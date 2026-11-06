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

/** خطوة لم تُنفَّذ لعدم تحقق شرطها — تُحسب «متخطاة» لا ناجحة ولا فاشلة. */
function skip(step, reason) {
  log.push({ step, skipped: true, at: new Date().toISOString(), reason });
  process.stdout.write(`SKIP · ${step} · ${reason}\n`);
}

/** ملاحظة تشخيصية لا تُفشل الرحلة (معلومات بيئة، لا معيار قبول). */
function note(step, info = {}) {
  log.push({ step, ok: true, note: true, at: new Date().toISOString(), ...info });
  process.stdout.write(`NOTE · ${step} · ${JSON.stringify(info)}\n`);
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
  return {
    status: response.status,
    body,
    // F-43: بصمة كود الدالة المنشورة — تكشف النشر القديم بلا وصول إلى السجلات.
    build: response.headers.get('x-function-build'),
  };
}

/** الدوال الست المنشورة — تُفحص بصمتها كلها لأن النشر قد ينجح جزئيًا. */
const FUNCTIONS = ['auth-login', 'admin-teachers', 'admin-instructions', 'invite-accept', 'auth-recovery', 'workspace-select'];

/** يقرأ بصمة البناء من رد أي دالة (الرد نفسه قد يكون 400/401 ولا يهم). */
async function probeBuilds() {
  const found = {};
  for (const name of FUNCTIONS) {
    const response = await call(`/functions/v1/${name}`, {
      method: 'POST',
      headers: json(),
      body: '{}',
    });
    found[name] = response.build ?? response.body?.build ?? null;
  }
  return found;
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

  // ٠) فحص أولي (ملاحظات بيئة، لا معايير قبول)
  const adminProbe = await call('/auth/v1/admin/users?per_page=1', { method: 'GET', headers: serviceJson() });
  note('حالة مفتاح الخدمة مع GoTrue', {
    status: adminProbe.status,
    code: adminProbe.body?.code ?? adminProbe.body?.error_code ?? null,
    service_kind: `${SERVICE.slice(0, 4)}…/${SERVICE.length}`,
    anon_kind: `${ANON.slice(0, 4)}…/${ANON.length}`,
  });
  const anonProbe = await call('/rest/v1/groups?select=id&limit=1', { method: 'GET', headers: { ...json(), apikey: ANON } });
  note('حالة المفتاح العام مع PostgREST', { status: anonProbe.status, code: anonProbe.body?.code ?? null });

  // ١.٥) بصمة كود الدوال المنشورة: النشر القديم يجعل كل نتيجة لاحقة بلا معنى (F-43)
  const expectedBuild = String(env.EXPECTED_BUILD ?? '').trim().toLowerCase().slice(0, 12);
  const builds = await probeBuilds();
  const buildValues = Object.values(builds);
  const uniqueBuilds = Array.from(new Set(buildValues.filter(Boolean)));
  if (expectedBuild) {
    const allMatch = buildValues.every((value) => typeof value === 'string' && value.toLowerCase().startsWith(expectedBuild));
    record('بصمة كود الدوال المنشور', allMatch, { expected: expectedBuild, builds });
  } else if (uniqueBuilds.length === 1) {
    note('بصمة كود الدوال المنشور', { build: uniqueBuilds[0] });
  } else if (uniqueBuilds.length === 0) {
    // تشغيل محلي على خادم وهمي: لا بصمة أصلًا — ملاحظة لا فشل.
    note('بصمة كود الدوال المنشور', { builds, reason: 'لا ترويسة بصمة (تشغيل محلي)' });
  } else {
    record('بصمة كود الدوال المنشور', false, { builds, distinct: uniqueBuilds, reason: 'بصمات مختلفة بين الدوال' });
  }

  // ١.٦) تصفير عدّادات الحد: فحص متكرر يستهلك حدّ الدخول فيفشل بـ429 بلا عيب (F-45).
  // الأداة service_role فقط (مهاجرة 0010) ولا تُستخدم في أي مسار مستخدم.
  const resetLimits = await call('/rest/v1/rpc/svc_rate_limit_reset', {
    method: 'POST',
    headers: serviceJson(),
    body: JSON.stringify({ p_prefix: null }),
  });
  record('تصفير عدّادات الحد قبل الرحلة', resetLimits.status === 200, {
    status: resetLimits.status,
    cleared: resetLimits.body ?? null,
    code: resetLimits.body?.code ?? null,
  });

  // ١) حسابات اصطناعية
  const admin = await seedUser({ phone: ADMIN_PHONE, password: ADMIN_PASSWORD });
  record('تهيئة حساب السوبر أدمن', admin.ok, {
    user_id: admin.userId ?? null,
    has_profile: admin.hasProfile ?? false,
    create_status: admin.createStatus ?? null,
    lookup_status: admin.lookupStatus ?? null,
  });
  const teacher = await seedUser({ phone: TEACHER_PHONE, password: TEACHER_PASSWORD });
  record('تهيئة حساب المدرس', teacher.ok, {
    user_id: teacher.userId ?? null,
    has_profile: teacher.hasProfile ?? false,
  });
  if (!admin.ok || !teacher.ok) {
    skip('بقية الرحلة', 'تهيئة الحسابات لم تكتمل');
    return;
  }

  // ٢) دخول السوبر أدمن عبر الدالة الحقيقية
  const adminLogin = await login(ADMIN_PHONE, ADMIN_PASSWORD);
  const canAdmin = record('دخول السوبر أدمن', Boolean(adminLogin.token), {
    status: adminLogin.status,
    code: adminLogin.body?.code ?? adminLogin.body?.error?.code ?? null,
  });

// PostgREST في هذه البيئة يرفض المفتاح `sb_publishable_…` (ليس JWT) بـ401 قبل
// أن يصل أي منح. الدور الحقيقي يأتي من Authorization، فنجرّب مفتاح المتصفح أولًا
// (وهو الصحيح منتجًا)، وإن رُفض نُسجّل ذلك صراحةً ونستخدم مفتاح خدمة كـapikey
// مع إبقاء توكن المستخدم — الدور يبقى `authenticated` والمنح تُختبر كما هي.
async function browserProbeWithFallback(token, path) {
  const first = await call(path, {
    method: 'GET',
    headers: { apikey: ANON, authorization: `Bearer ${token}` },
  });
  if (first.status !== 401) return { status: first.status, key: 'anon' };
  const second = await call(path, {
    method: 'GET',
    headers: { apikey: SERVICE, authorization: `Bearer ${token}` },
  });
  return { status: second.status, key: 'service-as-apikey', anonStatus: first.status };
}

  const adminHeaders = { ...json(), authorization: `Bearer ${adminLogin.token}` };

  // ٢.٥) قراءة عروض الإدارة كما يفعل المتصفح: جلسة الأدمن + المفتاح العام.
  // هذا هو المسار الذي كشف D-03-A: الرحلة كانت تقرأ بمفتاح الخدمة فتتجاوز منح
  // `authenticated` وتُخفي رفض 42501 على قائمة الدعوات.
  if (!canAdmin) {
    skip('قراءة عروض الإدارة بجلسة المتصفح', 'لا توكن سوبر أدمن');
  } else {
    const views = ['admin_teachers', 'admin_invitations', 'admin_audit_log', 'admin_overview'];
    const statuses = {};
    const keysUsed = new Set();
    for (const view of views) {
      const probe = await browserProbeWithFallback(adminLogin.token, `/rest/v1/${view}?select=*&limit=1`);
      statuses[view] = probe.status;
      keysUsed.add(probe.key);
      if (probe.anonStatus) statuses[`${view}__anon`] = probe.anonStatus;
    }
    if (keysUsed.has('service-as-apikey')) {
      note(
        'مفتاح المتصفح publishable على PostgREST',
        'TEST_ANON_KEY يحمل مفتاحًا بصيغة sb_publishable_… يرد 401 على PostgREST؛ ' +
          'ثبت القراءة بمفتاح خدمة كـapikey مع توكن المستخدم (الدور authenticated كما هو). ' +
          'المطلوب: ضبط TEST_ANON_KEY على المفتاح anon بصيغة JWT.'
      );
    }
    const allReadable = views.every((view) => statuses[view] === 200);
    record('قراءة عروض الإدارة بجلسة المتصفح', allReadable, { statuses });
  }

  // ٣) دورة دعوة كاملة: دعوة هاتف جديد ثم قبولها ثم دخول صاحبها
  const freshPhone = `+201${String(Date.now()).slice(-8)}`;
  let inviteToken = null;
  if (!canAdmin) {
    skip('دعوة مدرس جديد', 'لا توكن سوبر أدمن');
  } else {
    const invite = await call('/functions/v1/admin-teachers', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ action: 'invite', phone: freshPhone, full_name: 'مدرس مدعو', headline: 'رياضيات' }),
    });
    const inviteLink = invite.body?.data?.invite_link ?? null;
    // الرابط على صيغة <base>/pages/auth/accept-invitation.html?token=…
    // فآخر مقطع من المسار هو اسم الصفحة لا الرمز — الرمز في معامل الاستعلام.
    inviteToken = null;
    if (inviteLink) {
      try {
        inviteToken = new URL(inviteLink).searchParams.get('token');
      } catch {
        inviteToken = null;
      }
      if (!inviteToken) {
        const match = /[?&]token=([^&#]+)/.exec(inviteLink);
        inviteToken = match ? decodeURIComponent(match[1]) : null;
      }
    }
    record('دعوة مدرس من اللوحة', invite.status === 200 && Boolean(inviteToken), {
      status: invite.status,
      code: invite.body?.code ?? invite.body?.error?.code ?? null,
      invitation_id: invite.body?.data?.invitation_id ?? null,
      view_link: invite.body?.error?.code === 'FORBIDDEN' ? 'لا صلاحية' : undefined,
          message: invite.body?.message ?? null,
      details: invite.body?.details ?? null,
    });
  }

  // ٤) قبول الدعوة: إنشاء الحساب من الرابط نفسه
  if (!inviteToken) {
    skip('قبول الدعوة وإنشاء الحساب', 'لا رمز دعوة');
  } else {
    const accept = await call('/functions/v1/invite-accept', {
      method: 'POST',
      headers: json(),
      body: JSON.stringify({
        token: inviteToken,
        full_name: 'مدرس مدعو',
        password: TEACHER_PASSWORD,
        identifier: freshPhone,
      }),
    });
    record('قبول الدعوة وإنشاء الحساب', accept.status === 200, {
      status: accept.status,
      code: accept.body?.code ?? accept.body?.error?.code ?? null,
      role: accept.body?.data?.profile?.role ?? null,
          message: accept.body?.message ?? null,
      details: accept.body?.details ?? null,
    });

    const freshLogin = await login(freshPhone, TEACHER_PASSWORD);
    record('دخول المدرس الجديد بعد قبول الدعوة', Boolean(freshLogin.token), {
      status: freshLogin.status,
      code: freshLogin.body?.error?.code ?? null,
    });
  }

  // ٥) محاولة كتابة أكاديمية بحساب السوبر أدمن — يجب أن تُرفض خادميًا
  if (!canAdmin) {
    skip('رفض الكتابة الأكاديمية', 'لا توكن سوبر أدمن');
  } else {
    const academicWrite = await call('/rest/v1/groups', {
      method: 'POST',
      headers: { ...json(), apikey: SERVICE, authorization: `Bearer ${adminLogin.token}`, prefer: 'return=representation' },
      body: JSON.stringify([{ teacher_id: admin.userId, name: 'مجموعة غير مصرح بها', academic_year: '2026/2027' }]),
    });
    record('رفض الكتابة الأكاديمية بحساب الإدارة', academicWrite.status === 403 || academicWrite.status === 401, {
      status: academicWrite.status,
      code: academicWrite.body?.code ?? null,
    });
  }

  // ٦) تهيئة حالة المدرس: الرحلة حالة تراكمية — تشغيل سابق قد ترك المدرس موقوفًا،
  // فيفشل الإرسال التعليمي (لا مستقبلين نشطين) ويصير «منع الدخول» بلا معنى (F-41).
  const setStatus = (status, reason) =>
    call('/functions/v1/admin-teachers', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ action: 'set-status', user_id: teacher.userId, status, reason }),
    });

  let teacherActive = false;
  if (!canAdmin) {
    skip('تهيئة المدرس نشطًا', 'لا توكن سوبر أدمن');
  } else {
    const activate = await setStatus('active', 'تهيئة رحلة الفحص — إعادة تنشيط المدرس');
    teacherActive = activate.status === 200;
    record('تهيئة المدرس نشطًا', teacherActive, {
      status: activate.status,
      code: activate.body?.code ?? activate.body?.error?.code ?? null,
      changed: activate.body?.data?.changed ?? null,
      message: activate.body?.message ?? null,
      details: activate.body?.details ?? null,
    });
  }

  // ٧) دخول المدرس النشط
  const teacherLogin = await login(TEACHER_PHONE, TEACHER_PASSWORD);
  record('دخول المدرس', Boolean(teacherLogin.token), {
    status: teacherLogin.status,
    code: teacherLogin.body?.code ?? teacherLogin.body?.error?.code ?? null,
    message: teacherLogin.body?.message ?? null,
    details: teacherLogin.body?.details ?? null,
  });

  // ٨) تعليمات إدارية للمدرس المحدد — قبل الإيقاف، لأن المستقبلين مدرسون نشطون فقط
  if (!canAdmin || !teacherActive) {
    skip('إرسال تعليم لمدرس محدد', canAdmin ? 'المدرس غير نشط' : 'لا توكن سوبر أدمن');
  } else {
    const instruction = await call('/functions/v1/admin-instructions', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        action: 'send',
        title: 'اجتماع',
        body: 'نص التعليمات للاختبار',
        audience: 'teachers',
        user_ids: [teacher.userId],
      }),
    });
    record('إرسال تعليم لمدرس محدد', instruction.status === 200, {
      status: instruction.status,
      code: instruction.body?.code ?? instruction.body?.error?.code ?? null,
      recipients: instruction.body?.data?.recipients ?? null,
      message: instruction.body?.message ?? null,
      details: instruction.body?.details ?? null,
    });
  }

  // ٨.٥) صندوق التنبيهات من طرف المستلم (D-03-B): قراءة، تعليم مقروء، ورفض تنبيه غيره
  if (!teacherLogin.token) {
    skip('صندوق تنبيهات المدرس', 'لا توكن مدرس');
  } else {
    // نفس قاعدة المفتاح: نجرب مفتاح المتصفح، وإن رُفض بـ401 نستخدم مفتاح خدمة
    // كـapikey مع إبقاء توكن المدرس (الدور authenticated من التوكن).
    let inbox = await call('/rest/v1/my_notifications?select=id,title,read_at', {
      method: 'GET',
      headers: { apikey: ANON, authorization: `Bearer ${teacherLogin.token}` },
    });
    const teacherHeaders = { apikey: ANON, authorization: `Bearer ${teacherLogin.token}` };
    if (inbox.status === 401) {
      teacherHeaders.apikey = SERVICE;
      inbox = await call('/rest/v1/my_notifications?select=id,title,read_at', { method: 'GET', headers: teacherHeaders });
    }
    const items = Array.isArray(inbox.body) ? inbox.body : [];
    record('صندوق تنبيهات المدرس (قراءة)', inbox.status === 200 && items.length > 0, {
      status: inbox.status,
      count: items.length,
    });

    const target = items.find((item) => !item.read_at) ?? items[0];
    if (!target?.id) {
      skip('تعليم التنبيه كمقروء', 'لا تنبيهات');
      skip('رفض تعليم تنبيه غير المستلم', 'لا تنبيهات');
    } else {
      const marked = await call('/rest/v1/rpc/notify_mark_read', {
        method: 'POST',
        headers: teacherHeaders,
        body: JSON.stringify({ p_notification_id: target.id }),
      });
      const readAt = marked.body?.read_at ?? null;
      record('تعليم التنبيه كمقروء', marked.status === 200 && Boolean(readAt), {
        status: marked.status,
        changed: marked.body?.changed ?? null,
        code: marked.body?.code ?? null,
        message: marked.body?.message ?? null,
        hint: marked.body?.hint ?? null,
      });

      // تنبيه لم يوجَّه لهذا المدرس: يجب أن يُرفض (42501) لا أن يُقبل بصمت
      const foreign = await call('/rest/v1/rpc/notify_mark_read', {
        method: 'POST',
        headers: teacherHeaders,
        body: JSON.stringify({ p_notification_id: '00000000-0000-4000-8000-0000000000ff' }),
      });
      record('رفض تعليم تنبيه غير المستلم', foreign.status === 403 || foreign.status === 404, {
        status: foreign.status,
        code: foreign.body?.code ?? null,
        message: foreign.body?.message ?? null,
      });
    }
  }

  // ٩) الإيقاف ثم منع الدخول ثم إعادة الحالة — آخر خطوة، وتبقى البيئة نظيفة بعدها
  if (!canAdmin || !teacherActive) {
    skip('إيقاف المدرس بسبب', 'المدرس غير نشط');
    skip('منع دخول المدرس الموقوف', 'لم يُوقَف');
    skip('استعادة المدرس بعد الفحص', 'لم يُوقَف');
  } else {
    const suspend = await setStatus('suspended', 'إيقاف اختباري من رحلة الفحص');
    record('إيقاف المدرس بسبب', suspend.status === 200, {
      status: suspend.status,
      code: suspend.body?.code ?? suspend.body?.error?.code ?? null,
      changed: suspend.body?.data?.changed ?? null,
      identity_banned: suspend.body?.data?.identity_banned ?? null,
      revoked_auth_sessions: suspend.body?.data?.revoked_auth_sessions ?? null,
      message: suspend.body?.message ?? null,
      details: suspend.body?.details ?? null,
    });

    const afterSuspend = await login(TEACHER_PHONE, TEACHER_PASSWORD);
    // الفشل التقني (502/500) ليس دليل منع: يجب أن يكون الرد رفضًا صريحًا
    // (403 ACCOUNT_DISABLED أو 401 من المزوّد) بلا توكن. العدّ لكل ما ليس 200
    // كان يخفي عيبًا حقيقيًا في المنع (F-41).
    const blocked = (afterSuspend.status === 401 || afterSuspend.status === 403) && !afterSuspend.token;
    record('منع دخول المدرس الموقوف', blocked, {
      status: afterSuspend.status,
      code: afterSuspend.body?.code ?? afterSuspend.body?.error?.code ?? null,
      message: afterSuspend.body?.message ?? null,
      details: afterSuspend.body?.details ?? null,
    });

    const restore = await setStatus('active', 'انتهاء رحلة الفحص — إعادة المدرس نشطًا');
    const restored = restore.status === 200;
    record('استعادة المدرس بعد الفحص', restored, {
      status: restore.status,
      changed: restore.body?.data?.changed ?? null,
      message: restore.body?.message ?? null,
    });
    if (restored) {
      const afterRestore = await login(TEACHER_PHONE, TEACHER_PASSWORD);
      record('دخول المدرس بعد الاستعادة', Boolean(afterRestore.token), {
        status: afterRestore.status,
        code: afterRestore.body?.code ?? afterRestore.body?.error?.code ?? null,
        message: afterRestore.body?.message ?? null,
        details: afterRestore.body?.details ?? null,
      });
    }
  }
}
main()
  .catch((error) => record('استثناء غير متوقع', false, { message: String(error?.message ?? error) }))
  .finally(() => {
    const summary = {
      failed,
      steps: log.length,
      passed: log.filter((e) => e.ok && !e.note && !e.skipped).length,
      skipped: log.filter((e) => e.skipped).length,
      notes: log.filter((e) => e.note).length,
    };
    process.stdout.write(`\n== الملخص: ${JSON.stringify(summary)} ==\n`);
    try {
      writeFileSync('admin-journey-log.json', JSON.stringify({ summary, log }, null, 2), 'utf8');
    } catch {
      /* لا نُفشل بسبب الكتابة */
    }
    process.exitCode = failed ? 1 : 0;
  });
