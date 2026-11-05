/**
 * functions.test.js — اختبارات آلية لمسارات Edge Functions نفسها (F-10).
 *
 * لماذا: اختبارات الوحدة السابقة كانت تغطي الأوليّات (تطبيع، تجزئة، سياسة كلمة مرور)،
 * أما قرارات الدوال (من يُرفض، وبأي رمز، وهل تُستهلك الدعوة) فكانت تُجرَّب يدويًا فقط.
 * كل حالة هنا تستخدم `deps.db` مزيّفًا صريحًا: لا شبكة، ولا قاعدة بيانات، ولا أسرار.
 *
 * ما لا تحله هذه الاختبارات: سلوك PostgreSQL وRLS الحقيقي — ذاك يبقى لـ pgTAP
 * على قاعدة منعزلة، ويُسجّل NOT RUN حتى تُوفَّر.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { handler as inviteAccept } from '../../supabase/functions/invite-accept/index.js';
import { handler as authLogin } from '../../supabase/functions/auth-login/index.js';
import { handler as authRecovery } from '../../supabase/functions/auth-recovery/index.js';
import { LIMITS } from '../../supabase/functions/_shared/rate-limit.js';
import { ERROR_SPECS } from '../../supabase/functions/_shared/errors.js';

const ORIGIN = 'https://app.example.test';
const ENV = Object.freeze({
  APP_ALLOWED_ORIGINS: ORIGIN,
  SUPABASE_URL: 'https://stub-project-ref-0000.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'stub-service-role-key-not-real',
  RATE_LIMIT_SECRET: 'stub-rate-secret-not-real-0123456789abcdef',
});

/** توكن بصيغة مقبولة كما يفرضها isTokenShapeValid: base64url بطول ٤٣ (٣٢ بايت) — وهمي. */
const TOKEN = 'a'.repeat(43);

/**
 * عميل مزيّف: كل نداء يُسجَّل، وكل مسار يُجاب من خريطة يحددها الاختبار.
 * @param {{rpc?: Record<string, Function>, auth?: Record<string, Function>}} [spec]
 */
function fakeDb(spec = {}) {
  const calls = [];
  return {
    calls,
    rpc(name, args) {
      calls.push({ kind: 'rpc', name, args });
      const fn = spec.rpc?.[name];
      return Promise.resolve(fn ? fn(args) : { data: null, error: null });
    },
    auth: new Proxy(
      {},
      {
        get: (_target, method) => (arg) => {
          calls.push({ kind: 'auth', name: String(method), arg });
          const fn = spec.auth?.[method];
          return Promise.resolve(fn ? fn(arg) : { data: null, error: null });
        },
      },
    ),
  };
}

