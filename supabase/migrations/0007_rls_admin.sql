-- =====================================================================
--  0007_rls_admin.sql — المرحلة ٠٣
--  الحدّ الأمني للوحة السوبر أدمن:
--   ١. RLS على جداول الإدارة الجديدة + سياسات قراءة فقط.
--   ٢. واجهات قراءة في public (security_invoker) تحمل شرط الإدارة داخلها.
--   ٣. أغلفة svc_* للدوال الحساسة: service_role فقط — لا المتصفح.
--
--  القاعدة الحاكمة: «الإدارة تقرأ وتقرر حالة الحساب، ولا تكتب أكاديميًا».
--  لا تُضاف في هذا الملف أي سياسة insert/update/delete للتدقيق أو لأي جدول أكاديمي.
-- =====================================================================

-- ---------- ١) تفعيل RLS ----------
alter table app.notifications            enable row level security;
alter table app.notification_recipients  enable row level security;
alter table app.account_events           enable row level security;

comment on table app.notifications is
  'تعليمات داخلية. لا كتابة من المتصفح: الإرسال عبر دالة الخادم فقط، والقراءة عبر عرض مفلتر.';
comment on table app.account_events is
  'سجل قرارات الحساب (إيقاف/تفعيل/دعوة). append-only، قراءة إدارية فقط.';

-- ---------- ٢) المنح ----------
grant select on app.notifications to authenticated;
grant select on app.notification_recipients to authenticated;
grant select on app.account_events to authenticated;

-- المستلم يستطيع تعليم إشعاره كمقروء — عمود واحد فقط، وصفّه هو.
grant update (read_at) on app.notification_recipients to authenticated;

-- ---------- ٣) السياسات ----------
drop policy if exists notifications_select_admin on app.notifications;
create policy notifications_select_admin on app.notifications
  for select to authenticated
  using (app.is_super_admin());

-- R-36: الاستعلام داخل السياسة لا يقرأ notification_recipients مباشرة،
-- بل يستدعي دالة بصلاحية المُعرِّف — فلا تتكرر سياسة داخل سياسة.
drop policy if exists notifications_select_recipient on app.notifications;
create policy notifications_select_recipient on app.notifications
  for select to authenticated
  using (app.is_notification_recipient(id, auth.uid()) and app.is_active());

drop policy if exists notification_recipients_select_own on app.notification_recipients;
create policy notification_recipients_select_own on app.notification_recipients
  for select to authenticated
  using (user_id = auth.uid() and app.is_active());

drop policy if exists notification_recipients_select_admin on app.notification_recipients;
create policy notification_recipients_select_admin on app.notification_recipients
  for select to authenticated
  using (app.is_super_admin());

drop policy if exists notification_recipients_update_own on app.notification_recipients;
create policy notification_recipients_update_own on app.notification_recipients
  for update to authenticated
  using (user_id = auth.uid() and app.is_active())
  with check (user_id = auth.uid());

-- لا سياسة insert لأي دور: الإدراج يتم داخل دالة الإرسال (definer) فقط.
-- لا سياسة update/delete على app.notifications: التعليم المرسل لا يُعدَّل ولا يُحذف.

drop policy if exists account_events_select_admin on app.account_events;
create policy account_events_select_admin on app.account_events
  for select to authenticated
  using (app.is_super_admin());

-- ---------- ٤) واجهات قراءة للمتصفح ----------
create or replace view public.admin_teachers
with (security_invoker = true) as
select
  tp.user_id as teacher_id,
  tp.full_name,
  tp.status,
  right(coalesce(tp.phone_e164, ''), 4) as phone_last4,
  t.headline,
  tp.created_at,
  (select count(*) from app.student_profiles sp where sp.teacher_id = tp.user_id) as students_count,
  (select count(*) from app.student_profiles sp
    where sp.teacher_id = tp.user_id and sp.status = 'active') as students_active,
  (select count(*) from app.student_profiles sp
    where sp.teacher_id = tp.user_id and sp.status = 'pending_link') as students_pending_link,
  (select count(*) from public.groups g
    where g.teacher_id = tp.user_id and g.status = 'active') as groups_active,
  (select count(*) from app.teacher_memberships m
    where m.teacher_id = tp.user_id and m.role_in_workspace = 'assistant' and m.status = 'active') as assistants_active,
  (select count(*) from app.invitations i
    where i.kind = 'teacher_invite'
      and i.target_hint = tp.phone_e164
      and i.used_at is null and i.revoked_at is null and i.expires_at > now()) as invitations_pending
from app.profiles tp
join app.teachers t on t.teacher_id = tp.user_id
where app.is_super_admin();

comment on view public.admin_teachers is
  'قائمة المدرسين مع أرقام حقيقية من صفوفهم. المدرس والمساعد والطالب يرون صفرًا هنا. لا هاتف كامل: آخر ٤ أرقام فقط.';

