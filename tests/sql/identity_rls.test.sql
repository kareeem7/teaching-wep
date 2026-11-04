-- =====================================================================
--  identity_rls.test.sql — اختبارات العزل والصلاحيات (المرحلة ٠٢)
--
--  الطريقة: pgTAP. كل حالة تبني مستخدمًا اصطناعيًا في `auth.users`، وتنتحل هويته
--  عبر `set local role authenticated` + ضبط `request.jwt.claims`، ثم تتحقق من النتيجة.
--
--  الحالة: **لم تُنفَّذ بعد** — لا PostgreSQL ولا Docker ولا Supabase CLI في بيئة التنفيذ،
--  ولم يُصرَّح بمشروع Supabase (BLOCKED، L-27). الملف مكتوب ليُشغَّل على نسخة منعزلة:
--
--    supabase db reset --db-url "$DEV_DATABASE_URL"   # نسخة تطوير/اختبار فقط
--    psql "$DEV_DATABASE_URL" -f tests/sql/identity_rls.test.sql
--
--  يُتوقع عند التشغيل: كل `ok(...)` تنجح، و`finish()` تطبع `# Looks like you planned N tests`.
--  أي `not ok` = فشل عزل = بوابة المرحلة لا تُفتح.
-- =====================================================================

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, app, pg_temp;

select plan(37);

-- ---------- تجهيز هويات اصطناعية ----------
-- لا بيانات حقيقية: أسماء وأرقام وهمية داخل معاملة تُلغى في النهاية.
insert into auth.users (id, phone, phone_confirmed_at, raw_app_meta_data, raw_user_meta_data)
values
  ('11111111-1111-1111-1111-111111111111', '+201000000001', now(), '{"provider":"phone"}', '{}'),
  ('22222222-2222-2222-2222-222222222222', '+201000000002', now(), '{"provider":"phone"}', '{}'),
  ('33333333-3333-3333-3333-333333333333', '+201000000003', now(), '{"provider":"phone"}', '{}'),
  ('44444444-4444-4444-4444-444444444444', '+201000000004', now(), '{"provider":"phone"}', '{}'),
  ('55555555-5555-5555-5555-555555555555', '+201000000005', now(), '{"provider":"phone"}', '{}'),
  ('99999999-9999-9999-9999-999999999999', '+201000000009', now(), '{"provider":"phone"}', '{}');

insert into app.profiles (user_id, full_name, role, status, phone_e164) values
  ('11111111-1111-1111-1111-111111111111', 'مدرس أول', 'teacher', 'active', '+201000000001'),
  ('22222222-2222-2222-2222-222222222222', 'مدرس ثانٍ', 'teacher', 'active', '+201000000002'),
  ('33333333-3333-3333-3333-333333333333', 'مساعد محدود', 'assistant', 'active', '+201000000003'),
  ('44444444-4444-4444-4444-444444444444', 'طالب عند الأول', 'student', 'active', null),
  ('55555555-5555-5555-5555-555555555555', 'طالب عند الاثنين', 'student', 'active', null),
  ('99999999-9999-9999-9999-999999999999', 'سوبر أدمن', 'super_admin', 'active', '+201000000009');

update app.profiles set student_code = 'MH000001' where user_id = '44444444-4444-4444-4444-444444444444';
update app.profiles set student_code = 'MH000002' where user_id = '55555555-5555-5555-5555-555555555555';

insert into app.teachers (teacher_id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

insert into app.student_profiles (id, teacher_id, user_id, full_name, local_code, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   '44444444-4444-4444-4444-444444444444', 'طالب عند الأول', 'S1', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
   '55555555-5555-5555-5555-555555555555', 'طالب عند الاثنين', 'S2', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
   '55555555-5555-5555-5555-555555555555', 'طالب عند الاثنين', 'S3', 'active');

insert into app.teacher_memberships (id, teacher_id, user_id, role_in_workspace, status) values
  ('bbbbbbbb-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   '11111111-1111-1111-1111-111111111111', 'teacher', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   '33333333-3333-3333-3333-333333333333', 'assistant', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222',
   '22222222-2222-2222-2222-222222222222', 'teacher', 'active');

-- المساعد: قراءة الطلاب فقط، بلا كتابة ولا مجموعات
insert into app.assistant_permissions (membership_id, action) values
  ('bbbbbbbb-0000-0000-0000-000000000002', 'students:read');

insert into public.groups (id, teacher_id, name, subject, grade, academic_year) values
  ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'مجموعة أ', 'رياضيات', 'الثالث', '2026/2027'),
  ('cccccccc-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'مجموعة ب', 'علوم', 'الثاني', '2026/2027');

insert into public.group_memberships (group_id, student_profile_id) values
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001');

-- ---------- دالة انتحال هوية ----------
create or replace function pg_temp.login_as(p_user_id uuid, p_role text default 'authenticated', p_iat bigint default null)
returns void
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', p_user_id,
      'role', p_role,
      'iat', coalesce(p_iat, extract(epoch from now())::bigint)
    )::text,
    true
  );
  execute format('set local role %I', p_role);
