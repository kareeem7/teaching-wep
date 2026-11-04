/**
 * حارس واجهة أولي — **ليس حماية**.
 *
 * الحقيقة الأمنية: أي حارس في المتصفح يمكن تجاوزه بتعديل الصفحة أو استدعاء الـAPI مباشرة.
 * الحماية الفعلية تأتي في المرحلة ٠٢ بـRLS على الخادم (R-11، PERMISSIONS §١).
 * وظيفة هذا الملف: تحويل الزائر إلى صفحة الدخول وتجربة استخدام سليمة فقط.
 */
import { getSupabaseClient, getSupabaseStatus } from './supabase-client.js';

/** المسار النسبي لصفحة الدخول بغض النظر عن عمق الصفحة الحالية. */
export function buildLoginUrl(nextPath, prefix = '') {
  const next = encodeURIComponent(nextPath ?? '');
  return `${prefix}pages/auth/login.html?next=${next}`;
}

/**
 * يحسب البادئة النسبية من الصفحة الحالية إلى جذر `public/`.
 * @param {string} pathname
 * @returns {string}
 */
export function relativePrefix(pathname) {
  if (typeof pathname !== 'string' || pathname.length === 0) return '';
  const depth = pathname.split('/').filter(Boolean).length - 1;
  return depth > 0 ? '../'.repeat(depth) : '';
}

/**
 * نتيجة الفحص الحالية للجلسة.
 * @returns {Promise<{allowed: boolean, reason: string, session: object|null}>}
 */
export async function checkSession() {
  const status = getSupabaseStatus();
  if (!status.ready) {
    return { allowed: false, reason: status.reason ?? 'unconfigured', session: null };
  }
  const client = getSupabaseClient();
  if (!client) return { allowed: false, reason: 'client-unavailable', session: null };
  const { data, error } = await client.auth.getSession();
  if (error) return { allowed: false, reason: 'session-error', session: null };
  if (!data?.session) return { allowed: false, reason: 'no-session', session: null };
  return { allowed: true, reason: 'ok', session: data.session };
}

/**
 * يحمي صفحة تحمل `data-requires-auth="true"` على عنصر body.
 * @param {{redirect?: boolean}} [options]
 */
export async function guardPage(options = {}) {
  const { redirect = true } = options;
  const body = typeof document === 'undefined' ? null : document.body;
  if (!body || body.dataset.requiresAuth !== 'true') return { allowed: true, reason: 'public' };

  const result = await checkSession();
  if (result.allowed) return result;

  body.dataset.authState = 'denied';
  if (redirect && typeof window !== 'undefined') {
    const prefix = relativePrefix(window.location.pathname);
    const target = buildLoginUrl(window.location.pathname + window.location.search, prefix);
    window.location.replace(`${target}&reason=${encodeURIComponent(result.reason)}`);
  }
  return result;
}
