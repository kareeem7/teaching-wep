import { test, expect } from '@playwright/test';

/**
 * عزل مساحات المدرسين على مستوى **الواجهة** (المرحلة ٠٢).
 *
 * تنبيه منهجي مهم: هذا الملف لا يثبت أن الخادم يعزل البيانات. العزل الحقيقي في
 * `public/../supabase/migrations/0005_rls_identity.sql` ويُختبر في
 * `tests/sql/identity_rls.test.sql` على PostgreSQL.
 *
 * ما يثبته هذا الملف:
 *  ١. القائمة المعروضة تأتي من رد الخادم، لا من رابط أو من قيمة في العنوان.
 *  ٢. اختيار مساحة يخزّن مساحة واحدة فقط، ولا يمنح مساحة أخرى.
 *  ٣. اختبار مساحة مستخدم لآخر يفشل (لا خلط بين حسابين على نفس المتصفح).
 *  ۴. الحقول غير المسموح بها في الرد لا تُرسم في الصفحة.
 */

const VALID_URL = 'https://workspaces0test0000.supabase.co';
const VALID_KEY = 'sb_publishable_e2e_workspace_key';

/** يجعل إعداد Supabase "صالحًا" ويحقن جلسة مُحاكاة، حتى تعمل الصفحة كأنها مسجّلة. */
async function stubSession(page, { userId = 'user-a' } = {}) {
  await page.addInitScript(
    ({ url, key, uid }) => {
      window.__MINHAJ_ENV__ = { supabaseUrl: url, publishableKey: key };
      const session = {
        access_token: 'e2e-stub-token',
        refresh_token: 'e2e-stub-refresh',
        user: { id: uid },
      };
      const stub = {
        auth: {
          getSession: async () => ({ data: { session }, error: null }),
          setSession: async () => ({ data: { session }, error: null }),
          signOut: async () => ({ error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
        },
      };
      // المكتبة الحقيقية تُحمَّل من الصفحة وتكتب على window.supabase، فنثبّت البديل.
      // createClient مطلوب لأن supabase-client.js يتحقق من وجوده قبل اعتبار الإعداد جاهزًا.
      stub.createClient = () => stub;
      Object.defineProperty(window, 'supabase', { configurable: true, get: () => stub, set: () => {} });
    },
    { url: VALID_URL, key: VALID_KEY, uid: userId },
  );
}

/** يعترض نداء workspace-select ويعيد مساحات محددة. */
async function mockWorkspaces(page, workspaces) {
  await page.route('**/functions/v1/workspace-select', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: { workspaces, requires_selection: workspaces.length > 1, count: workspaces.length } }),
    });
  });
}

const TEACHER_A = { teacher_id: 'teacher-a', teacher_name: 'مدرس أ', role: 'teacher', kind: 'teaching' };
const TEACHER_B = { teacher_id: 'teacher-b', teacher_name: 'مدرس ب', role: 'assistant', kind: 'teaching' };

test('القائمة تُبنى من رد الخادم فقط', async ({ page }) => {
  await stubSession(page);
  await mockWorkspaces(page, [TEACHER_A, TEACHER_B]);

  await page.goto('/pages/auth/select-workspace.html');
  const items = page.locator('[data-workspace-list] [data-teacher-id]');
  await expect(items).toHaveCount(2);
  await expect(page.locator('[data-workspace-list]')).toContainText('مدرس أ');
  await expect(page.locator('[data-workspace-list]')).toContainText('مدرس ب');
  await expect(page.locator('[data-workspace-status]')).toContainText('٢');
});

test('رابط فيه مساحة أخرى لا يضيف شيئًا: القائمة من الخادم لا من العنوان', async ({ page }) => {
  await stubSession(page);
  await mockWorkspaces(page, [TEACHER_A]);

  await page.goto('/pages/auth/select-workspace.html?teacher_id=teacher-b&next=x.html');
  await expect(page.locator('[data-workspace-list] [data-teacher-id]')).toHaveCount(1);
  await expect(page.locator('[data-workspace-list]')).not.toContainText('مدرس ب');
});

test('اختيار مساحة يخزّن مساحة واحدة ولا يفتح غيرها', async ({ page }) => {
  await stubSession(page, { userId: 'user-a' });
  await mockWorkspaces(page, [TEACHER_A, TEACHER_B]);

  await page.goto('/pages/auth/select-workspace.html');
  await page.locator('[data-workspace-list] [data-teacher-id="teacher-b"] [data-action="choose-workspace"]').click();

  const stored = await page.evaluate(() => JSON.parse(window.sessionStorage.getItem('minhaj.active-workspace')));
  expect(stored.teacher_id).toBe('teacher-b');
  expect(stored.user_id).toBe('user-a');
  expect(stored.role).toBe('assistant');
});

test('مساحة محفوظة لحساب لا تُستخدم لحساب آخر على نفس المتصفح', async ({ page }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem(
      'minhaj.active-workspace',
      JSON.stringify({ user_id: 'someone-else', teacher_id: 'teacher-a', role: 'teacher' }),
    );
  });
  await stubSession(page, { userId: 'user-b' });
  await mockWorkspaces(page, [TEACHER_A]);

  await page.goto('/pages/auth/select-workspace.html');
  await expect(page.locator('[data-workspace-list] [data-teacher-id]')).toHaveCount(1);

  const active = await page.evaluate(async () => {
    const module = await import('/assets/js/workspace.js');
    return module.getActiveWorkspace('user-b');
  });
  expect(active).toBeNull();
});

test('حقول غير مسموح بها في الرد لا تُرسم في الصفحة', async ({ page }) => {
  await stubSession(page);
  await mockWorkspaces(page, [
    {
      teacher_id: 'teacher-a',
      teacher_name: 'مدرس أ',
      role: 'teacher',
      kind: 'teaching',
      students: [{ full_name: 'طالب سري', phone: '+201000000000' }],
      phone: '+201000000000',
    },
  ]);

  await page.goto('/pages/auth/select-workspace.html');
  await expect(page.locator('[data-workspace-list] [data-teacher-id]')).toHaveCount(1);
  const text = await page.locator('[data-workspace-list]').innerText();
  expect(text).not.toContain('طالب سري');
  expect(text).not.toContain('201000000000');
});

test('مساحة واحدة تُختار تلقائيًا وتُخزَّن', async ({ page }) => {
  await stubSession(page, { userId: 'user-c' });
  await mockWorkspaces(page, [TEACHER_A]);

  await page.goto('/pages/auth/select-workspace.html');
  await expect(page.locator('[data-workspace-list] [data-teacher-id]')).toHaveCount(1);

  await expect
    .poll(async () => page.evaluate(() => window.sessionStorage.getItem('minhaj.active-workspace')))
    .not.toBeNull();
  const stored = await page.evaluate(() => JSON.parse(window.sessionStorage.getItem('minhaj.active-workspace')));
  expect(stored.user_id).toBe('user-c');
  expect(stored.teacher_id).toBe('teacher-a');
});

test('فشل الخادم لا ينتج قائمة وهمية', async ({ page }) => {
  await stubSession(page);
  await page.route('**/functions/v1/workspace-select', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, code: 'INVALID_SESSION', message: 'الجلسة منتهية أو غير صالحة. سجّل الدخول من جديد.' }),
    });
  });

  await page.goto('/pages/auth/select-workspace.html');
  await expect(page.locator('[data-form-error]')).toContainText('الجلسة');
  await expect(page.locator('[data-workspace-list] [data-teacher-id]')).toHaveCount(0);
});