end;
$$;

-- =====================================================================
--  ١) مدرس يرى طلابه فقط
-- =====================================================================
select pg_temp.login_as('11111111-1111-1111-1111-111111111111');
select is(
  (select count(*)::int from app.student_profiles),
  2,
  'المدرس الأول يرى ملفَّي طالبه (لا ملف المدرس الثاني)'
);
select is(
  (select count(*)::int from app.student_profiles where teacher_id = '22222222-2222-2222-2222-222222222222'),
  0,
  'لا يرى ملفات مدرس آخر'
);
select is(
  (select count(*)::int from public.my_students),
  2,
  'واجهة my_students تحترم نفس العزل'
);
select is(
  (select count(*)::int from public.groups),
  1,
  'يرى مجموعاته فقط'
);

-- =====================================================================
--  ٢) طالب: بياناته فقط، ولا يرى زملاءه ولا مدرسًا غير مرتبط
-- =====================================================================
select pg_temp.login_as('44444444-4444-4444-4444-444444444444');
select is(
  (select count(*)::int from app.student_profiles),
  1,
  'الطالب يرى ملفه المحلي فقط'
);
select is(
  (select full_name from app.student_profiles limit 1),
  'طالب عند الأول',
  'الملف الظاهر هو ملفه'
);
select is(
  (select count(*)::int from app.profiles),
  1,
  'الطالب يرى ملفه الشخصي فقط (لا زملاء ولا إدارة)'
);
select is(
  (select count(*)::int from public.groups),
  1,
  'الطالب يرى مجموعته المسجّل بها فقط'
);
select is(
  (select count(*)::int from public.groups where teacher_id = '22222222-2222-2222-2222-222222222222'),
  0,
  'لا يرى مجموعات مدرس غير مرتبط به'
);

-- =====================================================================
--  ٣) طالب مرتبط بمدرسين: مساحتان، ولا انتقال صلاحيات
-- =====================================================================
select is(
  (select jsonb_array_length(public.svc_workspaces('55555555-5555-5555-5555-555555555555'))),
  2,
  'الطالب المرتبط بمدرسين يرى مساحتين للاختيار'
);
select pg_temp.login_as('55555555-5555-5555-5555-555555555555');
select is(
  (select count(*)::int from app.student_profiles),
  2,
  'يرى ملفيه المحليين فقط'
);
select is(
  (select count(*)::int from app.student_profiles where status <> 'active'),
  0,
  'لا يرى ملفات غير نشطة'
);

-- =====================================================================
--  ٤) السوبر أدمن: قراءة أكاديمية فقط
-- =====================================================================
select pg_temp.login_as('99999999-9999-9999-9999-999999999999');
select ok(
  (select count(*)::int from app.profiles) >= 6,
  'السوبر أدمن يقرأ ملفات الحسابات (متابعة إدارية)'
);
select is(
  (select count(*)::int from app.audit_events),
  0,
  'سجل التدقيق فارغ في هذه المعاملة (append-only لم يُكتب منه شيء)'
);
select throws_ok(
  $$ insert into public.groups (teacher_id, name, academic_year)
     values ('11111111-1111-1111-1111-111111111111', 'مجموعة السوبر', '2026/2027') $$,
  '42501',
  null,
  'السوبر أدمن لا يملك كتابة أكاديمية (إنشاء مجموعة مرفوض)'
);
select throws_ok(
  $$ update app.student_profiles set full_name = 'تعديل إداري'
     where id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  '42501',
  null,
  'السوبر أدمن لا يعدّل ملف طالب'
);

-- =====================================================================
--  ٥) المساعد: قراءة فقط حسب صلاحيته، والكتابة تُرفض
-- =====================================================================
select pg_temp.login_as('33333333-3333-3333-3333-333333333333');
select is(
  (select count(*)::int from app.student_profiles),
  2,
  'المساعد بصلاحية students:read يرى طلاب المساحة'
);
select throws_ok(
  $$ insert into app.student_profiles (teacher_id, full_name, local_code)
     values ('11111111-1111-1111-1111-111111111111', 'طالب جديد', 'S9') $$,
  '42501',
  null,
  'المساعد بلا students:write لا ينشئ ملف طالب'
);
select throws_ok(
  $$ insert into public.groups (teacher_id, name, academic_year)
     values ('11111111-1111-1111-1111-111111111111', 'مجموعة المساعد', '2026/2027') $$,
  '42501',
  null,
  'المساعد بلا groups:write لا ينشئ مجموعة'
);
select is(
  (select count(*)::int from public.groups),
  1,
  'المساعد يرى مجموعات المساحة المسموح بها'
);

-- =====================================================================
--  ٦) الإيقاف وإبطال الجلسات
-- =====================================================================
reset role;
update app.profiles set status = 'suspended' where user_id = '44444444-4444-4444-4444-444444444444';

select pg_temp.login_as('44444444-4444-4444-4444-444444444444');
select is(
  (select count(*)::int from app.student_profiles),
  0,
  'الحساب الموقوف لا يرى شيئًا حتى بجلسة صالحة شكليًا'
);
select is(app.is_active(), false, 'is_active ترجع false للموقوف');

