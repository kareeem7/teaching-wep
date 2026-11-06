-- =====================================================================
--  0017 — مسارات ٠٤ الخادمية: عضوية المجموعات والتحويل والأرشفة
--  ---------------------------------------------------------------------
--  يسدّ عيوب الفحص H-04 و M-05:
--    • لا مسار خادمي يضيف/يسحب/يحوّل عضوية مجموعة مع حفظ التاريخ.
--    • لا مسار أرشفة للطالب/المكان/المادة/الصف/المجموعة.
--    • `0015` أعلن revoke على app.student_profiles ولم يُطبَّق ⇒ الكتابة
--      المباشرة من المتصفح تتجاوز تحققات 0013.
--
--  المبادئ:
--    ١. كل عملية عضوية **معاملة واحدة**: إغلاق (left_at) + فتح جديد + تدقيق.
--       لا حذف لصف تاريخي أبدًا.
--    ٢. النطاق يُفحص على الخادم: المدرس المالك، أو مساعد يملك
--       `groups:write` على **المجموعة المعنية** (لا على المساحة عمومًا).
--    ٣. الكتابة على ملفات الطلاب تُغلق أمام `authenticated`، وتبقى الأغلفة
--       `svc_*` لـservice_role فقط (تُستدعى من Edge Functions بعد تحقق الجلسة).
-- =====================================================================

begin;

