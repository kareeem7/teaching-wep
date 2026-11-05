-- =====================================================================
--  0003_teacher_workspaces.sql — المرحلة ٠٢
--  مساحة المدرس: ملفات الطلاب المحلية، عضويات المساعد وصلاحياته، المجموعات.
--
--  الفكرة الحاكمة: الطالب هوية عالمية واحدة (0002) + ملف أكاديمي محلي عند كل مدرس.
--  لذلك `app.student_profiles.teacher_id` هو عمود العزل: لا يرى مدرس طلاب غيره.
--
--  انحراف موثق عن نص DATA_MODEL (R-25): رمز الدخول الفريد عالميًا في `app.profiles.student_code`،
--  وكود الملف المحلي هنا اسمه `local_code` وفريد داخل المدرس فقط — حتى لا يتعارض كودان
--  لنفس الشخص عند مدرسين مختلفين، ولأن الدخول يحتاج معرّفًا واحدًا لا معرّفًا لكل مساحة.
-- =====================================================================

do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'app' and t.typname = 'student_link_status') then
    create type app.student_link_status as enum ('pending_link', 'active', 'archived', 'revoked');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'app' and t.typname = 'membership_status') then
    create type app.membership_status as enum ('invited', 'active', 'suspended', 'revoked');
  end if;
end
$$;

