-- =====================================================================
--  0005_rls_identity.sql — المرحلة ٠٢
--  الحدّ الأمني الفعلي: RLS على كل جدول + منح محدود + واجهات قراءة في public.
--
--  المبدأ الحاكم (PERMISSIONS §١): لا حدّ في المتصفح. كل قراءة/كتابة تُفحص هنا.
--  قاعدة إضافية: السوبر أدمن **قراءة أكاديمية فقط**؛ لا سياسة كتابة أكاديمية له إطلاقًا.
--
--  لماذا منح SELECT على جداول app ونرى RLS؟ لأن الواجهات في public هي
--  `security_invoker = true`، فتعمل بصلاحيات المستدعي وتمرّ على RLS.
--  مخطط app نفسه غير مكشوف في PostgREST (0001 + config.toml)، فلا وصول مباشر من المتصفح.
-- =====================================================================

-- ---------- تفعيل RLS على كل الجداول ----------
alter table app.profiles               enable row level security;
alter table app.teachers               enable row level security;
alter table app.student_profiles       enable row level security;
alter table app.teacher_memberships    enable row level security;
alter table app.assistant_permissions  enable row level security;
alter table public.groups              enable row level security;
alter table public.group_memberships   enable row level security;
alter table app.invitations            enable row level security;
alter table app.recovery_tokens        enable row level security;
alter table app.rate_limits            enable row level security;
alter table app.audit_events           enable row level security;

-- جداول لا يصلها المتصفح أبدًا: RLS بلا أي سياسة = رفض كامل لغير service_role
comment on table app.invitations is
  'دعوات: لا سياسة لأي دور عميل. الإنشاء/الاستهلاك عبر Edge Functions بمفتاح خدمة فقط.';
comment on table app.rate_limits is
  'عدّادات: لا سياسة لأي دور عميل. تُكتب عبر app.rate_limit_hit فقط.';

-- ---------- المنح ----------
grant usage on schema app to authenticated;
revoke all on schema app from anon;

grant execute on function app.is_active() to authenticated;
grant execute on function app.is_super_admin() to authenticated;
grant execute on function app.current_role_name() to authenticated;
grant execute on function app.current_profile() to authenticated;
grant execute on function app.teacher_id_of_current_user() to authenticated;
grant execute on function app.is_workspace_member(uuid) to authenticated;
grant execute on function app.is_workspace_teacher(uuid) to authenticated;
grant execute on function app.assistant_can(uuid, text, uuid) to authenticated;
grant execute on function app.student_profile_of_current_user(uuid) to authenticated;

-- UPDATE عمودي: الاسم فقط. الدور والمعرّفات محمية بحراسة 0002.
grant select (user_id, full_name, role, status, phone_e164, student_code, sessions_valid_after, created_at, updated_at)
  on app.profiles to authenticated;
grant update (full_name) on app.profiles to authenticated;

grant select on app.teachers to authenticated;
grant select on app.teacher_memberships to authenticated;
grant select on app.assistant_permissions to authenticated;
grant select, insert, update on app.student_profiles to authenticated;
grant select on app.audit_events to authenticated;

grant select, insert, update, delete on public.groups to authenticated;
grant select, insert, update, delete on public.group_memberships to authenticated;

-- ---------- الملفات ----------
drop policy if exists profiles_select_own on app.profiles;
create policy profiles_select_own on app.profiles
  for select to authenticated
  using (user_id = auth.uid() and app.is_active());

drop policy if exists profiles_select_super_admin on app.profiles;
create policy profiles_select_super_admin on app.profiles
  for select to authenticated
  using (app.is_super_admin());
-- ملاحظة أمنية: السياسة أعلاه قراءة فقط. لا توجد سياسة insert/update/delete للسوبر أدمن
-- على أي جدول أكاديمي — إدارة الحسابات تمرّ عبر Edge Functions بمفتاح خدمة + تدقيق.

drop policy if exists profiles_update_own_name on app.profiles;
create policy profiles_update_own_name on app.profiles
  for update to authenticated
  using (user_id = auth.uid() and app.is_active())
  with check (user_id = auth.uid() and app.is_active());

drop policy if exists profiles_select_my_teacher on app.profiles;
create policy profiles_select_my_teacher on app.profiles
  for select to authenticated
  using (
    app.is_active()
    and exists (
      select 1 from app.teacher_memberships m
      where m.user_id = auth.uid() and m.status = 'active' and m.teacher_id = app.profiles.user_id
    )
  );

-- ---------- المدرسون ----------
drop policy if exists teachers_select_self on app.teachers;
create policy teachers_select_self on app.teachers
  for select to authenticated
  using (teacher_id = auth.uid() and app.is_active());

