/**
 * حارس واجهة أولي.
 * تنبيه صريح: هذا الحارس تحسين تجربة فقط، وليس حدًّا أمنيًا.
 * الحماية الحقيقية تأتي من RLS في قاعدة البيانات؛ أي صفحة تُحمى هنا يجب أن
 * تكون بياناتها محمية بـ RLS أيضًا. لا تُخزَّن هنا أي أدوار أو صلاحيات حقيقية.
 */

import { appUrl } from './config.js';
import { getSupabaseClient } from './supabase-client.js';

/** @type {Promise<{user: any} | null> | null} */
let sessionPromise = null;

/**
 * يقرأ الجلسة الحالية (بلا شبكة إن كانت محفوظة).
 * @returns {Promise<{user: any} | null>}
 */
export async function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      try {
        const client = await getSupabaseClient();
        const { data, error } = await client.auth.getSession();
        if (error) return null;
        return data?.session ?? null;
      } catch {
        return null;
      }
    })();
  }
  return sessionPromise;
}

/** يعيد ضبط الذاكرة المؤقتة للجلسة (يُستخدم بعد تسجيل الدخول/الخروج في المرحلة ٠٢). */
export function resetSessionCache() {
  sessionPromise = null;
}

/**
 * يبني رابط صفحة الدخول مع حفظ وجهة العودة.
 * @param {string} [next] الوجهة المطلوبة؛ الافتراضي هو الصفحة الحالية
 * @returns {string} رابط مطلق
 */
export function buildLoginUrl(next) {
  const target = next ?? `${window.location.pathname}${window.location.search}`;
  const url = new URL(appUrl('pages/auth/login.html'), window.location.href);
  url.searchParams.set('next', target);
  return url.href;
}

/**
 * يعيد المستخدم إلى صفحة الدخول مع حفظ الوجهة.
 * @param {string} [next]
 */
export function redirectToLogin(next) {
  window.location.assign(buildLoginUrl(next));
}

/**
 * يضمن وجود جلسة قبل عرض صفحة محمية.
 * @param {{redirect?: boolean}} [options]
 * @returns {Promise<{user: any} | null>}
 */
export async function requireSession(options = {}) {
  const session = await getSession();
  if (!session && options.redirect !== false) {
    redirectToLogin();
    return null;
  }
  return session;
}

/**
 * يخفي محتوى الصفحة المحمية حتى تتأكد الجلسة (منع وميض المحتوى).
 * @param {string} [protectedSelector]
 */
export function hideUntilAuthorized(protectedSelector = '[data-protected]') {
  for (const node of document.querySelectorAll(protectedSelector)) {
    node.setAttribute('hidden', '');
  }
}
