-- =====================================================================
--  0004_invitations_recovery.sql — المرحلة ٠٢
--  الدعوات، الاستعادة، حدّ المعدل، وسجل التدقيق.
--
--  قواعد حاكمة:
--   ١. لا يُخزَّن أي رمز خام: البصمة (HMAC-SHA256 بمفتاح الخادم) فقط.
--   ٢. كل رمز للاستخدام مرة واحدة، وله انتهاء إلزامي، وله نوع (kind) يُفحص عند الاستخدام.
--   ٣. الاستهلاك ذرّي: `app.consume_invitation` تُقفل الصف وتتحقق وتستهلك في معاملة واحدة.
--   ٤. سجل التدقيق append-only: لا سياسة تحديث أو حذف لأي دور (0005).
--  المرجع: docs/AUTH_DESIGN.md §٣، §٤، §٧.
-- =====================================================================

do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'app' and t.typname = 'invitation_kind') then
    create type app.invitation_kind as enum ('teacher_invite', 'student_link', 'assistant_invite');
  end if;
end
$$;

-- ---------- الدعوات ----------
create table if not exists app.invitations (
  id uuid primary key default gen_random_uuid(),
  kind app.invitation_kind not null,

  -- بصمة الرمز فقط. فريدة لأن التصادم يعني دعوتين بنفس السر.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),

  -- سياق الدعوة: لمن أُنشئت وفي أي مساحة
  teacher_id uuid references app.teachers (teacher_id) on delete cascade,
  student_profile_id uuid references app.student_profiles (id) on delete cascade,
  target_hint text check (target_hint is null or char_length(target_hint) <= 120),

  created_by uuid references app.profiles (user_id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references app.profiles (user_id),
  revoked_at timestamptz,

  constraint invitations_expiry_after_creation check (expires_at > created_at),
  constraint invitations_teacher_kind_needs_no_student check (
    kind <> 'teacher_invite' or student_profile_id is null
  ),
  constraint invitations_student_kind_needs_student check (
    kind <> 'student_link' or student_profile_id is not null
  )
);

create index if not exists invitations_lookup_idx
  on app.invitations (token_hash) where used_at is null and revoked_at is null;

comment on table app.invitations is
  'دعوات المدرس/المساعد/ربط الطالب. الرمز الخام لا يُخزَّن ولا يُسجَّل ولا يُعاد إلا مرة واحدة عند الإنشاء.';

-- ---------- رموز الاستعادة ----------
create table if not exists app.recovery_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.profiles (user_id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  issued_by uuid not null references app.profiles (user_id),
  reason text not null check (char_length(reason) between 5 and 300),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,

  constraint recovery_expiry_after_creation check (expires_at > created_at)
);

comment on table app.recovery_tokens is
  'استعادة كلمة المرور يطلبها مدرس مرتبط بالحساب، بسبب إلزامي، وصلاحية ٣٠ دقيقة، واستخدام واحد.';

create index if not exists recovery_tokens_user_idx
  on app.recovery_tokens (user_id) where used_at is null and revoked_at is null;

-- ---------- حدّ المعدل ----------
create table if not exists app.rate_limits (
  bucket_key text not null check (char_length(bucket_key) between 3 and 200),
  window_start timestamptz not null,
  hits integer not null default 0 check (hits >= 0),
  updated_at timestamptz not null default now(),
  primary key (bucket_key, window_start)
);

comment on table app.rate_limits is
  'عدّادات نوافذ ثابتة. المفتاح مُبصم (لا هواتف خام) — AUTH_DESIGN §٤.';

-- الدالة الذرية: تزيد العدّاد وترجع القيمة بعد الزيادة في نداء واحد.
create or replace function app.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
returns integer
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_window_start timestamptz;
  v_hits integer;
begin
  if p_key is null or char_length(p_key) < 3 then
    raise exception 'invalid rate limit key' using errcode = '22023';
  end if;
  if p_limit is null or p_limit <= 0 or p_window_seconds is null or p_window_seconds <= 0 then
    raise exception 'invalid rate limit parameters' using errcode = '22023';
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into app.rate_limits (bucket_key, window_start, hits)
  values (p_key, v_window_start, 1)
  on conflict (bucket_key, window_start)
  do update set hits = app.rate_limits.hits + 1, updated_at = now()
  returning hits into v_hits;

  return v_hits;
end;
$$;

comment on function app.rate_limit_hit(text, integer, integer) is
  'زيادة ذرية لعدّاد نافذة ثابتة. ترجع عدد المحاولات في النافذة الحالية.';

-- تنظيف العدّادات القديمة (يُستدعى من مهمة مجدولة، لا من المتصفح)
create or replace function app.rate_limits_sweep(p_keep_hours integer default 24)
returns integer
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from app.rate_limits
  where window_start < now() - make_interval(hours => greatest(p_keep_hours, 1));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ---------- سجل التدقيق ----------
