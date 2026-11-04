/**
 * workspace-select — يحدد مساحات المستخدم بعد الدخول (عزل مساحات المدرسين).
 *
 * المدخل: رأس `Authorization: Bearer <access_token>` — لا معرّف في الجسم (لا انتحال).
 * المخرج: قائمة المساحات + هل يلزم اختيار.
 *
 * قواعد:
 *  ١. المساحات تُشتق من الجلسة نفسها، لا من قيمة يرسلها المتصفح.
 *  ٢. الطالب يرى مساحات المدرسين المرتبطين به فقط (من ملفاته المحلية النشطة).
 *  ٣. لا تُعاد بيانات أي طالب آخر — فقط اسم المدرس/المساحة.
 */
import { apiError, okResponse, toErrorResponse, logError, newRequestId } from '../_shared/errors.js';
import { parseAllowlist, preflightResponse, corsHeaders } from '../_shared/cors.js';
import { createDb, readEnv, requireEnv } from '../_shared/db.js';
import { bearerToken, guardRequest, requireSession } from '../_shared/auth.js';

/**
 * @param {Request} request
 * @param {{env?: Record<string, string>, fetchImpl?: typeof fetch, db?: object}} [deps]
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
    const db = deps.db ?? createDb({ baseUrl, serviceRoleKey: serviceKey, fetchImpl: deps.fetchImpl });

    const { userId } = await requireSession(db, bearerToken(request));

    const { data: profileData, error: profileError } = await db.rpc('svc_profile_context', {
      p_user_id: userId,
    });
    const profile = Array.isArray(profileData) ? profileData[0] : profileData;
    if (profileError || !profile?.user_id) throw apiError('INVALID_SESSION');
    if (profile.status !== 'active') throw apiError('ACCOUNT_DISABLED');

    // العزل داخل SQL: كل مستخدم يرى مساحاته فقط، والطالب يرى مدرسيه المرتبطين
    const { data: workspaces, error: workspaceError } = await db.rpc('svc_workspaces', {
      p_user_id: userId,
    });
    if (workspaceError) throw apiError('UPSTREAM_UNAVAILABLE');

    const list = Array.isArray(workspaces) ? workspaces : (workspaces ?? []);

    // السوبر أدمن لا يملك مساحة أكاديمية (قراءة فقط) — يعود بقائمة فارغة صريحة
    return okResponse(
      {
        requires_selection: list.length > 1,
        workspaces: list,
        count: list.length,
        role: profile.role,
      },
      { corsHeaders: corsHeaders(request.headers.get('origin'), allowlist) },
    );
  } catch (error) {
    logError('workspace-select', error, { requestId });
    return toErrorResponse(error, { corsHeaders: corsHeaders(request.headers.get('origin'), allowlist), requestId });
  }
}

if (globalThis.Deno?.serve) {
  globalThis.Deno.serve((request) => handler(request));
}