drop policy if exists teachers_select_members on app.teachers;
create policy teachers_select_members on app.teachers
  for select to authenticated
  using (app.is_workspace_member(teacher_id));

drop policy if exists teachers_select_admin on app.teachers;
create policy teachers_select_admin on app.teachers
  for select to authenticated
  using (app.is_super_admin());

-- ---------- ملفات الطلاب ----------
drop policy if exists student_profiles_select_teacher on app.student_profiles;
create policy student_profiles_select_teacher on app.student_profiles
  for select to authenticated
  using (
    app.is_workspace_teacher(teacher_id)
    or app.assistant_can(teacher_id, 'students:read', null)
  );

drop policy if exists student_profiles_write_teacher on app.student_profiles;
create policy student_profiles_write_teacher on app.student_profiles
  for insert to authenticated
  with check (
    app.is_workspace_teacher(teacher_id)
    or app.assistant_can(teacher_id, 'students:write', null)
  );

drop policy if exists student_profiles_update_teacher on app.student_profiles;
create policy student_profiles_update_teacher on app.student_profiles
  for update to authenticated
  using (
    app.is_workspace_teacher(teacher_id)
    or app.assistant_can(teacher_id, 'students:write', null)
  )
  with check (
    app.is_workspace_teacher(teacher_id)
    or app.assistant_can(teacher_id, 'students:write', null)
  );

drop policy if exists student_profiles_select_own on app.student_profiles;
create policy student_profiles_select_own on app.student_profiles
  for select to authenticated
  using (user_id = auth.uid() and status = 'active' and app.is_active());

-- لا سياسة DELETE: الأرشفة بحالة status، لا حذف بيانات طالب.

-- ---------- العضويات ----------
drop policy if exists memberships_select_own on app.teacher_memberships;
create policy memberships_select_own on app.teacher_memberships
  for select to authenticated
  using (user_id = auth.uid() and app.is_active());

drop policy if exists memberships_select_workspace on app.teacher_memberships;
create policy memberships_select_workspace on app.teacher_memberships
  for select to authenticated
  using (app.is_workspace_teacher(teacher_id));

-- ---------- صلاحيات المساعد ----------
drop policy if exists assistant_permissions_select_own on app.assistant_permissions;
create policy assistant_permissions_select_own on app.assistant_permissions
  for select to authenticated
  using (
    exists (
      select 1 from app.teacher_memberships m
      where m.id = app.assistant_permissions.membership_id
        and m.user_id = auth.uid()
        and m.status = 'active'
    )
  );

drop policy if exists assistant_permissions_select_teacher on app.assistant_permissions;
create policy assistant_permissions_select_teacher on app.assistant_permissions
  for select to authenticated
  using (
    exists (
      select 1 from app.teacher_memberships m
      where m.id = app.assistant_permissions.membership_id
        and app.is_workspace_teacher(m.teacher_id)
    )
  );
-- الكتابة على الصلاحيات: عبر Edge Functions فقط (تفويض = قرار مدرس موثّق في التدقيق).

-- ---------- المجموعات ----------
drop policy if exists groups_select_member on public.groups;
create policy groups_select_member on public.groups
  for select to authenticated
  using (
    app.is_workspace_member(teacher_id)
    or app.assistant_can(teacher_id, 'groups:read', id)
    or exists (
      select 1
      from public.group_memberships gm
      join app.student_profiles sp on sp.id = gm.student_profile_id
      where gm.group_id = public.groups.id
        and gm.left_at is null
        and sp.user_id = auth.uid()
        and sp.status = 'active'
        and app.is_active()
    )
  );

drop policy if exists groups_write_teacher on public.groups;
create policy groups_write_teacher on public.groups
  for insert to authenticated
  with check (
    app.is_workspace_teacher(teacher_id)
    or app.assistant_can(teacher_id, 'groups:write', null)
  );

drop policy if exists groups_update_teacher on public.groups;
create policy groups_update_teacher on public.groups
  for update to authenticated
  using (
    app.is_workspace_teacher(teacher_id)
    or app.assistant_can(teacher_id, 'groups:write', id)
  )
  with check (
    app.is_workspace_teacher(teacher_id)
    or app.assistant_can(teacher_id, 'groups:write', id)
  );

drop policy if exists groups_delete_teacher on public.groups;
create policy groups_delete_teacher on public.groups
  for delete to authenticated
  using (app.is_workspace_teacher(teacher_id));

