import { escapeHtml } from '../ui.js';

/**
 * قائمة جانبية للتنقل داخل مساحة الدور.
 * @param {{title?: string, links: Array<{label: string, href: string, current?: boolean}>}} options
 * @returns {HTMLElement|null}
 */
export function renderSidebar(options = {}) {
  const { title = 'التنقل', links = [] } = options;
  const host = document.querySelector('[data-component="sidebar"]');
  if (!host) return null;

  const items = links
    .map((link) => {
      const current = link.current ? ' aria-current="page"' : '';
      return `<li><a class="app-nav__link" href="${escapeHtml(link.href)}"${current}>${escapeHtml(link.label)}</a></li>`;
    })
    .join('');

  host.innerHTML = `
    <aside class="app-sidebar">
      <p class="app-sidebar__title">${escapeHtml(title)}</p>
      <ul class="app-nav">${items}</ul>
    </aside>
  `;
  return host;
}
