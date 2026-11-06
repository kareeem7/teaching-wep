-- =====================================================================
--  0012 — الأماكن والمواد والصفوف والمواعيد + ربطها بالمجموعات
--  ---------------------------------------------------------------------
--  قرار العميل (٢٠٢٦-١١-٠٦): «الأماكن والمواد والصفوف والمواعيد» تُبنى
--  **كيانات مستقلة** لا نصوصًا داخل المجموعة، و«الصفوف» = الصف الدراسي.
--
--  ملاحظة ترقيم: أسماء المهاجرات في برومبت ٠٤ (0008…0011) مستخدمة ومطبَّقة
--  فعلًا، فانتقلت المرحلة إلى 0012…0015. مسجَّل في docs/DECISIONS.md (R-46).
--
--  المبدأ:
--    • كل كيان داخل مساحة مدرس واحدة، والعزل عمود `teacher_id` كما في 0003.
--    • المجموعة تشير إلى المكان/المادة/الصف بمفتاح مركّب (id, teacher_id)
--      فيستحيل عليها الإشارة إلى كيان مدرس آخر — قيد في قاعدة البيانات
--      لا فحص في التطبيق.
--    • الأعمدة النصية القديمة في `public.groups` تبقى للتوافق، وتُملأ منها
--      الكيانات الجديدة مرة واحدة (نقل بيانات لا حذف).
--    • RLS مُفعَّلة هنا بلا سياسات؛ السياسات في 0015. أي تطبيق جزئي
--      يمنع الجميع بدل أن يفتح للجميع.
-- =====================================================================

begin;

-- ---------- ١) الأماكن ----------
create table if not exists public.locations (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references app.teachers (teacher_id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  address text check (address is null or char_length(address) <= 200),
  notes text check (notes is null or char_length(notes) <= 500),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint locations_id_teacher_unique unique (id, teacher_id)
);

comment on table public.locations is
  'أماكن المدرس (سنتر/قاعة/بيت). تسمية متشابهة عند مدرسين مختلفين لا تُدمج: التفرّد داخل teacher_id فقط.';

create unique index if not exists locations_active_name_unique
  on public.locations (teacher_id, lower(btrim(name)))
  where status = 'active';

create index if not exists locations_teacher_idx on public.locations (teacher_id, status);

drop trigger if exists locations_touch_updated_at on public.locations;
create trigger locations_touch_updated_at
  before update on public.locations
  for each row execute function app.touch_updated_at();

-- ---------- ٢) المواد ----------
create table if not exists public.subjects (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references app.teachers (teacher_id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subjects_id_teacher_unique unique (id, teacher_id)
);

create unique index if not exists subjects_active_name_unique
  on public.subjects (teacher_id, lower(btrim(name)))
  where status = 'active';

drop trigger if exists subjects_touch_updated_at on public.subjects;
create trigger subjects_touch_updated_at
  before update on public.subjects
  for each row execute function app.touch_updated_at();

-- ---------- ٣) الصفوف الدراسية ----------
create table if not exists public.grades (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references app.teachers (teacher_id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  sort_order integer not null default 100,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint grades_id_teacher_unique unique (id, teacher_id)
);

comment on table public.grades is
  'الصف الدراسي داخل مساحة المدرس (أولى ثانوي…). ليس فصلاً/شعبة: ذلك يخص المكان والموعد.';

create unique index if not exists grades_active_name_unique
  on public.grades (teacher_id, lower(btrim(name)))
  where status = 'active';

drop trigger if exists grades_touch_updated_at on public.grades;
create trigger grades_touch_updated_at
  before update on public.grades
  for each row execute function app.touch_updated_at();

-- ---------- ٤) ربط المجموعة بالكيانات الجديدة ----------
alter table public.groups add column if not exists location_id uuid;
alter table public.groups add column if not exists subject_id uuid;
alter table public.groups add column if not exists grade_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'groups_location_same_teacher' and conrelid = 'public.groups'::regclass
  ) then
    alter table public.groups
      add constraint groups_location_same_teacher
      foreign key (location_id, teacher_id) references public.locations (id, teacher_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'groups_subject_same_teacher' and conrelid = 'public.groups'::regclass
  ) then
    alter table public.groups
      add constraint groups_subject_same_teacher
      foreign key (subject_id, teacher_id) references public.subjects (id, teacher_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'groups_grade_same_teacher' and conrelid = 'public.groups'::regclass
  ) then
    alter table public.groups
      add constraint groups_grade_same_teacher
      foreign key (grade_id, teacher_id) references public.grades (id, teacher_id);
  end if;
end;
$$;

create index if not exists groups_location_idx on public.groups (location_id) where location_id is not null;

-- ---------- ٥) المواعيد: مقاطع أسبوعية للمجموعة ----------
create table if not exists public.schedule_slots (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  -- ٠ = السبت … ٦ = الجمعة (أسبوع عربي يبدأ السبت)
  weekday smallint not null check (weekday between 0 and 6),
  starts_at time not null,
  ends_at time not null,
  location_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint schedule_slots_time_order check (ends_at > starts_at)
);

