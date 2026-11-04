/**
 * اختبارات الرموز والبصمات وأوليّات الهوية وحدّ المعدل وCORS.
 *
 * كلها كود نقي يعمل في Node بلا قاعدة بيانات ولا Deno — لذلك تُشغَّل فعليًا هنا:
 *   node --test tests/unit/token-hash.test.js
 *
 * ما لا تغطيه هذه الاختبارات: RLS نفسها (تحتاج PostgreSQL) — انظر `tests/sql/identity_rls.test.sql`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_MAX_AGE_SECONDS,
  INVITE_TTL_SECONDS,
  RECOVERY_TTL_SECONDS,
  classifyIdentifier,
  checkTokenState,
  constantTimeEqual,
  hashRateKey,
  hashToken,
  hmacSha256Hex,
  isSessionStillValid,
  isTokenShapeValid,
  issueToken,
  normalizePhone,
  normalizeStudentCode,
  publicProfile,
  randomToken,
  sha256Hex,
  validatePassword,
} from '../../supabase/functions/_shared/auth.js';

import { LIMITS, buildKey, evaluate, enforceRateLimit, retryAfterSeconds, windowStart } from '../../supabase/functions/_shared/rate-limit.js';
import { ApiError, ERROR_SPECS, apiError, okResponse, redact, toErrorResponse } from '../../supabase/functions/_shared/errors.js';
import { corsHeaders, isBlockedOrigin, isOriginAllowed, parseAllowlist, preflightResponse } from '../../supabase/functions/_shared/cors.js';
import { buildUrl, createDb, readEnv, requireEnv, scrubKey } from '../../supabase/functions/_shared/db.js';

const SECRET = 'unit-test-secret-key-0123456789abcdef';

/* ----------------------------- ١) الهاتف ----------------------------- */

test('الهاتف: الأرقام العربية والفارسية والمسافات تُطبَّع إلى E.164 مصري', () => {
  assert.deepEqual(normalizePhone('٠١٠ ١٢٣٤ ٥٦٧٨'), { ok: true, e164: '+201012345678' });
  assert.deepEqual(normalizePhone('0101-234-5678'), { ok: true, e164: '+201012345678' });
  assert.deepEqual(normalizePhone('+20 101 234 5678'), { ok: true, e164: '+201012345678' });
  assert.deepEqual(normalizePhone('00201012345678'), { ok: true, e164: '+201012345678' });
  assert.deepEqual(normalizePhone('1012345678'), { ok: true, e164: '+201012345678' });
});

test('الهاتف: المدخلات غير الصالحة تُرفض بأسباب مختلفة لا برسالة غامضة', () => {
  assert.equal(normalizePhone('').ok, false);
  assert.equal(normalizePhone('abc').ok, false);
  assert.equal(normalizePhone('123').ok, false);
  assert.equal(normalizePhone('1234567890123456').ok, false);
  assert.equal(normalizePhone(/** @type {unknown} */ (12345)).ok, false);
  assert.equal(normalizePhone('+2010123456789').ok, true, 'طول ١٥ مقبول');
});

/* ----------------------------- ٢) كود الطالب ----------------------------- */

test('الكود: صيغة موحّدة (حرفان + ٦ أرقام) بلا اعتماد على حالة الأحرف', () => {
  assert.deepEqual(normalizeStudentCode('mh123456'), { ok: true, code: 'MH123456' });
  assert.deepEqual(normalizeStudentCode('MH-123 456'), { ok: true, code: 'MH123456' });
  assert.deepEqual(normalizeStudentCode('مش123456'), { ok: false, reason: 'format' });
  assert.equal(normalizeStudentCode('MH12345').ok, false);
  assert.equal(normalizeStudentCode('M1123456').ok, false);
});

test('تمييز المعرّف: هاتف مقابل كود بلا تخمين', () => {
  assert.deepEqual(classifyIdentifier('MH123456'), { kind: 'code', value: 'MH123456' });
  assert.deepEqual(classifyIdentifier('01012345678'), { kind: 'phone', value: '+201012345678' });
  assert.deepEqual(classifyIdentifier('+201012345678'), { kind: 'phone', value: '+201012345678' });
  assert.equal(classifyIdentifier('  ').kind, 'invalid');
  assert.equal(classifyIdentifier('x').kind, 'invalid');
});

/* ----------------------------- ٣) كلمة المرور ----------------------------- */

