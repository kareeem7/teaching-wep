-- 0001b_platform_meta.sql
-- (كانت 0002 ثم أُعيد ترقيمها بقرار العميل A-13/D-323 لتحرير 0002–0005 للمرحلة ٠٢)
-- سبب وجود هذا الملف منفصلًا: المهاجرة 0001 كانت قد طُبِّقت فعلًا على مشروع التطوير،
-- والمهاجرات سجل إضافي لا يُعاد كتابته (append-only). انظر D-312 في docs/DECISIONS.md.
-- الأثر: نقل جدول إعدادات العرض إلى public ليصبح مقروءًا عبر REST تحت RLS،
-- مع إبقاء مخطط app للمنطق الداخلي غير المكشوف.

drop table if exists app.platform_meta cascade;

create table if not exists public.platform_meta (
  key text primary key,
  value text not null,
  description text,
  updated_at timestamptz not null default now()
);

comment on table public.platform_meta is 'إعدادات عرض عامة غير حساسة، قراءة فقط من المتصفح';

drop trigger if exists platform_meta_set_updated_at on public.platform_meta;
create trigger platform_meta_set_updated_at
  before update on public.platform_meta
  for each row execute function app.set_updated_at();

alter table public.platform_meta enable row level security;

drop policy if exists platform_meta_public_read on public.platform_meta;
create policy platform_meta_public_read
  on public.platform_meta
  for select
  to anon, authenticated
  using (true);

-- لا سياسة كتابة: التعديل من لوحة Supabase أو بمهاجرة فقط، لا من المتصفح.
revoke all on public.platform_meta from anon, authenticated;
grant select on public.platform_meta to anon, authenticated;
