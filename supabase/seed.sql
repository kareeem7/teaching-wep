-- seed.sql — بيانات تركيبية فقط، بلا أي بيانات أشخاص حقيقيين.
-- آمنة للتكرار: كل إدراج يستخدم on conflict.

insert into public.platform_meta (key, value, description) values
  ('platform_name', 'مِنهاج', 'اسم المنصة المعتمد (A-11)'),
  ('default_locale', 'ar-EG', 'لغة العرض الافتراضية'),
  ('default_timezone', 'Africa/Cairo', 'المنطقة الزمنية المرجعية'),
  ('phase', '1', 'المرحلة الحالية من خطة التنفيذ')
on conflict (key) do update
  set value = excluded.value,
      description = excluded.description;