test('كلمة المرور: السياسة ترفض القصير والبسيط وتقبل القوي', () => {
  assert.equal(validatePassword('short').ok, false);
  assert.ok(validatePassword('short').issues.includes('password-too-short'));

  const digitsOnly = validatePassword('1234567890123');
  assert.equal(digitsOnly.ok, false);
  assert.ok(digitsOnly.issues.includes('password-no-letter'));

  const lettersOnly = validatePassword('abcdefghijkl');
  assert.equal(lettersOnly.ok, false);
  assert.ok(lettersOnly.issues.includes('password-no-digit'));

  const common = validatePassword('password1');
  assert.ok(common.issues.includes('password-too-common') || common.issues.includes('password-too-short'));

  assert.equal(validatePassword('Minhaj#2026pass').ok, true);
  assert.ok(validatePassword('Minhaj#2026pass').score >= 3);
});

test('كلمة المرور: لا تُقبل مطابقة المعرّف ولا الاسم، وتُرفض إن زادت عن ٧٢ بايت', () => {
  const sameAsPhone = validatePassword('+201012345678', { identifier: '+201012345678' });
  assert.ok(sameAsPhone.issues.includes('password-equals-identifier'));

  const sameAsName = validatePassword('minhaj ali', { displayName: 'Minhaj Ali' });
  assert.ok(sameAsName.issues.includes('password-equals-name'));
  assert.equal(sameAsName.ok, false, 'مسافة مزدوجة/لا رقم ⇒ مرفوضة');

  const long = validatePassword(`${'a1'.repeat(40)}`);
  assert.ok(long.issues.includes('password-too-long'));
  assert.equal(long.ok, false);
});

/* ----------------------------- ٤) الرموز والبصمات ----------------------------- */

test('الرمز العشوائي: ٤٣ محرفًا base64url وفريد في كل نداء', () => {
  const tokens = new Set(Array.from({ length: 200 }, () => randomToken()));
  assert.equal(tokens.size, 200, 'لا تكرار في ٢٠٠ رمز');
  for (const token of tokens) {
    assert.equal(token.length, 43);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(isTokenShapeValid(token), true);
  }
  assert.equal(isTokenShapeValid('short'), false);
  assert.equal(isTokenShapeValid('a'.repeat(44)), false);
});

test('البصمة: sha256 معروفة القيمة، وHMAC يتغير بتغيّر المفتاح', async () => {
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );

  const a = await hmacSha256Hex(SECRET, 'token-1');
  const b = await hmacSha256Hex(`${SECRET}x`, 'token-1');
  const c = await hmacSha256Hex(SECRET, 'token-2');
  assert.notEqual(a, b, 'مفتاح مختلف ⇒ بصمة مختلفة');
  assert.notEqual(a, c, 'رسالة مختلفة ⇒ بصمة مختلفة');
  assert.equal(a.length, 64);
  await assert.rejects(() => hmacSha256Hex('short', 'x'), /hmac secret too short/);
});

test('بصمة الرمز: نفس الرمز يعطي نفس البصمة، ولا يمكن استنتاج الرمز من البصمة', async () => {
  const token = randomToken();
  assert.equal(await hashToken(token, SECRET), await hashToken(token, SECRET));
  assert.notEqual(await hashToken(token, SECRET), await hashToken(token, `${SECRET}2`));
  assert.notEqual(await hashToken(token, SECRET), token);
  assert.match(await hashToken(token, SECRET), /^[0-9a-f]{64}$/);
});

test('بصمة مفاتيح حدّ المعدل لا تساوي القيمة الأصلية (لا هواتف في جدول العدّادات)', async () => {
  const digest = await hashRateKey('+201012345678', SECRET);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest.includes('201012345678'), false);

  const key = await buildKey('login:identifier', '+201012345678', hmacSha256Hex, SECRET);
  assert.match(key, /^login:identifier:[0-9a-f]{32}$/);
  assert.equal(key.includes('201012345678'), false);
});

test('المقارنة بزمن ثابت: تساوي/اختلاف/أنواع غير نصية', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual('', ''), true);
  assert.equal(constantTimeEqual(/** @type {unknown} */ (null), 'abc'), false);
});

