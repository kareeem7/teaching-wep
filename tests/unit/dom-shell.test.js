/**
 * اختبارات DOM حقيقية (jsdom) للصفحة المحمية ومكوّناتها.
 *
 * الغرض: دليل محلي على إصلاح H-01 وH-02 من تقرير الفحص PHASE_01_CHECK،
 * بلا حاجة إلى متصفح مُنزَّل (تنزيل المتصفحات محجوب في بيئة الفحص).
 *
 * الصفحة تُقرأ من الملف الحقيقي `public/pages/shared/app-shell.html`،
 * لا من نسخة مكتوبة داخل الاختبار — حتى لا يمرّ الاختبار على صفحة وهمية.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SHELL = new URL('../../public/pages/shared/app-shell.html', import.meta.url);

/** يبني DOM من الملف الحقيقي ويضعه كـdocument عالمي مؤقتًا. */
function loadShell() {
  const html = readFileSync(SHELL, 'utf8');
  const dom = new JSDOM(html, { url: 'https://minhaj.test/pages/shared/app-shell.html' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  return dom;
}

function cleanup() {
  delete globalThis.window;
  delete globalThis.document;
}

test('H-01: الصفحة المحمية تحمل data-requires-auth="true"', () => {
  const dom = loadShell();
  assert.equal(dom.window.document.body.dataset.requiresAuth, 'true');
  cleanup();
});

test('H-02: الصفحة تحمل data-role-label ونقطة تركيب الشريط الجانبي', () => {
  const dom = loadShell();
  assert.match(dom.window.document.body.dataset.roleLabel, /مساحة العمل/);
  assert.ok(dom.window.document.querySelector('[data-component="sidebar"]'));
  assert.ok(dom.window.document.querySelector('[data-empty-host]'));
  cleanup();
});

test('H-02: renderSidebar يبني الهيكل الفعلي بعد اجتياز الحارس', async () => {
  const dom = loadShell();
  const { renderSidebar } = await import('../../public/assets/js/components/sidebar.js');
  const host = renderSidebar({
    title: 'مساحة العمل (نموذج)',
    links: [{ label: 'الرئيسية', href: '../../index.html', current: true }],
  });
  const doc = dom.window.document;
  assert.ok(host);
  assert.ok(doc.querySelector('.app-sidebar'));
  assert.match(doc.querySelector('.app-sidebar__title').textContent, /مساحة العمل/);
  assert.equal(doc.querySelectorAll('.app-nav__link').length, 1);
  assert.equal(doc.querySelector('.app-nav__link').getAttribute('aria-current'), 'page');
  cleanup();
});

test('H-02: الحالة الفارغة تُحقن في نقطة التركيب بصدق', async () => {
  const dom = loadShell();
  const { renderEmptyState } = await import('../../public/assets/js/components/empty-state.js');
  const doc = dom.window.document;
  doc.querySelector('[data-empty-host]').append(renderEmptyState({ title: 'لا بيانات بعد' }));
  assert.match(doc.querySelector('.empty-state__title').textContent, /لا بيانات بعد/);
  cleanup();
});

test('M-01: showToast له مسار تنفيذ حقيقي', async () => {
  const dom = loadShell();
  const { showToast } = await import('../../public/assets/js/components/toast.js');
  const toast = showToast('إعداد Supabase غير صالح — راجع صفحة صحة النظام.', { tone: 'danger', delay: 10 });
  const doc = dom.window.document;
  assert.ok(toast);
  assert.ok(doc.querySelector('[data-toast-container] .toast'));
  assert.equal(doc.querySelector('.toast').getAttribute('role'), 'alert');
  cleanup();
});

test('الحارس: الزائر بلا إعداد مصادقة يُرفض مع سبب unconfigured', async () => {
  loadShell();
  delete globalThis.__MINHAJ_ENV__;
  const { checkSession, guardPage, buildLoginUrl, relativePrefix } = await import(
    '../../public/assets/js/auth-guard.js'
  );
  const result = await checkSession();
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'unconfigured');

  const guard = await guardPage({ redirect: false });
  assert.equal(guard.allowed, false);
  assert.equal(globalThis.document.body.dataset.authState, 'denied');

  assert.equal(relativePrefix('/pages/shared/app-shell.html'), '../../');
  const url = buildLoginUrl('/pages/shared/app-shell.html', '../../');
  assert.match(url, /^\.\.\/\.\.\/pages\/auth\/login\.html\?next=/);
  cleanup();
});

test('الحارس: جلسة مُحاكاة تسمح بالمرور', async () => {
  loadShell();
  globalThis.__MINHAJ_ENV__ = {
    supabaseUrl: 'https://unitstubunitstub1234.supabase.co',
    publishableKey: 'sb_publishable_unit_stub',
  };
  globalThis.supabase = {
    createClient: () => ({
      auth: { getSession: async () => ({ data: { session: { access_token: 'stub' } }, error: null }) },
    }),
  };
  const { guardPage, checkSession } = await import('../../public/assets/js/auth-guard.js');
  const guard = await guardPage({ redirect: false });
  assert.equal(guard.allowed, true);
  assert.equal((await checkSession()).reason, 'ok');
  delete globalThis.__MINHAJ_ENV__;
  delete globalThis.supabase;
  cleanup();
});
