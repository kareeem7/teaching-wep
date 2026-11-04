/**
 * طبقة نداء الخادم من المتصفح.
 *
 * قاعدة ملزمة: هذا الملف **لا يقرر صلاحية**. كل قرار أمني في RLS/Edge Functions.
 * هنا فقط: مسار نسبي، مهلة، وتحويل الرد إلى شكل واحد مفهوم للواجهة.
 */

/** عنوان الدوال نسبي دائمًا: لا `localhost` ولا نطاق مكتوب في الكود. */
export const FUNCTIONS_PATH = '/functions/v1';

/**
 * يبني عنوان الدالة من مسار نسبي إلى موقع الصفحة الحالية.
 * @param {string} name
 * @param {string} [base]
 */
export function buildFunctionUrl(name, base = '') {
  const prefix = String(base).replace(/\/+$/, '');
  return `${prefix}${FUNCTIONS_PATH}/${String(name).replace(/^\/+/, '')}`;
}

/** خطأ موحد للواجهة: يحمل رمزًا ورسالة عربية وطلبًا للتتبع. */
export class ApiClientError extends Error {
  constructor(code, message, { status = 0, requestId = null, retryable = false, details = null } = {}) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.retryable = retryable;
    this.details = details;
  }
}

/** رسائل عربية ثابتة للحالات التي لا يأتي فيها رد من الخادم أصلًا. */
export const CLIENT_ERRORS = Object.freeze({
  NETWORK: 'تعذّر الوصول إلى الخادم. تحقق من الاتصال ثم أعد المحاولة.',
  TIMEOUT: 'انتهت مهلة الانتظار. أعد المحاولة بعد قليل.',
  NOT_DEPLOYED: 'خدمة الخادم غير منشورة بعد على هذا الموقع، فلا يمكن تنفيذ الطلب الآن.',
  UNEXPECTED: 'رد غير متوقع من الخادم. لم يُنفَّذ الطلب.',
  UNAUTHORIZED: 'تحتاج إلى تسجيل الدخول أولًا.',
});

/**
 * يحوّل رد HTTP إلى نجاح أو خطأ موحد. لا يفترض أن الجسم JSON.
 * @param {Response} response
 */
export async function parseApiResponse(response) {
  const status = response.status;
  const contentType = response.headers.get('content-type') ?? '';
  let payload = null;

  if (contentType.includes('application/json')) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  }

  if (payload && payload.ok === true) return payload.data ?? {};

  if (payload && payload.ok === false) {
    throw new ApiClientError(payload.code ?? 'UNKNOWN', payload.message ?? CLIENT_ERRORS.UNEXPECTED, {
      status,
      requestId: payload.request_id ?? null,
      retryable: Boolean(payload.retryable),
      details: payload.details ?? null,
    });
  }

  // 401/403 من بوابة Supabase (بلا جسم موحد) — رسالة مفهومة لا نص HTML
  if (status === 401) throw new ApiClientError('UNAUTHORIZED', CLIENT_ERRORS.UNAUTHORIZED, { status });
  if (status === 404 || status === 405 || status === 501) {
    throw new ApiClientError('NOT_DEPLOYED', CLIENT_ERRORS.NOT_DEPLOYED, { status });
  }
  throw new ApiClientError('UNEXPECTED', CLIENT_ERRORS.UNEXPECTED, { status });
}

/**
 * نداء دالة Edge.
 * @param {string} name
 * @param {{body?: Record<string, unknown>, token?: string|null, timeoutMs?: number, fetchImpl?: typeof fetch}} [options]
 */
export async function callFunction(name, options = {}) {
  const { body = null, token = null, timeoutMs = 12000 } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  try {
    const response = await fetchImpl(buildFunctionUrl(name), {
      method: 'POST',
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
      credentials: 'omit',
    });
    return await parseApiResponse(response);
  } catch (error) {
    if (error instanceof ApiClientError) throw error;
    if (error && error.name === 'AbortError') {
      throw new ApiClientError('TIMEOUT', CLIENT_ERRORS.TIMEOUT, { retryable: true });
    }
    throw new ApiClientError('NETWORK', CLIENT_ERRORS.NETWORK, { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------- مساعدات واجهة صغيرة ------------------------- */

/** يعرض رسالة خطأ في عنصر مُعد مسبقًا، ويخفيها عند null. */
export function showFormError(element, message) {
  if (!element) return;
  if (!message) {
    element.textContent = '';
    element.hidden = true;
    return;
  }
  element.textContent = message;
  element.hidden = false;
}

/** يعطّل الزر أثناء الطلب ويمنع الإرسال المزدوج. */
export function setBusy(button, busy, busyLabel = 'جارٍ التنفيذ…') {
  if (!button) return;
  if (busy) {
    button.dataset.idleLabel = button.textContent ?? '';
    button.textContent = busyLabel;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.idleLabel ?? button.textContent;
    button.disabled = false;
  }
}

/** قراءة قيم نموذج ككائن نصي بسيط. */
export function readForm(form) {
  if (!form) return {};
  const data = new FormData(form);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of data.entries()) out[key] = typeof value === 'string' ? value.trim() : '';
  return out;
}

/** الحصول على قيمة استعلام من العنوان (مثل token). */
export function queryParam(name, search = globalThis.location?.search ?? '') {
  return new URLSearchParams(search).get(name);
}

/** تحقق شكلي للعرض فقط — الخادم هو الحكم. */
export function looksFilled(value, minLength = 1) {
  return typeof value === 'string' && value.trim().length >= minLength;
}
