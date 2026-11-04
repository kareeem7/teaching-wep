# تقرير بناء المرحلة ٠١ — التأسيس

**التاريخ:** 2026-11-04 · **المنفّذ:** وكيل التنفيذ · **الفرع:** `arena/d20954b6-teaching-wep`
**الأساس:** اعتماد المرحلة ٠٠ (A-10) + اعتماد الهوية «مِنهاج» (A-11) + إذن مشروع Supabase سحابي (A-12).
**الحالة المعلنة:** `PARTIAL` — التفصيل في `PHASE_01_CHECK.md`.

---

## ١) ما أُنجز فعليًا

### أ) حزمة الواجهة

| البند | الحالة | الدليل |
|---|---|---|
| HTML5 + CSS3 + Bootstrap 5 RTL + ES Modules | ✓ | ٦ صفحات، `app.css`، `assets/js/*.js` كلها `type="module"` |
| لا Laravel / Inertia / React / Tailwind | ✓ | لا تبعية واحدة منها في `package.json` |
| Bootstrap RTL محلي بلا CDN | ✓ | `public/assets/vendor/bootstrap/` (بصمة `sha256` مسجلة) |
| عميل Supabase محلي واحد | ✓ | `supabase-client.js` + `assets/vendor/supabase/supabase.js` |
| RTL ولغة عربية | ✓ | `lang="ar" dir="rtl"` في كل صفحة، يتحقق منه HTMLHint واختبار E2E |
| مفتاح publishable فقط | ✓ | `config.js`؛ اختبار وحدة يفشل عند ظهور `sb_secret_` أو JWT بدور غير `anon` |

### ب) الصفحات

- `public/index.html` — صفحة رئيسية حقيقية: هوية، بطاقات، معلومات نسخة، رابط محمي يمرّ عبر الحارس.
- `public/pages/health.html` — **فحص حالة حقيقي**: حالة الشبكة + نداء `auth/v1/health` بزمن استجابة + زر إعادة فحص.
- `public/pages/auth/login.html` — هيكل صفحة الدخول. **الحقول معطّلة عن قصد**، والنموذج لا يُنشئ جلسة، ويعرض `next` القادم من الحارس.
- `public/pages/errors/{403,404,500}.html` — صفحات خطأ مستقلة تعرض الرمز ومسار عودة.

### ج) طبقة JavaScript

| الملف | المسؤولية | حدوده المعلنة |
|---|---|---|
| `config.js` | إعدادات مجمّدة + `validateConfig` + `appUrl` | لا يحمل أي سر |
| `supabase-client.js` | عميل مفرد (singleton) + `checkConnectivity` | لا يقرأ جداول أعمال في هذه المرحلة |
| `auth-guard.js` | `getSession` · `buildLoginUrl` · `redirectToLogin` · `requireSession` | **ليس حدًّا أمنيًا**؛ مكتوب صريحًا في أعلى الملف |
| `ui.js` | تنسيق أرقام/تواريخ `ar-EG` بتوقيت `Africa/Cairo`، حقن نصوص آمن، حالات انشغال | لا يبني HTML من مدخلات |
| `app.js` | تشغيل مشترك: الهوية، الشريط، التنقل النشِط، الروابط المحمية | نقطة واحدة لكل الصفحات |
| `components/` | navbar · sidebar · toast · empty-state | مكوّنات DOM بلا اعتماد على JS للـ Bootstrap |

### د) قاعدة البيانات (مشروع `teaching-wep` السحابي)

| المهاجرة | الأثر | مُطبَّقة؟ |
|---|---|---|
| `0001_extensions.sql` | `pgcrypto` + `citext` + `pg_trgm`، مخطط `app`، `app.set_updated_at()` | ✅ |
| `0002_platform_meta.sql` | `public.platform_meta` + trigger + RLS + سياسة قراءة عامة + سحب الكتابة | ✅ |

تحقق فعلي من قاعدة البيانات:

- `public.platform_meta`: `relrowsecurity = true`، سياسة واحدة (`SELECT` لـ `anon, authenticated`)، **صفر سياسة كتابة**.
- الصفوف: `default_locale=ar-EG` · `default_timezone=Africa/Cairo` · `phase=1` · `platform_name=مِنهاج`.
- سجل المهاجرات في `supabase_migrations.schema_migrations`: `0001_extensions` ثم `0002_platform_meta`.
- لا جدول طلاب/مدرّسين/امتحانات — مؤجّل عن قصد إلى مرحلة المخطط.
- `seed.sql` قابل للتكرار (`on conflict`) ولا يحوي شخصًا واحدًا.

---

