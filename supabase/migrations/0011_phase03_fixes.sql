-- =====================================================================
--  0011 — إصلاحات فحص المرحلة ٠٣ (D-03-A · D-03-B)
--  ---------------------------------------------------------------------
--  D-03-A (HIGH): `public.admin_invitations` كان يرد 42501 حتى لسوبر أدمن في
--    بيئة الفحص. السبب انحراف بيئة عن الريبو: مهاجرة 0007 تمنح SELECT
--    لـ`authenticated`، ولم يصدر أي revoke في المهاجرات، لكن ACL الحي كان بلا `r`.
--    الإصلاح: إعادة المنح صراحةً (idempotent) فلا تعتمد البيئة على تاريخ يدوي.
--    لا توسيع سطح: `app.invitations` (التي تحمل token_hash) تبقى بلا أي منح
--    ولا سياسة؛ العرض `security_invoker` يُرجع صفرًا لغير السوبر أدمن.
--
--  D-03-B (HIGH): «صندوق تنبيهات» بلا مسار كتابة. `my_notifications` للقراءة
--    فقط، ومخطط `app` غير مكشوف في PostgREST، فلا يمكن للمتصفح تحديث read_at
--    مباشرةً. الحل: دالة في `public` تأخذ هوية المستخدم من auth.uid() **ولا
--    تقبل معرّف مستخدم كوسيط**، فلا يمكن تعليم تنبيه غيرك كمقروء.
-- =====================================================================

begin;

-- ---------- ١) D-03-A: مطابقة منح قائمة الدعوات مع المهاجرة 0007 ----------
grant select on public.admin_invitations to authenticated;
revoke all on public.admin_invitations from anon;

-- ---------- ٢) D-03-B: تعليم تنبيه كمقروء — للمستلم وحده ----------
create or replace function public.mark_notification_read(p_notification_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_read timestamptz;
  v_changed boolean := false;
begin
  if v_user is null then
    raise exception 'no-session' using errcode = '42501';
  end if;
  if p_notification_id is null then
    raise exception 'invalid-notification-id' using errcode = '22023';
  end if;
  -- الجلسة يجب أن تكون نشطة (نفس شرط العرض my_notifications)
  if not app.is_active() then
    raise exception 'inactive-session' using errcode = '42501';
  end if;

  -- القيد الحاكم: user_id = صاحب الجلسة. لا وسيط يسمح بتعليم تنبيه غيرك.
  update app.notification_recipients r
     set read_at = coalesce(r.read_at, now())
   where r.notification_id = p_notification_id
     and r.user_id = v_user
     and r.read_at is null
  returning r.read_at into v_read;

  v_changed := v_read is not null;

  if not v_changed then
    -- إما مقروء سابقًا أو ليس من مستلمي هذا التنبيه — الرد واحد للحالتين
    -- حتى لا يُستخدم النداء لاستكشاف وجود تنبيهات لغيره.
    select r.read_at into v_read
      from app.notification_recipients r
     where r.notification_id = p_notification_id
       and r.user_id = v_user;
    if v_read is null then
      raise exception 'not-a-recipient' using errcode = '42501';
    end if;
  end if;

  return jsonb_build_object(
    'notification_id', p_notification_id,
    'read_at', v_read,
    'changed', v_changed
  );
end;
$$;

comment on function public.mark_notification_read(uuid) is
  'تعليم تنبيه كمقروء للمستلم الحالي فقط (auth.uid()). لا يقبل معرّف مستخدم. D-03-B.';

revoke all on function public.mark_notification_read(uuid) from public, anon;
grant execute on function public.mark_notification_read(uuid) to authenticated;

commit;
