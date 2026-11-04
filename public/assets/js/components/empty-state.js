import { escapeHtml } from '../ui.js';

/**
 * حالة فارغة إرشادية: سبب + إجراء واحد واضح.
 * @param {{title: string, text?: string, icon?: string}} options
 * @returns {HTMLElement}
 */
export function renderEmptyState(options) {
  const { title, text = '', icon = '○' } = options;
  const wrapper = document.createElement('div');
  wrapper.className = 'empty-state';
  wrapper.innerHTML = `
    <p class="empty-state__icon" aria-hidden="true">${escapeHtml(icon)}</p>
    <h3 class="empty-state__title">${escapeHtml(title)}</h3>
    ${text ? `<p class="empty-state__text">${escapeHtml(text)}</p>` : ''}
  `;
  return wrapper;
}
