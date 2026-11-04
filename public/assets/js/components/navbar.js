/**
 * الشريط العلوي الموحّد. يُبنى من مصفوفة عناصر واحدة حتى لا تتفرق الروابط بين الصفحات.
 */

import { APP, appUrl } from '../config.js';
import { el } from '../ui.js';

/** @type {{label: string, path: string, nav?: string}[]} */
const LINKS = [
  { label: 'الرئيسية', path: 'index.html', nav: 'home' },
  { label: 'حالة النظام', path: 'pages/health.html', nav: 'health' },
  { label: 'الدخول', path: 'pages/auth/login.html', nav: 'login' }
];

/**
 * @param {HTMLElement} container
 */
export function mountNavbar(container) {
  const nav = el('nav', null, 'navbar navbar-expand-md app-navbar');
  nav.setAttribute('aria-label', 'التنقل الرئيسي');

  const inner = el('div', null, 'container app-main py-0');
  const brand = el('a', null, 'navbar-brand d-flex align-items-center');
  brand.href = appUrl('index.html');
  brand.append(el('span', null, 'brand-dot'), document.createTextNode(APP.name));

  const toggler = el('button', null, 'navbar-toggler');
  toggler.type = 'button';
  toggler.setAttribute('data-bs-toggle', 'collapse');
  toggler.setAttribute('data-bs-target', '#appNav');
  toggler.setAttribute('aria-controls', 'appNav');
  toggler.setAttribute('aria-expanded', 'false');
  toggler.setAttribute('aria-label', 'إظهار القائمة');
  toggler.append(el('span', null, 'navbar-toggler-icon'));

  const collapse = el('div', null, 'collapse navbar-collapse');
  collapse.id = 'appNav';
  const list = el('ul', null, 'navbar-nav ms-auto gap-1');
  for (const link of LINKS) {
    const item = el('li', null, 'nav-item');
    const anchor = el('a', link.label, 'nav-link');
    anchor.href = appUrl(link.path);
    anchor.dataset.nav = link.nav ?? '';
    item.append(anchor);
    list.append(item);
  }
  collapse.append(list);
  inner.append(brand, toggler, collapse);
  nav.append(inner);
  container.replaceWith(nav);
}

export { LINKS as NAV_LINKS };
