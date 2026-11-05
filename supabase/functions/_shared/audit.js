/**
 * تدقيق من طبقة Edge — للأحداث التي **لا تمرّ** على دالة SQL.
 *
 * هنا بالضبط:
 *   • محاولة إدارية مرفوضة (دور غير كافٍ، جلسة منتهية) ⇒ outcome = 'denied'.
 *   • فشل قبل الوصول إلى قاعدة البيانات (إعداد ناقص، حِمل غير صالح).
 *
 * أمّا القرارات الناجحة (دعوة، إيقاف، تعليم) فتُدقَّق **داخل** دالة SQL في نفس المعاملة،
 * فلو فشلت الكتابة لم يقع القرار أصلًا. لا نكرر التدقيق هنا حتى لا يتضاعف الحدث.
 *
 * قواعد صارمة:
 *   ١. لا يُرسل رمز خام ولا كلمة مرور ولا بصمة إلى أي تفصيل — تُقلَّم قبل الإرسال.
 *   ٢. لا هواتف كاملة: يُسمح بـ`*_last4` فقط.
 *   ٣. فشل التدقيق لا يُسقط الطلب المرفوض (المستخدم مرفوض أصلًا)، لكنه يُسجَّل في سجل الدالة.
 */
import { apiError } from './errors.js';
import { hashRateKey } from './auth.js';

/** مفاتيح لا تدخل التفصيل مهما كان مصدرها. */
const SENSITIVE_KEY = /(token|password|secret|authorization|apikey|api_key|hash|otp|e164|phone|student_code)/i;
/** استثناء مقصود: آخر ٤ أرقام مسموح بها للدعم. */
const SAFE_KEY = /(_last4|_last_four)$/i;

/**
 * يقلّم التفصيل ليكون آمنًا للتخزين: يحذف المفاتيح الحساسة، ويحدّ الطول والعمق.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function sanitizeDetail(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (depth > 3) return '[مقتطع]';

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeDetail(item, depth + 1));
  }

  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, item] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      if (SAFE_KEY.test(key)) {
        out[key] = typeof item === 'string' ? item.slice(-4) : null;
        continue;
      }
      if (SENSITIVE_KEY.test(key)) continue;
      out[key] = sanitizeDetail(item, depth + 1);
    }
    return out;
  }

  if (typeof value === 'string') return value.slice(0, 300);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value).slice(0, 120);
}

/** بصمة قصيرة لعنوان الشبكة — لا يُخزَّن العنوان الخام أبدًا. */
export async function hashIp(ip, secret) {
  if (!ip || typeof ip !== 'string') return null;
  try {
    return await hashRateKey(ip, secret);
  } catch {
    return null;
  }
}

/**
 * يكتب حدث تدقيق عبر دالة الخدمة.
 * @param {{rpc: (name: string, args: Record<string, unknown>) => Promise<{data: unknown, error: unknown}>}} db
 * @param {{action: string, actor?: string|null, teacher?: string|null, entity?: string|null,
 *          entityId?: string|null, outcome?: 'ok'|'denied'|'failed', detail?: Record<string, unknown>,
 *          ipHash?: string|null}} event
 */
export async function auditEvent(db, event) {
  const {
    action, actor = null, teacher = null, entity = null, entityId = null,
    outcome = 'ok', detail = {}, ipHash = null,
  } = event;

  if (typeof action !== 'string' || action.length < 3 || action.length > 80) {
    return { ok: false, reason: 'invalid-action' };
  }

  try {
    const { error } = await db.rpc('svc_audit', {
      p_action: action,
      p_actor: actor ?? null,
      p_teacher: teacher ?? null,
      p_entity: entity ?? null,
      p_entity_id: entityId ?? null,
      p_outcome: outcome,
      p_detail: sanitizeDetail(detail) ?? {},
      p_ip_hash: ipHash && /^[0-9a-f]{64}$/.test(ipHash) ? ipHash : null,
    });

    if (error) return { ok: false, reason: 'rpc-error' };
    return { ok: true };
  } catch (error) {
    // لا نرمي من هنا: الطلب مرفوض أصلًا، وإسقاطه بسبب التدقيق يخفي السبب الحقيقي.
    console.error(JSON.stringify({ scope: 'audit', code: 'write-failed', message: String(error) }));
    return { ok: false, reason: 'exception' };
  }
}

/**
 * تدقيق محاولة مرفوضة. لا يحمل سببًا تقنيًا مفصّلًا، بل تصنيفًا قصيرًا.
 * @param {Parameters<typeof auditEvent>[0]} db
 * @param {{action: string, actor?: string|null, reason: string, ipHash?: string|null}} input
 */
export function auditDenied(db, input) {
  return auditEvent(db, {
    action: input.action,
    actor: input.actor ?? null,
    entity: 'admin',
    outcome: 'denied',
    ipHash: input.ipHash ?? null,
    detail: { reason: String(input.reason ?? 'denied').slice(0, 60) },
  });
}

/** خطأ موحّد للطلبات الإدارية غير المتاحة — رسالة واحدة لا تكشف سببًا داخليًا. */
export function adminDeniedError() {
  return apiError('FORBIDDEN', { details: 'admin-action' });
}
