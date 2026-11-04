# نموذج البيانات والعلاقات — DATA_MODEL

**الحالة:** تصميم أولي ملزم (يُترجم إلى `migrations` في المراحل ٠٢–١٠) · **آخر تحديث:** 2026-11-04
**لا يوجد سكيما منفَّذ الآن** — هذه المرحلة لا تنشئ قاعدة بيانات (P-01).

## ١) المخططات

| المخطط | الاستخدام | مكشوف عبر API؟ |
|---|---|---|
| `auth` | يدير Supabase Auth الهويات (`auth.users`) | لا (إلا نقاط Auth) |
| `app` | منطق المنصة: العضويات، الصلاحيات، التدقيق، الدوال | **لا** — غير مكشوف |
| `public` | الجداول التي تقرأها الواجهة تحت RLS | نعم |
| `extensions` | `pgcrypto`, `citext`, `pg_trgm` | لا |

**قاعدة:** كل ما هو «منطق» في `app`، وكل ما هو «بيانات تُقرأ من المتصفح» في `public` مع RLS. هذا يقلل سطح الهجوم ويجعل سياسات `public` واضحة.

## ٢) الكيانات

### أ) الهوية والوصول

| الجدول | أهم الحقول | القيود |
|---|---|---|
| `auth.users` | (يديره Supabase) | — |
| `app.profiles` | `user_id PK→auth.users`, `full_name`, `role` (`super_admin/teacher/assistant/student`), `status`, `phone_e164?`, `student_code?` | `role` محصور بقائمة؛ `phone_e164` فريد عند وجوده؛ `student_code` فريد (فهرس جزئي) |
| `app.teachers` | `id PK`, `user_id`, `display_name`, `timezone` (default `Africa/Cairo`), `status` | `user_id` فريد |
| `app.teacher_memberships` | `id`, `teacher_id`, `user_id`, `role` (`teacher/assistant`), `status` | فريد `(teacher_id, user_id)` |
| `app.assistant_permissions` | `membership_id`, `action` (enum نصي), `scope_group_ids uuid[]` | فريد `(membership_id, action)` |
| `app.invitations` | `id`, `kind` (`teacher_invite/student_link/assistant_invite`), `token_hash` (sha256), `target_hint?`, `teacher_id?`, `created_by`, `expires_at`, `used_at?`, `revoked_at?` | `token_hash` فريد؛ صالح مرة واحدة؛ `expires_at` إلزامي |
| `app.recovery_tokens` | `id`, `user_id`, `issued_by`, `token_hash`, `reason`, `expires_at`, `used_at?` | فريد `token_hash` |

### ب) الطالب والتنظيم

| الجدول | أهم الحقول | القيود |
|---|---|---|
| `app.student_profiles` | `id`, `teacher_id`, `user_id?`, `full_name`, `student_code`, `phone_e164?`, `guardian_phone_e164?`, `grade`, `location_name`, `city?`, `status`, `notes?` | **فريد `(teacher_id, user_id)`**؛ `student_code` فريد عالميًا |
| `public.groups` | `id`, `teacher_id`, `name`, `subject`, `grade`, `location_name`, `schedule_text`, `capacity?`, `status`, `academic_year?` | فريد `(teacher_id, name, academic_year)` |
| `public.group_memberships` | `id`, `group_id`, `student_profile_id`, `joined_at`, `left_at?` | فريد جزئي `(group_id, student_profile_id) WHERE left_at IS NULL` |

> **لماذا الطالب هو `profile` وليس حسابًا عامًا؟** C-03: الهوية عالمية (`auth.users`)، والملف الأكاديمي محلي عند كل مدرس. `student_profiles.teacher_id` يحقق العزل.

### ج) الحضور

