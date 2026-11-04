-- =====================================================================
--  0001_extensions.sql — المرحلة ٠١
--  الغرض: الإضافات والمخططات الأساسية فقط. لا جداول أكاديمية هنا
--  (تأتي في المرحلة ٠٢ مع RLS)، ولا بيانات حقيقية في أي حال.
--  المرجع: docs/SUPABASE_ARCHITECTURE.md §٢ و§٦
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- مخطط المنطق: غير مكشوف عبر PostgREST أبدًا (SECURITY: ARCHITECTURE §٢)
create schema if not exists app;

revoke all on schema app from anon, authenticated;
grant usage on schema app to service_role;

comment on schema app is
  'منطق داخلي غير مكشوف: العضويات، الصلاحيات، المحاولات، التدقيق. يُقرأ فقط عبر دوال آمنة.';

-- سجل إصدار المخطط: مرجع واحد لمعرفة ما طُبِّق فعلًا على القاعدة
create table if not exists app.schema_meta (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

comment on table app.schema_meta is
  'بيانات وصفية عن المخطط. لا تحتوي أي بيانات شخصية.';

revoke all on app.schema_meta from anon, authenticated;
grant select, insert, update on app.schema_meta to service_role;

insert into app.schema_meta (key, value)
values
  ('platform_name', 'مِنهاج'),
  ('schema_phase', '01'),
  ('migrations_applied', '0001_extensions')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
