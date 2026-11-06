-- =====================================================================
--  0015 — سياسات RLS للأماكن والمواد والصفوف والمواعيد، وتشديد نطاق المساعد
--  ---------------------------------------------------------------------
--  الجداول الأربعة أُنشئت في 0012 بـRLS مُفعَّلة وبلا سياسات (منع كامل).
--  هنا تُفتح بالقدر اللازم فقط:
--    • قراءة: عضو المساحة (مدرس أو مساعد نشط).
--    • كتابة: المدرس المالك، أو مساعد يملك groups:write **على كل المساحة**
--      (نطاق مجموعات محدود لا يخوّل إنشاء مكان/مادة/صف/موعد).
--    • السوبر أدمن: لا كتابة أكاديمية — القراءة الإدارية عبر العروض في 0007.
--    • الطالب: خارج كل هذه السياسات ⇒ صفر صفوف.
--
--  المواعيد تتبع المجموعة: قراءتها وكتابتها عبر صلاحية **تلك المجموعة**
--  (app.assistant_can بدعم scope_group_ids)، لا عبر صلاحية المساحة العامة.
-- =====================================================================

begin;

-- ---------- ١) الأماكن ----------
drop policy if exists locations_select_member on public.locations;
create policy locations_select_member on public.locations
  for select to authenticated
  using (app.is_workspace_member(teacher_id));

drop policy if exists locations_insert_teacher on public.locations;
create policy locations_insert_teacher on public.locations
  for insert to authenticated
  with check (
    app.is_workspace_teacher(teacher_id)
    or app.assistant_has_full_scope(teacher_id, 'groups:write')
  );

drop policy if exists locations_update_teacher on public.locations;
create policy locations_update_teacher on public.locations
  for update to authenticated
  using (
    app.is_workspace_teacher(teacher_id)
    or app.assistant_has_full_scope(teacher_id, 'groups:write')
  )
  with check (
    app.is_workspace_teacher(teacher_id)
    or app.assistant_has_full_scope(teacher_id, 'groups:write')
  );

-- ---------- ٢) المواد ----------
drop policy if exists subjects_select_member on public.subjects;
create policy subjects_select_member on public.subjects
  for select to authenticated
  using (app.is_workspace_member(teacher_id));

drop policy if exists subjects_insert_teacher on public.subjects;
create policy subjects_insert_teacher on public.subjects
  for insert to authenticated
  with check (
    app.is_workspace_teacher(teacher_id)
    or app.assistant_has_full_scope(teacher_id, 'groups:write')
  );

drop policy if exists subjects_update_teacher on public.subjects;
create policy subjects_update_teacher on public.subjects
  for update to authenticated
  using (
    app.is_workspace_teacher(teacher_id)
    or app.assistant_has_full_scope(teacher_id, 'groups:write')
  )
  with check (
    app.is_workspace_teacher(teacher_id)
    or app.assistant_has_full_scope(teacher_id, 'groups:write')
  );

-- ---------- ٣) الصفوف الدراسية ----------
drop policy if exists grades_select_member on public.grades;
create policy grades_select_member on public.grades
  for select to authenticated
  using (app.is_workspace_member(teacher_id));

drop policy if exists grades_insert_teacher on public.grades;
create policy grades_insert_teacher on public.grades
  for insert to authenticated
  with check (
    app.is_workspace_teacher(teacher_id)
    or app.assistant_has_full_scope(teacher_id, 'groups:write')
  );

drop policy if exists grades_update_teacher on public.grades;
create policy grades_update_teacher on public.grades
  for update to authenticated
  using (
    app.is_workspace_teacher(teacher_id)
    or app.assistant_has_full_scope(teacher_id, 'groups:write')
  )
  with check (
    app.is_workspace_teacher(teacher_id)
    or app.assistant_has_full_scope(teacher_id, 'groups:write')
  );

-- ---------- ٤) المواعيد: الصلاحية عبر المجموعة ----------
drop policy if exists schedule_slots_select on public.schedule_slots;
create policy schedule_slots_select on public.schedule_slots
  for select to authenticated
  using (
    exists (
      select 1 from public.groups g
      where g.id = public.schedule_slots.group_id
        and (
          app.is_workspace_teacher(g.teacher_id)
          or app.assistant_can(g.teacher_id, 'groups:read', g.id)
        )
    )
  );

drop policy if exists schedule_slots_write on public.schedule_slots;
create policy schedule_slots_write on public.schedule_slots
  for insert to authenticated
  with check (
    exists (
      select 1 from public.groups g
      where g.id = public.schedule_slots.group_id
        and (
          app.is_workspace_teacher(g.teacher_id)
          or app.assistant_can(g.teacher_id, 'groups:write', g.id)
        )
    )
  );

drop policy if exists schedule_slots_update on public.schedule_slots;
create policy schedule_slots_update on public.schedule_slots
  for update to authenticated
  using (
    exists (
      select 1 from public.groups g
      where g.id = public.schedule_slots.group_id
        and (
          app.is_workspace_teacher(g.teacher_id)
          or app.assistant_can(g.teacher_id, 'groups:write', g.id)
        )
    )
  )
  with check (
    exists (
      select 1 from public.groups g
      where g.id = public.schedule_slots.group_id
        and (
          app.is_workspace_teacher(g.teacher_id)
          or app.assistant_can(g.teacher_id, 'groups:write', g.id)
        )
    )
  );

drop policy if exists schedule_slots_delete on public.schedule_slots;
create policy schedule_slots_delete on public.schedule_slots
  for delete to authenticated
  using (
    exists (
      select 1 from public.groups g
      where g.id = public.schedule_slots.group_id
        and (
          app.is_workspace_teacher(g.teacher_id)
          or app.assistant_can(g.teacher_id, 'groups:write', g.id)
        )
    )
  );

-- ---------- ٥) ملاحظة منهجية موثّقة (لم يُطبَّق ما يلي) ----------
-- حاولت في المسودة الأولى إضافة سياسة `student_profiles_select_scope_strict`.
-- راجعتُها فوجدتها **لا تُشدِّد شيئًا**: سياسات Postgres التقييدية
-- (permissive) تتجمّع بـOR، فإضافة سياسة permissive جديدة تزيد الاستيعاب
-- لا تقلّله. التشديد الحقيقي يحتاج `as restrictive` أو حذف سياسة قائمة —
-- وكلاهما تغيير لسلوك 0005 المُختبَر، فلا يُفعل بلا قياس.
-- العزل الحالي لملفات الطلاب عبر `app.assistant_can_see_student` (F-02) وهو
-- مُثبت في `tests/sql/identity_rls.test.sql`. الحارس المضاف هنا: منع المساعد
-- من كتابة بياناته مباشرة (القسم ٦) وقياس النطاق في اختبارات ٠٤.

-- ---------- ٦) تأكيد أن المساعد لا يكتب صلاحياته ----------
revoke insert, update, delete on app.teacher_memberships from authenticated;
revoke insert, update, delete on app.student_profiles from authenticated;
-- (الكتابة تمر عبر الدوال/الأغلفة التي تتحقق من الدور، لا مباشرة من المتصفح)

commit;
