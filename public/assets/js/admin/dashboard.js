/**
 * لوحة السوبر أدمن — نظرة عامة (المرحلة ٠٣).
 *
 * كل رقم هنا من `public.admin_overview`، وهي عرض `security_invoker` يستدعي
 * `app.admin_stats(auth.uid())` التي ترفض غير الإدارة. لا رقم تجريبي ولا تقديري:
 * إن فشل التحميل نعرض خطأً صريحًا لا أصفارًا توهم بأن المنصة فارغة.
 *
 * ما لا تفعله هذه الصفحة: لا تعديل أكاديمي، ولا أزرار تدّعي وظائف غير موجودة.
 */
import { getSupabaseClient } from '../supabase-client.js';
import { selectAll, ApiClientError } from '../api.js';
import { guardAdminPage } from '../auth-guard.js';
import { formatDateTime, qs, qsa, announce } from '../ui.js';

/** الحقول المعروضة من الإحصاءات — أسماء مطابقة لما تُرجعه الدالة. */
export const STAT_FIELDS = Object.freeze([
  { key: 'teachers_total', label: 'مدرسون', hint: 'كل الحسابات' },
  { key: 'teachers_active', label: 'نشطون', hint: 'يمكنهم الدخول' },
  { key: 'teachers_suspended', label: 'موقوفون', hint: 'بلا وصول' },
  { key: 'students_total', label: 'ملفات طلاب', hint: 'كل المساحات' },
  { key: 'students_pending_link', label: 'بلا حساب', hint: 'بانتظار دعوة ربط' },
  { key: 'groups_active', label: 'مجموعات', hint: 'نشطة' },
  { key: 'invitations_pending', label: 'دعوات معلّقة', hint: 'سارية الآن' },
  { key: 'audit_events_24h', label: 'أحداث ٢٤ س', hint: 'من سجل التدقيق' },
]);

/**
 * يبني بطاقة رقم واحدة. القيمة تُكتب كنص لا كـHTML.
 * @param {{key: string, label: string, hint: string}} field
 * @param {number|null} value
 */
export function buildStatCard(field, value) {
  const card = document.createElement('div');
  card.className = 'card-mh stat-card';
  card.dataset.stat = field.key;

  const label = document.createElement('p');
  label.className = 'stat-card__label';
  label.textContent = field.label;

  const number = document.createElement('p');
  number.className = 'stat-card__value tnum';
  // F-23: الغياب ليس صفرًا. Number(null) === 0 كان يعرض «0» لقيمة غائبة،
  // فيبدو أن المنصة فارغة بينما القراءة فشلت. الغائب يُعرض «—» صريحًا.
  const missing = value === null || value === undefined || value === '';
  const numeric = Number(value);
  number.textContent = missing || !Number.isFinite(numeric) ? '—' : String(numeric);
  number.dataset.statValue = field.key;

  const hint = document.createElement('p');
  hint.className = 'stat-card__hint text-muted-mh';
  hint.textContent = field.hint;

  card.append(label, number, hint);
  return card;
}

/** @param {HTMLElement|null} container @param {Record<string, unknown>|null} stats */
export function renderStats(container, stats) {
  if (!container) return 0;
  container.textContent = '';
  const source = stats && typeof stats === 'object' ? stats : {};
  for (const field of STAT_FIELDS) {
    container.append(buildStatCard(field, source[field.key] ?? null));
  }
  return STAT_FIELDS.length;
}

/**
 * صف واحد من آخر النشاط. لا HTML من الخادم: كل قيمة نص.
 * @param {{action?: string, actor_name?: string|null, at?: string, outcome?: string}} row
 */
export function buildAuditRow(row) {
  const item = document.createElement('li');
  item.className = 'list-group-item d-flex justify-content-between align-items-center gap-2';
  item.dataset.augitAction = String(row.action ?? '');

  const label = document.createElement('span');
  label.textContent = row.actor_name ? `${row.actor_name} · ${row.action ?? ''}` : String(row.action ?? '');
  item.append(label);

  if (row.outcome && row.outcome !== 'ok') {
    const badge = document.createElement('span');
    badge.className = 'badge text-bg-warning';
    badge.textContent = row.outcome === 'denied' ? 'مرفوض' : 'فشل';
    item.append(badge);
  }

  const time = document.createElement('time');
  time.className = 'text-muted-mh tnum';
  time.dateTime = String(row.at ?? '');
  time.textContent = row.at ? formatDateTime(row.at) : '';
  item.append(time);

  return item;
}

/**
 * يُشغّل صفحة اللوحة. يقبل `deps` للاختبار (عميل مزيّف بلا شبكة).
 * @param {{client?: object, guard?: Function}} [deps]
 */
export async function initAdminDashboardPage(deps = {}) {
  const body = document.body;
  const client = deps.client ?? getSupabaseClient();

  const guard = deps.guard ? await deps.guard() : await guardAdminPage({ client });
  if (!guard.allowed) {
    body.dataset.adminState = 'denied';
    announce('هذه الصفحة للسوبر أدمن فقط.');
    return { allowed: false, reason: guard.reason };
  }
  body.dataset.adminState = 'ready';

  const errorHost = qs('[data-admin-error]');
  const updatedHost = qs('[data-updated-at]');
  const statsHost = qs('[data-stats]');
  const auditHost = qs('[data-audit-list]');

  const load = async () => {
    if (errorHost) errorHost.hidden = true;
    try {
      const rows = await selectAll(client, 'admin_overview');
      const stats = rows[0]?.stats ?? null;
      renderStats(statsHost, stats);
      if (updatedHost) {
        updatedHost.textContent = stats?.generated_at ? formatDateTime(stats.generated_at) : '—';
      }

      const audit = await selectAll(client, 'admin_audit_log');
      if (auditHost) {
        auditHost.textContent = '';
        const recent = audit
          .slice()
          .sort((a, b) => String(b.at).localeCompare(String(a.at)))
          .slice(0, 10);
        for (const row of recent) auditHost.append(buildAuditRow(row));
        if (recent.length === 0) {
          const empty = document.createElement('li');
          empty.className = 'list-group-item text-muted-mh';
          empty.textContent = 'لا أحداث إدارية بعد. تُسجَّل الدعوات والإيقافات والتعليمات هنا.';
          auditHost.append(empty);
        }
      }
      return { allowed: true, stats };
    } catch (error) {
      const clientError = error instanceof ApiClientError ? error : null;
      if (errorHost) {
        errorHost.textContent = clientError?.message ?? 'تعذّر تحميل الأرقام. أعد المحاولة.';
        errorHost.hidden = false;
      }
      return { allowed: true, error: clientError?.code ?? 'UNKNOWN' };
    }
  };

  qsa('[data-action="refresh"]').forEach((button) => {
    button.addEventListener('click', () => {
      void load();
    });
  });

  const result = await load();
  return result;
}
