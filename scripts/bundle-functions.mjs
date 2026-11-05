#!/usr/bin/env node
/**
 * مُجمِّع دوال Edge — يحل محل الاستيراد النسبي `../_shared/*` الذي يرفضه النشر.
 *
 * الرابط: R-38 (docs/DECISIONS.md) — «تجميع الدوال في ملف واحد قبل النشر».
 * القرار: بلا أي اعتمادية خارجية (لا esbuild، لا خدمة مدفوعة) ليبقى ضمن الحزمة المعتمدة.
 *
 * الطريقة: اجتياز عمق-أول للواردات النسبية، ثم إصدار كل وحدة مرة واحدة بترتيب التبعيات،
 * مع حذف أسطر `import` وإزالة كلمة `export` من التعريفات. الملفات كلها لنا، وواجهاتها
 * أسماء مصدَّرة مفردة (function/const/class) — لا `export default` ولا `export *`.
 *
 * يفشل بصوت عالٍ (لا يخمّن) عند: استيراد غير نسبي، اسم مُعرَّف مرتين، أو تصدير غير مدعوم.
 *
 * التشغيل: node scripts/bundle-functions.mjs [اسم الدالة ...]
 * الإخراج: supabase/.bundles/<name>.js  (مُستثنى من Git عبر .gitignore)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FUNCTIONS_DIR = resolve(ROOT, 'supabase/functions');
const OUT_DIR = resolve(ROOT, 'supabase/.bundles');

const DEFAULT_TARGETS = [
  'admin-teachers',
  'admin-instructions',
  'auth-login',
  'auth-recovery',
  'invite-accept',
  'workspace-select',
];

/** يطابق `import {...} from '...'` بما يشمل الكتلة متعددة الأسطر. */
const IMPORT_RE = /^import\s+[\s\S]*?from\s+['"]([^'"]+)['"];?[ \t]*$/gm;
/** تعريفات نُزيل عنها `export` عند التجميع. */
const EXPORT_DEF_RE = /^export\s+(async\s+function|function|const|let|class)\s/gm;
const UNSUPPORTED_EXPORT_RE = /^export\s+(default|\*|\{)/m;

/**
 * يقرأ وحدة ويعيد نصّها بلا واردات ولا `export`، مع قائمة وارداتها النسبية.
 * @param {string} absPath
 * @returns {{imports: string[], body: string}}
 */
function readModule(absPath) {
  const source = readFileSync(absPath, 'utf8');
  if (UNSUPPORTED_EXPORT_RE.test(source)) {
    throw new Error(`تصدير غير مدعوم في ${absPath} — يحتاج المُجمِّع مراجعة يدوية.`);
  }

  const imports = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    imports.push(match[1]);
  }

  const body = source
    .replace(IMPORT_RE, '')
    .replace(EXPORT_DEF_RE, '$1 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { imports, body };
}

/**
 * @param {string} entry
 * @returns {string} حزمة واحدة قابلة للنشر
 */
function bundle(entry) {
  /** @type {Map<string, string>} */
  const modules = new Map();
  /** @type {Map<string, string>} اسم التعريف ← الملف (لكشف التصادم) */
  const declared = new Map();

  const namesIn = (body) =>
    Array.from(
      body.matchAll(/^(?:async\s+function|function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm),
      (m) => m[1],
    );

  const visit = (absPath) => {
    if (modules.has(absPath)) return;
    modules.set(absPath, ''); // حجز لمنع الدوران
    const { imports, body } = readModule(absPath);

    for (const name of namesIn(body)) {
      const owner = declared.get(name);
      if (owner && owner !== absPath) {
        throw new Error(`تعريف مكرر «${name}» في ${owner} و${absPath} — لا يمكن الدمج بأمان.`);
      }
      declared.set(name, absPath);
    }

    for (const spec of imports.filter((s) => s.startsWith('.'))) {
      visit(resolve(dirname(absPath), spec));
    }

    modules.set(absPath, body);
  };

  visit(entry);

  const chunks = [];
  for (const [absPath, body] of modules) {
    // الدخول آخرًا دائمًا حتى تكون التبعيات معرَّفة قبله.
    if (absPath === entry) continue;
    chunks.push(body);
  }
  chunks.push(modules.get(entry));

  let output = chunks.join('\n\n');
  // تُصدَّر الدالة الداخلة لتُختبر الحزمة نفسها في Node (اختبار دخان)، وDeno لا يتأثر.
  if (/^(?:async\s+)?function\s+handler\b/m.test(output)) {
    output += '\nexport { handler };\n';
  }
  return output;
}

const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_TARGETS;
mkdirSync(OUT_DIR, { recursive: true });

for (const name of targets) {
  const entry = resolve(FUNCTIONS_DIR, name, 'index.js');
  const output = bundle(entry);
  const banner = `// ملف مُولَّد آليًا بواسطة scripts/bundle-functions.mjs — لا يُعدَّل يدويًا.\n// المصدر: supabase/functions/${name}/ — انظر R-38.\n`;
  const outPath = resolve(OUT_DIR, `${name}.js`);
  writeFileSync(outPath, `${banner}${output}\n`, 'utf8');
  process.stdout.write(`${name}: ${output.split('\n').length} سطرًا → ${outPath}\n`);
}
