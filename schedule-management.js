import { firebaseConfig } from './firebase-config.js?v=42g0';
import { renderNav, renderStuckNav } from './nav.js?v=42g0';
import { initPWA } from './pwa.js?v=42g0';
import { initAppCheck } from './appcheck.js?v=42g0';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';

const app = initializeApp(firebaseConfig);
await initAppCheck(app);
const auth = getAuth(app);
const functions = getFunctions(app, 'europe-west1');
const call = Object.freeze({
  status: httpsCallable(functions, 'getScheduleRuntimeStatus'),
  setup: httpsCallable(functions, 'getScheduleManagerSetup'),
  modeOptions: httpsCallable(functions, 'getScheduleModeOptions'),
  modeSet: httpsCallable(functions, 'setScheduleRuntimeMode'),
  sourcePreview: httpsCallable(functions, 'previewScheduleSource'),
  sourceSave: httpsCallable(functions, 'saveScheduleSource'),
  policyPreview: httpsCallable(functions, 'previewSchedulePolicy'),
  policySave: httpsCallable(functions, 'saveSchedulePolicy'),
  run: httpsCallable(functions, 'runSchedulePlanner'),
  preview: httpsCallable(functions, 'getScheduleDraftPreview'),
  publish: httpsCallable(functions, 'publishSchedule'),
  rollback: httpsCallable(functions, 'rollbackSchedule'),
  mine: httpsCallable(functions, 'getMyScheduleV2'),
  range: httpsCallable(functions, 'getStationScheduleRange'),
  respond: httpsCallable(functions, 'respondToSchedule')
});

const $ = (id) => document.getElementById(id);
const state = {
  user: null, claims: {}, status: null, setup: null, draft: null,
  draftPreview: null, previewStart: null,
  // חוקי התחנה, כפי שהמסך אוסף אותם
  policy: null, policySub: null, policyDirty: false, policyBusy: false,
  // מצב המנוע — הרשאה נפרדת לגמרי מאחראי הסידור
  modeView: null, modeTarget: null, modeBusy: false,
  // יבוא מקור כוח האדם
  sourceTable: null, sourceMap: null, sourceActive: null,
  sourcePlan: null, sourceBusy: false,
  // הלוח
  month: null, range: null, rangeMonth: null, rangePending: null, mineOnly: false,
  tab: null, busy: false
};

renderStuckNav('');
initPWA({ offer: false });

const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const DOW = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
// ארבעה צבעים, במחזור. תחנה חמישית תקבל שוב את הראשון — וזה
// מוצהר, ולא תקלה שמישהו יגלה כשתיפתח תחנת קצה נוספת.
const SUB_CLASS = ['s1', 's2', 's3', 's4'];

function localDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).reduce((out, part) => {
    out[part.type] = part.value;
    return out;
  }, {});
  return parts.year + '-' + parts.month + '-' + parts.day;
}

function monthStart() { return localDate().slice(0, 7); }

function shiftDate(iso, amount) {
  const date = new Date(iso + 'T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function monthBounds(ym) {
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');
  return { from: ym + '-01', to: ym + '-' + pad(last) };
}

function shiftMonth(ym, amount) {
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(5, 7)) - 1 + amount;
  const date = new Date(Date.UTC(year, month, 1));
  return date.toISOString().slice(0, 7);
}

function requestId(prefix) {
  const id = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().replace(/-/g, '')
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
  return prefix + '_' + id;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function clear(element) { while (element.firstChild) element.removeChild(element.firstChild); }

function errorText(error) {
  const message = String((error && error.message) || 'הפעולה נכשלה.');
  return message.replace(/^Firebase:\s*/i, '').replace(/^\w+\/[^:]+:\s*/i, '');
}

function errorCode(error) {
  const details = error && error.details;
  return details && details.schedule_code ? String(details.schedule_code) : '';
}

function message(target, text, kind) {
  const box = typeof target === 'string' ? $(target) : target;
  clear(box);
  if (!text) return;
  box.appendChild(node('div', 'msg ' + (kind || 'info'), text));
}

function dateLabel(iso) {
  try {
    return new Intl.DateTimeFormat('he-IL', {
      timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'numeric'
    }).format(new Date(iso + 'T00:00:00.000Z'));
  } catch (_) { return iso; }
}

function canViewSchedule() {
  return !!state.status && ['off', 'shadow', 'new'].indexOf(state.status.mode) !== -1;
}

/* עריכה אינה נגזרת מהתפקיד הראשי. גם מפקד/ת או רכז/ת משאבי אנוש
 * צריכים מינוי חי ונפרד של אחראי/ת סידור.
 *
 * ⭐ P1-1 · שינוי מכוון מול הגרסה הקודמת.
 *
 * קודם, המסך חסם ניהול כשהמנוע `off`. התוצאה הייתה לולאה סגורה:
 * אי אפשר להעביר את המנוע ל-shadow בלי מדיניות ומקור תקינים
 * (`modeReadiness` טוען אותם בפועל), ואי אפשר היה להזין מדיניות
 * ומקור בלי שהמנוע כבר יהיה ב-shadow. תחנה חדשה לא יכלה להתחיל.
 *
 * לכן ההרשאה מפוצלת לשתיים:
 *   `canManageSchedule` — הזנת חוקי תחנה ומקור כוח אדם. מותרת בכל
 *     מצב, כולל `off`, כי היא **הכנה** ואינה משנה מה שאיש רואה.
 *   `canRunSchedule`    — הרצת מנוע, הכנה, פרסום וחזרה. אלה נשארות
 *     חסומות ב-`off` בדיוק כפי שהיו.
 *
 * השרת אינו סומך על ההפרדה הזאת: `runPlanner`, `getDraftPreview`
 * ו-`publish` אוכפים `requireMode` בעצמם. המסך רק מפסיק להסתיר
 * מסך שהשרת ממילא מרשה.
 */
function canManageSchedule() {
  return !!state.status && state.status.manager === true;
}

function canRunSchedule() {
  return canManageSchedule()
    && ['shadow', 'new'].indexOf(state.status.mode) !== -1;
}

function setMode(status) {
  const box = $('mode');
  box.className = 'mode';
  let text = 'לא ניתן לאמת את מצב מנוע הסידור.';
  if (status.mode === 'shadow') {
    text = 'מצב בדיקה: הסידור הקיים מוצג בקריאה מאובטחת. אפשר להכין טיוטות, אך הן אינן מתפרסמות.';
  } else if (status.mode === 'new') {
    box.classList.add('good');
    text = 'המנוע החדש פעיל. פרסום מחליף את הסידור הפעיל ושולח עדכון אישי.';
  } else if (status.mode === 'off') {
    text = 'הסידור הקיים מוצג בקריאה מאובטחת. מנוע הסידור החדש עדיין כבוי.';
  } else box.classList.add('bad');
  if (status.mode !== 'off' && !status.configured) {
    text += ' עדיין חסרים חוקי תחנה או מקור כוח-אדם חתום.';
  }
  if (status.manager && status.active && Number(status.active.delivery_alerts || 0) > 0) {
    box.classList.remove('good'); box.classList.add('bad');
    text += ' יש ' + status.active.delivery_alerts + ' התראות שלא נמסרו ודורשות טיפול.';
  }
  box.lastElementChild.textContent = text;
}

function hideScheduleViews() {
  $('manageView').hidden = true;
  $('mineView').hidden = true;
  $('stationView').hidden = true;
}

function showUnavailable(title, text) {
  hideScheduleViews();
  $('scheduleTabs').hidden = true;
  $('availabilityTitle').textContent = title;
  $('availabilityText').textContent = text;
  $('availabilityView').hidden = false;
}

function showScheduleViews() {
  $('availabilityView').hidden = true;
  $('scheduleTabs').hidden = false;
  $('mineTab').hidden = false;
  $('stationTab').hidden = false;
  $('manageTab').hidden = !canManageSchedule();
  updateRunAvailability();
  $('scheduleTabs').classList.remove('manage-only');
  $('scheduleTabs').classList.toggle('views-only', !canManageSchedule());
}

function chooseTab(name, replaceUrl = true) {
  // הסידור התחנתי הוא נקודת הכניסה המשותפת: כך כל כבאי רואה את
  // תמונת התחנה לפני שהוא עובר לסידור האישי. כתובת ניהול אינה דרך
  // לעקוף את המינוי החי של אחראי/ת הסידור.
  if (name === 'manage' && !canManageSchedule()) name = 'station';
  if (['manage', 'mine', 'station'].indexOf(name) === -1) name = 'station';
  state.tab = name;
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.classList.toggle('on', button.dataset.tab === name);
    button.setAttribute('aria-selected', button.dataset.tab === name ? 'true' : 'false');
  });
  $('manageView').hidden = name !== 'manage';
  $('mineView').hidden = name !== 'mine';
  $('stationView').hidden = name !== 'station';
  if (replaceUrl) {
    const url = new URL(location.href);
    url.searchParams.set('tab', name);
    history.replaceState(null, '', url);
  }
  if (name === 'mine') loadMineRange();
  if (name === 'station') loadStationRange();
}

/* ==================================================================
 *  יבוא מקור כוח האדם
 * ------------------------------------------------------------------
 *  ⭐ המסך אינו ניגש לגיליון. הוא מקבל הדבקה.
 *
 *  זו אינה עצלנות אלא הגבול הנכון: קריאה מהגיליון דורשת הרשאה
 *  מתמשכת לחשבון שמחזיק את רשימת כל אנשי התחנה, והמסך הזה לא
 *  צריך אותה כדי לעשות את עבודתו. העתק-הדבק הוא קריאה חד-פעמית
 *  שאדם ביצע במודע.
 *
 *  ⭐ ואין כאן ניחוש עמודות. שמות העמודות בגיליון אינם ידועים לי,
 *  ולכן האדם ממפה אותן — ורואה בדיוק אילו ערכים יש בעמודת „פעיל"
 *  לפני שהוא מחליט מה מהם משמעותו פעיל. „כן"/"TRUE"/"1" הם ניחוש
 *  שנראה עובד עד שתחנה אחת כותבת „פעילה".
 * ================================================================== */

