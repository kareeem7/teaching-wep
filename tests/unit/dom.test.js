/**
 * اختبارات DOM حقيقية عبر jsdom (بديل موثّق لاختبارات المتصفح حين يتعذّر تشغيل Playwright).
 * الهدف: إثبات أن وحدات ES تعمل وتُنتج DOM فعليًا، لا مجرد فحص نصي للملفات.
 * ملاحظة: هذا لا يستبدل اختبار E2E في CI؛ كلاهما مطلوب.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_URL = pathToFileURL(join(ROOT, 'public', '/')).href;

/** يهيّئ jsdom من صفحة حقيقية ويضع الكائنات العالمية. */
function setupPage(relativePage) {
  const html = readFileSync(join(ROOT, 'public', relativePage), 'utf8');
  const dom = new JSDOM(html, {
    url: new URL(relativePage, PUBLIC_URL).href,
    pretendToBeVisual: true
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  // navigator في Node للقراءة فقط؛ نكتفي بـ window.navigator من jsdom
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.HTMLElement = dom.window.HTMLElement;
  return dom;
}

test('app.js يبني الشريط العلوي ويهيّئ الهوية', async () => {
  const dom = setupPage('index.html');
  await import('../../public/assets/js/app.js');
  const navbar = dom.window.document.querySelector('.app-navbar');
  assert.ok(navbar, 'لم يُبنَ الشريط العلوي');
  assert.equal(navbar.querySelectorAll('.nav-link').length, 3);
  assert.equal(navbar.querySelector('.navbar-brand').textContent.trim(), 'مِنهاج');
  assert.ok(dom.window.document.querySelector('.app-navbar .nav-link.active'), 'لا يوجد رابط نشِط');
  assert.equal(dom.window.document.documentElement.dataset.appReady, 'true');
});

test('ui.js ينسّق الأرقام والتواريخ بالعربية وبتوقيت القاهرة', async () => {
  setupPage('index.html');
  const { formatNumber, formatDate, el } = await import('../../public/assets/js/ui.js');
  assert.match(formatNumber(1234), /^[\u0660-\u0669\u06F0-\u06F9\d]{1,2}[\u066C\u060C,'٬]?[\u0660-\u0669\u06F0-\u06F9\d]{3}$/);
  assert.equal(formatNumber(Number.NaN), '—');
  assert.match(formatDate('2026-11-04T12:00:00Z', { withTime: true }), /٢٠٢٦|2026/);
  assert.equal(formatDate('not-a-date'), '—');
  const node = el('span', '<b>خطر</b>');
  assert.equal(node.innerHTML.includes('<b>'), false, 'النص يجب ألا يُفسَّر كـ HTML');
});

test('حارس الجلسة يبني رابط الدخول مع وجهة العودة', async () => {
  setupPage('index.html');
  const { buildLoginUrl } = await import('../../public/assets/js/auth-guard.js');
  const url = new URL(buildLoginUrl('/pages/health.html'));
  assert.ok(url.pathname.endsWith('/pages/auth/login.html'));
  assert.equal(url.searchParams.get('next'), '/pages/health.html');
});

test('الحالة الفارغة تُبنى بلا HTML من مدخلات', async () => {
  setupPage('index.html');
  const { createEmptyState } = await import('../../public/assets/js/components/empty-state.js');
  const node = createEmptyState({ title: 'لا بيانات', text: 'لم يُسجَّل أحد' });
  assert.equal(node.querySelector('.empty-state__title').textContent, 'لا بيانات');
  assert.equal(node.querySelectorAll('a').length, 0);
});
