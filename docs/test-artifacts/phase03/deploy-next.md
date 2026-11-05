# خطوة النشر التالية (بقية الدوال)

المرحلة ٠٣ في وضع `BLOCKED` والحائل الوحيد هو نشر بقية الدوال على بيئة الاختبار.
النشر من أداة التنفيذ يتطلب تمرير نص الحزمة كاملًا (٢٣–٢٨KB لكل دالة) عبر الموصل،
فصار النشر **دالة واحدة لكل دور** كما اختار العميل.

## حالة النشر على `wdqupfoznngqbyphjnie`

| الدالة | المصدر | بايتات الحزمة | sha256 (أول ١٦) | الحالة |
|---|---|---|---|---|
| `auth-login` | `supabase/functions/auth-login/index.js` | ٢٣٠٥٣ | `e8c853b0df8628a5` | **منشورة** (`version 2`، `verify_jwt=false`) |
| `invite-accept` | `supabase/functions/invite-accept/index.js` | ٢٧٩٧١ | `43dfac68968aa618` | التالية |
| `admin-teachers` | `supabase/functions/admin-teachers/index.js` | ٢٨٣١٤ | `1a301480bebb064b` | في الانتظار |
| `admin-instructions` | `supabase/functions/admin-instructions/index.js` | ٢٤٣١٧ | `df2412c0acc94acb` | في الانتظار |
| `auth-recovery` | `supabase/functions/auth-recovery/index.js` | — | — | في الانتظار |
| `workspace-select` | `supabase/functions/workspace-select/index.js` | — | — | في الانتظار |

**ملاحظة أمانة:** بصمات `sha256` أعلاه محسوبة على الحزم **المقصوصة** في `/tmp` (غير محفوظة في المستودع)،
فهي تُثبت مطابقة ما نُشر لما لُصق، ولا تُثبت أنه مطابق للمصدر إلا بإعادة توليد الحزمة بنفس السكربت.
إعادة التوليد الموثوقة هي `npm run bundle:functions` (بلا تقليص) — تحتاج الأدوات ولا تعمل في الصندوق بلا `node_modules`؛
لذلك يبقى التحقق القاطع من المطابقة عبر `.github/workflows/admin-journey.yml` أو تشغيل محلي.

## بيئة الاختبار الجاهزة

- ٣ متغيّرات: `RATE_LIMIT_SECRET` · `APP_ALLOWED_ORIGINS = http://localhost:4173,http://127.0.0.1:4173` · `APP_BASE_URL`.
- حسابان اصطناعيان: سوبر أدمن `+201000000901` · مدرس `+201000000902` (كلمة المرور `TestPass!234`، قيم اختبار فقط).
- صفحة الفحص: `docs/test-artifacts/phase03/login-probe.html` — تُقدَّم بـ
  `npx --yes serve -l 4173 docs/test-artifacts/phase03` ثم `http://localhost:4173/login-probe.html`.
