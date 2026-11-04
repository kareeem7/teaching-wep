/**
 * أوليّات الهوية: تطبيع الهاتف/الكود، سياسة كلمة المرور، الرموز والبصمات، سياسة الجلسة.
 *
 * كل شيء هنا **نقي** (بلا DOM ولا قاعدة بيانات) ليكون قابلًا للاختبار في Node:
 *   node --test tests/unit/token-hash.test.js
 *
 * المرجع: AUTH_DESIGN §٣ و§٥، قرارات C-28 (هاتف)، C-32 (خطر الاستعادة المقبول).
 */

import { apiError } from './errors.js';
import { isBlockedOrigin } from './cors.js';

/** سياسة الجلسة: التوكن يعيش ساعة، ويُرفض في كل طلب إن كان أقدم من `sessions_valid_after`. */
export const SESSION_MAX_AGE_SECONDS = 3600;
/** صلاحية دعوة المدرس: ٧٢ ساعة (AUTH_DESIGN §٣ ب). */
export const INVITE_TTL_SECONDS = 72 * 3600;
/** صلاحية رمز الاستعادة: ٣٠ دقيقة (AUTH_DESIGN §٣ د). */
export const RECOVERY_TTL_SECONDS = 30 * 60;
/** طول الرمز العشوائي بالبايت (٣٢ بايت = ٢٥٦ بت). */
export const TOKEN_BYTES = 32;

/** كلمات مرور ممنوعة شائعة — قائمة قصيرة معلنة، ليست بديلًا عن القوة الفعلية. */
export const WEAK_PASSWORDS = Object.freeze([
  'password', 'password1', '12345678', '123456789', '1234567890', 'qwertyui',
  'iloveyou', 'admin123', 'welcome1', 'letmein1', 'minhaj123', 'mina1234',
]);

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/** يحوّل الأرقام العربية/الفارسية إلى لاتينية ويزيل المحارف الخفية. */
export function normalizeDigits(input) {
  if (typeof input !== 'string') return '';
  return Array.from(input)
    .map((char) => {
      const ai = ARABIC_INDIC.indexOf(char);
      if (ai >= 0) return String(ai);
      const ei = EASTERN_ARABIC_INDIC.indexOf(char);
      if (ei >= 0) return String(ei);
      return char;
    })
    .join('')
    .replace(/[\u200c-\u200f\u202a-\u202e\ufeff]/g, '');
}

/**
 * تطبيع رقم الهاتف إلى E.164. لا يفترض ملكية الرقم، ولا يتحقق منه إلا شكليًا.
 * @param {string} raw
 * @param {{defaultCountry?: string}} [options]
 * @returns {{ok: true, e164: string} | {ok: false, reason: string}}
 */
export function normalizePhone(raw, options = {}) {
  const defaultCountry = options.defaultCountry ?? '20';
  if (typeof raw !== 'string') return { ok: false, reason: 'not-a-string' };

  let value = normalizeDigits(raw).trim().replace(/[\s().-]/g, '');
  if (value.length === 0) return { ok: false, reason: 'empty' };

  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  if (!value.startsWith('+')) {
    if (value.startsWith('0')) value = `+${defaultCountry}${value.slice(1)}`;
    else value = `+${defaultCountry}${value}`;
  }

  const digits = value.slice(1);
  if (!/^[0-9]+$/.test(digits)) return { ok: false, reason: 'non-digit' };
  if (digits.length < 8 || digits.length > 15) return { ok: false, reason: 'length' };
  if (digits.startsWith('0')) return { ok: false, reason: 'leading-zero' };

  return { ok: true, e164: `+${digits}` };
}

/**
 * كود الطالب: حرفان لاتينيان كبيران + ٦ أرقام (مثال: MH123456).
 * @param {string} raw
 */
export function normalizeStudentCode(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not-a-string' };
  const value = normalizeDigits(raw).trim().replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}[0-9]{6}$/.test(value)) return { ok: false, reason: 'format' };
  return { ok: true, code: value };
}

/**
 * يميّز نوع المعرّف. الكود لا يبدأ بـ`+` ولا يحتوي حروفًا لاتينية فقط بلا أرقام،
 * فالتفريق قطعي ولا يعتمد على طول الرقم.
 * @param {string} raw
 * @param {{defaultCountry?: string}} [options]
 */
export function classifyIdentifier(raw, options = {}) {
  if (typeof raw !== 'string') return { kind: 'invalid', reason: 'not-a-string' };
  const trimmed = normalizeDigits(raw).trim();
  if (trimmed.length === 0) return { kind: 'invalid', reason: 'empty' };

  const looksLikeCode = /^[A-Za-z]{1,3}[\s-]?[0-9]{4,10}$/.test(trimmed) && !trimmed.startsWith('+');
  if (looksLikeCode) {
    const code = normalizeStudentCode(trimmed);
    if (code.ok) return { kind: 'code', value: code.code };
  }

  const phone = normalizePhone(trimmed, options);
  if (phone.ok) return { kind: 'phone', value: phone.e164 };

  return { kind: 'invalid', reason: phone.reason };
}

