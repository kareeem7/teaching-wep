-- =====================================================================
--  0010 — تصفير عدّادات الحد (أداة تشغيل، لا مسار مستخدم)
--  ---------------------------------------------------------------------
--  لماذا؟ حدّ الدخول (٥ محاولات/١٥ دقيقة لكل معرّف) صحيح أمنيًا، لكنه يجعل
--  أي فحص آلي متكرر يفشل بـ429 لأسباب لا علاقة لها بالكود (F-45). الحلّ ليس
--  رفع الحدّ بل أداة صريحة يملكها service_role وحده، تُستخدم للفحص وللدعم
--  (فكّ حجب مستخدم أوقف نفسه بالتخمين).
--
--  الأمان: المخطط app غير مكشوف، والدالة العامة تُنفّذ `security definer`
--  وممنوعة على anon/authenticated، فلا يمكن لأي متصفح استدعاؤها.
-- =====================================================================

create or replace function app.rate_limit_reset(p_prefix text default null)
returns integer
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_deleted integer;
  v_prefix text;
begin
  -- بادئة فارغة = كل المفاتيح. الشرط في `where` مقصود: قاعدة الاختبار تُفعّل
  -- safeupdate، و`delete` بلا `where` يرفض بـ21000 (شوهد في الرحلة F-47).
  v_prefix := coalesce(btrim(p_prefix), '');
  delete from app.rate_limits where bucket_key like (v_prefix || '%');
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

create or replace function public.svc_rate_limit_reset(p_prefix text default null)
returns integer
language sql
security definer
set search_path = app, pg_temp
as $$
  select app.rate_limit_reset(p_prefix);
$$;

comment on function public.svc_rate_limit_reset(text) is
  'تصفير عدّادات الحد (أداة تشغيل/دعم) — service_role فقط. انظر F-45.';

revoke all on function public.svc_rate_limit_reset(text) from public, anon, authenticated;
grant execute on function public.svc_rate_limit_reset(text) to service_role;
