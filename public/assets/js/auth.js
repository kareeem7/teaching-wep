/**
 * واجهة المصادقة: دخول، دعوة، استعادة، وخروج.
 *
 * مبادئ:
 *  ١. الدخول يمرّ عبر Edge Function (`auth-login`) لا مباشرة إلى Auth، لتوحيد الحدّ والتدقيق.
 *  ٢. لا تُحفظ كلمة المرور في أي مكان: تُرسل مرة وتُمحى من الحقل.
 *  ٣. الرسائل لا تفرّق بين «حساب غير موجود» و«كلمة خطأ».
 *  ٤. ما يظهر هنا ليس حماية: الصلاحيات في RLS.
 */
import { callFunction, looksFilled, queryParam, readForm, setBusy, showFormError } from './api.js';
import { getSupabaseClient, getSupabaseStatus } from './supabase-client.js';

/** الحد الأدنى للعرض فقط (الخادم يفرض السياسة الكاملة). */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * نتيجة الدخول تُخزَّن جلسةً في عميل Supabase (persistSession) — لا في متغيّر عام.
 * @param {{access_token: string, refresh_token?: string|null}} session
 */
export async function applySession(session) {
  const client = getSupabaseClient();
  if (!client) return { stored: false, reason: 'unconfigured' };
  const { error } = await client.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token ?? '',
  });
  if (error) return { stored: false, reason: 'set-session-failed' };
  return { stored: true, reason: null };
}

/** يجلب الجلسة الحالية إن وُجدت. */
export async function currentSession() {
  const status = getSupabaseStatus();
  if (!status.ready) return null;
  const client = getSupabaseClient();
  if (!client) return null;
  const { data, error } = await client.auth.getSession();
  if (error || !data?.session) return null;
  return {
    userId: data.session.user?.id ?? null,
    token: data.session.access_token ?? null,
  };
}

export async function signOut() {
  const client = getSupabaseClient();
  if (client) await client.auth.signOut();
  globalThis.sessionStorage?.clear();
}

/**
 * ينفّذ الدخول عبر الدالة.
 * @param {{identifier: string, password: string, call?: typeof callFunction}} input
 */
export async function login(input) {
  const call = input.call ?? callFunction;
  const data = await call('auth-login', {
    body: { identifier: input.identifier, password: input.password },
  });
  const stored = await applySession({
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? null,
  });
  return { ...data, sessionStored: stored.stored };
}

/** يقبل دعوة (مدرس أو ربط طالب). */
export async function acceptInvitation({ token, fullName, identifier, password, sessionToken = null, call = callFunction }) {
  return call('invite-accept', {
    token: sessionToken,
    body: { token, full_name: fullName, identifier, password },
  });
}

/** يكمل الاستعادة برمز صالح. */
export async function completeRecovery({ token, password, call = callFunction }) {
  return call('auth-recovery', { body: { action: 'complete', token, password } });
}

/** يطلب استعادة (مدرس داخل مساحته). */
export async function requestRecovery({ identifier, reason, token, call = callFunction }) {
  return call('auth-recovery', { token, body: { action: 'request', identifier, reason } });
}

/* ------------------------------ تهيئة الصفحات ------------------------------ */

/** صفحة الدخول. */
export function initLoginPage(deps = {}) {
  const doc = globalThis.document;
  const form = doc.querySelector('[data-form="login"]');
  const errorBox = doc.querySelector('[data-form-error]');
  const submit = doc.querySelector('[data-action="login"]');
  if (!form || !submit) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showFormError(errorBox, null);
    const values = readForm(form);

    if (!looksFilled(values.identifier, 3)) {
      showFormError(errorBox, 'أدخل رقم الهاتف أو كود الطالب.');
      return;
    }
    if (!looksFilled(values.password, 1)) {
      showFormError(errorBox, 'أدخل كلمة المرور.');
      return;
    }

    setBusy(submit, true, 'جارٍ الدخول…');
    try {
      const result = await (deps.login ?? login)({
        identifier: values.identifier,
        password: values.password,
      });
      form.reset();
      const next = queryParam('next') ?? 'select-workspace.html';
      globalThis.location.assign(next);
      return result;
    } catch (error) {
      showFormError(errorBox, error?.message ?? 'تعذّر الدخول.');
      return null;
    } finally {
      setBusy(submit, false);
    }
  });
}

