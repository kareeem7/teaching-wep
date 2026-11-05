import { test, expect } from '@playwright/test';

/**
 * اختبارات واجهة المصادقة (المرحلة ٠٢).
 *
 * الواقع المفحوص هنا: صفحات حقيقية + نداء حقيقي إلى `/functions/v1/...`.
 * البيئة الثابتة في CI لا تحتوي Edge Functions، فالمتوقع **رسالة صادقة** بأن الخادم
 * غير منشور — لا نجاح وهمي. لماذا لا نُحاكي الخادم بالكامل؟ لأن محاكاة النجاح
 * في اختبار الواجهة تنتج دليلًا كاذبًا على وظيفة غير منشورة.
 *
 * عزل البيانات الحقيقي (RLS) يُفحص في `tests/sql/identity_rls.test.sql` على PostgreSQL.
 */

const AUTH_PAGES = [
  { path: '/pages/auth/login.html', title: /الدخول/ },
  { path: '/pages/auth/accept-invitation.html', title: /تفعيل الدعوة/ },
  { path: '/pages/auth/request-recovery.html', title: /استعادة/ },
  { path: '/pages/auth/reset-password.html', title: /كلمة مرور جديدة/ },
];

test.describe('صفحات المصادقة تُفتح وتصرّح بحدودها', () => {
  for (const page of AUTH_PAGES) {
    test(`تفتح بلا أخطاء: ${page.path}`, async ({ page: browserPage }) => {
      const errors = [];
      browserPage.on('pageerror', (error) => errors.push(error.message));
      const response = await browserPage.goto(page.path);
      expect(response?.status()).toBe(200);
      await expect(browserPage).toHaveTitle(page.title);
      await expect(browserPage.locator('h1').first()).toBeVisible();
      expect(errors).toEqual([]);
    });
  }
});

test('الدخول: الحقول مفعّلة فعلًا (لم تعد صفحة شكلية)', async ({ page }) => {
  await page.goto('/pages/auth/login.html');
  await expect(page.locator('#identifier')).toBeEnabled();
  await expect(page.locator('#password')).toBeEnabled();
  await expect(page.locator('[data-action="login"]')).toBeEnabled();
  await expect(page.locator('[data-backend-notice]')).toContainText('لم تُنشر');
});

test('الدخول: تحقق شكلي قبل أي نداء — لا يرسل نموذجًا فارغًا', async ({ page }) => {
  await page.goto('/pages/auth/login.html');
  await page.locator('[data-action="login"]').click();
  await expect(page.locator('[data-form-error]')).toContainText('رقم الهاتف أو كود الطالب');
  await expect(page.locator('[data-action="login"]')).toBeEnabled();
});

test('الدخول: كلمة المرور لا تُكتب في الصفحة ولا في أي نص مرئي', async ({ page }) => {
  const secret = 'Minhaj#Secret2026';
  await page.goto('/pages/auth/login.html');
  await page.fill('#identifier', '01012345678');
  await page.fill('#password', secret);
  await page.locator('[data-action="login"]').click();

  // النداء يفشل (لا خدمة) — والمهم ألا يُسرَّب السر إلى الصفحة
  await expect(page.locator('[data-form-error]')).toBeVisible({ timeout: 15000 });
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain(secret);
  const html = await page.content();
  expect(html).not.toContain(secret);
});

test('الدخول: غياب الخدمة يعطي رسالة صريحة لا نجاحًا وهميًا', async ({ page }) => {
  await page.goto('/pages/auth/login.html');
  await page.fill('#identifier', '01012345678');
  await page.fill('#password', 'Minhaj#Secret2026');
  await page.locator('[data-action="login"]').click();

  const error = page.locator('[data-form-error]');
  await expect(error).toBeVisible({ timeout: 15000 });
  await expect(error).toContainText(/غير منشورة|تعذّر|غير متاح/);
  await expect(page).toHaveURL(/login\.html/);
});