const SOURCE_FIELDS = [
  { key: 'employee_number', label: 'מספר עובד', required: true },
  { key: 'full_name', label: 'שם', required: true },
  { key: 'sub_station', label: 'תחנת קצה', required: true },
  { key: 'roles', label: 'תפקידים', required: true },
  { key: 'active', label: 'פעיל', required: true }
];

// מפריד שדות: טאב כשהוא קיים (זה מה שגיליון מדביק), אחרת פסיק.
function splitLine(line) {
  return (line.indexOf('\t') !== -1 ? line.split('\t') : line.split(','))
    .map((cell) => cell.trim());
}

function parsePaste(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim().length);
  if (lines.length < 2) return null;
  const header = splitLine(lines[0]);
  const rows = [];
  for (let index = 1; index < lines.length; index++) {
    const cells = splitLine(lines[index]);
    // ⭐ מספר השורה הוא מספר השורה **בגיליון**, כולל הכותרת. זה
    // המספר שיופיע בדוח, וזה מה שמאפשר למצוא אותה שם.
    rows.push({ row: index + 1, cells });
  }
  return { header, rows };
}

function guessNothing(select, header) {
  clear(select);
  const none = node('option', '', '— לא ממופה —');
  none.value = '';
  select.appendChild(none);
  header.forEach((name, index) => {
    const item = node('option', '', name || ('עמודה ' + (index + 1)));
    item.value = String(index);
    select.appendChild(item);
  });
}

function renderSourceMap() {
  const box = $('sourceMap');
  const table = state.sourceTable;
  clear(box);
  box.hidden = !table;
  if (!table) return;
  SOURCE_FIELDS.forEach((field) => {
    const wrap = node('div');
    wrap.appendChild(node('label', '', field.label));
    const select = node('select');
    select.dataset.field = field.key;
    guessNothing(select, table.header);
    if (state.sourceMap && state.sourceMap[field.key] !== undefined
        && state.sourceMap[field.key] !== null) {
      select.value = String(state.sourceMap[field.key]);
    }
    select.addEventListener('change', () => {
      state.sourceMap = state.sourceMap || {};
      state.sourceMap[field.key] = select.value === '' ? null : Number(select.value);
      state.sourcePlan = null;
      renderSourceActive();
      updateSourceButtons();
    });
    wrap.appendChild(select);
    box.appendChild(wrap);
  });
}

// הערכים שבאמת יש בעמודה, ולא רשימה שהמצאתי.
function renderSourceActive() {
  const box = $('sourceActive');
  const list = $('sourceActiveValues');
  const column = state.sourceMap && state.sourceMap.active;
  clear(list);
  if (!state.sourceTable || column === null || column === undefined) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const values = [];
  state.sourceTable.rows.forEach((row) => {
    const value = (row.cells[column] === undefined ? '' : row.cells[column]).trim();
    if (values.indexOf(value) === -1) values.push(value);
  });
  values.sort();
  // ⭐ כל ערך שקיים בעמודה מקבל מצב מפורש. „לא סומן" הוא לא פעיל,
  // וזו סמנטיקה של תיבות סימון שאדם מבין — אבל רק בזכות זה שכל
  // הערכים מוצגים, עם כמה שורות בכל אחד. ערך שלא הוצג לא יכול
  // ליפול לצד הלא נכון בשקט, כי אין ערך שלא מוצג.
  state.sourceActive = state.sourceActive || {};
  values.forEach((value) => {
    state.sourceActive[value] = state.sourceActive[value] === true;
  });
  values.forEach((value) => {
    const label = node('label', 'actval');
    const input = node('input');
    input.type = 'checkbox';
    input.checked = state.sourceActive[value] === true;
    input.addEventListener('change', () => {
      state.sourceActive[value] = input.checked;
      state.sourcePlan = null;
      renderActiveSummary();
      updateSourceButtons();
    });
    label.appendChild(input);
    label.appendChild(node('code', '', value === '' ? '(ריק)' : value));
    const count = state.sourceTable.rows.filter((row) =>
      (row.cells[column] === undefined ? '' : row.cells[column]).trim() === value).length;
    label.appendChild(node('span', '', '· ' + count));
    list.appendChild(label);
  });

  // הפילוח נאמר במספרים לפני השליחה, כדי ש„סימנתי את הערך הלא
  // נכון" ייראה כאן ולא יתגלה כשחסרים אנשים בסידור. הוא מתעדכן
  // בכל סימון, ולא רק בציור הראשון.
  const summary = node('div', 'sub');
  summary.id = 'sourceActiveSummary';
  list.appendChild(summary);
  renderActiveSummary();
}

function renderActiveSummary() {
  const summary = $('sourceActiveSummary');
  const column = state.sourceMap && state.sourceMap.active;
  if (!summary || !state.sourceTable || column === null || column === undefined) return;
  const active = state.sourceTable.rows.filter((row) =>
    state.sourceActive[(row.cells[column] === undefined ? '' : row.cells[column]).trim()] === true);
  summary.textContent = 'לפי הסימון: ' + active.length + ' פעילים · '
    + (state.sourceTable.rows.length - active.length) + ' לא פעילים.';
}

// תוויות התפקידים ותחנות הקצה מחוקי התחנה, להתאמה **מדויקת**.
// אין כאן התאמה מקורבת: ערך שאינו תווית ואינו מזהה עובר כמות
// שהוא, והשרת דוחה אותו בקוד ברור.
function policyLookup() {
  const subs = {};
  const roles = {};
  if (state.policy) {
    Object.keys(state.policy.sub_stations).forEach((id) => {
      const sub = state.policy.sub_stations[id];
      subs[id] = id;
      if (sub.label) subs[sub.label] = id;
      sub.requirements.forEach((item) => {
        roles[item.role] = item.role;
        if (item.label) roles[item.label] = item.role;
      });
    });
  }
  return { subs, roles };
}

function sourceRowsForServer() {
  const table = state.sourceTable;
  const map = state.sourceMap || {};
  if (!table) return null;
  const look = policyLookup();
  const cell = (row, key) => {
    const index = map[key];
    if (index === null || index === undefined) return '';
    return (row.cells[index] === undefined ? '' : row.cells[index]).trim();
  };
  return table.rows.map((row) => {
    const rawActive = cell(row, 'active');
    const rawRoles = cell(row, 'roles');
    return {
      row: row.row,
      employee_number: cell(row, 'employee_number'),
      full_name: cell(row, 'full_name'),
      sub_station: look.subs[cell(row, 'sub_station')] || cell(row, 'sub_station'),
      // ⭐ „פעיל" הוא בוליאני מפורש שהאדם סיווג. ערך שלא סומן אינו
      // הופך ל-false בשקט — הוא נשלח כלא-בוליאני, והשרת דוחה אותו.
      active: state.sourceActive
        && Object.prototype.hasOwnProperty.call(state.sourceActive, rawActive)
        ? state.sourceActive[rawActive] === true : null,
      roles: rawRoles.split(/[,;|]/).map((value) => value.trim()).filter(Boolean)
        .map((value) => look.roles[value] || value)
    };
  });
}

function updateSourceButtons() {
  const table = state.sourceTable;
  const map = state.sourceMap || {};
  const mapped = SOURCE_FIELDS.every((field) =>
    map[field.key] !== null && map[field.key] !== undefined);
  // מקור שכולו לא פעיל אינו מקור; אין טעם לשלוח אותו לשרת.
  const anyActive = !!state.sourceActive
    && Object.keys(state.sourceActive).some((key) => state.sourceActive[key] === true);
  $('sourceCheck').disabled = state.sourceBusy || !table || !mapped || !anyActive;
  const plan = state.sourcePlan;
  const needsAccept = !!plan && plan.report && plan.report.rejected > 0;
  $('sourceSave').disabled = state.sourceBusy || !plan || plan.blocked === true
    || (needsAccept && !$('sourceAccept').checked);
}

function renderSourceReport(report, blockedCode) {
  const counts = $('sourceCounts');
  clear(counts);
  counts.hidden = !report;
  if (!report) {
    $('sourceReportWrap').hidden = true;
    $('sourceAcceptWrap').hidden = true;
    return;
  }
  [['נקראו', report.total, false], ['ייכנסו למקור', report.accepted, false],
    ['לא ייכנסו', report.rejected, report.rejected > 0]].forEach(([label, value, bad]) => {
    const box = node('div', 'count' + (bad ? ' bad' : ''));
    box.append(node('b', '', value), node('span', '', label));
    counts.appendChild(box);
  });

  const body = $('sourceReport');
  clear(body);
  (report.rows || []).forEach((item) => {
    const tr = node('tr');
    const n = node('td', 'n', item.row);
    tr.append(n, node('td', '', item.text || item.code));
    const code = node('td');
    code.appendChild(node('code', '', item.code));
    tr.appendChild(code);
    body.appendChild(tr);
  });
  $('sourceReportWrap').hidden = !(report.rows || []).length;

  // ⭐ האישור נוקב במספר. אי אפשר לאשר „בערך" — וזה גם מה שנשלח
  // לשרת, שמשווה אותו למספר האמיתי.
  const wrap = $('sourceAcceptWrap');
  wrap.hidden = !(report.rejected > 0) || blockedCode === 'source-author-empty-result';
  if (!wrap.hidden) {
    $('sourceAcceptText').textContent =
      'ראיתי ש-' + report.rejected + ' שורות לא ייכנסו למקור, ואני מאשר/ת. '
      + 'כל אחת מהן היא אדם שהמנוע לא ישבץ.';
  }
}

