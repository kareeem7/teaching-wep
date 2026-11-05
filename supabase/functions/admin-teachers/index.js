/**
 * admin-teachers — قرارات إدارة المدرسين (المرحلة ٠٣).
 *
 * الأفعال:
 *   • invite      : دعوة مدرس جديد برقم هاتف → رابط يُعرض **مرة واحدة**.
 *   • reissue     : إعادة إصدار دعوة غير مستخدمة وفق السياسة (حدّ ٣/٢٤س داخل SQL).
 *   • set-status  : إيقاف/تفعيل حساب بسبب إلزامي، مع إبطال الجلسات عند الإيقاف.
 *
 * ما لا تفعله هذه الدالة ولا يجوز أن تفعله:
 *   • لا تكتب أي بيانات أكاديمية (حضور، درجات، مجموعات، طلاب).
 *   • لا تعتمد على دور مأخوذ من جسم الطلب: الدور يُقرأ من `app.profiles` عبر `svc_profile_context`.
 *   • لا تُعيد بصمة الرمز ولا تسجّلها: الرمز الخام يُعاد للمتصفح مرة واحدة ثم يُمحى من الذاكرة.
 *
 * التدقيق: القرار الناجح يُدقَّق داخل دالة SQL (نفس المعاملة). المحاولة المرفوضة
 * تُدقَّق هنا عبر `_shared/audit.js` بوصفها denied.
 */
import { apiError, okResponse, toErrorResponse, logError, newRequestId, apiErrorFromDb } from '../_shared/errors.js';
import { parseAllowlist, preflightResponse, corsHeaders } from '../_shared/cors.js';
import { createDb, readEnv, requireEnv } from '../_shared/db.js';
import {
  bearerToken,
  buildLink,
  clientIp,
  guardRequest,
  hashToken,
  normalizePhone,
  randomToken,
  readJson,
  requireSuperAdmin,
} from '../_shared/auth.js';
import { enforceRateLimit } from '../_shared/rate-limit.js';
import { auditDenied, hashIp } from '../_shared/audit.js';

