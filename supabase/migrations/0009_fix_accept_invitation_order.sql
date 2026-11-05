-- =====================================================================
--  0009 — إصلاح ترتيب استهلاك الدعوة (F-38)
--  ---------------------------------------------------------------------
--  العيب: `svc_accept_invitation` كانت تستدعي `app.consume_invitation`
--  أولًا، وهي تكتب `used_by = p_user_id`، والعمود مرتبط بمفتاح أجنبي إلى
--  `app.profiles(user_id)`. لكن الملف الشخصي لا يُنشأ إلا في السطر التالي
--  عبر `svc_accept_identity` ⇒ كل قبول دعوة يفشل بـ23503 ويخرج 500.
--
--  الاكتشاف: تشغيل الرحلة 42119786478 على بيئة الاختبار، ثم محاكاة مباشرة
--  لدالة القاعدة: `23503 :: violates foreign key constraint
--  "invitations_used_by_fkey"`.
--
--  الإصلاح: إنشاء الهوية/الملف أولًا ثم استهلاك الدعوة.
--  أثر جانبي محتمل: لو كان الرمز غير صالح يُنشأ ملف ثم ترفض الدعوة؛
--  ودالة الحافة تحذف مستخدم GoTrue المُنشأ عند فشل القبول فتزول الملفات
--  تبعًا لـON DELETE CASCADE. الدعوة نفسها تبقى صالحة لأن الاستهلاك لم يحدث.
--
--  ملاحظة ترقيم (R-46): هذا إصلاح للمرحلة ٠٣ ويأخذ الرقم 0009،
--  وتُزاح مهاجرات المرحلة ٠٤ إلى 0010–0013.
-- =====================================================================

create or replace function public.svc_accept_invitation(
  p_token_hash text,
  p_kind text,
  p_user_id uuid,
  p_full_name text,
  p_phone text default null,
  p_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_invite app.invitations;
  v_profile jsonb;
  v_link jsonb;
  v_role text;
begin
  if p_kind is null or p_kind not in ('teacher_invite', 'student_link') then
    raise exception 'invitation-wrong-kind' using errcode = '22023';
  end if;
  v_role := case p_kind when 'teacher_invite' then 'teacher' else 'student' end;

  if p_full_name is null or btrim(p_full_name) = '' then
    raise exception 'invalid-full-name' using errcode = '22023';
  end if;

  -- (١) الهوية أولًا: يُنشأ صف app.profiles المطلوب للمفتاح الأجنبي في الخطوة (٢).
  v_profile := public.svc_accept_identity(p_user_id, p_full_name, v_role, p_phone, p_code, 'active');

  -- (٢) ثم تُستهلك الدعوة: تتحقق من الصلاحية والاستخدام مرة واحدة وتكتب used_by.
  v_invite := app.consume_invitation(p_token_hash, p_kind::app.invitation_kind, p_user_id);

  if p_kind = 'student_link' then
    if v_invite.student_profile_id is null then
      raise exception 'invitation-wrong-kind' using errcode = '22023';
    end if;
    v_link := public.svc_link_student_profile(v_invite.student_profile_id, p_user_id);
  else
    v_link := null;
  end if;

  return jsonb_build_object(
    'kind', v_invite.kind,
    'teacher_id', v_invite.teacher_id,
    'student_profile_id', v_invite.student_profile_id,
    'profile', v_profile,
    'linked', v_link
  );
end;
$$;

comment on function public.svc_accept_invitation(text, text, uuid, text, text, text) is
  'قبول دعوة (مدرس/طالب) — خدمي: يُنشئ الهوية ثم يستهلك الدعوة ذرِّيًا. الإصلاح F-38.';

revoke all on function public.svc_accept_invitation(text, text, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.svc_accept_invitation(text, text, uuid, text, text, text)
  to service_role;
