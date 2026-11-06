/**
 * صندوق التنبيهات — للدور المستلم (مدرس/مساعد/طالب) — المرحلة ٠٣، عيب D-03-B.
 *
 * المصدر الوحيد: العرض `public.my_notifications` (security_invoker) الذي يقصف على
 * `r.user_id = auth.uid()`، فحتى لو غيّر المستخدم معرّفًا في العنوان لا يرى تنبيه غيره.
 *
 * التعليم كمقروء يمرّ بدالة `public.mark_notification_read` التي تأخذ الهوية من
 * الـJWT ولا تقبل معرّف مستخدم — فلا يمكن تعليم تنبيه غيرك.
 */
import { getSupabaseClient } from './supabase-client.js';
import { selectAll } from './api.js';
import { guardPage } from './auth-guard.js';
import { formatDateTime, qs, announce } from './ui.js';

/**
 * عدد غير المقروء من صفوف `my_notifications`.
 * @param {Array<Record<string, unknown>>} rows
 * @returns {number}
 */
export function unreadCount(rows) {
  if (!Array.isArray(rows)) return 0;
  return rows.filter((row) => row && (row.read_at === null || row.read_at === undefined)).length;
}

/**
 * ملخّص نصي مفهوم بدل رقم مجرّد.
 * @param {number} unread
 * @param {number} total
 */
export function unreadSummary(unread, total) {
  const safeUnread = Number.isFinite(unread) ? Math.max(0, unread) : 0;
  const safeTotal = Number.isFinite(total) ? Math.max(0, total) : 0;
  if (safeTotal === 0) return 'لا تنبيهات بعد.';
  if (safeUnread === 0) return `كل التنبيهات مقروءة (${safeTotal}).`;
  return `${safeUnread} غير مقروء من ${safeTotal}.`;
}

/**
 * يرتّب التنبيهات الأحدث أولًا بلا تعديل المصفوفة الأصلية.
 * @param {Array<Record<string, unknown>>} rows
 */
export function sortNotifications(rows) {
  return (Array.isArray(rows) ? rows.slice() : []).sort((a, b) =>
    String(b?.created_at ?? '').localeCompare(String(a?.created_at ?? '')),
  );
}

/**
 * يبني عنصر قائمة واحد. كل النصوص تُكتب بـtextContent لا كـHTML.
 * @param {Record<string, unknown>} row
 * @param {{onMarkRead?: (id: string) => void}} [handlers]
 */
export function buildNotificationItem(row, handlers = {}) {
  const item = document.createElement('li');
  const id = String(row?.id ?? '');
  const read = row?.read_at !== null && row?.read_at !== undefined;
  item.className = `list-group-item${read ? '' : ' fw-bold'}`;
  item.dataset.notificationId = id;
  item.dataset.read = read ? 'true' : 'false';

  const title = document.createElement('p');
  title.className = 'mb-1';
  title.textContent = String(row?.title ?? '(بلا عنوان)');
  item.append(title);

  const body = document.createElement('p');
  body.className = 'mb-1 text-muted-mh';
  body.textContent = String(row?.body ?? '');
  item.append(body);

  const meta = document.createElement('p');
  meta.className = 'mb-0 text-muted-mh small';
  const sender = String(row?.sender_name ?? 'الإدارة');
  const when = row?.created_at ? formatDateTime(row.created_at) : '—';
  meta.textContent = `${sender} · ${when}${read ? ' · مقروء' : ''}`;
  item.append(meta);

  if (!read) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-sm btn-outline-mh mt-2';
    button.dataset.action = 'mark-read';
    button.textContent = 'تحديد كمقروء';
    button.addEventListener('click', () => {
      if (typeof handlers.onMarkRead === 'function') handlers.onMarkRead(id);
    });
    item.append(button);
  }

  return item;
}

/**
 * @param {object} client عميل Supabase
 * @param {string} notificationId
 * @returns {Promise<{changed: boolean, readAt: string|null}>}
 */
export async function markNotificationRead(client, notificationId) {
  const { data, error } = await client.rpc('mark_notification_read', {
    p_notification_id: notificationId,
  });
  if (error) {
    const failure = new Error('لم يُسجَّل التنبيه كمقروء.');
    failure.code = error.code ?? 'READ_FAILED';
    throw failure;
  }
  return { changed: Boolean(data?.changed), readAt: data?.read_at ?? null };
}

/**
 * يهيّئ صفحة الصندوق. يعيد ملخصًا قابلًا للاختبار.
 * @param {{client?: object, guard?: Function}} [deps]
 */
export async function initNotificationsPage(deps = {}) {
  const client = deps.client ?? getSupabaseClient();
  const guard = deps.guard ? await deps.guard() : await guardPage({ redirect: false });
  if (guard && guard.allowed === false) {
    document.body.dataset.notificationsState = 'denied';
    return { allowed: false, reason: guard.reason ?? 'no-session' };
  }

  const listHost = qs('[data-notifications-list]');
  const emptyHost = qs('[data-notifications-empty]');
  const summaryHost = qs('[data-unread-summary]');
  const errorHost = qs('[data-notifications-error]');

  /** @type {Array<Record<string, unknown>>} */
  let rows = [];

  const render = () => {
    const total = rows.length;
    const unread = unreadCount(rows);
    if (summaryHost) summaryHost.textContent = unreadSummary(unread, total);
    if (emptyHost) emptyHost.hidden = total > 0;
    if (!listHost) return;
    listHost.textContent = '';
    for (const row of sortNotifications(rows)) {
      listHost.append(
        buildNotificationItem(row, {
          onMarkRead: async (id) => {
            try {
              await markNotificationRead(client, id);
              rows = rows.map((item) => (String(item.id) === id ? { ...item, read_at: new Date().toISOString() } : item));
              render();
              announce('سُجّل التنبيه كمقروء.');
            } catch {
              if (errorHost) {
                errorHost.textContent = 'تعذّر تعليم التنبيه كمقروء. أعد المحاولة.';
                errorHost.hidden = false;
              }
            }
          },
        }),
      );
    }
  };

  try {
    rows = await selectAll(client, 'my_notifications');
    if (errorHost) errorHost.hidden = true;
    render();
    document.body.dataset.notificationsState = 'ready';
    return { allowed: true, total: rows.length, unread: unreadCount(rows) };
  } catch {
    if (errorHost) {
      errorHost.textContent = 'تعذّر تحميل التنبيهات. أعد المحاولة.';
      errorHost.hidden = false;
    }
    document.body.dataset.notificationsState = 'error';
    return { allowed: true, error: 'load-failed' };
  }
}