function jsonRequest(path, body, { headers = {}, method = 'POST' } = {}) {
  return new Request(`https://functions.example.test${path}`, {
    method,
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

function rpcNames(db) {
  return db.calls.filter((call) => call.kind === 'rpc').map((call) => call.name);
}

function auditCalls(db) {
  return db.calls.filter((call) => call.kind === 'rpc' && call.name === 'svc_audit').map((call) => call.args);
}

function rateLimitCalls(db) {
  return db.calls.filter((call) => call.kind === 'rpc' && call.name === 'svc_rate_limit_hit');
}

/* =====================================================================
   ١) invite-accept — رفض الحساب الموقوف وخلط الأدوار، ولا استهلاك منفصل
   ===================================================================== */

const validInvite = {
  kind: 'teacher_invite',
  expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  used_at: null,
  revoked_at: null,
  teacher_id: null,
  student_profile_id: null,
};

test('invite-accept: بلا إعداد ⇒ 503 صريح لا 500', async () => {
  // بلا Origin: الحارس لا يحجب أولًا، فيصل الطلب إلى فحص الإعداد المفقود.
  const request = new Request('https://functions.example.test/invite-accept', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  const response = await inviteAccept(request, { env: {} });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'SERVICE_NOT_CONFIGURED');
});

test('invite-accept: GET ⇒ 405', async () => {
  const response = await inviteAccept(
    jsonRequest('/invite-accept', null, { method: 'GET' }),
    { env: ENV, db: fakeDb() },
  );
  assert.equal(response.status, 405);
});

test('invite-accept: أصل غير مسموح ⇒ 403 قبل أي عمل', async () => {
  const db = fakeDb();
  const response = await inviteAccept(
    jsonRequest('/invite-accept', { token: TOKEN }, { headers: { origin: 'https://evil.example' } }),
    { env: ENV, db },
  );
  assert.equal(response.status, 403);
  assert.equal(db.calls.length, 0);
});

test('invite-accept: رمز قصير/غير صالح الشكل ⇒ 400 بلا نداء قاعدة', async () => {
  const db = fakeDb();
  const response = await inviteAccept(jsonRequest('/invite-accept', { token: 'short' }), { env: ENV, db });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'INVITATION_INVALID');
  assert.equal(db.calls.length, 0);
});

test('invite-accept: حساب موقوف ⇒ 403 ACCOUNT_DISABLED وتعويض بحذف مستخدم Auth', async () => {
  const db = fakeDb({
    rpc: {
      svc_invitation_state: () => ({ data: validInvite, error: null }),
      svc_accept_invitation: () => ({
        data: null,
        error: { message: 'ACCOUNT_DISABLED', details: 'raise exception' },
      }),
    },
    auth: { createUser: () => ({ data: { id: 'new-user-id' }, error: null }) },
  });

  const response = await inviteAccept(
    jsonRequest('/invite-accept', {
      token: TOKEN,
      full_name: 'مدرس اصطناعي',
      identifier: '+201000000123',
      password: 'كلمة-قوية-9Xy',
    }),
    { env: ENV, db },
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'ACCOUNT_DISABLED');
  const deleted = db.calls.filter((call) => call.kind === 'auth' && call.name === 'deleteUser');
  assert.equal(deleted.length, 1, 'لا يُترك مستخدم Auth معلّقًا بلا ملف');
  assert.equal(deleted[0].arg, 'new-user-id');
});

test('invite-accept: خلط أدوار (دعوة مدرس لحساب طالب) ⇒ 403 ROLE_MISMATCH', async () => {
  const db = fakeDb({
    rpc: {
      svc_invitation_state: () => ({ data: validInvite, error: null }),
      svc_accept_invitation: () => ({ data: null, error: { message: 'ROLE_MISMATCH' } }),
    },
    auth: { createUser: () => ({ data: { id: 'new-user-id' }, error: null }) },
  });

  const response = await inviteAccept(
    jsonRequest('/invite-accept', {
      token: TOKEN,
      full_name: 'مدرس اصطناعي',
      identifier: '+201000000123',
      password: 'كلمة-قوية-9Xy',
    }),
    { env: ENV, db },
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'ROLE_MISMATCH');
});

test('invite-accept: الاستهلاك داخل معاملة واحدة — لا نداء svc_consume_invitation منفصلًا (F-03)', async () => {
  const db = fakeDb({
    rpc: {
      svc_invitation_state: () => ({ data: validInvite, error: null }),
      svc_accept_invitation: () => ({
        data: { kind: 'teacher_invite', teacher_id: null, profile: { user_id: 'new-user-id', role: 'teacher', status: 'active' } },
        error: null,
      }),
    },
    auth: { createUser: () => ({ data: { id: 'new-user-id' }, error: null }) },
  });

  const response = await inviteAccept(
    jsonRequest('/invite-accept', {
      token: TOKEN,
      full_name: 'مدرس اصطناعي',
      identifier: '+201000000123',
      password: 'كلمة-قوية-9Xy',
    }),
    { env: ENV, db },
  );

  assert.equal(response.status, 200);
  assert.ok(!rpcNames(db).includes('svc_consume_invitation'), 'الاستهلاك يجب أن يكون داخل svc_accept_invitation فقط');
  assert.ok(rpcNames(db).includes('svc_accept_invitation'));
});

test('invite-accept: المحاولة المرفوضة تُسجَّل في التدقيق بـ outcome=failed (F-12)', async () => {
  const db = fakeDb({
    rpc: {
      svc_invitation_state: () => ({ data: validInvite, error: null }),
      svc_accept_invitation: () => ({ data: null, error: { message: 'ACCOUNT_DISABLED' } }),
    },
    auth: { createUser: () => ({ data: { id: 'new-user-id' }, error: null }) },
  });

  await inviteAccept(
    jsonRequest('/invite-accept', {
      token: TOKEN,
      full_name: 'مدرس اصطناعي',
      identifier: '+201000000123',
      password: 'كلمة-قوية-9Xy',
    }),
    { env: ENV, db },
  );

  const rejected = auditCalls(db).filter((args) => args.p_action === 'invite.rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].p_outcome, 'failed');
  const serialized = JSON.stringify(rejected[0].p_detail ?? {});
  assert.ok(!serialized.includes('+2010'), 'التدقيق لا يحوي هاتفًا');
  assert.ok(!serialized.includes('new-user-id'), 'التدقيق لا يحوي معرّف حساب');
});

/* =====================================================================
   ٢) auth-login — رسالة موحدة، حدّ معدل عبر الدالة المكشوفة الصحيحة
   ===================================================================== */

test('auth-login: بيانات خاطئة ⇒ 401 INVALID_CREDENTIALS', async () => {
  const db = fakeDb({
    rpc: { svc_rate_limit_hit: () => ({ data: 1, error: null }) },
    auth: { signInWithPassword: () => ({ data: null, error: { status: 400 } }) },
  });

  const response = await authLogin(
    jsonRequest('/auth-login', { identifier: '+201000000123', password: 'wrong-pass-1' }),
    { env: ENV, db },
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'INVALID_CREDENTIALS');
});

test('auth-login: حدّ المعدل يُنادى باسم الدالة المكشوفة svc_rate_limit_hit (F-13)', async () => {
  const db = fakeDb({
    rpc: { svc_rate_limit_hit: () => ({ data: 1, error: null }) },
    auth: { signInWithPassword: () => ({ data: null, error: { status: 400 } }) },
  });

  await authLogin(
    jsonRequest('/auth-login', { identifier: '+201000000123', password: 'wrong-pass-1' }),
    { env: ENV, db },
  );

  const rateCalls = rateLimitCalls(db);
  assert.equal(rateCalls.length, 2, 'حدّان مستقلان: IP ثم المعرّف');
  assert.ok(
    !rpcNames(db).includes('rate_limit_hit'),
    'الاسم القديم غير مكشوف في PostgREST وكان يُنتج 404 ⇒ 502 على كل دخول',
  );
});

test('auth-login: تجاوز الحدّ ⇒ 429 قبل أي محاولة تحقق', async () => {
  const db = fakeDb({
    rpc: { svc_rate_limit_hit: () => ({ data: LIMITS['login:ip'].limit + 1, error: null }) },
    auth: { signInWithPassword: () => ({ data: { access_token: 'a.b.c' }, error: null }) },
  });

  const response = await authLogin(
    jsonRequest('/auth-login', { identifier: '+201000000123', password: 'wrong-pass-1' }),
    { env: ENV, db },
  );

  assert.equal(response.status, 429);
  assert.ok(!db.calls.some((call) => call.kind === 'auth' && call.name === 'signInWithPassword'));
});

test('auth-login: حساب موقوف ⇒ 403 ACCOUNT_DISABLED وإبطال جلسة عالمي', async () => {
  const db = fakeDb({
    rpc: {
      svc_rate_limit_hit: () => ({ data: 1, error: null }),
      svc_profile_context: () => ({
        data: { user_id: 'u-1', role: 'student', status: 'suspended', sessions_valid_after: null },
        error: null,
      }),
    },
    auth: {
      signInWithPassword: () => ({
        data: { access_token: fakeJwt({ sub: 'u-1', iat: Math.floor(Date.now() / 1000) }) },
        error: null,
      }),
      signOutGlobal: () => ({ data: {}, error: null }),
    },
  });

  const response = await authLogin(
    jsonRequest('/auth-login', { identifier: '+201000000123', password: 'good-pass-9Xy' }),
    { env: ENV, db },
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'ACCOUNT_DISABLED');
  assert.ok(db.calls.some((call) => call.kind === 'auth' && call.name === 'signOutGlobal'));
});

test('auth-login: الرد الناجح لا يحوي كلمة المرور ولا الهاتف الكامل', async () => {
  const iat = Math.floor(Date.now() / 1000);
  const db = fakeDb({
    rpc: {
      svc_rate_limit_hit: () => ({ data: 1, error: null }),
      svc_profile_context: () => ({
        data: {
          user_id: 'u-1',
          full_name: 'طالب اصطناعي',
          role: 'student',
          status: 'active',
          phone_e164: '+201000000123',
          phone_last4: '0123',
          sessions_valid_after: new Date((iat - 60) * 1000).toISOString(),
        },
        error: null,
      }),
    },
    auth: {
      signInWithPassword: () => ({
        data: { access_token: fakeJwt({ sub: 'u-1', iat }), refresh_token: 'r', expires_in: 3600 },
        error: null,
      }),
    },
  });

  const response = await authLogin(
    jsonRequest('/auth-login', { identifier: '+201000000123', password: 'good-pass-9Xy' }),
    { env: ENV, db },
  );

  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes('good-pass-9Xy'));
  assert.ok(!text.includes('+201000000123'), 'الهاتف الكامل لا يُعاد للمتصفح');
  assert.ok(text.includes('0123'));
});

test('auth-login: جلسة أقدم من آخر تغيير حساس تُرفض (دقة الثانية — F-07)', async () => {
  const iat = Math.floor(Date.now() / 1000);
  const db = fakeDb({
    rpc: {
      svc_rate_limit_hit: () => ({ data: 1, error: null }),
      svc_profile_context: () => ({
        data: {
          user_id: 'u-1',
          role: 'student',
          status: 'active',
          // آخر تغيير بعد إصدار التوكن بكسر عشري فقط: بنفس الثانية ⇒ لا يُرفض
          sessions_valid_after: new Date(iat * 1000 + 700).toISOString(),
        },
        error: null,
      }),
    },
    auth: {
      signInWithPassword: () => ({
        data: { access_token: fakeJwt({ sub: 'u-1', iat }) },
        error: null,
      }),
      signOutGlobal: () => ({ data: {}, error: null }),
    },
  });

  const response = await authLogin(
    jsonRequest('/auth-login', { identifier: '+201000000123', password: 'good-pass-9Xy' }),
    { env: ENV, db },
  );

  assert.equal(response.status, 200, 'لا يُرفض توكن صحيح بسبب كسر عشري في الثانية نفسها');
});

/* =====================================================================
   ٣) auth-recovery — الحدّ على الإكمال (F-06) ولا كشف لوجود الحساب
   ===================================================================== */

test('auth-recovery: رمز قصير ⇒ 400 بلا أي نداء قاعدة', async () => {
  const db = fakeDb();
  const response = await authRecovery(jsonRequest('/auth-recovery', { action: 'complete', token: 'x', password: 'كلمة-قوية-9Xy' }), {
    env: ENV,
    db,
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'RECOVERY_INVALID');
  assert.equal(db.calls.length, 0);
});

test('auth-recovery: الإكمال يخضع لحدّ معدل (F-06)', async () => {
  const db = fakeDb({
    rpc: { svc_rate_limit_hit: () => ({ data: LIMITS['recovery:complete'].limit + 1, error: null }) },
  });

  const response = await authRecovery(
    jsonRequest('/auth-recovery', { action: 'complete', token: TOKEN, password: 'كلمة-قوية-9Xy' }),
    { env: ENV, db },
  );

  assert.equal(response.status, 429);
  assert.equal(rateLimitCalls(db).length, 1);
  assert.ok(!rpcNames(db).includes('svc_consume_recovery'), 'الحدّ يُفحص قبل استهلاك الرمز');
});

test('auth-recovery: طلب بلا جلسة ⇒ 401 بلا كشف هدف', async () => {
  const db = fakeDb();
  const response = await authRecovery(
    jsonRequest('/auth-recovery', { action: 'request', identifier: '+201000000123', reason: 'تحقق هاتفي' }),
    { env: ENV, db },
  );
  assert.equal(response.status, 401);
  assert.equal(db.calls.length, 0);
});

test('أكواد الأخطاء المستخدمة في الدوال معرّفة وبرسائل عربية', () => {
  for (const code of ['ACCOUNT_DISABLED', 'ROLE_MISMATCH', 'INVITATION_INVALID', 'RECOVERY_INVALID', 'RATE_LIMITED']) {
    assert.ok(ERROR_SPECS[code], `الرمز ${code} غير معرّف`);
    assert.match(ERROR_SPECS[code].message, /[\u0600-\u06FF]/, `${code} بلا رسالة عربية`);
  }
  assert.equal(ERROR_SPECS.ROLE_MISMATCH.status, 403);
});

/** JWT اصطناعي غير موقّع — للقراءة فقط داخل الاختبار. */
function fakeJwt(payload) {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.signature`;
}
