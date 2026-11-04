/**
 * عميل Supabase الوحيد المسموح في المتصفح.
 * حزمة supabase-js منسوخة محليًا (UMD) لتعمل بلا CDN ولا خطوة بناء،
 * ويُغلّفها هذا الملف ليُستخدم عبر ES Modules.
 * لا يُنشأ العميل إلا بمفتاح publishable، وأي استعلام يخضع لـ RLS.
 */

import { APP, validateConfig } from './config.js';

// نسبي إلى موقع هذا الملف (assets/js/) لا إلى جذر الموقع.
const VENDOR_PATH = '../vendor/supabase/supabase.js';

/** @type {Promise<any> | null} */
let clientPromise = null;

/**
 * يحمّل حزمة supabase-js مرة واحدة فقط.
 * @returns {Promise<any>} مساحة الاسم العالمية التي تضعها الحزمة
 */
function loadVendor() {
  if (globalThis.supabase?.createClient) {
    return Promise.resolve(globalThis.supabase);
  }
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-supabase-vendor]');
    if (existing) {
      existing.addEventListener('load', () => resolve(globalThis.supabase));
      existing.addEventListener('error', () => reject(new Error('تعذّر تحميل حزمة Supabase')));
      return;
    }
    const script = document.createElement('script');
    script.src = new URL(VENDOR_PATH, import.meta.url).href;
    script.async = true;
    script.dataset.supabaseVendor = 'true';
    script.addEventListener('load', () => resolve(globalThis.supabase));
    script.addEventListener('error', () => reject(new Error('تعذّر تحميل حزمة Supabase')));
    document.head.append(script);
  });
}

/**
 * يرجع عميلًا مفردًا (singleton) لـ Supabase.
 * @returns {Promise<import('@supabase/supabase-js').SupabaseClient>}
 */
export async function getSupabaseClient() {
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const { ok, missing } = validateConfig(APP);
    if (!ok) {
      throw new Error(`إعدادات Supabase غير مكتملة: ${missing.join(', ')}`);
    }
    const vendor = await loadVendor();
    return vendor.createClient(APP.supabase.url, APP.supabase.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      global: { headers: { 'x-client-info': `minhaj-web/${APP.version}` } }
    });
  })();

  return clientPromise;
}

/**
 * فحص اتصال خفيف لا يقرأ بيانات أعمال.
 * يستخدم نقطة الصحة العامة في Supabase Auth.
 * @returns {Promise<{online: boolean, reachable: boolean, latencyMs: number, detail: string}>}
 */
export async function checkConnectivity() {
  const started = performance.now();
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { online: false, reachable: false, latencyMs: 0, detail: 'المتصفح غير متصل بالشبكة' };
  }
  try {
    const response = await fetch(`${APP.supabase.url}/auth/v1/health`, {
      headers: { apikey: APP.supabase.publishableKey },
      cache: 'no-store'
    });
    return {
      online: true,
      reachable: response.ok,
      latencyMs: Math.round(performance.now() - started),
      detail: response.ok ? 'خدمة المصادقة تستجيب' : `الخدمة ردّت بالحالة ${response.status}`
    };
  } catch (error) {
    return {
      online: true,
      reachable: false,
      latencyMs: Math.round(performance.now() - started),
      detail: `تعذّر الوصول: ${error.message}`
    };
  }
}