test('دعوة بلا رمز: ترفض نفسها فورًا وتعطّل الزر', async ({ page }) => {
  await page.goto('/pages/auth/accept-invitation.html');
  await expect(page.locator('[data-form-error]')).toContainText('لا يحتوي رمز دعوة');
  await expect(page.locator('[data-action="accept-invitation"]')).toBeDisabled();
});

test('دعوة: كلمتا مرور مختلفتان تُرفضان قبل الإرسال', async ({ page }) => {
  await page.goto('/pages/auth/accept-invitation.html?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  await page.fill('#full_name', 'مدرس تجريبي');
  await page.fill('#identifier', '01012345678');
  await page.fill('#password', 'Minhaj#2026pass');
  await page.fill('#password_confirm', 'Minhaj#2026pass2');
  await page.locator('[data-action="accept-invitation"]').click();
  await expect(page.locator('[data-form-error]')).toContainText('غير متطابقتين');
});

test('دعوة: كلمة مرور قصيرة تُرفض بكلمة واضحة', async ({ page }) => {
  await page.goto('/pages/auth/accept-invitation.html?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  await page.fill('#full_name', 'مدرس تجريبي');
  await page.fill('#identifier', '01012345678');
  await page.fill('#password', 'short1234');
  await page.fill('#password_confirm', 'short1234');
  await page.locator('[data-action="accept-invitation"]').click();
  await expect(page.locator('[data-form-error]')).toContainText(/10 محارف|١٠ محارف/);
});

test('استعادة: بلا جلسة مدرس تشرح السبب وتعطّل الإرسال', async ({ page }) => {
  await page.goto('/pages/auth/request-recovery.html');
  await expect(page.locator('[data-form-error]')).toContainText('للمدرس');
  await expect(page.locator('[data-action="request-recovery"]')).toBeDisabled();
});

test('تعيين كلمة مرور: بلا رمز لا محاولة', async ({ page }) => {
  await page.goto('/pages/auth/reset-password.html');
  await expect(page.locator('[data-form-error]')).toContainText('رمز استعادة');
  await expect(page.locator('[data-action="reset-password"]')).toBeDisabled();
});

test('تعيين كلمة مرور: عدم تطابق التأكيد يُرفض محليًا', async ({ page }) => {
  await page.goto('/pages/auth/reset-password.html?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  await page.fill('#password', 'Minhaj#2026pass');
  await page.fill('#password_confirm', 'Minhaj#2026pasz');
  await page.locator('[data-action="reset-password"]').click();
  await expect(page.locator('[data-form-error]')).toContainText('غير متطابقتين');
});

test('اختيار المساحة: بلا جلسة يُحوَّل إلى الدخول بسبب واضح', async ({ page }) => {
  await page.goto('/pages/auth/select-workspace.html');
  await page.waitForURL(/login\.html\?next=/);
  expect(page.url()).toContain('reason=no-session');
  await expect(page.locator('[data-login-notice]')).toBeVisible();
});

test('لا أسرار ولا مفاتيح في ملفات المصادقة المخدمة', async ({ request }) => {
  const files = [
    '/pages/auth/login.html',
    '/pages/auth/accept-invitation.html',
    '/pages/auth/request-recovery.html',
    '/pages/auth/reset-password.html',
    '/pages/auth/select-workspace.html',
    '/assets/js/auth.js',
    '/assets/js/api.js',
    '/assets/js/workspace.js',
  ];
  for (const file of files) {
    const response = await request.get(file);
    expect(response.status(), `تعذّر جلب ${file}`).toBe(200);
    const body = await response.text();
    expect(body, `${file} يحتوي sb_secret_`).not.toMatch(/sb_secret_[A-Za-z0-9]/);
    expect(body, `${file} يحتوي JWT`).not.toMatch(/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9]/);
    expect(body, `${file} يحتوي service_role صريحًا`).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*['"][^'"]+/);
  }
});

const STATIC_AUTH_PAGES = [...AUTH_PAGES];

test('لا تمرير أفقي في صفحات المصادقة', async ({ page }) => {
  for (const item of STATIC_AUTH_PAGES) {
    await page.goto(item.path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, item.path).toBeLessThanOrEqual(1);
  }
});
