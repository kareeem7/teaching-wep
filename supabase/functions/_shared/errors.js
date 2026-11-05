/* global FUNCTION_BUILD */
/**
 * أخطاء الـAPI: شكل واحد لكل الردود، ورسائل عربية لا تكشف وجود حساب أو تفاصيل داخلية.
 *
 * قواعد ملزمة (AUTH_DESIGN §٣ أ):
 *  ١. «بيانات الدخول غير صحيحة» رسالة واحدة لكل حالات فشل الدخول — لا تفريق بين مستخدم غير موجود وكلمة خطأ.
 *  ٢. لا تُعاد تفاصيل قاعدة البيانات أو أسماء جداول للمتصفح مطلقًا.
 *  ٣. كل خطأ يحمل معرّف طلب (request_id) لتتبعه في السجل بلا بيانات شخصية.
 */

/** @typedef {{status: number, message: string, retryable?: boolean}} ErrorSpec */

/** @type {Record<string, ErrorSpec>} */
export const ERROR_SPECS = Object.freeze({
  INVALID_INPUT: { status: 400, message: 'البيانات المرسلة غير مكتملة أو غير صحيحة.' },
  INVALID_CREDENTIALS: { status: 401, message: 'بيانات الدخول غير صحيحة.' },
  INVALID_SESSION: { status: 401, message: 'الجلسة منتهية أو غير صالحة. سجّل الدخول من جديد.' },
  ACCOUNT_DISABLED: { status: 403, message: 'الحساب غير مفعّل أو موقوف. تواصل مع مدرسك.' },
  FORBIDDEN: { status: 403, message: 'لا تملك صلاحية هذا الإجراء.' },
  ROLE_MISMATCH: { status: 403, message: 'هذا الرابط لا يناسب نوع هذا الحساب. اطلب الرابط الصحيح من مدرسك.' },
  NOT_A_MEMBER: { status: 403, message: 'لست عضوًا في هذه المساحة.' },
  INVITATION_INVALID: { status: 400, message: 'رابط الدعوة غير صالح أو مستخدم من قبل أو منتهي الصلاحية.' },
  INVITATION_EXPIRED: { status: 410, message: 'انتهت صلاحية رابط الدعوة. اطلب دعوة جديدة.' },
  RECOVERY_INVALID: { status: 400, message: 'رابط الاستعادة غير صالح أو مستخدم أو منتهي.' },
  DUPLICATE_ACCOUNT: { status: 409, message: 'يوجد حساب بهذه البيانات بالفعل. جرّب الدخول أو الاستعادة.' },
  WEAK_PASSWORD: { status: 422, message: 'كلمة المرور لا تحقق سياسة الأمان المطلوبة.' },
  RATE_LIMITED: { status: 429, message: 'محاولات كثيرة في وقت قصير. انتظر ثم أعد المحاولة.', retryable: true },
  METHOD_NOT_ALLOWED: { status: 405, message: 'طريقة الطلب غير مدعومة.' },
  SERVICE_NOT_CONFIGURED: { status: 503, message: 'خدمة المصادقة غير مهيأة على هذا الخادم بعد.' },
  UPSTREAM_UNAVAILABLE: { status: 502, message: 'تعذّر الوصول إلى خدمة المصادقة الآن. أعد المحاولة.', retryable: true },
  INTERNAL: { status: 500, message: 'خطأ داخلي. لم يُنفَّذ الطلب.' },
});

/** خطأ يحمل رمزًا معروفًا وحالة HTTP ورسالة آمنة للعرض. */
export class ApiError extends Error {
  /**
   * @param {string} code
   * @param {{status?: number, message?: string, requestId?: string, details?: unknown}} [options]
   */
  constructor(code, options = {}) {
    const spec = ERROR_SPECS[code] ?? ERROR_SPECS.INTERNAL;
    super(options.message ?? spec.message);
    this.name = 'ApiError';
    this.code = ERROR_SPECS[code] ? code : 'INTERNAL';
    this.status = options.status ?? spec.status;
    this.retryable = Boolean(spec.retryable);
    this.requestId = options.requestId ?? null;
    this.details = options.details ?? null;
  }
}

