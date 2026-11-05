/**
 * التعليمات الداخلية — إرسال ومتابعة (المرحلة ٠٣).
 *
 * القرار الأمني: المستلمون يُحسبون داخل `app.admin_send_instruction`، لا هنا.
 * ما يفعله هذا الملف: يجمع النص والهدف، ويعرض العدد الذي أعاده الخادم —
 * فإن أعاد الخادم ٢ بينما المتصفح توقّع ٥، فالعبرة بالخادم.
 *
 * القراءة من `public.admin_instructions` (RLS: سوبر أدمن فقط) — ولا تُعرض بيانات طلاب.
 */
import { getSupabaseClient } from '../supabase-client.js';
import { selectAll, callFunction, ApiClientError } from '../api.js';
import { guardAdminPage } from '../auth-guard.js';
import { formatDateTime, qs, announce } from '../ui.js';

const AUDIENCE_LABELS = Object.freeze({
  all_teachers: 'كل المدرسين النشطين',
  teachers: 'مدرسون محددون',
});

/** @param {unknown} value */
function text(value) {
  return value === null || value === undefined ? '' : String(value);
}

async function sessionToken(client) {
  try {
    const { data } = await client.auth.getSession();
    return data?.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * يبني صفًا لتعليم مرسل: العنوان، الهدف، عدد المستلمين، كم قرأه.
 * @param {Record<string, unknown>} row
 */
export function buildInstructionRow(row) {
  const item = document.createElement('tr');
  item.dataset.notificationId = text(row.id);

  const title = document.createElement('td');
  title.textContent = text(row.title);
  item.append(title);

  const audience = document.createElement('td');
  audience.textContent = AUDIENCE_LABELS[text(row.audience)] ?? text(row.audience);
  item.append(audience);

  const counts = document.createElement('td');
  counts.className = 'tnum';
  counts.textContent = `${text(row.read_count ?? 0)} / ${text(row.recipient_count ?? 0)}`;
  item.append(counts);

  const sent = document.createElement('td');
  sent.className = 'tnum';
  sent.textContent = row.created_at ? formatDateTime(row.created_at) : '—';
  item.append(sent);

  return item;
}

/**
 * صفحة التعليمات.
 * @param {{client?: object, guard?: Function, fetchImpl?: typeof fetch}} [deps]
 */
export async function initAdminInstructionsPage(deps = {}) {
  const client = deps.client ?? getSupabaseClient();
  const guard = deps.guard ? await deps.guard() : await guardAdminPage({ client });
  if (!guard.allowed) {
    document.body.dataset.adminState = 'denied';
    return { allowed: false, reason: guard.reason };
  }
  document.body.dataset.adminState = 'ready';

  const form = qs('[data-form="send-instruction"]');
  const errorHost = qs('[data-admin-error]');
  const resultHost = qs('[data-send-result]');
  const listBody = qs('[data-instructions-body]');
  const audienceSelect = qs('[data-audience]');
  const teachersPicker = qs('[data-teachers-picker]');
  const preview = qs('[data-recipients-preview]');

  const load = async () => {
    if (errorHost) errorHost.hidden = true;
    try {
      const rows = await selectAll(client, 'admin_instructions');
      if (listBody) {
        listBody.textContent = '';
        const sorted = rows.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        if (sorted.length === 0) {
          const row = document.createElement('tr');
          const cell = document.createElement('td');
          cell.colSpan = 4;
          cell.className = 'text-muted-mh';
          cell.textContent = 'لم تُرسل تعليمات بعد.';
          row.append(cell);
          listBody.append(row);
        }
        for (const row of sorted) listBody.append(buildInstructionRow(row));
      }
      document.body.dataset.instructionsCount = String(rows.length);
      return { allowed: true, count: rows.length };
    } catch (error) {
      if (errorHost) {
        errorHost.textContent = error instanceof ApiClientError ? error.message : 'تعذّر تحميل التعليمات.';
        errorHost.hidden = false;
      }
      return { allowed: true, error: 'load-failed' };
    }
  };

  /** قائمة اختيار المدرسين من نفس العرض المحكوم بـRLS. */
  const loadPicker = async () => {
    if (!teachersPicker) return;
    try {
      const teachers = await selectAll(client, 'admin_teachers');
      teachersPicker.textContent = '';
      for (const teacher of teachers.filter((row) => text(row.status) === 'active')) {
        const option = document.createElement('option');
        option.value = text(teacher.teacher_id);
        option.textContent = text(teacher.full_name);
        teachersPicker.append(option);
      }
      document.body.dataset.eligibleTeachers = String(teachersPicker.options.length);
    } catch {
      /* الفشل هنا لا يمنع الإرسال للجميع */
    }
  };

  audienceSelect?.addEventListener('change', () => {
    if (!teachersPicker) return;
    const specific = audienceSelect.value === 'teachers';
    teachersPicker.hidden = !specific;
    teachersPicker.disabled = !specific;
  });

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const element = /** @type {HTMLFormElement} */ (event.currentTarget);
    const data = new FormData(element);
    const formError = element.querySelector('[data-form-error]');
    const button = element.querySelector('[type="submit"]');
    if (formError) formError.hidden = true;
    if (resultHost) resultHost.hidden = true;
    if (button) button.disabled = true;

    const audience = String(data.get('audience') ?? 'all_teachers');
    const selected = teachersPicker
      ? Array.from(/** @type {HTMLSelectElement} */ (teachersPicker).selectedOptions).map((option) => option.value)
      : [];

    try {
      const token = await sessionToken(client);
      const result = await callFunction('admin-instructions', {
        body: {
          action: 'send',
          title: String(data.get('title') ?? '').trim(),
          body: String(data.get('body') ?? '').trim(),
          audience,
          user_ids: audience === 'teachers' ? selected : [],
        },
        token,
        fetchImpl: deps.fetchImpl,
      });

      if (resultHost) {
        resultHost.textContent = `أُرسل التعليم إلى ${result.recipients} مستلمًا.`;
        resultHost.hidden = false;
      }
      if (preview) preview.textContent = '';
      element.reset();
      if (teachersPicker) {
        teachersPicker.hidden = true;
        teachersPicker.disabled = true;
      }
      announce('أُرسل التعليم.');
      await load();
    } catch (error) {
      if (formError) {
        formError.textContent = error instanceof ApiClientError ? error.message : 'تعذّر إرسال التعليم.';
        formError.hidden = false;
      }
    } finally {
      if (button) button.disabled = false;
    }
  });

  await loadPicker();
  return await load();
}