| الجدول | أهم الحقول | القيود |
|---|---|---|
| `public.class_sessions` | `id`, `group_id`, `teacher_id`, `starts_at timestamptz`, `duration_min`, `topic?`, `status` | فريد `(group_id, starts_at)` |
| `public.attendance_records` | `id`, `session_id`, `student_profile_id`, `status`, `note?`, `recorded_by`, `recorded_at`, `updated_at` | **فريد `(session_id, student_profile_id)`** |
| `app.attendance_edits` | `id`, `attendance_id`, `old_status`, `new_status`, `reason`, `edited_by`, `edited_at` | إلزامي عند التعديل بعد الحفظ |

**صيغة نسبة الحضور (منقولة نصًا من وثيقة المتطلبات §6):**

> «نسبة الحضور = الحضور المحتسب ÷ الحصص التي كان الطالب مؤهلًا لحضورها والمسجل لها حالة.»

- المقام **لا يشمل** الحصص غير المرصودة (غياب السجل ليس غيابًا — C-10).
- البسط يتبع سياسة R-07: `present + late` محتسبان حضورًا، و`excused` لا يُحتسب حضورًا ولا غيابًا.
- **أثر R-07 على المقام:** إن اعتُمد استثناء العذر من المقام أيضًا صار التعريف `(present+late) ÷ (present+late+absent)`؛ هذا تفصيل يثبته العميل في R-07 قبل بناء التقارير (المرحلة ٠٥) حتى لا تتغير النسب بعد التدريب.

### د) الدروس

| الجدول | أهم الحقول | القيود |
|---|---|---|
| `public.lessons` | `id`, `teacher_id`, `title`, `subject`, `grade`, `body_md`, `status` (`draft/published/archived`), `published_at?` | — |
| `public.lesson_groups` | `lesson_id`, `group_id` | مفتاح مركب |
| `public.lesson_media` | `id`, `lesson_id`, `kind` (`image/equation/youtube`), `storage_path?`, `youtube_id?`, `position` | `youtube_id` بعد تحقق صيغة؛ لا HTML حر |

### هـ) الأسئلة والامتحانات

| الجدول | أهم الحقول | القيود |
|---|---|---|
| `public.questions` | `id`, `teacher_id`, `type` (`mcq` = اختيار من متعدد بإجابة واحدة · `true_false` = صح/خطأ), `text_md`, `subject`, `grade`, `topic?`, `difficulty?`, `status` (`draft/active/archived`), `version` | لا اعتماد سؤال بلا إجابة صحيحة (فحص على الخادم) |
| `public.question_options` | `id`, `question_id`, `text_md`, `is_correct`, `position` | **فريد جزئي `(question_id) WHERE is_correct`** لضمان إجابة واحدة |
| `public.exams` | `id`, `teacher_id`, `title`, `subject`, `grade`, `mode` (`fixed_window/flexible_window/open_period`), `opens_at`, `closes_at`, `duration_min?`, `draw_count`, `max_attempts`, `score_policy` (`best/last`), `release_grade` (`immediate/after_close/manual`), `allow_review`, `require_fullscreen`, `log_focus_events`, `status` | `draw_count > 0`؛ `closes_at > opens_at` |
| `public.exam_groups` | `exam_id`, `group_id` | مفتاح مركب |
| `public.exam_question_pool` | `exam_id`, `question_id` | مفتاح مركب — بنك الامتحان المرشّح للسحب |

### و) المحاولات والنتائج

| الجدول | أهم الحقول | القيود |
|---|---|---|
| `app.attempts` | `id`, `exam_id`, `student_profile_id`, `attempt_no`, `status` (`in_progress/submitted/graded/expired/voided`), `started_at`, `deadline_at`, `submitted_at?`, `graded_at?`, `score_raw?`, `score_total?` | **فريد `(exam_id, student_profile_id, attempt_no)`** + **فريد جزئي: محاولة نشطة واحدة لكل (exam, student)** |
| `app.attempt_questions` | `id`, `attempt_id`, `question_id`, `question_version`, `snapshot_text`, `position` | فريد `(attempt_id, question_id)` و`(attempt_id, position)` — **نسخة ثابتة** |
| `app.attempt_options` | `attempt_question_id`, `option_id`, `snapshot_text`, `position` | خلط مستقر محفوظ |
| `app.attempt_answers` | `attempt_question_id`, `selected_option_id?`, `saved_at` | فريد `(attempt_question_id)` |
| `app.attempt_events` | `id`, `attempt_id`, `kind` (`blur/visibility/fullscreen_exit/reconnect/write_session_change`), `at`, `meta jsonb` | مؤشرات لا اتهام (C-16) |
| `public.results` | `id`, `attempt_id`, `exam_id`, `student_profile_id`, `score`, `total`, `percent`, `released_at?`, `released_by?` | فريد `attempt_id`؛ لا سجل قبل التصحيح |