/**
 * سياسة كلمة المرور: ١٠ محارف على الأقل، حروف وأرقام، ليست شائعة، ولا تساوي المعرّف.
 * تُحسب البايتات لا المحارف لأن bcrypt يقصّ عند ٧٢ بايت.
 * @param {string} password
 * @param {{identifier?: string, displayName?: string}} [context]
 * @returns {{ok: boolean, issues: string[], score: number}}
 */
export function validatePassword(password, context = {}) {
  /** @type {string[]} */
  const issues = [];
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, issues: ['password-empty'], score: 0 };
  }

  const byteLength = new TextEncoder().encode(password).length;
  if (password.length < 10) issues.push('password-too-short');
  if (byteLength > 72) issues.push('password-too-long');
  if (!/[A-Za-z\u0600-\u06FF]/.test(password)) issues.push('password-no-letter');
  if (!/[0-9]/.test(password)) issues.push('password-no-digit');
  if (/\s{2,}/.test(password) || password.length === 0) issues.push('password-whitespace');

  const normalized = password.toLowerCase();
  if (WEAK_PASSWORDS.includes(normalized)) issues.push('password-too-common');
  const identifier = String(context.identifier ?? '').toLowerCase();
  if (identifier.length >= 4 && normalized === identifier) issues.push('password-equals-identifier');
  const displayName = String(context.displayName ?? '').trim().toLowerCase();
  if (displayName.length >= 4 && normalized === displayName) issues.push('password-equals-name');

  const score = [
    password.length >= 12,
    password.length >= 16,
    /[A-Z]/.test(password) && /[a-z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9\u0600-\u06FF]/.test(password),
  ].filter(Boolean).length;

  return { ok: issues.length === 0, issues, score };
}

/** ترميز base64url بلا `=` حتى يصلح في الروابط. */
function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** رمز عشوائي آمن (٣٢ بايت افتراضيًا). */
export function randomToken(byteLength = TOKEN_BYTES) {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** تنسيق الرمز المقبول: base64url بطول ٤٣ (٣٢ بايت). */
export function isTokenShapeValid(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

async function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 بصيغة hex. */
export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return toHex(digest);
}

/** HMAC-SHA-256 بصيغة hex — يُستخدم لبصم الرموز (مفتاح سرّي على الخادم فقط). */
export async function hmacSha256Hex(secret, value) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('hmac secret too short');
  }
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(value)));
  return toHex(signature);
}

/** بصمة الرمز كما تُخزَّن في قاعدة البيانات — لا يُخزَّن الرمز نفسه أبدًا. */
export async function hashToken(token, secret) {
  return hmacSha256Hex(secret, `minhaj-token:${String(token)}`);
}

/** مفاتيح حدّ المعدل: بصمة كي لا تُخزَّن أرقام الهواتف في جدول العدّادات. */
export async function hashRateKey(value, secret) {
  return hmacSha256Hex(secret, `minhaj-rate:${String(value)}`);
}

/** مقارنة بزمن ثابت — تمنع استنتاج البايت الصحيح من فرق التوقيت. */
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return diff === 0;
}

/**
 * يُصدر رمزًا جديدًا ويعيد الرمز الخام (يُسلَّم مرة واحدة) وبصمته (تُخزَّن).
 * @param {{secret: string, ttlSeconds: number, nowMs?: number, bytes?: number}} input
 */
export async function issueToken(input) {
  const { secret, ttlSeconds } = input;
  const nowMs = input.nowMs ?? Date.now();
  const token = randomToken(input.bytes ?? TOKEN_BYTES);
  const tokenHash = await hashToken(token, secret);
  return {
    token,
    tokenHash,
    expiresAt: new Date(nowMs + ttlSeconds * 1000).toISOString(),
    ttlSeconds,
  };
}

/**
 * تحقق من صلاحية دعوة/رمز استعادة كما ستُفحص في قاعدة البيانات أيضًا (دفاع مزدوج).
 * @param {{expiresAt?: string|null, usedAt?: string|null, revokedAt?: string|null, kind?: string|null, expectedKind?: string, nowMs?: number}} row
 */
export function checkTokenState(row, expectedKind) {
  if (!row) return { ok: false, reason: 'missing' };
  const nowMs = row.nowMs ?? Date.now();
  if (row.revokedAt) return { ok: false, reason: 'revoked' };
  if (row.usedAt) return { ok: false, reason: 'used' };
  if (expectedKind && row.kind && row.kind !== expectedKind) return { ok: false, reason: 'wrong-kind' };
  if (!row.expiresAt) return { ok: false, reason: 'no-expiry' };
  const expiry = Date.parse(row.expiresAt);
  if (Number.isNaN(expiry)) return { ok: false, reason: 'bad-expiry' };
  if (expiry <= nowMs) return { ok: false, reason: 'expired' };
  return { ok: true, reason: 'valid', secondsLeft: Math.floor((expiry - nowMs) / 1000) };
}