create table if not exists app.audit_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_user_id uuid references app.profiles (user_id) on delete set null,
  teacher_id uuid references app.teachers (teacher_id) on delete set null,
  action text not null check (char_length(action) between 3 and 80),
  entity text check (entity is null or char_length(entity) <= 80),
  entity_id uuid,
  outcome text not null default 'ok' check (outcome in ('ok', 'denied', 'failed')),
  detail jsonb not null default '{}'::jsonb,
  ip_hash text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$')
);

comment on table app.audit_events is
  'أحداث أمنية: دخول، فشل دخول، دعوة، استعادة، تغيير كلمة مرور. بلا أسرار وبلا كلمات مرور.';

create index if not exists audit_events_at_idx on app.audit_events (at desc);
create index if not exists audit_events_actor_idx on app.audit_events (actor_user_id, at desc);

-- منع التعديل/الحذف نهائيًا (append-only) حتى لمالك الجدول في الجلسات العادية
create or replace function app.prevent_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_events is append-only' using errcode = '42501';
end;
$$;

drop trigger if exists audit_events_no_update on app.audit_events;
create trigger audit_events_no_update
  before update or delete on app.audit_events
  for each row execute function app.prevent_audit_mutation();

-- F-08: TRUNCATE لا يمرّ على مشغّلات الصفوف، فيحتاج مشغّلًا على مستوى العبارة.
drop trigger if exists audit_events_no_truncate on app.audit_events;
create trigger audit_events_no_truncate
  before truncate on app.audit_events
  for each statement execute function app.prevent_audit_mutation();

-- ---------- استهلاك الدعوة (ذرّي) ----------
create or replace function app.consume_invitation(
  p_token_hash text,
  p_expected_kind app.invitation_kind,
  p_user_id uuid
)
returns app.invitations
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_row app.invitations;
begin
  select * into v_row
  from app.invitations
  where token_hash = p_token_hash
  for update;

  if not found then
    raise exception 'invitation-not-found' using errcode = 'P0002';
  end if;
  if v_row.revoked_at is not null then
    raise exception 'invitation-revoked' using errcode = '22023';
  end if;
  if v_row.used_at is not null then
    raise exception 'invitation-used' using errcode = '22023';
  end if;
  if v_row.kind <> p_expected_kind then
    raise exception 'invitation-wrong-kind' using errcode = '22023';
  end if;
  if v_row.expires_at <= now() then
    raise exception 'invitation-expired' using errcode = '22023';
  end if;

  update app.invitations
  set used_at = now(), used_by = p_user_id
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function app.consume_invitation(text, app.invitation_kind, uuid) is
  'يتحقق ويستهلك الدعوة في معاملة واحدة مع قفل الصف: لا استخدام مزدوج تحت التزامن.';

-- ---------- استهلاك رمز الاستعادة (ذرّي) ----------
create or replace function app.consume_recovery_token(p_token_hash text)
returns app.recovery_tokens
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_row app.recovery_tokens;
begin
  select * into v_row
  from app.recovery_tokens
  where token_hash = p_token_hash
  for update;

  if not found then
    raise exception 'recovery-not-found' using errcode = 'P0002';
  end if;
  if v_row.revoked_at is not null or v_row.used_at is not null then
    raise exception 'recovery-unusable' using errcode = '22023';
  end if;
  if v_row.expires_at <= now() then
    raise exception 'recovery-expired' using errcode = '22023';
  end if;

  update app.recovery_tokens
  set used_at = now()
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------- إبطال الجلسات ----------
create or replace function app.invalidate_sessions(p_user_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_now timestamptz := now();
begin
  update app.profiles
  set sessions_valid_after = v_now, updated_at = v_now
  where user_id = p_user_id;

  if not found then
    raise exception 'profile-not-found' using errcode = 'P0002';
  end if;

  return v_now;
end;
$$;

comment on function app.invalidate_sessions(uuid) is
  'كل JWT أُصدر قبل هذا الوقت يُرفض في RLS. تُستدعى عند تغيير كلمة المرور أو الإيقاف.';

-- ---------- تدقيق بسيط ----------
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
  insert into app.audit_events (actor_user_id, teacher_id, action, entity, entity_id, outcome, detail, ip_hash)
  values (p_actor, p_teacher, p_action, p_entity, p_entity_id, p_outcome, coalesce(p_detail, '{}'::jsonb), p_ip_hash);
end;
$$;

insert into app.schema_meta (key, value)
values ('migrations_applied', '0001_extensions,0002_identity_profiles,0003_teacher_workspaces,0004_invitations_recovery')
on conflict (key) do update set value = excluded.value, updated_at = now();
