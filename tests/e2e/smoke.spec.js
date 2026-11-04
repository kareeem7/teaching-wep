/**
 * اختبارات دخان للواجهة: تحميل الصفحات، RTL، سلوك الحارس، وأزرار غير مفعّلة.
 * تُشغّل على خادم ثابت محلي (http-server) لكل من سطح المكتب والجوال.
 */

import { test, expect } from '@playwright/test';

test.describe('الصفحة الرئيسية', () => {
  test('تُحمَّل بالعربية ومن اليمين إلى اليسار', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page).toHaveTitle(/مِنهاج/);
    await expect(page.locator('h1')).toHaveText('مِنهاج');
  });

  test('الشريط العلوي يُبنى بثلاثة روابط عمل', async ({ page }) => {
    await page.goto('/index.html');
    const links = page.locator('.app-navbar .nav-link');
    await expect(links).toHaveCount(3);
    await expect(page.locator('.app-navbar .nav-link.active')).toHaveCount(1);
  });

  test('Bootstrap RTL محمّل محليًا بلا CDN', async ({ page }) => {
    const external = [];
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith('http://127.0.0.1') && !url.startsWith('data:')) external.push(url);
    });
    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');
    expect(external.filter((url) => /cdn|jsdelivr|unpkg|googleapis/i.test(url))).toEqual([]);
  });

  test('لا أخطاء JavaScript في الطرفية', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });
});

test.describe('حالة النظام', () => {
  test('تُنفّذ فحصًا حقيقيًا وتنتهي بحالة نهائية', async ({ page }) => {
    await page.goto('/pages/health.html');
    const pill = page.locator('#conn-pill');
    await expect(pill).not.toHaveText('جارٍ الفحص…', { timeout: 20_000 });
    await expect(pill).toHaveText(/الخدمة (متاحة|غير متاحة)|فشل الفحص/);
    await expect(page.locator('#conn-latency')).toHaveText(/^\d+$|^—$/);
    await expect(page.locator('#online-pill')).toHaveText(/متصل بالشبكة|غير متصل/);
  });
});

test.describe('صفحة الدخول (هيكل المرحلة ٠١)', () => {
  test('الحقول معطّلة والنموذج لا يُرسل', async ({ page }) => {
    await page.goto('/pages/auth/login.html');
    await expect(page.locator('#email')).toBeDisabled();
    await expect(page.locator('#password')).toBeDisabled();
    await page.locator('#login-submit').click();
    await expect(page.locator('.app-toast').first()).toContainText('المرحلة ٠٢');
    await expect(page).toHaveURL(/pages\/auth\/login\.html/);
  });

  test('تعرض وجهة العودة عند تمرير next', async ({ page }) => {
    await page.goto('/pages/auth/login.html?next=%2Fpages%2Fhealth.html');
    await expect(page.locator('#next-hint')).toBeVisible();
    await expect(page.locator('#next-value')).toHaveText('/pages/health.html');
  });
});

test.describe('حارس الجلسة', () => {
  test('رابط محمي يوجّه إلى الدخول مع حفظ الوجهة', async ({ page }) => {
    await page.goto('/index.html');
    await page.locator('[data-requires-session]').click();
    await expect(page).toHaveURL(/pages\/auth\/login\.html\?next=/);
    expect(page.url()).toContain('next=');
  });
});

test.describe('صفحات الأخطاء', () => {
  for (const [code, title] of [
    ['403', 'لا تملك صلاحية الوصول'],
    ['404', 'الصفحة غير موجودة'],
    ['500', 'خطأ غير متوقع']
  ]) {
    test(`صفحة ${code} تعرض رمزها ومسار عودة`, async ({ page }) => {
      await page.goto(`/pages/errors/${code}.html`);
      await expect(page.locator('.error-code')).toHaveText(code);
      await expect(page.locator('h1')).toHaveText(title);
      await expect(page.getByRole('link', { name: 'الصفحة الرئيسية' })).toBeVisible();
    });
  }
});
