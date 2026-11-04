# مِنهاج

منصة تساعد المدرّس على إدارة طلابه ومجموعاته وحضوره ودرجاته ودروسه وامتحاناته.
ليست سوق كورسات، وليست نظام إدارة سناتر متعدد الإدارات.

**الحالة الحالية: المرحلة ٠١ — التأسيس.** الواجهة الثابتة والجودة تعمل، ولا توجد بعد
مصادقة حقيقية ولا قاعدة بيانات ولا وظائف أكاديمية. لا تدّعي هذه النسخة غير ذلك.

## التشغيل السريع

```bash
npm ci            # تثبيت نظيف
npm run serve     # خادم ثابت على http://0.0.0.0:4173  (public/ فقط)
```

ثم افتح `/index.html` أو `/pages/health.html` أو `/pages/auth/login.html`.

## الأوامر

| الأمر | ما يفعله |
|---|---|
| `npm run serve` | خادم ملفات ثابت (Python) على المنفذ ٤١٧٣ |
| `npm run lint:js` | ESLint على كل المستودع |
| `npm run lint:css` | Stylelint على `public/assets/css/` |
| `npm run lint:html` | HTMLHint على كل الصفحات |
| `npm run lint` | الثلاثة معًا |
| `npm run test:unit` | اختبارات وحدة (node:test) |
| `npm run test:e2e` | اختبارات Playwright (تحتاج تثبيت Chromium) |
| `npm run check` | lint + اختبارات الوحدة |

## البنية

```
public/                 الواجهة الثابتة (تُخدم كما هي، بلا بناء)
  index.html            الصفحة الرئيسية
  pages/health.html     فحوص تُنفَّذ في المتصفح
  pages/auth/login.html صفحة دخول شكلية (تُفعَّل في المرحلة ٠٢)
  pages/errors/         403 · 404 · 500
  assets/css/app.css    رموز الهوية المعتمدة (DECISIONS §هـ-١)
  assets/js/            config · supabase-client · auth-guard · ui · app + components/
  assets/vendor/        Bootstrap 5 RTL وSupabase — نسخ محلية، بلا CDN
supabase/               config.toml · migrations/ · seed.sql  (لا يُطبَّق تلقائيًا)
tests/unit | tests/e2e  اختبارات الوحدة والمتصفح
docs/                   القرارات والتقارير والنماذج
```

## تحديث الأصول المحلية

الأصول لا تُحمَّل من CDN. لتحديثها بعد تغيير الإصدارات في `package.json`:

```bash
npm ci
cp node_modules/bootstrap/dist/css/bootstrap.rtl.min.css            public/assets/vendor/bootstrap/bootstrap.rtl.min.css
cp node_modules/bootstrap/dist/js/bootstrap.bundle.min.js           public/assets/vendor/bootstrap/bootstrap.bundle.min.js
cp node_modules/@supabase/supabase-js/dist/umd/supabase.js          public/assets/vendor/supabase/supabase.umd.js
```

## الإعداد

لا تُدفع أي قيم. انسخ `.env.example` إلى `.env` (مُستبعَد من Git) عند الحاجة،
ثم احقن القيم العامة في وسوم `<meta name="minhaj-supabase-url">` و`<meta name="minhaj-supabase-key">`
وقت النشر. **المتصفح لا يحصل إلا على publishable/anon key.**

## Supabase

`supabase/config.toml` مهيأ لبيئة تطوير منعزلة، و`migrations/0001_extensions.sql` جاهزة،
لكن **لم تُطبَّق هنا**: لا يوجد Supabase CLI ولا Docker في بيئة التنفيذ الحالية،
ولم يُصرَّح بإنشاء مشروع Supabase. تُطبَّق في المرحلة ٠٢ بعد إذن العميل.

## الأمان

- كل الصلاحيات تُفرض على الخادم (RLS/دوال) — الحارس في المتصفح تجربة استخدام فقط.
- `public/` ممنوع أن يحتوي `service_role` أو `sb_secret_` أو أي سر. CI يفشل إن ظهر.
- لا بيانات طلاب حقيقية في أي بيئة تطوير أو اختبار.

## القيود المعروفة

انظر `docs/KNOWN_LIMITATIONS.md`. أهمها الآن: لا مصادقة، لا قاعدة بيانات مطبقة،
واختبارات المتصفح تُشغَّل في CI فقط لأن تنزيل Chromium محجوب في بيئة العمل المحلية.
