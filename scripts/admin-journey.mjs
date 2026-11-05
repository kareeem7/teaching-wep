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

const json = () => ({
  'content-type': 'application/json',
  apikey: ANON,
  authorization: `Bearer ${ANON}`,
});

/** ينشئ مستخدمًا اصطناعيًا عبر واجهة الإدارة (service_role، من CI فقط) ويضبط ملفه. */
async function seedUser({ phone, password, role, fullName }) {
  const created = await call('/auth/v1/admin/users', {
    method: 'POST',
    headers: { ...json(), authorization: `Bearer ${SERVICE}` },
    body: JSON.stringify({ phone, password, phone_confirm: true }),
  });

  let userId = created.body?.id ?? created.body?.user?.id;
  if (!userId) {
    // موجود من تشغيل سابق: نبحث عنه ثم نعيد تعيين كلمة المرور.
    const list = await call('/auth/v1/admin/users?page=1&per_page=200', {
      method: 'GET',
      headers: { ...json(), authorization: `Bearer ${SERVICE}` },
    });
    const found = (list.body?.users ?? []).find((u) => u.phone === phone.replace('+', ''));
    if (!found) return { ok: false, detail: 'تعذّر إنشاء المستخدم أو العثور عليه' };
    userId = found.id;
    await call(`/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: { ...json(), authorization: `Bearer ${SERVICE}` },
      body: JSON.stringify({ password, phone_confirm: true }),
    });
  }

  const profile = await call('/rest/v1/profiles?on_conflict=user_id', {
    method: 'POST',
    headers: {
      ...json(),
      authorization: `Bearer ${SERVICE}`,
      prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify([
      { user_id: userId, full_name: fullName, role, status: 'active', phone_e164: phone },
    ]),
  });

  return { ok: Boolean(userId), userId, profileStatus: profile.status };
}

async function login(phone, password) {
  const response = await call('/functions/v1/auth-login', {
    method: 'POST',
    headers: { ...json(), origin: BASE },
    body: JSON.stringify({ identifier: phone, password }),
  });
  const token = response.body?.data?.session?.access_token ?? response.body?.session?.access_token;
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

  // ١) حسابات اصطناعية
  const admin = await seedUser({ phone: ADMIN_PHONE, password: ADMIN_PASSWORD, role: 'super_admin', fullName: 'أدمن اختبار' });
  record('تهيئة حساب السوبر أدمن', admin.ok, { user_id: admin.userId ?? null });
  const teacher = await seedUser({ phone: TEACHER_PHONE, password: TEACHER_PASSWORD, role: 'teacher', fullName: 'مدرس اختبار' });
  record('تهيئة حساب المدرس', teacher.ok, { user_id: teacher.userId ?? null });
  if (failed) return;

  // ٢) دخول السوبر أدمن عبر الدالة الحقيقية
  const adminLogin = await login(ADMIN_PHONE, ADMIN_PASSWORD);
  record('دخول السوبر أدمن', Boolean(adminLogin.token), { status: adminLogin.status });
  if (!adminLogin.token) return;

  const adminHeaders = { ...json(), origin: BASE, authorization: `Bearer ${adminLogin.token}` };

  // ٣) دعوة مدرس عبر الدالة — يجب أن تُعيد رمزًا مرة واحدة
  const invite = await call('/functions/v1/admin-teachers', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ action: 'invite', phone: TEACHER_PHONE, full_name: 'مدرس مدعو', headline: 'رياضيات' }),
  });
  const inviteToken =
    invite.body?.data?.token ?? invite.body?.token ?? invite.body?.data?.invite_token ?? null;
  record('دعوة مدرس من اللوحة', invite.status === 200 && Boolean(inviteToken), {
    status: invite.status,
    code: invite.body?.error?.code ?? null,
    has_token: Boolean(inviteToken),
  });

  // ٤) محاولة كتابة أكاديمية بحساب السوبر أدمن — يجب أن تُرفض خادميًا
  const academicWrite = await call('/rest/v1/groups', {
    method: 'POST',
    headers: { ...json(), authorization: `Bearer ${adminLogin.token}`, prefer: 'return=representation' },
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
