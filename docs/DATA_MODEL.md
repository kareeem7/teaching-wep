# نموذج البيانات — DATA_MODEL

آخر تحديث: 2026-11-04 · المرحلة: 00 · تصميم فقط، لا migrations ولا قاعدة بيانات.

## 1. المبادئ

1. **المدرس هو جذر الملكية** (`teacher_id`)، والسنتر مجرد حقل تنظيمي داخله.
2. **الهوية العالمية منفصلة عن الملف الأكاديمي.** `profiles` (هوية) ↔ `student_profiles` (ملف عند مدرس).
3. **لا حذف للسجلات التاريخية**؛ الحالة (نشط/معلق/مؤرشف) لا الحذف.
4. **الأزمنة UTC** (`timestamptz`)، والعرض بالمنطقة المعتمدة (D-110).
5. **النسخة ثابتة**: بعد بدء المحاولة تُنسخ الأسئلة والاختيارات إلى المحاولة، فلا يغيّر تعديل السؤال محاولة جارية أو نتيجة سابقة.
6. **المفاتيح والحدود في قاعدة البيانات**، لا في التطبيق فقط.

## 2. مجموعات الكيانات

### أ) الهوية والمساحة (المرحلة 02–04)

| الجدول | الغرض | حقول مفتاحية | قيود جوهرية |
|---|---|---|---|
| `profiles` | هوية عالمية لكل مستخدم | `id` (= auth user)، `role`، `full_name`، `phone_e164`، `student_code`، `status` | `unique(phone_e164)`، `unique(student_code)`، `role in (super_admin, teacher, assistant, student)` |
| `teacher_workspaces` | مساحة عمل المدرس | `teacher_id` (= profile)، `display_name`، `timezone` | `teacher_id` فريد؛ `timezone` افتراضي `Africa/Cairo` |
| `teacher_invitations` | دعوة مدرس من الإدارة | `token_hash`، `expires_at`، `used_at`، `created_by` | `token_hash` فريد؛ استخدام واحد؛ لا يُخزَّن الرمز الخام |
| `assistant_memberships` | ربط مساعد بمدرس | `assistant_id`، `teacher_id`، `status` | `unique(assistant_id, teacher_id)` |
| `assistant_permissions` | فعل + نطاق | `assistant_id`، `teacher_id`، `action`، `scope_group_ids[]` | `unique(assistant_id, teacher_id, action)` |

### ب) التنظيم الأكاديمي (المرحلة 04)

| الجدول | الغرض | قيود جوهرية |
|---|---|---|
| `locations` | مكان/سنتر داخل مساحة مدرس | `unique(teacher_id, name)`؛ التكرار بين مدرسين مسموح |
| `groups` | مجموعة (مادة/صف/مكان/ميعاد) | `teacher_id` NOT NULL؛ `capacity` اختياري |
| `student_profiles` | ملف الطالب عند مدرس | `unique(teacher_id, profile_id)`؛ `status in (active, suspended, archived)` |
| `group_memberships` | عضوية طالب في مجموعة | `unique(group_id, student_profile_id)`؛ `joined_at`/`left_at` محفوظان لا يُعاد كتابتهما |
| `student_link_invitations` | دعوة ربط طالب بمدرس | `token_hash` فريد، استخدام واحد، انتهاء |
| `contact_numbers` | هاتف الطالب وولي الأمر | منفصل عن `profiles` لضبط `students.contacts` |

**قاعدة الإحصاء:** «عدد الطلاب» = `count(distinct student_profile_id)`، وليس `count(*)` من العضويات (REQ-04).

### ج) الحضور (المرحلة 05)

| الجدول | الغرض | قيود جوهرية |
|---|---|---|
| `sessions` | حصة فعلية | `teacher_id`، `group_id`، `starts_at timestamptz` |
| `attendance_records` | حالة طالب في حصة | `unique(session_id, student_profile_id)` ← يمنع الازدواج |
| `attendance_audit` | تعديل الحضور | `old_status`، `new_status`، `reason` NOT NULL، `changed_by` |

`status in (present, absent, late, excused)`. **غياب السجل ≠ غائب.** نسبة الحضور تُحسب من السجلات الموجودة فقط (D-114).

### د) الدروس (المرحلة 06)

`lessons` (teacher_id، title، body، math_enabled، status)، `lesson_groups` (many-to-many مع مجموعات)، `lesson_media` (نوع: youtube/image، `youtube_video_id` بعد التحقق)، وStorage خاص للصور.

### هـ) بنك الأسئلة والامتحانات (المرحلة 07)