reset role;
update app.profiles set status = 'active', sessions_valid_after = now() + interval '1 hour'
where user_id = '44444444-4444-4444-4444-444444444444';

select pg_temp.login_as('44444444-4444-4444-4444-444444444444');
select is(
  (select count(*)::int from app.student_profiles),
  0,
  'جلسة أُصدرت قبل sessions_valid_after تُرفض'
);

-- =====================================================================
--  ٧) لا وصول للجداول الحساسة من المتصفح
-- =====================================================================
select pg_temp.login_as('11111111-1111-1111-1111-111111111111');
select is(
  (select count(*)::int from app.invitations),
  0,
  'الدعوات لا تُقرأ من جلسة مستخدم (RLS بلا سياسة)'
);
select is(
  (select count(*)::int from app.recovery_tokens),
  0,
  'رموز الاستعادة لا تُقرأ من جلسة مستخدم'
);
select is(
  (select count(*)::int from app.rate_limits),
  0,
  'عدّادات حدّ المعدل غير مقروءة'
);

-- =====================================================================
--  ٨) حدّ المعدل: عدّاد ذرّي
-- =====================================================================
reset role;
select is(app.rate_limit_hit('test:key:1', 5, 900), 1, 'أول محاولة = ١');
select is(app.rate_limit_hit('test:key:1', 5, 900), 2, 'الثانية = ٢ (نفس النافذة)');
select is(app.rate_limit_hit('test:key:2', 5, 900), 1, 'مفتاح آخر يبدأ من ١');

-- =====================================================================
--  ٩) الدعوات: استخدام واحد ونوع صحيح
-- =====================================================================
select isnt(
  (select public.svc_invitation_state(repeat('a', 64))),
  null,
  'حالة دعوة غير موجودة ترجع null صريحًا (لا خطأ يخدع المستدعي)'
);

insert into app.invitations (id, kind, token_hash, teacher_id, created_by, expires_at)
values (
  'dddddddd-0000-0000-0000-000000000001', 'teacher_invite', repeat('b', 64),
  null, '99999999-9999-9999-9999-999999999999', now() + interval '72 hours'
);

select is(
  (public.svc_consume_invitation(repeat('b', 64), 'teacher_invite', '99999999-9999-9999-9999-999999999999') ->> 'kind'),
  'teacher_invite',
  'استهلاك دعوة صالحة ينجح مرة واحدة'
);
select throws_ok(
  $$ select public.svc_consume_invitation(repeat('b', 64), 'teacher_invite', '99999999-9999-9999-9999-999999999999') $$,
  '22023',
  null,
  'نفس الدعوة تُرفض في المرة الثانية (استخدام واحد)'
);

insert into app.invitations (id, kind, token_hash, created_by, expires_at)
values (
  'dddddddd-0000-0000-0000-000000000002', 'student_link', repeat('c', 64),
  '99999999-9999-9999-9999-999999999999', now() + interval '1 hour'
);
select throws_ok(
  $$ select public.svc_consume_invitation(repeat('c', 64), 'teacher_invite', '99999999-9999-9999-9999-999999999999') $$,
  '22023',
  null,
  'دعوة ربط طالب تُرفض عند استخدامها كدعوة مدرس (نوع خاطئ)'
);

insert into app.invitations (id, kind, token_hash, created_by, expires_at)
values (
  'dddddddd-0000-0000-0000-000000000003', 'teacher_invite', repeat('d', 64),
  '99999999-9999-9999-9999-999999999999', now() + interval '1 hour'
);
update app.invitations set expires_at = now() - interval '1 minute'
where id = 'dddddddd-0000-0000-0000-000000000003';
select throws_ok(
  $$ select public.svc_consume_invitation(repeat('d', 64), 'teacher_invite', '99999999-9999-9999-9999-999999999999') $$,
  '22023',
  null,
  'الدعوة المنتهية تُرفض'
);

-- =====================================================================
--  ١٠) الاستعادة: رمز واحد، مرة واحدة، ويُبطل الجلسات
-- =====================================================================
insert into app.recovery_tokens (user_id, token_hash, issued_by, reason, expires_at)
values ('44444444-4444-4444-4444-444444444444', repeat('e', 64),
        '11111111-1111-1111-1111-111111111111', 'تحقق هاتفي خارج النظام', now() + interval '30 minutes');

select isnt(
  public.svc_consume_recovery(repeat('e', 64)),
  null,
  'رمز استعادة صالح يُستهلك'
);
select throws_ok(
  $$ select public.svc_consume_recovery(repeat('e', 64)) $$,
  '22023',
  null,
  'الرمز المستخدم يُرفض في المرة الثانية'
);

select isnt(
  public.svc_invalidate_sessions('44444444-4444-4444-4444-444444444444'),
  null,
  'إبطال الجلسات يعيد وقت الإبطال'
);

-- ---------- نهاية ----------
select * from finish();
rollback;
