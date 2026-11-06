-- =====================================================================
--  0014 — المساعدون: دعوة، تفعيل/إيقاف، ومنح صلاحيات بنطاق مجموعات
--  ---------------------------------------------------------------------
--  المبدأ الحاكم:
--    • المدرس وحده يدير مساعديه وصلاحياتهم — لا مساعد يدعو مساعدًا ولا
--      يرفع صلاحية نفسه (كل الدوال تتحقق app.is_workspace_teacher).
--    • الصلاحية تُخزَّن كما هي في 0003 (action + scope_group_ids)؛ هذه المهاجرة
--      تضيف **مسارًا آمنًا** لكتابتها بدل الكتابة المباشرة من المتصفح.
--    • «مراجعة قبل الحفظ»: دالة معاينة تُرجع الفرق (يُضاف/يُسحب) دون كتابة؛
--      الواجهة تعرضه ثم تنادي الحفظ.
--    • الإيقاف/السحب يسري فورًا لأن كل سياسة RLS تقرأ حالة العضوية لحظيًا.
--    • كل تغيير حساس يُكتب في app.audit_events.
-- =====================================================================

begin;

-- ---------- ١) قائمة الأفعال المسموح بها ----------
create or replace function app.assistant_action_allowed(p_action text)
returns boolean
language sql
immutable
as $$
  select p_action in (
    'attendance:write', 'grades:read', 'grades:write', 'students:read', 'students:write',
    'groups:read', 'groups:write', 'lessons:read', 'exams:read', 'exams:write'
  );
$$;

comment on function app.assistant_action_allowed(text) is
  'مصدر واحد لقائمة الأفعال — مطابق لقيد app.assistant_permissions.action. أي إضافة تحتاج مهاجرة.';

-- ---------- ٢) تحقق النطاق: المجموعات يجب أن تكون لمساحة المدرس ----------
create or replace function app.assert_group_scope(p_teacher_id uuid, p_group_ids uuid[])
returns void
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_bad uuid;
begin
  if p_group_ids is null or cardinality(p_group_ids) = 0 then
    return;
  end if;

  select g.id into v_bad
  from unnest(p_group_ids) as g(id)
  left join public.groups gr on gr.id = g.id and gr.teacher_id = p_teacher_id
  where gr.id is null
  limit 1;

  if v_bad is not null then
    raise exception 'group-outside-workspace' using errcode = '42501';
  end if;
end;
$$;