-- ---------- ١) صلاحية الكتابة على مجموعة محددة ----------
create or replace function app.can_write_group(p_teacher_id uuid, p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select app.is_active() and (
    app.is_workspace_teacher(p_teacher_id)
    or app.assistant_can(p_teacher_id, 'groups:write', p_group_id)
  );
$$;

comment on function app.can_write_group(uuid, uuid) is
  'الكتابة على مجموعة بعينها: المدرس المالك أو مساعد بنطاق groups:write على نفس المجموعة.';

-- ---------- ٢) ضمان أن الطالب من مساحة المجموعة ----------
create or replace function app.assert_student_in_workspace(p_teacher_id uuid, p_student_profile_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
begin
  if not exists (
    select 1 from app.student_profiles sp
    where sp.id = p_student_profile_id and sp.teacher_id = p_teacher_id
  ) then
    raise exception 'student-outside-workspace' using errcode = '42501';
  end if;
end;
$$;

-- ---------- ٣) إضافة عضويات ----------
create or replace function app.group_member_add(
  p_actor uuid,
  p_group_id uuid,
  p_student_profile_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_group public.groups;
  v_id uuid;
  v_added integer := 0;
  v_skipped integer := 0;
begin
  if p_actor is null or not app.is_active() then
    raise exception 'no-session' using errcode = '42501';
  end if;

  select * into v_group from public.groups where id = p_group_id;
  if not found then
    raise exception 'group-not-found' using errcode = '22023';
  end if;

  if not app.can_write_group(v_group.teacher_id, p_group_id) then
    raise exception 'not-allowed' using errcode = '42501';
  end if;

  if p_student_profile_ids is null or cardinality(p_student_profile_ids) = 0 then
    raise exception 'no-students' using errcode = '22023';
  end if;

  foreach v_id in array p_student_profile_ids loop
    perform app.assert_student_in_workspace(v_group.teacher_id, v_id);

    -- العضوية السارية فريدة؛ الإضافة المتكررة تُعدّ تخطيًا لا خطأً.
    insert into public.group_memberships (group_id, student_profile_id)
    values (p_group_id, v_id)
    on conflict do nothing;

    if found then
      v_added := v_added + 1;
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  perform app.audit(
    'group.member.add', p_actor, v_group.teacher_id, 'group', p_group_id, 'ok',
    jsonb_build_object('added', v_added, 'skipped', v_skipped)
  );

  return jsonb_build_object('group_id', p_group_id, 'added', v_added, 'skipped', v_skipped);
end;
$$;

-- ---------- ٤) سحب عضوية (إغلاق بتاريخ، لا حذف) ----------
create or replace function app.group_member_remove(
  p_actor uuid,
  p_group_id uuid,
  p_student_profile_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_group public.groups;
  v_closed integer := 0;
begin
  if p_actor is null or not app.is_active() then
    raise exception 'no-session' using errcode = '42501';
  end if;

  select * into v_group from public.groups where id = p_group_id;
  if not found then
    raise exception 'group-not-found' using errcode = '22023';
  end if;

  if not app.can_write_group(v_group.teacher_id, p_group_id) then
    raise exception 'not-allowed' using errcode = '42501';
  end if;

  update public.group_memberships
     set left_at = now()
   where group_id = p_group_id
     and student_profile_id = p_student_profile_id
     and left_at is null;
  get diagnostics v_closed = row_count;

  if v_closed = 0 then
    raise exception 'membership-not-active' using errcode = '22023';
  end if;

  perform app.audit(
    'group.member.remove', p_actor, v_group.teacher_id, 'group', p_group_id, 'ok',
    jsonb_build_object('student_profile_id', p_student_profile_id)
  );

  return jsonb_build_object('group_id', p_group_id, 'closed', v_closed);
end;
$$;

-- ---------- ٥) تحويل: إغلاق القديم وفتح الجديد بلا محو التاريخ ----------
create or replace function app.group_member_transfer(
  p_actor uuid,
  p_student_profile_id uuid,
  p_to_group_ids uuid[],
  p_from_group_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_teacher uuid;
  v_to uuid[];
  v_from uuid[];
  v_target uuid;
  v_closed integer := 0;
  v_opened integer := 0;
begin
  if p_actor is null or not app.is_active() then
    raise exception 'no-session' using errcode = '42501';
  end if;

  if p_to_group_ids is null or cardinality(p_to_group_ids) = 0 then
    raise exception 'target-required' using errcode = '22023';
  end if;

  select sp.teacher_id into v_teacher from app.student_profiles sp where sp.id = p_student_profile_id;
  if v_teacher is null then
    raise exception 'student-not-found' using errcode = '22023';
  end if;

  -- النطاق: المدرس المالك، أو مساعد يملك groups:write على كل مجموعة هدف.
  if not app.is_workspace_teacher(v_teacher) then
    foreach v_target in array p_to_group_ids loop
      if not app.assistant_can(v_teacher, 'groups:write', v_target) then
        raise exception 'not-allowed' using errcode = '42501';
      end if;
    end loop;
  end if;

  -- كل مجموعات الهدف يجب أن تكون لمساحة الطالب نفسه.
  if exists (
    select 1 from unnest(p_to_group_ids) as g(id)
    left join public.groups gr on gr.id = g.id and gr.teacher_id = v_teacher
    where gr.id is null
  ) then
    raise exception 'group-outside-workspace' using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_to
  from unnest(p_to_group_ids) as x;

  -- العضويات المصدر: ما طُلب تحديده، أو كل الساري لهذا الطالب.
  if p_from_group_ids is null or cardinality(p_from_group_ids) = 0 then
    select coalesce(array_agg(gm.group_id), '{}'::uuid[]) into v_from
    from public.group_memberships gm
    where gm.student_profile_id = p_student_profile_id and gm.left_at is null;
  else
    select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_from
    from unnest(p_from_group_ids) as x;
  end if;

  -- ١. إغلاق المصادر غير الموجودة في الهدف (التاريخ يبقى).
  update public.group_memberships
     set left_at = now()
   where student_profile_id = p_student_profile_id
     and left_at is null
     and group_id = any (v_from)
     and not (group_id = any (v_to));
  get diagnostics v_closed = row_count;

  -- ٢. فتح الهدف غير الساري (لا يمسّ عضوية سارية قائمة).
  insert into public.group_memberships (group_id, student_profile_id)
  select g.id, p_student_profile_id
  from unnest(v_to) as g(id)
  where not exists (
    select 1 from public.group_memberships gm
    where gm.group_id = g.id and gm.student_profile_id = p_student_profile_id and gm.left_at is null
  )
  on conflict do nothing;
  get diagnostics v_opened = row_count;

  if v_closed = 0 and v_opened = 0 then
    raise exception 'transfer-noop' using errcode = '22023';
  end if;

  perform app.audit(
    'group.member.transfer', p_actor, v_teacher, 'student_profile', p_student_profile_id, 'ok',
    jsonb_build_object('closed', v_closed, 'opened', v_opened, 'to', v_to, 'from', v_from)
  );

  return jsonb_build_object('closed', v_closed, 'opened', v_opened, 'to', v_to);
end;
$$;

-- ---------- ٦) تعديل ملف الطالب (قائمة حقول بيضاء) ----------
create or replace function app.student_update(
  p_actor uuid,
  p_student_profile_id uuid,
  p_patch jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_sp app.student_profiles;
  v_key text;
  v_allowed text[] := array['full_name', 'local_code', 'phone_e164', 'guardian_phone_e164', 'notes', 'grade_id'];
  v_dups jsonb;
begin
  if p_actor is null or not app.is_active() then
    raise exception 'no-session' using errcode = '42501';
  end if;

  select * into v_sp from app.student_profiles where id = p_student_profile_id;
  if not found then
    raise exception 'student-not-found' using errcode = '22023';
  end if;

  if not (app.is_workspace_teacher(v_sp.teacher_id) or app.assistant_can_see_student(p_student_profile_id, 'students:write')) then
    raise exception 'not-allowed' using errcode = '42501';
  end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception 'empty-patch' using errcode = '22023';
  end if;

  for v_key in select jsonb_object_keys(p_patch) loop
    if not (v_key = any (v_allowed)) then
      raise exception 'field-not-allowed:%', v_key using errcode = '22023';
    end if;
  end loop;

  begin
    update app.student_profiles sp
       set full_name = coalesce(p_patch ->> 'full_name', sp.full_name),
           local_code = coalesce(p_patch ->> 'local_code', sp.local_code),
           phone_e164 = case when p_patch ? 'phone_e164' then nullif(p_patch ->> 'phone_e164', '') else sp.phone_e164 end,
           guardian_phone_e164 = case when p_patch ? 'guardian_phone_e164' then nullif(p_patch ->> 'guardian_phone_e164', '') else sp.guardian_phone_e164 end,
           notes = coalesce(p_patch ->> 'notes', sp.notes),
           grade_id = case when p_patch ? 'grade_id' then nullif(p_patch ->> 'grade_id', '')::uuid else sp.grade_id end
     where sp.id = p_student_profile_id
    returning * into v_sp;
  exception
    when unique_violation then
      raise exception 'local-code-taken' using errcode = '23505';
    when check_violation then
      raise exception 'invalid-field-value' using errcode = '22023';
    when foreign_key_violation then
      raise exception 'invalid-grade' using errcode = '22023';
  end;

  -- تنبيه تكرار بعد التعديل — لا دمج تلقائي أبدًا.
  v_dups := app.student_duplicate_hints(
    v_sp.teacher_id, v_sp.phone_e164, v_sp.guardian_phone_e164, v_sp.full_name, v_sp.id
  );

  perform app.audit(
    'student.update', p_actor, v_sp.teacher_id, 'student_profile', p_student_profile_id, 'ok',
    jsonb_build_object('fields', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(p_patch) as k))
  );

  return jsonb_build_object('student_profile_id', p_student_profile_id, 'duplicates', v_dups);
