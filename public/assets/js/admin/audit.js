/**
 * سجل التدقيق — صفحة مستقلة ببحث وفلاتر وترقيم (المرحلة ٠٣، عيب D-03-C).
 *
 * المصدر: `public.admin_audit_log` (security_invoker + `app.is_super_admin()` داخل العرض
 * + RLS على `app.audit_events`). التصفية هنا **عرض فقط**، والصلاحية على الخادم.
 *
 * لا تعديل ولا حذف: `app.audit_events` محمي بمُشغِّل يمنع UPDATE/DELETE/TRUNCATE،
 * وهذه الصفحة لا تعرض أي إجراء كتابة إطلاقًا.
 */
import { getSupabaseClient } from '../supabase-client.js';
import { selectAll, ApiClientError } from '../api.js';
import { guardAdminPage } from '../auth-guard.js';
import { formatDateTime, qs, qsa, announce } from '../ui.js';
import { renderEmptyState } from '../components/empty-state.js';
import { paginate } from './teachers.js';

/** حجم صفحة السجل — أكبر من قوائم المدرسين لأن السطر سطر تدقيق واحد. */
export const AUDIT_PAGE_SIZE = 15;

/** تسميات عربية للإجراءات المعروفة، وأي إجراء آخر يظهر كما هو. */
export const ACTION_LABELS = Object.freeze({
  'admin.teacher.invited': 'دعوة مدرس',
  'admin.invitation.reissued': 'إعادة إصدار دعوة',
  'admin.account.suspended': 'إيقاف حساب',
  'admin.account.reactivated': 'إعادة تنشيط حساب',
  'admin.instruction.sent': 'إرسال تعليم',
  'login.ok': 'دخول ناجح',
  'login.failed': 'دخول فاشل',
  'login.blocked': 'دخول مرفوض (حساب موقوف)',
  'login.invalid_input': 'مدخل دخول غير صالح',
  'invite.accepted.teacher_invite': 'قبول دعوة مدرس',
});

const text = (value) => (value === null || value === undefined ? '' : String(value));

/** تسمية مقروءة لإجراء. */
export function actionLabel(action) {
  const key = text(action).trim();
  if (!key) return '—';
  return ACTION_LABELS[key] ?? key;
}

/**
 * قائمة الإجراءات الموجودة فعلًا في البيانات (لخيارات الفلتر).
 * @param {Array<Record<string, unknown>>} rows
 * @returns {Array<{value: string, label: string, count: number}>}
 */
export function auditActions(rows) {
  const counts = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = text(row?.action);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, label: actionLabel(value), count }));
}

