#!/usr/bin/env node
/**
 * رحلة إدارة المدرس من البداية للنهاية — عبر HTTP حقيقي على بيئة الاختبار.
 *
 * هذا هو الدليل الذي تحتاجه بوابة الاعتماد في المرحلة ٠٣: لا يكفي أن تنجح الدوال
 * على مستوى SQL؛ المطلوب أن يمشي الطلب من المتصفح/الشبكة إلى الدالة إلى القاعدة.
 *
 * يُشغَّل من CI (الذي يملك شبكة) أو من جهازك. لا يطبع أي سرّ.
 *
 * متغيرات البيئة المطلوبة:
 *   TEST_SUPABASE_URL         عنوان المشروع (https://<ref>.supabase.co)
 *   TEST_SERVICE_ROLE_KEY     لإعداد الحسابات الاصطناعية فقط (لا يُطبع ولا يُرسل للمتصفح)
 *   TEST_ANON_KEY             مفتاح عام لاستدعاء الدوال كما يفعل المتصفح
 *   TEST_ADMIN_PHONE          هاتف سوبر أدمن اصطناعي (سيُنشأ إن لم يوجد)
 *   TEST_ADMIN_PASSWORD       كلمة مرور اصطناعية
 *   TEST_TEACHER_PHONE        هاتف مدرس اصطناعي (هدف الدعوة/الإيقاف)
 *   TEST_TEACHER_PASSWORD     كلمة مرور اصطناعية
 *
 * المخرجات: JSON لكل خطوة + ملخص. exit=1 عند أول فشل.
 */
import { writeFileSync } from 'node:fs';

const env = process.env;
const BASE = (env.TEST_SUPABASE_URL ?? '').replace(/\/+$/, '');
const SERVICE = env.TEST_SERVICE_ROLE_KEY ?? '';
const ANON = env.TEST_ANON_KEY ?? '';
const ADMIN_PHONE = env.TEST_ADMIN_PHONE ?? '';
const ADMIN_PASSWORD = env.TEST_ADMIN_PASSWORD ?? '';
const TEACHER_PHONE = env.TEST_TEACHER_PHONE ?? '';
const TEACHER_PASSWORD = env.TEST_TEACHER_PASSWORD ?? '';

const log = [];
let failed = false;

/** @param {string} step @param {boolean} ok @param {Record<string, unknown>} info */
function record(step, ok, info = {}) {
  const entry = { step, ok, at: new Date().toISOString(), ...info };
  log.push(entry);
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} · ${step} · ${JSON.stringify(info)}\n`);
  if (!ok) failed = true;
  return ok;
}

/** @param {string} path @param {RequestInit} init */
async function call(path, init) {
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: response.status, body };
}

// مكالمات الدوال: verify_jwt=false ⇒ لا حاجة لـapikey إطلاقًا (وأي apikey خاطئ قد يرفضها البوابة).
const json = () => ({ 'content-type': 'application/json' });

// مكالمات الإدارة (GoTrue admin / PostgREST بمفتاح الخدمة): المفتاح نفسه apikey + Bearer.
const serviceJson = () => ({
  'content-type': 'application/json',
  apikey: SERVICE,
  authorization: `Bearer ${SERVICE}`,
});

/** ينشئ مستخدمًا اصطناعيًا عبر واجهة الإدارة (service_role، من CI فقط) ويضبط ملفه. */
async function seedUser({ phone, password }) {
  const created = await call('/auth/v1/admin/users', {
    method: 'POST',
    headers: serviceJson(),
    body: JSON.stringify({ phone: phone.replace(/^\+/, ''), password, phone_confirm: true }),
  });

  const createStatus = created.status;
  const createError = created.status >= 400 ? created.body : null;
  let userId = created.body?.id ?? created.body?.user?.id;
  if (!userId) {
    // موجود من تشغيل سابق: نبحث عنه ثم نعيد تعيين كلمة المرور.
    const list = await call('/auth/v1/admin/users?page=1&per_page=200', {
      method: 'GET',
      headers: serviceJson(),
    });
    const wanted = phone.replace(/^\+/, '');
    const found = (list.body?.users ?? []).find((u) => String(u.phone ?? '').replace(/^\+/, '') === wanted);
    if (!found) {
      return {
        ok: false,
        createStatus,
        createError,
        lookupStatus: list.status,
        detail: Array.isArray(list.body?.users) ? 'المستخدم غير موجود في القائمة' : 'قائمة المستخدمين لم تُقرأ',
      };
    }
    userId = found.id;
    await call(`/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: serviceJson(),
      body: JSON.stringify({ password, phone_confirm: true }),
    });
  }

  // app.profiles غير مكشوفة عبر PostgREST (المخطط المكشوف هو public فقط).
  // فنقرأ حالة الملف عبر RPC الخدمي بدل الكتابة في مسار غير موجود.
  const context = await call('/rest/v1/rpc/svc_profile_context', {
    method: 'POST',
    headers: serviceJson(),
    body: JSON.stringify({ p_user_id: userId }),
  });
  const row = Array.isArray(context.body) ? context.body[0] : context.body;
  const hasProfile = Boolean(row?.user_id);

  return {
    ok: Boolean(userId) && hasProfile,
    userId,
    profileStatus: context.status,
    hasProfile,
    createStatus,
    createError,
  };
}

