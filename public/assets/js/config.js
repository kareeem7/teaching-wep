/**
 * إعدادات الواجهة العامة.
 * قاعدة صارمة: لا يدخل هذا الملف إلا ما يجوز كشفه للمتصفح.
 * المفتاح هنا «قابل للنشر» (publishable) وعمله محكوم بسياسات RLS في قاعدة البيانات.
 * ممنوع منعًا مطلقًا وضع service_role أو sb_secret_ في أي ملف تحت public/.
 */

/** @typedef {{url: string, publishableKey: string}} SupabaseConfig */

export const APP = Object.freeze({
  name: 'مِنهاج',
  nameLatin: 'Minhaj',
  version: '0.1.0',
  phase: 1,
  locale: 'ar-EG',
  direction: 'rtl',
  timeZone: 'Africa/Cairo',
  /** @type {SupabaseConfig} */
  supabase: Object.freeze({
    url: 'https://wdqupfoznngqbyphjnie.supabase.co',
    publishableKey: 'sb_publishable_I0auZPybNHocPZ97fNBY9g_gOiyO5uF'
  })
});

/**
 * يتحقق من اكتمال الإعدادات دون كشف قيمها.
 * @returns {{ok: boolean, missing: string[]}}
 */
export function validateConfig(config = APP) {
  const missing = [];
  if (!config?.name) missing.push('name');
  if (!config?.supabase?.url) missing.push('supabase.url');
  if (!config?.supabase?.publishableKey) missing.push('supabase.publishableKey');
  if (config?.supabase?.url && !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(config.supabase.url)) {
    missing.push('supabase.url:format');
  }
  return { ok: missing.length === 0, missing };
}

/**
 * يبني مسارًا داخليًا نسبيًا بغض النظر عن عمق الصفحة الحالية.
 * كل صفحات المشروع تحت public/، لذا نحسب الجذر من مسار الملف.
 * @param {string} path مسار يبدأ من جذر public مثل "pages/health.html"
 * @returns {string}
 */
export function appUrl(path = '') {
  const clean = String(path).replace(/^\/+/, '');
  const segments = window.location.pathname.split('/').filter(Boolean);
  const publicIndex = segments.lastIndexOf('public');
  const depth = publicIndex >= 0 ? segments.length - publicIndex - 2 : 0;
  const prefix = depth > 0 ? '../'.repeat(depth) : './';
  return `${prefix}${clean}`;
}
