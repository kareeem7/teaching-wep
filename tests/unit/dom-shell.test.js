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
  assert.equal(doc.querySelectorAll('.app-sidebar .app-nav__link').length, 1);
  assert.equal(doc.querySelector('.app-sidebar .app-nav__link').getAttribute('aria-current'), 'page');
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
    supabaseUrl: 'https://unitstub000000000000.supabase.co',
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

/* =====================================================================
   المرحلة ٠٣ — صفحات الإدارة تحت jsdom (بديل محلي عن المتصفح المحجوب)
   الصفحات تُقرأ من ملفاتها الحقيقية، والعميل مزيّف صريح: لا شبكة ولا أسرار.
   ===================================================================== */

const ADMIN_PAGES = {
  dashboard: new URL('../../public/pages/admin/dashboard.html', import.meta.url),
  teachers: new URL('../../public/pages/admin/teachers.html', import.meta.url),
  detail: new URL('../../public/pages/admin/teacher-detail.html', import.meta.url),
  instructions: new URL('../../public/pages/admin/instructions.html', import.meta.url),
};

/** يحمّل صفحة إدارية حقيقية ويثبّت عميلًا مزيّفًا يعيد عروضًا محددة. */
function loadAdminPage(file, { views = {}, search = '' } = {}) {
  const html = readFileSync(file, 'utf8');
  const dom = new JSDOM(html, { url: `https://minhaj.test/pages/admin/page.html${search}` });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  const client = {
    auth: { getSession: async () => ({ data: { session: { access_token: 'fake' } }, error: null }) },
    from: (view) => ({
      select() {
        return Promise.resolve({ data: views[view] ?? [], error: null });
      },
    }),
  };
  return { dom, client };
}

test('المرحلة ٠٣: اللوحة تعرض أرقام الخادم وتعلن القراءة فقط', async () => {
  const { client } = loadAdminPage(ADMIN_PAGES.dashboard, {
    views: {
      admin_overview: [{ stats: { teachers_total: 4, teachers_active: 3, students_total: 55 } }],
      admin_audit_log: [{ action: 'admin.teacher.invited', actor_name: 'أدمن', at: '2026-11-05T08:00:00Z', outcome: 'ok' }],
    },
  });

  const { initAdminDashboardPage } = await import('../../public/assets/js/admin/dashboard.js');
  const result = await initAdminDashboardPage({ client, guard: async () => ({ allowed: true, reason: 'ok' }) });

  assert.equal(result.allowed, true);
  const doc = globalThis.document;
  assert.equal(doc.querySelector('[data-stat="teachers_total"] [data-stat-value]').textContent, '4');
  assert.equal(doc.querySelector('[data-stat="teachers_active"] [data-stat-value]').textContent, '3');
  assert.match(doc.querySelector('[data-readonly-notice]').textContent, /قراءة أكاديمية فقط/);
  assert.equal(doc.querySelectorAll('[data-audit-list] li').length, 1);
  assert.match(doc.body.dataset.adminState, /ready/);
  cleanup();
});

test('المرحلة ٠٣: قيمة غائبة تُعرض «—» لا صفرًا كاذبًا', async () => {
  const { client } = loadAdminPage(ADMIN_PAGES.dashboard, {
    views: { admin_overview: [{ stats: { teachers_total: 2 } }], admin_audit_log: [] },
  });

  const { initAdminDashboardPage } = await import('../../public/assets/js/admin/dashboard.js');
  await initAdminDashboardPage({ client, guard: async () => ({ allowed: true, reason: 'ok' }) });

  const doc = globalThis.document;
  assert.equal(doc.querySelector('[data-stat="groups_active"] [data-stat-value]').textContent, '—');
  cleanup();
});

test('المرحلة ٠٣: قائمة المدرسين تُبنى من الصفوف وتُصفّى وتُرقَّم', async () => {
  const teachers = Array.from({ length: 12 }, (_, index) => ({
    teacher_id: `t-${index}`,
    full_name: `مدرس ${index + 1}`,
    status: index === 0 ? 'suspended' : 'active',
    phone_last4: '0001',
    students_count: 0,
    groups_active: 0,
    assistants_active: 0,
    students_pending_link: 0,
  }));

  const { client } = loadAdminPage(ADMIN_PAGES.teachers, {
    views: { admin_teachers: teachers, admin_invitations: [] },
  });

  const { initAdminTeachersPage } = await import('../../public/assets/js/admin/teachers.js');
  await initAdminTeachersPage({ client, guard: async () => ({ allowed: true, reason: 'ok' }) });

  const doc = globalThis.document;
  assert.equal(doc.querySelectorAll('[data-teachers-body] tr[data-teacher-id]').length, 10, 'صفحة واحدة = ١٠ صفوف');
  assert.match(doc.querySelector('[data-page-info]').textContent, /1–10/);
  assert.equal(doc.body.dataset.totalTeachers, '12');

  // تصفية بالحالة: مدرس واحد موقوف
  const status = doc.querySelector('[data-filter="status"]');
  status.value = 'suspended';
  status.dispatchEvent(new globalThis.window.Event('change'));
  assert.equal(doc.querySelectorAll('[data-teachers-body] tr[data-teacher-id]').length, 1);

  // تصفية بالبحث
  status.value = '';
  status.dispatchEvent(new globalThis.window.Event('change'));
  const search = doc.querySelector('[data-filter="q"]');
  search.value = 'مدرس 12';
  search.dispatchEvent(new globalThis.window.Event('input'));
  assert.equal(doc.querySelectorAll('[data-teachers-body] tr[data-teacher-id]').length, 1);
  cleanup();
});

test('المرحلة ٠٣: لا حقل أكاديمي في صفحة الملف — والنموذج الوحيد قرار حالة', () => {
  const { dom } = loadAdminPage(ADMIN_PAGES.detail);
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll('form').length, 1);
  assert.equal(doc.querySelector('form').dataset.form, 'account-status');
  assert.equal(doc.querySelectorAll('input[name*="grade" i], input[name*="attendance" i]').length, 0);
  assert.ok(doc.querySelector('#status-reason').hasAttribute('required'));
  cleanup();
});

test('المرحلة ٠٣: أدوار غير الإدارة تُرفض في الحارس بلا رسم بيانات', async () => {
  const { client } = loadAdminPage(ADMIN_PAGES.dashboard, {
    views: { admin_overview: [{ stats: { teachers_total: 9 } }], admin_audit_log: [] },
  });

  const { initAdminDashboardPage } = await import('../../public/assets/js/admin/dashboard.js');
  const result = await initAdminDashboardPage({
    client,
    guard: async () => ({ allowed: false, reason: 'not-admin' }),
  });

  assert.equal(result.allowed, false);
  assert.equal(globalThis.document.body.dataset.adminState, 'denied');
  assert.equal(globalThis.document.querySelectorAll('[data-stat]').length, 0, 'لا أرقام لغير الإدارة');
  cleanup();
});
