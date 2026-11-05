import { test, expect } from '@playwright/test';

/**
 * واجهة إدارة المدرسين (المرحلة ٠٣) — **اختبار عرض، لا اختبار صلاحية**.
 *
 * العزل والقرارات الحقيقية تُثبت في `tests/sql/admin_rls.test.sql` على PostgreSQL
 * وفي `tests/unit/functions.test.js`. ما يُثبته هذا الملف:
 *   ١. القائمة تُبنى من رد الخادم لا من ثابت في الصفحة.
 *   ٢. التصفية والترقيم يعملان على نفس البيانات.
 *   ٣. رابط الدعوة يظهر مرة واحدة بعد الرد، ولا يُخزَّن في الصفحة.
 *   ٤. لا يوجد في أي شاشة إدارية حقل لتعديل بيانات أكاديمية.
 */

const VALID_URL = 'https://e2eadmin00000000000.supabase.co';
const VALID_KEY = 'sb_publishable_e2e_admin_key';

const TEACHERS = [
  {
    teacher_id: 'teacher-a', full_name: 'مدرس أ', status: 'active', phone_last4: '0001',
    headline: 'رياضيات', created_at: '2026-10-01T10:00:00Z', students_count: 12,
    students_active: 10, students_pending_link: 2, groups_active: 3, assistants_active: 1,
    invitations_pending: 0,
  },
  {
    teacher_id: 'teacher-b', full_name: 'مدرس ب', status: 'suspended', phone_last4: '0002',
    headline: 'علوم', created_at: '2026-10-02T10:00:00Z', students_count: 0,
    students_active: 0, students_pending_link: 0, groups_active: 0, assistants_active: 0,
    invitations_pending: 1,
  },
];

/**
 * يثبّت عميل Supabase وهميًا: `auth.getSession` + `from(view).select()` ثمable.
 * @param {import('@playwright/test').Page} page
 * @param {{role?: string, views?: Record<string, unknown[]>}} [options]
 */
async function stubAdmin(page, options = {}) {
  const role = options.role ?? 'super_admin';
  const views = options.views ?? {};

  await page.addInitScript(
    ({ url, key, roleName, data }) => {
      window.__MINHAJ_ENV__ = { supabaseUrl: url, publishableKey: key };

      const makeChain = (viewName) => {
        const chain = {
          select() {
            return chain;
          },
          order() {
            return chain;
          },
          eq() {
            return chain;
          },
          range() {
            return chain;
          },
          limit() {
            return chain;
          },
          then(onFulfilled) {
            const rows = data[viewName] ?? [];
            return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
          },
        };
        return chain;
      };

      const session = { access_token: 'e2e-admin-token', refresh_token: 'e2e-refresh', user: { id: 'admin-user' } };
      const client = {
        auth: {
          getSession: async () => ({ data: { session }, error: null }),
          setSession: async () => ({ data: { session }, error: null }),
          signOut: async () => ({ error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
        },
        from: (viewName) => makeChain(viewName),
      };
      client.createClient = () => client;

      Object.defineProperty(window, 'supabase', { configurable: true, get: () => client, set: () => {} });
      window.__E2E_ROLE__ = roleName;
      // الدور يأتي من عرض `me` المحكوم بـRLS.
      data.me = [{ user_id: 'admin-user', full_name: 'أدمن', role: roleName, status: 'active' }];
    },
    { url: VALID_URL, key: VALID_KEY, roleName: role, data: { ...views } },
  );
}

/** يعترض دالة admin-teachers ويعيد ردًا محددًا. */
async function mockAdminFunction(page, responder) {
  await page.route('**/functions/v1/admin-teachers', async (route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: responder(body) }),
    });
  });
}

test('قائمة المدرسين تُبنى من رد الخادم', async ({ page }) => {
  await stubAdmin(page, {
    views: {
      admin_teachers: TEACHERS,
      admin_invitations: [],
    },
  });

  await page.goto('/pages/admin/teachers.html');
  await expect(page.locator('body')).toHaveAttribute('data-admin-state', 'ready');

  const rows = page.locator('[data-teachers-body] tr[data-teacher-id]');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('مدرس أ');
  await expect(rows.first().locator('[data-status]')).toContainText('نشط');
  await expect(rows.nth(1).locator('[data-status]')).toContainText('موقوف');
});

test('التصفية بالبحث والحالة تعمل على نفس بيانات الخادم', async ({ page }) => {
  await stubAdmin(page, { views: { admin_teachers: TEACHERS, admin_invitations: [] } });
  await page.goto('/pages/admin/teachers.html');
  await expect(page.locator('body')).toHaveAttribute('data-admin-state', 'ready');

  await page.locator('[data-filter="q"]').fill('مدرس ب');
  await expect(page.locator('[data-teachers-body] tr[data-teacher-id]')).toHaveCount(1);

  await page.locator('[data-filter="q"]').fill('');
  await page.locator('[data-filter="status"]').selectOption('active');
  await expect(page.locator('[data-teachers-body] tr[data-teacher-id]')).toHaveCount(1);
  await expect(page.locator('[data-teachers-body]')).toContainText('مدرس أ');
});

