# تقرير بناء المرحلة ٠٢ — الهوية والصلاحيات وعزل مساحات المدرسين

**التاريخ:** ٢٠٢٦-١١-٠٥ · **الفرع:** `arena/9ab16995-teaching-wep` (فرع الجلسة؛ اسم `phase/02-identity-authorization` غير قابل للإنشاء — انظر §٩)
**الحالة المعلنة:** **`PARTIAL`** — الكود والمهاجرات والدوال والواجهة والاختبارات موجودة ومفحوصة نحويًا ومحليًا، لكن **لم تُطبَّق أي مهاجرة على قاعدة بيانات** ولم تُنشر أي دالة (BLOCKED، §٧).

> **ما لا يقوله هذا التقرير:** لا يقول إن المرحلة مقبولة، ولا إن RLS مُثبتة بالتشغيل. بوابة المرحلة تحتاج فحصًا مستقلًا على بيئة تدعم PostgreSQL.

---

## ١) النطاق المنفذ

| البند المطلوب في البرومبت | الحالة | الدليل في المستودع |
|---|---|---|
| دخول وخروج وإيقاف جلسات وسياسة كلمات مرور | ✅ منفّذ | `functions/auth-login` · `public/assets/js/auth.js` · `app.profiles.sessions_valid_after` + `app.is_active()` |
| تحديد معدل الطلبات | ✅ منفّذ (منطق + SQL ذرّي) | `_shared/rate-limit.js` · `app.rate_limit_hit` · `app.rate_limits` |
| دخول الطالب بالهاتف المعياري أو الكود | ✅ منفّذ | `normalizePhone` / `normalizeStudentCode` / `classifyIdentifier` + R-26 |
| دعوات المدرسين أحادية الاستخدام ومنتهية الصلاحية وإغلاق التسجيل العام | ✅ منفّذ | `app.invitations` + `app.consume_invitation` + `functions/invite-accept` (لا مسار تسجيل عام) |
| ربط الطالب بمدرس عبر دعوة وموافقة لا بحث بالهاتف | ✅ منفّذ | `kind='student_link'` + `svc_link_student_profile` (لا واجهة بحث عن حسابات) |
| مساحة المدرس وملفات الطلاب المحلية وعضويات المساعد والمجموعات | ✅ منفّذ | `0003_teacher_workspaces.sql` |
| سياسات وصول على الخادم + وصول إداري للقراءة فقط | ✅ منفّذ | `0005_rls_identity.sql` (لا سياسة كتابة أكاديمية للسوبر أدمن) |
| استعادة الدخول بتحقق وتدقيق وإبطال جلسات وإشعارات | ✅ منفّذ جزئيًا | `functions/auth-recovery` + `app.recovery_tokens` + `app.audit_events`. **الإشعار الداخلي لم يُبنَ** (لا مركز إشعارات قبل المرحلة ٠٧) |
| مصادقة ثنائية للسوبر أدمن **إن اعتُمدت** | ⛔ خارج النطاق | لم تُعتمد بعد (R-09 معلّق)، ولا تُفترض. مذكورة كبند تحقق في المرحلة ٠٣ |
| أساس سجل تدقيق للأحداث الأمنية | ✅ منفّذ | `app.audit_events` (append-only بمشغّل يمنع التعديل والحذف) + `app.audit()` |

### غير منفّذ بقرار صريح

| البند | لماذا |
|---|---|
| `assistant_invite` (قبول دعوة مساعد) | الشاشات والتدفق تخص المرحلة ٠٤؛ النوع موجود في المخطط ويُرفض بوضوح في `invite-accept` بدل ادّعاء الدعم |
| مركز إشعارات داخلي | يحتاج جدول + شاشة (المرحلة ٠٧)، والبرومبت يطلب «إشعار عند اللزوم» — سُجِّل كقيد L-36 |
| المصادقة الثنائية | R-09 «إن اعتُمدت»؛ غير معتمدة حتى الآن |
| البحث عن حساب بالهاتف | **مرفوض أمنيًا** في هذه المرحلة (يكشف وجود الحسابات) |