comment on table public.schedule_slots is
  'موعد أسبوعي لمجموعة. تكرار (نفس اليوم/البداية) في نفس المجموعة ممنوع؛ التقاطع مع مجموعة أخرى تنبيه في الواجهة لا قيد في القاعدة.';

create unique index if not exists schedule_slots_group_slot_unique
  on public.schedule_slots (group_id, weekday, starts_at);

create index if not exists schedule_slots_group_idx on public.schedule_slots (group_id);

drop trigger if exists schedule_slots_touch_updated_at on public.schedule_slots;
create trigger schedule_slots_touch_updated_at
  before update on public.schedule_slots
  for each row execute function app.touch_updated_at();

-- المكان في الموعد يجب أن يكون لنفس مدرس المجموعة (قيد مركّب عبر دالة،
-- لأن الجدول لا يحمل teacher_id ويُفضَّل ألا يحمله تفاديًا للتكرار).
create or replace function app.schedule_slot_location_matches_group()
returns trigger
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_teacher uuid;
begin
  if new.location_id is null then
    return new;
  end if;

  select g.teacher_id into v_teacher from public.groups g where g.id = new.group_id;

  if not exists (
    select 1 from public.locations l
    where l.id = new.location_id and l.teacher_id = v_teacher
  ) then
    raise exception 'location-not-in-workspace' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists schedule_slots_location_guard on public.schedule_slots;
create trigger schedule_slots_location_guard
  before insert or update of group_id, location_id on public.schedule_slots
  for each row execute function app.schedule_slot_location_matches_group();

-- ---------- ٦) نقل البيانات النصية القديمة إلى الكيانات ----------
do $$
declare
  r record;
  v_location uuid;
  v_subject uuid;
  v_grade uuid;
begin
  -- الأماكن
  for r in
    select distinct g.teacher_id, btrim(g.location_name) as name
    from public.groups g
    where g.location_name is not null and btrim(g.location_name) <> ''
  loop
    insert into public.locations (teacher_id, name)
    values (r.teacher_id, r.name)
    on conflict do nothing;

    select l.id into v_location
    from public.locations l
    where l.teacher_id = r.teacher_id and lower(btrim(l.name)) = lower(r.name)
    limit 1;

    update public.groups g
       set location_id = v_location
     where g.teacher_id = r.teacher_id
       and g.location_id is null
       and lower(btrim(g.location_name)) = lower(r.name);
  end loop;

  -- المواد
  for r in
    select distinct g.teacher_id, btrim(g.subject) as name
    from public.groups g
    where g.subject is not null and btrim(g.subject) <> ''
  loop
    insert into public.subjects (teacher_id, name)
    values (r.teacher_id, r.name)
    on conflict do nothing;

    select s.id into v_subject
    from public.subjects s
    where s.teacher_id = r.teacher_id and lower(btrim(s.name)) = lower(r.name)
    limit 1;

    update public.groups g
       set subject_id = v_subject
     where g.teacher_id = r.teacher_id
       and g.subject_id is null
       and lower(btrim(g.subject)) = lower(r.name);
  end loop;

  -- الصفوف
  for r in
    select distinct g.teacher_id, btrim(g.grade) as name
    from public.groups g
    where g.grade is not null and btrim(g.grade) <> ''
  loop
    insert into public.grades (teacher_id, name)
    values (r.teacher_id, r.name)
    on conflict do nothing;

    select gr.id into v_grade
    from public.grades gr
    where gr.teacher_id = r.teacher_id and lower(btrim(gr.name)) = lower(r.name)
    limit 1;

    update public.groups g
       set grade_id = v_grade
     where g.teacher_id = r.teacher_id
       and g.grade_id is null
       and lower(btrim(g.grade)) = lower(r.name);
  end loop;
end;
$$;

-- ---------- ٧) الصلاحيات: المنح لـauthenticated، والعزل في RLS ----------
alter table public.locations      enable row level security;
alter table public.subjects       enable row level security;
alter table public.grades         enable row level security;
alter table public.schedule_slots enable row level security;

grant select, insert, update on public.locations      to authenticated;
grant select, insert, update on public.subjects       to authenticated;
grant select, insert, update on public.grades         to authenticated;
grant select, insert, update, delete on public.schedule_slots to authenticated;

revoke all on public.locations      from anon;
revoke all on public.subjects       from anon;
revoke all on public.grades         from anon;
revoke all on public.schedule_slots from anon;

-- لا DELETE على الأماكن/المواد/الصفوف: الأرشفة بحالة status.
-- لا كتابة أكاديمية للسوبر أدمن هنا: السياسات في 0015 تقصر الكتابة على
-- مالك المساحة ومساعده المخوَّل، والقراءة الإدارية عبر عرض إداري منفصل.

commit;
