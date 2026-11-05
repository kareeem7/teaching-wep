/**
 * إدارة المدرسين — القائمة وملف المدرس (المرحلة ٠٣).
 *
 * الحدود:
 *   • القراءة من عروض RLS (`admin_teachers`, `admin_invitations`, `admin_students`,
 *     `admin_account_events`). غير الإدارة يحصل على صفر صفوف من الخادم.
 *   • الكتابة عبر `admin-teachers` (Edge Function) التي تتحقق من الدور في SQL.
 *   • لا حقل أكاديمي قابل للتعديل هنا: الحضور والدرجات والمجموعات ليست في هذه الصفحة أصلًا.
 *
 * التصفية والترقيم في المتصفح: عرض فقط، لا صلاحية. القائمة كاملة أصلًا من الخادم
 * ومحكومة بـRLS، والمقياس المستهدف عشرات المدرسين لا آلاف.
 */
import { getSupabaseClient } from '../supabase-client.js';
import { selectAll, callFunction, ApiClientError } from '../api.js';
import { guardAdminPage } from '../auth-guard.js';
import { formatDateTime, qs, announce } from '../ui.js';

export const PAGE_SIZE = 10;

const STATUS_LABELS = Object.freeze({
  active: 'نشط',
  suspended: 'موقوف',
  pending: 'بانتظار التفعيل',
  archived: 'مؤرشف',
});

const STATE_LABELS = Object.freeze({
  pending: 'سارية',
  expired: 'منتهية',
  revoked: 'ملغاة',
  used: 'مستخدمة',
});

/** @param {unknown} value */
function text(value) {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * تصفية صفوف المدرسين — دالة نقية قابلة للاختبار.
 * @param {Array<Record<string, unknown>>} rows
 * @param {{q?: string, status?: string}} filters
 */
export function filterTeachers(rows, filters = {}) {
  const query = text(filters.q).trim().toLowerCase();
  const status = text(filters.status).trim();
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (status && text(row.status) !== status) return false;
    if (!query) return true;
    const haystack = [text(row.full_name), text(row.phone_last4), text(row.headline)].join(' ').toLowerCase();
    return haystack.includes(query);
  });
}

/**
 * تقطيع الصفحات — يعيد الصفحة الحالية مع حدودها.
 * @param {Array<unknown>} rows
 * @param {number} page يبدأ من ١
 * @param {number} [size]
 */
