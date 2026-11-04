/**
 * الشبكة الجانبية. العناصر غير المنجزة تظهر معطّلة (aria-disabled) ولا تُخفى،
 * حتى لا يوحي التطبيق بوظائف غير موجودة.
 */

import { el } from '../ui.js';

/**
 * @typedef {{label: string, href?: string, disabled?: boolean, hint?: string}} SidebarItem
 */

/**
 * @param {HTMLElement} container
 * @param {{title?: string, items: SidebarItem[]}} options
 */
export function mountSidebar(container, options) {
  const { title = 'التنقل', items = [] } = options;
  const aside = el('aside', null, 'app-sidebar');
  aside.setAttribute('aria-label', title);
  aside.append(el('p', title, 'app-sidebar__title'));

  for (const item of items) {
    if (item.disabled || !item.href) {
      const span = el('span', item.label, 'app-sidebar__link app-sidebar__link--disabled');
      span.setAttribute('aria-disabled', 'true');
      if (item.hint) span.title = item.hint;
      aside.append(span);
      continue;
    }
    const link = el('a', item.label, 'app-sidebar__link');
    link.href = item.href;
    aside.append(link);
  }

  container.replaceWith(aside);
}