const ACTIONS = Object.freeze(new Set(['invite', 'reissue', 'set-status']));
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVITE_PATH = '/pages/auth/accept-invitation.html';

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

  try {
    guardRequest(request, allowlist);

    const baseUrl = requireEnv(env, 'SUPABASE_URL');
    const serviceKey = requireEnv(env, 'SUPABASE_SERVICE_ROLE_KEY');
    const rateSecret = requireEnv(env, 'RATE_LIMIT_SECRET');
    const appBase = readEnv(env, 'APP_BASE_URL') ?? '';

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

    if (action === 'invite') {
      await enforceRateLimit(db, {
        route: 'admin:invite',
        key: `admin:invite:${session.userId}`,
        nowMs,
      });

      const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : '';
      if (fullName.length < 2 || fullName.length > 120) throw apiError('INVALID_INPUT', { details: 'name' });

      const phone = normalizePhone(body.phone, { defaultCountry: '20' });
      if (!phone.ok || !phone.e164) throw apiError('INVALID_INPUT', { details: 'phone' });

      const headline = typeof body.headline === 'string' ? body.headline.trim() : '';
      if (headline.length > 160) throw apiError('INVALID_INPUT', { details: 'headline' });

      const inviteToken = randomToken();
      const tokenHash = await hashToken(inviteToken, rateSecret);

      const { data, error } = await db.rpc('svc_admin_invite_teacher', {
        p_actor: session.userId,
        p_phone_e164: phone.e164,
        p_full_name: fullName,
        p_headline: headline.length > 0 ? headline : null,
        p_token_hash: tokenHash,
        p_ttl_hours: 72,
      });
      if (error) throw apiErrorFromDb(error);

      return okResponse(
        {
          action,
          invitation_id: data?.invitation_id ?? null,
          expires_at: data?.expires_at ?? null,
          phone_last4: data?.phone_last4 ?? null,
          // يُعرض مرة واحدة ولا يُخزَّن في الخادم: الخادم يحتفظ بالبصمة فقط.
          invite_link: buildLink(appBase, INVITE_PATH, inviteToken),
        },
        { corsHeaders: corsHeaders(request.headers.get('origin'), allowlist) },
      );
    }

    if (action === 'reissue') {
      await enforceRateLimit(db, {
        route: 'admin:invite',
        key: `admin:reissue:${session.userId}`,
        nowMs,
      });

      if (!isUuid(body.invitation_id)) throw apiError('INVALID_INPUT', { details: 'invitation_id' });

      const inviteToken = randomToken();
      const tokenHash = await hashToken(inviteToken, rateSecret);

      const { data, error } = await db.rpc('svc_admin_reissue_invitation', {
        p_actor: session.userId,
        p_invitation_id: body.invitation_id,
        p_token_hash: tokenHash,
        p_ttl_hours: 72,
      });
      if (error) throw apiErrorFromDb(error);

      return okResponse(
        {
          action,
          invitation_id: data?.invitation_id ?? null,
          previous_id: data?.previous_id ?? null,
          expires_at: data?.expires_at ?? null,
          invite_link: buildLink(appBase, INVITE_PATH, inviteToken),
        },
        { corsHeaders: corsHeaders(request.headers.get('origin'), allowlist) },
      );
    }

    // set-status
    await enforceRateLimit(db, { route: 'admin:status', key: `admin:status:${session.userId}`, nowMs });

    if (!isUuid(body.user_id)) throw apiError('INVALID_INPUT', { details: 'user_id' });
    const status = body.status;
    if (status !== 'active' && status !== 'suspended') throw apiError('INVALID_INPUT', { details: 'status' });

    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 5 || reason.length > 300) throw apiError('INVALID_INPUT', { details: 'reason' });

    const { data, error } = await db.rpc('svc_admin_set_account_status', {
      p_actor: session.userId,
      p_user_id: body.user_id,
      p_status: status,
      p_reason: reason,
    });
    if (error) throw apiErrorFromDb(error);

    // الإيقاف: يُنفَّذ على ثلاث طبقات، ولا يُفشل الطلب إن تعذّر أيٌّ منها (RLS يبقى الحكم):
    //   ١. حظر في GoTrue نفسه (ban_duration) ⇒ لا يُصدر المزوّد توكنًا للموقوف أصلًا.
    //   ٢. إبطال الجلسات القائمة (signOutGlobal) ⇒ لا يبقى توكن صالح في مكان ما.
    //   ٣. sessions_valid_after في القاعدة ⇒ أي توكن قديم يُرفض في RLS.
    // الفصل مقصود (F-39/F-42): تعذّر طبقة تعميق لا يجوز أن يُحوّل قرارًا صحيحًا إلى فشل.
    let revokedAuthSessions = false;
    let identityBanned = null;
    if (data?.changed === true) {
      const wantBan = status === 'suspended';
      try {
        const result = await db.auth.setBan(body.user_id, wantBan);
        identityBanned = !result?.error;
      } catch {
        identityBanned = false;
      }
      if (wantBan) {
        try {
          const result = await db.auth.signOutGlobal(body.user_id);
          revokedAuthSessions = !result?.error;
        } catch {
          revokedAuthSessions = false;
        }
      }
    }

    return okResponse(
      {
        action,
        user_id: data?.user_id ?? null,
        status: data?.status ?? null,
        changed: data?.changed ?? false,
        revoked_auth_sessions: revokedAuthSessions,
        identity_banned: identityBanned,
      },
      { corsHeaders: corsHeaders(request.headers.get('origin'), allowlist) },
    );
  } catch (error) {
    // F-22: لا تدقيق لطلب بلا هوية معروفة (actorId = null).
    // لو دقّقنا كل محاولة مجهولة لأمكن إغراق سجل التدقيق بلا مصادقة إطلاقًا.
    const failedActor = error?.actorUserId ?? actorId;
    if (db && failedActor && (error?.code === 'FORBIDDEN' || error?.code === 'INVALID_SESSION' || error?.code === 'ACCOUNT_DISABLED')) {
      await auditDenied(db, {
        action: 'admin.teachers.denied',
        actor: failedActor,
        reason: error.code === 'FORBIDDEN' ? 'not-super-admin' : 'invalid-session',
        ipHash,
      });
    }
    logError('admin-teachers', error, { requestId, actor: actorId });
    return toErrorResponse(error, {
      corsHeaders: corsHeaders(request.headers.get('origin'), allowlist),
      requestId,
    });
  }
}

if (typeof Deno !== 'undefined') {
  Deno.serve((request) => handler(request));
}
