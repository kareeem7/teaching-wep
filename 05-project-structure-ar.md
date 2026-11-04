# شجرة الملفات والفولدرات الملزمة — منصة المدرسين

الحزمة المعتمدة من العميل: HTML5 + CSS3 + Bootstrap 5 RTL + JavaScript ES Modules للواجهة، وSupabase للخلفية: PostgreSQL + Auth + Storage + Edge Functions + RLS. لا Laravel ولا Inertia ولا React ولا Tailwind. أي تغيير اسم أو مسار أو إضافة إطار عمل يتطلب قرارًا موثقًا في `docs/DECISIONS.md` وتحديث هذا الملف في نفس الـ commit.

## قواعد التسمية الملزمة

- الواجهة ثابتة تحت `public/`: صفحات HTML في `public/pages/<role>/`، الأصول في `public/assets/`، ومكونات JS في `public/assets/js/components/`.
- خلفية Supabase تحت `supabase/`: migrations في `supabase/migrations/`، Edge Functions في `supabase/functions/<function-name>/index.js`، ومشتركات في `supabase/functions/_shared/`.
- أسماء Edge Functions بصيغة kebab-case تصف العملية: `exam-start`, `exam-save`, `exam-submit`, `exam-grade`, `attendance-save`.
- صفحات HTML بصيغة kebab-case وتطابق اسم الشاشة في مصفوفة الشاشات؛ ملفات JS التابعة لها بنفس الاسم الأساسي.
- migrations بأسماء رقمية وصفية ثابتة مثل `0018_exam_attempts.sql`. لا تعديل migration منشور سابق؛ أضف migration جديدًا.
- اختبارات SQL/RLS في `tests/sql/`، اختبارات الوحدة في `tests/unit/`، اختبارات المتصفح في `tests/e2e/`، والحمل في `scripts/load/`.
- تقارير المراحل ثابتة: `docs/PHASE_REPORTS/PHASE_XX_BUILD.md` و`PHASE_XX_CHECK.md`.
- **تحديث المرحلة ٠١ (D-311، D-312):** أُضيفت `assets/vendor/supabase/` لأصول الطرف الثالث المحلية، وأُضيف `supabase/migrations/0002_platform_meta.sql` و`tests/unit/dom.test.js`. الأسباب موثقة في `docs/DECISIONS.md`، والأسماء الأصلية لم تتغيّر.
- في التقرير لا أسماء وهمية: كل ملف في شجرة تقرير البناء يجب أن يكون موجودًا فعلًا في الريبو.
- لا تضع أسرارًا أو `service_role` key تحت `public/`. المتصفح يستخدم publishable/anon key فقط، والصلاحيات تُفرض عبر RLS وEdge Functions.

## الشجرة العامة

```text
public/
  index.html
  pages/{auth,admin,teacher,student,shared,errors}/
  assets/css/ , assets/js/ , assets/js/components/
  assets/vendor/bootstrap/ , assets/vendor/supabase/   (أصول محلية منسوخة، D-311)
supabase/
  config.toml , seed.sql
  migrations/
  functions/_shared/ , functions/<function-name>/index.js
tests/unit/ , tests/sql/ , tests/e2e/
scripts/{load,backup,deploy}/ , deploy/staging/
docs/{PHASE_REPORTS,test-artifacts,WIREFRAMES,reports,runbooks,uat,release,guides}/
.github/workflows/ , phase-prompts/
```

## ملفات كل مرحلة

الملفات التالية تُنشأ في مرحلتها المحددة، وليس قبلها. الملفات المشتركة (مثل README وPROJECT_STATE) تُحدث ولا تُستبدل.

### المرحلة 00 — تثبيت المتطلبات والنماذج والقرارات