---

## ٢) الملفات المنشأة والمعدلة (بأسمائها الفعلية)

```text
supabase/migrations/0002_identity_profiles.sql      ← جديد: الأنواع، profiles، teachers، دوال السياق
supabase/migrations/0003_teacher_workspaces.sql     ← جديد: student_profiles، العضويات، صلاحيات المساعد، المجموعات
supabase/migrations/0004_invitations_recovery.sql   ← جديد: الدعوات، الاستعادة، حدّ المعدل الذرّي، التدقيق
supabase/migrations/0005_rls_identity.sql           ← جديد: RLS على ١١ جدولًا + منح + دوال خدمة + واجهات قراءة

supabase/functions/_shared/cors.js                  ← جديد: سماح دفاعي، رفض Origin غير المعلن
supabase/functions/_shared/auth.js                  ← جديد: تطبيع الهاتف/الكود، سياسة كلمة المرور، HMAC للرموز، سياسة الجلسة، طبقة الطلب
supabase/functions/_shared/db.js                    ← جديد: عميل REST مصغّر + Auth الإدارية، بلا تسريب مفاتيح
supabase/functions/_shared/errors.js                ← جديد: غلاف أخطاء موحد + حجب الأسرار من السجلات
supabase/functions/_shared/rate-limit.js            ← جديد: حدود AUTH_DESIGN §٤ + نداء الدالة الذرّية

supabase/functions/auth-login/index.js              ← جديد: دخول موحّد (هاتف/كود) + حدّ معدل + تدقيق
supabase/functions/auth-recovery/index.js           ← جديد: إصدار رمز استعادة + إكماله وإبطال الجلسات
supabase/functions/invite-accept/index.js           ← جديد: قبول دعوة مدرس/ربط طالب مع استهلاك ذرّي وتعويض
supabase/functions/workspace-select/index.js        ← جديد: مساحات المستخدم من الخادم فقط

public/pages/auth/login.html                        ← مُعدَّلة: من صفحة شكلية إلى نموذج حقيقي
public/pages/auth/accept-invitation.html            ← جديد
public/pages/auth/request-recovery.html             ← جديد
public/pages/auth/reset-password.html               ← جديد
public/pages/auth/select-workspace.html             ← جديد

public/assets/js/auth.js                            ← جديد: دخول/دعوة/استعادة + تهيئة الصفحات
public/assets/js/workspace.js                       ← جديد: اختيار المساحة وتخزينها بأمان
public/assets/js/api.js                             ← جديد: نداء الدوال، مهلة، تحويل الأخطاء لرسائل عربية
public/assets/js/app.js                             ← مُعدَّل: سجل تهيئة صفحة حسب data-page
public/assets/css/app.css                           ← مُعدَّلة: حالات النماذج (§١٢)

tests/sql/identity_rls.test.sql                     ← جديد: ٣٧ حالة pgTAP للعزل (لم تُنفَّذ — BLOCKED)
tests/unit/token-hash.test.js                       ← جديد: ٢٧ اختبارًا لأوليّات الهوية وحدّ المعدل
tests/e2e/auth.spec.js                              ← جديد: ١٧ حالة واجهة مصادقة
tests/e2e/workspace-isolation.spec.js               ← جديد: ٧ حالات عزل واجهة
tests/e2e/smoke.spec.js                             ← مُعدَّل: حالة الدخول تتوافق مع تفعيل المرحلة ٠٢

eslint.config.js                                    ← مُعدَّل: بيئة Edge Functions (Response/crypto/Deno)
docs/DECISIONS.md                                   ← مُعدَّل: R-25…R-29
docs/PHASE_REPORTS/PHASE_02_BUILD.md , PHASE_02_CHECK.md
docs/test-artifacts/phase02/*                       ← أدلة الفحص غير الحساسة
```

**أسماء لم تُغيَّر ولم تُحذف.** لم تُضَف ملفات خارج قائمة المرحلة إلا تعديلات على ملفات قائمة (`app.js`, `app.css`, `eslint.config.js`, `smoke.spec.js`, وثائق).