async function checkSource() {
  if (state.sourceBusy) return;
  const rows = sourceRowsForServer();
  if (!rows) return;
  state.sourceBusy = true;
  state.sourcePlan = null;
  $('sourceAccept').checked = false;
  updateSourceButtons();
  message('sourceMessage', 'בודק את הרשימה מול חוקי התחנה…', 'info');
  try {
    const result = (await call.sourcePreview({ rows })).data;
    state.sourcePlan = result;
    renderSourceReport(result.report, result.code);
    if (result.blocked) {
      message('sourceMessage', result.message, 'warn');
    } else if (result.kind === 'unchanged') {
      message('sourceMessage', 'הרשימה זהה למקור השמור. אין מה לשמור.', 'ok');
    } else {
      message('sourceMessage',
        result.counts.people + ' אנשים ייכנסו למקור, כמהדורה ' + result.revision + '.', 'ok');
    }
  } catch (error) {
    renderSourceReport(null);
    message('sourceMessage', errorText(error), 'err');
  } finally {
    state.sourceBusy = false;
    updateSourceButtons();
  }
}

/* ⭐ P0-1. יבוא סגל אינו נוגע בזמינות, בנעילות ובאירועים — הם עוברים
 * מהמקור הפעיל. מה שכן יוצא הוא רשומות של אנשים שאינם ברשימה החדשה,
 * והמספר הזה חייב להיאמר לרכזת **לפני** השמירה ולא להתגלות אחריה. */
function droppedCount(plan) {
  const dropped = plan && plan.carried_dropped;
  if (!dropped) return 0;
  return (dropped.availability || 0) + (dropped.locked || 0);
}

async function saveSource() {
  if (state.sourceBusy || !state.sourcePlan || state.sourcePlan.blocked) return;
  const rows = sourceRowsForServer();
  const rejected = state.sourcePlan.report ? state.sourcePlan.report.rejected : 0;
  if (rejected > 0 && !$('sourceAccept').checked) return;
  const dropped = droppedCount(state.sourcePlan);
  /* ⭐ P1-4. אנשים פעילים בתחנה שאינם בגיליון פשוט לא ישובצו. זה
   * המספר שחייב להיאמר בקול לפני ההפעלה, ולא להתגלות בעוד חודש. */
  const missing = Number(state.sourcePlan.missing_staff || 0);
  if (!confirm('לשמור את המקור? ' + state.sourcePlan.counts.people
    + ' אנשים ייכנסו, ו-' + rejected + ' שורות לא. '
    + (missing
      ? '⚠ ' + missing + ' אנשים פעילים בתחנה אינם בגיליון כלל, ולכן לא '
        + 'ישובצו. '
      : '')
    + (dropped
      ? '⚠ ' + dropped + ' רשומות של זמינות או נעילה שייכות לאנשים שאינם '
        + 'ברשימה החדשה, והן ייצאו מהמקור. '
      : 'זמינות, נעילות ואירועים נשמרים כפי שהם. ')
    + 'שמירת מקור אינה משנה סידור שפורסם ואינה שולחת הודעה.')) return;
  state.sourceBusy = true;
  updateSourceButtons();
  message('sourceMessage', 'שומר את המקור…', 'info');
  try {
    const result = (await call.sourceSave({
      request_id: requestId('source'),
      rows,
      activate: true,
      expected_source_id: state.sourcePlan.active_source_id,
      accept_rejected: rejected > 0 ? rejected : undefined,
      accept_carry_dropped: dropped > 0 ? dropped : undefined,
      accept_missing: missing > 0 ? missing : undefined
    })).data;
    message('sourceMessage', result.written
      ? 'המקור נשמר כמהדורה ' + result.revision + ' עם ' + result.counts.people + ' אנשים.'
        + (result.activated ? ' הוא המקור הפעיל.' : '')
      : 'המקור לא השתנה.', 'ok');
    state.sourcePlan = null;
    $('sourceAccept').checked = false;
    renderSourceReport(null);
    await loadSetup();
    await loadModeOptions();
    state.status = (await call.status({})).data;
    setMode(state.status);
  } catch (error) {
    message('sourceMessage', errorText(error), 'err');
  } finally {
    state.sourceBusy = false;
    updateSourceButtons();
  }
}

function renderSourceSummary() {
  const setup = state.setup;
  $('sourceSummaryLine').textContent = setup && setup.source
    ? 'מקור פעיל · גרסה ' + setup.source.version + ' · מהדורה ' + setup.source.revision
      + ((setup.people || []).length ? ' · ' + setup.people.length + ' אנשים פעילים' : '')
    : 'אין מקור כוח-אדם פעיל. בלעדיו המנוע אינו יכול לתכנן.';
}

/* ==================================================================
 *  מצב מנוע הסידור · המתג
 * ------------------------------------------------------------------
 *  ⭐ הכרטיס הזה אינו שייך לאחראי/ת הסידור.
 *
 *  עריכה, שיבוץ, הרצה ופרסום — מינוי אחראי/ת סידור. הזזת מצב
 *  המנוע משנה את מה שכל התחנה רואה, והיא שייכת לפיקוד. המסך אינו
 *  מחליט מי רשאי: הוא שואל את השרת ומציג את מה שהשרת אמר.
 * ================================================================== */

const MODE_LABEL = { off: 'כבוי', shadow: 'בדיקה', new: 'פעיל' };

function renderModeCard() {
  const view = state.modeView;
  const card = $('modeCard');
  if (!view || view.may_change !== true) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const now = $('modeNow');
  now.textContent = MODE_LABEL[view.current] || view.current || '—';
  now.classList.toggle('on', view.current === 'new');

  $('modeHelp').textContent = view.current === 'off'
    ? 'המנוע כבוי. מצב הבדיקה מריץ אותו בלי לשנות סידור פעיל ובלי לשלוח הודעה לאיש — '
      + 'וזה המקום היחיד לראות מה הוא היה מייצר לפני שמישהו מקבל את התוצאה כסידור שלו.'
    : (view.current === 'shadow'
      ? 'מצב בדיקה. אפשר להכין טיוטות ולראות מה המנוע מייצר; פרסום אינו אפשרי, ואיש אינו מקבל הודעה.'
      : 'המנוע פעיל. פרסום מחליף את הסידור הפעיל ושולח עדכון אישי.');

  const box = $('modeTargets');
  clear(box);
  (view.targets || []).forEach((target) => {
    const button = node('button', 'pill',
      'העבר ל' + (target.label || target.to));
    button.type = 'button';
    button.disabled = target.available !== true;
    button.setAttribute('aria-pressed', state.modeTarget === target.to ? 'true' : 'false');
    if (target.available !== true) {
      button.title = target.blocked_by === 'not_ready'
        ? 'חסרים חוקי תחנה או מקור כוח-אדם' : 'אין הרשאה';
    }
    button.addEventListener('click', () => {
      state.modeTarget = state.modeTarget === target.to ? null : target.to;
      $('modeConfirm').value = '';
      clear($('modeMessage'));
      renderModeCard();
    });
    box.appendChild(button);
  });

  // מה חסר נאמר, ולא מוסתר מאחורי כפתור מעומעם.
  if (view.ready === false && (view.readiness || null)) {
    const missing = [];
    if (view.readiness.policy !== true) missing.push('חוקי תחנה');
    if (view.readiness.source !== true) missing.push('מקור כוח-אדם חתום');
    if (view.readiness.policy === true && view.readiness.source === true
        && !(view.readiness.people > 0)) missing.push('אנשים במקור');
    if (missing.length) {
      const detail = (view.readiness.problems || []).length
        ? ' הקריאה נכשלה בקוד: ' + view.readiness.problems.join(', ') + '.' : '';
      box.appendChild(node('div', 'sub', 'כדי להפעיל חסרים: ' + missing.join(' · ') + '.' + detail));
    }
  }

  const form = $('modeForm');
  form.hidden = !state.modeTarget;
  if (state.modeTarget) {
    $('modeConfirmHint').textContent =
      'כדי לאשר, הקלד/י בדיוק: ' + state.modeTarget
      + ' — ההקלדה נשמרת ביומן יחד עם מי ביקש/ה, מתי ומאיזה מצב.';
    $('modeApply').textContent = 'העבר את המנוע ל' + (MODE_LABEL[state.modeTarget] || state.modeTarget);
  }
  updateModeApply();
}

function updateModeApply() {
  const ready = !!state.modeTarget
    && $('modeConfirm').value.trim() === state.modeTarget
    && !!$('modeReason').value;
  $('modeApply').disabled = state.modeBusy || !ready;
}

async function loadModeOptions() {
  try {
    state.modeView = (await call.modeOptions({})).data;
  } catch (error) {
    // כשל בקריאת האפשרויות אינו מסתיר את המסך ואינו ממציא הרשאה.
    state.modeView = null;
  }
  renderModeCard();
}

async function applyModeChange() {
  if (state.modeBusy || !state.modeTarget || !state.modeView) return;
  const target = state.modeTarget;
  const from = state.modeView.current;
  const text = target === 'off'
    ? 'לכבות את מנוע הסידור? התחנה תחזור להצגת הסידור הקיים.'
    : 'להעביר את מנוע הסידור ל„' + (MODE_LABEL[target] || target) + '"? '
      + (target === 'new' ? 'מרגע זה פרסום יחליף את הסידור הפעיל וישלח עדכונים אישיים.'
        : 'זהו מצב בדיקה: אפשר להכין טיוטות, ואיש אינו מקבל הודעה.');
  if (!confirm(text)) return;
  state.modeBusy = true;
  updateModeApply();
  message('modeMessage', 'משנה את מצב המנוע…', 'info');
  try {
    const result = (await call.modeSet({
      request_id: requestId('mode'),
      target,
      confirmation: $('modeConfirm').value.trim(),
      reason_code: $('modeReason').value,
      expected_mode: from
    })).data;
    message('modeMessage', result.changed
      ? 'מצב המנוע שונה מ„' + (MODE_LABEL[result.from] || result.from)
        + '" ל„' + (MODE_LABEL[result.to] || result.to) + '".'
        + (result.duplicate ? ' (הבקשה הזאת כבר בוצעה קודם.)' : '')
      : 'המנוע כבר היה במצב הזה. שום דבר לא השתנה.', 'ok');
    state.modeTarget = null;
    $('modeConfirm').value = '';
    $('modeReason').value = '';
    // המצב השתנה — כל מה שנגזר ממנו נטען מחדש מהשרת.
    state.status = (await call.status({})).data;
    setMode(state.status);
    invalidateRange();
    showScheduleViews();
    await loadModeOptions();
    await loadSetup();
    if (state.tab === 'station') await loadStationRange();
    if (state.tab === 'mine') await loadMineRange();
    setRollbackAvailability();
    updatePublishAvailability();
  } catch (error) {
    message('modeMessage', errorText(error), 'err');
  } finally {
    state.modeBusy = false;
    renderModeCard();
  }
}