-- ---------- عضويات المجموعات ----------
drop policy if exists group_memberships_select on public.group_memberships;
create policy group_memberships_select on public.group_memberships
  for select to authenticated
  using (
    exists (select 1 from public.groups g where g.id = public.group_memberships.group_id and app.is_workspace_member(g.teacher_id))
    or exists (
      select 1 from app.student_profiles sp
      where sp.id = public.group_memberships.student_profile_id
        and sp.user_id = auth.uid()
        and sp.status = 'active'
        and app.is_active()
    )
  );

drop policy if exists group_memberships_write on public.group_memberships;
create policy group_memberships_write on public.group_memberships
  for insert to authenticated
  with check (
    exists (
      select 1 from public.groups g
      where g.id = public.group_memberships.group_id
        and (app.is_workspace_teacher(g.teacher_id) or app.assistant_can(g.teacher_id, 'groups:write', g.id))
        and exists (
          select 1 from app.student_profiles sp
          where sp.id = public.group_memberships.student_profile_id
            and sp.teacher_id = g.teacher_id
        )
    )
  );

drop policy if exists group_memberships_update on public.group_memberships;
create policy group_memberships_update on public.group_memberships
  for update to authenticated
  using (
    exists (
      select 1 from public.groups g
      where g.id = public.group_memberships.group_id
        and (app.is_workspace_teacher(g.teacher_id) or app.assistant_can(g.teacher_id, 'groups:write', g.id))
    )
  )
  with check (
    exists (
      select 1 from public.groups g
      where g.id = public.group_memberships.group_id
        and (app.is_workspace_teacher(g.teacher_id) or app.assistant_can(g.teacher_id, 'groups:write', g.id))
    )
  );

-- ---------- التدقيق ----------
drop policy if exists audit_events_select_admin on app.audit_events;
create policy audit_events_select_admin on app.audit_events
  for select to authenticated
  using (app.is_super_admin());

drop policy if exists audit_events_select_own on app.audit_events;
create policy audit_events_select_own on app.audit_events
  for select to authenticated
  using (actor_user_id = auth.uid() and app.is_active());
-- لا سياسة كتابة: التدقيق يُكتب من دوال الخادم (append-only).

-- ---------- دوال خدمة للـEdge Functions ----------
-- مخطط app غير مكشوف في PostgREST، فالدوال التي تستدعيها Edge Functions تحتاج غلافًا في public.
-- هذه الأغلفة SECURITY DEFINER ومغلقة تمامًا: لا anon ولا authenticated، فقط service_role.
create or replace function public.svc_rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
returns integer
language sql
security definer
set search_path = app, pg_temp
as $$
  select app.rate_limit_hit(p_key, p_limit, p_window_seconds);
$$;