| الجدول | الغرض | قيود جوهرية |
|---|---|---|
| `questions` | سؤال بنسخة | `teacher_id`، `type in (mcq, true_false)`، `points default 1`، `status` |
| `question_options` | اختيارات بمعرّفات ثابتة | `unique(question_id, position)` |
| `question_answer_keys` | الإجابة الصحيحة (محمية) | صف واحد لكل سؤال؛ لا تُقرأ إلا حسب السياسة |
| `question_versions` | نسخة مجمّدة | تُستخدم لحفظ نص/خيارات السؤال وقت النشر |
| `exams` | إعداد الامتحان | `timing_mode in (fixed, window, open)`، `attempts_allowed`، `score_policy in (highest,last)`، `show_score_mode`، `review_mode`، `fullscreen_required`، `leave_logging` |
| `exam_groups` | المجموعات المستهدفة | — |

### و) المحرك (المرحلة 08–09)

| الجدول | الغرض | قيود جوهرية |
|---|---|---|
| `exam_attempts` | محاولة واحدة لكل طالب/امتحان في كل مرة | **فهرس جزئي فريد** `unique(exam_id, student_profile_id) where status='in_progress'` ← يمنع محاولتين نشطتين |
| `attempt_questions` | نسخة الأسئلة المثبتة | `unique(attempt_id, question_version_id)`؛ ترتيب مثبت |
| `attempt_options` | ترتيب الاختيارات المثبت | `unique(attempt_question_id, option_id)` |
| `attempt_answers` | الإجابات | `unique(attempt_question_id)`؛ تُرفض بعد `submitted_at`/`expires_at` |
| `attempt_events` | مغادرة/عودة/ملء شاشة/جهاز ثانٍ | أحداث فقط، بلا اتهام |
| `attempt_write_leases` | جهاز الكتابة النشط | `unique(attempt_id)` ← D-401/§10 (جهاز واحد يكتب) |
| `attempt_results` | النتيجة | `raw_score`، `total_points`، `percentage`، `policy_used`؛ `unique(attempt_id)` |

**ثوابت المحاولة:**
- `started_at` و`expires_at` يُحسبان على الخادم مرة واحدة.
- `expires_at = min(started_at + duration, exam.closes_at)`.
- لا تُقبل إجابة `server_received_at > expires_at`.
- التسليم idempotent: `submitted_at` يُكتب مرة، والإعادة ترجع نفس النتيجة.

### ز) الإدارة والتدقيق (المرحلة 03، 10)

`admin_instructions`، `notifications` (recipient، read_at، deep link يُفحص عند الفتح)، `audit_log` (actor، action، before/after، at)، `exports_log` (who/scope/when).

## 3. العلاقات المختصرة

```
profiles(teacher) 1─1 teacher_workspaces
teacher_workspaces 1─N locations, groups, lessons, questions, exams
groups 1─N group_memberships N─1 student_profiles N─1 profiles(student)
groups 1─N sessions 1─N attendance_records
exams 1─N exam_attempts 1─N attempt_questions 1─N attempt_answers
exam_attempts 1─1 attempt_results
```

## 4. قيود لا يجوز التنازل عنها

1. `unique(session_id, student_profile_id)` للحضور.
2. فهرس جزئي فريد للمحاولة النشطة.
3. `unique(attempt_question_id)` لكل إجابة.
4. `token_hash` فريد لكل دعوة/استعادة، ولا يُخزَّن الرمز الخام.
5. `reason NOT NULL` في أي تعديل على حضور أو درجة.
6. عدم وجود `on delete cascade` على السجلات الأكاديمية التاريخية.

## 4-ب) قاموس الحالات (مرجع موحّد للواجهة والتقارير والاختبار)

### أ. دورة حياة ملف الطالب

| الحالة | المعنى | الأثر على الوصول | الانتقال المسموح |
|---|---|---|---|
| `pending_link` | أُنشئ الملف ولم يقبل الطالب الربط | لا يرى الطالب شيئًا بعد | → `active` (بعد القبول) أو `archived` |
| `active` | نشط | كل ما تسمح به المجموعات | → `suspended`، `archived` |
| `suspended` | معلّق (سبب + تاريخ) | **يمنع** المحاولات والوصول للدروس | → `active` (بقرار مسجّل) |
| `archived` | مؤرشف | لا يظهر في القوائم النشطة | → `active` (باستثناء) |

**قاعدة:** الحالة تُغيَّر بسبب وتاريخ ومسجَّل، ولا يُحذف الصف.

### ب. حالة الحضور

| الحالة | الرمز | بسط النسبة (D-114) | مقام النسبة | ملاحظة |
|---|---|---|---|---|
| حاضر | `present` | ✓ | ✓ | — |
| متأخر | `late` | ✓ | ✓ | يُحتسب حاضرًا |
| غائب بعذر | `excused` | ✗ | ✓ | خانة مستقلة في التقارير |
| غائب | `absent` | ✗ | ✓ | — |
| *لم يُرصد* | *(لا صف)* | **✗** | **✗** | **ليس قيمة حالة**، بل غياب صف — لا يُحتسب غيابًا |

**حالة المقام الصفري (D-114):** إذا كان مجموع الحصص المسجَّل لها حالة = **صفر**، فلا نسبة تُحسب ولا تُعرض «٠٪» ولا `NaN`:

