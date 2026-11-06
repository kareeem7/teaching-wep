-- =====================================================================
--  0013 — ملفات الطلاب: تسجيل محلي، تحقق من الحقول، تنبيه تكرار، دعوة ربط
--  ---------------------------------------------------------------------
--  المبدأ الحاكم (برومبت ٠٤):
--    • الطالب قد يوجد محليًا بلا حساب (status = pending_link) حتى يقبل دعوة
--      الربط — وهذا قائم في 0003 ولا يُغيَّر هنا.
--    • التكرار **تنبيه** لا دمج تلقائي: لا unique على الهاتف، بل دالة تُرجع
--      المرشّحين ليتخذ المدرس القرار.
--    • التحقق من الهاتف وولي الأمر والصف والكود في **القاعدة**، لا في المتصفح.
--    • الدوال المكشوفة كلها `svc_*` تنفيذها لـ`service_role` فقط؛ الواجهة
--      تصل إليها عبر Edge Function تتحقق من الجلسة والدور أولًا.
-- =====================================================================

begin;

-- ---------- ١) حقول الطالب الناقصة ----------
alter table app.student_profiles
  add column if not exists phone_e164 text,
  add column if not exists grade_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'student_profiles_phone_format' and conrelid = 'app.student_profiles'::regclass
  ) then
    alter table app.student_profiles
      add constraint student_profiles_phone_format
      check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$');
  end if;

  -- طالب بلا رقم مستقل يقبل الدخول بكود فريد ⇒ يجب أن يوجد رقم ولي أمر واحد على الأقل.
  if not exists (
    select 1 from pg_constraint
    where conname = 'student_profiles_needs_a_contact' and conrelid = 'app.student_profiles'::regclass
  ) then
    alter table app.student_profiles
      -- `not valid`: صفوف سيئة قديمة لا تُكلِّف الترحيل فشلًا؛ تُتحقَّق الجديدة فقط،
      -- ثم تُطبَّق بـ`validate constraint` بعد تنظيف البيانات القديمة.
      add constraint student_profiles_needs_a_contact
      check (phone_e164 is not null or guardian_phone_e164 is not null) not valid;
  end if;
end;
$$;

create index if not exists student_profiles_phone_idx
  on app.student_profiles (teacher_id, phone_e164) where phone_e164 is not null;
create index if not exists student_profiles_guardian_idx
  on app.student_profiles (teacher_id, guardian_phone_e164) where guardian_phone_e164 is not null;
create index if not exists student_profiles_grade_idx
  on app.student_profiles (grade_id) where grade_id is not null;

-- الصف يجب أن يكون لمساحة المدرس نفسها (قيد مركّب من نوع آخر: عبر مُشغِّل).
create or replace function app.student_profile_grade_matches_workspace()
returns trigger
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
begin
  if new.grade_id is null then
    return new;
  end if;

  if not exists (
    select 1 from public.grades g
    where g.id = new.grade_id and g.teacher_id = new.teacher_id
  ) then
    raise exception 'grade-not-in-workspace' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists student_profiles_grade_guard on app.student_profiles;
create trigger student_profiles_grade_guard
  before insert or update of grade_id, teacher_id on app.student_profiles
  for each row execute function app.student_profile_grade_matches_workspace();

-- ---------- ٢) تنبيه التكرار (بلا دمج تلقائي) ----------
create or replace function app.student_duplicate_hints(
  p_teacher_id uuid,
  p_phone text,
  p_guardian_phone text,
  p_full_name text,
  p_exclude_profile uuid default null
)
returns table (profile_id uuid, full_name text, local_code text, status app.student_link_status, reason text)
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select sp.id, sp.full_name, sp.local_code, sp.status, r.reason
  from app.student_profiles sp
  cross join lateral (
    select case
             when p_phone is not null and sp.phone_e164 = p_phone then 'same_phone'
             when p_guardian_phone is not null and sp.guardian_phone_e164 = p_guardian_phone then 'same_guardian_phone'
             else 'similar_name'
           end as reason
  ) r
  where sp.teacher_id = p_teacher_id
    and (p_exclude_profile is null or sp.id <> p_exclude_profile)
    and (
      (p_phone is not null and sp.phone_e164 = p_phone)
      or (p_guardian_phone is not null and sp.guardian_phone_e164 = p_guardian_phone)
      -- تشابه الاسم: تنبيه فقط، ولا يمنع الإضافة
      or (p_full_name is not null and lower(btrim(sp.full_name)) = lower(btrim(p_full_name)))
    )
  order by sp.created_at
  limit 10;
$$;

comment on function app.student_duplicate_hints(uuid, text, text, text, uuid) is
  'مرشّحو تكرار داخل مساحة مدرس واحد فقط. لا تُدمج السجلات تلقائيًا — القرار للمدرس.';