export function paginate(rows, page = 1, size = PAGE_SIZE) {
  const all = Array.isArray(rows) ? rows : [];
  const perPage = Math.max(1, Number(size) || PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (current - 1) * perPage;
  return {
    page: current,
    totalPages,
    totalRows: all.length,
    rows: all.slice(start, start + perPage),
    from: all.length === 0 ? 0 : start + 1,
    to: Math.min(start + perPage, all.length),
  };
}

/** شارة حالة الحساب. */
function statusBadge(status) {
  const badge = document.createElement('span');
  badge.className = `badge ${status === 'active' ? 'text-bg-success' : status === 'suspended' ? 'text-bg-danger' : 'text-bg-secondary'}`;
  badge.dataset.status = text(status);
  badge.textContent = STATUS_LABELS[text(status)] ?? text(status);
  return badge;
}

/**
 * صف جدول مدرس واحد.
 * @param {Record<string, unknown>} teacher
 */
export function buildTeacherRow(teacher) {
  const row = document.createElement('tr');
  row.dataset.teacherId = text(teacher.teacher_id);
  row.dataset.status = text(teacher.status);

  const nameCell = document.createElement('td');
  const link = document.createElement('a');
  link.href = `teacher-detail.html?id=${encodeURIComponent(text(teacher.teacher_id))}`;
  link.textContent = text(teacher.full_name) || 'بدون اسم';
  link.dataset.action = 'open-teacher';
  nameCell.append(link);
  row.append(nameCell);

  const statusCell = document.createElement('td');
  statusCell.append(statusBadge(teacher.status));
  row.append(statusCell);

  const phoneCell = document.createElement('td');
  phoneCell.className = 'tnum';
  phoneCell.textContent = teacher.phone_last4 ? `…${text(teacher.phone_last4)}` : '—';
  row.append(phoneCell);

  const countsCell = document.createElement('td');
  countsCell.className = 'tnum';
  countsCell.textContent = `${text(teacher.students_count ?? 0)} / ${text(teacher.groups_active ?? 0)} / ${text(teacher.assistants_active ?? 0)}`;
  row.append(countsCell);

  const pendingCell = document.createElement('td');
  pendingCell.className = 'tnum';
  pendingCell.textContent = text(teacher.students_pending_link ?? 0);
  row.append(pendingCell);

  return row;
}

/** يحصل على رمز الجلسة من عميل Supabase، أو null. */
async function sessionToken(client) {
  try {
    const { data } = await client.auth.getSession();
    return data?.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * صفحة قائمة المدرسين.
 * @param {{client?: object, guard?: Function, fetchImpl?: typeof fetch}} [deps]
 */
export async function initAdminTeachersPage(deps = {}) {
  const client = deps.client ?? getSupabaseClient();
  const guard = deps.guard ? await deps.guard() : await guardAdminPage({ client });
  if (!guard.allowed) {
    document.body.dataset.adminState = 'denied';
    return { allowed: false, reason: guard.reason };
  }
  document.body.dataset.adminState = 'ready';

  const tbody = qs('[data-teachers-body]');
  const pageInfo = qs('[data-page-info]');
  const errorHost = qs('[data-admin-error]');
  const inviteResult = qs('[data-invite-result]');
  const invitationsBody = qs('[data-invitations-body]');
  const searchInput = qs('[data-filter="q"]');
  const statusSelect = qs('[data-filter="status"]');

  let teachers = [];
  let page = 1;

  const renderTable = () => {
    const filtered = filterTeachers(teachers, {
      q: searchInput?.value ?? '',
      status: statusSelect?.value ?? '',
    });
    const slice = paginate(filtered, page);
    page = slice.page;

    if (tbody) {
      tbody.textContent = '';
      for (const teacher of slice.rows) tbody.append(buildTeacherRow(teacher));
      if (slice.rows.length === 0) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 5;
        cell.className = 'text-muted-mh';
        cell.textContent = teachers.length === 0
          ? 'لا يوجد مدرسون بعد — ابدأ بدعوة أول مدرس.'
          : 'لا نتائج مطابقة للتصفية.';
        row.append(cell);
        tbody.append(row);
      }
    }

    if (pageInfo) {
      pageInfo.textContent = `صفحة ${slice.page} من ${slice.totalPages} · ${slice.from}–${slice.to} من ${slice.totalRows}`;
    }
    document.body.dataset.page = String(slice.page);
    document.body.dataset.totalTeachers = String(slice.totalRows);
  };

  const renderInvitations = (rows) => {
    if (!invitationsBody) return;
    invitationsBody.textContent = '';
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.className = 'text-muted-mh';
      cell.textContent = 'لا دعوات مدرسين بعد.';
      row.append(cell);
      invitationsBody.append(row);
      return;
    }

    for (const invite of list) {
      const row = document.createElement('tr');
      row.dataset.invitationId = text(invite.id);
      row.dataset.state = text(invite.state);

      const name = document.createElement('td');
      name.textContent = text(invite.target_name) || 'بدون اسم';
      row.append(name);

      const phone = document.createElement('td');
      phone.className = 'tnum';
      phone.textContent = text(invite.target_hint).slice(-4) || '—';
      row.append(phone);

      const state = document.createElement('td');
      state.textContent = STATE_LABELS[text(invite.state)] ?? text(invite.state);
      row.append(state);

      const expires = document.createElement('td');
      expires.className = 'tnum';
      expires.textContent = invite.expires_at ? formatDateTime(invite.expires_at) : '—';
      row.append(expires);

      const actions = document.createElement('td');
      if (text(invite.state) === 'pending') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-sm btn-outline-secondary';
        button.textContent = 'إعادة إصدار';
        button.dataset.action = 'reissue-invitation';
        button.dataset.invitationId = text(invite.id);
        actions.append(button);
      } else {
        actions.textContent = '—';
      }
      row.append(actions);

      invitationsBody.append(row);
    }
  };

  const load = async () => {
    if (errorHost) errorHost.hidden = true;
    try {
      teachers = await selectAll(client, 'admin_teachers');
      renderTable();
      renderInvitations(await selectAll(client, 'admin_invitations'));
      return { allowed: true, count: teachers.length };
    } catch (error) {
      if (errorHost) {
        errorHost.textContent = error instanceof ApiClientError ? error.message : 'تعذّر تحميل قائمة المدرسين.';
        errorHost.hidden = false;
      }
      return { allowed: true, error: 'load-failed' };
    }
  };

  /** يظهر الرابط مرة واحدة فقط — الخادم لا يحتفظ إلا بالبصمة. */
  const showInviteLink = (link, expiresAt) => {
    if (!inviteResult) return;
    inviteResult.textContent = '';
    if (!link) {
      const warn = document.createElement('p');
      warn.className = 'text-danger-mh';
      warn.textContent = 'تعذّر توليد رابط الدعوة.';
      inviteResult.append(warn);
      inviteResult.hidden = false;
      return;
    }
    const title = document.createElement('p');
    title.className = 'fw-bold';
    title.textContent = 'رابط الدعوة — يُعرض مرة واحدة فقط:';
    const value = document.createElement('code');
    value.className = 'd-block text-break';
    value.dataset.inviteLink = 'true';
    value.textContent = link;
    const note = document.createElement('p');
    note.className = 'text-muted-mh mb-0';
    note.textContent = expiresAt
      ? `صالح حتى ${formatDateTime(expiresAt)}. لن يظهر مرة أخرى — انسخه الآن.`
      : 'لن يظهر مرة أخرى — انسخه الآن.';
    inviteResult.append(title, value, note);
    inviteResult.hidden = false;
  };

  const callAdmin = async (payload) => {
    const token = await sessionToken(client);
    return callFunction('admin-teachers', {
      body: payload,
      token,
      fetchImpl: deps.fetchImpl,
    });
  };

  qs('[data-form="invite-teacher"]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = /** @type {HTMLFormElement} */ (event.currentTarget);
    const button = form.querySelector('[type="submit"]');
    const errorHostForm = form.querySelector('[data-form-error]');
    if (errorHostForm) errorHostForm.hidden = true;
    if (button) button.disabled = true;

    try {
      const data = new FormData(form);
      const result = await callAdmin({
        action: 'invite',
        full_name: String(data.get('full_name') ?? '').trim(),
        phone: String(data.get('phone') ?? '').trim(),
        headline: String(data.get('headline') ?? '').trim(),
      });
      showInviteLink(result.invite_link, result.expires_at);
      form.reset();
      announce('أُنشئت الدعوة. انسخ الرابط الآن لأنه لن يظهر مرة أخرى.');
      await load();
    } catch (error) {
      const message = error instanceof ApiClientError ? error.message : 'تعذّر إرسال الدعوة.';
      if (errorHostForm) {
        errorHostForm.textContent = message;
        errorHostForm.hidden = false;
      }
    } finally {
      if (button) button.disabled = false;
    }
  });

  document.addEventListener('click', async (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target?.dataset?.action !== 'reissue-invitation') return;
    target.disabled = true;
    try {
      const result = await callAdmin({ action: 'reissue', invitation_id: target.dataset.invitationId });
      showInviteLink(result.invite_link, result.expires_at);
      announce('أُعيد إصدار الدعوة وأُلغيت السابقة.');
      await load();
    } catch (error) {
      if (errorHost) {
        errorHost.textContent = error instanceof ApiClientError ? error.message : 'تعذّرت إعادة الإصدار.';
        errorHost.hidden = false;
      }
    } finally {
      target.disabled = false;
    }
  });

  searchInput?.addEventListener('input', () => {
    page = 1;
    renderTable();
  });
  statusSelect?.addEventListener('change', () => {
    page = 1;
    renderTable();
  });
  qs('[data-action="prev-page"]')?.addEventListener('click', () => {
    page -= 1;
    renderTable();
  });
  qs('[data-action="next-page"]')?.addEventListener('click', () => {
    page += 1;
    renderTable();
  });

  return await load();
}

