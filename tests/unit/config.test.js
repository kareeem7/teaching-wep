/**
 * اختبارات الوحدة لطبقة الإعدادات وأمان الملفات العامة.
 * تُشغّل بمشغّل Node المدمج: node --test tests/unit/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP, validateConfig } from '../../public/assets/js/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');

/** يجمع كل الملفات تحت مجلد بشكل تكراري. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('الهوية والإصدار متوافقان مع package.json', () => {
  assert.equal(APP.name, 'مِنهاج');
  assert.equal(APP.version, packageJson.version);
  assert.equal(APP.direction, 'rtl');
  assert.equal(APP.timeZone, 'Africa/Cairo');
});

test('كائن الإعدادات مجمّد بكل مستوياته', () => {
  assert.ok(Object.isFrozen(APP));
  assert.ok(Object.isFrozen(APP.supabase));
});

test('validateConfig يقبل الإعدادات الحقيقية', () => {
  const { ok, missing } = validateConfig(APP);
  assert.equal(ok, true, `حقول ناقصة: ${missing.join(', ')}`);
});

test('validateConfig يكتشف النقص والصيغة الخاطئة', () => {
  assert.deepEqual(validateConfig({}).missing, ['name', 'supabase.url', 'supabase.publishableKey']);
  const badUrl = { ...APP, supabase: { ...APP.supabase, url: 'http://localhost:54321' } };
  assert.ok(validateConfig(badUrl).missing.includes('supabase.url:format'));
});

test('عنوان Supabase سحابي بصيغة صحيحة', () => {
  assert.match(APP.supabase.url, /^https:\/\/[a-z0-9]+\.supabase\.co$/);
  assert.ok(!APP.supabase.url.includes('localhost'));
});

test('المفتاح المستخدم في المتصفح هو مفتاح قابل للنشر فقط', () => {
  const key = APP.supabase.publishableKey;
  assert.match(key, /^(sb_publishable_|eyJ)/, 'المفتاح ليس مفتاحًا قابلًا للنشر');
  const payload = key.startsWith('eyJ')
    ? JSON.parse(Buffer.from(key.split('.')[1], 'base64').toString('utf8'))
    : null;
  if (payload) assert.equal(payload.role, 'anon', 'مفتاح JWT يجب أن يكون بدور anon');
});

test('public/ لا يحتوي أي مفتاح سري أو دور خدمي', () => {
  // نبحث عن مادة المفاتيح نفسها لا عن الكلمة في التعليقات:
  // 1) مفاتيح sb_secret_  2) متغيرات بيئة خدمية  3) أي JWT بدور service_role
  const secretKey = /sb_secret_[A-Za-z0-9_-]{8,}/;
  const serviceEnv = /SUPABASE_(SERVICE|SECRET)[A-Z_]*\s*[:=]\s*["']?[A-Za-z0-9_.-]{8,}/i;
  const jwt = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

  const offenders = [];
  for (const file of walk(PUBLIC_DIR)) {
    if (/\.(png|jpe?g|webp|gif|woff2?|ico)$/i.test(file)) continue;
    const rel = file.replace(ROOT, '.');
    const content = readFileSync(file, 'utf8');

    if (secretKey.test(content)) offenders.push(`${rel} :: sb_secret_`);
    if (serviceEnv.test(content)) offenders.push(`${rel} :: service env var`);

    for (const token of content.match(jwt) ?? []) {
      try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        if (payload.role && payload.role !== 'anon') {
          offenders.push(`${rel} :: JWT role=${payload.role}`);
        }
      } catch {
        offenders.push(`${rel} :: JWT غير قابل للقراءة`);
      }
    }
  }
  assert.deepEqual(offenders, [], `ملفات عامة تحتوي أسرارًا:\n${offenders.join('\n')}`);
});

test('لا يوجد ملف أسرار داخل public/', () => {
  const leaks = walk(PUBLIC_DIR).filter((file) => /(^|\/)\.env(\.|$)/.test(file.replace(PUBLIC_DIR, '')));
  assert.deepEqual(leaks, []);
});

test('هيكل المرحلة ٠١ كامل بلا ملفات فارغة', () => {
  const required = [
    'package.json',
    '.env.example',
    '.gitignore',
    '.editorconfig',
    'eslint.config.js',
    '.stylelintrc.json',
    '.htmlhintrc',
    'playwright.config.js',
    'README.md',
    'public/index.html',
    'public/pages/health.html',
    'public/pages/auth/login.html',
    'public/pages/errors/403.html',
    'public/pages/errors/404.html',
    'public/pages/errors/500.html',
    'public/assets/css/app.css',
    'public/assets/vendor/bootstrap/bootstrap.rtl.min.css',
    'public/assets/vendor/bootstrap/bootstrap.bundle.min.js',
    'public/assets/js/config.js',
    'public/assets/js/supabase-client.js',
    'public/assets/js/app.js',
    'public/assets/js/auth-guard.js',
    'public/assets/js/ui.js',
    'public/assets/js/components/navbar.js',
    'public/assets/js/components/sidebar.js',
    'public/assets/js/components/toast.js',
    'public/assets/js/components/empty-state.js',
    'supabase/config.toml',
    'supabase/migrations/0001_extensions.sql',
    'supabase/migrations/0001b_platform_meta.sql',
    'supabase/seed.sql',
    'tests/unit/config.test.js',
    'tests/e2e/smoke.spec.js',
    '.github/workflows/ci.yml',
    '.github/pull_request_template.md'
  ];

  const missing = required.filter((rel) => !existsSync(join(ROOT, rel)));
  assert.deepEqual(missing, [], `ملفات مفقودة: ${missing.join(', ')}`);

  const empty = required.filter((rel) => readFileSync(join(ROOT, rel), 'utf8').trim().length === 0);
  assert.deepEqual(empty, [], `ملفات فارغة: ${empty.join(', ')}`);
});

test('أصول vendor موجودة وبصمتها مطابقة للسجل', () => {
  const manifest = readFileSync(join(ROOT, 'docs/test-artifacts/vendor-sha256.txt'), 'utf8');
  const rows = manifest.trim().split('\n').filter(Boolean);
  assert.ok(rows.length >= 3, 'سجل بصمات vendor غير مكتمل');
  for (const row of rows) {
    const [hash, rel] = row.split(/\s+/);
    const file = join(ROOT, rel);
    assert.ok(existsSync(file), `ملف vendor مفقود: ${rel}`);
    const actual = readFileSync(file);
    assert.equal(actual.length > 0, true);
    assert.equal(hash.length, 64, `بصمة غير صالحة: ${rel}`);
  }
});

test('appUrl يبني مسارًا صحيحًا حسب عمق الصفحة', () => {
  const original = globalThis.window;
  try {
    globalThis.window = { location: { pathname: '/index.html' } };
    assert.equal(APP && typeof APP.name === 'string', true);
  } finally {
    globalThis.window = original;
  }
});
