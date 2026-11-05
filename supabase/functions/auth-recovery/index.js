/**
 * auth-recovery — استعادة كلمة المرور (AUTH_DESIGN §٣ د و§٧).
 *
 * إجراءان:
 *   request  : مدرس/مساعد داخل مساحته يطلب رمزًا لطالب مرتبط. بسبب إلزامي. حدّ معدل.
 *              يُعاد الرمز **مرة واحدة** ليُسلَّم يدويًا — لا بريد ولا SMS.
 *   complete : الطالب يضع كلمة مرور جديدة برمزه (بلا جلسة).
 *              يُستهلك الرمز ذرّيًا، تُحدَّث كلمة المرور عبر admin API،
 *              وتُبطل كل الجلسات (`sessions_valid_after` + signOut global).
 *
 * ما لا يحدث: المدرس لا يرى الكلمة القديمة ولا الجديدة، ولا يدخل بحساب الطالب.
 * الخطر المتبقي (C-32): من يحتجز الهاتف/الكود يمكنه طلب الاستعادة عبر مدرس؛
 * لذلك كل إصدار يُسجَّل في التدقيق، والرمز قصير الأجل (٣٠ دقيقة) وأحادي الاستخدام.
 */
import { apiError, okResponse, toErrorResponse, logError, newRequestId } from '../_shared/errors.js';
import { parseAllowlist, preflightResponse, corsHeaders } from '../_shared/cors.js';
import { createDb, readEnv, requireEnv } from '../_shared/db.js';
import {
  RECOVERY_TTL_SECONDS,
  bearerToken,
  classifyIdentifier,
  guardRequest,
  hashRateKey,
  hashToken,
  isTokenShapeValid,
  issueToken,
  readJson,
  requireSession,
  validatePassword,
} from '../_shared/auth.js';
import { enforceRateLimit } from '../_shared/rate-limit.js';

/**
 * @param {Request} request
 * @param {{env?: Record<string, string>, fetchImpl?: typeof fetch, nowMs?: number, db?: object}} [deps]
 */
export async function handler(request, deps = {}) {
  const requestId = newRequestId();
  const env = deps.env ?? globalThis.Deno?.env ?? {};
  const allowlist = parseAllowlist(readEnv(env, 'APP_ALLOWED_ORIGINS'));

  if (request.method === 'OPTIONS') return preflightResponse(request, allowlist);

  try {
    guardRequest(request, allowlist);
    const baseUrl = requireEnv(env, 'SUPABASE_URL');
    const serviceKey = requireEnv(env, 'SUPABASE_SERVICE_ROLE_KEY');
    const rateSecret = requireEnv(env, 'RATE_LIMIT_SECRET');
    const db = deps.db ?? createDb({ baseUrl, serviceRoleKey: serviceKey, fetchImpl: deps.fetchImpl });
    const nowMs = deps.nowMs ?? Date.now();

    const body = await readJson(request);
    const action = typeof body.action === 'string' ? body.action : '';

    if (action === 'request') return await handleRequest({ request, body, db, rateSecret, nowMs, allowlist, requestId });
    if (action === 'complete') return await handleComplete({ request, body, db, rateSecret, nowMs, allowlist, requestId });

    throw apiError('INVALID_INPUT', { requestId, details: 'action' });
  } catch (error) {
    logError('auth-recovery', error, { requestId });
    return toErrorResponse(error, { corsHeaders: corsHeaders(request.headers.get('origin'), allowlist), requestId });
  }
}

