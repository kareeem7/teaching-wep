import { escapeHtml } from '../ui.js';

const TONES = new Set(['info', 'ok', 'warn', 'danger']);

/**
 * تنبيه عابر غير معطِّل. لا يعتمد على إضافة أي مكتبة خارج Bootstrap المحلية.
 * @param {string} message
 * @param {{tone?: 'info'|'ok'|'warn'|'danger', delay?: number}} [options]
 */
export function showToast(message, options = {}) {
  const { tone = 'info', delay = 5000 } = options;
  if (typeof document === 'undefined') return null;

  let container = document.querySelector('[data-toast-container]');
  if (!container) {
    container = document.createElement('div');
    container.setAttribute('data-toast-container', '');
    container.className = 'position-fixed bottom-0 start-0 p-3';
    container.style.zIndex = '1080';
    document.body.append(container);
  }

  const toast = document.createElement('div');
  toast.className = 'toast show';
  toast.setAttribute('role', TONES.has(tone) && tone !== 'ok' ? 'alert' : 'status');
  toast.innerHTML = `
    <div class="toast-body d-flex align-items-start gap-2">
      <span aria-hidden="true">•</span>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
  container.append(toast);
  window.setTimeout(() => toast.remove(), delay);
  return toast;
}