end;
$$;

-- ---------- ٧) أرشفة كيان (بالحالة، بلا حذف) ----------
create or replace function app.entity_archive(
  p_actor uuid,
  p_entity text,
  p_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_teacher uuid;
  v_changed integer := 0;
begin
  if p_actor is null or not app.is_active() then
    raise exception 'no-session' using errcode = '42501';
  end if;

  case p_entity
    when 'location' then
      select teacher_id into v_teacher from public.locations where id = p_id;
      if v_teacher is null then raise exception 'not-found' using errcode = '22023'; end if;
      if not (app.is_workspace_teacher(v_teacher) or app.assistant_has_full_scope(v_teacher, 'groups:write')) then
        raise exception 'not-allowed' using errcode = '42501';
      end if;
      update public.locations set status = 'archived' where id = p_id and status <> 'archived';
      get diagnostics v_changed = row_count;

    when 'subject' then
      select teacher_id into v_teacher from public.subjects where id = p_id;
      if v_teacher is null then raise exception 'not-found' using errcode = '22023'; end if;
      if not (app.is_workspace_teacher(v_teacher) or app.assistant_has_full_scope(v_teacher, 'groups:write')) then
        raise exception 'not-allowed' using errcode = '42501';
      end if;
      update public.subjects set status = 'archived' where id = p_id and status <> 'archived';
      get diagnostics v_changed = row_count;

    when 'grade' then
      select teacher_id into v_teacher from public.grades where id = p_id;
      if v_teacher is null then raise exception 'not-found' using errcode = '22023'; end if;
      if not (app.is_workspace_teacher(v_teacher) or app.assistant_has_full_scope(v_teacher, 'groups:write')) then
        raise exception 'not-allowed' using errcode = '42501';
      end if;
      update public.grades set status = 'archived' where id = p_id and status <> 'archived';
      get diagnostics v_changed = row_count;

    when 'group' then
      select teacher_id into v_teacher from public.groups where id = p_id;
      if v_teacher is null then raise exception 'not-found' using errcode = '22023'; end if;
      if not (app.is_workspace_teacher(v_teacher) or app.assistant_can(v_teacher, 'groups:write', p_id)) then
        raise exception 'not-allowed' using errcode = '42501';
      end if;
      -- الأرشفة تُغلق العضويات السارية في تاريخها، ولا تحذف أي صف.
      update public.group_memberships set left_at = now()
       where group_id = p_id and left_at is null;
      update public.groups set status = 'archived' where id = p_id and status <> 'archived';
      get diagnostics v_changed = row_count;

    when 'student' then
      select teacher_id into v_teacher from app.student_profiles where id = p_id;
      if v_teacher is null then raise exception 'not-found' using errcode = '22023'; end if;
      if not (app.is_workspace_teacher(v_teacher) or app.assistant_can_see_student(p_id, 'students:write')) then
        raise exception 'not-allowed' using errcode = '42501';
      end if;
      update app.student_profiles set status = 'archived'
       where id = p_id and status <> 'archived';
      get diagnostics v_changed = row_count;
      -- لا عضوية سارية لطالب مؤرشف.
      if v_changed > 0 then
        update public.group_memberships set left_at = now()
         where student_profile_id = p_id and left_at is null;
      end if;

    else
      raise exception 'unknown-entity:%', p_entity using errcode = '22023';
  end case;

  if v_changed = 0 then
    raise exception 'already-archived' using errcode = '22023';
  end if;

  perform app.audit(
    'entity.archive', p_actor, v_teacher, p_entity, p_id, 'ok',
    jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), ''))
  );

  return jsonb_build_object('entity', p_entity, 'id', p_id, 'status', 'archived');
