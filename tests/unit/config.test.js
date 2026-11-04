/**
 * اختبارات وحدة للمنطق النقي: إعداد الواجهة (config.js) وأدوات التنسيق (ui.js).
 * لا DOM ولا شبكة ولا قاعدة بيانات — تعمل في أي بيئة Node 20+.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateConfig,
  isValidSupabaseUrl,
  isForbiddenKey,
  decodeJwtClaims,
  readMetaConfig,
} from '../../public/assets/js/config.js';
import {
  escapeHtml,
  formatDateTime,
  formatPercent,
  isPlausiblePhone,
} from '../../public/assets/js/ui.js';

const VALID_URL = 'https://abcdefghijklmnopqrst.supabase.co';

/** يبني JWT غير موقّع لأغراض الاختبار فقط (ليس سرًّا ولا مفتاحًا حقيقيًا). */
function fakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesignature`;
}

test('إعداد فارغ: غير مهيأ لكنه ليس خطأ', () => {
  const result = validateConfig({ url: '', key: '' });
  assert.equal(result.ok, true);
  assert.equal(result.configured, false);
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 1);
});

test('عنوان صالح + مفتاح anon = إعداد مكتمل', () => {
  const result = validateConfig({ url: VALID_URL, key: fakeJwt({ role: 'anon' }) });
  assert.equal(result.ok, true);
  assert.equal(result.configured, true);
  assert.deepEqual(result.errors, []);
});

test('مفتاح service_role مرفوض دائمًا', () => {
  const result = validateConfig({ url: VALID_URL, key: fakeJwt({ role: 'service_role' }) });
  assert.equal(result.ok, false);
  assert.equal(result.configured, false);
  assert.match(result.errors.join(' '), /service_role/);
});

test('مفتاح sb_secret_ مرفوض دائمًا', () => {
  const result = validateConfig({ url: VALID_URL, key: 'sb_secret_FAKEONLY123' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /مفتاح سرّي/);
});

test('مفتاح publishable الجديد مقبول', () => {
  const result = validateConfig({ url: VALID_URL, key: 'sb_publishable_ABC123' });
  assert.equal(result.ok, true);
  assert.equal(result.configured, true);
});

test('عنوان بلا https مرفوض', () => {
  assert.equal(isValidSupabaseUrl('http://abcdefghijklmnopqrst.supabase.co'), false);
});

test('عنوان بمسار أو استعلام مرفوض', () => {
  assert.equal(isValidSupabaseUrl('https://abcdefghijklmnopqrst.supabase.co/rest/v1'), false);
  assert.equal(isValidSupabaseUrl('https://abcdefghijklmnopqrst.supabase.co/?x=1'), false);
});

test('نطاق غير تابع لـSupabase مرفوض', () => {
  const result = validateConfig({ url: 'https://evil.example.com', key: fakeJwt({ role: 'anon' }) });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /غير صالح/);
});

test('عنوان بلا مفتاح يُعد ناقصًا', () => {
  const result = validateConfig({ url: VALID_URL, key: '' });
  assert.equal(result.ok, false);
  assert.equal(result.configured, false);
  assert.match(result.errors.join(' '), /مفتاح/);
});

test('مفتاح غير JWT وغير publishable مرفوض', () => {
  const result = validateConfig({ url: VALID_URL, key: 'not-a-key' });
  assert.equal(result.ok, false);
});

test('مفتاح بدور غير anon مرفوض', () => {
  const result = validateConfig({ url: VALID_URL, key: fakeJwt({ role: 'authenticated' }) });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /anon/);
});

test('decodeJwtClaims ينفع على القيم غير الصالحة دون رمي استثناء', () => {
  assert.equal(decodeJwtClaims('abc'), null);
  assert.equal(decodeJwtClaims(''), null);
  assert.equal(decodeJwtClaims(undefined), null);
});

test('isForbiddenKey صحيح مع القيم الفارغة', () => {
  assert.equal(isForbiddenKey(''), false);
  assert.equal(isForbiddenKey(undefined), false);
});

test('readMetaConfig يُرجع قيمًا فارغة بلا DOM', () => {
  const result = readMetaConfig(null);
  assert.deepEqual(result, { url: '', key: '', source: 'none' });
});

test('escapeHtml يهرب الوسوم والاقتباسات', () => {
  assert.equal(escapeHtml('<b>"x"</b>'), '&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
  assert.equal(escapeHtml(null), '');
});

test('formatDateTime يستخدم المنطقة الزمنية المعتمدة ويتعامل مع تاريخ غير صالح', () => {
  const text = formatDateTime('2026-11-04T09:30:00Z');
  assert.ok(text.length > 0);
  assert.equal(formatDateTime('not-a-date'), '—');
});

test('formatPercent يقرّب ويحمي من القسمة على صفر', () => {
  assert.equal(formatPercent(8, 10), '80%');
  assert.equal(formatPercent(1, 0), '—');
});

test('isPlausiblePhone يتحقق شكليًا فقط', () => {
  assert.equal(isPlausiblePhone('+201012345678'), true);
  assert.equal(isPlausiblePhone('01012345678'), false);
  assert.equal(isPlausiblePhone(''), false);
});
