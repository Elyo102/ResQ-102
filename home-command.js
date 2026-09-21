import { assertPresentationOnly } from './role-view.js?v=42h27';

const ACTION_HREF = Object.freeze({
  open_document:'./hr.html', open_schedule_review:'./schedule-management.html',
  open_hr_reports:'./hr.html', open_maintenance:'./maintenance.html', open_fault:'./faults.html'
});
const ALLOWED_ROLES = Object.freeze(['firefighter','team_leader','deputy_team_leader','deputy','commander','station_commander','district_commander','hr_coordinator','super_admin']);
const COMMAND_ROLES = Object.freeze(['team_leader','deputy_team_leader','deputy','commander','station_commander']);
let active = null;

function text(value, max) { return String(value == null ? '' : value).trim().slice(0, max || 160); }
function count(value) { const n = Number(value); return Number.isSafeInteger(n) && n >= 0 ? n : 0; }
function roleOf(claims) {
  if (claims && claims.super === true) return 'super_admin';
  const role = text(claims && claims.role, 40);
  return ALLOWED_ROLES.includes(role) ? role : 'firefighter';
}
function roleCopy(role) {
  if (COMMAND_ROLES.includes(role)) return Object.freeze({
    family:'command', title:'מרכז המשמרת',
    intro:'מה דורש טיפול עכשיו, עדכוני התחנה והתמונה המבצעית של המשמרת.',
    eyebrow:'ניהול המשמרת', tasksTitle:'דורש טיפול',
    tasksText:'פעולות מבצעיות שממתינות לך לפי ההרשאה שלך.',
    empty:'אין כרגע פעולות שממתינות לטיפולך.', shiftTitle:'תמונה מבצעית'
  });
  if (role === 'hr_coordinator') return Object.freeze({
    family:'hr', title:'מרכז משאבי אנוש',
    intro:'דיווחים שממתינים לטיפול, עדכוני התחנה ותמונת מצב עדכנית.',
    eyebrow:'משאבי אנוש', tasksTitle:'דורש טיפול',
    tasksText:'דיווחים ופעולות שממתינים לך לפי ההרשאה שלך.',
    empty:'אין כרגע דיווחים שממתינים לטיפולך.', shiftTitle:'תמונת מצב'
  });
  if (role === 'super_admin' || role === 'district_commander') return Object.freeze({
    family:'admin', title:'תמונת מצב מערכת',
    intro:'משימות ניהול, עדכוני התחנה ותקלות שדורשות תשומת לב.',
    eyebrow:'ניהול ובקרה', tasksTitle:'דורש טיפול',
    tasksText:'פעולות ניהול שממתינות לך לפי ההרשאה שלך.',
    empty:'אין כרגע פעולות ניהול שממתינות לטיפולך.', shiftTitle:'תמונת מצב'
  });
  return Object.freeze({
    family:'member', title:'המשמרת שלי',
    intro:'מה דורש ממך טיפול, עדכוני התחנה ותקלות שחשוב להכיר.',
    eyebrow:'בשבילי היום', tasksTitle:'דורש ממני',
    tasksText:'משימות ופעולות אישיות שממתינות לך.',
    empty:'אין כרגע פעולות שממתינות לך. משמרת קלה!', shiftTitle:'מצב המשמרת'
  });
}
function applyRoleCopy(session) {
  const copy = roleCopy(session.role);
  session.elements.root.dataset.homeRoleFamily = copy.family;
  session.elements.title.textContent = copy.title;
  session.elements.intro.textContent = copy.intro;
  session.elements.tasksEyebrow.textContent = copy.eyebrow;
  session.elements.tasksTitle.textContent = copy.tasksTitle;
  session.elements.tasksText.textContent = copy.tasksText;
  session.elements.taskEmpty.textContent = copy.empty;
  session.elements.shiftTitle.textContent = copy.shiftTitle;
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
      const raw = shift[key];
      const known = available && Number.isSafeInteger(Number(raw)) && Number(raw) >= 0;
      const suffix = key === 'open_faults' && shift.partial === true ? '+' : '';
      session.elements.shiftMetrics[key].textContent = known ? String(count(raw)) + suffix : '—';
    }
  }
}

function loadHomeCommand(session) {
  const loadId = Number(session.loadId || 0) + 1;
  session.loadId = loadId;
  session.elements.tasks.setAttribute('aria-busy', 'true');
  session.elements.retry.classList.add('hide');
  session.elements.status.textContent = 'טוען את תמונת המשמרת…';
  return Promise.resolve(session.call({})).then((response) => {
    if (active !== session || session.loadId !== loadId) return;
    const data = response && response.data && typeof response.data === 'object' ? response.data : {};
    renderUrgent(session, data.urgent); renderTasks(session, data.tasks); renderShift(session, data.shift);
    session.elements.status.textContent = '';
    session.elements.tasks.setAttribute('aria-busy', 'false');
  }).catch(() => {
    if (active !== session || session.loadId !== loadId) return;
    renderUrgent(session, null); renderTasks(session, []); renderShift(session, null);
    session.elements.status.textContent = 'לא הצלחנו לטעון את המשימות כרגע. ההודעות והתקלות החיות ממשיכות לפעול.';
    session.elements.retry.classList.remove('hide');
    session.elements.tasks.setAttribute('aria-busy', 'false');
  });
}

export function destroyHomeCommand() {
  const prior = active; active = null;
  if (!prior) return;
  prior.loadId = Number(prior.loadId || 0) + 1;
  prior.elements.retry.removeEventListener('click', prior.retry);
  prior.elements.taskList.replaceChildren(); prior.elements.status.textContent = '';
  prior.elements.retry.classList.add('hide');
  prior.elements.tasks.setAttribute('aria-busy', 'false');
  prior.elements.urgent.classList.add('hide');
}
export function initHomeCommand(options) {
  destroyHomeCommand();
  const { functions, user, claims, presentation, sdk, elements } = options || {};
  if (!functions || !user || !text(user.uid, 128) || !sdk || typeof sdk.httpsCallable !== 'function' || !elements) throw new Error('home-command-invalid-options');
  const displayRole = claims && claims.super === true && assertPresentationOnly(presentation)
    ? presentation.role_id : roleOf(claims);
  const session = { uid:user.uid, role:displayRole, readOnly:assertPresentationOnly(presentation), elements,
    call:sdk.httpsCallable(functions, 'getHomeCommandCenter'), loadId:0 };
  session.retry = () => { if (active === session) loadHomeCommand(session); };
  active = session;
  applyRoleCopy(session);
  elements.retry.addEventListener('click', session.retry);
  loadHomeCommand(session);
  return Object.freeze({ destroy:() => { if (active === session) destroyHomeCommand(); } });
}
export const HOME_COMMAND_ACTION_HREF = ACTION_HREF;