end;
$$;

-- ---------- ٨) أغلفة service_role (نفس نمط 0013/0014) ----------
create or replace function public.svc_group_member_add(p_actor uuid, p_group_id uuid, p_student_profile_ids uuid[])
returns jsonb language sql security definer set search_path = app, public, pg_temp
as $$ select app.group_member_add(p_actor, p_group_id, p_student_profile_ids); $$;

create or replace function public.svc_group_member_remove(p_actor uuid, p_group_id uuid, p_student_profile_id uuid)
returns jsonb language sql security definer set search_path = app, public, pg_temp
as $$ select app.group_member_remove(p_actor, p_group_id, p_student_profile_id); $$;

create or replace function public.svc_group_member_transfer(p_actor uuid, p_student_profile_id uuid, p_to_group_ids uuid[], p_from_group_ids uuid[])
returns jsonb language sql security definer set search_path = app, public, pg_temp
as $$ select app.group_member_transfer(p_actor, p_student_profile_id, p_to_group_ids, p_from_group_ids); $$;

create or replace function public.svc_student_update(p_actor uuid, p_student_profile_id uuid, p_patch jsonb)
returns jsonb language sql security definer set search_path = app, public, pg_temp
as $$ select app.student_update(p_actor, p_student_profile_id, p_patch); $$;

create or replace function public.svc_entity_archive(p_actor uuid, p_entity text, p_id uuid, p_reason text)
returns jsonb language sql security definer set search_path = app, public, pg_temp
as $$ select app.entity_archive(p_actor, p_entity, p_id, p_reason); $$;

revoke all on function public.svc_group_member_add(uuid, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.svc_group_member_remove(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.svc_group_member_transfer(uuid, uuid, uuid[], uuid[]) from public, anon, authenticated;
revoke all on function public.svc_student_update(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.svc_entity_archive(uuid, text, uuid, text) from public, anon, authenticated;

grant execute on function public.svc_group_member_add(uuid, uuid, uuid[]) to service_role;
grant execute on function public.svc_group_member_remove(uuid, uuid, uuid) to service_role;
grant execute on function public.svc_group_member_transfer(uuid, uuid, uuid[], uuid[]) to service_role;
grant execute on function public.svc_student_update(uuid, uuid, jsonb) to service_role;
grant execute on function public.svc_entity_archive(uuid, text, uuid, text) to service_role;

-- ---------- ٩) إغلاق انحراف M-05 ----------
-- `0015` أعلن هذا السحب ولم يُطبَّق؛ الكتابة على ملفات الطلاب تمرّ الآن عبر
-- svc_student_* فقط (تحقق كامل + تدقيق)، لا من المتصفح مباشرة.
revoke insert, update, delete on app.student_profiles from authenticated;

commit;
