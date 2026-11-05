-- =====================================================================
--  0006_admin_audit_notifications.sql — المرحلة ٠٣
--  ما تُضيفه هذه المهاجرة:
--   ١. توسعة سجل التدقيق: دور الفاعل + فهارس البحث والتصفية.
--   ٢. أحداث الحساب (إيقاف/تفعيل) بسبب إلزامي — append-only.
--   ٣. التعليمات الداخلية: إشعار + مستلمون مُثبَّتون في صفوف (لا استعلام وقت القراءة).
--   ٤. دوال قرار إداري في مخطط app: تغيير الحالة، إرسال تعليمات، دعوة/إعادة إصدار، إحصاءات.
--
--  قواعد حاكمة (PERMISSIONS §١، C-04):
--   • كل قرار إداري يُفحص داخل SQL بدور الفاعل المأخوذ من الهوية، لا من جسم الطلب.
--   • السوبر أدمن **لا يملك** أي كتابة أكاديمية: هذه المهاجرة لا تضيف سياسة كتابة
--     على أي جدول أكاديمي، وأي محاولة تبقى صفر صفوف أو 42501.
--   • لا رمز دعوة خام في أي عمود ولا في أي تفصيل تدقيق: البصمة (token_hash) فقط.
--   • المستلمون يُحسبون على الخادم عند الإرسال، فلا يستطيع مدرس رؤية تعليمات غيره
--     حتى لو غيّر معرّفًا في المتصفح.
--  المرجع: docs/PERMISSIONS.md §٢-أ و§٣، docs/AUTH_DESIGN.md §٧.
-- =====================================================================

-- ---------- ١) الأنواع ----------
do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'app' and t.typname = 'notification_kind') then
    create type app.notification_kind as enum ('admin_instruction', 'system');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'app' and t.typname = 'notification_audience') then
    create type app.notification_audience as enum ('all_teachers', 'teachers');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'app' and t.typname = 'account_action') then
    create type app.account_action as enum ('suspend', 'reactivate', 'invite', 'reinvite');
  end if;
end
$$;

-- ---------- ٢) توسعة سجل التدقيق ----------
-- دور الفاعل يُخزَّن مع الحدث: لو تغيّر دور المستخدم لاحقًا يبقى الحدث صحيحًا تاريخيًا.
alter table app.audit_events add column if not exists actor_role app.user_role;

comment on column app.audit_events.actor_role is
  'دور الفاعل وقت الحدث — لا يُقرأ من الدور الحالي، فالصلاحيات تتغير والسجل لا.';

create index if not exists audit_events_action_idx on app.audit_events (action, at desc);
create index if not exists audit_events_teacher_idx on app.audit_events (teacher_id, at desc);
create index if not exists audit_events_outcome_idx on app.audit_events (outcome, at desc);

-- إعادة تعريف app.audit بالملء التلقائي لدور الفاعل (نفس التوقيع: لا يكسر أي مستدعٍ).
create or replace function app.audit(
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
language plpgsql
security definer
set search_path = app, pg_temp
as $$
begin
  insert into app.audit_events (
    actor_user_id, actor_role, teacher_id, action, entity, entity_id, outcome, detail, ip_hash
  )
  values (
    p_actor,
    (select p.role from app.profiles p where p.user_id = p_actor),
    p_teacher,
    p_action,
    p_entity,
    p_entity_id,
    p_outcome,
    coalesce(p_detail, '{}'::jsonb),
    p_ip_hash
  );
end;
$$;

comment on function app.audit(text, uuid, uuid, text, uuid, text, jsonb, text) is
  'كتابة حدث تدقيق. لا تُمرَّر فيها رموز خام ولا كلمات مرور — التفصيل يمرّ عبر تقليم المفاتيح الحساسة في _shared/audit.js.';

-- ---------- ٣) أحداث الحساب: بسبب إلزامي ----------
create table if not exists app.account_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references app.profiles (user_id) on delete cascade,
  action app.account_action not null,
  reason text not null check (char_length(btrim(reason)) between 5 and 300),
  actor_user_id uuid references app.profiles (user_id) on delete set null,
  at timestamptz not null default now()
);

