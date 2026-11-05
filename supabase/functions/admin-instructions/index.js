/**
 * admin-instructions — التعليمات الداخلية من السوبر أدمن (المرحلة ٠٣).
 *
 * الأفعال:
 *   • preview : عدد المستهدفين الحقيقي قبل الإرسال (لا إرسال).
 *   • send    : إنشاء تعليم وتثبيت مستلميه صفوفًا.
 *
 * لماذا الإرسال من هنا وليس من المتصفح؟
 *   لأن حساب المستلمين قرار أمني: لو حسبه المتصفح لأمكن إرسال تعليم لطالب
 *   أو لمدرس خارج النطاق. الحساب يقع داخل `app.admin_send_instruction`
 *   (مدرسون نشطون فقط، ٢٠٠ كحد أقصى، وحدّ إرسال ٢٠/ساعة)، وهذه الدالة تمرّره فقط.
 *
 * القراءة ليست هنا: المستلم يقرأ `public.my_notifications`، والأدمن يقرأ
 * `public.admin_instructions` — وكلاهما محكوم بـRLS لا بهذا الملف.
 */
import { apiError, okResponse, toErrorResponse, logError, newRequestId, apiErrorFromDb } from '../_shared/errors.js';
import { parseAllowlist, preflightResponse, corsHeaders } from '../_shared/cors.js';
import { createDb, readEnv, requireEnv } from '../_shared/db.js';
import {
  bearerToken,
  clientIp,
  guardRequest,
  readJson,
  requireSuperAdmin,
} from '../_shared/auth.js';
import { enforceRateLimit } from '../_shared/rate-limit.js';
import { auditDenied, hashIp } from '../_shared/audit.js';

const ACTIONS = Object.freeze(new Set(['preview', 'send']));
const AUDIENCES = Object.freeze(new Set(['all_teachers', 'teachers']));
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RECIPIENTS = 200;

/** @param {unknown} value */
function isUuid(value) {
  return typeof value === 'string' && UUID_SHAPE.test(value);
}

/**
 * @param {Request} request
 * @param {{env?: Record<string, string>, fetchImpl?: typeof fetch, nowMs?: number, db?: object}} [deps]
 */
export async function handler(request, deps = {}) {
  const requestId = newRequestId();
  const env = deps.env ?? globalThis.Deno?.env ?? {};
  const allowlist = parseAllowlist(readEnv(env, 'APP_ALLOWED_ORIGINS'));

  if (request.method === 'OPTIONS') return preflightResponse(request, allowlist);

  /** @type {object|null} */
  let db = null;
  let actorId = null;
  let ipHash = null;
  const cors = () => corsHeaders(request.headers.get('origin'), allowlist);

  try {
    guardRequest(request, allowlist);

    const baseUrl = requireEnv(env, 'SUPABASE_URL');
    const serviceKey = requireEnv(env, 'SUPABASE_SERVICE_ROLE_KEY');
    const rateSecret = requireEnv(env, 'RATE_LIMIT_SECRET');

    db = deps.db ?? createDb({ baseUrl, serviceRoleKey: serviceKey, fetchImpl: deps.fetchImpl });
    const nowMs = deps.nowMs ?? Date.now();
    ipHash = await hashIp(clientIp(request), rateSecret);

    const token = bearerToken(request);
    if (!token) throw apiError('INVALID_SESSION');

    const session = await requireSuperAdmin(db, token);
    actorId = session.userId;

    const body = await readJson(request, 8192);
    const action = typeof body.action === 'string' ? body.action : '';
    if (!ACTIONS.has(action)) throw apiError('INVALID_INPUT', { details: 'unknown-action' });

    const audience = typeof body.audience === 'string' ? body.audience : 'all_teachers';
    if (!AUDIENCES.has(audience)) throw apiError('INVALID_INPUT', { details: 'audience' });

    const userIds = Array.isArray(body.user_ids)
      ? Array.from(new Set(body.user_ids.filter(isUuid)))
      : [];
    if (audience === 'teachers' && userIds.length === 0) {
      throw apiError('INVALID_INPUT', { details: 'recipients' });
    }
    if (userIds.length > MAX_RECIPIENTS) throw apiError('INVALID_INPUT', { details: 'too-many-recipients' });

    if (action === 'preview') {
      const { data, error } = await db.rpc('svc_admin_stats', { p_actor: session.userId });
      if (error) throw apiErrorFromDb(error);
      const stats = Array.isArray(data) ? data[0] : data;
      return okResponse(
        {
          action,
          audience,
          recipients: audience === 'all_teachers' ? Number(stats?.teachers_active ?? 0) : userIds.length,
        },
        { corsHeaders: cors() },
      );
    }

    // send
    await enforceRateLimit(db, {
      route: 'admin:instruction',
      key: `admin:instruction:${session.userId}`,
      nowMs,
    });

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    if (title.length < 3 || title.length > 120) throw apiError('INVALID_INPUT', { details: 'title' });
    if (text.length < 5 || text.length > 2000) throw apiError('INVALID_INPUT', { details: 'body' });

    const { data, error } = await db.rpc('svc_admin_send_instruction', {
      p_actor: session.userId,
      p_title: title,
      p_body: text,
      p_audience: audience,
      p_user_ids: userIds,
    });
    if (error) throw apiErrorFromDb(error);

    return okResponse(
      {
        action,
        notification_id: data?.notification_id ?? null,
        recipients: Number(data?.recipients ?? 0),
        sent_at: data?.sent_at ?? null,
      },
      { corsHeaders: cors() },
    );
  } catch (error) {
    // F-22: لا تدقيق لطلب بلا هوية معروفة (actorId = null).
    // لو دقّقنا كل محاولة مجهولة لأمكن إغراق سجل التدقيق بلا مصادقة إطلاقًا.
    const failedActor = error?.actorUserId ?? actorId;
    if (db && failedActor && (error?.code === 'FORBIDDEN' || error?.code === 'INVALID_SESSION' || error?.code === 'ACCOUNT_DISABLED')) {
      await auditDenied(db, {
        action: 'admin.instructions.denied',
        actor: failedActor,
        reason: error.code === 'FORBIDDEN' ? 'not-super-admin' : 'invalid-session',
        ipHash,
      });
    }
    logError('admin-instructions', error, { requestId, actor: actorId });
    return toErrorResponse(error, { corsHeaders: cors(), requestId });
  }
}

if (typeof Deno !== 'undefined') {
  Deno.serve((request) => handler(request));
}
