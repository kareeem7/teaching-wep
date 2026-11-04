/**
 * عميل Supabase في المتصفح.
 *
 * - لا يُنشأ العميل إلا إذا كان الإعداد صالحًا (config.js).
 * - لا يُستورد أي سرّ هنا: المكتبة المحلية تقرأ publishable key فقط.
 * - هذه طبقة نقل بيانات؛ الصلاحيات الحقيقية تُفرض بـRLS على الخادم (R-11).
 */
import { getConfig } from './config.js';

/** @type {object|null} */
let cachedClient = null;
/** @type {string|null} */
let lastReason = null;

/**
 * @returns {{ready: boolean, reason: string|null, config: ReturnType<typeof getConfig>}}
 */
export function getSupabaseStatus() {
  const config = getConfig();
  if (!config.ok) return { ready: false, reason: 'invalid-config', config };
  if (!config.configured) return { ready: false, reason: 'unconfigured', config };
  if (typeof globalThis.supabase?.createClient !== 'function') {
    return { ready: false, reason: 'library-missing', config };
  }
  return { ready: true, reason: lastReason, config };
}

/**
 * يعيد العميل أو null إن لم يكن الإعداد مكتملًا. لا يرمي استثناءً في الحالة العادية.
 * @returns {object|null}
 */
export function getSupabaseClient() {
  if (cachedClient) return cachedClient;
  const status = getSupabaseStatus();
  if (!status.ready) return null;
  cachedClient = globalThis.supabase.createClient(status.config.url, status.config.key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
    global: { headers: { 'x-application-name': 'minhaj-web' } },
  });
  return cachedClient;
}

/** يُستخدم في الاختبارات فقط. */
export function resetSupabaseClient() {
  cachedClient = null;
  lastReason = null;
}