comment on table app.account_events is
  'تاريخ قرارات الحساب (إيقاف/تفعيل/دعوة) مع السبب والفاعل. append-only، ولا يُحذف بحذف الحساب إلا بالتكاسكاد.';

create index if not exists account_events_user_idx on app.account_events (user_id, at desc);
create index if not exists account_events_at_idx on app.account_events (at desc);

-- append-only بنفس آلية سجل التدقيق: لا تعديل ولا حذف ولا تفريغ.
drop trigger if exists account_events_no_mutation on app.account_events;
create trigger account_events_no_mutation
  before update or delete on app.account_events
  for each row execute function app.prevent_audit_mutation();

drop trigger if exists account_events_no_truncate on app.account_events;
create trigger account_events_no_truncate
  before truncate on app.account_events
  for each statement execute function app.prevent_audit_mutation();

-- ---------- ٤) التعليمات الداخلية ----------
create table if not exists app.notifications (
  id uuid primary key default gen_random_uuid(),
  kind app.notification_kind not null default 'admin_instruction',
  audience app.notification_audience not null,

  title text not null check (char_length(btrim(title)) between 3 and 120),
  body text not null check (char_length(btrim(body)) between 3 and 2000),

  created_by uuid references app.profiles (user_id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  recipient_count integer not null default 0 check (recipient_count >= 0),

  constraint notifications_expiry_after_creation check (expires_at is null or expires_at > created_at)
);

comment on table app.notifications is
  'تعليمات السوبر أدمن ورسائل النظام. تُقرأ عبر public.my_notifications أو public.admin_instructions فقط.';

create index if not exists notifications_created_idx on app.notifications (created_at desc);
create index if not exists notifications_author_idx on app.notifications (created_by, created_at desc);

-- المستلمون صفوف حقيقية: «من يصل إليه» قرار مُخزَّن، لا شرط في استعلام وقت القراءة.
create table if not exists app.notification_recipients (
  notification_id uuid not null references app.notifications (id) on delete cascade,
  user_id uuid not null references app.profiles (user_id) on delete cascade,
  delivered_at timestamptz not null default now(),
  read_at timestamptz,
  primary key (notification_id, user_id)
);

comment on table app.notification_recipients is
  'من استلم تعليمًا معيّنًا. صف واحد لكل (إشعار، مستخدم) — يمنع التكرار ويجعل العزل صفًّا لا استعلامًا.';

create index if not exists notification_recipients_user_idx
  on app.notification_recipients (user_id, delivered_at desc);

-- ---------- ٥) حراسة: سوبر أدمن نشط ----------
-- كل دوال هذه المهاجرة تبدأ من هنا: الفاعل يُقرأ من صف في قاعدة البيانات،
-- لا من حقل `role` في جسم الطلب.
create or replace function app.assert_active_super_admin(p_actor uuid)
returns app.profiles
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_profile app.profiles;
begin
  if p_actor is null then
    raise exception 'actor-required' using errcode = '42501';
  end if;

  select * into v_profile from app.profiles where user_id = p_actor;

  if not found then
    raise exception 'actor-not-found' using errcode = '42501';
  end if;

  if v_profile.role <> 'super_admin' then
    raise exception 'super-admin-required' using errcode = '42501';
  end if;

  if v_profile.status <> 'active' then
    raise exception 'actor-inactive' using errcode = '42501';
  end if;

  return v_profile;
end;
$$;

comment on function app.assert_active_super_admin(uuid) is
  'يضمن أن الفاعل سوبر أدمن نشط. يُستخدم كأول سطر في كل قرار إداري — لا يُثق بدور قادم من العميل.';