---

## ٣) تغييرات قاعدة البيانات

### جداول (كلها `RLS ENABLED`)

| الجدول | الغرض | قيود جوهرية |
|---|---|---|
| `app.profiles` | هوية كل مستخدم | `phone_e164` فريد جزئي · `student_code` فريد جزئي · `sessions_valid_after` · مشغّل يمنع تغيير الدور/المعرّفات من جلسة مستخدم |
| `app.teachers` | ملف المدرس | ١─١ مع profiles |
| `app.student_profiles` | الملف الأكاديمي المحلي | فريد `(teacher_id, local_code)` · فريد `(teacher_id, user_id)` عند النشاط · لا حذف (أرشفة) |
| `app.teacher_memberships` | عضوية المساحة | فريد `(teacher_id, user_id)` |
| `app.assistant_permissions` | صلاحيات المساعد | مفتاح مركّب + نطاق مجموعات `uuid[]` |
| `public.groups` / `public.group_memberships` | المجموعات | فريد الاسم داخل السنة · عضوية سارية واحدة |
| `app.invitations` | دعوات | `token_hash` فريد · انتهاء إلزامي · استخدام واحد · نوع يُفحص |
| `app.recovery_tokens` | استعادة | بصمة فقط · سبب إلزامي · ٣٠ دقيقة |
| `app.rate_limits` | عدّادات | مفتاح مُبصم + نافذة ثابتة |
| `app.audit_events` | تدقيق | **append-only**: مشغّل يرفض UPDATE/DELETE |

### دوال حاكمة
`app.is_active()` (نشاط + `iat >= sessions_valid_after`) · `app.is_super_admin()` · `app.is_workspace_teacher(uuid)` · `app.assistant_can(uuid, text, uuid)` · `app.consume_invitation(...)` (قفل صف + تحقق + استهلاك) · `app.consume_recovery_token(text)` · `app.invalidate_sessions(uuid)` · `app.rate_limit_hit(text,int,int)` (ذرّية) · `app.audit(...)`

### أغلفة خدمة مغلقة (`public.svc_*`)
مغلقة على `service_role` فقط (`revoke` من `anon/authenticated`)، لأن مخطط `app` غير مكشوف في PostgREST (R-27): `svc_profile_context` · `svc_workspaces` · `svc_invitation_state` · `svc_accept_identity` · `svc_link_student_profile` · `svc_create_recovery_token` · `svc_recovery_target` · `svc_consume_invitation` · `svc_consume_recovery` · `svc_invalidate_sessions` · `svc_rate_limit_hit` · `svc_audit`.

### واجهات قراءة للمتصفح
`public.me` · `public.my_workspaces` · `public.my_students` — كلها `security_invoker = true` فتمرّ على RLS.

---

## ٤) طريقة التشغيل والتجربة

### أ) الواجهة (متاح الآن بلا قاعدة بيانات)

```bash
npm ci
npm run serve            # python3 -m http.server 4173 --bind 0.0.0.0 --directory public
# ثم:  http://<host>:4173/pages/auth/login.html
```
الواجهة تعمل، لكن عند الإرسال ستظهر رسالة صريحة **«خدمة الخادم غير منشورة»** لأن الدوال غير منشورة. هذا سلوك مقصود: لا نجاح وهمي.

### ب) تطبيق المهاجرات (يحتاج بيئة PostgreSQL — غير متاح حاليًا)

```bash
# بيئة تطوير/اختبار منعزلة فقط، وبعد إذن العميل بمشروع Supabase:
supabase link --project-ref <DEV_REF>
supabase db push                       # يطبق 0001…0005 بالترتيب
psql "$DEV_DATABASE_URL" -f tests/sql/identity_rls.test.sql   # اختبارات العزل
```

### ج) متغيرات بيئة الدوال (أسماء فقط، لا قيم في المستودع)

`SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` · `RATE_LIMIT_SECRET` (≥ ٣٢ محرفًا) · `APP_ALLOWED_ORIGINS` (قائمة أصول مفصولة بفاصلة)

### د) حسابات اصطناعية عند التجربة (لا بيانات حقيقية)

| الحالة | كيف تُنشأ يدويًا على بيئة الاختبار |
|---|---|
| سوبر أدمن | صف في `app.profiles` بدور `super_admin` عبر `psql` (لا واجهة بعد — المرحلة ٠٣) |
| مدرس | دعوة `teacher_invite` في `app.invitations` ببصمة رمز تصنعها أنت، ثم فتح `accept-invitation.html?token=…` |
| طالب | ملف محلي `pending_link` + دعوة `student_link` ثم نفس الصفحة |

> لا أسماء ولا كلمات مرور جاهزة في المستودع. أي رمز تجربة يُنشأ وقت التجربة ويُستهلك.

---

## ٥) جدول أوامر الفحص (نتائج حقيقية)

| # | الأمر | البيئة | الوقت | Exit | النتيجة | الدليل |
|---|---|---|---|---|---|---|
| 1 | `npm ci` | محلي | ثانية | 0 | ١٧٤ حزمة | — |
| 2 | `npx eslint .` | محلي | ٢ث | 0 | ٠ خطأ | `phase02/lint.txt` |
| 3 | `npx stylelint "public/assets/css/**/*.css"` | محلي | ١ث | 0 | ٠ خطأ | نفسه |
| 4 | `npx htmlhint "public/**/*.html"` | محلي | ١ث | 0 | ١١ ملفًا، ٠ خطأ | نفسه |
| 5 | `node --test` | محلي | ٣ث | 0 | **٥٢/٥٢** (٢٥ من ٠١ + ٢٧ جديد) | `phase02/unit-and-e2e-list.txt` |
| 6 | `npx playwright test --list` | محلي | ٢ث | 0 | **٨٤ حالة** (٤٢ × مشروعان) | نفسه |
| 7 | `npx playwright test` | محلي | — | — | **غير منطبق**: لا متصفح في البيئة (L-29) | — |
| 8 | `pglast` (محلل PostgreSQL الحقيقي) على ٥ مهاجرات + ملف الاختبار | محلي | ٢ث | 0 | كلها تُحلَّل، ٢١٩ عبارة | `phase02/sql-parse.txt` |
| 9 | `gh run watch` — التشغيل `41927868113` | CI | ~٢د | 0 | الوظيفتان **نجاح** | GitHub Actions |
| 10 | `psql -f tests/sql/identity_rls.test.sql` | PostgreSQL | — | — | **لم يُنفَّذ**: لا قاعدة ولا Docker ولا CLI | — |
| 11 | استنساخ نظيف + إعادة كل ما سبق + ١٠ مسارات HTTP | محلي | ٥ث | 0 | كل الملفات 200 · POST على مسار الدوال = 501 (لا خدمة) | `phase02/clean-room.txt` |

**دورات CI أثناء المرحلة:** `41926439186` ❌ (اختبار قديم + رقم مرجع ناقص) → `41927403943` ❌ (عزل الواجهة) → `41927868113` ✅. الأسباب الحقيقية لكل فشل موثقة أدناه في §٦.

---

## ٦) فحص المرحلة — بندًا ببند (الحقيقة كما هي)

