/**
 * أدوات واجهة مشتركة: تنسيق التواريخ والأرقام العربية، وحالات التحميل، وحقن النصوص بأمان.
 * لا تُبنى نصوص HTML من مدخلات المستخدم أبدًا؛ يُستخدم textContent.
 */

import { APP } from './config.js';

const numberFormatter = new Intl.NumberFormat(APP.locale);
const dateFormatter = new Intl.DateTimeFormat(APP.locale, {
  timeZone: APP.timeZone,
  dateStyle: 'medium'
});
const dateTimeFormatter = new Intl.DateTimeFormat(APP.locale, {
  timeZone: APP.timeZone,
  dateStyle: 'medium',
  timeStyle: 'short'
});

/**
 * @param {number} value
 * @returns {string} رقم منسّق بالعربية
 */
export function formatNumber(value) {
  return Number.isFinite(value) ? numberFormatter.format(value) : '—';
}

/**
 * @param {string|number|Date} value
 * @param {{withTime?: boolean}} [options]
 * @returns {string} تاريخ بتوقيت القاهرة
 */
export function formatDate(value, options = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return (options.withTime ? dateTimeFormatter : dateFormatter).format(date);
}

/**
 * يحوّل نصًا إلى عنصر نصي آمن (بلا تفسير HTML).
 * @param {string} tag
 * @param {string} text
 * @param {string} [className]
 * @returns {HTMLElement}
 */
export function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

/**
 * يملأ كل العناصر التي تحمل data-brand بالاسم المعتمد.
 * @param {ParentNode} [root]
 */
export function hydrateBrand(root = document) {
  for (const node of root.querySelectorAll('[data-brand]')) {
    node.textContent = APP.name;
  }
  for (const node of root.querySelectorAll('[data-app-version]')) {
    node.textContent = `v${APP.version}`;
  }
}

/**
 * يحدد رابط التنقل الحالي حسب اسم الملف.
 */
export function markActiveNav() {
  const current = window.location.pathname.split('/').pop() || 'index.html';
  for (const link of document.querySelectorAll('[data-nav]')) {
    const href = link.getAttribute('href') || '';
    const target = href.split('/').pop() || '';
    const isActive = target === current;
    link.classList.toggle('active', isActive);
    if (isActive) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  }
}

/**
 * تبديل حالة الانشغال على زر.
 * @param {HTMLButtonElement} button
 * @param {boolean} busy
 * @param {string} [busyLabel]
 */
export function setBusy(button, busy, busyLabel = 'جارٍ التنفيذ…') {
  if (!button) return;
  if (busy) {
    button.dataset.idleLabel = button.textContent ?? '';
    button.textContent = busyLabel;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  } else {
    button.textContent = button.dataset.idleLabel ?? button.textContent;
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}
