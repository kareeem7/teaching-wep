/**
 * حدّ المعدل — التصميم المعتمد (AUTH_DESIGN §٤): جدول في PostgreSQL لا Redis.
 *
 * القاعدة الحاكمة: العدّاد داخل نافذة زمنية ثابتة، والزيادة **ذرية** في دالة SQL واحدة.
 * هذا الملف يحمل الحساب النقي (قابل للاختبار في Node) + طبقة نداء الدالة.
 */
import { apiError } from './errors.js';

/** الحدود المعتمدة، مفتاح واحد لكل مسار. */
export const LIMITS = Object.freeze({
  'login:identifier': { limit: 5, windowSeconds: 15 * 60 },
  'login:ip': { limit: 20, windowSeconds: 60 * 60 },
  'recovery:teacher': { limit: 3, windowSeconds: 60 * 60 },
  'recovery:student': { limit: 5, windowSeconds: 24 * 60 * 60 },
  'invite:ip': { limit: 10, windowSeconds: 60 * 60 },
  'workspace:session': { limit: 60, windowSeconds: 60 },
});

/** بداية النافذة الحالية (تُستخدم كمفتاح تخزين مع مفتاح العدّاد). */
export function windowStart(nowMs, windowSeconds) {
  const windowMs = windowSeconds * 1000;
  return Math.floor(nowMs / windowMs) * windowMs;
}

/** كم ثانية تبقى حتى تُفتح نافذة جديدة. */
export function retryAfterSeconds(nowMs, windowSeconds) {
  const windowMs = windowSeconds * 1000;
  const elapsed = nowMs - windowStart(nowMs, windowSeconds);
  return Math.max(1, Math.ceil((windowMs - elapsed) / 1000));
}

/**
 * قرار الحد بلا لمس قاعدة البيانات.
 * @param {{count: number, limit: number, windowSeconds: number, nowMs: number}} input
 */
export function evaluate(input) {
  const { count, limit, windowSeconds, nowMs } = input;
  const used = Number.isFinite(count) && count > 0 ? count : 0;
  const allowed = used <= limit;
  return {
    allowed,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    retryAfterSeconds: allowed ? 0 : retryAfterSeconds(nowMs, windowSeconds),
    windowStartMs: windowStart(nowMs, windowSeconds),
  };
}

/**
 * مفتاح تخزين لا يحمل بيانات شخصية: بادئة + بصمة HMAC قصيرة.
 * @param {string} prefix
 * @param {string} rawValue
 * @param {(secret: string, value: string) => Promise<string>} hmac
 * @param {string} secret
 */
export async function buildKey(prefix, rawValue, hmac, secret) {
  const digest = await hmac(secret, rawValue);
  return `${prefix}:${digest.slice(0, 32)}`;
}

/**
 * ينفّذ الحد عبر دالة SQL ذرية `app.rate_limit_hit(key, limit, window_seconds)`.
 * الدالة ترجع عدد الصفوف في النافذة الحالية بعد الزيادة.
 * @param {{rpc: (fn: string, args: Record<string, unknown>) => Promise<{data: unknown, error: unknown}>}} db
 */
export async function enforceRateLimit(db, { route, key, nowMs = Date.now() }) {
  const rule = LIMITS[route];
  if (!rule) throw new Error(`مسار بلا حدّ معرّف: ${route}`);

  const { data, error } = await db.rpc('rate_limit_hit', {
    p_key: key,
    p_limit: rule.limit,
    p_window_seconds: rule.windowSeconds,
  });

  if (error) throw apiError('UPSTREAM_UNAVAILABLE', { details: 'rate_limit_hit' });

  const count = typeof data === 'number' ? data : Number(data?.[0]?.rate_limit_hit ?? data?.count ?? 0);
  const decision = evaluate({ count, limit: rule.limit, windowSeconds: rule.windowSeconds, nowMs });
  if (!decision.allowed) {
    throw apiError('RATE_LIMITED', {
      details: { retry_after: decision.retryAfterSeconds },
    });
  }
  return decision;
}
