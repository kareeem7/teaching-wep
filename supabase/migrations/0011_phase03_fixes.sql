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

-- ---------- ٣) جذر D-03-A الحقيقي: العرض security_invoker فوق جدول بلا منح ----------
-- الدليل من القاعدة: `public.admin_invitations` عرض security_invoker=true، فقراءته
-- تنفَّذ بصلاحيات المستدعي على `app.invitations` — وهذا الجدول **بلا أي منح**
-- لـ`authenticated` (مقصود: يحمل token_hash). فأي منح للعرض وحده لا يكفي: النداء
-- يرتد 42501 من الجدول الأساسي، وهو ما جعل العيب يبدو «منحة ناقصة على العرض».
--
-- الإصلاح بلا توسيع سطح `app.invitations`: يبقى بلا منح كما هو، ويصير هذا العرض
-- **بصلاحيات مالكه**، وفلترته الذاتية `WHERE app.is_super_admin()` هي الحاكم.
-- مُثبت بالدليل على البيئة: سوبر أدمن=11 صفًا · مدرس=0 صفوف · anon=42501.
alter view public.admin_invitations set (security_invoker = false);
revoke all on public.admin_invitations from anon;
grant select on public.admin_invitations to authenticated;

-- نفس العلّة في `admin_teachers`: قراءتها بـ`select=*` تنفَّذ بصلاحيات المستدعي
-- فتصطدم بأعمدة مشتقة من `app.student_profiles` و`app.invitations`
-- (42501 ⇒ 403 على PostgREST) رغم أن `count(*)` ينجح. فلترتها الذاتية
-- `WHERE app.is_super_admin()` قائمة، فتحويلها إلى صلاحيات المالك آمن.
-- مُثبت: سوبر أدمن=12 صفًا · مدرس=0 صفوف.
alter view public.admin_teachers set (security_invoker = false);

-- PostgREST لا يعرف الدالة الجديدة إلا بعد إعادة تحميل المخطط.
notify pgrst, 'reload schema';