> **لماذا النتائج في `public` والمحاولات في `app`؟** المحاولة تحتوي منطقًا وحقولًا لا يجوز كشفها (مفاتيح، ترتيب). النتيجة المنشورة هي واجهة القراءة الوحيدة، وتُبنى من المحاولة بتصريح صريح.

### ز) التنبيهات والتدقيق

| الجدول | أهم الحقول | القيود |
|---|---|---|
| `public.notifications` | `id`, `teacher_id?`, `scope` (`global/teacher/group/student`), `title`, `body`, `created_by`, `created_at` | — |
| `public.notification_recipients` | `notification_id`, `user_id`, `read_at?` | مفتاح مركب |
| `app.audit_log` | `id`, `actor_user_id`, `teacher_id?`, `action`, `entity`, `entity_id`, `before jsonb?`, `after jsonb?`, `at`, `ip_hash?` | **append-only**؛ لا سياسة حذف/تعديل لأي دور |

## ٣) العلاقات (ERD مبسّط)

```text
auth.users 1──1 app.profiles
app.profiles 1──1 app.teachers            (إذا كان الدور teacher)
app.teachers 1──N app.student_profiles
auth.users 1──N app.student_profiles      (حساب عالمي → ملفات محلية)
app.teachers N──N auth.users              عبر app.teacher_memberships
app.teacher_memberships 1──N app.assistant_permissions

app.teachers 1──N public.groups
public.groups N──N app.student_profiles   عبر group_memberships
public.groups 1──N public.class_sessions
public.class_sessions 1──N attendance_records
app.student_profiles 1──N attendance_records

app.teachers 1──N public.lessons          ← lesson_groups ← groups
app.teachers 1──N public.questions        ← question_options
app.teachers 1──N public.exams            ← exam_groups ← groups
                                          ← exam_question_pool ← questions

public.exams 1──N app.attempts
app.attempts 1──N app.attempt_questions   ← attempt_options ← question_options(id)
app.attempt_questions 1──1 app.attempt_answers
app.attempts 1──N app.attempt_events
app.attempts 1──1 public.results
```

## ٤) قاموس الحالات

| الكيان | الحالات | الانتقالات المسموحة | أثرها |
|---|---|---|---|
| **الحساب** (`profiles.status`) | `pending` · `active` · `suspended` · `archived` | pending→active (تفعيل)؛ active↔suspended؛ →archived | `suspended/archived` يمنع الوصول الجديد **ويمنع الطلبات بالجلسات القديمة** (يُفحص في كل RLS/RPC) |
| **دعوة** | `pending` · `used` · `expired` · `revoked` | pending→used/expired/revoked | لا انتقال عكسي؛ الاستخدام مرة واحدة |
| **ملف طالب** | `pending_link` · `active` · `suspended` · `archived` | pending_link→active (قبول)؛ active↔suspended؛ →archived | المؤرشف لا يُحسب في الإحصاءات النشطة ويبقى في التاريخ |
| **عضوية مجموعة** | `active` · `left` | active→left | `joined_at/left_at` محفوظان دائمًا |
| **حضور** | `present` · `absent` · `late` · `excused` | أي تعديل مسموح بصلاحية + سبب | **لا حالة «غير مرصود» تُخزَّن** — غياب السجل = لم يُرصد |
| **درس** | `draft` · `published` · `archived` | draft→published→archived | المؤرشف لا يظهر للطالب |
| **سؤال** | `draft` · `active` · `archived` | draft→active→archived | المؤرشف لا يدخل امتحانًا جديدًا |
| **امتحان** | `draft` · `scheduled` · `open` · `closed` · `archived` | draft→scheduled→open→closed→archived | `closed` يمنع بدء محاولة جديدة |
| **محاولة** | `in_progress` · `submitted` · `graded` · `expired` · `voided` | in_progress→(submitted \| expired \| voided)→graded | بعد `submitted` لا تعديل إجابة؛ `voided` إداري بسبب مسجل |
| **نتيجة** | `graded` · `released` · `withheld` | graded→released \| withheld | لا تظهر للطالب قبل `released` |
| **تنبيه للمستلم** | `unread` · `read` | unread↔read | — |