/* ==================================================================
 *  הלוח · רצועת חודש
 * ------------------------------------------------------------------
 *  עמודה ליום, שורה לתחנת קצה, וגלילה שנתפסת לתחילת שבוע. רוחב
 *  היום נגזר מהמסך כך ששבוע שלם ייכנס בגלילה אחת כשיש מקום, ולא
 *  מספר קבוע שנראה טוב על מסך אחד ורע על כל השאר.
 * ================================================================== */

function subClass(index) { return SUB_CLASS[index % SUB_CLASS.length]; }

/**
 * ⭐ קריאה אחת לחודש, לשתי הלשוניות.
 *
 * „סידור התחנה" ו„הסידור שלי" מציגים את אותו חודש בדיוק — האישי
 * הוא אותו לוח מסונן לתחנת הקצה של האדם. קריאה נפרדת לכל לשונית
 * הייתה קוראת פעמיים את אותה תמונה חתומה, והקריאה הזאת אינה
 * זולה: היא קוראת את התמונה **בשלמותה** כדי לאמת את חתימתה.
 *
 * המטמון מוחלף בכל החלפת חודש, ומתאפס בפרסום ובחזרה לאחור.
 */
function invalidateRange() { state.range = null; state.rangeMonth = null; state.rangePending = null; }

function fetchRange(ym) {
  if (state.rangeMonth === ym && state.range) return Promise.resolve(state.range);
  if (state.rangeMonth === ym && state.rangePending) return state.rangePending;
  const bounds = monthBounds(ym);
  state.rangeMonth = ym;
  state.range = null;
  state.rangePending = call.range({ from: bounds.from, to: bounds.to }).then((result) => {
    if (state.rangeMonth !== ym) return result.data;
    state.range = result.data;
    state.rangePending = null;
    return result.data;
  }, (error) => {
    if (state.rangeMonth === ym) { state.rangeMonth = null; state.rangePending = null; }
    throw error;
  });
  return state.rangePending;
}

// כשל בקריאת אבטחות אינו הופך לוח לריק ואינו נראה כמו „אין
// אבטחות". הוא נאמר.
function guardsNotice(days) {
  const broken = (days || []).some((day) => day.guards_status === 'unavailable');
  return broken ? ' לא ניתן לטעון אבטחות כרגע. הסידור נשאר מוצג.' : '';
}

function isWeekend(iso) {
  const dow = new Date(iso + 'T00:00:00.000Z').getUTCDay();
  return dow === 5 || dow === 6;
}

// סדר תחנות הקצה נקבע ממדיניות התחנה כשהיא קיימת, כדי שהצבע של
// „תמנע" לא יתחלף בין יום ליום רק מפני שביום אחד לא היה שם איש.
function subOrder(days) {
  const fromPolicy = state.policy
    ? Object.keys(state.policy.sub_stations)
    : [];
  const seen = [];
  fromPolicy.forEach((id) => seen.push(id));
  (days || []).forEach((day) => (day.sub_stations || []).forEach((sub) => {
    if (seen.indexOf(sub.sub_station) === -1) seen.push(sub.sub_station);
  }));
  const labels = new Map();
  (days || []).forEach((day) => (day.sub_stations || []).forEach((sub) => {
    if (!labels.has(sub.sub_station)) labels.set(sub.sub_station, sub.label || sub.sub_station);
  }));
  if (state.policy) {
    Object.keys(state.policy.sub_stations).forEach((id) => {
      if (!labels.has(id)) labels.set(id, state.policy.sub_stations[id].label || id);
    });
  }
  return seen.map((id) => ({
    id,
    label: labels.get(id) || id,
    minimum: state.policy && state.policy.sub_stations[id]
      ? state.policy.sub_stations[id].minimum : null
  }));
}

function cellContent(cell, block, sub) {
  const people = (block && block.people) || [];
  const minimum = block && block.minimum !== undefined && block.minimum !== null
    ? block.minimum : sub.minimum;

  people.forEach((person, index) => {
    // ⭐ הקו האדום מצויר במקום קו המינימום של תחנת הקצה. הוא אינו
    // ידית: הוא ההחלטה ששמורה ב-`schedule_policies`, ומשנים אותה
    // בכרטיס „חוקי התחנה" — במקום שבו היא באמת נשמרת.
    if (minimum !== null && minimum !== undefined && index === minimum) {
      const bar = node('div', 'rulebar');
      bar.appendChild(node('span', 'ruleline'));
      cell.appendChild(bar);
    }
    const row = node('div', 'nm'
      + (index === 0 ? ' lead' : '')
      + (person.is_me ? ' me' : '')
      + (person.cancelled ? ' cancelled' : ''));
    row.textContent = person.person || person.uid || '—';
    cell.appendChild(row);
  });

  if (minimum !== null && minimum !== undefined && people.length <= minimum) {
    const bar = node('div', 'rulebar');
    bar.appendChild(node('span', 'ruleline'));
    cell.appendChild(bar);
  }
  if (block && block.below_minimum && minimum !== null && minimum !== undefined) {
    cell.appendChild(node('span', 'flag under',
      'מתחת לקו · ' + people.length + '/' + minimum));
  }
}

function renderBoard(target, days, options) {
  const opts = options || {};
  clear(target);
  if (!days || !days.length) {
    target.appendChild(node('div', 'empty', opts.empty || 'אין סידור להצגה בטווח הזה.'));
    return;
  }
  const subs = (opts.subs || subOrder(days)).filter((sub) =>
    !opts.onlySub || sub.id === opts.onlySub);
  if (!subs.length) {
    target.appendChild(node('div', 'empty', 'אין תחנות קצה להצגה.'));
    return;
  }

  const board = node('div', 'board');
  board.id = opts.id || 'board';
  board.style.setProperty('--n', String(days.length));
  board.appendChild(node('div', 'corner'));

  days.forEach((day, index) => {
    const head = node('div', 'hcell' + (isWeekend(day.date) ? ' we' : '')
      + (index % 7 === 0 ? ' snap' : ''));
    head.appendChild(node('div', 'dw', DOW[new Date(day.date + 'T00:00:00.000Z').getUTCDay()]));
    head.appendChild(node('div', 'dd',
      Number(day.date.slice(8, 10)) + '/' + Number(day.date.slice(5, 7))));
    board.appendChild(head);
  });

  subs.forEach((sub, subIndex) => {
    const stub = node('div', 'stub');
    stub.appendChild(node('b', '', sub.label));
    stub.appendChild(node('small', '',
      sub.minimum === null || sub.minimum === undefined ? 'אין קו' : 'קו ' + sub.minimum));
    board.appendChild(stub);

    days.forEach((day, index) => {
      const cell = node('div', 'cell ' + subClass(subIndex) + (index % 7 === 0 ? ' snap' : ''));
      const block = (day.sub_stations || []).find((item) => item.sub_station === sub.id);
      cellContent(cell, block, sub);
      // אירועים ואבטחות שייכים ליום כולו ולא לתחנת קצה. הם נתלים
      // על השורה הראשונה בלבד, כדי שלא יופיעו ארבע פעמים.
      if (subIndex === 0) {
        (day.events || []).forEach((event) => {
          cell.appendChild(node('span', 'flag evt',
            event.title + (event.hours ? ' · ' + event.hours : '')));
        });
        (day.guards || []).forEach((guard) => {
          // אבטחה בלי אנשים אינה „ריקה" — היא טרם אוישה, וזה מידע
          // תפעולי שאסור שייעלם רק מפני שהתא צר.
          const names = (guard.people || []).map((person) =>
            typeof person === 'string' ? person : person.person).filter(Boolean);
          cell.appendChild(node('span', 'flag guard',
            'אבטחה · ' + guard.title + (guard.hours ? ' · ' + guard.hours : '')
            + ' · ' + (names.length ? names.join(' · ') : 'טרם אוישה')));
        });
      }
      board.appendChild(cell);
    });
  });

  target.appendChild(board);
  fitColumns(board);
  // הלוח נפתח על תחילת הטווח. בכיוון RTL הדפדפן אינו תמיד מתחיל
  // שם מעצמו, ו„החודש נפתח באמצע" נראה כמו תקלה.
  board.scrollLeft = 0;
}

function fitColumns(board) {
  if (!board) return;
  const stub = 64;
  const available = board.clientWidth - stub;
  // שבוע מלא כשהמסך מרשה; אחרת העמודה הצרה ביותר שעדיין קריאה,
  // והגלילה משלימה את השבוע.
  const width = Math.max(84, Math.floor(available / 7));
  board.style.setProperty('--dayw', width + 'px');
  board.style.setProperty('--stub', stub + 'px');
}

function refitAll() {
  document.querySelectorAll('.board').forEach((board) => fitColumns(board));
}

