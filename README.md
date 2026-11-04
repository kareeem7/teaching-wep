# مِنهاج — منصة إدارة المدرّسين والطلاب

منصة ويب لإدارة المدرّسين والطلاب والحضور والامتحانات.
الواجهة HTML5 + CSS3 + Bootstrap 5 RTL + JavaScript (ES Modules)، والخدمات الخلفية على Supabase
(PostgreSQL + Auth + Storage + Edge Functions + RLS).

> **حالة المشروع: المرحلة ٠١ (تأسيس).** الواجهة هيكل حقيقي يعمل، لكن لا توجد مصادقة بعد
> ولا جداول أعمال ولا بيانات حقيقية. صفحة الدخول **غير مفعّلة عن قصد**.

## المتطلبات

- Node.js 20 أو أحدث (المُختبَر: 22.x) و npm.
- لا حاجة إلى Docker للتطوير على الواجهة؛ الواجهة ثابتة وتُخدم بخادم ملفات محلي.

## التشغيل المحلي

```bash
npm ci
npm run dev          # http://0.0.0.0:4173 → افتح /index.html
```

الخادم يخدم مجلد `public/` فقط. لا يوجد خطوة بناء (no build step): ما يُرفع هو نفسه ما يُختبر.

## الأوامر

| الأمر | الوظيفة |
| --- | --- |
| `npm run dev` | خادم ملفات ثابت على المنفذ 4173 مرتبط بـ 0.0.0.0 |
| `npm run lint:js` | ESLint على كل ملفات JavaScript |
| `npm run lint:css` | Stylelint على `public/assets/css` |
| `npm run lint:html` | HTMLHint على صفحات `public/` |
| `npm run test:unit` | اختبارات الوحدة بمشغّل Node المدمج |
| `npm run test:e2e` | اختبارات Playwright (سطح مكتب + جوال) |
| `npm run check` | كل ما سبق بالتسلسل |

## هيكل المشروع

```text
public/
  index.html                     الصفحة الرئيسية
  pages/health.html              فحص حالة حقيقي (شبكة + إعدادات)
  pages/auth/login.html          هيكل صفحة الدخول — غير مفعّل (المرحلة ٠٢)
  pages/errors/{403,404,500}.html
  assets/css/app.css             متغيّرات الهوية D-111 وتجاوزات RTL
  assets/vendor/bootstrap/       Bootstrap 5.3.8 RTL (منسوخ من npm)
  assets/vendor/supabase/        supabase-js 2.119.0 (UMD منسوخ من npm)
  assets/js/config.js            الإعدادات العامة (مفتاح publishable فقط)
  assets/js/supabase-client.js   العميل المفرد + فحص الاتصال
  assets/js/auth-guard.js        حارس واجهة أولي (لا يغني عن RLS)
  assets/js/app.js               نقطة التشغيل المشتركة
  assets/js/components/          navbar · sidebar · toast · empty-state
supabase/
  config.toml                    إعدادات التشغيل المحلي (مرجع للمطورين)
  migrations/0001_extensions.sql الامتدادات + مخطط app + الدوال المشتركة
  migrations/0002_platform_meta.sql جدول إعدادات العرض في public مع RLS
  seed.sql                       بيانات تركيبية فقط
tests/unit · tests/e2e
docs/                            الدستور والتقارير والقرارات
```

## إيقاف الخدمات وتنظيفها

| ماذا | كيف |
| --- | --- |
| إيقاف خادم الملفات المحلي | `Ctrl + C` في الطرفية التي تشغّل `npm run dev`، أو إن كان في الخلفية: `pkill -f http-server` |
| التأكد أن المنفذ فُرِّغ | `lsof -i :4173` (يجب ألا يعرض شيئًا) |
| تنظيف مخرجات الاختبار | `rm -rf test-results playwright-report docs/test-artifacts/screenshots` (كلها في `.gitignore`) |
| إيقاف Supabase محليًا | `supabase stop` — **غير متاح في هذه البيئة**، انظر أدناه |

## Supabase محليًا — الحد المعلن

`supabase/config.toml` موجود كمرجع للتشغيل المحلي على جهاز فيه **Docker + Supabase CLI**.
بيئة التنفيذ الحالية **بلا Docker وبلا CLI**، لذلك:

- لا يمكن تشغيل `supabase start` ولا تطبيق المهاجرات محليًا.
- بيئة التطوير هي مشروع Supabase سحابي مخصص للتطوير فقط (D-310)، والمهاجرات تُطبَّق عليه بالترتيب.
- أي عمل يحتاج قاعدة محلية منعزلة (مثل `supabase db reset`) **ممنوع** على المشروع السحابي، ومسجّل `BLOCKED` حتى يتوفر Docker.

## لقطات الواجهة

تُنتَج آليًا داخل CI (سطح مكتب + موبايل) وتُرفع مع مخرجات التشغيل باسم `playwright-artifacts`
تحت المسار `docs/test-artifacts/screenshots/`. لا تُودَع في Git.

## الأمان — قواعد غير قابلة للتفاوض

1. **مفتاح واحد فقط يُسمح به في المتصفح**: المفتاح القابل للنشر (publishable).
   لا `service_role` ولا `sb_secret_` داخل `public/` — واختبار الوحدة يفشل تلقائيًا إن ظهر أحدهما.
2. **RLS هي الحماية، لا الواجهة.** `public/assets/js/auth-guard.js` تحسين تجربة فقط؛
   إخفاء زر أو تعطيله ليس أمانًا.
3. **منطق الأعمال الحسّاس في الخادم**: التصحيح، اختيار الأسئلة، والسحب العشوائي لا تُنفَّذ في JavaScript المتصفح.
4. **لا بيانات أشخاص حقيقية** في الكود أو الاختبارات أو `seed.sql`.
5. `.env` لا يُرفع؛ `.env.example` نموذج بلا أسرار.

## قاعدة البيانات

- المهاجرات في `supabase/migrations/` وتُطبَّق بالترتيب الرقمي.
- `0001_extensions.sql`: `pgcrypto` + `citext` + `pg_trgm`، مخطط `app`، دالة `app.set_updated_at()`.
- `0002_platform_meta.sql`: جدول `public.platform_meta` مع RLS (قراءة عامة، بلا كتابة من المتصفح).
- `seed.sql` قابل للتكرار (`on conflict`) ويحتوي إعدادات عرض فقط.
- لا توجد جداول طلاب/مدرّسين/امتحانات في هذه المرحلة — تُبنى في مرحلة المخطط بعد اعتمادها.

## المراجع

- الدستور: `docs/CONSTITUTION.md` · الهيكل: `docs/05-project-structure-ar.md`
- القرارات: `docs/DECISIONS.md` (D-111 الهوية، D-310 مشروع Supabase، D-311 أدوات التطوير)
- تقرير المرحلة: `docs/PHASE_REPORTS/PHASE_01_BUILD.md` و`PHASE_01_CHECK.md`
- الاعتمادات: `docs/APPROVALS.md`

الترخيص: خاص — جميع الحقوق محفوظة لصاحب المشروع (`kareeem7`).