/**
 * صفحة ملف مدرس واحد: بيانات الحساب + ملخص أكاديمي للقراءة فقط + قرار الحالة.
 * @param {{client?: object, guard?: Function, fetchImpl?: typeof fetch, location?: Location}} [deps]
 */
export async function initAdminTeacherDetailPage(deps = {}) {
  const client = deps.client ?? getSupabaseClient();
  const guard = deps.guard ? await deps.guard() : await guardAdminPage({ client });
  if (!guard.allowed) {
    document.body.dataset.adminState = 'denied';
    return { allowed: false, reason: guard.reason };
  }
  document.body.dataset.adminState = 'ready';

  const location = deps.location ?? globalThis.location;
  const teacherId = new URLSearchParams(location?.search ?? '').get('id') ?? '';
  document.body.dataset.teacherId = teacherId;

  const errorHost = qs('[data-admin-error]');
  const titleHost = qs('[data-teacher-name]');
  const summaryHost = qs('[data-teacher-summary]');
  const studentsHost = qs('[data-teacher-students]');
  const eventsHost = qs('[data-account-events]');
  const warning = qs('[data-missing-teacher]');

  if (!teacherId) {
    if (warning) {
      warning.textContent = 'لا يوجد معرّف مدرس في العنوان. افتح الملف من قائمة المدرسين.';
      warning.hidden = false;
    }
    return { allowed: true, error: 'missing-id' };
  }

  const load = async () => {
    if (errorHost) errorHost.hidden = true;
    try {
      const teachers = await selectAll(client, 'admin_teachers');
      const teacher = teachers.find((row) => text(row.teacher_id) === teacherId);
      if (!teacher) {
        if (warning) warning.hidden = false;
        return { allowed: true, error: 'not-found' };
      }
      if (warning) warning.hidden = true;

      if (titleHost) {
        titleHost.textContent = text(teacher.full_name);
        titleHost.dataset.status = text(teacher.status);
      }

      if (summaryHost) {
        summaryHost.textContent = '';
        const items = [
          ['الحالة', STATUS_LABELS[text(teacher.status)] ?? text(teacher.status)],
          ['هاتف (آخر ٤)', teacher.phone_last4 ? `…${text(teacher.phone_last4)}` : '—'],
          ['المسمى', text(teacher.headline) || '—'],
          ['تاريخ الانضمام', teacher.created_at ? formatDateTime(teacher.created_at) : '—'],
          ['طلاب نشطون', text(teacher.students_active ?? 0)],
          ['طلاب بلا حساب', text(teacher.students_pending_link ?? 0)],
          ['مجموعات نشطة', text(teacher.groups_active ?? 0)],
          ['مساعدون', text(teacher.assistants_active ?? 0)],
        ];
        for (const [label, value] of items) {
          const term = document.createElement('dt');
          term.className = 'col-sm-4';
          term.textContent = label;
          const detail = document.createElement('dd');
          detail.className = 'col-sm-8';
          detail.textContent = value;
          summaryHost.append(term, detail);
        }
      }

      const students = await selectAll(client, 'admin_students');
      if (studentsHost) {
        studentsHost.textContent = '';
        const own = students.filter((row) => text(row.teacher_id) === teacherId);
        if (own.length === 0) {
          const row = document.createElement('tr');
          const cell = document.createElement('td');
          cell.colSpan = 3;
          cell.className = 'text-muted-mh';
          cell.textContent = 'لا ملفات طلاب في هذه المساحة.';
          row.append(cell);
          studentsHost.append(row);
        }
        for (const student of own) {
          const row = document.createElement('tr');
          row.dataset.studentId = text(student.id);
          for (const value of [text(student.full_name), text(student.local_code), text(student.status)]) {
            const cell = document.createElement('td');
            cell.textContent = value;
            row.append(cell);
          }
          studentsHost.append(row);
        }
      }

      const events = await selectAll(client, 'admin_account_events');
      if (eventsHost) {
        eventsHost.textContent = '';
        const own = events.filter((row) => text(row.user_id) === teacherId);
        if (own.length === 0) {
          const item = document.createElement('li');
          item.className = 'list-group-item text-muted-mh';
          item.textContent = 'لا قرارات حساب مسجَّلة.';
          eventsHost.append(item);
        }
        for (const event of own) {
          const item = document.createElement('li');
          item.className = 'list-group-item';
          item.dataset.accountAction = text(event.action);
          item.textContent = `${text(event.action)} · ${text(event.reason)} · ${event.at ? formatDateTime(event.at) : ''}`;
          eventsHost.append(item);
        }
      }

      return { allowed: true, teacher };
    } catch (error) {
      if (errorHost) {
        errorHost.textContent = error instanceof ApiClientError ? error.message : 'تعذّر تحميل ملف المدرس.';
        errorHost.hidden = false;
      }
      return { allowed: true, error: 'load-failed' };
    }
  };

  qs('[data-form="account-status"]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = /** @type {HTMLFormElement} */ (event.currentTarget);
    const data = new FormData(form);
    const errorHostForm = form.querySelector('[data-form-error]');
    if (errorHostForm) errorHostForm.hidden = true;

    try {
      const token = await sessionToken(client);
      const result = await callFunction('admin-teachers', {
        body: {
          action: 'set-status',
          user_id: teacherId,
          status: String(data.get('status') ?? ''),
          reason: String(data.get('reason') ?? '').trim(),
        },
        token,
        fetchImpl: deps.fetchImpl,
      });
      announce(result.changed ? 'تم تحديث حالة الحساب.' : 'الحالة نفسها — لم يتغيّر شيء.');
      form.reset();
      await load();
    } catch (error) {
      if (errorHostForm) {
        errorHostForm.textContent = error instanceof ApiClientError ? error.message : 'تعذّر تحديث الحالة.';
        errorHostForm.hidden = false;
      }
    }
  });

  return await load();
}
