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

test.describe('التنقل بين الصفحات', () => {
  test('قائمة الموبايل تُفتح بالزر وينتقل الرابط', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'خاص بمقاس الموبايل');
    await page.goto('/index.html');
    const toggler = page.locator('.navbar-toggler');
    await expect(toggler).toBeVisible();

    const menu = page.locator('#appNav');
    await expect(menu).not.toHaveClass(/show/);
    await toggler.click();
    await expect(menu).toHaveClass(/show/);

    await page.locator('#appNav a[data-nav="health"]').click();
    await expect(page).toHaveURL(/pages\/health\.html/);
  });

  test('روابط التنقل ظاهرة مباشرة على سطح المكتب', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'خاص بسطح المكتب');
    await page.goto('/index.html');
    await expect(page.locator('.navbar-toggler')).toBeHidden();
    await expect(page.locator('.app-navbar .nav-link')).toHaveCount(3);
    await expect(page.locator('.app-navbar .nav-link').first()).toBeVisible();
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

  test('الفحص يبدأ تلقائيًا بلا أي تفاعل من المستخدم', async ({ page }) => {
    // الحالة الابتدائية في HTML هي «لم يُنفَّذ بعد». إن بقي المؤشر عليها،
    // فمعناه أن الفحص التلقائي لم يعمل (عيب D1 في تقرير الفحص).
    await page.goto('/pages/health.html');
    await expect(page.locator('#conn-pill')).not.toHaveText('لم يُنفَّذ بعد', { timeout: 20_000 });
    await expect(page.locator('#conn-detail')).not.toHaveText('جارٍ التنفيذ…', { timeout: 20_000 });
    await expect(page.locator('#conn-latency')).not.toHaveText('—', { timeout: 20_000 });
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

test.describe('لقطات مرجعية', () => {
  // تُنتَج داخل CI حيث يتوفر متصفح حقيقي، وتُرفع كـ artifact للاعتماد.
  const pages = [
    ['index', '/index.html'],
    ['health', '/pages/health.html'],
    ['login', '/pages/auth/login.html']
  ];
  for (const [name, path] of pages) {
    test(`لقطة ${name}`, async ({ page, isMobile }) => {
      const size = isMobile ? 'mobile' : 'desktop';
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await page.screenshot({
        path: `docs/test-artifacts/screenshots/${name}-${size}.png`,
        fullPage: true
      });
    });
  }
});