async function login(phone, password) {
  const response = await call('/functions/v1/auth-login', {
    method: 'POST',
    // بلا Origin: الخادم يسمح بالطلبات غير المتصفحية (isOriginAllowed(undefined) ⇒ true)
    headers: { ...json() },
    body: JSON.stringify({ identifier: phone, password }),
  });
  const token =
    response.body?.data?.access_token ??
    response.body?.data?.session?.access_token ??
    response.body?.session?.access_token ??
    null;
  return { status: response.status, token, body: response.body };
}

async function main() {
  const missing = Object.entries({
    TEST_SUPABASE_URL: BASE,
    TEST_SERVICE_ROLE_KEY: SERVICE,
    TEST_ANON_KEY: ANON,
    TEST_ADMIN_PHONE: ADMIN_PHONE,
    TEST_ADMIN_PASSWORD: ADMIN_PASSWORD,
    TEST_TEACHER_PHONE: TEACHER_PHONE,
    TEST_TEACHER_PASSWORD: TEACHER_PASSWORD,
  })
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    record('الإعداد', false, { missing });
    return;
  }

  // ٠) فحص أولي: هل مفتاح الخدمة والمفتاح العام يعملان أصلًا؟
  const adminProbe = await call('/auth/v1/admin/users?per_page=1', {
    method: 'GET',
    headers: serviceJson(),
  });
  record('مفتاح الخدمة يعمل (GoTrue admin)', adminProbe.status === 200, {
    status: adminProbe.status,
    code: adminProbe.body?.code ?? adminProbe.body?.error_code ?? null,
    message: typeof adminProbe.body?.msg === 'string' ? adminProbe.body.msg.slice(0, 120) : null,
    // بصمة غير حساسة: نوع المفتاح (JWT يبدأ eyJh · مفتاح جديد يبدأ sb_s) وطوله فقط
    service_kind: `${SERVICE.slice(0, 4)}…/${SERVICE.length}`,
    anon_kind: `${ANON.slice(0, 4)}…/${ANON.length}`,
  });

  const anonProbe = await call('/rest/v1/groups?select=id&limit=1', {
    method: 'GET',
    headers: { ...json(), apikey: ANON, authorization: `Bearer ${ANON}` },
  });
  record('المفتاح العام يعمل (PostgREST)', anonProbe.status === 200, {
    status: anonProbe.status,
    code: anonProbe.body?.code ?? null,
  });

  // ١) حسابات اصطناعية
  const admin = await seedUser({ phone: ADMIN_PHONE, password: ADMIN_PASSWORD, role: 'super_admin', fullName: 'أدمن اختبار' });
  record('تهيئة حساب السوبر أدمن', admin.ok, {
    user_id: admin.userId ?? null,
    has_profile: admin.hasProfile ?? false,
    create_status: admin.createStatus ?? null,
    create_error: admin.createError ?? null,
    lookup_status: admin.lookupStatus ?? null,
  });
  const teacher = await seedUser({ phone: TEACHER_PHONE, password: TEACHER_PASSWORD, role: 'teacher', fullName: 'مدرس اختبار' });
  record('تهيئة حساب المدرس', teacher.ok, {
    user_id: teacher.userId ?? null,
    has_profile: teacher.hasProfile ?? false,
  });
  if (failed) return;

  // ٢) دخول السوبر أدمن عبر الدالة الحقيقية
  const adminLogin = await login(ADMIN_PHONE, ADMIN_PASSWORD);
  record('دخول السوبر أدمن', Boolean(adminLogin.token), { status: adminLogin.status });
  if (!adminLogin.token) return;

  const adminHeaders = { ...json(), authorization: `Bearer ${adminLogin.token}` };

  // ٣) دعوة مدرس عبر الدالة — يجب أن تُعيد رمزًا مرة واحدة
  const invite = await call('/functions/v1/admin-teachers', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ action: 'invite', phone: TEACHER_PHONE, full_name: 'مدرس مدعو', headline: 'رياضيات' }),
  });
  // الدالة تُعيد رابط الدعوة كاملًا (والرمز داخله) لا الرمز وحده.
  const inviteLink = invite.body?.data?.invite_link ?? invite.body?.invite_link ?? null;
  const inviteToken =
    invite.body?.data?.token ??
    invite.body?.token ??
    invite.body?.data?.invite_token ??
    (typeof inviteLink === 'string' ? inviteLink.split('/').filter(Boolean).pop() : null);
  record('دعوة مدرس من اللوحة', invite.status === 200 && Boolean(inviteToken), {
    status: invite.status,
    code: invite.body?.error?.code ?? null,
    has_token: Boolean(inviteToken),
    invitation_id: invite.body?.data?.invitation_id ?? null,
  });

  // ٤) محاولة كتابة أكاديمية بحساب السوبر أدمن — يجب أن تُرفض خادميًا
  const academicWrite = await call('/rest/v1/groups', {
    method: 'POST',
    headers: {
      ...json(),
      apikey: ANON,
      authorization: `Bearer ${adminLogin.token}`,
      prefer: 'return=representation',
    },
    body: JSON.stringify([{ teacher_id: admin.userId, name: 'مجموعة غير مصرح بها', academic_year: '2026/2027' }]),
  });
  record('رفض الكتابة الأكاديمية بحساب الإدارة', academicWrite.status === 401 || academicWrite.status === 403, {
    status: academicWrite.status,
    code: academicWrite.body?.code ?? null,
  });

  // ٥) دخول المدرس ثم إيقافه ثم محاولة وصول
  const teacherLogin = await login(TEACHER_PHONE, TEACHER_PASSWORD);
  record('دخول المدرس', Boolean(teacherLogin.token), { status: teacherLogin.status });

  const suspend = await call('/functions/v1/admin-teachers', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      action: 'set-status',
      user_id: teacher.userId,
      status: 'suspended',
      reason: 'إيقاف اختباري من رحلة الفحص',
    }),
  });
  record('إيقاف المدرس بسبب', suspend.status === 200, { status: suspend.status });

  const afterSuspend = await login(TEACHER_PHONE, TEACHER_PASSWORD);
  record('المدرس الموقوف لا يدخل', afterSuspend.status !== 200 || !afterSuspend.token, {
    status: afterSuspend.status,
    code: afterSuspend.body?.error?.code ?? null,
  });

  // ٦) تعليمات إدارية: المستلم هو المدرس لا غيره
  const instruction = await call('/functions/v1/admin-instructions', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ action: 'send', title: 'اجتماع', body: 'نص التعليمات للاختبار', audience: 'teachers', user_ids: [teacher.userId] }),
  });
  record('إرسال تعليم لمدرس محدد', instruction.status === 200, {
    status: instruction.status,
    recipients: instruction.body?.data?.recipients ?? null,
  });
}

main()
  .catch((error) => record('استثناء غير متوقع', false, { message: String(error?.message ?? error) }))
  .finally(() => {
    const summary = { failed, steps: log.length, passed: log.filter((e) => e.ok).length };
    process.stdout.write(`\n== الملخص: ${JSON.stringify(summary)} ==\n`);
    try {
      writeFileSync('admin-journey-log.json', JSON.stringify({ summary, log }, null, 2), 'utf8');
    } catch {
      /* لا نُفشل بسبب الكتابة */
    }
    process.exitCode = failed ? 1 : 0;
  });