function renderBoardHead(target, ym, onMonth, boardId, weekLabelId) {
  clear(target);
  const months = node('div', 'months');
  const year = Number(ym.slice(0, 4));
  // שנים עשר חודשי השנה הנוכחית. הסידור שנתי — שום דבר אינו
  // מתאפס במעבר חודש, וכל חודש הוא קריאה בפני עצמה.
  MONTHS.forEach((label, index) => {
    const button = node('button', '', label);
    button.type = 'button';
    button.dataset.index = String(index);
    const value = year + '-' + String(index + 1).padStart(2, '0');
    button.setAttribute('aria-pressed', value === ym ? 'true' : 'false');
    button.addEventListener('click', () => onMonth(value));
    months.appendChild(button);
  });
  target.appendChild(months);

  const jump = node('div', 'wkjump');
  const prev = node('button', '', '›'); prev.type = 'button';
  prev.setAttribute('aria-label', 'שבוע קודם');
  const label = node('b', '', 'שבוע 1'); label.id = weekLabelId;
  const next = node('button', '', '‹'); next.type = 'button';
  next.setAttribute('aria-label', 'שבוע הבא');
  const step = (direction) => {
    const board = $(boardId);
    if (!board) return;
    const width = parseInt(getComputedStyle(board).getPropertyValue('--dayw'), 10) || 96;
    board.scrollBy({ left: direction * width * 7, behavior: 'smooth' });
  };
  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  jump.append(prev, label, next);
  target.appendChild(jump);
}

function watchWeekLabel(boardId, weekLabelId, dayCount) {
  const board = $(boardId);
  const label = $(weekLabelId);
  if (!board || !label) return;
  const update = () => {
    const width = parseInt(getComputedStyle(board).getPropertyValue('--dayw'), 10) || 96;
    const week = Math.floor(Math.round(Math.abs(board.scrollLeft) / width) / 7) + 1;
    label.textContent = 'שבוע ' + Math.min(week, Math.max(1, Math.ceil(dayCount / 7)));
  };
  board.addEventListener('scroll', update, { passive: true });
  update();
}

/* ---------------- סידור התחנה ---------------- */

async function loadStationRange(ym) {
  if (!canViewSchedule()) return;
  state.month = ym || state.month || monthStart();
  renderBoardHead($('stationHead'), state.month,
    (value) => loadStationRange(value), 'stationBoard', 'stationWeek');
  const box = $('stationContent');
  clear(box); box.appendChild(node('div', 'loader'));
  $('stationNote').textContent = '';
  try {
    const view = await fetchRange(state.month);
    if (!view.active) {
      clear(box);
      box.appendChild(node('div', 'empty', 'עדיין לא פורסם סידור לחודש הזה.'));
      return;
    }
    renderBoard(box, view.days, { id: 'stationBoard' });
    watchWeekLabel('stationBoard', 'stationWeek', (view.days || []).length);
    $('stationNote').textContent = (view.source === 'legacy'
      ? 'הלוח מוצג מהסידור הקיים, כי מנוע הסידור החדש עדיין אינו פעיל.'
      : 'הלוח מוצג מהסידור שפורסם · גרסה ' + (view.revision || '—') + '.')
      + guardsNotice(view.days);
  } catch (error) {
    clear(box);
    box.appendChild(node('div', 'msg err', errorText(error)));
  }
}

/* ---------------- הסידור שלי ---------------- */

/* ⭐ הפאנל האישי נשאר יומי, והלוח חודשי.
 *
 * זו אינה חצי-עבודה: „מאשר/ת" ו„לא יכול/ה" נשלחים עם
 * `publication_id` ו-`item_id` של יום מסוים, ואין קריאה בשרת
 * שמחזירה את כל מה שממתין לתשובה לאורך חודש. לוח חודשי עם כפתורי
 * אישור היה נראה שלם ולא היה עובד. עד שתהיה קריאה כזאת, האישור
 * נעשה במקום שבו הוא באמת אפשרי — והלוח מציג את החודש. */

function answerStatus(item) {
  if (!item.answer) return '';
  return item.answer.status === 'confirmed' ? 'אישרתי' : 'דיווחתי שאיני יכול';
}

function answerButtons(itemId, item) {
  const wrap = node('div', 'answer');
  if (item.answer) { wrap.appendChild(node('div', 'msg ok', answerStatus(item))); return wrap; }
  const yes = node('button', 'confirm', 'מאשר/ת'); yes.type = 'button';
  const no = node('button', 'decline', 'לא יכול/ה'); no.type = 'button';
  yes.addEventListener('click', () => respond(itemId, 'confirm', null));
  no.addEventListener('click', () => {
    const choice = prompt('בחר סיבה: 1 לא זמין, 2 התנגשות, 3 שיבוץ שגוי, 4 אחר', '1');
    const reasons = { '1': 'unavailable', '2': 'conflict', '3': 'incorrect_assignment', '4': 'other' };
    if (choice !== null && reasons[choice]) respond(itemId, 'decline', reasons[choice]);
  });
  wrap.append(yes, no); return wrap;
}

function assignmentCard(item) {
  const card = node('article', 'assignment');
  card.appendChild(node('div', 'place', item.sub_station_label || item.sub_station));
  const inner = node('div', 'inner');
  const person = node('div', 'person');
  person.append(node('div', 'avatar',
    (state.user.displayName || state.user.email || '?').slice(0, 1)));
  const who = node('div');
  who.append(node('b', '', state.user.displayName || state.user.email || 'הסידור שלי'),
    node('div', 'role', (item.role_label || item.role || '') + (item.hours ? ' · ' + item.hours : '')));
  person.appendChild(who); inner.appendChild(person);
  const chips = node('div', 'chips');
  (item.qualifications || []).forEach((value) => chips.appendChild(node('span', 'chip', value)));
  if (item.shift) chips.appendChild(node('span', 'chip', item.shift));
  inner.appendChild(chips);
  const names = (item.crew || []).map((value) =>
    value.person + (value.role_label ? ' · ' + value.role_label : ''));
  inner.appendChild(node('div', 'crew',
    names.length ? 'צוות: ' + names.join(' · ') : 'לא שובצו אנשי צוות נוספים.'));
  if (item.change) inner.appendChild(node('div', 'msg info', 'השיבוץ הזה השתנה בפרסום האחרון.'));
  if (item.requires_answer || item.answer) inner.appendChild(answerButtons(item.date, item));
  card.appendChild(inner); return card;
}

function eventCard(item) {
  const card = node('article', 'assignment');
  card.appendChild(node('div', 'place', 'אירוע'));
  const inner = node('div', 'inner');
  inner.append(node('b', '', item.title), node('div', 'role', item.hours || item.date));
  if (item.change) inner.appendChild(node('div', 'msg info', 'האירוע הזה השתנה בפרסום האחרון.'));
  if (item.requires_answer || item.answer) inner.appendChild(answerButtons(item.id, item));
  card.appendChild(inner); return card;
}

function guardCard(item) {
  // אבטחה היא מידע תפעולי חי, לא אירוע חתום בסידור. במכוון אין לה
  // כפתורי אישור.
  const card = node('article', 'assignment guard-card');
  card.appendChild(node('div', 'place', 'אבטחה'));
  const inner = node('div', 'inner');
  inner.append(node('b', '', item.title), node('div', 'role', item.hours || item.date));
  card.appendChild(inner); return card;
}

function renderMineToday() {
  const box = $('mineToday');
  clear(box);
  const date = localDate();
  if (!state.mine || !state.mine.active) {
    if (state.mine && state.mine.error) {
      box.appendChild(node('div', 'msg err',
        'לא ניתן לטעון את הפאנל האישי כרגע. ' + state.mine.error));
    }
    return;
  }
  const days = (state.mine.days || []).filter((item) => item.date === date);
  const events = (state.mine.events || []).filter((item) => item.date === date);
  const guards = (state.mine.guards || []).filter((item) => item.date === date);
  days.forEach((item) => box.appendChild(assignmentCard(item)));
  events.forEach((item) => box.appendChild(eventCard(item)));
  guards.forEach((item) => box.appendChild(guardCard(item)));
  if (state.mine.guards_status === 'unavailable') {
    box.appendChild(node('div', 'msg info',
      'לא ניתן לטעון אבטחות כרגע. הסידור נשאר מוצג.'));
  }
}

async function respond(itemId, answer, reasonCode) {
  if (!state.status || state.status.mode !== 'new' || state.busy ||
      !state.mine || !state.mine.publication_id) return;
  state.busy = true;
  try {
    await call.respond({
      request_id: requestId('answer'), publication_id: state.mine.publication_id,
      item_id: itemId, answer, reason_code: reasonCode
    });
    await loadMine();
  } catch (error) { alert(errorText(error)); }
  finally { state.busy = false; }
}

async function loadMine() {
  if (!canViewSchedule()) return;
  try {
    state.mine = (await call.mine({ date: localDate() })).data;
  } catch (error) { state.mine = { active: false, error: errorText(error) }; }
  renderMineToday();
}

function mySubStation() {
  const person = state.setup && Array.isArray(state.setup.people)
    ? state.setup.people.find((item) => item.id === (state.user && state.user.uid)) : null;
  return person ? person.sub_station : null;
}

function daysWithMe(days) {
  return (days || []).filter((day) => (day.sub_stations || []).some((sub) =>
    (sub.people || []).some((person) => person.is_me === true)));
}

async function loadMineRange(ym) {
  if (!canViewSchedule()) return;
  state.month = ym || state.month || monthStart();
  loadMine();
  renderBoardHead($('mineHead'), state.month,
    (value) => loadMineRange(value), 'mineBoard', 'mineWeek');
  const box = $('mineContent');
  clear(box); box.appendChild(node('div', 'loader'));
  $('mineNote').textContent = '';
  try {
    const view = await fetchRange(state.month);
    if (!view.active) {
      clear(box);
      box.appendChild(node('div', 'empty', 'עדיין לא פורסם סידור לחודש הזה.'));
      return;
    }
    const days = state.mineOnly ? daysWithMe(view.days) : view.days;
    const only = mySubStation();
    renderBoard(box, days, { id: 'mineBoard', onlySub: only || undefined,
      empty: 'אין לך שיבוץ בחודש הזה.' });
    watchWeekLabel('mineBoard', 'mineWeek', (days || []).length);
    $('mineNote').textContent = (only
      ? 'מוצגת תחנת הקצה שלך. „סידור התחנה" מציג את כל התחנה.'
      : 'לא ניתן לזהות את תחנת הקצה שלך מהמקור, ולכן מוצגות כל התחנות.')
      + guardsNotice(view.days);
  } catch (error) {
    clear(box);
    box.appendChild(node('div', 'msg err', errorText(error)));
  }
}

