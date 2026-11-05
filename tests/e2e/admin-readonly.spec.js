import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * حدود لوحة الإدارة (المرحلة ٠٣).
 *
 * هذه ليست اختبارات صلاحية: من يعطّل الحارس في المتصفح يصل إلى عروض RLS التي تُرجع
 * صفر صفوف، وإلى دوال تردّ 403. الملف هنا يثبت ثلاثة أمور **حقيقية**:
 *   ١. غير السوبر أدمن يُحوَّل خارج الصفحات الإدارية (تجربة استخدام).
 *   ٢. الواجهة لا تملك مسار كتابة أكاديمية أصلًا — لا زر ولا دالة في طبقة النقل.
 *   ٣. عدد المستلمين المعروض يأتي من الخادم، لا من حساب المتصفح.
 */

const VALID_URL = 'https://e2eadmin000000000000.supabase.co'; // ٢٠ محرفًا: شرط isValidSupabaseUrl
const VALID_KEY = 'sb_publishable_e2e_admin_key';

async function stubSupabase(page, { role = 'super_admin', views = {} } = {}) {
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
            return Promise.resolve({ data: data[viewName] ?? [], error: null }).then(onFulfilled);
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

      data.me = [{ user_id: 'admin-user', full_name: 'مستخدم', role: roleName, status: 'active' }];
    },
    { url: VALID_URL, key: VALID_KEY, roleName: role, data: { ...views } },
  );
}

test('المدرس يُحوَّل بعيدًا عن لوحة الإدارة', async ({ page }) => {
  await stubSupabase(page, { role: 'teacher' });
  await page.goto('/pages/admin/dashboard.html');
  await page.waitForURL(/pages\/errors\/403\.html/);
  await expect(page).toHaveURL(/403\.html/);
});

test('الطالب يُحوَّل بعيدًا عن صفحة التعليمات', async ({ page }) => {
  await stubSupabase(page, { role: 'student' });
  await page.goto('/pages/admin/instructions.html');
  await page.waitForURL(/pages\/errors\/403\.html/);
});

test('لوحة الإدارة تعلن حدودها القرائية بوضوح', async ({ page }) => {
  await stubSupabase(page, {
    views: {
      admin_overview: [{ stats: { teachers_total: 3, teachers_active: 2, students_total: 40, audit_events_24h: 5 } }],
      admin_audit_log: [],
    },
  });

  await page.goto('/pages/admin/dashboard.html');
  await expect(page.locator('body')).toHaveAttribute('data-admin-state', 'ready');
  await expect(page.locator('[data-readonly-notice]')).toContainText('قراءة أكاديمية فقط');
  await expect(page.locator('[data-stat="teachers_total"] [data-stat-value]')).toHaveText('3');
});

test('الأرقام المعروضة من الخادم لا تُحسب في المتصفح', async ({ page }) => {
  // الخادم يعيد رقمًا مختلفًا عن أي حساب محلي (المدارس في العرض ٣، والخادم يقول ٩٩)
  await stubSupabase(page, {
    views: {
      admin_overview: [{ stats: { teachers_active: 99, teachers_total: 99 } }],
      admin_audit_log: [],
    },
  });

  await page.goto('/pages/admin/dashboard.html');
  await expect(page.locator('[data-admin-state]')).toHaveAttribute('data-admin-state', 'ready');
  await expect(page.locator('[data-stat="teachers_active"] [data-stat-value]')).toHaveText('99');
});

test('عدد مستلمي التعليم يأتي من رد الخادم', async ({ page }) => {
  await stubSupabase(page, {
    views: {
      admin_instructions: [],
      admin_teachers: [
        { teacher_id: 't1', full_name: 'مدرس أ', status: 'active' },
        { teacher_id: 't2', full_name: 'مدرس ب', status: 'active' },
      ],
    },
  });

  await page.route('**/functions/v1/admin-instructions', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      // الخادم يقول ٧ بينما العرض المحلي فيه مدرسان — العبرة بالخادم.
      body: JSON.stringify({ ok: true, data: { notification_id: 'n-1', recipients: 7, sent_at: '2026-11-05T09:00:00Z' } }),
    });
  });

  await page.goto('/pages/admin/instructions.html');
  await expect(page.locator('body')).toHaveAttribute('data-admin-state', 'ready');

  await page.locator('#instruction-title').fill('اجتماع المدرسين');
  await page.locator('#instruction-body').fill('يرجى مراجعة خطة الأسبوع قبل الخميس.');
  await page.locator('[data-action="send-instruction"]').click();

  await expect(page.locator('[data-send-result]')).toContainText('7');
});

test('طبقة النقل في الواجهة لا تُصدّر أي كتابة أكاديمية', () => {
  const source = readFileSync(new URL('../../public/assets/js/api.js', import.meta.url), 'utf8');
  // لا دوال إدراج/تحديث/حذف لبيانات أكاديمية في المتصفح:
  // القرارات الحساسة تُمرَّر عبر دوال Edge التي تتحقق من الدور في SQL.
  expect(source).not.toMatch(/export\s+(async\s+)?function\s+(insert|update|delete|patch)/i);
  expect(source).not.toMatch(/from\(['"]app\./);
  expect(source).not.toMatch(/\.(insert|upsert|delete)\(/);
});

test('لا شاشة إدارية تحتوي حقلًا لبيانات أكاديمية', () => {
  const pages = [
    '../../public/pages/admin/dashboard.html',
    '../../public/pages/admin/teachers.html',
    '../../public/pages/admin/teacher-detail.html',
    '../../public/pages/admin/instructions.html',
  ];

  for (const rel of pages) {
    const html = readFileSync(new URL(rel, import.meta.url), 'utf8');
    expect(html, `${rel}: لا حقل درجة/حضور`).not.toMatch(/name="(grade|attendance|score|answer)"/i);
    expect(html, `${rel}: لا استدعاء جداول أكاديمية`).not.toMatch(/from\(['"]app\./);
  }
});
