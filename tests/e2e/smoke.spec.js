import { test, expect } from '@playwright/test';

/**
 * اختبار دخان حقيقي للواجهة الثابتة (المرحلة ٠١).
 * لا يتصل بأي قاعدة بيانات: لا مشروع Supabase في هذه المرحلة.
 * يُشغَّل على مشروعَي المتصفح: سطح المكتب والموبايل.
 */

const PROTECTED = '/pages/shared/app-shell.html';

const PAGES = [
  { path: '/index.html', title: /مِنهاج/ },
  { path: '/pages/health.html', title: /صحة النظام/ },
  { path: '/pages/auth/login.html', title: /الدخول/ },
  { path: '/pages/errors/404.html', title: /404/ },
];

test.describe('الصفحات الأساسية', () => {
  for (const page of PAGES) {
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

test('الاتجاه واللغة عربيان', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
});

test('المكوّنات تُحقن فعلًا (شريط علوي + هوية مِنهاج)', async ({ page }) => {
  await page.goto('/index.html');
  const brand = page.locator('.app-topbar__brand');
  await expect(brand).toBeVisible();
  await expect(brand).toContainText('مِنهاج');
});

test('حالة الإعداد تُعرض بصدق ولا تدّعي اتصالًا', async ({ page }) => {
  await page.goto('/index.html');
  const status = page.locator('[data-config-status]');
  await expect(status).not.toHaveText(/جارٍ الفحص/);
  await expect(status).toHaveText(/غير مهيأة/);
});

test('صفحة الصحة تنفّذ الفحوص وتعرض «غير منطبق» لما لا ينطبق', async ({ page }) => {
  await page.goto('/pages/health.html');
  const rows = page.locator('#health-checks tbody tr');
  await expect(rows).toHaveCount(5);
  await expect(page.locator('#health-checks')).toContainText('غير منطبق');
  await expect(page.locator('#health-checks')).toContainText('سليم');
});

test('صفحة الدخول شكلية: كل الحقول والزر معطّلة', async ({ page }) => {
  await page.goto('/pages/auth/login.html');
  await expect(page.locator('#identifier')).toBeDisabled();
  await expect(page.locator('#password')).toBeDisabled();
  await expect(page.locator('button[type="submit"]')).toBeDisabled();
  await expect(page.locator('.alert-warning')).toContainText('شكلية');
});

test('صفحة 404 تعطي مخرجًا بدل الطريق المسدود', async ({ page }) => {
  await page.goto('/pages/errors/404.html');
  await expect(page.getByRole('link', { name: 'العودة للرئيسية' })).toBeVisible();
});

test.describe('التجاوب', () => {
  for (const path of ['/index.html', '/pages/health.html', '/pages/auth/login.html']) {
    test(`لا تمرير أفقي: ${path}`, async ({ page }) => {
      await page.goto(path);
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });
  }
});

test('لا أسرار ولا مفاتيح في أي ملف يُخدم للمتصفح', async ({ request }) => {
  const files = [
    '/index.html',
    '/assets/js/config.js',
    '/assets/js/app.js',
    '/assets/js/supabase-client.js',
    '/assets/js/auth-guard.js',
    '/assets/js/ui.js',
    '/assets/js/components/navbar.js',
  ];
  for (const file of files) {
    const response = await request.get(file);
    expect(response.status(), `تعذّر جلب ${file}`).toBe(200);
    const body = await response.text();
    expect(body, `${file} يحتوي sb_secret_`).not.toMatch(/sb_secret_[A-Za-z0-9]/);
    expect(body, `${file} يحتوي JWT حقيقيًا`).not.toMatch(/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9]/);
  }
});

/* ---------------------------------------------------------------------------
 * H-01/H-02 (تقرير الفحص PHASE_01_CHECK): يجب أن توجد صفحة محمية فعلية،
 * وأن يرفض الحارس الزائر، وأن يُبنى هيكل الدور بعد اجتياز الحارس.
 * ------------------------------------------------------------------------- */

test.describe('الحارس المحمي وهيكل الدور', () => {
  test('الصفحة المحمية تحمل data-requires-auth وتُرفض بلا جلسة', async ({ request, page }) => {
    const raw = await request.get(PROTECTED);
    expect(raw.status()).toBe(200);
    expect(await raw.text()).toContain('data-requires-auth="true"');

    const response = await page.goto(PROTECTED);
    expect(response?.status()).toBe(200);
    await page.waitForURL(/pages\/auth\/login\.html\?next=/);
    expect(page.url()).toContain('reason=unconfigured');
    const notice = page.locator('[data-login-notice]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('لم تُهيَّأ');
  });

  test('لا يُبنى شريط جانبي لزائر بلا جلسة', async ({ page }) => {
    await page.goto(PROTECTED);
    await page.waitForURL(/login\.html/);
    await expect(page.locator('.app-sidebar')).toHaveCount(0);
  });

  test('بعد اجتياز الحارس: الشريط الجانبي والحالة الفارغة يظهران', async ({ page }) => {
    await page.addInitScript(() => {
      window.__MINHAJ_ENV__ = {
        supabaseUrl: 'https://e2estube2estube2est.supabase.co',
        publishableKey: 'sb_publishable_e2e_stub_key',
      };
      // المكتبة الحقيقية تُحمَّل من الصفحة لاحقًا وتكتب على window.supabase؛
      // لهذا نثبّت البديل بخاصية بلا مُعيِّن حتى لا يُستبدل.
      const stub = {
        createClient: () => ({
          auth: {
            getSession: async () => ({
              data: { session: { access_token: 'e2e-stub', user: { id: 'e2e-stub' } } },
              error: null,
            }),
          },
        }),
      };
      Object.defineProperty(window, 'supabase', {
        configurable: true,
        get: () => stub,
        set: () => {},
      });
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const response = await page.goto(PROTECTED);
    expect(response?.status()).toBe(200);
    expect(page.url()).toContain('/pages/shared/app-shell.html');
    await expect(page.locator('.app-sidebar')).toHaveCount(1);
    await expect(page.locator('.app-sidebar__title')).toContainText('مساحة العمل');
    await expect(page.locator('.app-nav__link')).toHaveCount(1);
    await expect(page.locator('.empty-state__title')).toContainText('لا بيانات بعد');
    await expect(page.locator('body')).toHaveAttribute('data-role-label', /مساحة العمل/);
    expect(errors).toEqual([]);
  });

  test('إعداد غير صالح يظهر تنبيهًا مرئيًا (showToast مستخدم فعلًا)', async ({ page }) => {
    await page.addInitScript(() => {
      window.__MINHAJ_ENV__ = { supabaseUrl: 'http://not-https.example', publishableKey: 'plain-text' };
    });
    await page.goto('/index.html');
    const toast = page.locator('[data-toast-container] .toast');
    await expect(toast.first()).toBeVisible();
    await expect(toast.first()).toContainText('إعداد Supabase غير صالح');
  });
});