```text
docs/
├── DECISIONS.md
├── APPROVALS.md
├── PROJECT_STATE.md
├── REQUIREMENTS_TRACEABILITY.md
├── KNOWN_LIMITATIONS.md
├── DATA_MODEL.md
├── PERMISSIONS.md
├── TEST_PLAN.md
├── COST_OPTIONS.md
├── SUPABASE_ARCHITECTURE.md
├── AUTH_DESIGN.md
├── WIREFRAMES/
│   ├── admin-dashboard.md
│   ├── teacher-dashboard.md
│   ├── students-and-groups.md
│   ├── attendance-sheet.md
│   ├── lesson-view.md
│   ├── question-bank.md
│   ├── exam-builder.md
│   ├── student-exam.md
│   └── student-results.md
└── PHASE_REPORTS/
    ├── PHASE_00_BUILD.md
    └── PHASE_00_CHECK.md
05-project-structure-ar.md   # اعتماد/تحديث شجرة الملفات ضمن مخرجات المرحلة
```

### المرحلة 01 — تأسيس المشروع وهيكل الواجهة والجودة

```text
package.json / package-lock.json
.env.example
.gitignore , .editorconfig , README.md
eslint.config.js , .stylelintrc.json , .htmlhintrc
playwright.config.js
public/index.html
public/pages/health.html
public/pages/auth/login.html          # صفحة دخول شكلية حتى المرحلة ٠٢
public/pages/errors/403.html , 404.html , 500.html
public/assets/css/app.css
public/assets/vendor/bootstrap/bootstrap.rtl.min.css , bootstrap.bundle.min.js
public/assets/js/config.js , supabase-client.js , app.js , auth-guard.js , ui.js
public/assets/js/components/navbar.js , sidebar.js , toast.js , empty-state.js
supabase/config.toml
supabase/migrations/0001_extensions.sql
supabase/seed.sql
tests/unit/config.test.js
tests/e2e/smoke.spec.js
.github/workflows/ci.yml , .github/pull_request_template.md
docs/PHASE_REPORTS/PHASE_01_BUILD.md , PHASE_01_CHECK.md
```

### المرحلة 02 — الهوية والصلاحيات وعزل مساحات المدرسين

```text
supabase/migrations/0002_identity_profiles.sql
supabase/migrations/0003_teacher_workspaces.sql
supabase/migrations/0004_invitations_recovery.sql
supabase/migrations/0005_rls_identity.sql
supabase/functions/_shared/cors.js , auth.js , db.js , errors.js , rate-limit.js
supabase/functions/auth-login/index.js
supabase/functions/auth-recovery/index.js
supabase/functions/invite-accept/index.js
supabase/functions/workspace-select/index.js
public/pages/auth/login.html , accept-invitation.html , request-recovery.html , reset-password.html , select-workspace.html
public/assets/js/auth.js , workspace.js , api.js
tests/sql/identity_rls.test.sql
tests/unit/token-hash.test.js
tests/e2e/auth.spec.js , workspace-isolation.spec.js
docs/PHASE_REPORTS/PHASE_02_BUILD.md , PHASE_02_CHECK.md
```

### المرحلة 03 — السوبر أدمن وإدارة المدرسين

```text
supabase/migrations/0006_admin_audit_notifications.sql
supabase/migrations/0007_rls_admin.sql
supabase/functions/admin-teachers/index.js
supabase/functions/admin-instructions/index.js
supabase/functions/_shared/audit.js
public/pages/admin/dashboard.html , teachers.html , teacher-detail.html , instructions.html
public/assets/js/admin/dashboard.js , teachers.js , instructions.js
tests/sql/admin_rls.test.sql
tests/e2e/admin-teachers.spec.js , admin-readonly.spec.js
docs/PHASE_REPORTS/PHASE_03_BUILD.md , PHASE_03_CHECK.md
```

### المرحلة 04 — الطلاب والأماكن والمجموعات والمساعدون

