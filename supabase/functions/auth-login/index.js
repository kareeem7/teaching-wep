/**
 * auth-login — الدخول الموحّد (AUTH_DESIGN §٣ أ).
 *
 * لماذا دالة وليس دخولًا مباشرًا من المتصفح؟
 *  ١. حدّ معدل موحّد لا يمكن تجاوزه من العميل.
 *  ٢. تدقيق كل محاولة (نجاح/فشل) بلا كشف هوية الحساب.
 *  ٣. رسالة فشل واحدة: لا تعداد حسابات بالتفريق بين «غير موجود» و«كلمة خطأ».
 *
 * المدخل: { identifier: هاتف أو كود, password }
 * المخرج عند النجاح: { ok:true, data:{ access_token, refresh_token, expires_in, profile:{...} } }
 *
 * يعمل على Deno (Supabase Edge Runtime) ويُختبر منطقُه المشترك في Node.
 */
import { apiError, okResponse, toErrorResponse, logError, newRequestId } from '../_shared/errors.js';
import { parseAllowlist, preflightResponse } from '../_shared/cors.js';
import { createDb, readEnv, requireEnv } from '../_shared/db.js';
import {
  classifyIdentifier,
  hashRateKey,
  isSessionStillValid,
  publicProfile,
  syntheticEmailForCode,
} from '../_shared/auth.js';
import { readJson, clientIp, guardRequest, decodeJwtPayload } from '../_shared/auth.js';
import { enforceRateLimit } from '../_shared/rate-limit.js';

/** أسماء متغيرات البيئة المطلوبة (لا أسرار في الكود). */
export const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RATE_LIMIT_SECRET'];

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
    const password = typeof body.password === 'string' ? body.password : '';
    const identifier = classifyIdentifier(typeof body.identifier === 'string' ? body.identifier : '');

    // المدخل غير صالح يُرفض بنفس رسالة الفشل: لا نكشف صيغة معرّفاتنا
    if (identifier.kind === 'invalid' || password.length === 0) {
      await safeAudit(db, 'login.invalid_input', null, 'denied');
      throw apiError('INVALID_CREDENTIALS', { requestId });
    }

    const ip = clientIp(request);
    const ipKey = `login:ip:${await hashRateKey(ip, rateSecret)}`;
    const idKey = `login:identifier:${await hashRateKey(identifier.value, rateSecret)}`;

    // الحدّان مستقلان: معرّف + IP
    await enforceRateLimit(db, { route: 'login:ip', key: ipKey, nowMs });
    await enforceRateLimit(db, { route: 'login:identifier', key: idKey, nowMs });

    // GoTrue يخزّن الهاتف بأرقام فقط بلا '+' (صيغة E.164 بلا علامة زائد).
    // إرسال '+' يجعل البحث لا يطابق الصف المخزَّن ⇒ فشل دخول وهمي.
    const credentials = identifier.kind === 'phone'
      ? { phone: identifier.value.replace(/^\+/, ''), password }
      : { email: syntheticEmailForCode(identifier.value), password };

    const { data: authData, error: authError } = await db.auth.signInWithPassword(credentials);

    if (authError || !authData?.access_token) {
      await safeAudit(db, 'login.failed', null, 'failed', { identifier_kind: identifier.kind });
      throw apiError('INVALID_CREDENTIALS', { requestId });
    }

    const claims = decodeJwtPayload(authData.access_token) ?? {};
    const userId = claims.sub ?? authData.user?.id;

    // المخطط app غير مكشوف في PostgREST: القراءة عبر دالة خدمة فقط
    const { data: profileData, error: profileError } = await db.rpc('svc_profile_context', {
      p_user_id: userId,
    });

    const profile = Array.isArray(profileData) ? profileData[0] : profileData;
    if (profileError || !profile?.user_id) {
      // F-39: إبطال الجلسة إجراء تعميق لا شرط صحة. تعذّره (مهلة/شبكة) كان يحوّل
      // الرفض الصحيح 403 إلى 502 فيظهر كأن المنع «لا يعمل». نفصل النداء عن القرار.
      await revokeSessionsSafe(db, userId, requestId);
      throw apiError('ACCOUNT_DISABLED', { requestId });
    }

    // سياسة الإيقاف وإبطال الجلسات: تُفحص هنا **وأيضًا** في RLS عند كل طلب
    const sessionOk = profile.status === 'active'
      && isSessionStillValid({ issuedAtSeconds: Number(claims.iat), validAfterIso: profile.sessions_valid_after });

    if (!sessionOk) {
      const revoked = await revokeSessionsSafe(db, userId, requestId);
      await safeAudit(db, 'login.blocked', userId, 'denied', {
        status: profile.status,
        revoked_auth_sessions: revoked,
      });
      throw apiError('ACCOUNT_DISABLED', { requestId });
    }

    await safeAudit(db, 'login.ok', userId, 'ok', { role: profile.role });

    return okResponse(
      {
        access_token: authData.access_token,
        refresh_token: authData.refresh_token ?? null,
        expires_in: authData.expires_in ?? null,
        profile: publicProfile(profile),
      },
      { corsHeaders: corsHeadersOf(request, allowlist) },
    );
  } catch (error) {
    logError('auth-login', error, { requestId });
    const status = error?.status ?? 500;
    const response = toErrorResponse(error, {
      corsHeaders: corsHeadersOf(request, allowlist),
      requestId,
    });
    if (status === 401) {
      // رسالة موحدة حتى لو تغيّر مصدر الخطأ
      return toErrorResponse(apiError('INVALID_CREDENTIALS', { requestId }), {
        corsHeaders: corsHeadersOf(request, allowlist),
        requestId,
      });
    }
    return response;
  }
}

/**
 * إبطال جلسات GoTrue بلا إسقاط الطلب — قرار الرفض يُتخذ من قاعدة البيانات لا من نجاح النداء.
 * يعيد `true` فقط إذا أكّد GoTrue الإبطال، ويُسجَّل الفشل بمعرّف الطلب.
 * @returns {Promise<boolean>}
 */
async function revokeSessionsSafe(db, userId, requestId) {
  try {
    const result = await db.auth.signOutGlobal(userId);
    const ok = !result?.error;
    if (!ok) logError('auth-login', new Error('signOutGlobal-failed'), { requestId, step: 'signOutGlobal' });
    return ok;
  } catch (error) {
    logError('auth-login', error, { requestId, step: 'signOutGlobal' });
    return false;
  }
}

function corsHeadersOf(request, allowlist) {
  const origin = request.headers.get('origin');
  if (!allowlist.includes(origin ?? '')) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    vary: 'origin',
  };
}

async function safeAudit(db, action, actor, outcome, detail = {}) {
  try {
    await db.rpc('svc_audit', {
      p_action: action,
      p_actor: actor,
      p_outcome: outcome,
      p_detail: detail,
    });
  } catch {
    // لا نُسقط الطلب لأن التدقيق تعطّل — لكن لا ندّعي أنه سُجّل
  }
}

if (globalThis.Deno?.serve) {
  globalThis.Deno.serve((request) => handler(request));
}
