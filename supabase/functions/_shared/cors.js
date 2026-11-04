/**
 * CORS بدفاع افتراضي: لا نسمح بـ`*` مع رؤوس اعتماد، ونسمح فقط بأصل الموقع المعروف
 * وأصول المعاينة المحددة في متغير البيئة `APP_ALLOWED_ORIGINS` (مفصولة بفاصلة).
 *
 * الطلبات بلا `Origin` (خادم↔خادم، أو أدوات الاختبار) تمر لأن CORS قاعدة متصفح لا خادم.
 */

/** @param {string|undefined|null} raw */
export function parseAllowlist(raw) {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter((item) => item.length > 0 && item !== '*');
}

/**
 * هل هذا الأصل مسموح؟ (مطابقة تامة للأصل بلا مسار)
 * @param {string|null|undefined} origin
 * @param {string[]} allowlist
 */
export function isOriginAllowed(origin, allowlist = []) {
  if (!origin) return true;
  if (typeof origin !== 'string') return false;
  const normalized = origin.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[a-z0-9.-]+(:\d{2,5})?$/i.test(normalized)) return false;
  return allowlist.includes(normalized);
}

/** يُرجع `{}` عند الرفض، لا `null` — حتى لا يخطئ المستدعي في الفحص. */
export function corsHeaders(origin, allowlist = []) {
  if (!isOriginAllowed(origin, allowlist)) return {};
  return {
    'access-control-allow-origin': origin || allowlist[0] || 'null',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-max-age': '600',
    vary: 'origin',
  };
}

/** رد preflight، أو null إذا كان الأصل مرفوضًا. */
export function preflightResponse(request, allowlist = []) {
  const origin = request.headers.get('origin');
  const headers = corsHeaders(origin, allowlist);
  if (Object.keys(headers).length === 0) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers });
}

/** هل الطلب من أصل مرفوض؟ يُستخدم في الدوال لمنع التنفيذ قبل أي عمل. */
export function isBlockedOrigin(request, allowlist = []) {
  return !isOriginAllowed(request.headers.get('origin'), allowlist);
}
