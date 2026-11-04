-- 0001_extensions.sql
-- الأساس البنيوي للمرحلة ٠١: الامتدادات والمخطط app وجدول إعدادات المنصة.
-- لا يحتوي هذا الملف أي جداول أعمال (طلاب/مدرّسون/امتحانات)؛ تلك تُبنى في مرحلة المخطط.
-- قابل لإعادة التنفيذ (idempotent) قدر الإمكان.

create extension if not exists "pgcrypto" with schema extensions;
create extension if not exists "citext" with schema extensions;
create extension if not exists "pg_trgm" with schema extensions;

create schema if not exists app;

comment on schema app is 'منطق المنصة ومكوّناتها المشتركة — منفصل عن public';

-- دالة مشتركة لتحديث updated_at (تُستخدم لاحقًا في جداول الأعمال)
create or replace function app.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- إعدادات عرض عامة غير حساسة (اسم المنصة، المنطقة الزمنية، اللغة)
create table if not exists app.platform_meta (
  key text primary key,
  value text not null,
  description text,
  updated_at timestamptz not null default now()
);

comment on table app.platform_meta is 'إعدادات عرض عامة غير حساسة تُقرأ من الواجهة';

drop trigger if exists platform_meta_set_updated_at on app.platform_meta;
create trigger platform_meta_set_updated_at
  before update on app.platform_meta
  for each row execute function app.set_updated_at();

-- RLS: مفعّلة، والقراءة متاحة للزوار، والكتابة محجوبة عن المتصفح تمامًا.
alter table app.platform_meta enable row level security;

drop policy if exists platform_meta_public_read on app.platform_meta;
create policy platform_meta_public_read
  on app.platform_meta
  for select
  to anon, authenticated
  using (true);

revoke all on app.platform_meta from anon, authenticated;
grant select on app.platform_meta to anon, authenticated;

grant usage on schema app to anon, authenticated;
