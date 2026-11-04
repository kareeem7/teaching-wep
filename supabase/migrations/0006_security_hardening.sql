-- 0006_security_hardening.sql
-- سبب الملف منفصلًا: المهاجرات سجل إضافي لا يُعاد كتابته (انظر D-312).
-- الأثر: تحصين دالة تحديث الطابع الزمني بمسار بحث فارغ (D-321).
-- غير مطلوب اليوم لأن الدالة invoker، لكنه يمنع تحولها إلى ثغرة لو صارت definer لاحقًا.

create or replace function app.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function app.set_updated_at() is 'تحديث updated_at — search_path فارغ (تحصين D-321)';
