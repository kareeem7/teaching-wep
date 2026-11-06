import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { unreadCount, unreadSummary, sortNotifications } from '../../public/assets/js/notifications.js';
import { actionLabel, auditActions, filterAuditEvents } from '../../public/assets/js/admin/audit.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migDir = join(root, 'supabase', 'migrations');

// ---------- D-03-B: صندوق التنبيهات ----------

test('unreadCount يعدّ ما لم يُقرأ فقط ويحتمل بيانات مشوّهة', () => {
  const rows = [{ read_at: null }, { read_at: '2026-11-06T00:00:00Z' }, { read_at: undefined }, null];
  assert.equal(unreadCount(rows), 2);
  assert.equal(unreadCount(null), 0);
});

test('unreadSummary يقول الحالة بوضوح ولا يعرض رقمًا وهميًا', () => {
  assert.equal(unreadSummary(0, 0), 'لا تنبيهات بعد.');
  assert.equal(unreadSummary(0, 3), 'كل التنبيهات مقروءة (3).');
  assert.equal(unreadSummary(2, 5), '2 غير مقروء من 5.');
});

test('sortNotifications يرتّب الأحدث أولًا بلا تعديل الأصل', () => {
  const rows = [
    { id: 'a', created_at: '2026-11-01T00:00:00Z' },
    { id: 'b', created_at: '2026-11-05T00:00:00Z' },
  ];
  const sorted = sortNotifications(rows);
  assert.deepEqual(
    sorted.map((row) => row.id),
    ['b', 'a'],
  );
  assert.equal(rows[0].id, 'a');
});

// ---------- D-03-C: سجل التدقيق ----------

const EVENTS = [
  { action: 'admin.teacher.invited', actor_name: 'سارة', outcome: 'ok', at: '2026-11-05T20:00:00Z', entity: 'invitation' },
  { action: 'admin.account.suspended', actor_name: 'سارة', outcome: 'ok', at: '2026-11-06T09:00:00Z', entity: 'profile' },
  { action: 'admin.instruction.sent', actor_name: 'منى', outcome: 'ok', at: '2026-11-06T10:00:00Z', entity: 'notification' },
  { action: 'login.failed', actor_name: null, outcome: 'failed', at: '2026-11-06T10:30:00Z', entity: 'session' },
];

test('actionLabel يعطي تسمية عربية ويُبقي الإجراء المجهول كما هو', () => {
  assert.equal(actionLabel('admin.account.suspended'), 'إيقاف حساب');
  assert.equal(actionLabel('custom.future.action'), 'custom.future.action');
  assert.equal(actionLabel(null), '—');
});

test('auditActions يحسب التكرارات من البيانات الفعلية', () => {
  const actions = auditActions([...EVENTS, EVENTS[0]]);
  const invited = actions.find((item) => item.value === 'admin.teacher.invited');
  assert.equal(invited.count, 2);
  assert.equal(invited.label, 'دعوة مدرس');
  assert.equal(actions[0].count, 2);
});

test('filterAuditEvents: بحث بالفاعل وبالإجراء العربي', () => {
  assert.equal(filterAuditEvents(EVENTS, { q: 'منى' }).length, 1);
  assert.equal(filterAuditEvents(EVENTS, { q: 'إيقاف' }).length, 1, 'البحث يشمل التسمية العربية لا المفتاح فقط');
  assert.equal(filterAuditEvents(EVENTS, {}).length, 4);
});

test('filterAuditEvents: فلتر الإجراء والنتيجة', () => {
  assert.equal(filterAuditEvents(EVENTS, { action: 'admin.instruction.sent' }).length, 1);
  assert.equal(filterAuditEvents(EVENTS, { outcome: 'failed' }).length, 1);
  assert.equal(filterAuditEvents(EVENTS, { outcome: 'denied' }).length, 0);
});

test('filterAuditEvents: المدى الزمني شامل الطرفين ويستبعد غير المطابق', () => {
  assert.equal(filterAuditEvents(EVENTS, { from: '2026-11-06', to: '2026-11-06' }).length, 3);
  assert.equal(filterAuditEvents(EVENTS, { from: '2026-11-07' }).length, 0);
  assert.equal(filterAuditEvents(EVENTS, { to: '2026-11-05' }).length, 1);
});

test('filterAuditEvents: حدث بلا تاريخ لا يمرّ عند تحديد مدى', () => {
  const rows = [{ action: 'x', outcome: 'ok' }];
  assert.equal(filterAuditEvents(rows, { from: '2026-01-01' }).length, 0);
  assert.equal(filterAuditEvents(rows, {}).length, 1);
});

// ---------- D-03-A: حرس انحراف منح قائمة الدعوات ----------

test('المهاجرات تمنح authenticated قراءة admin_invitations ولا تسحبها لاحقًا', () => {
  const files = readdirSync(migDir).filter((file) => file.endsWith('.sql')).sort();
  let granted = false;
  const revokes = [];
  for (const file of files) {
    const sql = readFileSync(join(migDir, file), 'utf8');
    const grantRe = /grant\s+select\s+on\s+public\.admin_invitations\s+to\s+[^;]*authenticated[^;]*;/gi;
    if (grantRe.test(sql)) granted = true;
    for (const match of sql.matchAll(/revoke[^;]*public\.admin_invitations[^;]*;/gi)) {
      if (/authenticated/i.test(match[0])) revokes.push(`${file}: ${match[0].replace(/\s+/g, ' ').trim()}`);
    }
  }
  assert.ok(granted, 'لا توجد مهاجرة تمنح authenticated قراءة admin_invitations — قائمة الدعوات سترد 42501');
  assert.deepEqual(revokes, [], 'مهاجرة تسحب القراءة عن authenticated بعد المنح — انحراف D-03-A يتكرر');
});

test('مهاجرة 0011 تُنشئ دالة تعليم التنبيه وتقيّدها بالمستلم', () => {
  const sql = readFileSync(join(migDir, '0011_phase03_fixes.sql'), 'utf8');
  assert.match(sql, /create or replace function public\.mark_notification_read/i);
  assert.match(sql, /r\.user_id\s*=\s*v_user/i, 'القيد الحاكم يجب أن يكون user_id = صاحب الجلسة');
  assert.match(sql, /revoke all on function public\.mark_notification_read[\s\S]*from public, anon/i);
  assert.match(sql, /grant execute on function public\.mark_notification_read[\s\S]*to authenticated/i);
  assert.doesNotMatch(sql, /p_user_id/i, 'لا يجوز قبول معرّف مستخدم كوسيط');
});
