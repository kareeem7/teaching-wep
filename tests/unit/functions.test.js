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
        // يمرّر كل الوسائط: بعض دوال Auth تأخذ أكثر من مُدخل (مثل setBan(id, banned)).
        get: (_target, method) => (...args) => {
          calls.push({ kind: 'auth', name: String(method), arg: args[0], args });
          const fn = spec.auth?.[method];
          return Promise.resolve(fn ? fn(...args) : { data: null, error: null });
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

/* =====================================================================
   ٤) admin-teachers / admin-instructions — المرحلة ٠٣
   ===================================================================== */

import { handler as adminTeachers } from '../../supabase/functions/admin-teachers/index.js';
import { handler as adminInstructions } from '../../supabase/functions/admin-instructions/index.js';
import { sanitizeDetail, auditEvent } from '../../supabase/functions/_shared/audit.js';

const ADMIN_ID = '99999999-9999-9999-9999-999999999999';
const TEACHER_ID = '11111111-1111-1111-1111-111111111111';
const STUDENT_ID = '44444444-4444-4444-4444-444444444444';
const ADMIN_ENV = Object.freeze({ ...ENV, APP_BASE_URL: 'https://app.example.test' });

/** توكن مقبول الشكل لجلسة إدارية. */
function adminToken(userId = ADMIN_ID) {
  return fakeJwt({ sub: userId, iat: Math.floor(Date.now() / 1000), role: 'authenticated' });
}

/**
 * عميل مزيّف لدوال الإدارة: الهوية والدور من الخريطة، والقرارات من الخريطة أيضًا.
 * @param {{role?: string, status?: string, rpc?: Record<string, Function>}} [spec]
 */
function adminDb(spec = {}) {
  const role = spec.role ?? 'super_admin';
  const status = spec.status ?? 'active';
  return fakeDb({
    auth: { getUser: () => ({ data: { id: ADMIN_ID }, error: null }) },
    rpc: {
      svc_profile_context: () => ({ data: { user_id: ADMIN_ID, role, status }, error: null }),
      svc_rate_limit_hit: () => ({ data: 1, error: null }),
      svc_audit: () => ({ data: null, error: null }),
      ...spec.rpc,
    },
  });
}

function bearerRequest(path, body, token) {
  return jsonRequest(path, body, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

test('admin-teachers: طلب بلا توكن ⇒ 401 بلا أي نداء قاعدة', async () => {
  const db = adminDb();
  const response = await adminTeachers(bearerRequest('/admin-teachers', { action: 'invite' }), { env: ADMIN_ENV, db });
  assert.equal(response.status, 401);
  assert.equal(db.calls.length, 0);
});

test('admin-teachers: مدرس غير أدمن ⇒ 403 ويُدقَّق الرفض بلا أي دعوة', async () => {
  const db = adminDb({ role: 'teacher' });
  const response = await adminTeachers(
    bearerRequest('/admin-teachers', { action: 'invite', full_name: 'مدرس جديد', phone: '01000000077' }, adminToken()),
    { env: ADMIN_ENV, db },
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'FORBIDDEN');
  assert.ok(!rpcNames(db).includes('svc_admin_invite_teacher'), 'لا دعوة من غير أدمن');
  const audited = auditCalls(db);
  assert.equal(audited.length, 1);
  assert.equal(audited[0].p_outcome, 'denied');
});

test('admin-teachers: الأدمن يدعو ⇒ بصمة ٦٤ خانة ورابط يُعرض مرة واحدة', async () => {
  const db = adminDb({
    rpc: {
      svc_admin_invite_teacher: () => ({
        data: { invitation_id: 'dddddddd-0000-0000-0000-000000000011', expires_at: '2026-11-08T00:00:00Z', phone_last4: '0077' },
        error: null,
      }),
    },
  });

  const response = await adminTeachers(
    bearerRequest('/admin-teachers', { action: 'invite', full_name: 'مدرس جديد', phone: '01000000077', headline: 'رياضيات' }, adminToken()),
    { env: ADMIN_ENV, db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.match(payload.data.invite_link, /^https:\/\/app\.example\.test\/pages\/auth\/accept-invitation\.html\?token=/);
  assert.equal(payload.data.phone_last4, '0077');

  const call = db.calls.find((item) => item.kind === 'rpc' && item.name === 'svc_admin_invite_teacher');
  assert.match(call.args.p_token_hash, /^[0-9a-f]{64}$/, 'الخادم لا يرى إلا البصمة');
  assert.equal(call.args.p_phone_e164, '+201000000077');
  assert.ok(!JSON.stringify(payload.data).includes(call.args.p_token_hash), 'البصمة لا تُعاد للمتصفح');
});

test('admin-teachers: هاتف غير صالح ⇒ 400 قبل أي دعوة', async () => {
  const db = adminDb();
  const response = await adminTeachers(
    bearerRequest('/admin-teachers', { action: 'invite', full_name: 'مدرس جديد', phone: '12' }, adminToken()),
    { env: ADMIN_ENV, db },
  );
  assert.equal(response.status, 400);
  assert.ok(!rpcNames(db).includes('svc_admin_invite_teacher'));
});

test('admin-teachers: قرار SQL مرفوض يُترجم إلى رمز API صحيح', async () => {
  const forbidden = adminDb({
    rpc: { svc_admin_set_account_status: () => ({ data: null, error: { status: 400, body: { code: '42501' } } }) },
  });
  const first = await adminTeachers(
    bearerRequest('/admin-teachers', { action: 'set-status', user_id: TEACHER_ID, status: 'suspended', reason: 'مخالفة سياسة' }, adminToken()),
    { env: ADMIN_ENV, db: forbidden },
  );
  assert.equal(first.status, 403);

  const limited = adminDb({
    rpc: { svc_admin_set_account_status: () => ({ data: null, error: { status: 400, body: { code: '42900' } } }) },
  });
  const second = await adminTeachers(
    bearerRequest('/admin-teachers', { action: 'set-status', user_id: TEACHER_ID, status: 'suspended', reason: 'مخالفة سياسة' }, adminToken()),
    { env: ADMIN_ENV, db: limited },
  );
  assert.equal(second.status, 429);
});

test('admin-teachers: الإيقاف يحاول إبطال جلسات Auth ولا يُفشل الطلب عند فشله', async () => {
  const db = fakeDb({
    auth: {
      getUser: () => ({ data: { id: ADMIN_ID }, error: null }),
      signOutGlobal: () => ({ data: null, error: { status: 500, body: {} } }),
    },
    rpc: {
      svc_profile_context: () => ({ data: { user_id: ADMIN_ID, role: 'super_admin', status: 'active' }, error: null }),
      svc_rate_limit_hit: () => ({ data: 1, error: null }),
      svc_admin_set_account_status: () => ({ data: { changed: true, user_id: TEACHER_ID, status: 'suspended' }, error: null }),
    },
  });

  const response = await adminTeachers(
    bearerRequest('/admin-teachers', { action: 'set-status', user_id: TEACHER_ID, status: 'suspended', reason: 'مخالفة سياسة' }, adminToken()),
    { env: ADMIN_ENV, db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.changed, true);
  assert.equal(payload.data.revoked_auth_sessions, false, 'فشل الإبطال لا يُفشل القرار');
});

test('admin-instructions: طالب كمستلم ⇒ 400 (التحقق النهائي في SQL)', async () => {
  const db = adminDb({
    rpc: { svc_admin_send_instruction: () => ({ data: null, error: { status: 400, body: { code: '22023' } } }) },
  });

  const response = await adminInstructions(
    bearerRequest('/admin-instructions', { action: 'send', title: 'تعليم', body: 'نص تعليم واضح', audience: 'teachers', user_ids: [STUDENT_ID] }, adminToken()),
    { env: ADMIN_ENV, db },
  );

  assert.equal(response.status, 400);
  const call = db.calls.find((item) => item.kind === 'rpc' && item.name === 'svc_admin_send_instruction');
  assert.deepEqual(call.args.p_user_ids, [STUDENT_ID], 'المعرّف يُمرَّر لـSQL لترفضه');
});

test('admin-instructions: الإرسال الناجح يعيد عدد المستلمين من الخادم', async () => {
  const db = adminDb({
    rpc: {
      svc_admin_send_instruction: () => ({ data: { notification_id: 'eeeeeeee-0000-0000-0000-000000000001', recipients: 3 }, error: null }),
    },
  });

  const response = await adminInstructions(
    bearerRequest('/admin-instructions', { action: 'send', title: 'اجتماع', body: 'يرجى الحضور الخميس', audience: 'all_teachers' }, adminToken()),
    { env: ADMIN_ENV, db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.recipients, 3);
  assert.equal(rateLimitCalls(db).length, 1, 'حدّ الإرسال يُفحص قبل التنفيذ');
});

test('audit: التفصيل يُقلَّم — لا رموز ولا هواتف كاملة ولا كلمات مرور', async () => {
  const sanitized = sanitizeDetail({
    token: 'raw-token-value',
    password: 'secret-123',
    phone_e164: '+201000000123',
    phone_last4: '0123',
    student_code: 'MH123456',
    invitation_id: 'dddddddd-0000-0000-0000-000000000011',
    nested: { authorization: 'Bearer x', reason: 'مخالفة' },
  });

  assert.equal(sanitized.token, undefined);
  assert.equal(sanitized.password, undefined);
  assert.equal(sanitized.phone_e164, undefined);
  assert.equal(sanitized.student_code, undefined);
  assert.equal(sanitized.phone_last4, '0123');
  assert.equal(sanitized.nested.authorization, undefined);
  assert.equal(sanitized.nested.reason, 'مخالفة');
});

test('audit: الحدث يُرسل عبر svc_audit بلا قيمة سرية', async () => {
  const db = fakeDb({ rpc: { svc_audit: () => ({ data: null, error: null }) } });
  const result = await auditEvent(db, {
    action: 'admin.test',
    actor: ADMIN_ID,
    outcome: 'denied',
    detail: { token: 'raw', reason: 'not-super-admin' },
  });

  assert.equal(result.ok, true);
  const call = db.calls.find((item) => item.kind === 'rpc' && item.name === 'svc_audit');
  assert.equal(call.args.p_detail.token, undefined);
  assert.equal(call.args.p_detail.reason, 'not-super-admin');
  assert.equal(call.args.p_outcome, 'denied');
});

// F-39: تعذّر إبطال جلسات GoTrue (مهلة/شبكة) كان يحوّل الرفض الصحيح إلى 502
test('auth-login: فشل signOutGlobal لا يحوّل رفض الموقوف إلى 502 (F-39)', async () => {
  const db = fakeDb({
    rpc: {
      svc_rate_limit_hit: () => ({ data: 1, error: null }),
      svc_profile_context: () => ({
        data: { user_id: 'u-2', role: 'teacher', status: 'suspended', sessions_valid_after: null },
        error: null,
      }),
    },
    auth: {
      signInWithPassword: () => ({
        data: { access_token: fakeJwt({ sub: 'u-2', iat: Math.floor(Date.now() / 1000) }) },
        error: null,
      }),
      signOutGlobal: () => {
        throw new Error('upstream timeout');
      },
    },
  });

  const response = await authLogin(
    jsonRequest('/auth-login', { identifier: '+201000000124', password: 'good-pass-9Xy' }),
    { env: ENV, db },
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'ACCOUNT_DISABLED');
});

test('auth-login: فشل signOutGlobal مع حساب بلا ملف يبقى 403 لا 502 (F-39)', async () => {
  const db = fakeDb({
    rpc: {
      svc_rate_limit_hit: () => ({ data: 1, error: null }),
      svc_profile_context: () => ({ data: [], error: null }),
    },
    auth: {
      signInWithPassword: () => ({
        data: { access_token: fakeJwt({ sub: 'u-3', iat: Math.floor(Date.now() / 1000) }) },
        error: null,
      }),
      signOutGlobal: () => {
        throw new Error('network');
      },
    },
  });

  const response = await authLogin(
    jsonRequest('/auth-login', { identifier: '+201000000125', password: 'good-pass-9Xy' }),
    { env: ENV, db },
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'ACCOUNT_DISABLED');
});

test('admin-teachers: الإيقاف يحظر الحساب في GoTrue نفسه (F-42)', async () => {
  const bans = [];
  const db = fakeDb({
    auth: {
      getUser: () => ({ data: { id: ADMIN_ID }, error: null }),
      setBan: (id, banned) => {
        bans.push({ id, banned });
        return { data: {}, error: null };
      },
      signOutGlobal: () => ({ data: {}, error: null }),
    },
    rpc: {
      svc_profile_context: () => ({ data: { user_id: ADMIN_ID, role: 'super_admin', status: 'active' }, error: null }),
      svc_rate_limit_hit: () => ({ data: 1, error: null }),
      svc_admin_set_account_status: () => ({ data: { changed: true, user_id: TEACHER_ID, status: 'suspended' }, error: null }),
    },
  });

  const response = await adminTeachers(
    bearerRequest('/admin-teachers', { action: 'set-status', user_id: TEACHER_ID, status: 'suspended', reason: 'مخالفة سياسة' }, adminToken()),
    { env: ADMIN_ENV, db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.identity_banned, true);
  assert.deepEqual(bans, [{ id: TEACHER_ID, banned: true }], 'يجب حظر الحساب عند المزوّد لا الاكتفاء بإبطال الجلسات');
});

test('admin-teachers: إعادة التنشيط ترفع الحظر ولا تُبطل جلسات جديدة (F-42)', async () => {
  const bans = [];
  const db = fakeDb({
    auth: {
      getUser: () => ({ data: { id: ADMIN_ID }, error: null }),
      setBan: (id, banned) => {
        bans.push({ id, banned });
        return { data: {}, error: null };
      },
      signOutGlobal: () => {
        throw new Error('يجب ألا يُطلب إبطال الجلسات عند التنشيط');
      },
    },
    rpc: {
      svc_profile_context: () => ({ data: { user_id: ADMIN_ID, role: 'super_admin', status: 'active' }, error: null }),
      svc_rate_limit_hit: () => ({ data: 1, error: null }),
      svc_admin_set_account_status: () => ({ data: { changed: true, user_id: TEACHER_ID, status: 'active' }, error: null }),
    },
  });

  const response = await adminTeachers(
    bearerRequest('/admin-teachers', { action: 'set-status', user_id: TEACHER_ID, status: 'active', reason: 'انتهاء التحقيق' }, adminToken()),
    { env: ADMIN_ENV, db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.identity_banned, true);
  assert.deepEqual(bans, [{ id: TEACHER_ID, banned: false }]);
  assert.ok(!db.calls.some((call) => call.kind === 'auth' && call.name === 'signOutGlobal'));
});
