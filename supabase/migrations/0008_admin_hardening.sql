-- =====================================================================
-- 0008 — تقوية إدارة السوبر أدمن (نتائج فحص المرحلة ٠٣)
--
-- العيوب المُصلحة هنا:
--   F-28 (D-03-02، MEDIUM) — `app.admin_stats(p_actor)` دالة SECURITY DEFINER
--        كانت ممنوحة لـ`authenticated` وتثق بالهوية المارَّرة كوسيط:
--        أي مستخدم مصادق يعرف uuid السوبر أدمن يقرأ إحصاءات المنصة كاملة.
--        الإصلاح: سحب الدالة عن المتصفح، وإتاحة `app.admin_stats_self()` التي
--        تأخذ الهوية من `auth.uid()` وحده.
--   F-29 (D-03-04، LOW) — `audit_events` يمنع UPDATE/TRUNCATE بمُشغِّل، أما DELETE
--        فكان ممنوعًا بغياب سياسة RLS فقط (صفر صفوف بصمت). صار ممنوعًا بمُشغِّل.
--   F-30 (D-03-05، LOW) — **رُفض الإصلاح بعد التحقق، وهذا مقصود**:
--        `admin_invitations` يرد 42501 بينما بقية العروض ترد صفر صفوف. لسبب ذلك أن
--        `app.invitations` جدول يحمل `token_hash` وبلا أي منح أو سياسة لـauthenticated.
--        توحيد النمط كان يتطلب منح SELECT على جدول البصمات — أي توسيع السطح على
--        جدول حسّاس مقابل اتساق شكلي. الرفض الصريح (42501) أقوى من صفر صفوف،
--        فالقرار: نُبقي السلوك ونوثّق الفرق بدل توسيع المنح.
--
-- لا تغيير على أي عقد واجهة: `public.admin_overview` يبقى باسمه وأعمدته.
-- =====================================================================

begin;

-- ---------- ١) الإحصاءات: الهوية من الـJWT لا من الوسيط ----------
create or replace function app.admin_stats_self()
returns jsonb
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_actor app.profiles;
begin
  -- الهوية الوحيدة المقبولة: صاحب الجلسة. لا وسيط يمكن التلاعب به.
  v_actor := app.assert_active_super_admin(auth.uid());
  perform v_actor;

  return app.admin_stats(auth.uid());
end;
$$;

comment on function app.admin_stats_self() is
  'F-28: إحصاءات اللوحة لهوية الجلسة فقط. تمنع تمرير uuid أدمن آخر كوسيط.';

revoke all on function app.admin_stats_self() from public, anon;
grant execute on function app.admin_stats_self() to authenticated;

-- الدالة الأصلية تبقى للخادم وحده (تستدعيها الأغلفة والدالة أعلاه).
revoke all on function app.admin_stats(uuid) from public, anon, authenticated;
grant execute on function app.admin_stats(uuid) to service_role;

create or replace view public.admin_overview
with (security_invoker = true) as
select app.admin_stats_self() as stats
where app.is_super_admin();

comment on view public.admin_overview is
  'أرقام اللوحة مشتقة من صفوف حقيقية عبر app.admin_stats_self (هوية الجلسة). للمدرس: صفر صفوف.';

grant select on public.admin_overview to authenticated;

-- ---------- ٢) التدقيق: منع الحذف بمُشغِّل لا بغياب السياسة ----------
drop trigger if exists audit_events_no_delete on app.audit_events;
create trigger audit_events_no_delete
  before delete on app.audit_events
  for each row execute function app.prevent_audit_mutation();

-- ---------- ٣) F-30: لا تغيير على المنح (انظر رأس الملف) ----------
-- ---------- ٤) سجل المهاجرات ----------
insert into app.schema_meta (key, value)
values (
  'migrations_applied',
  '0001_extensions,0002_identity_profiles,0003_teacher_workspaces,0004_invitations_recovery,0005_rls_identity,0006_admin_audit_notifications,0007_rls_admin,0008_admin_hardening'
)
on conflict (key) do update set value = excluded.value, updated_at = now();

commit;