test('إصدار الرمز: مدة الصلاحية محسوبة من الزمن المعطى', async () => {
  const nowMs = Date.parse('2026-11-05T10:00:00.000Z');
  const invite = await issueToken({ secret: SECRET, ttlSeconds: INVITE_TTL_SECONDS, nowMs });
  assert.equal(invite.expiresAt, new Date(nowMs + 72 * 3600 * 1000).toISOString());
  assert.equal((await hashToken(invite.token, SECRET)), invite.tokenHash);

  const recovery = await issueToken({ secret: SECRET, ttlSeconds: RECOVERY_TTL_SECONDS, nowMs });
  assert.equal(recovery.ttlSeconds, 1800);
});

/* ----------------------------- ٥) حالة الرمز ----------------------------- */

test('حالة الرمز: مستخدم/منتهي/ملغى/نوع خاطئ/سليم', () => {
  const nowMs = Date.parse('2026-11-05T10:00:00.000Z');
  const future = new Date(nowMs + 60_000).toISOString();
  const past = new Date(nowMs - 60_000).toISOString();

  // الزمن يُمرَّر صريحًا: لا اعتماد على ساعة الجهاز في اختبار أمني
  assert.equal(checkTokenState({ expiresAt: future, kind: 'teacher_invite', nowMs }, 'teacher_invite').reason, 'valid');
  assert.equal(checkTokenState({ expiresAt: future, usedAt: new Date(nowMs).toISOString(), nowMs }).reason, 'used');
  assert.equal(checkTokenState({ expiresAt: future, kind: 'student_link', nowMs }, 'teacher_invite').reason, 'wrong-kind');
  assert.equal(checkTokenState({ expiresAt: past, nowMs }).reason, 'expired');
  assert.equal(checkTokenState({ expiresAt: future, revokedAt: past, nowMs }).reason, 'revoked');
  assert.equal(checkTokenState(null).reason, 'missing');
  assert.equal(checkTokenState({ expiresAt: 'not-a-date', nowMs }).reason, 'bad-expiry');
  assert.equal(checkTokenState({ expiresAt: future, nowMs }).secondsLeft, 60);
});

/* ----------------------------- ٦) سياسة الجلسة ----------------------------- */

test('الجلسة: تُرفض إن أُصدرت قبل آخر تغيير لكلمة المرور أو الإيقاف', () => {
  const validAfter = '2026-11-05T10:00:00.000Z';
  const before = Math.floor(Date.parse('2026-11-05T09:59:59.000Z') / 1000);
  const after = Math.floor(Date.parse('2026-11-05T10:00:01.000Z') / 1000);

  assert.equal(isSessionStillValid({ issuedAtSeconds: before, validAfterIso: validAfter }), false);
  assert.equal(isSessionStillValid({ issuedAtSeconds: after, validAfterIso: validAfter }), true);
  assert.equal(isSessionStillValid({ issuedAtSeconds: after, validAfterIso: null }), true);
  assert.equal(isSessionStillValid({ issuedAtSeconds: null, validAfterIso: validAfter }), false);
  assert.equal(isSessionStillValid({ issuedAtSeconds: after, validAfterIso: 'x' }), false);
  assert.equal(SESSION_MAX_AGE_SECONDS, 3600);
});

/* ----------------------------- ٧) ما يُعاد للمتصفح ----------------------------- */

test('لاتظهر الملفات: لا كلمة مرور ولا بصمة ولا هاتف كامل', () => {
  const safe = publicProfile({
    user_id: 'u1',
    full_name: 'طالب تجريبي',
    role: 'student',
    status: 'active',
    phone_e164: '+201012345678',
    password_hash: 'secret',
    student_code: 'MH123456',
  });
  assert.equal(safe.user_id, 'u1');
  assert.equal(safe.phone_last4, '5678');
  assert.equal(JSON.stringify(safe).includes('201012345678'), false);
  assert.equal(Object.keys(safe).includes('password_hash'), false);
  assert.equal(publicProfile(null), null);
});

/* ----------------------------- ٨) حدّ المعدل ----------------------------- */

test('حدّ المعدل: نافذة ثابتة وقرار صحيح عند الحد وعنده زائدًا', () => {
  const windowSeconds = 900;
  const nowMs = Date.parse('2026-11-05T10:07:30.000Z');
  assert.equal(windowStart(nowMs, windowSeconds), Date.parse('2026-11-05T10:00:00.000Z'));
  assert.equal(retryAfterSeconds(nowMs, windowSeconds), 450);

  const allowed = evaluate({ count: 5, limit: 5, windowSeconds, nowMs });
  assert.equal(allowed.allowed, true, 'الخامسة مسموحة');
  assert.equal(allowed.remaining, 0);

  const blocked = evaluate({ count: 6, limit: 5, windowSeconds, nowMs });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 450);

  assert.equal(evaluate({ count: 0, limit: 5, windowSeconds, nowMs }).allowed, true);
  assert.equal(evaluate({ count: Number.NaN, limit: 5, windowSeconds, nowMs }).used, 0);
});