/* ==================================================================
 *  חוקי התחנה · העורך
 * ------------------------------------------------------------------
 *  ⭐ אין כאן ולו ערך אחד שהמסך ממציא.
 *
 *  קו מינימום, כמות לכל תפקיד, חובה או רשות — כולם החלטות של
 *  התחנה. שדה שלא נקבע מוצג כ-„—" והשמירה חסומה, ולא הופך ל-0
 *  בשקט. מספר שאיש לא בחר הוא הדבר המסוכן ביותר במסך הזה: קו
 *  מינימום 0 הופך „מתחת לתקן" למצב שלעולם אינו קורה.
 * ================================================================== */

function policyFromSetup(setup) {
  if (setup && setup.configured && setup.policy) {
    const subs = {};
    (setup.policy.sub_stations || []).forEach((sub) => {
      subs[sub.id] = {
        label: sub.label,
        minimum: sub.minimum,
        requirements: (sub.requirements || []).map((item) => ({
          role: item.role,
          label: item.label || item.role,
          count: item.count,
          required: item.required === true
        }))
      };
    });
    return {
      known: true,
      active_policy_id: setup.policy.active_policy_id || setup.policy.id || null,
      version: setup.policy.version || null,
      sub_stations: subs,
      rest: setup.policy.rest && Number.isInteger(setup.policy.rest.min_gap_days)
        ? { min_gap_days: setup.policy.rest.min_gap_days } : null,
      rotation: setup.policy.rotation === undefined ? null : setup.policy.rotation,
      max_shifts_per_month: setup.policy.max_shifts_per_month === undefined
        ? null : setup.policy.max_shifts_per_month
    };
  }

  // מקור בלי מדיניות. תחנות הקצה והתפקידים נלקחים ממה שקיים
  // בפועל אצל האנשים — זו תצפית, לא הצעה. הכמויות וקו המינימום
  // נשארים ריקים עד שאדם יקבע אותם.
  const observed = setup && setup.observed ? setup.observed : null;
  if (!observed || !(observed.sub_stations || []).length) return null;
  const subs = {};
  observed.sub_stations.forEach((sub) => {
    subs[sub.id] = {
      label: sub.label || sub.id,
      minimum: null,
      requirements: (observed.roles || []).map((role) => ({
        role, label: role, count: null, required: null
      }))
    };
  });
  return {
    known: false, active_policy_id: null, version: null,
    sub_stations: subs, rest: null, rotation: null, max_shifts_per_month: null
  };
}

function policyComplete() {
  const policy = state.policy;
  if (!policy) return false;
  const keys = Object.keys(policy.sub_stations);
  if (!keys.length) return false;
  if (!policy.rest || !Number.isInteger(policy.rest.min_gap_days)) return false;
  return keys.every((key) => {
    const sub = policy.sub_stations[key];
    if (!Number.isInteger(sub.minimum)) return false;
    if (!sub.requirements.length) return false;
    return sub.requirements.every((item) =>
      Number.isInteger(item.count) && typeof item.required === 'boolean');
  });
}

function stepper(label, value, onChange, extraClass) {
  const wrap = node('div', 'step' + (extraClass ? ' ' + extraClass : ''));
  wrap.appendChild(node('span', '', label));
  const minus = node('button', '', '−'); minus.type = 'button';
  minus.setAttribute('aria-label', 'הפחת · ' + label);
  const number = node('b', 'n', value === null || value === undefined ? '—' : value);
  const plus = node('button', '', '+'); plus.type = 'button';
  plus.setAttribute('aria-label', 'הוסף · ' + label);
  minus.disabled = !Number.isInteger(value) || value <= 0;
  minus.addEventListener('click', () => onChange(Number.isInteger(value) ? value - 1 : 0));
  // ⭐ הלחיצה הראשונה על „+" על שדה ריק קובעת 0 במפורש, כמעשה
  // של אדם. היא אינה מציבה 1 „כי זה סביר".
  plus.addEventListener('click', () => onChange(Number.isInteger(value) ? value + 1 : 0));
  wrap.append(minus, number, plus);
  return wrap;
}

function renderPolicy() {
  const setup = state.setup;
  const subsBox = $('policySubs');
  const stepsBox = $('policySteps');
  clear(subsBox); clear(stepsBox);

  if (!setup) {
    $('sourceSummary').textContent = 'טוען מדיניות ומקור נתונים…';
    return;
  }
  if (!state.policy) {
    $('sourceSummary').textContent = (setup.missing || []).indexOf('source') !== -1
      ? 'אין מקור כוח-אדם חתום, ולכן אי אפשר לקבוע חוקי תחנה. '
        + 'המקור הוא רשימת האנשים, התחנות והתפקידים שהמנוע מתכנן לפיהם.'
      : 'אין מדיניות פעילה ואין ממה לגזור תחנות קצה ותפקידים.';
    $('savePolicy').disabled = true;
    return;
  }

  const keys = Object.keys(state.policy.sub_stations).sort();
  if (!state.policySub || keys.indexOf(state.policySub) === -1) state.policySub = keys[0];

  $('sourceSummary').textContent = state.policy.known
    ? 'מקור ' + ((setup.source && setup.source.version) || '—')
      + ' · מהדורה ' + ((setup.source && setup.source.revision) || '—')
      + ' · מדיניות ' + (state.policy.version || '—')
    : 'עדיין אין חוקי תחנה. תחנות הקצה והתפקידים שלהלן נצפו במקור — '
      + 'הכמויות וקו המינימום עדיין לא נקבעו.';
  $('policyVersion').textContent = state.policy.version
    ? 'גרסה נוכחית: ' + state.policy.version : 'טרם נשמרה גרסה';

  keys.forEach((key) => {
    const button = node('button', 'pill', state.policy.sub_stations[key].label || key);
    button.type = 'button';
    button.setAttribute('aria-pressed', key === state.policySub ? 'true' : 'false');
    button.addEventListener('click', () => { state.policySub = key; renderPolicy(); });
    subsBox.appendChild(button);
  });

  const sub = state.policy.sub_stations[state.policySub];
  sub.requirements.forEach((item) => {
    const step = stepper(item.label || item.role, item.count, (value) => {
      item.count = value; state.policyDirty = true; renderPolicy();
    });
    const duty = node('button', 'duty', item.required === true ? 'חובה'
      : (item.required === false ? 'רשות' : '—'));
    duty.type = 'button';
    duty.setAttribute('aria-pressed', item.required === true ? 'true' : 'false');
    duty.setAttribute('aria-label', 'חובה או רשות · ' + (item.label || item.role));
    // שלושה מצבים במחזור: לא נקבע → חובה → רשות. „לא סימנו" אינו
    // „רשות", ולכן הוא מצב נפרד שחוסם שמירה.
    duty.addEventListener('click', () => {
      item.required = item.required === true ? false : (item.required === false ? null : true);
      state.policyDirty = true; renderPolicy();
    });
    step.appendChild(duty);
    stepsBox.appendChild(step);
  });

  stepsBox.appendChild(stepper('קו מינימום', sub.minimum, (value) => {
    sub.minimum = value; state.policyDirty = true; renderPolicy();
  }, 'min'));

  stepsBox.appendChild(stepper('ימי מנוחה בין משמרות',
    state.policy.rest ? state.policy.rest.min_gap_days : null, (value) => {
      state.policy.rest = { min_gap_days: value };
      state.policyDirty = true; renderPolicy();
    }));

  const complete = policyComplete();
  $('savePolicy').disabled = state.policyBusy || !complete || !state.policyDirty;
  const box = $('policyMessage');
  const incomplete = box.querySelector('.incomplete');
  if (!complete) {
    clear(box);
    // הודעת „ערך חסר" מסומנת, כדי שרק היא תוסר כשהערך הושלם.
    // הודעת השמירה שמעליה אינה שייכת לרינדור הזה ואסור שתימחק
    // רק מפני שהמסך צויר מחדש.
    box.appendChild(node('div', 'msg warn incomplete',
      'עדיין יש ערך שלא נקבע. כל תפקיד צריך כמות וסימון חובה/רשות, '
      + 'ולכל תחנת קצה צריך קו מינימום. ערך חסר אינו אפס.'));
  } else if (incomplete) {
    clear(box);
  }
}

function renderChanges(result) {
  const box = $('policyChanges');
  clear(box);
  if (!result) return;
  (result.weakening || []).forEach((change) => {
    box.appendChild(node('div', 'change weak', describeChange(change) + ' — הקלה בתקן'));
  });
  (result.changes || []).filter((change) => change.weakens !== true).forEach((change) => {
    box.appendChild(node('div', 'change', describeChange(change)));
  });
  (result.warnings || []).forEach((warning) => {
    box.appendChild(node('div', 'change warn', warning.detail || warning.code));
  });
}

function describeChange(change) {
  const where = change.sub_station ? change.sub_station + ' · ' : '';
  switch (change.kind) {
    case 'minimum': return where + 'קו מינימום ' + change.from + ' → ' + change.to;
    case 'role-count': return where + change.role + ' ' + change.from + ' → ' + change.to;
    case 'role-required': return where + change.role + ' '
      + (change.to ? 'הפך לחובה' : 'הפך לרשות');
    case 'role-added': return where + 'נוסף תפקיד ' + change.role;
    case 'role-removed': return where + 'הוסר תפקיד ' + change.role;
    case 'sub-station-added': return 'נוספה תחנת קצה ' + change.sub_station;
    case 'sub-station-removed': return 'הוסרה תחנת קצה ' + change.sub_station;
    case 'sub-station-label': return where + 'שם השתנה ל-' + change.to;
    case 'rest-min-gap-days': return 'ימי מנוחה ' + change.from + ' → ' + change.to;
    case 'rotation': return 'מחזוריות ' + (change.to ? 'הוגדרה' : 'בוטלה');
    case 'max-shifts-per-month': return 'תקרת משמרות '
      + (change.to === null ? 'בוטלה' : 'נקבעה ל-' + change.to);
    default: return change.kind;
  }
}