/**
 * هل الجلسة أقدم من آخر تغيير لكلمة المرور/الإيقاف؟
 * القاعدة الملزمة (AUTH_DESIGN §٥): `iat >= sessions_valid_after`.
 * @param {{issuedAtSeconds?: number|null, validAfterIso?: string|null}} input
 */
export function isSessionStillValid(input) {
  const { issuedAtSeconds, validAfterIso } = input;
  if (!Number.isFinite(issuedAtSeconds)) return false;
  if (!validAfterIso) return true;
  const validAfter = Date.parse(validAfterIso);
  if (Number.isNaN(validAfter)) return false;
  return issuedAtSeconds * 1000 >= validAfter;
}

/** حقول الملف التي يجوز إرجاعها للمتصفح — لا كلمة مرور ولا بصمة ولا هاتف كاملًا. */
export function publicProfile(row) {
  if (!row || typeof row !== 'object') return null;
  const source = /** @type {Record<string, unknown>} */ (row);
  return {
    user_id: source.user_id ?? source.id ?? null,
    full_name: source.full_name ?? null,
    role: source.role ?? null,
    status: source.status ?? null,
    phone_last4: typeof source.phone_e164 === 'string' ? source.phone_e164.slice(-4) : null,
    student_code: source.student_code ?? null,
    sessions_valid_after: source.sessions_valid_after ?? null,
  };
}

/** رسالة فشل الدخول الموحدة: لا تفريق بين «لا يوجد حساب» و«كلمة خطأ». */
export const UNIFIED_LOGIN_ERROR = 'بيانات الدخول غير صحيحة.';

/* =====================================================================
 *  طبقة الطلب المشتركة بين دوال المصادقة
 *  (كانت في ملف منفصل، ودُمجت هنا للحفاظ على قائمة ملفات المرحلة كما هي ملزمة)
 * ===================================================================== */
/** بريد داخلي اصطناعي لمن يدخل بالكود — لا يظهر للمستخدم ولا يُرسل إليه شيء. */
export function syntheticEmailForCode(code) {
  return `code-${String(code).toLowerCase()}@students.minhaj.invalid`;
}

/** عنوان IP من رؤوس الوسيط، أو 'unknown'. */
export function clientIp(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}

/**
 * يقرأ JSON بحد أقصى للحجم، ويرفض ما ليس كائنًا.
 * @param {Request} request
 * @param {number} [maxBytes]
 */
export async function readJson(request, maxBytes = 4096) {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) throw apiError('INVALID_INPUT');
  const text = await request.text();
  if (text.length === 0) throw apiError('INVALID_INPUT');
  if (text.length > maxBytes) throw apiError('INVALID_INPUT', { details: 'payload-too-large' });
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not-object');
    return /** @type {Record<string, unknown>} */ (parsed);
  } catch {
    throw apiError('INVALID_INPUT');
  }
}

/** يفك حمولة JWT بلا تحقق توقيع — للقراءة فقط بعد أن يتحقق الخادم من الجلسة. */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const json = atob(padded);
    const bytes = Uint8Array.from(json, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * يتحقق من جلسة العميل عبر Auth، ويعيد الملف.
 * @param {{auth: {getUser: (token: string) => Promise<{data: unknown, error: unknown}>}}} db
 * @param {string|null} token
 */
export async function requireSession(db, token) {
  if (typeof token !== 'string' || token.split('.').length !== 3) throw apiError('INVALID_SESSION');
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user?.id) throw apiError('INVALID_SESSION');

  const claims = decodeJwtPayload(token) ?? {};
  const issuedAt = Number(claims.iat);
  if (!Number.isFinite(issuedAt)) throw apiError('INVALID_SESSION');
  if (Date.now() / 1000 - issuedAt > SESSION_MAX_AGE_SECONDS + 60) {
    throw apiError('INVALID_SESSION', { details: 'session-too-old' });
  }

  return { userId: data.user.id, issuedAt, claims };
}

/** يستخرج رمز Bearer من الرأس. */
export function bearerToken(request) {
  const header = request.headers.get('authorization');
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/** هل الطلب مقبول من ناحية الأصل والطريقة؟ يرمي أخطاء مناسبة. */
export function guardRequest(request, allowlist, { method = 'POST' } = {}) {
  if (isBlockedOrigin(request, allowlist)) throw apiError('FORBIDDEN', { details: 'origin' });
  if (request.method !== method) throw apiError('METHOD_NOT_ALLOWED');
}

/** يبني عنوان الرابط للدعوة/الاستعادة من متغير بيئة، بلا افتراض نطاق إنتاجي. */
export function buildLink(env, path, token) {
  const base = typeof env === 'string' ? env : '';
  const prefix = base.replace(/\/+$/, '');
  return `${prefix}${path}?token=${encodeURIComponent(token)}`;
}

