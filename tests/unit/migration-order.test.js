import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migDir = join(root, 'supabase', 'migrations');
const files = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
const read = (f) => readFileSync(join(migDir, f), 'utf8');

test('المهاجرات مرقّمة بلا فجوات ولا تكرار (R-46)', () => {
  const nums = files.map((f) => Number(f.slice(0, 4)));
  nums.forEach((n, i) => assert.equal(n, i + 1, `ترقيم غير متسلسل عند ${files[i]}`));
});

test('قبول الدعوة يُنشئ الهوية قبل استهلاك الدعوة (F-38)', () => {
  const sql = read('0009_fix_accept_invitation_order.sql');
  const identity = sql.indexOf('svc_accept_identity(');
  const consume = sql.indexOf('consume_invitation(');
  assert.ok(identity > 0, 'الدالة يجب أن تستدعي svc_accept_identity');
  assert.ok(consume > 0, 'الدالة يجب أن تستدعي consume_invitation');
  assert.ok(
    identity < consume,
    'ترتيب خاطئ: الاستهلاك يكتب used_by بمفتاح أجنبي إلى app.profiles فيجب أن يأتي بعد إنشاء الملف',
  );
});

test('قبول الدعوة ممنوع على anon/authenticated ومسموح لـservice_role فقط', () => {
  const sql = read('0009_fix_accept_invitation_order.sql');
  assert.match(sql, /revoke all on function public\.svc_accept_invitation/i);
  assert.match(sql, /grant execute on function public\.svc_accept_invitation[\s\S]*to service_role/i);
  assert.doesNotMatch(sql, /grant execute on function public\.svc_accept_invitation[\s\S]{0,200}to (anon|authenticated|public)/i);
});