create or replace view public.admin_invitations
with (security_invoker = true) as
select
  i.id,
  i.kind,
  i.target_hint,
  i.meta ->> 'full_name' as target_name,
  i.meta ->> 'headline' as target_headline,
  cp.full_name as created_by_name,
  i.created_at,
  i.expires_at,
  i.used_at,
  i.revoked_at,
  case
    when i.used_at is not null then 'used'
    when i.revoked_at is not null then 'revoked'
    when i.expires_at <= now() then 'expired'
    else 'pending'
  end as state
from app.invitations i
left join app.profiles cp on cp.user_id = i.created_by
where app.is_super_admin()
  and i.kind = 'teacher_invite';

comment on view public.admin_invitations is
  'دعوات المدرسين بحالتها المشتقة. **لا تُعرض token_hash إطلاقًا** — الرمز يظهر مرة واحدة عند الإنشاء فقط.';

create or replace view public.admin_audit_log
with (security_invoker = true) as
select
  a.id,
  a.at,
  a.actor_user_id,
  ap.full_name as actor_name,
  a.actor_role,
  a.teacher_id,
  tp.full_name as teacher_name,
  a.action,
  a.entity,
  a.entity_id,
  a.outcome,
  a.detail
from app.audit_events a
left join app.profiles ap on ap.user_id = a.actor_user_id
left join app.profiles tp on tp.user_id = a.teacher_id
where app.is_super_admin();

comment on view public.admin_audit_log is
  'سجل التدقيق الإداري للقراءة والتصفية. append-only: لا واجهة تعديل ولا حذف.';

create or replace view public.admin_account_events
with (security_invoker = true) as
select
  e.id,
  e.user_id,
  p.full_name,
  p.role,
  e.action,
  e.reason,
  e.at,
  ap.full_name as actor_name
from app.account_events e
join app.profiles p on p.user_id = e.user_id
left join app.profiles ap on ap.user_id = e.actor_user_id
where app.is_super_admin();

comment on view public.admin_account_events is
  'قرارات الحساب مع سببها وفاعلها. يُستخدم في صفحة المدرس ولوحة المتابعة.';

create or replace view public.admin_instructions
with (security_invoker = true) as
select
  n.id,
  n.title,
  n.body,
  n.audience,
  n.recipient_count,
  n.created_at,
  n.expires_at,
  ap.full_name as created_by_name,
  (select count(*) from app.notification_recipients r
    where r.notification_id = n.id and r.read_at is not null) as read_count
from app.notifications n
left join app.profiles ap on ap.user_id = n.created_by
where app.is_super_admin();

comment on view public.admin_instructions is
  'التعليمات المرسلة وعدد مستلميها وكم قرأها. لا تُدرج صفوفًا لغير السوبر أدمن.';

-- الإحصاءات: الدالة تحرس بنفسها؛ والشرط هنا يمنع استدعاءها أصلًا لغير الإدارة.
create or replace view public.admin_overview
with (security_invoker = true) as
select app.admin_stats(auth.uid()) as stats
where app.is_super_admin();

comment on view public.admin_overview is
  'أرقام اللوحة مشتقة من صفوف حقيقية عبر app.admin_stats. للمدرس: صفر صفوف لا أرقام مغلوطة.';

create or replace view public.my_notifications
with (security_invoker = true) as
select
  n.id,
  n.kind,
  n.title,
  n.body,
  n.created_at,
  n.expires_at,
  r.delivered_at,
  r.read_at,
  ap.full_name as sender_name
from app.notification_recipients r
join app.notifications n on n.id = r.notification_id
left join app.profiles ap on ap.user_id = n.created_by
where r.user_id = auth.uid()
  and app.is_active()
  and (n.expires_at is null or n.expires_at > now());

comment on view public.my_notifications is
  'صندوق تنبيهات المستخدم: تعليمات وُجِّهت إليه وحده. لا يرى تعليمات غيره ولو غيّر أي معرّف.';

grant select on public.admin_teachers to authenticated;
grant select on public.admin_invitations to authenticated;
grant select on public.admin_audit_log to authenticated;
grant select on public.admin_account_events to authenticated;
grant select on public.admin_instructions to authenticated;
grant select on public.admin_overview to authenticated;
grant select on public.my_notifications to authenticated;

revoke all on public.admin_teachers, public.admin_invitations, public.admin_audit_log,
              public.admin_account_events, public.admin_instructions, public.admin_overview,
              public.my_notifications
  from anon;