| الفحص المطلوب | ما نُفِّذ فعلًا | الحالة |
|---|---|---|
| **روابط دعوة منتهية/مستخدمة/لغرض آخر تُرفض** | منطق `checkTokenState` + `app.consume_invitation` (ترفض `expired`/`used`/`wrong-kind`) + ٤ حالات في `identity_rls.test.sql` + حالات واجهة | **مكتوب ومحلَّل نحويًا** · **لم يُنفَّذ على قاعدة** ⇒ غير مُثبت |
| **تسجيل مدرس بلا دعوة يُرفض** | لا مسار تسجيل عام أصلًا؛ `invite-accept` يرفض رمزًا غير صالح أو نوعًا غير مدعوم (اختُبر بالنداء الفعلي: 400/422) | ✅ مثبت على مستوى الدالة بلا قاعدة (نداء مباشر في §٥ سطر ٥ الملاحظة أدناه) |
| **هاتف/كود مكرر لا ينشئ هويتين، والرسائل لا تكشف معلومات** | فهرسان فريدان + `profiles_identifier_required` + رسالة دخول موحدة `INVALID_CREDENTIALS` | مقيّد في المخطط · **لم يُنفَّذ على قاعدة** |
| **طالب مرتبط بمدرسين يختار المساحة ولا تنتقل الصلاحيات** | `svc_workspaces` + `workspace-select` + ٧ حالات عزل واجهة (منها: رابط `?teacher_id=` لا يضيف مساحة، ورد فيه بيانات زائدة لا يُرسم) | ✅ مثبت في الواجهة · `identity_rls` يغطي الخادم (غير مُنفَّذ) |
| **تغيير كلمة المرور يبطل الجلسات، والمدرس لا يقرأ الكلمة** | `invalidate_sessions` + `signOutGlobal` + عمود `sessions_valid_after` + حرمان قراءة `auth.users` · لا مسار يعيد كلمة المرور | مكتوب · **لم يُنفَّذ** |
| **إيقاف الحساب يمنع الوصول الجديد والقديم** | `app.is_active()` تُستخدم في كل سياسة + فحص في `auth-login` و`workspace-select` | مكتوب · حالتان في `identity_rls` · **لم يُنفَّذ** |
| **اختبار تخمين الدخول والاستعادة ومعدلات الطلب** | `LIMITS` مطابقة لـ§٤ + ٤ حالات وحدة (٥/١٥د، ٢٠/س، ٣/س، ٥/يوم، ١٠/س) + `app.rate_limit_hit` ذرّي | ✅ مثبت على مستوى المنطق · **لم يُنفَّذ على قاعدة** |

### ما جرى فعليًا من نداءات الدوال (بلا قاعدة بيانات)

| النداء | النتيجة الحقيقية |
|---|---|
| `auth-login` بلا إعداد | `503 SERVICE_NOT_CONFIGURED` |
| `auth-login` بـ`GET` | `405 METHOD_NOT_ALLOWED` |
| `auth-login` من أصل غير معلن (`OPTIONS`) | `403` |
| `auth-recovery` برمز قصير | `400 RECOVERY_INVALID` |
| `auth-recovery` بكلمة مرور ضعيفة | `422 WEAK_PASSWORD` |
| `auth-recovery` طلب استعادة بلا جلسة | `401 INVALID_SESSION` |
| `workspace-select` برمز غير JWT | `401 INVALID_SESSION` |

### فحص تراكمي (المرحلة ٠١)

- ✅ `smoke.spec.js` كلها ناجحة في CI (`41927868113`) بعد **تعديل مقصود** لحالة كانت تتحقق من «حقول الدخول معطّلة» — صار الواقع أن الدخول مفعّل. التعديل مسجّل في التعليق داخل الملف، ولم يُحذف أي فحص آخر.
- ✅ ٢٥ اختبار وحدة من المرحلة ٠١ ما زالت تعمل.
- ✅ الصفحة المحمية وهيكل الدور من إصلاح H-01/H-02 يعملان كما هما (٨٤ حالة متصفح في CI تشملهما).

### أخطاء ظهرت في CI وأُصلحت (مسجلة كي لا تتكرر)

| الدورة | الفشل | السبب الحقيقي | الإصلاح |
|---|---|---|---|
| `41926439186` | ٣ حالات | (١) `select-workspace` تُحوّل بلا جلسة فأفسدت حلقة «تفتح بلا أخطاء» (٢) رسالة «10 محارف» بأرقام لاتينية مقابل توقّع عربي (٣) تحقق قديم من تعطيل حقول الدخول | استبعاد الصفحة المحوِّلة من الحلقة · مطابقة الأرقام بأي صيغة · تحديث الحالة القديمة |
| `41927403943` | حالات عزل | مرجع مشروع **١٩** حرفًا في الجلسة المحاكاة (القاعدة تطلب ٢٠) فاعتُبر الإعداد غير صالح | `e2e` + ١٧ محرفًا = ٢٠ |
| `41927868113` | — | (ناجح) | — |

