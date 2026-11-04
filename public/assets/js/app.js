/**
 * نقطة تشغيل الواجهة المشتركة لكل الصفحات.
 * تُحمَّل كوحدة واحدة (type="module") وتقوم بـ: الهوية، التنقل، التاريخ،
 * حراسة الروابط المحمية، وتشغيل الصفحة الخاصة إن وُجدت.
 */

import { APP, appUrl } from './config.js';
import { hydrateBrand, markActiveNav } from './ui.js';
import { mountNavbar } from './components/navbar.js';
import { redirectToLogin } from './auth-guard.js';

/**
 * يضبط الروابط التي تفتح صفحات محمية: لا نُخفي الرابط، بل نوجّه الزائر
 * إلى تسجيل الدخول مع حفظ الوجهة. الحماية الفعلية في المرحلة ٠٢ عبر RLS.
 * @param {ParentNode} root
 */
function wireProtectedLinks(root) {
  for (const link of root.querySelectorAll('[data-requires-session]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      redirectToLogin(link.dataset.next || appUrl('index.html'));
    });
  }
}

/**
 * يملأ أي عنصر يحمل data-supabase-url بعنوان المشروع (معلومة غير حساسة).
 * @param {ParentNode} root
 */
function hydrateStaticInfo(root) {
  for (const node of root.querySelectorAll('[data-supabase-host]')) {
    try {
      node.textContent = new URL(APP.supabase.url).host;
    } catch {
      node.textContent = '—';
    }
  }
  for (const node of root.querySelectorAll('[data-timezone]')) {
    node.textContent = APP.timeZone;
  }
}

export function boot() {
  hydrateBrand(document);
  mountNavbar(document.querySelector('[data-component="navbar"]'));
  markActiveNav();
  hydrateStaticInfo(document);
  wireProtectedLinks(document);

  for (const node of document.querySelectorAll('[data-year]')) {
    node.textContent = String(new Date().getFullYear());
  }

  document.documentElement.dataset.appReady = 'true';
  document.dispatchEvent(new CustomEvent('minhaj:ready', { detail: { version: APP.version } }));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
