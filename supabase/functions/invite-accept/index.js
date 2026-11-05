/**
 * invite-accept — قبول الدعوات (AUTH_DESIGN §٣ ب و§٣ ج).
 *
 * الأنواع المدعومة في هذه المرحلة:
 *   • teacher_invite : معلم يدعوه السوبر أدمن → يُنشأ الحساب ويُفعّل ويُفتح له ملف مدرس.
 *   • student_link   : ربط طالب بملف محلي أنشأه المدرس → إما حساب جديد أو حساب قائم.
 *
 * `assistant_invite` موجود في المخطط لكن **غير منفذ** هنا (المرحلة ٠٤) — يُرفض بوضوح.
 *
 * الترتيب المقصود: تحقق ← إنشاء/تحديد الهوية ← `svc_accept_invitation` ذرّيًا
 * (استهلاك + هوية + ربط في معاملة واحدة) ← تعويض بحذف مستخدم Auth وحده عند الفشل.
 * لا يوجد اعتماد على «حسن النية» من المتصفح: نوع الدعوة يُفحص داخل SQL أيضًا.
 */
import { apiError, okResponse, toErrorResponse, logError, newRequestId } from '../_shared/errors.js';
import { parseAllowlist, preflightResponse, corsHeaders } from '../_shared/cors.js';
import { createDb, readEnv, requireEnv } from '../_shared/db.js';
import {
  checkTokenState,
  classifyIdentifier,
  hashRateKey,
  hashToken,
  isTokenShapeValid,
  publicProfile,
  readJson,
  syntheticEmailForCode,
  validatePassword,
  bearerToken,
  guardRequest,
  requireSession,
} from '../_shared/auth.js';
import { enforceRateLimit } from '../_shared/rate-limit.js';

/** استهلاك الدعوة يتم في SQL؛ هذه الخريطة تمنع اختلاف الأسماء بين الطبقتين. */
const KIND_MAP = Object.freeze({
  teacher_invite: 'teacher_invite',
  student_link: 'student_link',
});

/**
 * @param {Request} request
 * @param {{env?: Record<string, string>, fetchImpl?: typeof fetch, nowMs?: number, db?: object}} [deps]
 */
