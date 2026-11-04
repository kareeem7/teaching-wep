/**
 * تنبيهات منبثقة بسيطة (toast) بلا اعتماد على مكوّن Bootstrap التفاعلي،
 * لأن بعض الصفحات لا تحمّل الحزمة كاملة. متاح للقارئ الشاشي عبر role="status".
 */

import { el } from '../ui.js';

/**
 * @returns {HTMLElement} حاوية التنبيهات
 */
function stack() {
  let node = document.querySelector('.toast-stack');
  if (!node) {
    node = el('div', null, 'toast-stack');
    node.setAttribute('aria-live', 'polite');
    node.setAttribute('aria-atomic', 'false');
    document.body.append(node);
  }
  return node;
}

/**
 * يعرض تنبيهًا يختفي تلقائيًا.
 * @param {string} message
 * @param {{variant?: 'info'|'success'|'warning'|'danger', timeout?: number}} [options]
 * @returns {HTMLElement}
 */
export function showToast(message, options = {}) {
  const { variant = 'info', timeout = 5000 } = options;
  const toast = el('div', null, `app-toast app-toast--${variant}`);
  toast.setAttribute('role', variant === 'danger' ? 'alert' : 'status');

  const text = el('span', message, 'app-toast__text');
  const close = el('button', '✕', 'app-toast__close');
  close.type = 'button';
  close.setAttribute('aria-label', 'إغلاق التنبيه');

  const remove = () => toast.remove();
  close.addEventListener('click', remove);
  toast.append(text, close);
  stack().append(toast);

  if (timeout > 0) {
    window.setTimeout(remove, timeout);
  }
  return toast;
}

/**
 * يزيل كل التنبيهات المعروضة.
 */
export function clearToasts() {
  document.querySelector('.toast-stack')?.replaceChildren();
}

export const Toast = { show: showToast, clear: clearToasts };