create or replace function public.svc_consume_invitation(p_token_hash text, p_kind text, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_row app.invitations;
begin
  v_row := app.consume_invitation(p_token_hash, p_kind::app.invitation_kind, p_user_id);
  return jsonb_build_object(
    'id', v_row.id,
    'kind', v_row.kind,
    'teacher_id', v_row.teacher_id,
    'student_profile_id', v_row.student_profile_id
  );
end;
$$;

create or replace function public.svc_consume_recovery(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_row app.recovery_tokens;
begin
  v_row := app.consume_recovery_token(p_token_hash);
  return jsonb_build_object('id', v_row.id, 'user_id', v_row.user_id, 'issued_by', v_row.issued_by);
end;
$$;

create or replace function public.svc_invalidate_sessions(p_user_id uuid)
returns timestamptz
language sql
security definer
set search_path = app, pg_temp
as $$
  select app.invalidate_sessions(p_user_id);
$$;

create or replace function public.svc_audit(
  p_action text,
  p_actor uuid default null,
  p_teacher uuid default null,
  p_entity text default null,
  p_entity_id uuid default null,
  p_outcome text default 'ok',
  p_detail jsonb default '{}'::jsonb,
  p_ip_hash text default null
)
returns void
language sql
security definer
set search_path = app, pg_temp
as $$
  select app.audit(p_action, p_actor, p_teacher, p_entity, p_entity_id, p_outcome, p_detail, p_ip_hash);
$$;

-- قراءة سياق المستخدم (بدل قراءة app.profiles من الدالة)
create or replace function public.svc_profile_context(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = app, pg_temp
as $$
  select coalesce(
    (select jsonb_build_object(
       'user_id', p.user_id,
       'full_name', p.full_name,
       'role', p.role,
       'status', p.status,
       'phone_last4', right(coalesce(p.phone_e164, ''), 4),
       'student_code', p.student_code,
       'sessions_valid_after', p.sessions_valid_after
     ) from app.profiles p where p.user_id = p_user_id),
    'null'::jsonb
  );
$$;

-- مساحات المستخدم (مدرس/مساعد/طالب) — العزل داخل SQL لا في المتصفح
create or replace function public.svc_workspaces(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = app, pg_temp
as $$
  with me as (
    select p.user_id, p.role, p.status from app.profiles p where p.user_id = p_user_id
  ),
  teaching as (
    select jsonb_build_object(
      'teacher_id', m.teacher_id,
      'teacher_name', tp.full_name,
      'role', m.role_in_workspace,
      'kind', 'teaching'
    ) as item
    from app.teacher_memberships m
    join app.profiles tp on tp.user_id = m.teacher_id
    join me on me.user_id = p_user_id
    where m.user_id = p_user_id and m.status = 'active' and me.role in ('teacher', 'assistant')
  ),
  learning as (
    select jsonb_build_object(
      'teacher_id', sp.teacher_id,
      'teacher_name', tp.full_name,
      'role', 'student',
      'kind', 'learning'
    ) as item
    from app.student_profiles sp
    join app.profiles tp on tp.user_id = sp.teacher_id
    join me on me.user_id = p_user_id
    where sp.user_id = p_user_id and sp.status = 'active' and me.role = 'student'
  )
  select coalesce(jsonb_agg(item), '[]'::jsonb) from (select item from teaching union all select item from learning) t;
$$;

-- حالة الدعوة بلا استهلاك (للتشخيص قبل أي إنشاء حساب)
create or replace function public.svc_invitation_state(p_token_hash text)
returns jsonb
language sql
security definer
set search_path = app, pg_temp
as $$
  select coalesce(
    (select jsonb_build_object(
       'id', i.id,
       'kind', i.kind,
       'teacher_id', i.teacher_id,
       'student_profile_id', i.student_profile_id,
       'expires_at', i.expires_at,
       'used_at', i.used_at,
       'revoked_at', i.revoked_at
     ) from app.invitations i where i.token_hash = p_token_hash),
    'null'::jsonb
  );
$$;

-- قبول الهوية: upsert للملف + صف المدرس عند الحاجة (بعد استهلاك الدعوة)
create or replace function public.svc_accept_identity(
  p_user_id uuid,
  p_full_name text,
  p_role text,
  p_phone text default null,
  p_code text default null,
  p_status text default 'active'
)
returns jsonb
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_profile app.profiles;
begin
  insert into app.profiles (user_id, full_name, role, status, phone_e164, student_code)
  values (p_user_id, p_full_name, p_role::app.user_role, p_status::app.account_status, p_phone, p_code)
  on conflict (user_id) do update
    set full_name = excluded.full_name,
        status = excluded.status,
        updated_at = now()
  returning * into v_profile;

  if v_profile.role = 'teacher' then
    insert into app.teachers (teacher_id) values (v_profile.user_id)
    on conflict (teacher_id) do nothing;
  end if;

  return jsonb_build_object(
    'user_id', v_profile.user_id,
    'full_name', v_profile.full_name,
    'role', v_profile.role,
    'status', v_profile.status
  );
end;
$$;

-- ربط ملف طالب قائم بحساب (مرة واحدة فقط)
create or replace function public.svc_link_student_profile(p_student_profile_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_row app.student_profiles;
begin
  update app.student_profiles
  set user_id = p_user_id, status = 'active', linked_at = now(), updated_at = now()
  where id = p_student_profile_id
    and (user_id is null or user_id = p_user_id)
  returning * into v_row;

  if not found then
    raise exception 'student-profile-not-linkable' using errcode = '22023';
  end if;

  return jsonb_build_object('student_profile_id', v_row.id, 'teacher_id', v_row.teacher_id);
end;
$$;

-- إنشاء رمز استعادة (البصمة فقط)
create or replace function public.svc_create_recovery_token(
  p_user_id uuid,
  p_token_hash text,
  p_issued_by uuid,
  p_reason text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into app.recovery_tokens (user_id, token_hash, issued_by, reason, expires_at)
  values (p_user_id, p_token_hash, p_issued_by, p_reason, p_expires_at)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'user_id', p_user_id, 'expires_at', p_expires_at);
end;
$$;

-- هدف الاستعادة: مدرس مرتبط يطلب استعادة لطالب بالكود أو الهاتف (داخل مساحته فقط)
create or replace function public.svc_recovery_target(p_teacher_id uuid, p_identifier text)
returns jsonb
language sql
security definer
set search_path = app, pg_temp
as $$
  select coalesce(
    (select jsonb_build_object(
       'student_profile_id', sp.id,
       'user_id', sp.user_id,
       'full_name', sp.full_name,
       'status', sp.status
     )
     from app.student_profiles sp
     join app.profiles pr on pr.user_id = sp.user_id
     where sp.teacher_id = p_teacher_id
       and (pr.student_code = upper(p_identifier) or pr.phone_e164 = p_identifier)
     limit 1),
    'null'::jsonb
  );
$$;

revoke all on function public.svc_profile_context(uuid) from public, anon, authenticated;
revoke all on function public.svc_workspaces(uuid) from public, anon, authenticated;
revoke all on function public.svc_invitation_state(text) from public, anon, authenticated;
revoke all on function public.svc_accept_identity(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.svc_link_student_profile(uuid, uuid) from public, anon, authenticated;
revoke all on function public.svc_create_recovery_token(uuid, text, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.svc_recovery_target(uuid, text) from public, anon, authenticated;

grant execute on function public.svc_profile_context(uuid) to service_role;
grant execute on function public.svc_workspaces(uuid) to service_role;
grant execute on function public.svc_invitation_state(text) to service_role;
grant execute on function public.svc_accept_identity(uuid, text, text, text, text, text) to service_role;
grant execute on function public.svc_link_student_profile(uuid, uuid) to service_role;
grant execute on function public.svc_create_recovery_token(uuid, text, uuid, text, timestamptz) to service_role;
grant execute on function public.svc_recovery_target(uuid, text) to service_role;

revoke all on function public.svc_rate_limit_hit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.svc_consume_invitation(text, text, uuid) from public, anon, authenticated;
revoke all on function public.svc_consume_recovery(text) from public, anon, authenticated;
revoke all on function public.svc_invalidate_sessions(uuid) from public, anon, authenticated;
revoke all on function public.svc_audit(text, uuid, uuid, text, uuid, text, jsonb, text) from public, anon, authenticated;

grant execute on function public.svc_rate_limit_hit(text, integer, integer) to service_role;
grant execute on function public.svc_consume_invitation(text, text, uuid) to service_role;
grant execute on function public.svc_consume_recovery(text) to service_role;
grant execute on function public.svc_invalidate_sessions(uuid) to service_role;
grant execute on function public.svc_audit(text, uuid, uuid, text, uuid, text, jsonb, text) to service_role;

comment on function public.svc_rate_limit_hit(text, integer, integer) is
  'غلاف خدمة لعدّاد حدّ المعدل. لا يُستدعى من المتصفح: EXECUTE لـservice_role فقط.';

-- ---------- واجهات قراءة للمتصفح ----------
create or replace view public.me
with (security_invoker = true) as
select
  p.user_id,
  p.full_name,
  p.role,
  p.status,
  right(coalesce(p.phone_e164, ''), 4) as phone_last4,
  p.student_code,
  p.sessions_valid_after
from app.profiles p
where p.user_id = auth.uid();

comment on view public.me is 'ملف المستخدم الحالي بلا هاتف كامل — يستخدمه المتصفح بدل قراءة app.profiles.';

create or replace view public.my_workspaces
with (security_invoker = true) as
select
  m.teacher_id,
  t.headline as teacher_headline,
  tp.full_name as teacher_name,
  m.role_in_workspace,
  m.status,
  m.id as membership_id
from app.teacher_memberships m
join app.teachers t on t.teacher_id = m.teacher_id
join app.profiles tp on tp.user_id = t.teacher_id
where m.user_id = auth.uid()
  and m.status = 'active'
  and app.is_active();

comment on view public.my_workspaces is
  'المساحات التي ينتمي إليها المستخدم. الطالب لا يظهر هنا؛ مساحاته من student_profiles.';

create or replace view public.my_students
with (security_invoker = true) as
select
  sp.id,
  sp.teacher_id,
  sp.full_name,
  sp.local_code,
  sp.grade,
  sp.status,
  sp.user_id,
  sp.linked_at
from app.student_profiles sp
where app.is_workspace_teacher(sp.teacher_id)
   or app.assistant_can(sp.teacher_id, 'students:read', null);

comment on view public.my_students is
  'طلاب المساحة للمدرس/المساعد فقط. لا تُعرض هنا ملفات طلاب مدرس آخر.';

grant select on public.me to authenticated;
grant select on public.my_workspaces to authenticated;
grant select on public.my_students to authenticated;

revoke all on public.me, public.my_workspaces, public.my_students from anon;

insert into app.schema_meta (key, value)
values (
  'migrations_applied',
  '0001_extensions,0002_identity_profiles,0003_teacher_workspaces,0004_invitations_recovery,0005_rls_identity'
)
on conflict (key) do update set value = excluded.value, updated_at = now();