-- ---------- ملف الطالب المحلي عند مدرس ----------
create table if not exists app.student_profiles (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references app.teachers (teacher_id) on delete cascade,

  -- يُملأ فقط بعد قبول دعوة الربط؛ حتى ذلك الحين الملف بلا حساب
  user_id uuid references app.profiles (user_id) on delete set null,

  full_name text not null check (char_length(full_name) between 2 and 120),
  local_code text not null check (local_code ~ '^[A-Z0-9]{2,10}$'),
  grade text check (grade is null or char_length(grade) <= 40),
  location_name text check (location_name is null or char_length(location_name) <= 80),
  guardian_phone_e164 text check (guardian_phone_e164 is null or guardian_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  notes text check (notes is null or char_length(notes) <= 2000),

  status app.student_link_status not null default 'pending_link',
  linked_at timestamptz,
  created_by uuid references app.profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint student_profiles_local_code_unique unique (teacher_id, local_code),
  constraint student_profiles_active_requires_user check (
    status <> 'active' or user_id is not null
  )
);

comment on table app.student_profiles is
  'الملف الأكاديمي المحلي: ملك المدرس، ومعزول بـteacher_id. لا يُنشأ حساب دخول من هنا.';

create unique index if not exists student_profiles_one_per_teacher
  on app.student_profiles (teacher_id, user_id)
  where user_id is not null and status = 'active';

create index if not exists student_profiles_teacher_idx on app.student_profiles (teacher_id, status);

drop trigger if exists student_profiles_touch_updated_at on app.student_profiles;
create trigger student_profiles_touch_updated_at
  before update on app.student_profiles
  for each row execute function app.touch_updated_at();

-- ---------- عضويات المساحة (مدرس/مساعد) ----------
create table if not exists app.teacher_memberships (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references app.teachers (teacher_id) on delete cascade,
  user_id uuid not null references app.profiles (user_id) on delete cascade,
  role_in_workspace app.user_role not null check (role_in_workspace in ('teacher', 'assistant')),
  status app.membership_status not null default 'invited',
  created_by uuid references app.profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint teacher_memberships_unique unique (teacher_id, user_id)
);

comment on table app.teacher_memberships is
  'من ينتمي لمساحة مدرس. صف واحد لكل (مدرس، مستخدم) — لا عضويتان متعارضتان.';

create index if not exists teacher_memberships_user_idx on app.teacher_memberships (user_id, status);

drop trigger if exists teacher_memberships_touch_updated_at on app.teacher_memberships;
create trigger teacher_memberships_touch_updated_at
  before update on app.teacher_memberships
  for each row execute function app.touch_updated_at();

-- ---------- صلاحيات المساعد ----------
create table if not exists app.assistant_permissions (
  membership_id uuid not null references app.teacher_memberships (id) on delete cascade,
  action text not null check (action in (
    'attendance:write', 'grades:read', 'grades:write', 'students:read', 'students:write',
    'groups:read', 'groups:write', 'lessons:read', 'exams:read', 'exams:write'
  )),
  scope_group_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (membership_id, action)
);

comment on table app.assistant_permissions is
  'صلاحية المساعد فعلية ومحصورة اختياريًا بمجموعات (scope_group_ids). المدرس وحده يعدّلها.';

-- ---------- المجموعات ----------
create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references app.teachers (teacher_id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  subject text check (subject is null or char_length(subject) <= 40),
  grade text check (grade is null or char_length(grade) <= 40),
  location_name text check (location_name is null or char_length(location_name) <= 80),
  schedule_text text check (schedule_text is null or char_length(schedule_text) <= 120),
  capacity integer check (capacity is null or capacity > 0),
  academic_year text not null default '2026/2027' check (academic_year ~ '^[0-9]{4}/[0-9]{4}$'),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint groups_unique_name_per_year unique (teacher_id, academic_year, name)
);

comment on table public.groups is
  'مجموعات المدرس. مكشوفة عبر PostgREST لكن RLS تحدّ الصفوف والكتابة (0005).';

create index if not exists groups_teacher_idx on public.groups (teacher_id, status);

drop trigger if exists groups_touch_updated_at on public.groups;
create trigger groups_touch_updated_at
  before update on public.groups
  for each row execute function app.touch_updated_at();

create table if not exists public.group_memberships (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  student_profile_id uuid not null references app.student_profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists group_memberships_active_unique
  on public.group_memberships (group_id, student_profile_id)
  where left_at is null;

comment on table public.group_memberships is
  'عضوية الطالب في مجموعة. فريدة ما دامت سارية (left_at is null).';

-- ---------- دوال مساعدة للعزل ----------
create or replace function app.teacher_id_of_current_user()
returns uuid
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select t.teacher_id from app.teachers t where t.teacher_id = auth.uid();
$$;

create or replace function app.is_workspace_member(target_teacher_id uuid)
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select app.is_active() and exists (
    select 1
    from app.teacher_memberships m
    where m.teacher_id = target_teacher_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

create or replace function app.is_workspace_teacher(target_teacher_id uuid)
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select app.is_active() and (
    exists (select 1 from app.teachers t where t.teacher_id = target_teacher_id and t.teacher_id = auth.uid())
    or exists (
      select 1 from app.teacher_memberships m
      where m.teacher_id = target_teacher_id
        and m.user_id = auth.uid()
        and m.role_in_workspace = 'teacher'
        and m.status = 'active'
    )
  );
$$;

-- المساعد: هل يملك فعلًا معيّنًا؟ (اختياريًا محصورًا بمجموعة)
create or replace function app.assistant_can(target_teacher_id uuid, target_action text, target_group_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select app.is_active() and exists (
    select 1
    from app.teacher_memberships m
    join app.assistant_permissions p on p.membership_id = m.id
    where m.teacher_id = target_teacher_id
      and m.user_id = auth.uid()
      and m.role_in_workspace = 'assistant'
      and m.status = 'active'
      and p.action = target_action
      and (
        target_group_id is null
        or cardinality(p.scope_group_ids) = 0
        or target_group_id = any (p.scope_group_ids)
      )
  );
$$;

comment on function app.assistant_can(uuid, text, uuid) is
  'الصلاحية الفعلية للمساعد. قائمة scope_group_ids فارغة = كل مجموعات المدرس. لا تُستخدم لملفات الطلاب مباشرةً (F-02): استخدم app.assistant_can_see_student.';

-- F-02: نطاق المجموعات يجب أن يُفرض على ملفات الطلاب، لا أن يُتجاهل بتمرير null.
-- الدالة الأولى: هل للمساعد الصلاحية على مستوى المساحة كلها (نطاق فارغ)؟
create or replace function app.assistant_has_full_scope(target_teacher_id uuid, target_action text)
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select app.is_active() and exists (
    select 1
    from app.teacher_memberships m
    join app.assistant_permissions p on p.membership_id = m.id
    where m.teacher_id = target_teacher_id
      and m.user_id = auth.uid()
      and m.role_in_workspace = 'assistant'
      and m.status = 'active'
      and p.action = target_action
      and cardinality(p.scope_group_ids) = 0
  );
$$;

comment on function app.assistant_has_full_scope(uuid, text) is
  'المساعد يملك الصلاحية على كل مجموعات المساحة (scope_group_ids فارغة). تُستخدم عند الإنشاء: لا نطاق ⇒ لا إنشاء.';

-- الدالة الثانية: هل للمساعد الصلاحية على ملف طالب بعينه عبر مجموعاته؟
create or replace function app.assistant_can_see_student(target_student_profile_id uuid, target_action text)
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select app.is_active() and exists (
    select 1
    from app.student_profiles sp
    join app.teacher_memberships m on m.teacher_id = sp.teacher_id
    join app.assistant_permissions p on p.membership_id = m.id
    where sp.id = target_student_profile_id
      and m.user_id = auth.uid()
      and m.role_in_workspace = 'assistant'
      and m.status = 'active'
      and p.action = target_action
      and (
        cardinality(p.scope_group_ids) = 0
        or exists (
          select 1
          from public.group_memberships gm
          where gm.student_profile_id = sp.id
            and gm.left_at is null
            and gm.group_id = any (p.scope_group_ids)
        )
      )
  );
$$;

comment on function app.assistant_can_see_student(uuid, text) is
  'المساعد يرى/يعدّل ملف الطالب فقط إن كان ضمن مجموعة داخلة في نطاقه، أو نطاقه فارغ (كل المساحة).';


create or replace function app.student_profile_of_current_user(target_teacher_id uuid)
returns uuid
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select sp.id
  from app.student_profiles sp
  where sp.teacher_id = target_teacher_id
    and sp.user_id = auth.uid()
    and sp.status = 'active'
  limit 1;
$$;

insert into app.schema_meta (key, value)
values ('migrations_applied', '0001_extensions,0002_identity_profiles,0003_teacher_workspaces')
on conflict (key) do update set value = excluded.value, updated_at = now();
