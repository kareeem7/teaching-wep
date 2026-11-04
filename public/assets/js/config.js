/**
 * إعدادات الواجهة ومفاتيح التشغيل.
 *
 * قواعد غير قابلة للتفاوض (docs/DECISIONS.md — C-19، R-11):
 *  ١. المتصفح يحصل على publishable/anon key فقط.
 *  ٢. لا يُقبل أي مفتاح سرّي (service_role أو sb_secret_) ولا يوجد مسار يقرأه.
 *  ٣. غياب الإعداد ليس خطأً قاتلًا: المنصة تعمل في حالة «غير مهيأة» بوضوح.
 *
 * الملف نقي بلا اعتماد على DOM عند الاستيراد، ليكون قابلًا لاختبار الوحدة في Node.
 */

/** أسماء وسوم meta التي يحقنها النشر بالقيم العامة. */
export const META_NAMES = Object.freeze({
  url: 'minhaj-supabase-url',
  key: 'minhaj-supabase-key',
});

/** بادئات المفاتيح السرّية التي تُرفض دائمًا. */
export const FORBIDDEN_KEY_PREFIXES = Object.freeze(['sb_secret_', 'sbp_']);

/**
 * يفك حمولة JWT بلا تحقق توقيع — لأغراض التحقق من النوع فقط.
 * @param {string} token
 * @returns {Record<string, unknown> | null}
 */
export function decodeJwtClaims(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  if (typeof atob !== 'function') return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const json = decodeURIComponent(
      Array.from(atob(padded))
        .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    );
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * هل هذا المفتاح سرّي أو يمنح تجاوز RLS؟
 * @param {string} key
 * @returns {boolean}
 */
export function isForbiddenKey(key) {
  if (typeof key !== 'string' || key.length === 0) return false;
  if (FORBIDDEN_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
  const claims = decodeJwtClaims(key);
  if (!claims) return false;
  return claims.role === 'service_role';
}

/**
 * تحقق من صيغة عنوان مشروع Supabase.
 * @param {string} url
 * @returns {boolean}
 */
export function isValidSupabaseUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.pathname !== '/' && parsed.pathname !== '') return false;
  if (parsed.search || parsed.hash) return false;
  return /^[a-z0-9]{20}\.supabase\.co$/i.test(parsed.hostname);
}

/**
 * حالة الإعداد الكاملة.
 * @param {{url?: string, key?: string, source?: string}} input
 * @returns {{configured: boolean, ok: boolean, url: string, key: string, source: string,
 *            errors: string[], warnings: string[]}}
 */
export function validateConfig(input = {}) {
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  const key = typeof input.key === 'string' ? input.key.trim() : '';
  const source = typeof input.source === 'string' ? input.source : 'unknown';
  const errors = [];
  const warnings = [];

  const hasUrl = url.length > 0;
  const hasKey = key.length > 0;

  if (!hasUrl && !hasKey) {
    warnings.push('لم تُضبط قيم Supabase بعد — الواجهة تعمل في وضع غير مهيأ.');
    return { configured: false, ok: true, url, key, source, errors, warnings };
  }

  if (!hasUrl) errors.push('عنوان Supabase ناقص.');
  if (!hasKey) errors.push('مفتاح Supabase العام ناقص.');

  if (hasUrl && !isValidSupabaseUrl(url)) {
    errors.push('عنوان Supabase غير صالح: يجب أن يكون https://<project-ref>.supabase.co بلا مسار.');
  }

  if (hasKey && isForbiddenKey(key)) {
    errors.push('مفتاح سرّي مرفوض: service_role أو sb_secret_ لا يُوضع في المتصفح أبدًا.');
  } else if (hasKey) {
    const claims = decodeJwtClaims(key);
    const isPublishable = key.startsWith('sb_publishable_');
    if (!isPublishable && !claims) {
      errors.push('المفتاح ليس publishable ولا JWT صالح — تحقق من القيمة.');
    } else if (claims && claims.role !== 'anon') {
      errors.push(`المفتاح ليس anon (الدور المكتشف: ${String(claims.role)}).`);
    }
  }

  return {
    configured: hasUrl && hasKey && errors.length === 0,
    ok: errors.length === 0,
    url,
    key,
    source,
    errors,
    warnings,
  };
}

/**
 * قراءة القيم من وسوم meta في الصفحة.
 * @param {Document|null} doc
 * @returns {{url: string, key: string, source: string}}
 */
export function readMetaConfig(doc) {
  const documentRef = doc ?? (typeof document === 'undefined' ? null : document);
  if (!documentRef || typeof documentRef.querySelector !== 'function') {
    return { url: '', key: '', source: 'none' };
  }
  const read = (name) => {
    const element = documentRef.querySelector(`meta[name="${name}"]`);
    return element && typeof element.content === 'string' ? element.content.trim() : '';
  };
  return { url: read(META_NAMES.url), key: read(META_NAMES.key), source: 'meta' };
}

/**
 * الترتيب: meta ثم window.__MINHAJ_ENV__ (يُستخدم في الاختبارات).
 * @param {Window|Record<string, unknown>} [scope]
 * @param {Document|null} [doc]
 */
export function readRuntimeConfig(scope, doc) {
  const meta = readMetaConfig(doc);
  if (meta.url || meta.key) return meta;
  const injected = scope && typeof scope === 'object' ? scope.__MINHAJ_ENV__ : undefined;
  if (injected && typeof injected === 'object') {
    return {
      url: typeof injected.supabaseUrl === 'string' ? injected.supabaseUrl.trim() : '',
      key: typeof injected.publishableKey === 'string' ? injected.publishableKey.trim() : '',
      source: 'runtime',
    };
  }
  return { url: '', key: '', source: 'none' };
}

/** نقطة واحدة تستخدمها بقية الملفات. */
export function getConfig() {
  return validateConfig(readRuntimeConfig(globalThis));
}