```text
supabase/migrations/0008_locations_groups.sql
supabase/migrations/0009_students_profiles.sql
supabase/migrations/0010_assistants_permissions.sql
supabase/migrations/0011_rls_students_groups.sql
supabase/functions/students-register/index.js
supabase/functions/groups-transfer/index.js
supabase/functions/assistants-permissions/index.js
public/pages/teacher/dashboard.html      # إضافة موثقة: المهمة ٥ تطلب نموذج لوحة المدرس (G-04)
public/pages/teacher/students.html , student-create.html , student-profile.html
public/pages/teacher/locations.html , groups.html , group-detail.html
public/pages/teacher/assistants.html , assistant-permissions.html
public/assets/js/teacher/dashboard.js    # إضافة موثقة مع الصفحة أعلاه
public/assets/js/teacher/students.js , locations.js , groups.js , assistants.js
tests/sql/students_groups_rls.test.sql
tests/e2e/students-groups.spec.js , assistant-scope.spec.js
docs/PHASE_REPORTS/PHASE_04_BUILD.md , PHASE_04_CHECK.md
```

### المرحلة 05 — الحصص والحضور وملف الطالب

```text
supabase/migrations/0012_sessions_attendance.sql
supabase/migrations/0013_rls_attendance.sql
supabase/functions/attendance-save/index.js
supabase/functions/student-profile/index.js
public/pages/teacher/attendance-sheet.html , attendance-history.html
public/pages/teacher/student-profile.html
public/assets/js/teacher/attendance.js , student-profile.js
public/assets/js/components/attendance-status-badge.js
tests/sql/attendance_rls.test.sql
tests/unit/attendance-calculator.test.js
tests/e2e/attendance.spec.js
docs/PHASE_REPORTS/PHASE_05_BUILD.md , PHASE_05_CHECK.md
```

### المرحلة 06 — الدروس والمعادلات والمرفقات ويوتيوب

```text
supabase/migrations/0014_lessons_media.sql
supabase/migrations/0015_rls_lessons_storage.sql
supabase/functions/lessons-publish/index.js
supabase/functions/attachments-sign/index.js
supabase/functions/_shared/youtube.js , sanitizer.js
public/pages/teacher/lessons.html , lesson-editor.html
public/pages/student/lesson-view.html
public/assets/js/teacher/lessons.js , student/lesson-view.js
public/assets/js/components/youtube-embed.js , math-text.js , rich-content.js
tests/sql/lessons_storage_rls.test.sql
tests/unit/youtube-validation.test.js , sanitizer.test.js
tests/e2e/lessons.spec.js
docs/PHASE_REPORTS/PHASE_06_BUILD.md , PHASE_06_CHECK.md
```

### المرحلة 07 — بنك الأسئلة وإعداد الامتحانات

```text
supabase/migrations/0016_questions_exams.sql
supabase/migrations/0017_rls_questions_exams.sql
supabase/functions/exams-publish/index.js
supabase/functions/_shared/question-validator.js , random-sampler.js
public/pages/teacher/questions.html , question-editor.html
public/pages/teacher/exams.html , exam-builder.html
public/assets/js/teacher/questions.js , exams.js
public/assets/js/components/question-editor.js
tests/sql/questions_exams_rls.test.sql
tests/unit/question-validator.test.js , random-sampler.test.js
tests/e2e/exam-builder.spec.js
docs/PHASE_REPORTS/PHASE_07_BUILD.md , PHASE_07_CHECK.md
```

### المرحلة 08 — محرك المحاولات والتصحيح على الخادم

```text
supabase/migrations/0018_exam_attempts.sql
supabase/migrations/0019_rls_attempts.sql
supabase/functions/exam-start/index.js
supabase/functions/exam-save/index.js
supabase/functions/exam-submit/index.js
supabase/functions/exam-grade/index.js
supabase/functions/attempt-finalize/index.js
supabase/functions/_shared/server-clock.js , idempotency.js , grading.js
tests/sql/attempts_rls.test.sql
tests/unit/grading.test.js , idempotency.test.js
tests/e2e/attempt-api.spec.js
docs/PHASE_REPORTS/PHASE_08_BUILD.md , PHASE_08_CHECK.md
```

### المرحلة 09 — واجهة الطالب والحماية والنتائج

