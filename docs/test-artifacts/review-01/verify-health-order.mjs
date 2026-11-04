// أداة تحقق مستقلة: تُثبت أن صفحة الصحة يبدأ تلقائيًا بعد الإصلاح.
// تُشغَّل من جذر المستودع: node docs/test-artifacts/review-01/verify-health-order.mjs
// قبل/بعد: تمرّر نسخة ما قبل الإصلاح عبر git show.
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';

const root = process.cwd();
let n = 0;

async function probe(pageFile, label) {
  const html = readFileSync(pageFile, 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4173/pages/health.html', runScripts: 'outside-only' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.checkConnectivity = async () => ({ online: true, reachable: true, latencyMs: 12, detail: 'استجابة اصطناعية للفحص' });
  globalThis.setBusy = () => {};

  Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'interactive' });
  n += 1;
  await import(`${root}/public/assets/js/app.js?probe=${n}`);

  const body = html.split('<script type="module">')[1].split('</script>')[0].replace(/^\s*import[^\n]*$/gm, '');
  new Function(body)();
  await new Promise((r) => setTimeout(r, 80));

  return {
    label,
    pill: document.getElementById('conn-pill').textContent,
    detail: document.getElementById('conn-detail').textContent,
    latency: document.getElementById('conn-latency').textContent
  };
}

const beforeFile = '/tmp/health-before.html';
writeFileSync(beforeFile, execFileSync('git', ['show', 'a4c3ed9:public/pages/health.html'], { cwd: root }));
const before = await probe(beforeFile, 'قبل الإصلاح');
const after = await probe(`${root}/public/pages/health.html`, 'بعد الإصلاح');
for (const r of [before, after]) {
  console.log(`${r.label}: المؤشر=${JSON.stringify(r.pill)} | التفصيل=${JSON.stringify(r.detail)} | الزمن=${JSON.stringify(r.latency)}`);
}
console.log(before.pill === 'لم يُنفَّذ بعد' ? 'قبل: ❌ عالق' : 'قبل: بدأ');
console.log(after.pill !== 'لم يُنفَّذ بعد' ? 'بعد: ✅ يبدأ تلقائيًا' : 'بعد: ❌ ما زال معطوبًا');
