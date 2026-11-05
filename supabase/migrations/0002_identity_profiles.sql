-- =====================================================================
--  0002_identity_profiles.sql — المرحلة ٠٢
--  الهوية: الأنواع + الملفات + حسابات المدرسين + دوال سياق آمنة.
--
--  قواعد حاكمة:
--   ١. الهوية عالمية في `auth.users`، والملف في `app.profiles` (١─١).
--   ٢. معرّف الدخول (هاتف أو كود) يعيش في `app.profiles` فقط، وهو الفريد عالميًا.
--   ٣. المخطط `app` غير مكشوف عبر PostgREST (0001)، فلا وصول للمتصفح إلا عبر
--      واجهات `public` المنضبطة في 0005 أو عبر Edge Functions.
--   ٤. لا أسرار ولا كلمات مرور هنا: كلمة المرور في `auth.users` وحدها (تجزئتها في Supabase Auth).
--  المرجع: docs/AUTH_DESIGN.md §٣، docs/DATA_MODEL.md §٢، R-11، R-25.
-- =====================================================================

-- ---------- الأنواع ----------
do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'app' and t.typname = 'user_role') then
    create type app.user_role as enum ('super_admin', 'teacher', 'assistant', 'student');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'app' and t.typname = 'account_status') then
    create type app.account_status as enum ('pending', 'active', 'suspended', 'archived');
  end if;
end
$$;

-- ---------- الملفات ----------
create table if not exists app.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null check (char_length(full_name) between 2 and 120),
  role app.user_role not null,
  status app.account_status not null default 'pending',

  -- معرّفات الدخول: أحدهما على الأقل، وكلاهما فريد عند وجوده
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  student_code text check (student_code is null or student_code ~ '^[A-Z]{2}[0-9]{6}$'),

  -- أي جلسة أُصدرت قبل هذا الوقت تُرفض (تغيير كلمة المرور/الإيقاف) — AUTH_DESIGN §٥
  sessions_valid_after timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- لا طالب بلا كود ولا هاتف؛ ولا كود لمن ليس طالبًا
  constraint profiles_identifier_required check (
    (role = 'student' and (phone_e164 is not null or student_code is not null))
    or (role <> 'student')
  ),
  constraint profiles_code_only_for_students check (
    student_code is null or role = 'student'
  )
);

comment on table app.profiles is
  'هوية كل مستخدم. الهاتف/الكود للدخول فقط، ولا يُعاد للمتصفح كاملًا (auth.publicProfile).';
comment on column app.profiles.sessions_valid_after is
  'سياسة إبطال الجلسات: RLS ترفض أي JWT تاريخ إصداره أقدم من هذه القيمة.';

create unique index if not exists profiles_phone_unique
  on app.profiles (phone_e164) where phone_e164 is not null;

create unique index if not exists profiles_student_code_unique
  on app.profiles (student_code) where student_code is not null;

create index if not exists profiles_role_status_idx on app.profiles (role, status);

-- ---------- حسابات المدرسين ----------
create table if not exists app.teachers (
  teacher_id uuid primary key references app.profiles (user_id) on delete cascade,
  headline text check (headline is null or char_length(headline) <= 160),
  created_at timestamptz not null default now()
);

comment on table app.teachers is
  'بيانات المدرس العامة. وجود صف هنا يعني أن الدور teacher وقد اجتاز دعوة صحيحة.';

-- ---------- تحديث updated_at ----------
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on app.profiles;
create trigger profiles_touch_updated_at
  before update on app.profiles
  for each row execute function app.touch_updated_at();

-- ---------- دوال السياق ----------
-- SECURITY DEFINER لأن RLS تحتاج قراءة الملف دون الدخول في تكرار لا نهائي.
create or replace function app.current_profile()
returns app.profiles
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select * from app.profiles where user_id = auth.uid();
$$;

comment on function app.current_profile() is
  'ملف المستخدم الحالي. null إن لم يوجد — وهذا يعني رفضًا لا سماحًا.';

create or replace function app.jwt_iat()
returns bigint
language plpgsql
stable
as $$
declare
  v_claims jsonb;
  v_iat text;
begin
  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    return null;
  end;
  if v_claims is null then
    return null;
  end if;
  v_iat := v_claims ->> 'iat';
  if v_iat is null or v_iat !~ '^[0-9]{1,12}$' then
    return null;
  end if;
  return v_iat::bigint;
end;
$$;

comment on function app.jwt_iat() is
  'وقت إصدار التوكن بالثواني الصحيحة، أو null إن غاب التشكيل أو كان غير صالح. الغياب = رفض لا سماح (F-09).';

create or replace function app.is_active()
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select exists (
    select 1
    from app.profiles p
    where p.user_id = auth.uid()
      and p.status = 'active'
      -- F-07: الطرفان بالثواني الصحيحة (floor) — لا تقريب يُرفض جلسة صحيحة،
      -- ولا افتراض «الآن» عند غياب iat (F-09): الغياب يقارن بـ null ⇒ false.
      and app.jwt_iat() >= floor(extract(epoch from p.sessions_valid_after))::bigint
  );
$$;

comment on function app.is_active() is
  'الحساب نشط وجلسته أحدث من آخر تغيير حساس (دقة ثانية واحدة). أي RLS تكتب/تقرأ بيانات شخصية تستخدمها.';

create or replace function app.current_role_name()
returns text
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select p.role::text from app.profiles p where p.user_id = auth.uid();
$$;

create or replace function app.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select exists (
    select 1 from app.profiles p
    where p.user_id = auth.uid()
      and p.role = 'super_admin'
      and p.status = 'active'
  );
$$;

-- ---------- حارس عدم تصعيد الدور ----------
-- منع تغيير الدور أو معرّفات الدخول من داخل جلسة مستخدم عادي:
-- التغييرات الإدارية تمرّ بـservice_role (Edge Functions) أو بدور postgres في المهاجرات.
create or replace function app.guard_profile_identity()
returns trigger
language plpgsql
security definer
set search_path = app, pg_temp
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if new.role <> old.role then
      raise exception 'role is immutable for %', current_user using errcode = '42501';
    end if;
    if coalesce(new.phone_e164, '') <> coalesce(old.phone_e164, '')
       or coalesce(new.student_code, '') <> coalesce(old.student_code, '') then
      raise exception 'login identifiers are immutable for %', current_user using errcode = '42501';
    end if;
    if new.status <> old.status and not app.is_super_admin() then
      raise exception 'status change requires super admin' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_identity on app.profiles;
create trigger profiles_guard_identity
  before update on app.profiles
  for each row execute function app.guard_profile_identity();

-- ---------- تسجيل الإصدار ----------
insert into app.schema_meta (key, value)
values ('migrations_applied', '0001_extensions,0002_identity_profiles'),
       ('schema_phase', '02')
on conflict (key) do update set value = excluded.value, updated_at = now();
