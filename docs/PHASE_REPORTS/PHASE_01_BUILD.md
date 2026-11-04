# تقرير بناء المرحلة ٠١ — تأسيس المشروع وهيكل الواجهة والجودة

**التاريخ:** 2026-11-04 · **الفرع:** `arena/f2a4f2de-teaching-wep` · **الحالة:** `READY_FOR_CHECK`
**شرط البداية:** المرحلة ٠٠ معتمدة — `A-06` في `docs/APPROVALS.md` ✅

---

## ١) النطاق المنفذ

| المهمة | ما نُفِّذ فعلًا | الحالة |
|---|---|---|
| تهيئة المشروع وفق الحزمة المعتمدة | `package.json` + `package-lock.json`، `type: module`، Node ≥ 20، بلا إطار عمل | ✅ |
| إعداد Supabase منعزل | `supabase/config.toml` + `migrations/0001_extensions.sql` + `seed.sql` | 📄 **مكتوبة، غير مطبَّقة** (BLOCKED — §٦) |
| Bootstrap RTL محلي + CSS/JS عامة | `public/assets/vendor/bootstrap/*` منسوخة من `node_modules`، `app.css` برموز الهوية | ✅ |
| عميل Supabase في المتصفح بمفتاح عام فقط | `config.js` + `supabase-client.js`؛ `validateConfig` يرفض `service_role` و`sb_secret_` | ✅ |
| صفحة صحة وصفحات دخول/خطأ + حارس واجهة | `health.html` (فحوص تُنفَّذ فعليًا)، `login.html` (شكلية معطّلة)، `403/404/500`، `auth-guard.js` | ✅ |
| ESLint + Stylelint + HTMLHint + Playwright + اختبارات وحدة + CI | كلها موجودة وتعمل، والـCI مكتوب | ✅ محليًا / ⏳ CI |
| توثيق التشغيل | `README.md` (تشغيل، أوامر، تحديث الأصول، الأمان، القيود) | ✅ |

**خارج النطاق ولم يُلمس:** المصادقة الحقيقية، قاعدة البيانات، الطلاب، المجموعات، الحضور، الدروس، الأسئلة، الامتحانات، التصدير.

## ٢) الملفات المنشأة والمعدَّلة (بأسمائها الفعلية)

```text
package.json · package-lock.json · .env.example · .gitignore · .editorconfig · README.md
eslint.config.js · .stylelintrc.json · .htmlhintrc · playwright.config.js

public/index.html
public/pages/health.html
public/pages/auth/login.html
public/pages/errors/{403,404,500}.html
public/assets/css/app.css
public/assets/js/{config,supabase-client,app,auth-guard,ui}.js
public/assets/js/components/{navbar,sidebar,toast,empty-state}.js
public/assets/vendor/bootstrap/{bootstrap.rtl.min.css,bootstrap.bundle.min.js}
public/assets/vendor/supabase/supabase.umd.js

supabase/config.toml · supabase/migrations/0001_extensions.sql · supabase/seed.sql
tests/unit/config.test.js · tests/e2e/smoke.spec.js

.github/workflows/ci.yml · .github/pull_request_template.md
docs/test-artifacts/{commands-local.log,http-smoke.txt,e2e-local-attempt.log}
docs/PHASE_REPORTS/PHASE_01_BUILD.md · PHASE_01_CHECK.md
معدّل: docs/{PROJECT_STATE,KNOWN_LIMITATIONS,DECISIONS,REQUIREMENTS_TRACEABILITY}.md
```

**تغييرات مخطط قاعدة البيانات:** مهاجرة واحدة `0001_extensions.sql` (إضافات + مخطط `app` غير مكشوف + `app.schema_meta`). **لم تُطبَّق** على أي قاعدة.

## ٣) طريقة التشغيل والتجربة

```bash
npm ci                              # تثبيت نظيف
npm run serve                       # http://0.0.0.0:4173  (public/ فقط)
```

- الصفحات: `/index.html` · `/pages/health.html` · `/pages/auth/login.html` · `/pages/errors/404.html`.
- المعاينة الحيّة في هذه الجلسة كانت على المنفذ ٤١٧٣ (خادم Python).
- **حسابات اصطناعية:** لا توجد. لا مصادقة في هذه المرحلة، وصفحة الدخول معطّلة عن قصد.
- **لا أسرار:** لا `.env` ولا مفاتيح في أي ملف؛ القيم تُحقن وقت النشر في وسوم `<meta>`.

## ٤) جدول أوامر الفحص (كلها شُغِّلت فعلًا في هذه الجلسة)

