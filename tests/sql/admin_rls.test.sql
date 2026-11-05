-- =====================================================================
--  tests/sql/admin_rls.test.sql — المرحلة ٠٣
--  اختبارات لوحة السوبر أدمن على PostgreSQL حقيقي (pgTAP).
--
--  ما يثبته هذا الملف — لا الواجهة:
--   §١ أرقام حقيقية للوحة، وصفر صفوف لغير الإدارة.
--   §٢ دعوة مدرس: بصمة فقط، دعوة سارية واحدة، رفض المكرر والرمز السيئ.
--   §٣ إعادة الإصدار: تُلغي القديمة، وترفض المستخدمة، وتحدّ التكرار.
--   §٤ الإيقاف: بسبب، وإبطال جلسات، وبيانات باقية، وممانعة إيقاف أدمن.
--   §٥ الكتابة الأكاديمية مرفوضة على الخادم (لا في الواجهة).
--   §٦ تعليمات تصل للمستهدفين فقط (لا طلاب، ولا موقوفين).
--   §٧ السجل append-only، وسجل التدقيق لا يسر رمزًا، ودوال القرار مغلقة عن المتصفح.
--
--  التشغيل: يُنفَّذ داخل معاملة على مشروع اختبار، ثم `select * from finish()`.
--  الدروس المطبَّقة من المرحلة ٠٢ (F-18/F-19): نداء svc_* بعد `reset role`،
--  ولا CTE معدِّلة للبيانات داخل وسيط دالة.
-- =====================================================================

begin;

set local search_path = public, extensions, app, pg_temp;

select plan(53);

-- ---------- بيانات اصطناعية ----------
insert into auth.users (id, phone, phone_confirmed_at, raw_app_meta_data, raw_user_meta_data) values
  ('99999999-9999-9999-9999-999999999999','+201000000009', now(), '{"provider":"phone"}', '{}'),
  ('11111111-1111-1111-1111-111111111111','+201000000001', now(), '{"provider":"phone"}', '{}'),
  ('22222222-2222-2222-2222-222222222222','+201000000002', now(), '{"provider":"phone"}', '{}'),
  ('33333333-3333-3333-3333-333333333333','+201000000003', now(), '{"provider":"phone"}', '{}'),
  ('44444444-4444-4444-4444-444444444444','+201000000004', now(), '{"provider":"phone"}', '{}'),
  ('55555555-5555-5555-5555-555555555555','+201000000005', now(), '{"provider":"phone"}', '{}');

insert into app.profiles (user_id, full_name, role, status, phone_e164, student_code) values
  ('99999999-9999-9999-9999-999999999999','سوبر أدمن','super_admin','active','+201000000009', null),
  ('11111111-1111-1111-1111-111111111111','مدرس أول','teacher','active','+201000000001', null),
  ('22222222-2222-2222-2222-222222222222','مدرس ثانٍ','teacher','active','+201000000002', null),
  ('33333333-3333-3333-3333-333333333333','مساعد','assistant','active','+201000000003', null),
  ('44444444-4444-4444-4444-444444444444','طالب أول','student','active', null, 'MH000001'),
  ('55555555-5555-5555-5555-555555555555','طالب ثانٍ','student','active', null, 'MH000002');

insert into app.teachers (teacher_id, headline) values
  ('11111111-1111-1111-1111-111111111111', 'مدرس رياضيات'),
  ('22222222-2222-2222-2222-222222222222', 'مدرس علوم');

insert into app.student_profiles (id, teacher_id, user_id, full_name, local_code, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','طالب أول','S1','active'),
  ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','55555555-5555-5555-5555-555555555555','طالب ثانٍ','S2','active'),
  ('aaaaaaaa-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','55555555-5555-5555-5555-555555555555','طالب ثانٍ','S3','active'),
  ('aaaaaaaa-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111', null,'طالب بلا حساب','S4','pending_link');

insert into app.teacher_memberships (id, teacher_id, user_id, role_in_workspace, status) values
  ('bbbbbbbb-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','teacher','active'),
  ('bbbbbbbb-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','assistant','active'),
  ('bbbbbbbb-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','22222222-2222-2222-2222-222222222222','teacher','active');

insert into public.groups (id, teacher_id, name, subject, grade, academic_year) values
  ('cccccccc-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','مجموعة أ','رياضيات','الثالث','2026/2027'),
  ('cccccccc-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','مجموعة ب','علوم','الثاني','2026/2027');

create or replace function pg_temp.login_as(p_user_id uuid, p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user_id, 'role', p_role, 'iat', extract(epoch from now())::bigint)::text, true);
  execute format('set local role %I', p_role);
