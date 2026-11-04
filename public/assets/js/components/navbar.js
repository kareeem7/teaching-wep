import { escapeHtml } from '../ui.js';

/**
 * شريط علوي موحّد لكل الصفحات.
 * @param {{brandHref?: string, meta?: string, links?: Array<{label: string, href: string}>}} options
 * @returns {HTMLElement|null}
 */
export function renderNavbar(options = {}) {
  const { brandHref = 'index.html', meta = '', links = [] } = options;
  const host = document.querySelector('[data-component="navbar"]');
  if (!host) return null;

  const items = links
    .map((link) => `<a class="app-nav__link" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`)
    .join('');

  host.innerHTML = `
    <header class="app-topbar">
      <a class="app-topbar__brand" href="${escapeHtml(brandHref)}">
        <span class="app-topbar__mark" aria-hidden="true">م</span>
        <span>مِنهاج</span>
      </a>
      <span class="app-topbar__spacer"></span>
      ${meta ? `<span class="app-topbar__meta">${escapeHtml(meta)}</span>` : ''}
      ${items ? `<nav aria-label="روابط سريعة">${items}</nav>` : ''}
    </header>
  `;
  return host;
}