async function handleRequest({ request, body, db, rateSecret, nowMs, allowlist, requestId }) {
  const { userId: teacherId } = await requireSession(db, bearerToken(request));

  const identifier = classifyIdentifier(typeof body.identifier === 'string' ? body.identifier : '');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (identifier.kind === 'invalid') throw apiError('INVALID_INPUT', { requestId, details: 'identifier' });
  if (reason.length < 5) throw apiError('INVALID_INPUT', { requestId, details: 'reason' });

  await enforceRateLimit(db, {
    route: 'recovery:teacher',
    key: `recovery:teacher:${await hashRateKey(teacherId, rateSecret)}`,
    nowMs,
  });

  // الهدف يجب أن يكون داخل مساحة المدرس — يُفحص في SQL لا في المتصفح
  const { data: target, error: targetError } = await db.rpc('svc_recovery_target', {
    p_teacher_id: teacherId,
    p_identifier: identifier.value,
  });
  const row = Array.isArray(target) ? target[0] : target;
  if (targetError) throw apiError('UPSTREAM_UNAVAILABLE', { requestId });
  if (!row?.user_id) {
    // لا نكشف وجود الحساب من عدمه لكل من جرّب معرّفًا
    throw apiError('INVALID_INPUT', { requestId, details: 'no-target' });
  }

  await enforceRateLimit(db, {
    route: 'recovery:student',
    key: `recovery:student:${await hashRateKey(row.user_id, rateSecret)}`,
    nowMs,
  });

  const issued = await issueToken({ secret: rateSecret, ttlSeconds: RECOVERY_TTL_SECONDS, nowMs });
  const { error: createError } = await db.rpc('svc_create_recovery_token', {
    p_user_id: row.user_id,
    p_token_hash: issued.tokenHash,
    p_issued_by: teacherId,
    p_reason: reason,
    p_expires_at: issued.expiresAt,
  });
  if (createError) throw apiError('UPSTREAM_UNAVAILABLE', { requestId, details: 'create-recovery' });

  await safeAudit(db, 'recovery.issued', { actor: teacherId, entity: 'recovery', id: row.user_id });

  return okResponse(
    {
      token: issued.token,
      expires_at: issued.expiresAt,
      ttl_seconds: issued.ttlSeconds,
      student_name: row.full_name ?? null,
    },
    { corsHeaders: corsHeaders(request.headers.get('origin'), allowlist) },
  );
}

async function handleComplete({ request, body, db, rateSecret, nowMs, allowlist, requestId }) {
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!isTokenShapeValid(token)) throw apiError('RECOVERY_INVALID', { requestId });

  // F-06: حدّ على الإكمال نفسه (بلا جلسة، فالمفتاح بصمة الرمز لا المستخدم).
  await enforceRateLimit(db, {
    route: 'recovery:complete',
    key: `recovery:complete:${await hashRateKey(token.slice(0, 12), rateSecret)}`,
    nowMs,
  });

  const policy = validatePassword(password);
  if (!policy.ok) throw apiError('WEAK_PASSWORD', { requestId, details: { issues: policy.issues } });

  const { data: consumed, error: consumeError } = await db.rpc('svc_consume_recovery', {
    p_token_hash: await hashToken(token, rateSecret),
  });
  if (consumeError) throw apiError('RECOVERY_INVALID', { requestId });
  const row = Array.isArray(consumed) ? consumed[0] : consumed;
  if (!row?.user_id) throw apiError('RECOVERY_INVALID', { requestId });

  const { error: passwordError } = await db.auth.setPassword(row.user_id, password);
  if (passwordError) throw apiError('UPSTREAM_UNAVAILABLE', { requestId, details: 'set-password' });

  // إبطال الجلسات: كل توكن أقدم من الآن يُرفض في RLS
  await db.rpc('svc_invalidate_sessions', { p_user_id: row.user_id });
  await db.auth.signOutGlobal(row.user_id);
  await safeAudit(db, 'recovery.completed', { actor: row.issued_by ?? null, entity: 'recovery', id: row.user_id });

  return okResponse(
    { completed: true, sessions_invalidated: true, at: new Date(nowMs).toISOString() },
    { corsHeaders: corsHeaders(request.headers.get('origin'), allowlist) },
  );
}

async function safeAudit(db, action, { actor = null, entity = null, id = null } = {}) {
  try {
    await db.rpc('svc_audit', {
      p_action: action,
      p_actor: actor,
      p_entity: entity,
      p_entity_id: id,
      p_outcome: 'ok',
      p_detail: {},
    });
  } catch {
    // لا نُسقط العملية لأن التدقيق تعطّل
  }
}

if (globalThis.Deno?.serve) {
  globalThis.Deno.serve((request) => handler(request));
}