## ٢) الشجرة الحقيقية المنشأة (كلها موجودة على القرص)

```text
.editorconfig
.env.example
.gitignore
.htmlhintrc
.stylelintrc.json
eslint.config.js
package.json
package-lock.json
playwright.config.js
.github/workflows/ci.yml
.github/pull_request_template.md
public/index.html
public/pages/health.html
public/pages/auth/login.html
public/pages/errors/{403,404,500}.html
public/assets/css/app.css
public/assets/js/{config,supabase-client,app,auth-guard,ui}.js
public/assets/js/components/{navbar,sidebar,toast,empty-state}.js
public/assets/vendor/bootstrap/bootstrap.rtl.min.css
public/assets/vendor/bootstrap/bootstrap.bundle.min.js
public/assets/vendor/supabase/supabase.js        (D-311)
supabase/config.toml
supabase/migrations/0001_extensions.sql
supabase/migrations/0002_platform_meta.sql       (D-312)
supabase/seed.sql
tests/unit/config.test.js
tests/unit/dom.test.js                           (D-312)
tests/e2e/smoke.spec.js
docs/test-artifacts/{commands.md,cmd-01..05.log,http-smoke.txt,vendor-sha256.txt}
docs/PHASE_REPORTS/PHASE_01_BUILD.md
docs/PHASE_REPORTS/PHASE_01_CHECK.md
```

ملفات معدّلة: `README.md` (كان سطرين، صار دليل تشغيل حقيقي)، `docs/DECISIONS.md` (D-310..D-316)،
`docs/SUPABASE_ARCHITECTURE.md` (§13 صار أرقامًا مثبَّتة)، `05-project-structure-ar.md`،
`docs/APPROVALS.md`، `docs/PROJECT_STATE.md`.

**لا ملفات فارغة ولا عناصر نائبة صامتة** — يتحقق منه اختبار وحدة على ٣٥ مسارًا ملزمًا.

---

## ٣) الالتزامات الملزمة وكيف قُوبلت

| الالتزام | كيف نُفِّذ |
|---|---|
| أسماء الملفات حرفية | كل الأسماء المطلوبة موجودة كما هي. الإضافات: `0002_platform_meta.sql`، `tests/unit/dom.test.js`، `assets/vendor/supabase/` — موثّقة في D-311/D-312 ومحدَّث بها ملف الهيكل في نفس الـ commit |
| لا `service_role` في `public/` | اختبار وحدة يمسح كل ملفات `public/` بحثًا عن مادة المفتاح نفسها (لا الكلمة في التعليقات) |
| الحارس لا يُغني عن RLS | منصوص في `auth-guard.js` و`login.html` و`README` وPR template |
| منطق الأعمال في الخادم | لا يوجد في هذه المرحلة أي منطق تصحيح/سحب/احتساب — لا في الخادم ولا في المتصفح. لم يُقلَّد شيء |
| بيانات تركيبية فقط | لا اسم شخص واحد في الكود أو الاختبارات أو `seed.sql` |
| بلا deploy وبلا شراء | لا نشر، المشروع تطويري، كل التبعيات مجانية |
| خادم على `0.0.0.0` | `npm run dev` = `http-server public -a 0.0.0.0 -p 4173` |
| تسجيل نتائج حقيقية فقط | جدول الأوامر في `PHASE_01_CHECK.md` مأخوذ من تشغيل فعلي، وE2E مسجّل **FAIL/BLOCKED** لا PASS |

---

## ٤) الانحرافات والحدود

1. **E2E لم يُشغَّل محليًا** — Chromium غير متاح والحزمة محجوبة (D-315). البديل المُنفَّذ: ٤ اختبارات DOM حقيقية بـ jsdom + فحص HTTP لـ ١٢ مسارًا.
2. **لا وصول شبكي إلى `supabase.co` من بيئة التنفيذ** (`000` في ٠٫٠٥ ث). لذلك لم أتحقق بنداء REST حقيقي من قراءة `anon` للجدول؛ التحقق تم عبر SQL على مستوى القاعدة. **يبقى هذا فحصًا مطلوبًا في المرحلة التالية أو في CI.**
3. **KaTeX غير مثبَّت** — يُثبَّت في مرحلة المحتوى الرياضي.
4. **حزمة supabase-js تُحمَّل UMD** داخل غلاف ESM (D-311) — تنازل معلن.
5. **لا مصادقة ولا أدوار** — المرحلة ٠٢. صفحة الدخول صرّحت بذلك بدل أن تتظاهر بالعمل.

---

## ٥) التالي

فحص مستقل للمرحلة ٠١. لن أبدأ المرحلة ٠٢ ولن أعلن `PASS` لنفسي.