-- ---------- ٣) التسجيل المحلي ----------
create or replace function app.student_register_local(
  p_actor uuid,
  p_teacher_id uuid,
  p_full_name text,
  p_local_code text,
  p_phone text default null,
  p_guardian_phone text default null,
  p_grade_id uuid default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_name text := btrim(coalesce(p_full_name, ''));
  v_code text := upper(btrim(coalesce(p_local_code, '')));
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_guardian text := nullif(btrim(coalesce(p_guardian_phone, '')), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_id uuid;
begin
  if p_actor is null or not app.is_active() then
    raise exception 'no-session' using errcode = '42501';
  end if;

  -- الفاعل يجب أن يكون مالك المساحة أو مساعدًا يملك students:write
  if not (app.is_workspace_teacher(p_teacher_id) or app.assistant_has_full_scope(p_teacher_id, 'students:write')) then
    raise exception 'not-allowed' using errcode = '42501';
  end if;

  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'invalid-full-name' using errcode = '22023';
  end if;

  if v_code !~ '^[A-Z0-9]{2,10}$' then
    raise exception 'invalid-local-code' using errcode = '22023';
  end if;

  if v_phone is null and v_guardian is null then
    raise exception 'contact-required' using errcode = '22023';
  end if;

  if v_phone is not null and v_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'invalid-phone' using errcode = '22023';
  end if;

  if v_guardian is not null and v_guardian !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'invalid-guardian-phone' using errcode = '22023';
  end if;

  if v_notes is not null and char_length(v_notes) > 2000 then
    raise exception 'invalid-notes' using errcode = '22023';
  end if;

  if exists (
    select 1 from app.student_profiles sp
    where sp.teacher_id = p_teacher_id and sp.local_code = v_code
  ) then
    raise exception 'local-code-taken' using errcode = '23505';
  end if;

  if p_grade_id is not null and not exists (
    select 1 from public.grades g where g.id = p_grade_id and g.teacher_id = p_teacher_id
  ) then
    raise exception 'grade-not-in-workspace' using errcode = '42501';
  end if;

  insert into app.student_profiles (
    teacher_id, full_name, local_code, phone_e164, guardian_phone_e164, grade_id, notes, status, created_by
  )
  values (
    p_teacher_id, v_name, v_code, v_phone, v_guardian, p_grade_id, v_notes, 'pending_link', p_actor
  )
  returning id into v_id;

  return jsonb_build_object(
    'student_profile_id', v_id,
    'status', 'pending_link',
    'duplicates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'profile_id', d.profile_id,
        'full_name', d.full_name,
        'local_code', d.local_code,
        'status', d.status,
        'reason', d.reason
      ))
      from app.student_duplicate_hints(p_teacher_id, v_phone, v_guardian, v_name, v_id) d
    ), '[]'::jsonb)
  );
end;
$$;

comment on function app.student_register_local(uuid, uuid, text, text, text, text, uuid, text) is
  'تسجيل طالب محلي. يُرجع المعرّف ومرشّحي التكرار فقط — لا دمج تلقائي.';

-- ---------- ٤) دعوة ربط الطالب ----------
create or replace function app.student_create_link_invitation(
  p_actor uuid,
  p_student_profile_id uuid,
  p_token_hash text,
  p_ttl_hours integer default 168
)
returns jsonb
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_student app.student_profiles;
  v_id uuid;
begin
  if p_actor is null or not app.is_active() then
    raise exception 'no-session' using errcode = '42501';
  end if;

  select * into v_student from app.student_profiles where id = p_student_profile_id;
  if not found then
    raise exception 'student-not-found' using errcode = '42501';
  end if;

  if not (app.is_workspace_teacher(v_student.teacher_id) or app.assistant_has_full_scope(v_student.teacher_id, 'students:write')) then
    raise exception 'not-allowed' using errcode = '42501';
  end if;

  if v_student.status = 'active' then
    raise exception 'already-linked' using errcode = '23505';
  end if;

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid-token-hash' using errcode = '22023';
  end if;

  if p_ttl_hours is null or p_ttl_hours < 1 or p_ttl_hours > 168 then
    raise exception 'invalid-ttl' using errcode = '22023';
  end if;

  -- دعوة ربط سارية واحدة لكل طالب: إبطال السابقة قبل إنشاء جديدة
  update app.invitations i
     set revoked_at = now()
   where i.kind = 'student_link'
     and i.student_profile_id = p_student_profile_id
     and i.used_at is null
     and i.revoked_at is null;

  insert into app.invitations (
    kind, token_hash, teacher_id, student_profile_id, target_hint, created_by, expires_at
  )
  values (
    'student_link', p_token_hash, v_student.teacher_id, p_student_profile_id,
    coalesce(v_student.phone_e164, v_student.guardian_phone_e164),
    p_actor, now() + make_interval(hours => p_ttl_hours)
  )
  returning id into v_id;

  return jsonb_build_object(
    'invitation_id', v_id,
    'student_profile_id', p_student_profile_id,
    'expires_in_hours', p_ttl_hours
  );
end;
$$;

-- ---------- ٥) أغلفة الخدمة (service_role فقط) ----------
create or replace function public.svc_student_register(
  p_actor uuid, p_teacher_id uuid, p_full_name text, p_local_code text,
  p_phone text default null,
  p_guardian_phone text default null,
  p_grade_id uuid default null,
  p_notes text default null
)
returns jsonb
language sql
security definer
set search_path = app, public, pg_temp
as $$
  select app.student_register_local(p_actor, p_teacher_id, p_full_name, p_local_code,
                                    p_phone, p_guardian_phone, p_grade_id, p_notes);
$$;

create or replace function public.svc_student_link_invitation(
  p_actor uuid, p_student_profile_id uuid, p_token_hash text, p_ttl_hours integer default 168
)
returns jsonb
language sql
security definer
set search_path = app, public, pg_temp
as $$
  select app.student_create_link_invitation(p_actor, p_student_profile_id, p_token_hash, p_ttl_hours);
$$;

revoke all on function public.svc_student_register(uuid, uuid, text, text, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.svc_student_link_invitation(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.svc_student_register(uuid, uuid, text, text, text, text, uuid, text) to service_role;
grant execute on function public.svc_student_link_invitation(uuid, uuid, text, integer) to service_role;

-- لا تُمنح دوال app.* لأي دور عميل: تبقى داخل المخطط غير المكشوف.

commit;