| الشرط | العرض | الاحتساب |
|---|---|---|
| `total = 0` | «لا بيانات حضور» | يُستثنى الطالب من متوسط الحضور، ولا يُعدّ غائبًا |
| `total > 0` | النسبة + عدد الحصص المحتسبة | حسب D-114 |

القاعدة نفسها تنطبق على متوسط الدرجات: طالب بلا امتحان محتسب **يُستثنى**، لا يُحسب صفرًا (D-117).

### ج. دورة حياة المحاولة

| الحالة | المعنى | يمكن الكتابة؟ | الانتقال |
|---|---|---|---|
| `not_started` | لا محاولة (مفهوم لا صف) | — | → `in_progress` ببدء المحاولة |
| `in_progress` | جارية، نسخة مثبتة ووقت محسوب | ✓ قبل `expires_at` فقط | → `submitted` (يدويًا أو بالوقت)، → `voided` إداريًا |
| `submitted` | سُلّمت، النتيجة محتسبة | **✗ نهائيًا** | → `graded` |
| `graded` | نتيجة محفوظة ومتاحة وفق الإفراج | ✗ | لا رجوع إلا بإجراء مسجّل |
| `voided` | أُلغيت إداريًا (سبب إلزامي) | ✗ | لا تُحتسب في الأعلى/الأخيرة |
| `expired` | انتهى وقتها بلا تسليم | ✗ | تُصحَّح كـ`submitted` تلقائيًا بما حُفظ |

**تمييز إلزامي:** «لم يبدأ» ≠ «بدأ ولم يسلّم» ≠ «سلّم بصفر». ثلاثة أشياء مختلفة في العرض والتقارير (D-118).

### د. حالة النتيجة والإفراج

| الحالة | من يراها | الشرط |
|---|---|---|
| `not_released` | المدرس والمساعد المسموح | لم يتحقق شرط الإفراج (D-120) |
| `released_date` | الطالب | بُعد إغلاق الامتحان |
| `released_manual` | الطالب | نشر المدرس صراحةً (`results.publish`) |
| `review_open` | الطالب | المراجعة مفعّلة **و**الامتحان مغلق |
| `review_blocked` | — | المراجعة ممنوعة أو الامتحان جارٍ |

### هـ. حالة حساب المستخدم

`invited` → `active` → `suspended` → `archived`. الرموز (`invitations`/`recovery`) لها حالة مستقلة: `issued` → `consumed` | `expired` | `revoked`.

## 4-ج) سياسة الأرشفة والحذف والاحتفاظ (توصية D-124/D-125)

| العملية | ما يحدث فعليًا | ما لا يحدث |
|---|---|---|
| أرشفة طالب/مجموعة/درس/سؤال | إخفاء من القوائم النشطة، ومنع الاستخدام في جديد | **لا حذف** لأي سجل تاريخي |
| إيقاف مدرس | توقف الوصول، بقاء البيانات | لا حذف، لا فقدان تقارير |
| حذف طالب (طلب موثق) | إخفاء هوية: الاسم→«طالب محذوف»، حذف أرقام الاتصال | **لا** حذف النتائج والحضور (تبقى مجهولة الهوية) |
| حذف حساب مدرس | لا يُسمح من الواجهة؛ بطلب مكتوب وموافقة | لا حذف تلقائي |
| حذف سؤال مستخدم في امتحان | أرشفة فقط | لا يغيّر محاولة جارية أو نتيجة سابقة |

**مدد احتفاظ مقترحة (تحتاج اعتمادًا):** أكاديمي ٣ سنوات بعد نهاية العام · محاولات/نتائج سنتان · سجل تدقيق سنتان · رموز منتهية ٩٠ يومًا. **لا تنفيذ آلي للاحتفاظ في الإصدار الأول**؛ السياسة موثقة وتُنفَّذ يدويًا/بمهمة عند اعتمادها.

**تنبيه:** هذه سياسة، وليست حذفًا منفّذًا. لا يوجد كود في المرحلة ٠٠.

## 5. ما يُحسم في مراحل لاحقة

- أنواع الصفوف والمراحل التعليمية الافتراضية (D-201/D-203).
- بنية `audit_log` النهائية (المرحلة 03).
- طريقة تخزين `scope_group_ids` (مصفوفة أو جدول ربط) — §14 says decision D-402.
- إصدارات Question snapshots التفصيلية (المرحلة 07).

## 6. تتبع إلى المراحل

`0002`–`0005` (هوية) · `0006`–`0007` (أدمن) · `0008`–`0011` (طلاب/مجموعات) · `0012`–`0013` (حضور) · `0014`–`0015` (دروس) · `0016`–`0017` (أسئلة/امتحانات) · `0018`–`0019` (محاولات) · `0020`–`0021` (نتائج/أحداث) · `0022`–`0023` (تقارير/تنبيهات).