end;
$$;

-- =====================================================================
-- §١ — لوحة الإدارة: أرقام حقيقية، وصفر صفوف لغير الإدارة
-- =====================================================================
select pg_temp.login_as('99999999-9999-9999-9999-999999999999');

select is((select count(*)::int from public.admin_overview), 1, '١-السوبر أدمن يرى لوحة واحدة');
select is((select (stats ->> 'teachers_total')::int from public.admin_overview), 2, '١-عدد المدرسين من الصفوف الحقيقية');
select is((select (stats ->> 'students_total')::int from public.admin_overview), 4, '١-عدد ملفات الطلاب حقيقي لا تقديري');
select is((select (stats ->> 'invitations_pending')::int from public.admin_overview), 0, '١-لا دعوات معلّقة بعد');
select is((select count(*)::int from public.admin_teachers), 2, '١-قائمة المدرسين كاملة للأدمن');
select ok((select bool_and(char_length(phone_last4) <= 4) from public.admin_teachers), '١-الهاتف مقنّص إلى ٤ أرقام');
select hasnt_column('public', 'admin_invitations', 'token_hash', '١-عرض الدعوات لا يحمل بصمة الرمز أصلًا');

select pg_temp.login_as('11111111-1111-1111-1111-111111111111');
select is((select count(*)::int from public.admin_overview), 0, '١-المدرس لا يرى لوحة الإدارة');
select is((select count(*)::int from public.admin_teachers), 0, '١-المدرس لا يرى قائمة المدرسين');
select is((select count(*)::int from public.admin_audit_log), 0, '١-المدرس لا يرى سجل التدقيق الإداري');

-- =====================================================================
-- §٢ — دعوة مدرس
-- =====================================================================
select pg_temp.login_as('44444444-4444-4444-4444-444444444444');
select throws_ok(
  $$ select public.svc_admin_invite_teacher('44444444-4444-4444-4444-444444444444','+201000000077','مدرس جديد',null,repeat('a',64),72) $$,
  '42501', null, '٢-الطالب لا يستدعي دالة الدعوة (مغلقة عن authenticated)'
);

reset role;
select throws_ok(
  $$ select public.svc_admin_invite_teacher('44444444-4444-4444-4444-444444444444','+201000000077','مدرس جديد',null,repeat('a',64),72) $$,
  '42501', null, '٢-غير الأدمن لا يُدعى بحجة أن النداء من الخادم'
);
select ok(
  (public.svc_admin_invite_teacher('99999999-9999-9999-9999-999999999999','+201000000077','مدرس جديد','رياضيات',repeat('a',64),72) ? 'invitation_id'),
  '٢-الأدمن ينشئ دعوة مدرس'
);
select ok(
  (public.svc_admin_invite_teacher('99999999-9999-9999-9999-999999999999','+201000000077','مدرس جديد','رياضيات',repeat('c',64),72) ? 'invitation_id'),
  '٢-إعادة الدعوة لنفس الرقم تُنشئ بديلة'
);
select is(
  (select count(*)::int from app.invitations
    where kind = 'teacher_invite' and target_hint = '+201000000077'
      and used_at is null and revoked_at is null),
  1,
  '٢-دعوة سارية واحدة فقط لكل رقم (القديمة أُلغيت)'
);
select throws_ok(
  $$ select public.svc_admin_invite_teacher('99999999-9999-9999-9999-999999999999','+201000000001','مدرس مكرر',null,repeat('d',64),72) $$,
  '23405', null, '٢-رقم مسجَّل لا يُدعى مرة أخرى'
);
select throws_ok(
  $$ select public.svc_admin_invite_teacher('99999999-9999-9999-9999-999999999999','+201000000078','مدرس',null,'not-a-hash',72) $$,
  '22023', null, '٢-بصمة غير صالحة تُرفض قبل أي إدراج'
);
select is(
  (select count(*)::int from app.invitations where token_hash like '%a%' and char_length(token_hash) = 64),
  1,
  '٢-الرمز يُخزَّن بصمة ٦٤ خانة فقط'
);
select ok(
  not exists (select 1 from app.audit_events where detail::text like '%' || repeat('a',64) || '%'),
  '٢-سجل التدقيق لا يحمل الرمز الخام'
);
select is(
  (select count(*)::int from app.audit_events where action = 'admin.teacher.invited'),
  2,
  '٢-كل دعوة لها حدث تدقيق'
);