/** صفحة قبول الدعوة. */
export function initAcceptInvitationPage(deps = {}) {
  const doc = globalThis.document;
  const form = doc.querySelector('[data-form="accept-invitation"]');
  const errorBox = doc.querySelector('[data-form-error]');
  const statusBox = doc.querySelector('[data-invite-status]');
  const submit = doc.querySelector('[data-action="accept-invitation"]');
  const token = queryParam('token');

  if (!form || !submit) return;
  if (!token) {
    showFormError(errorBox, 'الرابط لا يحتوي رمز دعوة. اطلب رابطًا جديدًا من الإدارة.');
    submit.disabled = true;
    return;
  }
  if (statusBox) statusBox.textContent = 'الرمز موجود في الرابط وسيُتحقق منه عند الإرسال.';

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showFormError(errorBox, null);
    const values = readForm(form);

    if (!looksFilled(values.full_name, 2)) {
      showFormError(errorBox, 'اكتب الاسم كما تريده أن يظهر.');
      return;
    }
    if (!looksFilled(values.identifier, 3)) {
      showFormError(errorBox, 'أدخل رقم الهاتف أو الكود الذي ستستخدمه للدخول.');
      return;
    }
    if (values.password !== values.password_confirm) {
      showFormError(errorBox, 'كلمتا المرور غير متطابقتين.');
      return;
    }
    if (values.password.length < MIN_PASSWORD_LENGTH) {
      showFormError(errorBox, `كلمة المرور يجب أن تكون ${MIN_PASSWORD_LENGTH} محارف على الأقل.`);
      return;
    }

    setBusy(submit, true, 'جارٍ التفعيل…');
    try {
      const result = await (deps.accept ?? acceptInvitation)({
        token,
        fullName: values.full_name,
        identifier: values.identifier,
        password: values.password,
      });
      form.reset();
      if (statusBox) statusBox.textContent = 'تم التفعيل. يمكنك الدخول الآن.';
      showFormError(errorBox, null);
      return result;
    } catch (error) {
      showFormError(errorBox, error?.message ?? 'تعذّر قبول الدعوة.');
      return null;
    } finally {
      setBusy(submit, false);
    }
  });
}

/** صفحة طلب الاستعادة (مدرس). */
export async function initRequestRecoveryPage(deps = {}) {
  const doc = globalThis.document;
  const form = doc.querySelector('[data-form="request-recovery"]');
  const errorBox = doc.querySelector('[data-form-error]');
  const resultBox = doc.querySelector('[data-recovery-result]');
  const submit = doc.querySelector('[data-action="request-recovery"]');
  if (!form || !submit) return;

  const session = await (deps.currentSession ?? currentSession)();
  if (!session?.token) {
    showFormError(errorBox, 'هذه الصفحة للمدرس. سجّل الدخول أولًا ثم أعد المحاولة.');
    submit.disabled = true;
    return;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showFormError(errorBox, null);
    const values = readForm(form);

    if (!looksFilled(values.identifier, 3)) {
      showFormError(errorBox, 'أدخل كود الطالب أو هاتفه.');
      return;
    }
    if (!looksFilled(values.reason, 5)) {
      showFormError(errorBox, 'اكتب سبب الاستعادة (٥ محارف على الأقل) — يُسجَّل في التدقيق.');
      return;
    }

    setBusy(submit, true, 'جارٍ إصدار الرمز…');
    try {
      const data = await (deps.request ?? requestRecovery)({
        identifier: values.identifier,
        reason: values.reason,
        token: session.token,
      });
      form.reset();
      if (resultBox) {
        resultBox.textContent = `الرمز صالح حتى ${data.expires_at}. سلّمه للطالب مرة واحدة.`;
        resultBox.hidden = false;
      }
      return data;
    } catch (error) {
      showFormError(errorBox, error?.message ?? 'تعذّر إصدار رمز الاستعادة.');
      return null;
    } finally {
      setBusy(submit, false);
    }
  });
}

/** صفحة تعيين كلمة مرور جديدة برمز استعادة. */
export function initResetPasswordPage(deps = {}) {
  const doc = globalThis.document;
  const form = doc.querySelector('[data-form="reset-password"]');
  const errorBox = doc.querySelector('[data-form-error]');
  const statusBox = doc.querySelector('[data-status]');
  const submit = doc.querySelector('[data-action="reset-password"]');
  const token = queryParam('token');

  if (!form || !submit) return;
  if (!token) {
    showFormError(errorBox, 'الرابط لا يحتوي رمز استعادة صالحًا. اطلب رمزًا جديدًا من مدرسك.');
    submit.disabled = true;
    return;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showFormError(errorBox, null);
    const values = readForm(form);

    if (values.password !== values.password_confirm) {
      showFormError(errorBox, 'كلمتا المرور غير متطابقتين.');
      return;
    }
    if (values.password.length < MIN_PASSWORD_LENGTH) {
      showFormError(errorBox, `كلمة المرور يجب أن تكون ${MIN_PASSWORD_LENGTH} محارف على الأقل.`);
      return;
    }

    setBusy(submit, true, 'جارٍ الحفظ…');
    try {
      await (deps.complete ?? completeRecovery)({ token, password: values.password });
      form.reset();
      if (statusBox) {
        statusBox.textContent = 'تم تغيير كلمة المرور وإنهاء كل الجلسات القديمة. سجّل الدخول من جديد.';
      }
    } catch (error) {
      showFormError(errorBox, error?.message ?? 'تعذّر تغيير كلمة المرور.');
    } finally {
      setBusy(submit, false);
    }
  });
}