/** يحوّل تاريخًا (ISO) إلى يوم محلي YYYY-MM-DD للمقارنة مع مدخلات date. */
function dayOf(value) {
  const raw = text(value);
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * تصفية السجل: بحث نصي + إجراء + نتيجة + مدى زمني. كلها على البيانات المقروءة.
 * @param {Array<Record<string, unknown>>} rows
 * @param {{q?: string, action?: string, outcome?: string, from?: string, to?: string}} filters
 */
export function filterAuditEvents(rows, filters = {}) {
  const q = text(filters.q).trim().toLowerCase();
  const action = text(filters.action).trim();
  const outcome = text(filters.outcome).trim();
  const from = text(filters.from).trim();
  const to = text(filters.to).trim();

  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (action && text(row?.action) !== action) return false;
    if (outcome && text(row?.outcome) !== outcome) return false;
    const day = dayOf(row?.at);
    if (from && (!day || day < from)) return false;
    if (to && (!day || day > to)) return false;
    if (q) {
      const haystack = [row?.actor_name, row?.teacher_name, row?.action, actionLabel(row?.action), row?.entity]
        .map((part) => text(part).toLowerCase())
        .join(' ');
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

/** يبني صف جدول واحد. */
export function buildAuditEventRow(row) {
  const tr = document.createElement('tr');
  tr.dataset.action = text(row?.action);
  tr.dataset.outcome = text(row?.outcome);

  const cells = [
    row?.at ? formatDateTime(row.at) : '—',
    text(row?.actor_name) || (text(row?.actor_role) ? '—' : 'غير معروف'),
    text(row?.actor_role) || '—',
    actionLabel(row?.action),
    text(row?.entity) || '—',
    text(row?.outcome) || '—',
    text(row?.detail) ? JSON.stringify(row.detail) : '—',
  ];

  for (const [index, value] of cells.entries()) {
    const td = document.createElement('td');
    td.textContent = value;
    if (index === 6) td.className = 'text-muted-mh small';
    tr.append(td);
  }
  return tr;
}

/**
 * يهيّئ صفحة السجل.
 * @param {{client?: object, guard?: Function}} [deps]
 */
export async function initAdminAuditPage(deps = {}) {
  const client = deps.client ?? getSupabaseClient();
  const guard = deps.guard ? await deps.guard() : await guardAdminPage({ client });
  if (!guard.allowed) {
    document.body.dataset.adminState = 'denied';
    return { allowed: false, reason: guard.reason };
  }
  document.body.dataset.adminState = 'ready';

  const host = qs('[data-audit-body]');
  const emptyHost = qs('[data-audit-empty]');
  const countHost = qs('[data-audit-count]');
  const pageInfo = qs('[data-page-info]');
  const errorHost = qs('[data-admin-error]');
  const actionSelect = qs('[data-filter="action"]');
  const form = qs('[data-form="audit-filters"]');

  let rows = [];
  let page = 1;
  const filters = () => ({
    q: qs('[data-filter="q"]')?.value ?? '',
    action: actionSelect?.value ?? '',
    outcome: qs('[data-filter="outcome"]')?.value ?? '',
    from: qs('[data-filter="from"]')?.value ?? '',
    to: qs('[data-filter="to"]')?.value ?? '',
  });

  const fillActions = () => {
    if (!actionSelect) return;
    const current = actionSelect.value;
    actionSelect.textContent = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'الكل';
    actionSelect.append(all);
    for (const item of auditActions(rows)) {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = `${item.label} (${item.count})`;
      actionSelect.append(option);
    }
    actionSelect.value = current;
  };

  const render = () => {
    const filtered = filterAuditEvents(rows, filters());
    const slice = paginate(filtered, page, AUDIT_PAGE_SIZE);
    if (countHost) countHost.textContent = `${filtered.length} حدثًا مطابقًا من ${rows.length}.`;
    if (emptyHost) emptyHost.hidden = filtered.length > 0;
    if (pageInfo) pageInfo.textContent = `صفحة ${slice.page} من ${slice.totalPages}`;
    qsa('[data-action="prev"]').forEach((button) => (button.disabled = slice.page <= 1));
    qsa('[data-action="next"]').forEach((button) => (button.disabled = slice.page >= slice.totalPages));
    if (!host) return;
    host.textContent = '';
    for (const row of slice.rows) host.append(buildAuditEventRow(row));
    if (filtered.length === 0 && rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.append(renderEmptyState({ title: 'لا أحداث بعد', text: 'تُسجَّل الدعوات والإيقافات والتعليمات هنا.', icon: '◇' }));
      tr.append(td);
      host.append(tr);
    }
    return { total: filtered.length, page: slice.page, totalPages: slice.totalPages };
  };

  const load = async () => {
    if (errorHost) errorHost.hidden = true;
    try {
      rows = await selectAll(client, 'admin_audit_log');
      rows = rows.slice().sort((a, b) => String(b?.at ?? '').localeCompare(String(a?.at ?? '')));
      fillActions();
      const result = render();
      return { allowed: true, ...result };
    } catch (error) {
      if (errorHost) {
        errorHost.textContent = error instanceof ApiClientError ? error.message : 'تعذّر تحميل سجل التدقيق.';
        errorHost.hidden = false;
      }
      return { allowed: true, error: 'load-failed' };
    }
  };

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    page = 1;
    render();
    announce('طُبِّقت الفلاتر.');
  });
  qs('[data-action="reset"]')?.addEventListener('click', () => {
    form?.reset();
    page = 1;
    render();
    announce('أُعيد ضبط الفلاتر.');
  });
  qsa('[data-filter]').forEach((input) => {
    input.addEventListener('input', () => {
      page = 1;
      render();
    });
    input.addEventListener('change', () => {
      page = 1;
      render();
    });
  });
  qs('[data-action="prev"]')?.addEventListener('click', () => {
    page = Math.max(1, page - 1);
    render();
  });
  qs('[data-action="next"]')?.addEventListener('click', () => {
    page += 1;
    render();
  });

  return load();
}