function policyDraftPayload() {
  const subs = {};
  Object.keys(state.policy.sub_stations).forEach((key) => {
    const sub = state.policy.sub_stations[key];
    subs[key] = {
      label: sub.label,
      minimum: sub.minimum,
      requirements: sub.requirements.map((item) => ({
        role: item.role, label: item.label, count: item.count, required: item.required
      }))
    };
  });
  return {
    sub_stations: subs,
    rest: state.policy.rest,
    // ⭐ שתי ההצהרות האלה נשלחות תמיד, גם כ-null. השרת דורש הצהרה
    // מפורשת ולא „לא שלחו — כנראה אין".
    rotation: state.policy.rotation === undefined ? null : state.policy.rotation,
    max_shifts_per_month: state.policy.max_shifts_per_month === undefined
      ? null : state.policy.max_shifts_per_month
  };
}

async function savePolicy() {
  if (state.policyBusy || !state.policy || !policyComplete()) return;
  state.policyBusy = true;
  $('savePolicy').disabled = true;
  message('policyMessage', 'בודק מה משתנה לפני השמירה…', 'info');
  try {
    const draft = policyDraftPayload();
    const preview = (await call.policyPreview({ draft })).data;
    renderChanges(preview);
    if (preview.kind === 'unchanged') {
      message('policyMessage', 'החוקים זהים למה שכבר שמור. לא נוצרה גרסה חדשה.', 'ok');
      state.policyDirty = false;
      return;
    }
    if ((preview.weakening || []).length && !$('confirmWeakening').checked) {
      message('policyMessage',
        'השינוי מקל על התקן ב-' + preview.weakening.length + ' מקומות. '
        + 'סמנו „מאשר/ת הקלה בתקן" כדי להמשיך.', 'warn');
      return;
    }
    const saved = (await call.policySave({
      request_id: requestId('policy'),
      draft,
      activate: true,
      expected_policy_id: state.policy.active_policy_id,
      confirm_weakening: $('confirmWeakening').checked === true
    })).data;
    renderChanges(saved);
    message('policyMessage', saved.written
      ? 'חוקי התחנה נשמרו כגרסה ' + saved.version
        + (saved.activated ? ' והם החוקים הפעילים.' : ' ולא הופעלו.')
        + ' שמירת חוקים אינה משנה סידור שכבר פורסם ואינה שולחת הודעה.'
      : 'לא היה מה לשמור — החוקים לא השתנו.', 'ok');
    $('confirmWeakening').checked = false;
    state.policyDirty = false;
    // טיוטה שנבנתה על החוקים הקודמים אינה תואמת עוד את מה שנשמר.
    if (state.draft) {
      state.draft = null; state.draftPreview = null;
      $('draftPreviewCard').classList.add('hide');
      message('runMessage', 'חוקי התחנה השתנו, ולכן הטיוטה הקודמת נמחקה מהמסך. '
        + 'יש להריץ את המנוע מחדש.', 'warn');
    }
    await loadSetup();
  } catch (error) {
    const code = errorCode(error);
    if (code === 'policy-conflict') {
      message('policyMessage', errorText(error), 'err');
      await loadSetup();
    } else {
      message('policyMessage', errorText(error), 'err');
    }
  } finally {
    state.policyBusy = false;
    renderPolicy();
    updatePublishAvailability();
  }
}

/* ---------------- שיבוץ ידני ---------------- */

function option(select, value, label) {
  const item = node('option', '', label);
  item.value = value;
  select.appendChild(item);
}

function addOverride(initial = {}) {
  if (!state.setup || !state.policy) return;
  const row = node('div', 'override');
  const dateWrap = node('div');
  dateWrap.appendChild(node('label', '', 'תאריך'));
  const date = node('input');
  date.type = 'date'; date.value = initial.date || (monthStart() + '-01');
  date.dataset.field = 'date';
  dateWrap.appendChild(date);

  const subWrap = node('div');
  subWrap.appendChild(node('label', '', 'תחנת קצה'));
  const sub = node('select'); sub.dataset.field = 'sub_station';
  Object.keys(state.policy.sub_stations).sort().forEach((id) =>
    option(sub, id, state.policy.sub_stations[id].label || id));
  sub.value = initial.sub_station || sub.value;
  subWrap.appendChild(sub);

  const personWrap = node('div', 'wide');
  personWrap.appendChild(node('label', '', 'איתור עובד'));
  const person = node('select'); person.dataset.field = 'person';
  (state.setup.people || []).forEach((value) => option(person, value.id, value.name));
  person.value = initial.person || person.value;
  personWrap.appendChild(person);

  const roleWrap = node('div');
  roleWrap.appendChild(node('label', '', 'תפקיד בשיבוץ'));
  const role = node('select'); role.dataset.field = 'role';
  const updateRoles = () => {
    const selected = (state.setup.people || []).find((value) => value.id === person.value);
    clear(role); option(role, '', 'לפי צורכי המנוע');
    ((selected && selected.roles) || []).forEach((value) => option(role, value, value));
    if (initial.role) role.value = initial.role;
  };
  person.addEventListener('change', updateRoles); updateRoles();
  roleWrap.appendChild(role);

  const remove = node('button', 'btn danger remove', 'הסר');
  remove.type = 'button'; remove.addEventListener('click', () => row.remove());
  row.append(dateWrap, subWrap, personWrap, roleWrap, remove);
  $('overrideList').appendChild(row);
}

function overrides() {
  return Array.from($('overrideList').querySelectorAll('.override')).map((row) => {
    const get = (field) => row.querySelector('[data-field="' + field + '"]').value;
    const value = {
      date: get('date'), sub_station: get('sub_station'), person: get('person'), role: get('role') || null
    };
    if (!value.date || !value.sub_station || !value.person) throw new Error('יש להשלים כל שיבוץ ידני.');
    return value;
  });
}

function renderSummary(summary) {
  const box = $('draftSummary'); clear(box); box.classList.remove('hide');
  const values = [
    ['שובצו', summary.filled || 0], ['חוסרים חוסמים', summary.blocking_gaps || 0],
    ['ימים מתחת למינימום', summary.days_below_minimum || 0], ['שינויים שנדחו', summary.rejected_manual || 0]
  ];
  values.forEach(([label, value]) => {
    const metric = node('div', 'metric');
    metric.append(node('b', '', value), node('span', '', label)); box.appendChild(metric);
  });
}

function updatePublishAvailability() {
  const gaps = Number((state.draft && state.draft.summary || {}).blocking_gaps || 0);
  /* ⭐ P0-2. ב-`shadow` פרסום הוא **הכנה**, ולכן הוא מותר שם — זה
   * כל מה שסוגר את חלון הלוח הריק. ב-`off` הוא חסום כמו קודם. */
  const ready = !!state.draft && !!state.draftPreview && $('reviewDraft').checked
    && canRunSchedule() && gaps === 0;
  $('publish').disabled = state.busy || !ready;
  $('publish').textContent = state.status && state.status.mode === 'shadow'
    ? 'הכן את הסידור לקראת מעבר' : 'פרסום הסידור';
  $('draftBadge').hidden = !state.draft;
}

/* ⭐ P1-1. מסך הניהול נפתח עכשיו גם ב-`off`, כדי שאפשר יהיה להזין
 * חוקי תחנה ומקור בתחנה חדשה. הפקדים שמריצים ומפרסמים נשארים
 * חסומים שם — והשרת אוכף את זה בעצמו, ללא תלות במסך. */
function updateRunAvailability() {
  const may = canRunSchedule();
  $('runPlanner').disabled = state.busy || !may;
  if (!may) $('publish').disabled = true;
  const note = $('runMessage');
  if (note && !may && state.status && state.status.mode === 'off') {
    message('runMessage',
      'המנוע כבוי. אפשר להזין חוקי תחנה ומקור כוח אדם, '
      + 'והרצה תתאפשר אחרי שהפיקוד יעביר את המנוע למצב צל.', 'info');
  }
}

function renderDraftPreview(preview) {
  const card = $('draftPreviewCard');
  const box = $('draftPreview');
  card.classList.remove('hide');
  renderBoard(box, preview.days || [], { id: 'draftBoard',
    empty: 'אין שיבוצים בשבוע הזה.' });
  const first = (preview.days || [])[0];
  const last = (preview.days || [])[(preview.days || []).length - 1];
  $('previewRange').textContent = first && last
    ? dateLabel(first.date) + ' — ' + dateLabel(last.date) : (preview.week_start || '');
  $('previewPrev').disabled = preview.week_start <= preview.from;
  $('previewNext').disabled = !last || last.date >= preview.to;
}

async function loadDraftPreview(start, resetApproval) {
  if (!state.draft) return;
  state.previewStart = start || state.draft.from;
  state.draftPreview = null;
  if (resetApproval !== false) $('reviewDraft').checked = false;
  $('reviewDraft').disabled = true;
  updatePublishAvailability();
  clear($('draftPreview')); $('draftPreview').appendChild(node('div', 'loader'));
  $('draftPreviewCard').classList.remove('hide');
  message('previewMessage', 'טוען את הטיוטה לבדיקה…', 'info');
  try {
    const preview = (await call.preview({
      draft_id: state.draft.draft_id,
      start: state.previewStart
    })).data;
    if (!state.draft || preview.draft_id !== state.draft.draft_id) return;
    state.draftPreview = preview;
    state.previewStart = preview.week_start;
    renderDraftPreview(preview);
    $('reviewDraft').disabled = false;
    message('previewMessage', 'הטיוטה מוצגת לבדיקה. היא עדיין לא פורסמה.', 'ok');
  } catch (error) {
    message('previewMessage', errorText(error), 'err');
  }
  updatePublishAvailability();
}

