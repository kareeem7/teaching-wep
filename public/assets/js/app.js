/**
 * نقطة تشغيل الواجهة المشتركة لكل الصفحات.
 * تفعل ثلاثة أشياء فقط في المرحلة ٠١: تحقن المكوّنات، تعرض حالة الإعداد بصدق،
 * وتشغّل حارس الواجهة. لا منطق أكاديمي هنا (المراحل ٠٣+).
 */
import { getConfig } from './config.js';
import { getSupabaseStatus } from './supabase-client.js';
import { guardPage } from './auth-guard.js';
import { renderNavbar } from './components/navbar.js';
import { renderSidebar } from './components/sidebar.js';
import { renderEmptyState } from './components/empty-state.js';
import { showToast } from './components/toast.js';
import { setStatus, announce, qsa } from './ui.js';

/** نسخة الواجهة كما هي في package.json (مكررة نصًا في وسوم meta). */
export const APP_VERSION = '0.1.0';

/**
 * وصف حالة الإعداد بالعربية.
 * @param {ReturnType<typeof getConfig>} config
 * @returns {{text: string, tone: 'ok'|'warn'|'danger'}}
 */
export function describeConfig(config) {
  if (!config.ok) return { text: 'إعداد غير صالح — راجع الرسائل', tone: 'danger' };
  if (!config.configured) return { text: 'غير مهيأة (لا مفاتيح بعد)', tone: 'warn' };
  return { text: 'مهيأة', tone: 'ok' };
}

/**
 * يعرض حالة الإعداد في كل عنصر يحمل `data-config-status`.
 * @param {Document} [doc]
 */
export function hydrateConfigStatus(doc = document) {
  const config = getConfig();
  const state = describeConfig(config);
  qsa('[data-config-status]', doc).forEach((element) => setStatus(element, state));
  qsa('[data-config-detail]', doc).forEach((element) => {
    if (config.errors.length > 0) {
      element.textContent = config.errors.join(' · ');
      element.hidden = false;
    } else {
      element.hidden = true;
    }
  });
  return { config, state };
}

/**
 * يبني جدول الفحوص الحيّة لصفحة الصحة. كل بند يُنفَّذ فعلًا في المتصفح.
 * @param {Document} [doc]
 */