test('حدّ المعدل: الحدود المعتمدة تطابق AUTH_DESIGN §٤', () => {
  assert.deepEqual(LIMITS['login:identifier'], { limit: 5, windowSeconds: 900 });
  assert.deepEqual(LIMITS['login:ip'], { limit: 20, windowSeconds: 3600 });
  assert.deepEqual(LIMITS['recovery:teacher'], { limit: 3, windowSeconds: 3600 });
  assert.deepEqual(LIMITS['recovery:student'], { limit: 5, windowSeconds: 86400 });
  assert.deepEqual(LIMITS['invite:ip'], { limit: 10, windowSeconds: 3600 });
});

test('حدّ المعدل: يتوقف عند الحد ويرمي RATE_LIMITED قبل تنفيذ العمل', async () => {
  const allowedDb = { rpc: async () => ({ data: 3, error: null }) };
  const decision = await enforceRateLimit(allowedDb, { route: 'login:identifier', key: 'login:identifier:abc' });
  assert.equal(decision.allowed, true);
  assert.equal(decision.remaining, 2);

  const blockedDb = { rpc: async () => ({ data: 6, error: null }) };
  await assert.rejects(
    () => enforceRateLimit(blockedDb, { route: 'login:identifier', key: 'k' }),
    (error) => error instanceof ApiError && error.code === 'RATE_LIMITED' && error.status === 429,
  );

  const brokenDb = { rpc: async () => ({ data: null, error: { status: 500 } }) };
  await assert.rejects(
    () => enforceRateLimit(brokenDb, { route: 'login:ip', key: 'k' }),
    (error) => error instanceof ApiError && error.code === 'UPSTREAM_UNAVAILABLE',
  );
});

/* ----------------------------- ٩) الأخطاء ----------------------------- */

test('الأخطاء: كل رمز له حالة ورسالة، ورسالة الدخول موحدة', async () => {
  for (const [code, spec] of Object.entries(ERROR_SPECS)) {
    assert.ok(Number.isInteger(spec.status) && spec.status >= 400, code);
    assert.ok(typeof spec.message === 'string' && spec.message.length > 0, code);
  }
  assert.equal(ERROR_SPECS.INVALID_CREDENTIALS.status, 401);
  assert.equal(ERROR_SPECS.RATE_LIMITED.status, 429);
  assert.equal(apiError('INVALID_CREDENTIALS').message, ERROR_SPECS.INVALID_CREDENTIALS.message);

  const unknown = apiError('NOT_A_REAL_CODE');
  assert.equal(unknown.code, 'INTERNAL');
  assert.equal(unknown.status, 500);
});

test('الأخطاء: الرد لا يسرّب تفاصيل داخلية ويحمل request_id', async () => {
  const response = toErrorResponse(new ApiError('INVALID_INPUT'), { requestId: 'req-1' });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body.code, 'INVALID_INPUT');
  assert.equal(body.request_id, 'req-1');
  assert.equal(JSON.stringify(body).includes('stack'), false);

  const internal = await toErrorResponse(new Error('relation app.profiles does not exist')).json();
  assert.equal(internal.code, 'INTERNAL');
  assert.equal(JSON.stringify(internal).includes('relation'), false, 'لا أسماء جداول للمتصفح');

  const ok = await okResponse({ token: 'x' }).json();
  assert.equal(ok.ok, true);
  assert.equal(ok.data.token, 'x');
});

test('الحجب: أي مفتاح حساس يظهر [محجوب] في السجل', () => {
  const safe = redact({
    password: 'Secret#123',
    nested: { token: 'abc', refresh_token: 'r', note: 'ok' },
    authorization: 'Bearer x',
  });
  assert.equal(safe.password, '[محجوب]');
  assert.equal(safe.nested.token, '[محجوب]');
  assert.equal(safe.nested.refresh_token, '[محجوب]');
  assert.equal(safe.nested.note, 'ok');
  assert.equal(safe.authorization, '[محجوب]');
});

/* ----------------------------- ١٠) CORS ----------------------------- */