test('الترقيم يعرض عشر صفحات-صفوف ثم الباقي', async ({ page }) => {
  const many = Array.from({ length: 12 }, (_, index) => ({
    teacher_id: `t-${index}`,
    full_name: `مدرس ${index + 1}`,
    status: 'active',
    phone_last4: String(1000 + index),
    headline: null,
    created_at: '2026-10-01T10:00:00Z',
    students_count: 0,
    students_active: 0,
    students_pending_link: 0,
    groups_active: 0,
    assistants_active: 0,
    invitations_pending: 0,
  }));

  await stubAdmin(page, { views: { admin_teachers: many, admin_invitations: [] } });
  await page.goto('/pages/admin/teachers.html');
  await expect(page.locator('body')).toHaveAttribute('data-admin-state', 'ready');

  await expect(page.locator('[data-teachers-body] tr[data-teacher-id]')).toHaveCount(10);
  await expect(page.locator('[data-page-info]')).toContainText('1–10');

  await page.locator('[data-action="next-page"]').click();
  await expect(page.locator('[data-teachers-body] tr[data-teacher-id]')).toHaveCount(2);
  await expect(page.locator('[data-page-info]')).toContainText('11–12');
});

test('رابط الدعوة يظهر مرة واحدة من رد الخادم', async ({ page }) => {
  await stubAdmin(page, { views: { admin_teachers: TEACHERS, admin_invitations: [] } });
  const link = 'https://app.example.test/pages/auth/accept-invitation.html?token=e2e-once-token';

  await mockAdminFunction(page, (body) => ({
    action: body.action,
    invitation_id: 'dddddddd-0000-0000-0000-0000000000aa',
    expires_at: '2026-11-08T10:00:00Z',
    phone_last4: '0077',
    invite_link: link,
  }));

  await page.goto('/pages/admin/teachers.html');
  await expect(page.locator('body')).toHaveAttribute('data-admin-state', 'ready');

  await page.locator('#invite-name').fill('مدرس جديد');
  await page.locator('#invite-phone').fill('01000000077');
  await page.locator('[data-action="send-invite"]').click();

  const linkElement = page.locator('[data-invite-link]');
  await expect(linkElement).toBeVisible();
  await expect(linkElement).toHaveText(link);
  await expect(page.locator('[data-invite-result]')).toContainText('مرة واحدة');
  // الرابط لا يُحقن في أي حقل مخفي أو في عنوان الصفحة
  await expect(page.locator('input[value*="token="]')).toHaveCount(0);
});

test('إعادة إصدار الدعوة تُظهر رابطًا جديدًا وتحدّث القائمة', async ({ page }) => {
  await stubAdmin(page, {
    views: {
      admin_teachers: TEACHERS,
      admin_invitations: [
        {
          id: 'dddddddd-0000-0000-0000-0000000000bb', target_name: 'مدرس معلّق', target_hint: '+201000000099',
          created_at: '2026-11-04T10:00:00Z', expires_at: '2026-11-07T10:00:00Z', state: 'pending',
        },
      ],
    },
  });

  await mockAdminFunction(page, () => ({
    invitation_id: 'dddddddd-0000-0000-0000-0000000000cc',
    previous_id: 'dddddddd-0000-0000-0000-0000000000bb',
    expires_at: '2026-11-08T10:00:00Z',
    invite_link: 'https://app.example.test/pages/auth/accept-invitation.html?token=reissued-token',
  }));

  await page.goto('/pages/admin/teachers.html');
  await expect(page.locator('body')).toHaveAttribute('data-admin-state', 'ready');
  await expect(page.locator('[data-invitations-body] tr[data-invitation-id]')).toHaveCount(1);

  await page.locator('[data-action="reissue-invitation"]').click();
  await expect(page.locator('[data-invite-link]')).toContainText('reissued-token');
});

test('ملف المدرس قراءة فقط: لا حقل لتعديل بيانات أكاديمية', async ({ page }) => {
  await stubAdmin(page, {
    views: {
      admin_teachers: TEACHERS,
      admin_students: [
        {
          id: 'aaaaaaaa-0000-0000-0000-000000000001', teacher_id: 'teacher-a',
          teacher_name: 'مدرس أ', full_name: 'طالب أول', local_code: 'S1', grade: 'الثالث',
          status: 'active', linked_at: null, created_at: '2026-10-01T10:00:00Z',
        },
      ],
      admin_account_events: [
        {
          id: 1, user_id: 'teacher-b', full_name: 'مدرس ب', role: 'teacher',
          action: 'suspend', reason: 'مخالفة سياسة الاستخدام', at: '2026-11-04T09:00:00Z', actor_name: 'أدمن',
        },
      ],
    },
  });

  await page.goto('/pages/admin/teacher-detail.html?id=teacher-a');
  await expect(page.locator('body')).toHaveAttribute('data-admin-state', 'ready');
  await expect(page.locator('[data-teacher-name]')).toHaveText('مدرس أ');
  await expect(page.locator('[data-teacher-students]')).toContainText('طالب أول');

  // لا حقول أكاديمية في أي مكان بالصفحة
  const academicInputs = page.locator('input[name*="grade" i], input[name*="attendance" i], input[name*="score" i]');
  await expect(academicInputs).toHaveCount(0);

  // النموذج الوحيد للكتابة هو قرار الحالة، ويحمل سببًا إلزاميًا
  const forms = page.locator('form');
  await expect(forms).toHaveCount(1);
  await expect(page.locator('#status-reason')).toHaveAttribute('required', '');
});
