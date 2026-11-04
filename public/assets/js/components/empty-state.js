/**
 * حالة فارغة معيارية: تُستخدم عندما لا توجد بيانات، لا عند فشل التحميل.
 */

import { el } from '../ui.js';

/**
 * @param {{title: string, text?: string, icon?: string, action?: {label: string, href?: string, onClick?: Function}}} options
 * @returns {HTMLElement}
 */
export function createEmptyState(options) {
  const { title, text = '', icon = '◻', action } = options;
  const wrapper = el('div', null, 'empty-state');
  wrapper.append(el('div', icon, 'empty-state__icon'));
  wrapper.append(el('p', title, 'empty-state__title'));
  if (text) wrapper.append(el('p', text, 'empty-state__text'));

  if (action) {
    const button = el(action.href ? 'a' : 'button', action.label, 'btn btn-outline-primary btn-sm mt-3');
    if (action.href) {
      button.href = action.href;
    } else {
      button.type = 'button';
      if (typeof action.onClick === 'function') button.addEventListener('click', action.onClick);
    }
    wrapper.append(button);
  }
  return wrapper;
}

/**
 * يستبدل محتوى حاوية بحالة فارغة.
 * @param {Element|null} container
 * @param {Parameters<typeof createEmptyState>[0]} options
 */
export function renderEmptyState(container, options) {
  if (!container) return;
  container.replaceChildren(createEmptyState(options));
}