```text
supabase/migrations/0020_attempt_events_results.sql
supabase/migrations/0021_rls_results_events.sql
supabase/functions/attempt-events/index.js
supabase/functions/results-release/index.js
public/pages/student/exam-room.html , exam-result.html , review.html
public/assets/js/student/exam-room.js , exam-result.js , review.js
public/assets/js/components/question-card.js , exam-timer.js , connection-status.js , fullscreen-guard.js
public/assets/js/exam/autosave.js , server-time.js , exam-events.js
tests/sql/results_events_rls.test.sql
tests/e2e/exam-flow.spec.js , exam-reconnect.spec.js , exam-mobile.spec.js
docs/PHASE_REPORTS/PHASE_09_BUILD.md , PHASE_09_CHECK.md
```

### المرحلة 10 — التقارير والتنبيهات والتصدير واكتمال لوحة الإدارة

```text
supabase/migrations/0022_reports_notifications_exports.sql
supabase/migrations/0023_rls_reports_notifications.sql
supabase/functions/reports-export/index.js
supabase/functions/notifications-dispatch/index.js
supabase/functions/_shared/csv-export.js , ranking.js
public/pages/teacher/reports.html , group-report.html , student-ranking.html
public/pages/admin/overview.html
public/pages/shared/notifications.html
public/assets/js/teacher/reports.js , admin/overview.js , shared/notifications.js
public/assets/js/components/notification-bell.js
tests/sql/reports_notifications_rls.test.sql
tests/unit/ranking.test.js , csv-injection.test.js
tests/e2e/reports-notifications.spec.js
docs/PHASE_REPORTS/PHASE_10_BUILD.md , PHASE_10_CHECK.md
```

### المرحلة 11 — الأمان والحمل والنسخ الاحتياطي وبيئة التجربة

```text
scripts/load/exam-scenario.js , ramp-100.js , ramp-500.js , ramp-1000.js
scripts/backup/backup.sh , restore.sh
scripts/deploy/deploy.sh , rollback.sh
deploy/staging/README.md , deploy/staging/.env.example
docs/reports/SECURITY_AUDIT.md , LOAD_TEST_REPORT.md , RESTORE_TEST_REPORT.md
docs/runbooks/backup-restore.md , incident-response.md
tests/sql/authorization-sweep.test.sql
docs/PHASE_REPORTS/PHASE_11_BUILD.md , PHASE_11_CHECK.md
```

### المرحلة 12 — قبول العميل والإطلاق التجريبي ثم التشغيل

```text
docs/uat/UAT_CHECKLIST.md , UAT_RESULTS.md
docs/release/RELEASE_NOTES.md , GO_LIVE_CHECKLIST.md
docs/guides/teacher-guide.md , assistant-guide.md , student-guide.md , admin-guide.md
docs/runbooks/deploy.md , monitoring.md
docs/PHASE_REPORTS/PHASE_12_BUILD.md , PHASE_12_CHECK.md
```

## التحقق

- برومبت التنفيذ لكل مرحلة يتضمن قائمة ملفاتها حرفيًا، وبرومبت الفحص يطابق الأسماء.
- الفاحص يسجل أي ملف ناقص أو اسم مخالف كعيب، ولا يقبل «هيكل مشابه» بديلًا عن الأسماء المعتمدة.
- أي وظيفة حساسة في المتصفح فقط، أو `service_role` key في الواجهة، عيب أمني مانع.

## تعديلات موثقة على الشجرة

| التاريخ | التعديل | السبب | المرجع |
|---|---|---|---|
| 2026-11-04 | إضافة `public/pages/teacher/dashboard.html` و`public/assets/js/teacher/dashboard.js` إلى المرحلة ٠٤ | المهمة ٥ من برومبت المرحلة ٠٠ تطلب نموذج شاشة المدرس، ولم تكن الصفحة في أي مرحلة | G-04 في `docs/PROJECT_STATE.md` |

لم تُحذف أو تُعدَّل أي أسماء أخرى. لا تنظيم موازٍ، ولا ملفات فارغة.