-- ---------- ٤-ب) منح دوال مخطط app المستخدمة في العروض والسياسات ----------
-- F-24: دوال PostgreSQL تُمنح EXECUTE لـPUBLIC افتراضيًا. `assert_active_super_admin`
-- تعيد صفًّا كاملًا من app.profiles (فيه الهاتف)، وكان يمكن استدعاؤها من المتصفح.
-- الإصلاح: كل دوال القرار مسحوبة عن anon/authenticated ومنحها لـservice_role وحده.
-- Public.stats and the notification policy run as the invoker, so they need EXECUTE.
-- Every other admin function is decision logic: it must NOT be callable from the browser,
-- otherwise a caller could invoke it directly and bypass the Edge Function guards.
-- (assert_active_super_admin returns a whole profile row — leaking it would expose a phone.)
grant execute on function app.admin_stats(uuid) to authenticated;
grant execute on function app.is_notification_recipient(uuid, uuid) to authenticated;

revoke all on function app.assert_active_super_admin(uuid) from public, anon, authenticated;
revoke all on function app.admin_set_account_status(uuid, uuid, app.account_status, text) from public, anon, authenticated;
revoke all on function app.admin_send_instruction(uuid, text, text, app.notification_audience, uuid[]) from public, anon, authenticated;
revoke all on function app.admin_invite_teacher(uuid, text, text, text, text, integer) from public, anon, authenticated;
revoke all on function app.admin_reissue_invitation(uuid, uuid, text, integer) from public, anon, authenticated;

grant execute on function app.assert_active_super_admin(uuid) to service_role;
grant execute on function app.admin_set_account_status(uuid, uuid, app.account_status, text) to service_role;
grant execute on function app.admin_send_instruction(uuid, text, text, app.notification_audience, uuid[]) to service_role;
grant execute on function app.admin_invite_teacher(uuid, text, text, text, text, integer) to service_role;
grant execute on function app.admin_reissue_invitation(uuid, uuid, text, integer) to service_role;

-- ---------- ٥) أغلفة الخدمة (service_role فقط) ----------
create or replace function public.svc_admin_set_account_status(
  p_actor uuid,
  p_user_id uuid,
  p_status text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = app, pg_temp
as $$
begin
  if p_status is null or p_status not in ('active', 'suspended') then
    raise exception 'invalid-status' using errcode = '22023';
  end if;
  return app.admin_set_account_status(p_actor, p_user_id, p_status::app.account_status, p_reason);
end;
$$;

create or replace function public.svc_admin_send_instruction(
  p_actor uuid,
  p_title text,
  p_body text,
  p_audience text,
  p_user_ids uuid[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = app, pg_temp
as $$
begin
  if p_audience is null or p_audience not in ('all_teachers', 'teachers') then
    raise exception 'invalid-audience' using errcode = '22023';
  end if;
  return app.admin_send_instruction(p_actor, p_title, p_body, p_audience::app.notification_audience, p_user_ids);
end;
$$;

create or replace function public.svc_admin_invite_teacher(
  p_actor uuid,
  p_phone_e164 text,
  p_full_name text,
  p_headline text,
  p_token_hash text,
  p_ttl_hours integer default 72
)
returns jsonb
language sql
security definer
set search_path = app, pg_temp
as $$
  select app.admin_invite_teacher(p_actor, p_phone_e164, p_full_name, p_headline, p_token_hash, p_ttl_hours);
$$;

create or replace function public.svc_admin_reissue_invitation(
  p_actor uuid,
  p_invitation_id uuid,
  p_token_hash text,
  p_ttl_hours integer default 72
)
returns jsonb
language sql
security definer
set search_path = app, pg_temp
as $$
  select app.admin_reissue_invitation(p_actor, p_invitation_id, p_token_hash, p_ttl_hours);
$$;

create or replace function public.svc_admin_stats(p_actor uuid)
returns jsonb
language sql
security definer
set search_path = app, pg_temp
as $$
  select app.admin_stats(p_actor);
$$;

revoke all on function public.svc_admin_set_account_status(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.svc_admin_send_instruction(uuid, text, text, text, uuid[]) from public, anon, authenticated;
revoke all on function public.svc_admin_invite_teacher(uuid, text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.svc_admin_reissue_invitation(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.svc_admin_stats(uuid) from public, anon, authenticated;

grant execute on function public.svc_admin_set_account_status(uuid, uuid, text, text) to service_role;
grant execute on function public.svc_admin_send_instruction(uuid, text, text, text, uuid[]) to service_role;
grant execute on function public.svc_admin_invite_teacher(uuid, text, text, text, text, integer) to service_role;
grant execute on function public.svc_admin_reissue_invitation(uuid, uuid, text, integer) to service_role;
grant execute on function public.svc_admin_stats(uuid) to service_role;

comment on function public.svc_admin_set_account_status(uuid, uuid, text, text) is
  'غلاف خدمة لقرار حالة الحساب. EXECUTE لـservice_role فقط: المتصفح لا يستدعيه.';

insert into app.schema_meta (key, value)
values ('migrations_applied', '0001_extensions,0002_identity_profiles,0003_teacher_workspaces,0004_invitations_recovery,0005_rls_identity,0006_admin_audit_notifications,0007_rls_admin')
on conflict (key) do update set value = excluded.value, updated_at = now();
