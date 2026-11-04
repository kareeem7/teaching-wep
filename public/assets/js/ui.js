/**
 * أدوات واجهة مشتركة: تنسيق، تحقق، عناصر آمنة.
 * الدوال النقية (بلا DOM) تُختبر في tests/unit.
 */

/** المنطقة الزمنية المعتمدة — docs/DECISIONS.md C-23 · R-02. */
export const DEFAULT_TIME_ZONE = 'Africa/Cairo';
/** اللغة الافتراضية للعرض. */
export const DEFAULT_LOCALE = 'ar-EG';

/**
 * يهرب النص قبل حقنه في HTML.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * تنسيق تاريخ بالمنطقة الزمنية المعتمدة.
 * @param {Date|string|number} value
 * @param {{timeZone?: string, locale?: string, withTime?: boolean}} [options]
 * @returns {string}
 */
export function formatDateTime(value, options = {}) {
  const {
    timeZone = DEFAULT_TIME_ZONE,
    locale = DEFAULT_LOCALE,
    withTime = true,
  } = options;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date);
}

/**
 * تحقق شكلي من صيغة هاتف مصرية/دولية.
 * **صحة الصيغة لا تثبت ملكية الرقم** (KNOWN_LIMITATIONS L-24).
 * @param {string} value
 * @returns {boolean}
 */
export function isPlausiblePhone(value) {
  if (typeof value !== 'string') return false;
  const digits = value.replace(/[\s()-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(digits);
}

/**
 * نسبة مئوية مقرّبة بلا كسور زائدة.
 * @param {number} part
 * @param {number} total
 * @returns {string}
 */
export function formatPercent(part, total) {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return '—';
  return `${Math.round((part / total) * 100)}%`;
}

/** @param {string} selector @param {ParentNode} [scope] */
export function qs(selector, scope) {
  const root = scope ?? (typeof document === 'undefined' ? null : document);
  return root ? root.querySelector(selector) : null;
}

/** @param {string} selector @param {ParentNode} [scope] */
export function qsa(selector, scope) {
  const root = scope ?? (typeof document === 'undefined' ? null : document);
  return root ? Array.from(root.querySelectorAll(selector)) : [];
}

/**
 * إعلان لقارئ الشاشة عبر منطقة حيّة.
 * @param {string} message
 */
export function announce(message) {
  const region = qs('[data-live-region]');
  if (!region) return;
  region.textContent = '';
  window.setTimeout(() => {
    region.textContent = message;
  }, 50);
}

/**
 * ضبط شارة حالة نصية (لا لون وحده).
 * @param {Element|null} element
 * @param {{text: string, tone?: 'ok'|'warn'|'danger'|'info'}} state
 */
export function setStatus(element, state) {
  if (!element) return;
  element.classList.remove('status--ok', 'status--warn', 'status--danger', 'status--info');
  element.classList.add('status', `status--${state.tone ?? 'info'}`);
  element.textContent = state.text;
  element.removeAttribute('aria-busy');
}