-- ---------- ٣) معاينة الصلاحيات قبل الحفظ (بلا كتابة) ----------
create or replace function app.assistant_permissions_preview(
  p_actor uuid,
  p_membership_id uuid,
  p_permissions jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_member app.teacher_memberships;
  v_current jsonb;
  v_new jsonb;
begin
  select * into v_member from app.teacher_memberships where id = p_membership_id;
  if not found then
    raise exception 'membership-not-found' using errcode = '42501';
  end if;

  if not app.is_workspace_teacher(v_member.teacher_id) or p_actor <> auth.uid() then
    raise exception 'not-allowed' using errcode = '42501';
  end if;

  select coalesce(jsonb_object_agg(p.action, to_jsonb(p.scope_group_ids)), '{}'::jsonb)
    into v_current
  from app.assistant_permissions p
  where p.membership_id = p_membership_id;

  v_new := coalesce(p_permissions, '{}'::jsonb);

  return jsonb_build_object(
    'current', v_current,
    'proposed', v_new,
    'added', (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
              from jsonb_each(v_new) e(k, v)
              where not v_current ? e.k),
    'removed', (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
                from jsonb_each(v_current) e(k, v)
                where not v_new ? e.k),
    'changed', (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
                from jsonb_each(v_new) e(k, v)
                where v_current ? e.k and v_current -> e.k <> e.v)
  );
end;
$$;

comment on function app.assistant_permissions_preview(uuid, uuid, jsonb) is
  'فرق الصلاحيات المعروض للمدرس قبل الحفظ. لا يكتب شيئًا.';

-- ---------- ٤) حفظ الصلاحيات (استبدال كامل داخل معاملة) ----------
create or replace function app.assistant_set_permissions(
  p_actor uuid,
  p_membership_id uuid,
  p_permissions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_member app.teacher_memberships;
  v_key text;
  v_val jsonb;
  v_scope uuid[];
  v_count integer := 0;
begin
  if p_actor is null or not app.is_active() then
    raise exception 'no-session' using errcode = '42501';
  end if;

  select * into v_member from app.teacher_memberships where id = p_membership_id;
  if not found then
    raise exception 'membership-not-found' using errcode = '42501';
  end if;

  -- المدرس المالك فقط. المساعد لا يرفع صلاحية نفسه ولا غيره.
  if not app.is_workspace_teacher(v_member.teacher_id) then
    raise exception 'not-allowed' using errcode = '42501';
  end if;

  if v_member.role_in_workspace <> 'assistant' then
    raise exception 'not-an-assistant' using errcode = '22023';
  end if;

  if p_permissions is null or jsonb_typeof(p_permissions) <> 'object' then
    raise exception 'invalid-permissions' using errcode = '22023';
  end if;

  -- تحقق كامل قبل أي كتابة (لا كتابة جزئية عند خطأ).
  for v_key, v_val in select * from jsonb_each(p_permissions) loop
    if not app.assistant_action_allowed(v_key) then
      raise exception 'unknown-action:%', v_key using errcode = '22023';
    end if;

    if jsonb_typeof(v_val) <> 'array' then
      raise exception 'invalid-scope:%', v_key using errcode = '22023';
    end if;

    select coalesce(array_agg((x)::text::uuid), '{}'::uuid[])
      into v_scope
    from jsonb_array_elements_text(v_val) as x;

    perform app.assert_group_scope(v_member.teacher_id, v_scope);
  end loop;

  delete from app.assistant_permissions where membership_id = p_membership_id;

  for v_key, v_val in select * from jsonb_each(p_permissions) loop
    select coalesce(array_agg((x)::text::uuid), '{}'::uuid[])
      into v_scope
    from jsonb_array_elements_text(v_val) as x;

    insert into app.assistant_permissions (membership_id, action, scope_group_ids)
    values (p_membership_id, v_key, v_scope);

    v_count := v_count + 1;
  end loop;

  perform app.audit(
    'assistant.permissions.set', p_actor, v_member.teacher_id,
    'membership', p_membership_id, 'ok',
    jsonb_build_object('actions', p_permissions)
  );

  return jsonb_build_object('membership_id', p_membership_id, 'actions_count', v_count);
end;
$$;

-- ---------- ٥) دعوة مساعد ----------
create or replace function app.assistant_invite(
  p_actor uuid,
  p_teacher_id uuid,
  p_phone_e164 text,
  p_token_hash text,
  p_ttl_hours integer default 168,
  p_permissions jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_phone text := nullif(btrim(coalesce(p_phone_e164, '')), '');
  v_id uuid;
  v_existing uuid;
begin
  if p_actor is null or not app.is_active() then
    raise exception 'no-session' using errcode = '42501';
  end if;

  if not app.is_workspace_teacher(p_teacher_id) then
    raise exception 'not-allowed' using errcode = '42501';
  end if;

  if v_phone is null or v_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'invalid-phone' using errcode = '22023';
  end if;

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid-token-hash' using errcode = '22023';
  end if;

  if p_ttl_hours is null or p_ttl_hours < 1 or p_ttl_hours > 168 then
    raise exception 'invalid-ttl' using errcode = '22023';
  end if;

  -- مساعد نشط بنفس الرقم في هذه المساحة: لا دعوة ثانية.
  select m.id into v_existing
  from app.teacher_memberships m
  join app.profiles pr on pr.user_id = m.user_id
  where m.teacher_id = p_teacher_id
    and m.role_in_workspace = 'assistant'
    and m.status in ('active', 'invited')
    and pr.phone_e164 = v_phone
  limit 1;

  if v_existing is not null then
    raise exception 'assistant-already-member' using errcode = '23505';
  end if;

  -- دعوة سارية سابقة لنفس الرقم تُبطَل قبل الجديدة.
  update app.invitations i
     set revoked_at = now()
   where i.kind = 'assistant_invite'
     and i.teacher_id = p_teacher_id
     and i.target_hint = v_phone
     and i.used_at is null
     and i.revoked_at is null;

  insert into app.invitations (kind, token_hash, teacher_id, target_hint, created_by, expires_at, meta)
  values (
    'assistant_invite', p_token_hash, p_teacher_id, v_phone, p_actor,
    now() + make_interval(hours => p_ttl_hours),
    jsonb_build_object('permissions', coalesce(p_permissions, '{}'::jsonb))
  )
  returning id into v_id;

  perform app.audit(
    'assistant.invited', p_actor, p_teacher_id, 'invitation', v_id, 'ok',
    jsonb_build_object('phone_last4', right(v_phone, 4))
  );

  return jsonb_build_object('invitation_id', v_id, 'expires_in_hours', p_ttl_hours);
end;
$$;

-- ---------- ٦) قبول الدعوة: إنشاء العضوية + صلاحياتها الأولية ----------
create or replace function app.assistant_accept(
  p_token_hash text,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_inv app.invitations;
  v_membership uuid;
  v_perms jsonb;
begin
  if p_user_id is null then
    raise exception 'no-session' using errcode = '42501';
  end if;

  v_inv := app.consume_invitation(p_token_hash, 'assistant_invite'::app.invitation_kind, p_user_id);

  insert into app.teacher_memberships (teacher_id, user_id, role_in_workspace, status, created_by)
  values (v_inv.teacher_id, p_user_id, 'assistant', 'active', v_inv.created_by)
  on conflict (teacher_id, user_id) do update
    set status = 'active', updated_at = now()
  returning id into v_membership;

  v_perms := coalesce(v_inv.meta -> 'permissions', '{}'::jsonb);

  -- الصلاحيات الأولية تُكتب فقط إن كانت صالحة، وبنفس تحققات الحفظ.
  if v_perms <> '{}'::jsonb then
    declare
      v_key text;
      v_val jsonb;
      v_scope uuid[];
    begin
      for v_key, v_val in select * from jsonb_each(v_perms) loop
        if not app.assistant_action_allowed(v_key) then
          continue;
        end if;
        select coalesce(array_agg((x)::text::uuid), '{}'::uuid[])
          into v_scope
        from jsonb_array_elements_text(v_val) as x;
        perform app.assert_group_scope(v_inv.teacher_id, v_scope);
        insert into app.assistant_permissions (membership_id, action, scope_group_ids)
        values (v_membership, v_key, v_scope)
        on conflict (membership_id, action) do update set scope_group_ids = excluded.scope_group_ids;
      end loop;
    end;
  end if;

  perform app.audit('assistant.joined', p_user_id, v_inv.teacher_id, 'membership', v_membership, 'ok');

  return jsonb_build_object('membership_id', v_membership, 'teacher_id', v_inv.teacher_id);
end;
$$;

-- ---------- ٧) تفعيل/إيقاف/سحب ----------
create or replace function app.assistant_set_status(
  p_actor uuid,
  p_membership_id uuid,
  p_status text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_member app.teacher_memberships;
  v_from app.membership_status;
begin
  if p_actor is null or not app.is_active() then
    raise exception 'no-session' using errcode = '42501';
  end if;

  select * into v_member from app.teacher_memberships where id = p_membership_id;
  if not found then
    raise exception 'membership-not-found' using errcode = '42501';
  end if;

  if not app.is_workspace_teacher(v_member.teacher_id) then
    raise exception 'not-allowed' using errcode = '42501';
  end if;

  if v_member.role_in_workspace <> 'assistant' then
    raise exception 'not-an-assistant' using errcode = '22023';
  end if;

  if p_status not in ('active', 'suspended', 'revoked') then
    raise exception 'invalid-status' using errcode = '22023';
  end if;

  if p_status = 'revoked' and (p_reason is null or char_length(btrim(p_reason)) < 5) then
    raise exception 'reason-required' using errcode = '22023';
  end if;

  v_from := v_member.status;

  if v_from = p_status::app.membership_status then
    return jsonb_build_object('membership_id', p_membership_id, 'changed', false, 'status', p_status);
  end if;

  -- لا عودة من revoked: يُعاد الدعوة/الإنشاء بدل إحياء سجل مسحوب.
  if v_from = 'revoked' then
    raise exception 'cannot-revive-revoked' using errcode = '22023';
  end if;

  update app.teacher_memberships
     set status = p_status::app.membership_status, updated_at = now()
   where id = p_membership_id;

  perform app.audit(
    'assistant.status.' || p_status, p_actor, v_member.teacher_id, 'membership', p_membership_id, 'ok',
    jsonb_build_object('from', v_from, 'to', p_status, 'reason', p_reason)
  );

  return jsonb_build_object('membership_id', p_membership_id, 'changed', true, 'status', p_status);
end;
$$;

-- ---------- ٨) أغلفة الخدمة ----------
create or replace function public.svc_assistant_invite(p_actor uuid, p_teacher_id uuid, p_phone_e164 text, p_token_hash text, p_ttl_hours integer default 168, p_permissions jsonb default '{}'::jsonb)
returns jsonb language sql security definer set search_path = app, public, pg_temp
as $$ select app.assistant_invite(p_actor, p_teacher_id, p_phone_e164, p_token_hash, p_ttl_hours, p_permissions); $$;