-- =====================================================================
-- §٣ — إعادة إصدار الدعوة
-- =====================================================================
select ok(
  (public.svc_admin_reissue_invitation(
     '99999999-9999-9999-9999-999999999999',
     (select id from app.invitations where kind = 'teacher_invite' and target_hint = '+201000000077'
        and used_at is null and revoked_at is null),
     repeat('b',64), 24) ? 'invitation_id'),
  '٣-إعادة الإصدار تنجح لدعوة غير مستخدمة'
);
select is(
  (select count(*)::int from app.invitations
    where kind = 'teacher_invite' and target_hint = '+201000000077' and revoked_at is null and used_at is null),
  1,
  '٣-تبقى دعوة سارية واحدة بعد إعادة الإصدار'
);
select is(
  (select count(*)::int from app.invitations
    where kind = 'teacher_invite' and target_hint = '+201000000077' and revoked_at is not null),
  2,
  '٣-الدعوتان السابقتان أُلغيتا لا حُذفتا (أثر محفوظ)'
);
select throws_ok(
  format($$ select public.svc_admin_reissue_invitation('99999999-9999-9999-9999-999999999999', %L, repeat('e',64), 24) $$,
    (select id from app.invitations where kind='teacher_invite' and target_hint='+201000000077' and revoked_at is null)),
  '42900', null, '٣-سياسة الحد: لا إعادة إصدار رابعة في ٢٤ ساعة'
);

insert into app.invitations (id, kind, token_hash, target_hint, created_by, created_at, expires_at, used_at)
values ('dddddddd-0000-0000-0000-000000000009','teacher_invite',repeat('f',64),'+201000000098',
        '99999999-9999-9999-9999-999999999999', now() - interval '2 days', now() + interval '1 day', now());

select throws_ok(
  $$ select public.svc_admin_reissue_invitation('99999999-9999-9999-9999-999999999999','dddddddd-0000-0000-0000-000000000009',repeat('9',64),24) $$,
  '22023', null, '٣-دعوة مستخدمة لا يُعاد إصدارها'
);

-- =====================================================================
-- §٤ — الإيقاف والتفعيل
-- =====================================================================
select throws_ok(
  $$ select public.svc_admin_set_account_status('99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111','suspended','قصير') $$,
  '22023', null, '٤-الإيقاف بلا سبب كافٍ مرفوض'
);
select throws_ok(
  $$ select public.svc_admin_set_account_status('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','suspended','محاولة مدرس') $$,
  '42501', null, '٤-المدرس لا يوقف حساب غيره'
);
select is(
  (public.svc_admin_set_account_status('99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111','suspended','مخالفة سياسة الاستخدام') ->> 'status'),
  'suspended',
  '٤-الأدمن يوقف الحساب بسبب موثق'
);
select ok(
  (select sessions_valid_after from app.profiles where user_id = '11111111-1111-1111-1111-111111111111')
    >= now() - interval '10 seconds',
  '٤-الإيقاف يُبطل الجلسات الصادرة قبل الآن'
);
select is(
  (select count(*)::int from app.student_profiles where teacher_id = '11111111-1111-1111-1111-111111111111'),
  3,
  '٤-بيانات المساحة باقية بعد الإيقاف (لا محو)'
);
select is(
  (select reason from app.account_events
    where user_id = '11111111-1111-1111-1111-111111111111' and action = 'suspend'
    order by at desc limit 1),
  'مخالفة سياسة الاستخدام',
  '٤-السبب محفوظ في سجل الحساب'
);
select is(
  (select actor_role::text from app.audit_events
    where action = 'admin.account.suspended' order by at desc limit 1),
  'super_admin',
  '٤-حدث التدقيق يحمل دور الفاعل'
);
select throws_ok(
  $$ select public.svc_admin_set_account_status('99999999-9999-9999-9999-999999999999','99999999-9999-9999-9999-999999999999','suspended','محاولة إيقاف الإدارة') $$,
  '42501', null, '٤-لا يوقف أدمنٌ حساب أدمن'
);
select is(
  (public.svc_admin_set_account_status('99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111','suspended','تكرار نفس القرار') ->> 'changed')::boolean,
  false,
  '٤-تكرار نفس القرار لا يُنشئ حدثًا جديدًا'
);

select pg_temp.login_as('11111111-1111-1111-1111-111111111111');
select is((select count(*)::int from app.student_profiles), 0, '٤-المدرس الموقوف لا يقرأ ملفات طلابه');
select is((select count(*)::int from public.admin_teachers), 0, '٤-المدرس الموقوف لا يرى لوحة الإدارة');

