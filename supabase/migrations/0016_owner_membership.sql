-- =====================================================================
--  0016 — عضوية المالك في مساحته (إصلاح H-01 / H-02)
--  ---------------------------------------------------------------------
--  العيب المقيس في فحص ٠٤:
--    سياسات القراءة على public.locations/subjects/grades (0015) وعلى
--    public.groups (0005) تستخدم app.is_workspace_member(teacher_id)،
--    وهذه تقرأ app.teacher_memberships فقط. ولا يوجد في المستودع أي مسار
--    يُنشئ صف عضوية للمدرس المالك ⇒ المدرس لا يرى موارده (كل القوائم صفر)،
--    و`insert … returning` يفشل بـ42501 لأن RETURNING يخضع لسياسة SELECT.
--
--  الحل المختار: **الخيار (أ)** في برومبت الإصلاح — مطابق لـR-28:
--  «المدرسون أنفسهم لهم عضوية teacher داخل مساحتهم».
--    • تعبئة رجعية لكل المدرسين القائمين.
--    • مُشغِّل بعد الإدراج يضمن الصف لأي مسار يضيف مدرسًا لاحقًا
--      (بما فيه مسار الإدارة بمفتاح الخدمة).
--  لماذا (أ) وليس (ب): تعديل السياسات كان سيترك R-28 مخالفًا للواقع،
--  ويُبقي اختبارات العزل تعتمد صفوفًا مُصنَّعة يدويًا بدل بيانات حقيقية.
-- =====================================================================

begin;

-- ---------- ١) دالة الضمان (متكرّرة الاستدعاء، بلا أثر جانبي إن كان الصف قائمًا) ----------
create or replace function app.ensure_owner_membership(p_teacher_id uuid)
returns boolean
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_inserted boolean := false;
begin
  if p_teacher_id is null then
    return false;
  end if;

  -- المدرس هو ملف مستخدم؛ لا عضوية قبل وجود ملف (يمنع فشل FK في التعبئة).
  if not exists (select 1 from app.profiles p where p.user_id = p_teacher_id) then
    return false;
  end if;

  insert into app.teacher_memberships (teacher_id, user_id, role_in_workspace, status)
  values (p_teacher_id, p_teacher_id, 'teacher', 'active')
  on conflict on constraint teacher_memberships_unique do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;

  -- ملاحظة مقصودة: لا `do update`. إحياء عضوية مالك موقوفة/مسحوبة قرار
  -- إداري يحتاج مسارًا موثّقًا، ولا يجوز أن يحدث صامتًا من مُشغِّل.
end;
$$;

comment on function app.ensure_owner_membership(uuid) is
  'يضمن صف عضوية teacher نشط للمدرس المالك (R-28). لا يُحيي عضوية مسحوبة.';

-- ---------- ٢) مُشغِّل على app.teachers ----------
create or replace function app.teachers_owner_membership_tg()
returns trigger
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
begin
  perform app.ensure_owner_membership(new.teacher_id);
  return new;
end;
$$;

drop trigger if exists teachers_owner_membership on app.teachers;
create trigger teachers_owner_membership
  after insert on app.teachers
  for each row execute function app.teachers_owner_membership_tg();

-- ---------- ٣) تعبئة رجعية ----------
do $$
declare
  v_teacher uuid;
  v_added integer := 0;
begin
  for v_teacher in select teacher_id from app.teachers loop
    if app.ensure_owner_membership(v_teacher) then
      v_added := v_added + 1;
    end if;
  end loop;

  raise notice 'owner memberships added: %', v_added;
end;
$$;

-- ---------- ٤) تحقق مدمج: لا مدرس بلا عضوية مالك ----------
do $$
declare
  v_missing integer;
begin
  select count(*) into v_missing
  from app.teachers t
  where not exists (
    select 1 from app.teacher_memberships m
    where m.teacher_id = t.teacher_id
      and m.user_id = t.teacher_id
      and m.role_in_workspace = 'teacher'
      and m.status = 'active'
  );

  if v_missing > 0 then
    raise exception 'owner-membership-backfill-incomplete: %', v_missing;
  end if;
end;
$$;

commit;