/** @param {string} code @param {Record<string, unknown>} [extra] */
export function apiError(code, extra = {}) {
  return new ApiError(code, extra);
}

export function isApiError(value) {
  return value instanceof ApiError;
}

/** بصمة البناء المحقونة في الحزمة، أو 'dev' عند التشغيل من المصدر مباشرة. */
export function buildStamp() {
  return typeof FUNCTION_BUILD === 'string' && FUNCTION_BUILD.length > 0 ? FUNCTION_BUILD : 'dev';
}

/** يبني رأس JSON موحدًا. */
export function jsonResponse(body, { status = 200, corsHeaders = {}, extraHeaders = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      // F-43: بصمة البناء تُحقن عند التجميع؛ كشف «المنشور ليس كود هذا الالتزام».
      'x-function-build': buildStamp(),
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

/**
 * يحوّل أي خطأ إلى رد JSON آمن. لا يمرر رسالة قاعدة البيانات ولا stack للمتصفح.
 * @param {unknown} error
 */
export function toErrorResponse(error, { corsHeaders = {}, requestId = null, headers = {} } = {}) {
  const apiErr = isApiError(error) ? error : new ApiError('INTERNAL');
  const rid = apiErr.requestId ?? requestId;
  return jsonResponse(
    {
      ok: false,
      code: apiErr.code,
      message: apiErr.message,
      request_id: rid,
      // F-43: البصمة في الجسم أيضًا — بعض البوابات تُسقط الترويسات المخصصة.
      build: buildStamp(),
      // تفاصيل التشغيل (رموز داخلية مثل audience/recipients) لا تحمل سرًا،
      // وغيابها جعل تشخيص رفض 400/500 يستهلك محاولات كاملة (F-37).
      ...(apiErr.details === null || apiErr.details === undefined ? {} : { details: apiErr.details }),
      ...(apiErr.retryable ? { retryable: true } : {}),
    },
    { status: apiErr.status, corsHeaders, extraHeaders: headers },
  );
}

/** رد نجاح موحد. */
export function okResponse(data = {}, { status = 200, corsHeaders = {} } = {}) {
  return jsonResponse({ ok: true, data }, { status, corsHeaders });
}

const SECRET_KEYS = /^(authorization|apikey|password|new_password|token|refresh_token|access_token|service_role_key|supabase_service_role_key)$/i;

/** إزالة أي قيمة حساسة قبل أي سجل — احتياط نهائي لا بديل عن عدم تسجيلها. */
export function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, item] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    out[key] = SECRET_KEYS.test(key) ? '[محجوب]' : redact(item, depth + 1);
  }
  return out;
}

/** سجل خطأ بلا أسرار ولا بيانات شخصية. */
export function logError(scope, error, context = {}) {
  const payload = {
    scope,
    code: isApiError(error) ? error.code : 'INTERNAL',
    message: error instanceof Error ? error.message : String(error),
    context: redact(context),
  };
  console.error(JSON.stringify(payload));
}

/**
 * يحوّل خطأ PostgREST/SQL إلى خطأ API برمز مفهوم، بلا تمرير نص قاعدة البيانات للمتصفح.
 * الشفرة `code` هنا هي SQLSTATE التي ترفعها دوال app.admin_* في المهاجرة 0006.
 * @param {{status?: number, body?: any}|null|undefined} error
 */
export function apiErrorFromDb(error) {
  const sqlState = error?.body?.code ?? error?.code ?? null;
  const map = {
    '42501': 'FORBIDDEN',
    '22023': 'INVALID_INPUT',
    '22P02': 'INVALID_INPUT',
    '23405': 'DUPLICATE_ACCOUNT',
    '23505': 'DUPLICATE_ACCOUNT',
    '42900': 'RATE_LIMITED',
    P0002: 'INVITATION_INVALID',
  };
  const code = map[String(sqlState)] ?? 'UPSTREAM_UNAVAILABLE';
  return apiError(code, { details: 'db:' + String(sqlState ?? 'unknown') });
}

/** معرّف طلب قصير لتتبع الطلب في السجل والتقرير. */
export function newRequestId() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
