-- =====================================================================
-- انحدار المرحلة ٠٢ بعد مهاجرتي ٠٣ — تركيز على المسارات التي لمستها 0006/0007
-- (إعادة تعريف app.audit، عمود invitations.meta، عمود audit_events.actor_role،
--  العروض الجديدة على مستخدمَي ٠٢، وسياسة المجموعات F-17).
--
-- ملاحظة صريحة: هذا **ليس** الملف الكامل `identity_rls.test.sql` (٥١ تأكيدًا)،
-- بل ١٢ تأكيدًا على نقاط الالتحام. الملف الكامل يُعاد تشغيله في خطوة الفحص
-- المستقلة أو في CI حيث يُتاح psql؛ التشغيل هنا جرى عبر Management API.
--
-- التشغيل: begin; set local search_path = public, extensions, app, pg_temp; <الملف>; rollback;
-- =====================================================================
create temp table r(seq serial, t text) on commit drop;
grant select, insert on r to authenticated;
grant usage, select on sequence r_seq_seq to authenticated;
select plan(12);

insert into auth.users (id, phone, phone_confirmed_at) values
  ('99999999-9999-9999-9999-999999999999','+201000000009',now()),
  ('11111111-1111-1111-1111-111111111111','+201000000001',now()),
  ('44444444-4444-4444-4444-444444444444','+201000000004',now()),
  ('55555555-5555-5555-5555-555555555555','+201000000005',now());
insert into app.profiles (user_id, full_name, role, status, phone_e164, student_code) values
  ('99999999-9999-9999-9999-999999999999','أدمن تجريبي','super_admin','active','+201000000009',null),
  ('11111111-1111-1111-1111-111111111111','مدرس تجريبي','teacher','active','+201000000001',null),
  ('44444444-4444-4444-4444-444444444444','طالب تجريبي','student','active',null,'MH000001'),
  ('55555555-5555-5555-5555-555555555555','طالب ثانوي','student','active',null,'MH000002');
insert into app.teachers (teacher_id) values ('11111111-1111-1111-1111-111111111111');
insert into app.teacher_memberships (id, teacher_id, user_id, role_in_workspace, status)
values ('bbbbbbbb-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','teacher','active');
insert into app.student_profiles (id, teacher_id, user_id, full_name, local_code, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','طالب تجريبي','S1','active'),
  ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111',null,'طالب جديد','S2','pending_link');
insert into public.groups (id, teacher_id, name, academic_year)
values ('cccccccc-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','مجموعة أ','2026/2027');
insert into public.group_memberships (group_id, student_profile_id)
values ('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001');
insert into app.invitations (id, kind, token_hash, student_profile_id, created_by, expires_at)
values ('dddddddd-0000-0000-0000-000000000001','student_link',repeat('a',64),'aaaaaaaa-0000-0000-0000-000000000002','99999999-9999-9999-9999-999999999999', now()+interval '1 hour');

-- مسار قبول الدعوة يستدعي app.audit — تغيّر توقيعه في ٠٠٠٦
insert into r(t) select * from isnt(
  public.svc_accept_invitation(repeat('a',64),'student_link','55555555-5555-5555-5555-555555555555','طالب جديد',null,null),
  null::jsonb, 'a1 accept');
insert into r(t) select * from is(
  (select user_id from app.student_profiles where id='aaaaaaaa-0000-0000-0000-000000000002'),
  '55555555-5555-5555-5555-555555555555'::uuid, 'a2 linked');
-- F-26/L-52: قبول الدعوة لا يكتب حدث تدقيق (سلوك ٠٢، لم يتغيّر في ٠٣)
insert into r(t) select * from is((select count(*)::int from app.audit_events), 0,
  'a3 accept writes no audit');
insert into r(t) select * from is(
  (select count(*)::int from app.invitations where used_at is not null), 1, 'a4 consumed once');
insert into r(t) select * from is(
  (select count(*)::int from app.audit_events where actor_user_id is not null and actor_role is null), 0,
  'a5 no actor without role');
insert into app.invitations (id, kind, token_hash, created_by, expires_at)
values ('dddddddd-0000-0000-0000-000000000002','teacher_invite',repeat('b',64),'99999999-9999-9999-9999-999999999999',now()+interval '1 hour');
insert into r(t) select * from is(
  (select meta::text from app.invitations where id='dddddddd-0000-0000-0000-000000000002'), '{}',
  'a6 meta default');

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object('sub','44444444-4444-4444-4444-444444444444','role','authenticated','iat',extract(epoch from now())::bigint)::text, true);
insert into r(t) select * from is((select count(*)::int from app.student_profiles), 1, 'a7 student sees own');
insert into r(t) select * from is((select count(*)::int from public.groups), 1, 'a8 groups policy');
insert into r(t) select * from is((select count(*)::int from public.admin_teachers), 0, 'a9 student no teachers');
insert into r(t) select * from is((select count(*)::int from public.my_notifications), 0, 'a10 student inbox empty');
select set_config('request.jwt.claims', jsonb_build_object('sub','11111111-1111-1111-1111-111111111111','role','authenticated','iat',extract(epoch from now())::bigint)::text, true);
insert into r(t) select * from is((select count(*)::int from app.student_profiles), 2, 'a11 teacher sees own students');
insert into r(t) select * from is((select count(*)::int from public.admin_overview), 0, 'a12 teacher no dashboard');

select jsonb_agg(t order by seq) from r;
select * from finish();