reset role;
select is(
  (public.svc_admin_set_account_status('99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111','active','انتهاء سبب الإيقاف') ->> 'status'),
  'active',
  '٤-التفعيل يعيد الحساب بلا حذف أي بيانات'
);

-- =====================================================================
-- §٥ — الإدارة لا تكتب أكاديميًا (حتى لو أرسلت الطلب يدويًا)
-- =====================================================================
select pg_temp.login_as('99999999-9999-9999-9999-999999999999');

update app.student_profiles set full_name = 'تعديل إداري' where id = 'aaaaaaaa-0000-0000-0000-000000000001';

reset role;
select is(
  (select full_name from app.student_profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'طالب أول',
  '٥-تعديل الأدمن لملف طالب لا يغيّر شيئًا (لا سياسة كتابة)'
);

select pg_temp.login_as('99999999-9999-9999-9999-999999999999');
select throws_ok(
  $$ insert into public.groups (teacher_id, name, academic_year)
     values ('11111111-1111-1111-1111-111111111111','مجموعة الإدارة','2026/2027') $$,
  '42501', null, '٥-الإدارة لا تنشئ مجموعة'
);
select throws_ok(
  $$ update app.profiles set status = 'suspended' where user_id = '22222222-2222-2222-2222-222222222222' $$,
  '42501', null, '٥-لا تغيير حالة مباشر من المتصفح: القرار يمرّ بدالة الخادم'
);
select ok((select count(*)::int from public.admin_audit_log) >= 3, '٥-سجل التدقيق مقروء للأدمن');

-- =====================================================================
-- §٦ — تعليمات تصل للمستهدفين فقط
-- =====================================================================
reset role;
select is(
  (public.svc_admin_send_instruction('99999999-9999-9999-9999-999999999999',
     'اجتماع المدرسين', 'يرجى مراجعة خطة الأسبوع قبل الخميس', 'all_teachers') ->> 'recipients')::int,
  2,
  '٦-الإرسال للجميع يصل المدرسين النشطين وحدهما (لا مساعد ولا طالب ولا أدمن)'
);

select throws_ok(
  $$ select public.svc_admin_send_instruction('99999999-9999-9999-9999-999999999999',
       'تعليم', 'نص تعليم واضح للمدرسين', 'teachers', array['44444444-4444-4444-4444-444444444444']::uuid[]) $$,
  '22023', null, '٦-الطالب لا يمكن أن يكون مستلمًا'
);

select pg_temp.login_as('22222222-2222-2222-2222-222222222222');
select is((select count(*)::int from public.my_notifications), 1, '٦-المدرس المستهدف يرى التعليم');

update app.notification_recipients set read_at = now() where user_id = '22222222-2222-2222-2222-222222222222';
select is(
  (select read_at is not null from public.my_notifications limit 1),
  true,
  '٦-المستلم يعلّم إشعاره كمقروء'
);
select is(
  (select count(*)::int from app.notification_recipients where user_id <> '22222222-2222-2222-2222-222222222222'),
  0,
  '٦-المدرس لا يرى صفوف مستلمين آخرين'
);

select pg_temp.login_as('44444444-4444-4444-4444-444444444444');
select is((select count(*)::int from public.my_notifications), 0, '٦-الطالب لا يصله أي تعليم إداري');

reset role;
select is(
  (select (detail ->> 'recipients')::int from app.audit_events
    where action = 'admin.instruction.sent' order by at desc limit 1),
  2,
  '٦-عدد المستلمين مسجَّل في التدقيق'
);

-- =====================================================================
-- §٧ — السجل append-only، ودوال القرار مغلقة عن المتصفح
-- =====================================================================
select throws_ok('update app.audit_events set action = ''tampered''', '42501', null, '٧-لا تعديل على سجل التدقيق');
select throws_ok('delete from app.audit_events', '42501', null, '٧-لا حذف من سجل التدقيق');
select throws_ok('truncate app.account_events', '42501', null, '٧-لا تفريغ لسجل الحساب');

select pg_temp.login_as('99999999-9999-9999-9999-999999999999');
select throws_ok(
  $$ select public.svc_admin_stats('99999999-9999-9999-9999-999999999999') $$,
  '42501', null, '٧-دوال القرار مغلقة حتى عن الأدمن من المتصفح'
);
select throws_ok(
  $$ select app.assert_active_super_admin('99999999-9999-9999-9999-999999999999') $$,
  '42501', null, '٧-دالة الحراسة نفسها لا تُستدعى من المتصفح (تمنع تسريب صف الملف)'
);

select * from finish();