-- ---------- ٦) تغيير حالة حساب (إيقاف/تفعيل) بسبب ----------
create or replace function app.admin_set_account_status(
  p_actor uuid,
  p_user_id uuid,
  p_status app.account_status,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_actor app.profiles;
  v_target app.profiles;
  v_now timestamptz := now();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_sessions timestamptz;
begin
  v_actor := app.assert_active_super_admin(p_actor);
  perform v_actor;

  if p_status is null or p_status not in ('active', 'suspended') then
    raise exception 'invalid-status' using errcode = '22023';
  end if;

  if char_length(v_reason) < 5 then
    raise exception 'reason-required' using errcode = '22023';
  end if;

  select * into v_target from app.profiles where user_id = p_user_id for update;

  if not found then
    raise exception 'profile-not-found' using errcode = 'P0002';
  end if;

  -- لا يوقف الأدمن حساب أدمن آخر: هذا يفتح باب تعطيل الإدارة نفسها.
  if v_target.role = 'super_admin' then
    raise exception 'cannot-change-admin-account' using errcode = '42501';
  end if;

  if v_target.status = p_status then
    return jsonb_build_object(
      'changed', false,
      'user_id', v_target.user_id,
      'status', v_target.status
    );
  end if;

  update app.profiles
  set status = p_status, updated_at = v_now
  where user_id = p_user_id;

  -- الإيقاف يُبطل كل JWT صادر قبل هذه اللحظة، ولا يمحو أي بيانات.
  if p_status = 'suspended' then
    v_sessions := app.invalidate_sessions(p_user_id);
  else
    select sessions_valid_after into v_sessions from app.profiles where user_id = p_user_id;
  end if;

  insert into app.account_events (user_id, action, reason, actor_user_id, at)
  values (
    p_user_id,
    case when p_status = 'suspended' then 'suspend'::app.account_action else 'reactivate'::app.account_action end,
    v_reason,
    p_actor,
    v_now
  );

  perform app.audit(
    case when p_status = 'suspended' then 'admin.account.suspended' else 'admin.account.reactivated' end,
    p_actor,
    case when v_target.role = 'teacher' then p_user_id else null end,
    'profile',
    p_user_id,
    'ok',
    jsonb_build_object('reason', v_reason, 'from', v_target.status::text, 'to', p_status::text)
  );

  return jsonb_build_object(
    'changed', true,
    'user_id', p_user_id,
    'status', p_status,
    'sessions_valid_after', v_sessions
  );
end;
$$;

comment on function app.admin_set_account_status(uuid, uuid, app.account_status, text) is
  'إيقاف/تفعيل حساب بغير الأدمن مع سبب إلزامي. الإيقاف يُبطل الجلسات ولا يحذف بيانات.';

-- ---------- ٧) إرسال تعليمات داخلية ----------
create or replace function app.admin_send_instruction(
  p_actor uuid,
  p_title text,
  p_body text,
  p_audience app.notification_audience,
  p_user_ids uuid[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_actor app.profiles;
  v_now timestamptz := now();
  v_title text := btrim(coalesce(p_title, ''));
  v_body text := btrim(coalesce(p_body, ''));
  v_ids uuid[];
  v_requested integer;
  v_valid integer;
  v_recent integer;
  v_id uuid;
begin
  v_actor := app.assert_active_super_admin(p_actor);
  perform v_actor;

  if char_length(v_title) < 3 or char_length(v_title) > 120 then
    raise exception 'invalid-title' using errcode = '22023';
  end if;

  if char_length(v_body) < 5 or char_length(v_body) > 2000 then
    raise exception 'invalid-body' using errcode = '22023';
  end if;

  -- حدّ إرسال: ٢٠ تعليمًا في الساعة لكل أدمن. يمنع الإغراق وسوء الاستخدام.
  select count(*) into v_recent
  from app.notifications
  where created_by = p_actor and created_at > v_now - interval '1 hour';

  if v_recent >= 20 then
    raise exception 'instruction-rate-limited' using errcode = '42900';
  end if;

  if p_audience = 'all_teachers' then
    select coalesce(array_agg(p.user_id order by p.user_id), '{}'::uuid[])
    into v_ids
    from app.profiles p
    where p.role = 'teacher' and p.status = 'active';

  elsif p_audience = 'teachers' then
    select count(distinct x) into v_requested from unnest(coalesce(p_user_ids, '{}'::uuid[])) as x;

    if v_requested = 0 then
      raise exception 'recipients-required' using errcode = '22023';
    end if;

    if v_requested > 200 then
      raise exception 'too-many-recipients' using errcode = '22023';
    end if;

    select count(distinct p.user_id) into v_valid
    from app.profiles p
    where p.user_id = any (p_user_ids)
      and p.role = 'teacher'
      and p.status = 'active';

    -- أي معرّف ليس مدرسًا نشطًا يُفشل الإرسال كله: لا «إرسال جزئي» صامت.
    if v_valid <> v_requested then
      raise exception 'invalid-recipients' using errcode = '22023';
    end if;

    v_ids := (
      select array_agg(distinct p.user_id order by p.user_id)
      from app.profiles p
      where p.user_id = any (p_user_ids)
    );
  else
    raise exception 'invalid-audience' using errcode = '22023';
  end if;

  if coalesce(array_length(v_ids, 1), 0) = 0 then
    raise exception 'no-recipients' using errcode = '22023';
  end if;

  insert into app.notifications (kind, audience, title, body, created_by, created_at, recipient_count)
  values ('admin_instruction', p_audience, v_title, v_body, p_actor, v_now, array_length(v_ids, 1))
  returning id into v_id;

  insert into app.notification_recipients (notification_id, user_id, delivered_at)
  select v_id, recipient, v_now from unnest(v_ids) as recipient;

  perform app.audit(
    'admin.instruction.sent',
    p_actor,
    null,
    'notification',
    v_id,
    'ok',
    jsonb_build_object(
      'audience', p_audience::text,
      'recipients', array_length(v_ids, 1),
      'title_length', char_length(v_title)
    )
  );

  return jsonb_build_object(
    'notification_id', v_id,
    'recipients', array_length(v_ids, 1),
    'sent_at', v_now
  );
end;
$$;

comment on function app.admin_send_instruction(uuid, text, text, app.notification_audience, uuid[]) is
  'إرسال تعليم إداري لمدرسين نشطين فقط، مع تثبيت المستلمين صفوفًا. الطلاب والخارجون عن النطاق لا يصلهم شيء.';

-- هل هذا المستخدم مستلم لهذا الإشعار؟ دالة بصلاحية المُعرِّف (R-36) لتفادي قراءة سياسة داخل سياسة.
create or replace function app.is_notification_recipient(p_notification_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
set search_path = app, pg_temp
stable
as $$
  select exists (
    select 1
    from app.notification_recipients r
    where r.notification_id = p_notification_id
      and r.user_id = p_user_id
  );
$$;

-- ---------- ٨) دعوة مدرس وإعادة إصدارها ----------
-- الحقول الاختيارية للدعوة (الاسم والمسمى) تُحفظ في meta لتُستخدم عند القبول وللعرض الإداري.
alter table app.invitations add column if not exists meta jsonb not null default '{}'::jsonb;

comment on column app.invitations.meta is
  'بيانات الدعوة المقصودة (الاسم/المسمى). لا رموز ولا أسرار — البصمة وحدها في token_hash.';

create or replace function app.admin_invite_teacher(
  p_actor uuid,
  p_phone_e164 text,
  p_full_name text,
  p_headline text,
  p_token_hash text,
  p_ttl_hours integer default 72
)
returns jsonb
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_actor app.profiles;
  v_now timestamptz := now();
  v_recent integer;
  v_id uuid;
  v_expires timestamptz;
  v_name text := btrim(coalesce(p_full_name, ''));
  v_headline text := nullif(btrim(coalesce(p_headline, '')), '');
begin
  v_actor := app.assert_active_super_admin(p_actor);
  perform v_actor;

  if p_phone_e164 is null or p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'invalid-phone' using errcode = '22023';
  end if;

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid-token-hash' using errcode = '22023';
  end if;

  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'invalid-name' using errcode = '22023';
  end if;

  if v_headline is not null and char_length(v_headline) > 160 then
    raise exception 'invalid-headline' using errcode = '22023';
  end if;

  if p_ttl_hours is null or p_ttl_hours < 1 or p_ttl_hours > 168 then
    raise exception 'invalid-ttl' using errcode = '22023';
  end if;

  select count(*) into v_recent
  from app.invitations
  where kind = 'teacher_invite' and created_by = p_actor and created_at > v_now - interval '1 hour';

  if v_recent >= 10 then
    raise exception 'invite-rate-limited' using errcode = '42900';
  end if;

  -- هوية قائمة (نشطة أو موقوفة) لا تُدعى: تُدار بحالتها، فلا تتفرّع منها هويتان.
  if exists (
    select 1 from app.profiles p
    where p.phone_e164 = p_phone_e164 and p.status in ('active', 'suspended')
  ) then
    raise exception 'phone-already-registered' using errcode = '23405';
  end if;

  -- دعوة سارية واحدة لكل رقم: الإصدار الجديد يُلغي القديم بدل تكديس روابط صالحة.
  update app.invitations
  set revoked_at = v_now
  where kind = 'teacher_invite'
    and target_hint = p_phone_e164
    and used_at is null
    and revoked_at is null;

  v_expires := v_now + make_interval(hours => p_ttl_hours);

  insert into app.invitations (kind, token_hash, target_hint, created_by, created_at, expires_at, meta)
  values (
    'teacher_invite',
    p_token_hash,
    p_phone_e164,
    p_actor,
    v_now,
    v_expires,
    jsonb_build_object('full_name', v_name, 'headline', v_headline)
  )
  returning id into v_id;

  insert into app.account_events (user_id, action, reason, actor_user_id, at)
  values (p_actor, 'invite'::app.account_action, 'دعوة مدرس جديد من لوحة الإدارة', p_actor, v_now);

  perform app.audit(
    'admin.teacher.invited',
    p_actor,
    null,
    'invitation',
    v_id,
    'ok',
    jsonb_build_object(
      'phone_last4', right(p_phone_e164, 4),
      'full_name', v_name,
      'expires_at', v_expires
    )
  );

  return jsonb_build_object('invitation_id', v_id, 'expires_at', v_expires, 'phone_last4', right(p_phone_e164, 4));
end;
$$;

comment on function app.admin_invite_teacher(uuid, text, text, text, text, integer) is
  'إنشاء دعوة مدرس. لا تُخزَّن إلا بصمة الرمز، ولا تُستدعى إلا بسوبر أدمن نشط.';

create or replace function app.admin_reissue_invitation(
  p_actor uuid,
  p_invitation_id uuid,
  p_token_hash text,
  p_ttl_hours integer default 72
)
returns jsonb
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_actor app.profiles;
  v_old app.invitations;
  v_now timestamptz := now();
  v_reissues integer;
  v_id uuid;
  v_expires timestamptz;
begin
  v_actor := app.assert_active_super_admin(p_actor);
  perform v_actor;

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid-token-hash' using errcode = '22023';
  end if;

  if p_ttl_hours is null or p_ttl_hours < 1 or p_ttl_hours > 168 then
    raise exception 'invalid-ttl' using errcode = '22023';
  end if;

  select * into v_old from app.invitations where id = p_invitation_id for update;

  if not found then
    raise exception 'invitation-not-found' using errcode = 'P0002';
  end if;

  if v_old.kind <> 'teacher_invite' then
    raise exception 'invitation-wrong-kind' using errcode = '22023';
  end if;

  if v_old.used_at is not null then
    raise exception 'invitation-used' using errcode = '22023';
  end if;

  -- سياسة إعادة الإصدار: ٣ مرات كحد أقصى لكل رقم في ٢٤ ساعة.
  select count(*) into v_reissues
  from app.invitations
  where kind = 'teacher_invite'
    and target_hint = v_old.target_hint
    and created_at > v_now - interval '24 hours';

  if v_reissues >= 3 then
    raise exception 'reissue-rate-limited' using errcode = '42900';
  end if;

  update app.invitations set revoked_at = v_now where id = v_old.id;

  v_expires := v_now + make_interval(hours => p_ttl_hours);

  insert into app.invitations (kind, token_hash, target_hint, created_by, created_at, expires_at, meta)
  values ('teacher_invite', p_token_hash, v_old.target_hint, p_actor, v_now, v_expires, v_old.meta)
  returning id into v_id;

  insert into app.account_events (user_id, action, reason, actor_user_id, at)
  values (p_actor, 'reinvite'::app.account_action, 'إعادة إصدار دعوة مدرس', p_actor, v_now);

  perform app.audit(
    'admin.invitation.reissued',
    p_actor,
    null,
    'invitation',
    v_id,
    'ok',
    jsonb_build_object('previous_id', v_old.id, 'expires_at', v_expires)
  );

  return jsonb_build_object('invitation_id', v_id, 'previous_id', v_old.id, 'expires_at', v_expires);
end;
$$;

comment on function app.admin_reissue_invitation(uuid, uuid, text, integer) is
  'إعادة إصدار دعوة غير مستخدمة: تُلغي القديمة وتنشئ بديلة، بحدّ ٣ مرات/٢٤ ساعة لكل رقم.';

-- ---------- ٩) إحصاءات حقيقية (لا أرقام وهمية) ----------
create or replace function app.admin_stats(p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_actor app.profiles;
begin
  v_actor := app.assert_active_super_admin(p_actor);
  perform v_actor;

  return jsonb_build_object(
    'generated_at', now(),
    'teachers_total', (select count(*) from app.profiles p where p.role = 'teacher'),
    'teachers_active', (select count(*) from app.profiles p where p.role = 'teacher' and p.status = 'active'),
    'teachers_suspended', (select count(*) from app.profiles p where p.role = 'teacher' and p.status = 'suspended'),
    'teachers_pending', (select count(*) from app.profiles p where p.role = 'teacher' and p.status = 'pending'),
    'assistants_active', (select count(*) from app.profiles p where p.role = 'assistant' and p.status = 'active'),
    'students_total', (select count(*) from app.student_profiles),
    'students_linked', (select count(*) from app.student_profiles sp where sp.user_id is not null and sp.status = 'active'),
    'students_pending_link', (select count(*) from app.student_profiles sp where sp.status = 'pending_link'),
    'groups_active', (select count(*) from public.groups g where g.status = 'active'),
    'invitations_pending', (
      select count(*) from app.invitations i
      where i.used_at is null and i.revoked_at is null and i.expires_at > now()
    ),
    'instructions_30d', (
      select count(*) from app.notifications n
      where n.created_at > now() - interval '30 days'
    ),
    'audit_events_24h', (
      select count(*) from app.audit_events a
      where a.at > now() - interval '24 hours'
    )
  );
end;
$$;

comment on function app.admin_stats(uuid) is
  'أرقام منشورة مشتقة من صفوف حقيقية فقط. لا يحتوي أي رقم تقديري أو تجريبي.';

insert into app.schema_meta (key, value)
values ('migrations_applied', '0001_extensions,0002_identity_profiles,0003_teacher_workspaces,0004_invitations_recovery,0005_rls_identity,0006_admin_audit_notifications')
on conflict (key) do update set value = excluded.value, updated_at = now();