| # | الأمر | البيئة | exit | النتيجة | الدليل |
|---|---|---|---|---|---|
| 1 | `npm ci` | sandbox · Node 22.22.3 | 0 | تثبيت نظيف (٥٧٦ حزمة) | `commands-local.log` |
| 2 | `npm run lint:js` (ESLint) | sandbox | 0 | صفر أخطاء | `commands-local.log` |
| 3 | `npm run lint:css` (Stylelint) | sandbox | 0 | صفر أخطاء | `commands-local.log` |
| 4 | `npm run lint:html` (HTMLHint) | sandbox | 0 | ٦ ملفات، صفر أخطاء | `commands-local.log` |
| 5 | `npm run test:unit` | sandbox | 0 | **١٨/١٨ ناجحة، ٠ فاشلة** | `commands-local.log` |
| 6 | فحص الصفحات عبر HTTP (١١ مسارًا) | sandbox · خادم محلي | 0 | كلها **200** + علامات RTL/JS سليمة | `http-smoke.txt` |
| 7 | فحص الأسرار في `public/` (منطق CI نفسه) | sandbox | 0 | لا مفاتيح سرّية ولا JWT | `commands-local.log` |
| 8 | `git ls-files` مقابل `.env` و`node_modules` | sandbox | 0 | لا شيء متتبَّع | `commands-local.log` |
| 9 | `npx playwright install chromium` | sandbox | **1** | **فشل: تنزيل محجوب** | `e2e-local-attempt.log` |
| 10 | `npm run test:e2e` | sandbox | **1** | ٢٨ حالة لم تبدأ (لا متصفح) | `e2e-local-attempt.log` |
| 11 | CI (push) — `41915385283` | GitHub Actions · ubuntu-latest | **1** | متصفح ✅ / جودة ❌ (نمط grep خاطئ يعدّ `.env.example` ملف بيئة) | سجل التشغيل |
| 12 | CI (push) بعد الإصلاح — `41915567324` | GitHub Actions | **0** | **كلا الوظيفتين success** | سجل التشغيل |
| 13 | CI (PR #5) — `41915581320` | GitHub Actions | **0** | **success** — ٢٨ حالة Playwright نُفِّذت ونجحت | سجل التشغيل |

**تنبيه صدق:** البند ١٠ **فشل محليًا** ولم أنجح في تشغيله، ولا يُسجَّل نجاحًا. تعويضه الحقيقي هو البند ١٣: CI نفّذ ٢٨ حالة متصفح فعلية على Ubuntu ونجحت. الفرق مهم: النجاح جاء من بيئة تستطيع تشغيل المتصفح، لا من كلامي.

**الفشل الأول في CI (البند ١١) كان عيبًا حقيقيًا في سكربت الفحص** — النمط `\.env($|\.)` يطابق `.env.example` المشروع. أُصلح في commit `d6a9ac4` (`.env` الدقيق أو `.env.<local|production|…>` فقط)، وأُعيد التشغيل فنجح. هذا سلوك CI المطلوب: يكشف ثم يُصلح، لا يُخفى.

## ٥) فحص المرحلة مقابل معايير القبول

| المعيار | النتيجة | الدليل |
|---|---|---|
| تثبيت نظيف وتشغيل الموقع | ✅ | البند ١ + ٦ |
| صفحة صحية تعمل وتُظهر حالة حقيقية | ✅ | `health.html` يعرض ٥ فحوص منفَّذة، ومنها «غير منطبق» بصراحة |
| صفحات دخول/خطأ مناسبة | ✅ | ٤ صفحات، والدخول يعطّل كل حقول |
| دخان موبايل وكمبيوتر + RTL + تباين أولي | ✅ **في CI** | ٢٨ حالة (١٤ × مشروعان) نجحت في التشغيل `41915567324` و`41915581320` |
| مسارات محمية ترفض الزائر واجهيًا | ✅ | `auth-guard.js` — موثق أنه ليس حماية |
| لا وظائف أكاديمية وهمية | ✅ | لا زر ولا صفحة تدّعي عملًا غير موجود |
| CI يشغّل lint + وحدة + Playwright | ✅ **منفَّذ ونجح** | تشغيلان أخضران: `41915567324` (push) و`41915581320` (PR) |
| `public/` بلا `service_role` أو أسرار | ✅ | البند ٧ + خطوة CI مستقلة |

## ٦) بند BLOCKED الموثق

| البند | السبب | الأثر | ما يلزم |
|---|---|---|---|
| **تطبيق مهاجرة `0001` على قاعدة** | لا `supabase` CLI ولا Docker في بيئة التنفيذ، ولم يُصرَّح بإنشاء مشروع (A-06 لا يبيح ذلك) | `supabase/` ملفات صحيحة الشكل لكن **غير مختبرة بالتشغيل** | إذن العميل + بيئة تدعم Docker (المرحلة ٠٢) |
| ~~Playwright محليًا~~ | **مُعالَج بالتحويل إلى CI**: ٢٨ حالة نجحت هناك | — | — |

## ٧) القيود والمخاطر المتبقية

| # | القيد | المرجع |
|---|---|---|
| 1 | لا مصادقة حقيقية — الصفحة شكلية | L-26 |
| 2 | لا قاعدة بيانات مطبَّقة | L-27 |
| 3 | `config.toml` غير متحقق بتشغيل فعلي | L-28 |
| 4 | اختبار المتصفح محليًا غير متاح | L-29 |
| 5 | `auth-guard` تجربة استخدام فقط؛ الحماية الحقيقية RLS في ٠٢ | PERMISSIONS §١ |
| 6 | ملفات الخطوط العربية لم تُضف بعد — الصفحات تستخدم بدائل نظامية حتى تُورَّد الخطوط | `app.css` §٢ |
| 7 | صفحة الصحة لا تختبر قاعدة البيانات (لا وجود لها) | `health.html` |

## ٨) الحالة

**`READY_FOR_CHECK`** — بند `BLOCKED` واحد متبقٍ (تطبيق قاعدة البيانات)، و CI أخضر (push + PR).
المرحلة ٠١ **غير معتمدة**، ولا أعلن قبولها؛ القرار للعميل بعد فحص مستقل.
