/**
 * اختيار المساحة وعزلها في المتصفح.
 *
 * تنبيه أمني: هذا الملف **واجهة** فقط. اختيار المساحة في المتصفح لا يمنح أي صلاحية؛
 * الصلاحيات تُفرض في RLS على `teacher_id` المأخوذ من الخادم، لا من قيمة هنا.
 * فائدته: تذكّر المساحة النشطة لعرضها، ومنع الخلط بين مدرسين في نفس الجلسة.
 */
import { callFunction, queryParam, setBusy, showFormError } from './api.js';

const STORAGE_KEY = 'minhaj.active-workspace';

/**
 * يحفظ المساحة النشطة مع هوية المستخدم — لا تُستخدم مساحة مستخدم لآخر.
 * @param {{userId: string, teacherId: string, role: string, teacherName?: string|null}} input
 */
export function setActiveWorkspace(input) {
  const payload = {
    user_id: input.userId,
    teacher_id: input.teacherId,
    role: input.role,
    teacher_name: input.teacherName ?? null,
    at: new Date().toISOString(),
  };
  globalThis.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  return payload;
}

/** @param {string} userId */
export function getActiveWorkspace(userId) {
  const raw = globalThis.sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.user_id !== userId || !parsed.teacher_id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearActiveWorkspace() {
  globalThis.sessionStorage.removeItem(STORAGE_KEY);
}

/**
 * هل هذه القائمة نفسها مساحة واحدة؟ (لا نُخفي الاختيار عندما يلزم)
 * @param {Array<{teacher_id: string}>} workspaces
 */
export function needsSelection(workspaces) {
  return Array.isArray(workspaces) && new Set(workspaces.map((item) => item.teacher_id)).size > 1;
}

/**
 * يرسم بطاقات المساحات في الحاوية. لا يثق بأي `href` قادم من الخادم.
 * @param {HTMLElement|null} container
 * @param {Array<{teacher_id: string, teacher_name?: string|null, role?: string, kind?: string}>} workspaces
 * @returns {HTMLElement[]}
 */
export function renderWorkspaceList(container, workspaces) {
  if (!container) return [];
  container.textContent = '';
  const cards = [];

  for (const workspace of workspaces ?? []) {
    const item = document.createElement('li');
    item.className = 'list-group-item d-flex justify-content-between align-items-center gap-2';
    item.dataset.teacherId = String(workspace.teacher_id ?? '');

    const label = document.createElement('span');
    label.textContent = workspace.teacher_name ?? 'مساحة مدرس';
    item.append(label);

    const role = document.createElement('span');
    role.className = 'badge text-bg-light';
    role.textContent = workspace.role === 'assistant'
      ? 'مساعد'
      : workspace.role === 'teacher' ? 'مدرس' : 'طالب';
    item.append(role);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-sm btn-mh-primary';
    button.textContent = 'دخول';
    button.dataset.action = 'choose-workspace';
    button.dataset.role = String(workspace.role ?? '');
    button.dataset.teacherName = String(workspace.teacher_name ?? '');
    item.append(button);

    container.append(item);
    cards.push(button);
  }

  return cards;
}

/**
 * تهيئة صفحة اختيار المساحة.
 * @param {{getSession?: () => Promise<{userId: string, token: string}|null>, call?: typeof callFunction}} [deps]
 */
export async function initSelectWorkspacePage(deps = {}) {
  const doc = globalThis.document;
  const list = doc.querySelector('[data-workspace-list]');
  const errorBox = doc.querySelector('[data-form-error]');
  const statusBox = doc.querySelector('[data-workspace-status]');
  const reloadButton = doc.querySelector('[data-action="reload-workspaces"]');

  const getSession = deps.getSession ?? (async () => null);
  const call = deps.call ?? callFunction;

  const session = await getSession();
  if (!session || !session.token) {
    // لا مساحات بلا جلسة: التحويل إلى الدخول بسبب واضح
    const next = encodeURIComponent(globalThis.location.pathname);
    globalThis.location.replace(`login.html?next=${next}&reason=no-session`);
    return { redirected: true };
  }

  async function load() {
    showFormError(errorBox, null);
    if (statusBox) statusBox.textContent = 'جارٍ تحميل مساحاتك…';
    if (reloadButton) setBusy(reloadButton, true, 'جارٍ التحميل…');

    try {
      const data = await call('workspace-select', { token: session.token });
      const workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
      renderWorkspaceList(list, workspaces);

      if (statusBox) {
        statusBox.textContent = workspaces.length === 0
          ? 'لا توجد مساحة مرتبطة بحسابك بعد. تواصل مع مدرسك أو الإدارة.'
          : `لديك ${workspaces.length} مساحة. اختر واحدة للمتابعة.`;
      }

      if (needsSelection(workspaces) === false && workspaces.length === 1) {
        const only = workspaces[0];
        setActiveWorkspace({
          userId: session.userId,
          teacherId: only.teacher_id,
          role: only.role ?? 'student',
          teacherName: only.teacher_name ?? null,
        });
      }

      return { redirected: false, workspaces };
    } catch (error) {
      if (statusBox) statusBox.textContent = '';
      showFormError(errorBox, error?.message ?? 'تعذّر تحميل المساحات.');
      return { redirected: false, workspaces: [], error };
    } finally {
      if (reloadButton) setBusy(reloadButton, false);
    }
  }

  if (list) {
    list.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('[data-action="choose-workspace"]') : null;
      if (!button) return;
      const container = button.closest('[data-teacher-id]');
      setActiveWorkspace({
        userId: session.userId,
        teacherId: container?.dataset?.teacherId ?? '',
        role: button.dataset.role ?? 'student',
        teacherName: button.dataset.teacherName ?? null,
      });
      const target = queryParam('next') ?? '../shared/app-shell.html';
      globalThis.location.assign(target);
    });
  }

  if (reloadButton) reloadButton.addEventListener('click', () => { void load(); });

  return load();
}
