import { assertPresentationOnly } from './role-view.js?v=42h17';

const ACTION_HREF = Object.freeze({
  open_document:'./hr.html', open_schedule_review:'./schedule-management.html',
  open_hr_reports:'./hr.html', open_maintenance:'./maintenance.html', open_fault:'./faults.html'
});
const ALLOWED_ROLES = Object.freeze(['firefighter','team_leader','deputy_team_leader','deputy','commander','station_commander','district_commander','hr_coordinator','super_admin']);
let active = null;

function text(value, max) { return String(value == null ? '' : value).trim().slice(0, max || 160); }
function count(value) { const n = Number(value); return Number.isSafeInteger(n) && n >= 0 ? n : 0; }
function roleOf(claims) {
  if (claims && claims.super === true) return 'super_admin';
  const role = text(claims && claims.role, 40);
  return ALLOWED_ROLES.includes(role) ? role : 'firefighter';
}
function actionOf(value) {
  const action = value && typeof value === 'object' ? value : {};
  const type = text(action.type, 60);
  return Object.prototype.hasOwnProperty.call(ACTION_HREF, type)
    ? { type, id:text(action.id, 120), href:ACTION_HREF[type] } : null;
}
function taskOf(value) {
  if (!value || typeof value !== 'object') return null;
  const id = text(value.id, 120), title = text(value.title, 160), action = actionOf(value.action);
  const roles = Array.isArray(value.target_roles)
    ? value.target_roles.map((r) => text(r, 40)).filter((r) => ALLOWED_ROLES.includes(r)) : [];
  return id && title && action && roles.length ? {
    id, title, action, roles, summary:text(value.summary, 240), priority:value.priority === 'high' ? 'high' : 'normal'
  } : null;
}
function makeTask(task, readOnly) {
  const link = document.createElement('a');
  link.className = 'home-task-card';
  if (readOnly) {
    link.setAttribute('aria-disabled', 'true');
    link.title = 'תצוגה בלבד';
  } else link.href = task.action.href;
  link.dataset.homeTaskId = task.id; link.dataset.priority = task.priority;
  const copy = document.createElement('span');
  const title = document.createElement('strong'); title.textContent = task.title;
  const detail = document.createElement('small'); detail.textContent = task.summary;
  copy.append(title, detail);
  const arrow = document.createElement('b'); arrow.className = 'home-task-arrow';
  arrow.setAttribute('aria-hidden', 'true'); arrow.textContent = '‹';
  link.append(copy, arrow); return link;
}
function renderUrgent(session, value) {
  const urgent = value && typeof value === 'object' && value.severity === 'critical' ? value : null;
  session.elements.urgent.classList.toggle('hide', !urgent);
  session.elements.urgentTitle.textContent = urgent ? (text(urgent.title, 160) || 'תקלה קריטית פתוחה') : '';
  session.elements.urgentText.textContent = urgent ? text(urgent.summary, 240) : '';
  const action = urgent ? actionOf(urgent.action) : null;
  if (action && action.type === 'open_fault' && !session.readOnly) session.elements.urgentLink.href = action.href;
  else session.elements.urgentLink.removeAttribute('href');
}
function renderTasks(session, values) {
  const tasks = (Array.isArray(values) ? values : []).map(taskOf).filter(Boolean)
    .filter((task) => session.role === 'super_admin' || task.roles.includes(session.role));
  session.elements.taskList.replaceChildren(...tasks.map((task) => makeTask(task, session.readOnly)));
  session.elements.taskEmpty.classList.toggle('hide', tasks.length !== 0);
}
function renderShift(session, value) {
  const shift = value && typeof value === 'object' ? value : {};
  session.elements.shiftLabel.textContent = text(shift.label, 80) || 'המשמרת הנוכחית';
  const available = shift.available !== false;
  for (const key of ['on_duty','open_faults','missing']) {
    if (session.elements.shiftMetrics[key]) {
      const suffix = key === 'open_faults' && shift.partial === true ? '+' : '';
      session.elements.shiftMetrics[key].textContent = available ? String(count(shift[key])) + suffix : '—';
    }
  }
}

export function destroyHomeCommand() {
  const prior = active; active = null;
  if (!prior) return;
  prior.elements.taskList.replaceChildren(); prior.elements.status.textContent = '';
  prior.elements.urgent.classList.add('hide');
}
export function initHomeCommand(options) {
  destroyHomeCommand();
  const { functions, user, claims, presentation, sdk, elements } = options || {};
  if (!functions || !user || !text(user.uid, 128) || !sdk || typeof sdk.httpsCallable !== 'function' || !elements) throw new Error('home-command-invalid-options');
  const displayRole = claims && claims.super === true && assertPresentationOnly(presentation)
    ? presentation.role_id : roleOf(claims);
  const session = { uid:user.uid, role:displayRole, readOnly:assertPresentationOnly(presentation), elements }; active = session;
  elements.status.textContent = 'טוען את תמונת המשמרת…';
  const call = sdk.httpsCallable(functions, 'getHomeCommandCenter');
  Promise.resolve(call({})).then((response) => {
    if (active !== session) return;
    const data = response && response.data && typeof response.data === 'object' ? response.data : {};
    renderUrgent(session, data.urgent); renderTasks(session, data.tasks); renderShift(session, data.shift);
    elements.status.textContent = '';
  }).catch(() => {
    if (active !== session) return;
    renderUrgent(session, null); renderTasks(session, []); renderShift(session, null);
    elements.status.textContent = 'לא הצלחנו לטעון את המשימות כרגע. ההודעות והתקלות החיות ממשיכות לפעול.';
  });
  return Object.freeze({ destroy:() => { if (active === session) destroyHomeCommand(); } });
}
export const HOME_COMMAND_ACTION_HREF = ACTION_HREF;