create or replace function public.svc_assistant_accept(p_token_hash text, p_user_id uuid)
returns jsonb language sql security definer set search_path = app, public, pg_temp
as $$ select app.assistant_accept(p_token_hash, p_user_id); $$;

create or replace function public.svc_assistant_preview_permissions(p_actor uuid, p_membership_id uuid, p_permissions jsonb)
returns jsonb language sql stable security definer set search_path = app, public, pg_temp
as $$ select app.assistant_permissions_preview(p_actor, p_membership_id, p_permissions); $$;

create or replace function public.svc_assistant_set_permissions(p_actor uuid, p_membership_id uuid, p_permissions jsonb)
returns jsonb language sql security definer set search_path = app, public, pg_temp
as $$ select app.assistant_set_permissions(p_actor, p_membership_id, p_permissions); $$;

create or replace function public.svc_assistant_set_status(p_actor uuid, p_membership_id uuid, p_status text, p_reason text default null)
returns jsonb language sql security definer set search_path = app, public, pg_temp
as $$ select app.assistant_set_status(p_actor, p_membership_id, p_status, p_reason); $$;

revoke all on function public.svc_assistant_invite(uuid, uuid, text, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.svc_assistant_accept(text, uuid) from public, anon, authenticated;
revoke all on function public.svc_assistant_preview_permissions(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.svc_assistant_set_permissions(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.svc_assistant_set_status(uuid, uuid, text, text) from public, anon, authenticated;

grant execute on function public.svc_assistant_invite(uuid, uuid, text, text, integer, jsonb) to service_role;
grant execute on function public.svc_assistant_accept(text, uuid) to service_role;
grant execute on function public.svc_assistant_preview_permissions(uuid, uuid, jsonb) to service_role;
grant execute on function public.svc_assistant_set_permissions(uuid, uuid, jsonb) to service_role;
grant execute on function public.svc_assistant_set_status(uuid, uuid, text, text) to service_role;

-- مساعد لا يكتب صلاحياته بنفسه من المتصفح: لا منح كتابة على الجدول للعميل.
revoke insert, update, delete on app.assistant_permissions from authenticated;

commit;