test('CORS: رفض `*` وسماح الأصول المعلنة فقط', () => {
  assert.deepEqual(parseAllowlist('*'), []);
  assert.deepEqual(parseAllowlist('https://a.test, https://b.test/ '), ['https://a.test', 'https://b.test']);

  assert.equal(isOriginAllowed('https://a.test', ['https://a.test']), true);
  assert.equal(isOriginAllowed('https://evil.test', ['https://a.test']), false);
  assert.equal(isOriginAllowed('https://a.test/path', ['https://a.test']), false);
  assert.equal(isOriginAllowed(null, []), true, 'طلبات بلا Origin (خادم↔خادم)');

  assert.deepEqual(corsHeaders('https://evil.test', ['https://a.test']), {});
  assert.equal(corsHeaders('https://a.test', ['https://a.test'])['access-control-allow-origin'], 'https://a.test');
  assert.equal(JSON.stringify(corsHeaders('https://a.test', ['https://a.test'])).includes('*'), false);
});

test('CORS: preflight صريح، والأصل المرفوض ٤٠٣', () => {
  const allowed = preflightResponse(
    new Request('https://fn.test/auth-login', { method: 'OPTIONS', headers: { origin: 'https://a.test' } }),
    ['https://a.test'],
  );
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-methods'), 'POST, OPTIONS');

  const blocked = preflightResponse(
    new Request('https://fn.test/auth-login', { method: 'OPTIONS', headers: { origin: 'https://evil.test' } }),
    ['https://a.test'],
  );
  assert.equal(blocked.status, 403);

  const req = (origin) => new Request('https://fn.test/x', { headers: { origin } });
  assert.equal(isBlockedOrigin(req('https://evil.test'), ['https://a.test']), true);
  assert.equal(isBlockedOrigin(req('https://a.test'), ['https://a.test']), false);
});

/* ----------------------------- ١١) طبقة الاتصال ----------------------------- */

test('العنوان: بناء صحيح بلا تكرار شرطة مائلة ولا معاملات فارغة', () => {
  assert.equal(
    buildUrl('https://x.supabase.co/', '/rest/v1/rpc/rl', { a: 1, b: null, c: '' }),
    'https://x.supabase.co/rest/v1/rpc/rl?a=1',
  );
  assert.equal(buildUrl('https://x.supabase.co', 'rest/v1/t'), 'https://x.supabase.co/rest/v1/t');
});

test('البيئة: قراءة من كائن أو من `get`، والمتغير الإلزامي يرمي SERVICE_NOT_CONFIGURED', () => {
  assert.equal(readEnv({ A: 'x' }, 'A'), 'x');
  assert.equal(readEnv({ A: '' }, 'A'), undefined);
  assert.equal(readEnv({ get: (k) => (k === 'B' ? 'y' : undefined) }, 'B'), 'y');
  assert.throws(() => requireEnv({}, 'SUPABASE_URL'), (error) => error.code === 'SERVICE_NOT_CONFIGURED');
});

test('طبقة الاتصال: المفتاح في الرأس، والخطأ يُطهَّر من المفتاح', async () => {
  const key = 'service-role-key-for-test';
  const calls = [];
  const db = createDb({
    baseUrl: 'https://x.supabase.co',
    serviceRoleKey: key,
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: init.headers, method: init.method, body: init.body });
      return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
    },
  });

  const { data, error } = await db.select('app.profiles', { filters: { id: 'eq.1' }, limit: 1 });
  assert.equal(error, null);
  assert.deepEqual(data, [{ id: 1 }]);
  assert.equal(calls[0].headers.apikey, key);
  assert.equal(calls[0].headers.authorization, `Bearer ${key}`);
  assert.match(calls[0].url, /select=%2A|select=\*/);
  assert.equal(calls[0].url.includes('limit=1'), true);

  assert.equal(scrubKey(`failed with ${key}`, key), 'failed with [محجوب]');
  assert.throws(() => db.update('app.profiles', {}, { status: 'x' }), /بلا مرشّح/);
});

test('طبقة الاتصال: فشل الشبكة يتحول إلى UPSTREAM_UNAVAILABLE لا إلى تفاصيل داخلية', async () => {
  const db = createDb({
    baseUrl: 'https://x.supabase.co',
    serviceRoleKey: 'k'.repeat(20),
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED 10.0.0.1');
    },
  });
  await assert.rejects(() => db.rpc('rate_limit_hit', {}), (error) => {
    assert.equal(error.code, 'UPSTREAM_UNAVAILABLE');
    assert.equal(error.message.includes('ECONNREFUSED'), false);
    return true;
  });
});