export async function handler(request, deps = {}) {
  const requestId = newRequestId();
  const env = deps.env ?? globalThis.Deno?.env ?? {};
  const allowlist = parseAllowlist(readEnv(env, 'APP_ALLOWED_ORIGINS'));

  if (request.method === 'OPTIONS') return preflightResponse(request, allowlist);

  let createdUserId = null;
  try {
    guardRequest(request, allowlist);
    const baseUrl = requireEnv(env, 'SUPABASE_URL');
    const serviceKey = requireEnv(env, 'SUPABASE_SERVICE_ROLE_KEY');
    const rateSecret = requireEnv(env, 'RATE_LIMIT_SECRET');
    const db = deps.db ?? createDb({ baseUrl, serviceRoleKey: serviceKey, fetchImpl: deps.fetchImpl });
    const nowMs = deps.nowMs ?? Date.now();

    const body = await readJson(request);
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!isTokenShapeValid(token)) throw apiError('INVITATION_INVALID', { requestId });

    // حدّ المعدل على المحاولات لا على النجاحات
    const ipKey = `invite:ip:${await hashRateKey(clientIpOf(request), rateSecret)}`;
    await enforceRateLimit(db, { route: 'invite:ip', key: ipKey, nowMs });

    const tokenHash = await hashToken(token, rateSecret);

    // قراءة الدعوة من مسار الخدمة (schema app غير مكشوف) — عبر REST على جدول غير مكشوف غير ممكن،
    // لذلك نستخدم دالة خدمة تُرجع الحالة دون استهلاك.
    const { data: inviteRows, error: inviteError } = await db.rpc('svc_invitation_state', {
      p_token_hash: tokenHash,
    });
    if (inviteError) throw apiError('UPSTREAM_UNAVAILABLE');
    const invite = Array.isArray(inviteRows) ? inviteRows[0] : inviteRows;

    const state = checkTokenState(
      {
        expiresAt: invite?.expires_at ?? null,
        usedAt: invite?.used_at ?? null,
        revokedAt: invite?.revoked_at ?? null,
        kind: invite?.kind ?? null,
        nowMs,
      },
      undefined,
    );
    if (!state.ok) throw apiError(inviteErrorCode(state.reason), { requestId });
    if (!KIND_MAP[invite.kind]) throw apiError('INVITATION_INVALID', { requestId, details: 'unsupported-kind' });

    const password = typeof body.password === 'string' ? body.password : '';
    const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : '';
    if (fullName.length < 2) throw apiError('INVALID_INPUT', { requestId, details: 'full_name' });

    const identifier = classifyIdentifier(typeof body.identifier === 'string' ? body.identifier : '');
    if (identifier.kind === 'invalid') throw apiError('INVALID_INPUT', { requestId, details: 'identifier' });

    const policy = validatePassword(password, { identifier: identifier.value, displayName: fullName });
    if (!policy.ok) {
      throw apiError('WEAK_PASSWORD', { requestId, details: { issues: policy.issues } });
    }

    // ---------- ١) تحديد/إنشاء الهوية ----------
    /** @type {{userId: string, isNew: boolean}} */
    let identity;

    const existingSession = bearerToken(request);
    if (existingSession) {
      const { userId } = await requireSession(db, existingSession);
      identity = { userId, isNew: false };
    } else {
      const createBody = identifier.kind === 'phone'
        ? { phone: identifier.value, password, fullName, role: invite.kind === 'teacher_invite' ? 'teacher' : 'student' }
        : {
          phone: undefined,
          password,
          code: identifier.value,
          fullName,
          role: invite.kind === 'teacher_invite' ? 'teacher' : 'student',
        };

      const { data: created, error: createError } = await db.auth.createUser({
        ...createBody,
        email: identifier.kind === 'code' ? syntheticEmailForCode(identifier.value) : undefined,
      });

      if (createError || !created?.id) {
        const status = createError?.status;
        if (status === 422 || status === 409) throw apiError('DUPLICATE_ACCOUNT', { requestId });
        throw apiError('UPSTREAM_UNAVAILABLE', { requestId, details: 'create-user' });
      }
      createdUserId = created.id;
      identity = { userId: created.id, isNew: true };
    }

    // ---------- ٢) قبول ذرّي: استهلاك + هوية + ربط في معاملة واحدة (F-03) ----------
    // لم يبقَ استهلاك منفصل: لو رُفضت الهوية (موقوف/خلط أدوار) أُلغي الاستهلاك تلقائيًا،
    // فلا تُحرق دعوة صالحة بسبب فشل لاحق.
    const { data: acceptedRows, error: acceptError } = await db.rpc('svc_accept_invitation', {
      p_token_hash: tokenHash,
      p_kind: invite.kind,
      p_user_id: identity.userId,
      p_full_name: fullName,
      p_phone: identifier.kind === 'phone' ? identifier.value : null,
      p_code: identifier.kind === 'code' ? identifier.value : null,
    });

    if (acceptError) {
      const code = mapAcceptErrorCode(acceptError);
      // F-12: محاولة مرفوضة تُسجَّل (رمز السبب فقط، بلا معرّف ولا هاتف).
      await safeAudit(db, 'invite.rejected', identity.userId, { kind: invite.kind, reason: code }, 'failed');
      if (createdUserId) await db.auth.deleteUser(createdUserId);
      throw apiError(code, { requestId, details: 'accept' });
    }

    const accepted = Array.isArray(acceptedRows) ? acceptedRows[0] : acceptedRows;

    await safeAudit(
      db,
      `invite.accepted.${invite.kind}`,
      identity.userId,
      { new_identity: identity.isNew },
      'ok',
    );

    return okResponse(
      {
        kind: invite.kind,
        profile: publicProfile(accepted?.profile),
        teacher_id: accepted?.teacher_id ?? invite.teacher_id ?? null,
        requires_login: true,
      },
      { corsHeaders: corsHeaders(request.headers.get('origin'), allowlist) },
    );
  } catch (error) {
    logError('invite-accept', error, { requestId });
    return toErrorResponse(error, { corsHeaders: corsHeaders(request.headers.get('origin'), allowlist), requestId });
  }
}

/** تحويل رسالة الاستثناء من SQL إلى رمز API — بلا تسريب نص قاعدة البيانات للمتصفح. */
function mapAcceptErrorCode(error) {
  const text = `${error?.message ?? ''} ${error?.details ?? ''} ${error?.hint ?? ''}`;
  if (text.includes('ACCOUNT_DISABLED')) return 'ACCOUNT_DISABLED';
  if (text.includes('ROLE_MISMATCH')) return 'ROLE_MISMATCH';
  if (text.includes('invalid-full-name')) return 'INVALID_INPUT';
  if (text.includes('invitation-') || text.includes('not-linkable')) return 'INVITATION_INVALID';
  return 'INTERNAL';
}

function inviteErrorCode(reason) {
  if (reason === 'expired') return 'INVITATION_EXPIRED';
  return 'INVITATION_INVALID';
}

function clientIpOf(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}

async function safeAudit(db, action, actor, detail = {}, outcome = 'ok') {
  try {
    await db.rpc('svc_audit', { p_action: action, p_actor: actor, p_outcome: outcome, p_detail: detail });
  } catch {
    // التدقيق لا يُسقط العملية، لكن لا ندّعي أنه سُجّل
  }
}

if (globalThis.Deno?.serve) {
  globalThis.Deno.serve((request) => handler(request));
}