async function runPlanner() {
  if (state.busy) return;
  state.busy = true; $('runPlanner').disabled = true; state.draft = null; state.draftPreview = null;
  $('publish').disabled = true; $('reviewDraft').checked = false; $('reviewDraft').disabled = true;
  $('draftPreviewCard').classList.add('hide');
  message('runMessage', 'המנוע בונה טיוטה ובודק את כל החוקים…', 'info');
  try {
    const startMonth = $('startMonth').value;
    if (!/^\d{4}-\d{2}$/.test(startMonth)) throw new Error('יש לבחור חודש התחלה.');
    const result = (await call.run({
      request_id: requestId('draft'), start: startMonth + '-01',
      months: Number($('months').value), overrides: overrides()
    })).data;
    state.draft = result;
    renderSummary(result.summary || {});
    message('runMessage', 'הטיוטה הושלמה. היא עדיין לא פורסמה ולא נשלחה שום הודעה.', 'ok');
    await loadDraftPreview(result.from, true);
  } catch (error) { message('runMessage', errorText(error), 'err'); }
  finally { state.busy = false; $('runPlanner').disabled = false; updatePublishAvailability(); }
}

async function publishDraft() {
  if (!state.status || state.status.mode !== 'new' || state.busy ||
      !state.draft || !state.draftPreview || !$('reviewDraft').checked) return;
  const gaps = Number((state.draft.summary || {}).blocking_gaps || 0);
  if (gaps > 0) { message('publishMessage', 'אי אפשר לפרסם: בטיוטה יש חוסרים חוסמים.', 'err'); return; }
  if (!confirm('לפרסם את הטיוטה? הסידור יהפוך לפעיל והמשתמשים הרלוונטיים יקבלו עדכון.')) return;
  state.busy = true; $('publish').disabled = true;
  message('publishMessage', 'מפרסם את הסידור בפעולה אחת…', 'info');
  try {
    const result = (await call.publish({
      draft_id: state.draft.draft_id,
      expected_content_digest: state.draftPreview.expected_content_digest,
      request_id: requestId('publish')
    })).data;
    message('publishMessage', 'הסידור פורסם בהצלחה. נוצרו ' + result.notified_people + ' עדכונים לשליחה.', 'ok');
    state.draft = null;
    state.draftPreview = null;
    $('reviewDraft').checked = false;
    $('reviewDraft').disabled = true;
    $('draftPreviewCard').classList.add('hide');
    state.status = (await call.status({})).data;
    setMode(state.status); setRollbackAvailability();
    invalidateRange();
    await Promise.all([loadMine(), loadMineRange(), loadStationRange()]);
  } catch (error) { message('publishMessage', errorText(error), 'err'); }
  finally { state.busy = false; setRollbackAvailability(); updatePublishAvailability(); }
}

function setRollbackAvailability() {
  const active = state.status && state.status.active;
  $('rollback').disabled = state.busy || !state.status || state.status.mode !== 'new'
    || !state.status.manager || !active || active.can_rollback !== true
    || !active.previous_publication_id;
}

async function rollbackSchedule() {
  if (state.busy || $('rollback').disabled) return;
  const active = state.status.active;
  const text = 'לחזור מגרסה ' + active.revision + ' לגרסה הקודמת? '
    + 'המערכת תשמור את ההיסטוריה ותשלח עדכון רק למי שהסידור שלו משתנה.';
  if (!confirm(text)) return;
  state.busy = true; setRollbackAvailability();
  message('rollbackMessage', 'מחזיר לגרסה הקודמת בפעולה בטוחה…', 'info');
  try {
    const result = (await call.rollback({
      request_id: requestId('rollback'),
      expected_active_publication_id: active.publication_id,
      target_publication_id: active.previous_publication_id,
      reason_code: 'operational_safety'
    })).data;
    message('rollbackMessage', 'החזרה הושלמה כגרסה ' + result.revision + '.', 'ok');
    state.status = (await call.status({})).data;
    setMode(state.status); setRollbackAvailability();
    invalidateRange();
    await Promise.all([loadMine(), loadMineRange(), loadStationRange()]);
  } catch (error) {
    message('rollbackMessage', errorText(error), 'err');
  } finally {
    state.busy = false; setRollbackAvailability();
  }
}

async function loadSetup() {
  if (!canManageSchedule()) return;
  try {
    state.setup = (await call.setup({})).data;
    state.policy = policyFromSetup(state.setup);
    state.policyDirty = false;
    renderPolicy();
    renderSourceSummary();
  } catch (error) { message('policyMessage', errorText(error), 'err'); }
}

async function boot(user) {
  state.user = user;
  try { state.claims = (await user.getIdTokenResult()).claims || {}; } catch (_) { state.claims = {}; }
  renderNav(state.claims, 'schedule-management.html', user.displayName || user.email || '');
  $('who').textContent = user.displayName || user.email || '';
  $('appMain').classList.remove('hide');
  try {
    state.status = (await call.status({})).data;
    setMode(state.status || {});

    if (!canViewSchedule()) {
      showUnavailable('הסידור החדש עדיין אינו פעיל',
        'לא ניתן לקבוע איזו תצוגת סידור בטוחה להצגה. נסה/י לרענן או לפנות לאחראי/ת הסידור.');
      return;
    }

    setRollbackAvailability();
    $('startMonth').value = monthStart();
    state.month = monthStart();
    showScheduleViews();
    await Promise.all([loadSetup(), loadModeOptions()]);
    chooseTab(new URLSearchParams(location.search).get('tab') || 'station');
  } catch (error) {
    state.status = null;
    const box = $('mode');
    box.className = 'mode bad';
    box.lastElementChild.textContent = 'לא ניתן לאמת את מצב מנוע הסידור.';
    showUnavailable('לא ניתן לטעון את הסידור כרגע',
      'המערכת לא מציגה נתונים ישנים כאשר בדיקת ההרשאה או מצב המנוע נכשלה. נסה/י לרענן או לפנות לאחראי/ת הסידור.');
  }
}

document.querySelectorAll('[data-tab]').forEach((button) =>
  button.addEventListener('click', () => chooseTab(button.dataset.tab)));
$('mineOnly').addEventListener('click', () => {
  state.mineOnly = !state.mineOnly;
  $('mineOnly').setAttribute('aria-pressed', state.mineOnly ? 'true' : 'false');
  loadMineRange();
});
$('previewPrev').addEventListener('click', () => {
  if (!state.draftPreview || $('previewPrev').disabled) return;
  loadDraftPreview(shiftDate(state.previewStart, -7), false);
});
$('previewNext').addEventListener('click', () => {
  if (!state.draftPreview || $('previewNext').disabled) return;
  loadDraftPreview(shiftDate(state.previewStart, 7), false);
});
$('reviewDraft').addEventListener('change', updatePublishAvailability);
$('addOverride').addEventListener('click', () => addOverride());
// ⭐ `hidden` ו-`disabled` הם שכבת תצוגה בלבד. אפשר להסיר אותם
// בשורה אחת מקונסולת הדפדפן, ואז המאזין נורה כרגיל. השרת אמנם
// עוצר — `requireManager` על כל פעולה משנה — אבל מסך ששולח פעולה
// שהוא יודע שאינה מותרת משקר לאדם וגם מייצר קריאה מיותרת.
//
// לכן כל פעולת ניהול עוברת דרך שער אחד. הוא נשען על **תשובת
// השרת** (`state.status.manager`) ולא על התפקיד בטוקן ולא על
// רוחב המסך, והוא מקום אחד — כדי שפעולה חדשה לא תישכח בחוץ.
function managerAction(fn) {
  return function (event) {
    if (!canManageSchedule()) return;
    return fn(event);
  };
}

// שער המצב נפרד: הוא שייך לפיקוד ולא למינוי התפעולי, ולכן הוא
// נשען על `may_change` שהשרת החזיר ולא על היכולת לנהל.
/* הרצה, הכנה ופרסום — חסומות ב-`off` גם למי שממונה. */
function runAction(fn) {
  return function (event) {
    if (!canRunSchedule()) return;
    return fn(event);
  };
}

function commandAction(fn) {
  return function (event) {
    if (!state.modeView || state.modeView.may_change !== true) return;
    return fn(event);
  };
}

$('runPlanner').addEventListener('click', runAction(runPlanner));
$('publish').addEventListener('click', runAction(publishDraft));
$('rollback').addEventListener('click', runAction(rollbackSchedule));
$('savePolicy').addEventListener('click', managerAction(savePolicy));
$('modeConfirm').addEventListener('input', updateModeApply);
$('modeReason').addEventListener('change', updateModeApply);
$('modeApply').addEventListener('click', commandAction(applyModeChange));
$('sourceParse').addEventListener('click', () => {
  const table = parsePaste($('sourcePaste').value);
  if (!table) {
    message('sourceMessage', 'צריך לפחות שורת כותרות ושורת נתונים אחת.', 'err');
    return;
  }
  state.sourceTable = table;
  state.sourceMap = null;
  state.sourceActive = null;
  state.sourcePlan = null;
  renderSourceMap();
  renderSourceActive();
  renderSourceReport(null);
  message('sourceMessage', 'נקראו ' + table.rows.length + ' שורות ו-'
    + table.header.length + ' עמודות. יש למפות את העמודות.', 'info');
  updateSourceButtons();
});
$('sourceAccept').addEventListener('change', updateSourceButtons);
$('sourceCheck').addEventListener('click', managerAction(checkSource));
$('sourceSave').addEventListener('click', managerAction(saveSource));
addEventListener('resize', refitAll);

onAuthStateChanged(auth, (user) => {
  if (!user) { location.replace('./login.html?next=schedule-management.html'); return; }
  boot(user);
});