export function renderHealth(doc = document) {
  const host = doc.querySelector('#health-checks');
  if (!host) return null;
  const config = getConfig();
  const supabaseStatus = getSupabaseStatus();
  const stylesheet = doc.querySelector('link[rel="stylesheet"][href*="bootstrap.rtl.min.css"]');
  const body = doc.body;

  const checks = [
    {
      label: 'وحدات JavaScript محمّلة',
      ok: typeof getConfig === 'function',
      detail: `الإصدار ${APP_VERSION}`,
    },
    {
      label: 'اتجاه الصفحة واللغة',
      ok: doc.documentElement.lang === 'ar' && body.getAttribute('dir') !== 'ltr',
      detail: `${doc.documentElement.lang} · ${body.getAttribute('dir')}`,
    },
    {
      label: 'Bootstrap RTL محلي',
      ok: Boolean(stylesheet) && stylesheet.getAttribute('href').startsWith('../assets/'),
      detail: stylesheet ? 'محلي داخل public/assets/vendor' : 'غير موجود',
    },
    {
      label: 'إعداد Supabase',
      ok: config.ok,
      detail: describeConfig(config).text,
    },
    {
      label: 'الاتصال بقاعدة البيانات',
      ok: null,
      detail: supabaseStatus.ready ? 'مهيأ — الاختبار الفعلي في المرحلة ٠٢' : 'غير منطبق الآن (المرحلة ٠٢)',
    },
  ];

  const rows = checks.map((check) => {
    const tone = check.ok === null ? 'info' : check.ok ? 'ok' : 'danger';
    const text = check.ok === null ? 'غير منطبق' : check.ok ? 'سليم' : 'خلل';
    return `
      <tr>
        <th scope="row">${check.label}</th>
        <td><span class="status status--${tone}">${text}</span></td>
        <td class="text-muted-mh">${check.detail}</td>
      </tr>`;
  });

  host.innerHTML = `
    <table class="table align-middle mb-0">
      <caption class="visually-hidden-mh">نتائج فحوص الصحة المنفذة في المتصفح</caption>
      <thead>
        <tr><th scope="col">الفحص</th><th scope="col">النتيجة</th><th scope="col">التفصيل</th></tr>
      </thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;

  return checks;
}

/** التشغيل. */
export async function bootstrap() {
  const doc = document;

  // الشريط العلوي والقائمة الجانبية (إن وُجد مكانهما)
  const isNested = doc.body.dataset.pageDepth === 'nested';
  const base = isNested ? '../../' : '';
  renderNavbar({
    brandHref: `${base}index.html`,
    meta: doc.body.dataset.roleLabel ?? '',
    links: [
      { label: 'الدخول', href: `${base}pages/auth/login.html` },
      { label: 'صحة النظام', href: `${base}pages/health.html` },
    ],
  });
  if (doc.body.dataset.roleLabel) {
    const page = doc.body.dataset.page ?? '';
    const isAdmin = page.startsWith('admin-');
    renderSidebar({
      title: doc.body.dataset.roleLabel,
      links: isAdmin
        ? [
            { label: 'نظرة عامة', href: `${base}pages/admin/dashboard.html`, current: page === 'admin-dashboard' },
            { label: 'المدرسون', href: `${base}pages/admin/teachers.html`, current: page === 'admin-teachers' || page === 'admin-teacher-detail' },
            { label: 'التعليمات', href: `${base}pages/admin/instructions.html`, current: page === 'admin-instructions' },
            { label: 'الرئيسية', href: `${base}index.html` },
          ]
        : [
            { label: 'الرئيسية', href: `${base}index.html`, current: true },
          ],
    });
  }

  hydrateConfigStatus(doc);
  renderHealth(doc);

  // حالة فارغة صريحة بدل مساحة بيضاء توهم بوجود بيانات
  qsa('[data-empty-host]', doc).forEach((host) => {
    if (host.dataset.filled === 'true') return;
    if ((doc.body.dataset.page ?? '').startsWith('admin-')) return;
    host.append(renderEmptyState({
      title: 'لا بيانات بعد',
      text: 'هذا تخطيط فارغ. الطلاب والمجموعات والحضور تبدأ في المرحلتين ٠٤ و٠٥.',
      icon: '◇',
    }));
    host.dataset.filled = 'true';
  });

  // تحذير مرئي عند إعداد غير صالح (وليس عند مجرد كونه غير مهيأ)
  const runtimeConfig = getConfig();
  if (runtimeConfig.errors.length > 0) {
    showToast('إعداد Supabase غير صالح — راجع صفحة صحة النظام.', { tone: 'danger', delay: 8000 });
  }


  const yearTarget = doc.querySelector('[data-current-year]');
  if (yearTarget) yearTarget.textContent = String(new Date().getFullYear());

  // رسالة سبب إعادة التوجيه إلى صفحة الدخول (من auth-guard)
  const notice = doc.querySelector('[data-login-notice]');
  if (notice) {
    const reason = new URLSearchParams(doc.defaultView.location.search).get('reason');
    const reasons = {
      unconfigured: 'المصادقة لم تُهيَّأ بعد (المرحلة ٠٢). الصفحات المحمية ترفض الزائر حتى ذلك الحين.',
      'invalid-config': 'إعداد Supabase غير صالح — راجع الرسائل أدناه.',
      'no-session': 'لا توجد جلسة دخول. سجّل الدخول بعد تفعيل المصادقة.',
      'library-missing': 'مكتبة Supabase المحلية لم تُحمَّل.',
      'session-error': 'تعذّر قراءة الجلسة الحالية.',
    };
    if (reason) {
      notice.textContent = reasons[reason] ?? 'تم تحويلك إلى صفحة الدخول.';
      notice.hidden = false;
    }
  }

  const guard = await guardPage();
  if (!guard.allowed && guard.reason !== 'public') {
    doc.body.dataset.authState = 'denied';
    announce('تحتاج إلى تسجيل الدخول لعرض هذه الصفحة.');
  }
}

/**
 * تهيئة صفحة المصادقة/المساحة حسب `data-page` على `<body>`.
 * الاستيراد ديناميكي حتى لا تُحمَّل وحدات المصادقة في الصفحات العامة.
 */
export async function initPage(doc = document) {
  const page = doc.body?.dataset?.page;
  if (!page) return null;

  if (page === 'login') {
    const { initLoginPage } = await import('./auth.js');
    initLoginPage();
    return 'login';
  }
  if (page === 'accept-invitation') {
    const { initAcceptInvitationPage } = await import('./auth.js');
    initAcceptInvitationPage();
    return 'accept-invitation';
  }
  if (page === 'request-recovery') {
    const { initRequestRecoveryPage } = await import('./auth.js');
    await initRequestRecoveryPage();
    return 'request-recovery';
  }
  if (page === 'reset-password') {
    const { initResetPasswordPage } = await import('./auth.js');
    initResetPasswordPage();
    return 'reset-password';
  }
  if (page === 'admin-dashboard') {
    const { initAdminDashboardPage } = await import('./admin/dashboard.js');
    await initAdminDashboardPage();
    return 'admin-dashboard';
  }
  if (page === 'admin-teachers') {
    const { initAdminTeachersPage } = await import('./admin/teachers.js');
    await initAdminTeachersPage();
    return 'admin-teachers';
  }
  if (page === 'admin-teacher-detail') {
    const { initAdminTeacherDetailPage } = await import('./admin/teachers.js');
    await initAdminTeacherDetailPage();
    return 'admin-teacher-detail';
  }
  if (page === 'admin-instructions') {
    const { initAdminInstructionsPage } = await import('./admin/instructions.js');
    await initAdminInstructionsPage();
    return 'admin-instructions';
  }
  if (page === 'select-workspace') {
    const [{ initSelectWorkspacePage }, { currentSession }] = await Promise.all([
      import('./workspace.js'),
      import('./auth.js'),
    ]);
    await initSelectWorkspacePage({ getSession: currentSession });
    return 'select-workspace';
  }

  return null;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      void bootstrap().then(() => initPage());
    });
  } else {
    void bootstrap().then(() => initPage());
  }
}