## ٥) قيود الفرادة والمنع من التكرار (منطق مطلوب)

| القاعدة | التنفيذ المقترح |
|---|---|
| لا محاولتان نشطتان لنفس الطالب والامتحان | فهرس فريد جزئي على `app.attempts (exam_id, student_profile_id) WHERE status='in_progress'` |
| لا حضور مزدوج لنفس الطالب في الحصة | فريد `(session_id, student_profile_id)` |
| لا نتائج مزدوجة للمحاولة | فريد `results(attempt_id)` + `ON CONFLICT DO NOTHING` في التصحيح |
| لا يستخدم رابط دعوة/استعادة مرتين | `UPDATE … WHERE used_at IS NULL RETURNING *` ذري |
| التسليم مرة واحدة | `UPDATE app.attempts SET status='submitted' WHERE id=? AND status='in_progress'` |
| لا اختيار صحيح مزدوج | فريد جزئي على `question_options(question_id) WHERE is_correct` |
| لا سؤال مكرر في محاولة | فريد `(attempt_id, question_id)` |

## ٦) الأرشفة والحذف والاحتفاظ

| الحالة | القاعدة |
|---|---|
| **الحذف الناعم** | الكيانات الأكاديمية لا تُحذف صلبًا من الواجهة؛ تُؤرشف (`archived`) ويبقى تاريخها. |
| **الحذف الصلب** | مسموح فقط: الرموز المنتهية، ومحاولات مسودة لم تبدأ فعليًا (لا إجابات)، وبعد انتهاء مدة الاحتفاظ. |
| **ملف الطالب** | أرشفة تمنع الوصول الجديد وتُبقي السجلات للتقارير التاريخية. |
| **سجل التدقيق** | append-only، لا يُحذف بأي دور؛ يُجهَّل الهوية (pseudonymize) عند الحذف النهائي بدل حذف السجل. |
| **الاحتفاظ** | ٢٤ شهرًا بعد الأرشفة (R-10) — **قرار مبدئي ينتظر تثبيت O-06**. |
| **الطلب من صاحب البيانات** | تصدير + حذف: مسار موثق يُنفَّذ بمهاجرة/سكربت إداري، لا من واجهة المدرس. |

## ٧) ملاحظات تصميمية ملزمة

1. **الأزمنة كلها `timestamptz` بـUTC** (C-23)، والعرض بمنطقة المدرس (R-02).
2. **`student_code` عالمي الفريد** لأنه معرّف عرض وبحث يُتبادله المدرسون شفويًا؛ صار كذلك بعد C-28 (لم يعد وسيلة دخول)، ويبقى فريدًا لمنع الالتباس.
3. **`assistant_permissions.scope_group_ids`** مصفوفة UUID لتبسيط أول، مع خطة تحويلها لجدول ربط إن احتجنا استعلامات دقيقة (قرار مؤجل، لا يعطّل شيئًا الآن).
4. **لا حقل «كلمة مرور»** في أي جدول من جداولنا — كلمات المرور في `auth.users` فقط (C-25).
5. **لا مشاركة بيانات بين مدرسين** بالتصميم: كل جدول أعمال يحمل `teacher_id` وRLS تربطه بالعضوية (R-11).