---

## ٧) القيود والمخاطر المتبقية

| # | القيد | الأثر | المرجع |
|---|---|---|---|
| 1 | **لا قاعدة بيانات مطبَّقة** — لا PostgreSQL ولا Docker ولا Supabase CLI، ولم يُصرَّح بمشروع | **RLS لم تُختبر بالتشغيل**، و٣٧ حالة pgTAP و٤ مهاجرات بلا تنفيذ. هذا أخطر ما في المرحلة | L-27، M-04 |
| 2 | الدوال لم تُنشر | `supabase functions deploy` يحتاج مشروعًا؛ الواجهة تعطي رسالة صريحة بدل نجاح وهمي | L-34 |
| 3 | المصادقة الثنائية لم تُنفَّذ | R-09 معلّقة ولم تُعتمد | §١ |
| 4 | الإشعار الداخلي بعد الاستعادة غير موجود | يُحتاج مركز إشعارات (المرحلة ٠٧) | L-36 |
| 5 | خطر الاستعادة المتبقي | من يحتجز الهاتف/الكود قد يطلب استعادة عبر مدرس؛ العلاج: سبب إلزامي + تدقيق + ٣٠ دقيقة + إبطال جلسات | C-32 |
| 6 | لا إشعارات فورية للإيقاف | التوكن يبقى صالحًا حتى `exp` (ساعة)، والرفض يحدث في كل طلب عبر `is_active()` | AUTH_DESIGN §٥ |
| 7 | لا متصفح محليًا | ٨٤ حالة تُثبت في CI فقط | L-29 |
| 8 | تحقق SQL نحوي فقط | `pglast` يثبت الصياغة لا الدلالة ولا السياسات | §٥ سطر ٨ |

---

## ٨) الحالة

**`PARTIAL`**

- **ما يجعله ليس `BLOCKED`:** كل ما يمكن بناؤه وفحصه بلا قاعدة بيانات موجود ويعمل: ٥٢ اختبار وحدة، ٨٤ حالة متصفح خضراء في CI،٢٢٠+ عبارة SQL تُحلَّل بمحلل PostgreSQL الحقيقي، وأربع دوال تتصرف بصدق عند غياب الإعداد.
- **ما يجعله ليس `READY_FOR_CHECK`:** بوابة المرحلة تشترط **صفر اختبارات عزل فاشلة** ولا عيب أمني عالٍ. لا يمكن قول ذلك عن RLS **لم تُشغَّل ولو مرة**. من يقول غير ذلك يخالف البند ٨ من طريقة التنفيذ.
- **ما يلزم لرفعه:** بيئة PostgreSQL منعزلة + إذن العميل بمشروع تطوير ⇒ `supabase db push` ⇒ `psql -f tests/sql/identity_rls.test.sql` ⇒ ٣٧/٣٧ ⇒ نشر الدوال على بيئة تطوير ⇒ إعادة تشغيل حالات CI.

---

## ٩) نقاط استئناف لو انقطعت الجلسة

1. الفرع: `arena/9ab16995-teaching-wep` — مدفوع، وآخر تشغيل CI أخضر `41927868113`.
2. المتبقي الحقيقي: (أ) تطبيق المهاجرات على بيئة معزولة، (ب) تشغيل `identity_rls.test.sql`، (ج) نشر الدوال، (د) فحص مستقل للمرحلة.
3. لا تكرر ما نجح: لا تعِد كتابة المهاجرات من الصفر — الفحص النحوي يمرّ، والمطلوب **تنفيذ** لا إعادة صياغة.
4. عند الخطأ في `identity_rls`: أول ما يُراجع هو سياسات `app.profiles` و`public.my_students`، ثم `app.is_active()`.
5. لا تبدأ المرحلة ٠٣.
