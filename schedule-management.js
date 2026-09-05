import { firebaseConfig } from './firebase-config.js?v=42h1';
import { renderNav, renderStuckNav } from './nav.js?v=42h1';
import { initPWA } from './pwa.js?v=42h1';
import { initAppCheck } from './appcheck.js?v=42h1';
import { readScheduleFile } from './schedule-file-import.js?v=42h1';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFunctions, httpsCallable } from './monitored-functions.js?v=42h1';

const app = initializeApp(firebaseConfig);
await initAppCheck(app);
const auth = getAuth(app);
const functions = getFunctions(app, 'europe-west1');
const call = Object.freeze({
  status: httpsCallable(functions, 'getScheduleRuntimeStatus'),
  setup: httpsCallable(functions, 'getScheduleManagerSetup'),
  modeOptions: httpsCallable(functions, 'getScheduleModeOptions'),
  modeSet: httpsCallable(functions, 'setScheduleRuntimeMode'),
  /* ⭐ שתי אלה היו מיוצאות בשרת ולא נוצרו כאן, ולכן כל מחזור החיים
   * של המעבר — הכנה, בדיקה מול הסידור הקיים, ומעבר אטומי — פשוט לא
   * היה על המסלול של המסך. המסך המשיך להזיז mode ישירות. */
  cutoverPreview: httpsCallable(functions, 'previewScheduleCutover'),
  cutoverPromote: httpsCallable(functions, 'promoteScheduleToNew'),
  sourcePreview: httpsCallable(functions, 'previewScheduleSource'),
  sourceSave: httpsCallable(functions, 'saveScheduleSource'),
  policyPreview: httpsCallable(functions, 'previewSchedulePolicy'),
  policySave: httpsCallable(functions, 'saveSchedulePolicy'),
  run: httpsCallable(functions, 'runSchedulePlanner'),
  importPreview: httpsCallable(functions, 'previewScheduleImport'),
  importSheet: httpsCallable(functions, 'importScheduleSheet'),
  displayStatus: httpsCallable(functions, 'getScheduleDisplayStatus'),
  displaySet: httpsCallable(functions, 'setScheduleDisplay'),
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
  // מזהה פרסום הוא חלק מחוזה ה-idempotency עם השרת. כל ניסיון
  // חוזר על אותה טיוטה חתומה ובאותה כוונה (הכנה/פרסום) חייב להשתמש
  // באותו מזהה, גם אם תשובת השרת אבדה אחרי שהכתיבה כבר הושלמה.
  publishRequestId: null, publishRequestKey: null,
  // חוקי התחנה, כפי שהמסך אוסף אותם
  policy: null, policySub: null, policyDirty: false, policyBusy: false,
  // מצב המנוע — הרשאה נפרדת לגמרי מאחראי הסידור
  modeView: null, modeTarget: null, modeBusy: false, cutoverRequestId: null,
  pendingCutover: null,
  // יבוא מקור כוח האדם
  sourceTable: null, sourceMap: null, sourceActive: null,
  sourcePlan: null, sourceBusy: false,
  importMatrix: null, importFileName: null, importSelectedFile: null, importedDraft: null,
  importStationMap: null, importDisplay: null, displayRequestIds: {},
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
const FIXED_STATIONS = Object.freeze([
  Object.freeze({ id:'eilat', label:'אילת', minimum:7 }),
  Object.freeze({ id:'shahmon', label:'שחמון', minimum:null }),
  Object.freeze({ id:'timna', label:'תמנע', minimum:null }),
  Object.freeze({ id:'yotvata', label:'יטבתה', minimum:null })
]);

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

function resetPublishRequest() {
  state.publishRequestId = null;
  state.publishRequestKey = null;
}

function requestIdForPublication(draftId, contentDigest, intent) {
  const key = JSON.stringify([
    String(draftId || ''), String(contentDigest || ''), String(intent || '')
  ]);
  if (!state.publishRequestId || state.publishRequestKey !== key) {
    state.publishRequestId = requestId('publish');
    state.publishRequestKey = key;
  }
  return state.publishRequestId;
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

/* ⭐ קודי הסיבה של ה-preflight, בעברית. הדוח מחזיר קודים ולא טקסט
 * — כדי שלא יהיה בו מקום למידע אישי — ולכן התרגום חי כאן, במסך. */
const REASON_TEXT = Object.freeze({
  'preflight-missing': 'יש מי שמשובץ היום ולא משובץ בסידור החדש',
  'preflight-foreign': 'יש שיבוץ למי שאינו במקור כוח האדם',
  'preflight-duplicate': 'אותו אדם מופיע פעמיים באותו יום',
  'preflight-empty-day': 'יש יום מאויש שנעשה ריק',
  'preflight-out-of-range': 'יש שיבוץ מחוץ לטווח שנבדק'
});

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
      ? 'מצב בדיקה. אפשר להכין טיוטה ופרסום מוכן לבדיקה בלבד; הסידור הקיים נשאר פעיל ואיש אינו מקבל הודעה.'
      : 'המנוע פעיל. פרסום מחליף את הסידור הפעיל ושולח עדכון אישי.');

  const box = $('modeTargets');
  clear(box);
  /* ⭐ המתג ל-`new` מוצג — ומוביל למסלול המעבר (preflight חתום +
   * אישור), לא להחלפת מצב. הכרעת אלדד (3.9.2026): המעבר נשלח בנוי
   * ואינרטי, „שכל מה שיישאר לי זה להרים את המתג". */
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
  /* ⭐ 386.3 · בקשת מעבר שלא קיבלה תשובה מוצגת כאן תמיד — גם כשהשרת
   * כבר אינו מציע `new` (כי הוא שם), וגם כשאין מועמד. הכפתור שולח
   * את **אותה** בקשה; הוא לעולם אינו מתחיל מעבר חדש. */
  if (state.pendingCutover && !(view.targets || []).some((target) => target && target.to === 'new')) {
    const retry = node('button', 'pill retry', 'נסה שוב את המעבר שלא קיבל תשובה');
    retry.type = 'button';
    retry.id = 'cutoverRetry';
    retry.disabled = state.modeBusy;
    retry.addEventListener('click', () => { promoteToNew(); });
    box.appendChild(retry);
  }

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

  /* ⭐ מועמד מוכן — הפיקוד חייב לדעת שהוא קיים. בלי השורה הזאת,
   * מפקד שאינו אחראי סידור לא היה יכול לגלות שיש סידור שמחכה
   * לאישורו; הוא היה תלוי במצב מקומי במסך של מישהו אחר. */
  const candidate = view && view.candidate;
  if (candidate) {
    const line = 'יש סידור מוכן למעבר: מהדורה ' + candidate.revision
      + ' · ' + (candidate.from || '') + ' עד ' + (candidate.to || '')
      + (candidate.preflight && candidate.preflight.blocked
        ? ' · הבדיקה האחרונה מצאה פערים' : '');
    box.appendChild(node('div', 'sub', line));
  }

  const form = $('modeForm');
  form.hidden = !state.modeTarget;
  if (state.modeTarget) {
    const toNew = state.modeTarget === 'new';
    $('modeConfirmHint').textContent = toNew
      ? 'מעבר לסידור המוכן נבדק מול הסידור הקיים לפני האישור. '
        + 'אם מישהו שמשובץ היום ייעלם — המעבר ייחסם.'
      : 'כדי לאשר, הקלד/י בדיוק: ' + state.modeTarget
        + ' — ההקלדה נשמרת ביומן יחד עם מי ביקש/ה, מתי ומאיזה מצב.';
    // שדות האישור וההקלדה אינם רלוונטיים למעבר, שנשען על הבדיקה.
    $('modeConfirm').hidden = toNew;
    $('modeReason').hidden = toNew;
    if (!toNew) {
      $('modeApply').textContent =
        'העבר את המנוע ל' + (MODE_LABEL[state.modeTarget] || state.modeTarget);
    }
  }
  updateModeApply();
}

function updateModeApply() {
  const retry = document.getElementById('cutoverRetry');
  if (retry) retry.disabled = state.modeBusy;
  /* ⭐ מעבר ל-`new` אינו החלפת מצב ולכן אינו דורש הקלדת אישור וסיבה
   * — הוא דורש **פרסום מוכן**. בלי מועמד אין מה לאשר, והכפתור
   * אומר את זה במקום להיות פעיל ולהיכשל בשרת. */
  if (state.modeTarget === 'new') {
    const candidate = usableCandidate();
    const raw = state.modeView && state.modeView.candidate;
    const pending = state.pendingCutover;
    $('modeApply').disabled = state.modeBusy || (!candidate && !pending);
    if (pending) {
      /* ⭐ 386.3 · הניסיון החוזר מוצג גם כשהמועמד כבר אינו „מוכן" —
       * למשל אחרי commit שהתשובה שלו אבדה. */
      $('modeApply').textContent = 'נסה שוב את המעבר שלא קיבל תשובה';
    } else if (candidate) {
      $('modeApply').textContent = 'בדוק ואשר מעבר לסידור המוכן';
    } else if (raw && raw.ambiguous) {
      /* ⭐ 378.4 · יותר מהכנה אחת — אין „מועמד", ואין publication_id
       * לנחש. המסך אומר מה יש ומה לעשות; הוא אינו מציע כפתור. */
      $('modeApply').textContent = 'יש ' + Number(raw.prepared_count || 0)
        + ' סידורים מוכנים — צריך להישאר אחד לפני המעבר';
    } else {
      $('modeApply').textContent = 'אין סידור מוכן — אחראי/ת סידור צריך/ה להכין אחד';
    }
    return;
  }
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

/* ==================================================================
 * ⭐ המעבר למנוע החדש אינו החלפת מצב
 *
 * `setScheduleRuntimeMode` מזיז מצב ותו לא, והשרת דוחה דרכו כל
 * מעבר ל-`new` בקוד `cutover-required`. המסלול היחיד הוא:
 *
 *   אחראי/ת סידור  → מריץ מנוע ו**מכין** פרסום ב-shadow
 *   פיקוד          → בודק את הפרסום מול הסידור הקיים, ומאשר
 *
 * שתי הסמכויות נפרדות בכוונה: מי שבונה את הסידור אינו מי שמחליט
 * שכל התחנה עוברת אליו.
 * ================================================================== */
/* מועמד שאפשר לפעול עליו: אחד, עם מזהה. `ambiguous` אינו מועמד. */
function usableCandidate() {
  const candidate = state.modeView && state.modeView.candidate;
  if (!candidate || candidate.ambiguous === true) return null;
  if (typeof candidate.publication_id !== 'string' || !candidate.publication_id) return null;
  return candidate;
}

/* ⭐ 378.1 · ניסיון חוזר אחרי תשובה שאבדה. ה-commit אולי הצליח; המצב
 * כבר `new`; preview חדש ייכשל — ולא יגיע ל-replay. לכן קודם שולחים
 * **בדיוק** את מה שנשלח קודם (אותו request_id, אותה חתימה, אותו
 * אישור); השרת מזהה חזרה ומחזיר `duplicate`. הכוונה נשמרת עד תשובה
 * מאומתת, ונמחקת רק אז. */
/* ⭐ 386.2 · תשובה פגומה אינה „הצלחה". הבקשה נמחקת רק כשהשרת החזיר
 * את מה שחוזה ההצלחה מבטיח — ועל **אותו** פרסום שביקשנו. */
function verifiedCutoverResult(pending, raw) {
  const result = raw && typeof raw === 'object' ? raw : null;
  if (!result || result.mode !== 'new'
      || result.publication_id !== pending.candidate_publication_id
      || !Number.isInteger(result.revision) || result.revision < 1
      || typeof result.duplicate !== 'boolean') {
    const error = new Error('השרת החזיר תשובה שאינה תואמת לבקשת המעבר. הבקשה נשמרה לניסיון חוזר.');
    error.code = 'cutover-response-invalid';
    throw error;
  }
  return result;
}

async function promotePending() {
  const pending = state.pendingCutover;
  const result = verifiedCutoverResult(pending, (await call.cutoverPromote(pending)).data);
  state.pendingCutover = null;
  state.cutoverRequestId = null;
  return result;
}

function cutoverSuccessText(result) {
  return 'התחנה עברה לסידור החדש (מהדורה ' + result.revision + ').'
    + (result.duplicate ? ' (הבקשה הזאת כבר בוצעה קודם.)' : '');
}

async function promoteToNew() {
  if (state.modeBusy) return;
  const pending = state.pendingCutover;
  const candidate = usableCandidate();
  /* ⭐ 386.3 · בקשה ממתינה קודמת למועמד: אחרי commit אמיתי הרענון
   * מחזיר `new` בלי מועמד מוכן — והניסיון החוזר חייב להישאר נגיש. */
  if (!pending && !candidate) return;
  state.modeBusy = true;
  updateModeApply();
  let result = null;
  try {
    if (pending) {
      message('modeMessage', 'שולח שוב את המעבר שלא קיבל תשובה…', 'info');
      result = await promotePending();
    } else {
      message('modeMessage', 'בודק את הסידור המוכן מול הסידור הקיים…', 'info');
      const report = (await call.cutoverPreview({
        candidate_publication_id: candidate.publication_id
      })).data;
      if (report.blocked) {
        const why = Object.keys(report.by_reason || {})
          .filter((key) => report.by_reason[key] > 0)
          .map((key) => (REASON_TEXT[key] || key) + ' ' + report.by_reason[key])
          .join(' · ');
        message('modeMessage',
          'המעבר נחסם: ' + (why || 'נמצאו פערים') + '. '
          + 'יש לתקן ולבנות טיוטה חדשה לפני המעבר.', 'err');
        return;
      }
      /* ⭐ שינויי שיבוץ אינם חוסמים — אבל המפקד רואה **כמה**, ועל
       * פני כמה ימים, ומאשר אותם בנפרד. האישור נשלח כחתימת הדוח
       * הזה בדיוק, ולכן אינו חל על דוח אחר. */
      const changes = report.changes || { count: 0, days: [] };
      const changed = Number(changes.count || 0);
      const missing = Number((report.by_reason || {})['preflight-missing'] || 0);
      let accept = null;
      if (changed > 0) {
        const days = (changes.days || []).length;
        if (!confirm('הסידור החדש משנה ' + changed + ' שיבוצים לעומת הסידור הקיים'
          + (days ? ', על פני ' + days + ' ימים' : '') + '.'
          + (missing > 0 ? '\n\nאזהרה: ' + missing + ' שיבוצים של אנשים מהסידור הקיים אינם בסידור החדש '
            + '(אין יום שנשאר ריק). זו אזהרה, לא חסימה — האישור נרשם על חתימת הדוח.' : '')
          + '\n\nלהמשיך?')) return;
        accept = report.signature;
      }
      if (!confirm('להעביר את התחנה לסידור המוכן? '
        + 'מרגע האישור כל התחנה רואה את הסידור החדש, וההודעות שהמתינו נשלחות.')) return;

      /* ⭐ אותו `request_id` נשמר לניסיון חוזר, יחד עם מלוא הכוונה. */
      if (!state.cutoverRequestId) state.cutoverRequestId = requestId('cutover');
      state.pendingCutover = {
        request_id: state.cutoverRequestId,
        candidate_publication_id: candidate.publication_id,
        /* ⭐ החתימה של הדוח ש**הוצג בשורה שלמעלה**, ולא זו שהשרת
         * ימצא על הדיסק ברגע האישור. השרת משווה אותה בתוך העסקה. */
        expected_preflight_signature: report.signature,
        accept_changes: accept,
        expected_mode: state.modeView.current
      };
      result = await promotePending();
    }
  } catch (error) {
    /* ⭐ אין תשובה מאומתת — הכוונה נשארת ב-pendingCutover, והכפתור
     * הבא שולח אותה שוב לפני כל preview. */
    message('modeMessage', 'המעבר לא קיבל תשובה או נדחה. (' + (error.code || error.message) + ') '
      + (state.pendingCutover ? 'אפשר לנסות שוב — אותה בקשה, לא מעבר חדש. ' : '')
      + 'המצב נטען מחדש מהשרת.', 'err');
    try { await refreshAfterModeChange(); } catch (_) { /* הודעה כבר הוצגה */ }
    return;
  } finally {
    /* ⭐ 386.1 · כל יציאה — דוח חסום, ביטול באחד משני האישורים, כשל —
     * משחררת את המסך. הרענון של ההצלחה רץ מחוץ ל-try הזה. */
    if (result === null) {
      state.modeBusy = false;
      updateModeApply();
    }
  }
  /* ⭐ 378.2 · ההצלחה העסקית קודם. כשל ברענון אחרי commit אינו „המעבר
   * נכשל" — הוא „המעבר הצליח, המסך לא התרענן". */
  message('modeMessage', cutoverSuccessText(result), 'ok');
  try {
    await refreshAfterModeChange();
  } catch (_) {
    message('modeMessage', cutoverSuccessText(result)
      + ' מצב המסך לא התרענן; יש לרענן את הדף לפני פעולה נוספת.', 'warn');
  } finally {
    state.modeBusy = false;
    updateModeApply();
  }
}

async function refreshAfterModeChange() {
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
  updateRunAvailability();
}

async function applyModeChange() {
  if (state.modeBusy || !state.modeTarget || !state.modeView) return;
  const target = state.modeTarget;
  const from = state.modeView.current;
  // ⭐ מעבר ל-new אינו עובר כאן. השרת דוחה אותו, והמסך לא מתיימר.
  if (target === 'new') { await promoteToNew(); return; }
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
    await refreshAfterModeChange();
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

const ABSENCE_ROWS = [['sick', 'מחלה'], ['reserve', 'מילואים'], ['course', 'קורסים'], ['leave', 'חופש']];
const ABSENCE_LOCATIONS = new Map([['abroad', 'חו״ל'], ['north', 'צפון'], ['eilat', 'אילת']]);
const CREW_HE = { A: 'א׳', B: 'ב׳', C: 'ג׳' };

function absenceDataReady(day, kind) {
  return day.absences_status === 'ready' && Array.isArray(day.absences)
    && day.absence_coverage && day.absence_coverage[kind] === 'ready'
    && day.absences.every((item) => item && typeof item === 'object'
      && typeof item.uid === 'string' && item.uid.length > 0
      && typeof item.display === 'string' && item.display.trim().length > 0);
}

function absenceKind(item) {
  return ABSENCE_ROWS.some(([kind]) => kind === item.kind) ? item.kind : 'unknown';
}

/* שורות ההיעדרות בתחתית הלוח — כמו בתחתית הגיליון. חודש שלא הודבק
 * (הסידור הקיים) אינו יודע היעדרויות: התאים ריקים והערה אחת מתחת
 * ללוח אומרת זאת — לא הודעה בכל תא. */
function appendAbsenceRows(board, days) {
  const rows = ABSENCE_ROWS.slice();
  rows.forEach(([kind, label], rowIndex) => {
    const ariaRow = node('div', 'board-row');
    ariaRow.setAttribute('role', 'row');
    const stub = node('div', 'stub absence absence-stub');
    stub.setAttribute('role', 'rowheader');
    stub.appendChild(node('b', '', label));
    ariaRow.appendChild(stub);
    days.forEach((day, index) => {
      const ready = absenceDataReady(day, kind);
      // „אין נתון" (חודש שלא הודבק) אינו „אף אחד" (רשימה ריקה מאומתת):
      // הראשון תא מקווקו בלי סימן, השני מקף. ההסבר — פעם אחת מתחת ללוח.
      const cell = node('div', 'cell absence-cell' + (rowIndex === 0 ? ' first' : '')
        + (ready ? '' : ' unknown') + (index % 7 === 0 ? ' snap' : ''));
      cell.setAttribute('role', 'gridcell');
      cell.dataset.absenceKind = kind;
      cell.dataset.date = day.date;
      if (!ready) cell.title = 'אין נתון: החודש הזה לא הודבק מהגיליון';
      const people = ready ? day.absences.filter((item) => absenceKind(item) === kind) : [];
      people.forEach((item) => {
        const row = node('div', 'nm absence-name' + (item.is_me ? ' me' : ''), item.display);
        if (kind === 'leave' && ABSENCE_LOCATIONS.has(item.location)) {
          row.appendChild(node('span', 'absence-location', ABSENCE_LOCATIONS.get(item.location)));
        }
        cell.appendChild(row);
      });
      if (ready && !people.length) cell.appendChild(node('span', 'absence-empty', '—'));
      ariaRow.appendChild(cell);
    });
    board.appendChild(ariaRow);
  });
}

function absenceNote(days) {
  if (!days || !days.length) return '';
  const ready = days.filter((day) => ABSENCE_ROWS.every(([kind]) => absenceDataReady(day, kind))).length;
  if (ready === days.length) return '';
  return ready === 0
    ? ' שורות ההיעדרות מתמלאות מהסידור שמודבק מהגיליון; החודש הזה עדיין לא הודבק.'
    : ' חלק מהימים בטווח לא הודבקו מהגיליון, ולכן שורות ההיעדרות שלהם ריקות.';
}

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
  const labels = new Map();
  (days || []).forEach((day) => (day.sub_stations || []).forEach((sub) => {
    if (!labels.has(sub.sub_station)) labels.set(sub.sub_station, sub.label || sub.sub_station);
  }));
  if (state.policy) {
    Object.keys(state.policy.sub_stations).forEach((id) => {
      if (!labels.has(id)) labels.set(id, state.policy.sub_stations[id].label || id);
    });
  }
  // הקו של כל תחנה: מהמדיניות כשהיא טעונה (אחראי סידור), אחרת מהשורות
  // עצמן — השרת מצרף לכל בלוק את הקו שנחתם בפרסום. קו 0 = אין קו.
  const minimums = new Map();
  (days || []).forEach((day) => (day.sub_stations || []).forEach((sub) => {
    if (!minimums.has(sub.sub_station) && Number.isInteger(sub.minimum)) minimums.set(sub.sub_station, sub.minimum);
  }));
  const lineOf = (id) => {
    const value = state.policy && state.policy.sub_stations[id]
      ? state.policy.sub_stations[id].minimum
      : (minimums.has(id) ? minimums.get(id) : null);
    return Number.isInteger(value) && value > 0 ? value : null;
  };
  return FIXED_STATIONS.map((station) => ({
    id: station.id,
    label: station.label,
    minimum: lineOf(station.id) === null ? station.minimum : lineOf(station.id)
  }));
}

// „הסידור שלי" נשאר שימושי גם כשהמנוע כבוי: במצב legacy אין מיפוי
// אמין ממשמרת א/ב/ג לתחנת קצה, ולכן מציגים שם את שורת המשמרת האישית
// כפי שהשרת החזיר. בלוח התחנתי לעולם לא משתמשים ברשימה הזאת.
function legacySubOrder(days) {
  const seen = [];
  const labels = new Map();
  (days || []).forEach((day) => (day.sub_stations || []).forEach((sub) => {
    if (!sub || !sub.sub_station) return;
    if (!seen.includes(sub.sub_station)) seen.push(sub.sub_station);
    if (!labels.has(sub.sub_station)) labels.set(sub.sub_station, sub.label || sub.sub_station);
  }));
  return seen.map((id) => ({ id, label: labels.get(id) || id, minimum: null }));
}

function cellContent(cell, block, sub) {
  const people = (block && block.people) || [];
  const missing = !block || block.coverage === 'missing';
  const declared = block && block.minimum !== undefined && block.minimum !== null
    ? block.minimum : sub.minimum;
  // קו 0 (או חסר) = „אין קו": אין קו אדום ואין „מתחת לקו".
  const minimum = Number.isInteger(declared) && declared > 0 ? declared : null;

  if (missing) {
    cell.classList.add('unknown');
    cell.title = 'לא הוזן סידור לתחנה ביום הזה';
    cell.appendChild(node('span', 'absence-empty', 'לא הוזן'));
  }
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
    if (['A', 'B', 'C'].includes(person.crew)) {
      row.classList.add('crew-' + person.crew);
      row.title = 'משמרת ' + ({ A: 'א', B: 'ב', C: 'ג' })[person.crew];
    }
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
  if (!subs.length && opts.showAbsences !== true) {
    target.appendChild(node('div', 'empty', 'אין תחנות קצה להצגה.'));
    return;
  }

  const board = node('div', 'board');
  board.id = opts.id || 'board';
  board.setAttribute('role', 'grid');
  board.setAttribute('aria-label', opts.ariaLabel || 'סידור תחנתי');
  board.style.setProperty('--n', String(days.length));
  const headerRow = node('div', 'board-row');
  headerRow.setAttribute('role', 'row');
  const corner = node('div', 'corner');
  corner.setAttribute('role', 'columnheader');
  corner.setAttribute('aria-label', 'תחנת קצה');
  headerRow.appendChild(corner);

  // צוות היום (משמרת = יממה) מגיע מהשרת: `day.crew`. הוא צובע את העמודה
  // כולה ומופיע כאות בכותרת — כמו בגיליון. בלי צוות ידוע — עמודה ניטרלית.
  const dayCrew = (day) => (['A', 'B', 'C'].includes(day.crew) ? day.crew : null);
  days.forEach((day, index) => {
    const head = node('div', 'hcell' + (isWeekend(day.date) ? ' we' : '')
      + (index % 7 === 0 ? ' snap' : ''));
    head.setAttribute('role', 'columnheader');
    head.appendChild(node('div', 'dw', DOW[new Date(day.date + 'T00:00:00.000Z').getUTCDay()]));
    head.appendChild(node('div', 'dd',
      Number(day.date.slice(8, 10)) + '/' + Number(day.date.slice(5, 7))));
    const crew = dayCrew(day);
    const chip = node('span', 'crew' + (crew ? ' crew-' + crew : ''), crew ? 'משמרת ' + CREW_HE[crew] : '—');
    chip.title = crew ? 'המשמרת שעובדת ביממה הזאת' : 'המשמרת של היום אינה ידועה';
    head.appendChild(chip);
    headerRow.appendChild(head);
  });
  board.appendChild(headerRow);

  subs.forEach((sub, subIndex) => {
    const ariaRow = node('div', 'board-row');
    ariaRow.setAttribute('role', 'row');
    const stub = node('div', 'stub ' + subClass(subIndex));
    stub.setAttribute('role', 'rowheader');
    stub.appendChild(node('b', '', sub.label));
    stub.appendChild(node('small', '',
      sub.minimum === null || sub.minimum === undefined ? 'אין קו' : 'קו ' + sub.minimum));
    ariaRow.appendChild(stub);

    days.forEach((day, index) => {
      const crew = dayCrew(day);
      const cell = node('div', 'cell ' + (crew ? 'col-' + crew : subClass(subIndex)) + (index % 7 === 0 ? ' snap' : ''));
      cell.setAttribute('role', 'gridcell');
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
      ariaRow.appendChild(cell);
    });
    board.appendChild(ariaRow);
  });

  if (opts.showAbsences !== false) appendAbsenceRows(board, days);
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
    renderBoard(box, view.days, { id: 'stationBoard', showAbsences: true });
    watchWeekLabel('stationBoard', 'stationWeek', (view.days || []).length);
    $('stationNote').textContent = (view.source === 'legacy'
      ? 'הלוח מוצג מהסידור הקיים — החודש הזה עדיין לא הודבק מהגיליון.'
      : view.source === 'imported-display'
        ? 'הלוח מוצג מקובץ הסידור שיובא. המנוע נשאר ' + view.mode + ' וחישובי המערכת לא הוחלפו.'
        : (view.imported ? 'הלוח מוצג מהגיליון שהודבק' : 'הלוח מוצג מהסידור שפורסם') + ' · גרסה ' + (view.revision || '—') + '.')
      + absenceNote(view.days) + guardsNotice(view.days);
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
    renderBoard(box, days, { id: 'mineBoard',
      subs: view.source === 'legacy' ? legacySubOrder(days) : undefined,
      onlySub: view.source === 'legacy' ? undefined : (only || undefined), showAbsences: false,
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
      resetPublishRequest();
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

/* ==================================================================
 * הדבקת הסידור מהגיליון (הכרעת אלדד 4.9 — „אפשרות ב׳")
 *
 * הגיליון הוא מסד הנתונים. אחראי הסידור מדביק אותו כמות שהוא; השרת
 * מפרק לפי התוויות, מדווח מה זוהה ומה לא, ואחרי התאמת שמות מייבא
 * **כטיוטה** — אותה תצוגה מקדימה ואותו כפתור פרסום. המנוע אינו מריץ
 * כללים על הגיליון. שם שלא זוהה מוצג פעם אחת; ההתאמה נשמרת בשרת.
 * ================================================================== */
/* ההתאמות נצברות במסך בין בדיקה לבדיקה: אחרי שהשרת אישר שם, השורה
 * שלו נעלמת מהדוח — אבל ההתאמה חייבת להישלח גם בייבוא. השרת שומר
 * אותן לחודשים הבאים; המסך מנקה אותן כשמדביקים גיליון אחר. */
function importAliases() {
  const out = Object.assign({}, state.importAliases || {});
  document.querySelectorAll('#importUnresolved select[data-name]').forEach((select) => {
    const value = select.value;
    if (value === '') return;
    out[select.dataset.name] = value === '__ignore__' ? null : value;
  });
  state.importAliases = out;
  return out;
}

function canonicalPolicyReady() {
  return !!(state.policy && FIXED_STATIONS.every((station) =>
    Object.prototype.hasOwnProperty.call(state.policy.sub_stations || {}, station.id)));
}

function renderImportStationMap() {
  const wrap = $('importStationMap');
  const grid = $('importStationMapGrid');
  clear(grid);
  if (!state.policy || canonicalPolicyReady()) {
    wrap.hidden = true;
    state.importStationMap = null;
    $('importStationMapConfirm').checked = false;
    return;
  }
  wrap.hidden = false;
  const existing = Object.keys(state.policy.sub_stations || {}).sort();
  const current = state.importStationMap || {};
  FIXED_STATIONS.forEach((station) => {
    const label = node('label', '', station.label);
    const select = node('select');
    select.dataset.stationId = station.id;
    const choose = node('option', '', '— בחר/י —'); choose.value = ''; select.appendChild(choose);
    existing.forEach((id) => {
      const old = state.policy.sub_stations[id] || {};
      const option = node('option', '', (old.label || id) + ' (' + id + ')');
      option.value = id;
      select.appendChild(option);
    });
    const none = node('option', '', 'אין תחנה ישנה'); none.value = '__none__'; select.appendChild(none);
    if (Object.prototype.hasOwnProperty.call(current, station.id)) {
      select.value = current[station.id] === null ? '__none__' : current[station.id];
    } else {
      const exact = existing.find((id) => String((state.policy.sub_stations[id] || {}).label || '').trim() === station.label);
      if (exact) { select.value = exact; current[station.id] = exact; }
    }
    select.addEventListener('change', () => {
      const next = Object.assign({}, state.importStationMap || {});
      if (select.value === '') delete next[station.id];
      else next[station.id] = select.value === '__none__' ? null : select.value;
      state.importStationMap = next;
      $('importStationMapConfirm').checked = false;
      invalidateImportReport();
    });
    label.appendChild(select);
    grid.appendChild(label);
  });
  state.importStationMap = current;
}

function importStationMap() {
  if (canonicalPolicyReady()) return null;
  if (!state.policy) throw new Error('חסרים חוקי תחנה פעילים.');
  const mapping = state.importStationMap || {};
  if (FIXED_STATIONS.some((station) => !Object.prototype.hasOwnProperty.call(mapping, station.id))) {
    throw new Error('יש לבחור מיפוי לכל ארבע התחנות.');
  }
  const chosen = FIXED_STATIONS.map((station) => mapping[station.id]).filter((value) => value !== null);
  if (new Set(chosen).size !== chosen.length) throw new Error('אי אפשר למפות תחנה ישנה אחת לשתי תחנות חדשות.');
  if (!$('importStationMapConfirm').checked) throw new Error('יש לאשר שבדקת את מיפוי התחנות.');
  return mapping;
}

function importInput() {
  const month = $('importMonth').value;
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('יש לבחור חודש לייבוא.');
  const input = { month, aliases: importAliases(), accept: {
    missing_stations: $('importAcceptMissing').checked === true,
    ignored_blocks: $('importAcceptIgnored').checked === true
  } };
  const stationMap = importStationMap();
  if (stationMap) input.station_map = stationMap;
  if (Array.isArray(state.importMatrix)) input.matrix = state.importMatrix;
  else {
    const paste = $('importPaste').value;
    if (!paste.trim()) throw new Error('צריך לבחור קובץ או להדביק את הגיליון.');
    input.paste = paste;
  }
  return input;
}

/* כל שינוי בקלט — חודש, הדבקה, התאמה, אישור — מבטל את הדוח: הייבוא
 * מותר רק על הדוח שהשרת חתם לקלט הזה בדיוק (`expected_report_digest`). */
function invalidateImportReport() {
  state.importReport = null;
  $('importRun').disabled = !state.importPending;
  if (state.importPending) { message('importMessage', pendingImportText(), 'warn'); return; }
  if (!$('importReport').hidden) message('importMessage', 'הקלט השתנה — יש ללחוץ שוב על „בדוק את ההדבקה" לפני הייבוא.', 'info');
}

/* ⭐ final-review §2 · ניסיון ממתין: תשובת ייבוא שאבדה אחרי שהשרת אולי כבר
 * יצר את הטיוטה. ה-payload המלא ומזהה הבקשה נשמרים; „ייבא" הבא שולח
 * **בדיוק** אותם — לפני כל דוח או בקשה חדשים — והשרת מחזיר את הקבלה
 * המקורית (גם אם בינתיים השתנה כינוי שאינו קשור). הניסיון נמחק רק אחרי
 * תשובה מאומתת: הצלחה, או סירוב מפורש של השרת (schedule_code). */
function pendingImportText() {
  return 'התשובה על הייבוא לא הגיעה. לחץ שוב על „ייבא כטיוטה" — אותה בקשה בדיוק תישלח שוב, ולא תיווצר טיוטה שנייה.';
}

function renderImportReport(report) {
  const wrap = $('importReport');
  wrap.hidden = false;
  const counts = $('importCounts'); clear(counts);
  const c = report.counts || {};
  [['ימים', c.days || 0], ['שיבוצים', c.assignments || 0], ['היעדרויות', c.absences || 0],
    ['ימים מתחת לקו', c.below_minimum || 0], ['שמות לא מזוהים', c.unresolved || 0], ['כפילויות', c.duplicates || 0]]
    .forEach(([label, value]) => {
      const metric = node('div', 'metric');
      metric.append(node('b', '', value), node('span', '', label));
      counts.appendChild(metric);
    });
  const blocks = $('importBlocks'); clear(blocks);
  (report.blocks || []).forEach((block) => {
    const label = block.label || '(בלי תווית)';
    const text = block.kind === 'station' ? label + ' · ' + block.names + ' שיבוצים'
      : block.kind === 'absence' ? label + ' · ' + block.names
      : label + ' · שורות ' + block.rows[0] + '–' + block.rows[1] + ' לא יובאו';
    const tag = node('span', 'blocktag ' + block.kind, text);
    tag.title = 'שורות ' + block.rows[0] + '–' + block.rows[1] + ' בגיליון';
    blocks.appendChild(tag);
  });
  const unresolvedWrap = $('importUnresolvedWrap');
  const list = $('importUnresolved'); clear(list);
  const unresolved = report.unresolved || [];
  unresolvedWrap.hidden = !unresolved.length;
  unresolved.forEach((item) => {
    const row = node('div', 'row');
    const who = node('div');
    who.appendChild(node('b', '', item.name));
    who.appendChild(node('small', '', item.count + ' פעמים · ' + item.dates.slice(0, 3).map(dateLabel).join(', ')
      + (item.dates.length > 3 ? '…' : '')));
    row.appendChild(who);
    const select = node('select');
    select.dataset.name = item.name;
    const choose = node('option', '', '— בחר —'); choose.value = ''; select.appendChild(choose);
    const candidates = (item.candidates || []).length ? item.candidates : (report.people || []);
    candidates.forEach((person) => {
      const option = node('option', '', person.name); option.value = person.uid; select.appendChild(option);
    });
    if ((item.candidates || []).length) {
      const rest = node('optgroup'); rest.label = 'כל הסגל';
      (report.people || []).forEach((person) => {
        if (item.candidates.some((cand) => cand.uid === person.uid)) return;
        const option = node('option', '', person.name); option.value = person.uid; rest.appendChild(option);
      });
      select.appendChild(rest);
    }
    const ignore = node('option', '', 'זה לא שם (למשל „אבטחה")'); ignore.value = '__ignore__'; select.appendChild(ignore);
    row.appendChild(select);
    row.appendChild(node('span', 'atright', (item.candidates || []).length ? 'דו-משמעי' : 'לא נמצא'));
    list.appendChild(row);
  });
  const dups = $('importDuplicates'); clear(dups);
  (report.duplicates || []).forEach((item) => {
    dups.appendChild(node('div', 'change weak',
      item.name + ' מופיע ב-' + dateLabel(item.date) + ' בשתי תחנות: ' + item.blocks.join(' + ') + ' — יש לתקן בגיליון.'));
  });
  (report.warnings || []).forEach((warning) => {
    if (warning.code === 'block-ignored') return;   // כבר מוצג כתגית מחוקה
    dups.appendChild(node('div', 'change ' + (warning.code === 'cell-too-many-names' ? 'weak' : 'warn'), warning.detail || warning.code));
  });
  // חסר אינו ריק: תחנה בלי בלוק, ובלוק עם שמות שלא יובא — דורשים אישור מפורש.
  const missing = report.missing_stations || [];
  const ignoredNames = (report.counts || {}).ignored_names || 0;
  $('importAcceptMissingWrap').hidden = !missing.length;
  $('importAcceptMissingText').textContent = missing.length
    ? 'ראיתי שאין בהדבקה בלוק ל-' + missing.map((m) => m.label).join(', ') + ' — התחנות האלה לא יופיעו בסידור של החודש הזה, ואני מאשר/ת.' : '';
  $('importAcceptIgnoredWrap').hidden = !ignoredNames;
  $('importAcceptIgnoredText').textContent = ignoredNames
    ? 'ראיתי ש-' + ignoredNames + ' שמות באזור שלא זוהה (שורות ' + (report.ignored || []).map((b) => b.rows[0] + '–' + b.rows[1]).join(', ') + ') לא ייכנסו לסידור, ואני מאשר/ת.' : '';
}

function importBlockedText(report) {
  const why = report.blocked_by || [];
  if (why.indexOf('no-assignments') !== -1) return 'לא נמצא אף שיבוץ. האם החודש נכון והתוויות בעמודה הימנית?';
  if (why.indexOf('oversized-cells') !== -1) return 'יש תא עם יותר מדי שמות — יש לפצל אותו בגיליון ולהדביק שוב.';
  if (why.indexOf('duplicates') !== -1) return 'יש כפילויות — אדם שמופיע בשתי תחנות באותו יום. יש לתקן בגיליון ולהדביק שוב.';
  if (why.indexOf('unresolved') !== -1) return 'יש שמות שלא זוהו. התאם אותם למטה ולחץ שוב על „בדוק את ההדבקה".';
  if (why.indexOf('missing-stations') !== -1 || why.indexOf('ignored-blocks') !== -1) return 'יש תחנות חסרות או שמות שלא ייכנסו. סמן שראית, ולחץ שוב על „בדוק את ההדבקה".';
  return 'הייבוא חסום.';
}

async function checkImport() {
  if (state.busy) return;
  let input;
  try { input = importInput(); } catch (error) { message('importMessage', error.message, 'err'); return; }
  state.busy = true; $('importCheck').disabled = true; $('importRun').disabled = true;
  message('importMessage', 'קורא את ההדבקה…', 'info');
  try {
    const report = (await call.importPreview(input)).data;
    state.importReport = report;
    renderImportReport(report);
    if (report.blocked) {
      message('importMessage', importBlockedText(report), 'warn');
    } else {
      message('importMessage', 'ההדבקה תקינה: ' + report.counts.assignments + ' שיבוצים ו-' + report.counts.absences
        + ' היעדרויות ל-' + report.counts.days + ' ימים (' + dateLabel(report.from) + ' — ' + dateLabel(report.to) + '). אפשר לייבא.', 'ok');
    }
    $('importRun').disabled = !state.importPending && (report.blocked === true || !canManageSchedule());
    if (state.importPending) message('importMessage', pendingImportText(), 'warn');
  } catch (error) {
    state.importReport = null;
    $('importReport').hidden = true;
    message('importMessage', errorText(error), 'err');
    $('importRun').disabled = !state.importPending;
  } finally { state.busy = false; $('importCheck').disabled = false; }
}

async function importSheet() {
  if (state.busy) return;
  const pending = state.importPending;
  if (!pending && (!state.importReport || state.importReport.blocked)) return;
  let payload;
  if (pending) {
    payload = pending.payload;   // אותה בקשה בדיוק — לא נקרא הקלט מחדש
  } else {
    let input;
    try { input = importInput(); } catch (error) { message('importMessage', error.message, 'err'); return; }
    // מזהה הניסיון נקשר לחתימת הדוח: ניסיון חוזר אחרי תשובה שאבדה משתמש
    // באותו מזהה, והשרת מחזיר את אותה טיוטה במקום ליצור שנייה.
    const reportDigest = state.importReport.report_digest;
    state.importRequestIds = state.importRequestIds || {};
    if (!state.importRequestIds[reportDigest]) state.importRequestIds[reportDigest] = requestId('import');
    payload = Object.assign({ request_id: state.importRequestIds[reportDigest], expected_report_digest: reportDigest }, input);
  }
  state.busy = true; $('importRun').disabled = true; $('importCheck').disabled = true;
  state.draft = null; state.draftPreview = null;
  resetPublishRequest();
  $('publish').disabled = true; $('reviewDraft').checked = false; $('reviewDraft').disabled = true;
  $('draftPreviewCard').classList.add('hide');
  message('importMessage', pending ? 'שולח שוב את אותה בקשת ייבוא…' : 'מייבא את הגיליון כטיוטה…', 'info');
  state.importPending = { payload };
  try {
    const result = (await call.importSheet(payload)).data;
    state.importPending = null;
    state.draft = result;
    state.importedDraft = result;
    renderSummary(result.summary || {});
    message('importMessage', 'הגיליון יובא כטיוטה (' + dateLabel(result.from) + ' — ' + dateLabel(result.to)
      + '). לא הופעל מנוע ולא נשלחה הודעה. בדוק אותה למטה ואז לחץ „הצג בלוח”.', 'ok');
    message('runMessage', 'הטיוטה שלמטה יובאה מהגיליון.', 'info');
    await loadDraftPreview(result.from, true);
    $('draftPreviewCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    if (errorCode(error)) {
      // סירוב מפורש של השרת — הבקשה נענתה; אין מה לשלוח שוב.
      state.importPending = null;
      message('importMessage', errorText(error), 'err');
    } else {
      // כשל תקשורת עמום — ייתכן שהטיוטה כבר נוצרה. הניסיון נשאר לשליחה חוזרת.
      message('importMessage', pendingImportText() + ' (' + errorText(error) + ')', 'warn');
    }
  } finally {
    state.busy = false; $('importCheck').disabled = false;
    $('importRun').disabled = !state.importPending;
    updateImportDisplayAvailability();
    updatePublishAvailability();
  }
}

function displayRequestId(action, month, generation, draftId, contentDigest) {
  const key = JSON.stringify([action, month, generation, draftId || '', contentDigest || '']);
  if (!state.displayRequestIds[key]) state.displayRequestIds[key] = requestId('display');
  return state.displayRequestIds[key];
}

function renderImportDisplayStatus() {
  const status = state.importDisplay;
  const active = status && status.enabled === true;
  $('importClear').hidden = !active;
  $('importDisplayStatus').textContent = active
    ? 'הסידור המיובא מוצג כעת בלוח של ' + status.month + '. המנוע לא הופעל ולא נשלחו התראות.'
    : 'אין סידור מיובא שנבחר להצגה בחודש הזה. הייבוא אינו מפעיל את המנוע ואינו שולח התראות.';
  updateImportDisplayAvailability();
}

function updateImportDisplayAvailability() {
  const draft = state.importedDraft;
  const month = $('importMonth').value;
  const mayDisplay = canManageSchedule() && state.status
    && ['off', 'shadow'].indexOf(state.status.mode) !== -1;
  $('importShow').disabled = state.busy || !mayDisplay || !draft
    || String(draft.from || '').slice(0, 7) !== month || !draft.content_digest;
  $('importClear').disabled = state.busy || !mayDisplay
    || !state.importDisplay || state.importDisplay.enabled !== true;
}

async function loadImportDisplayStatus(month) {
  if (!canManageSchedule() || !/^\d{4}-\d{2}$/.test(String(month || ''))) return;
  try {
    state.importDisplay = (await call.displayStatus({ month })).data;
    renderImportDisplayStatus();
  } catch (error) {
    state.importDisplay = null;
    $('importClear').hidden = true;
    $('importDisplayStatus').textContent = 'לא ניתן לבדוק איזה סידור מיובא מוצג: ' + errorText(error);
    updateImportDisplayAvailability();
  }
}

async function showImportedSchedule() {
  if (state.busy || $('importShow').disabled || !state.importedDraft) return;
  const draft = state.importedDraft;
  const month = $('importMonth').value;
  if (!state.importDisplay || state.importDisplay.month !== month) {
    await loadImportDisplayStatus(month);
  }
  if (!state.importDisplay) return;
  const generation = Number(state.importDisplay.generation || 0);
  state.busy = true;
  updateImportDisplayAvailability();
  message('importMessage', 'מחבר את הסידור המיובא ללוח החודש…', 'info');
  try {
    const result = (await call.displaySet({
      action: 'show', month,
      request_id: displayRequestId('show', month, generation, draft.draft_id, draft.content_digest),
      expected_generation: generation,
      draft_id: draft.draft_id,
      expected_content_digest: draft.content_digest
    })).data;
    state.importDisplay = result;
    renderImportDisplayStatus();
    message('importMessage', 'הסידור מוצג עכשיו בלוח. מצב המנוע נשאר '
      + state.status.mode + ' ולא נשלחה שום התראה.', 'ok');
    invalidateRange();
    await loadStationRange(month);
  } catch (error) {
    message('importMessage', errorText(error), 'err');
    await loadImportDisplayStatus(month);
  } finally {
    state.busy = false;
    updateImportDisplayAvailability();
  }
}

async function clearImportedSchedule() {
  if (state.busy || $('importClear').disabled || !state.importDisplay) return;
  const month = $('importMonth').value;
  const generation = Number(state.importDisplay.generation || 0);
  state.busy = true;
  updateImportDisplayAvailability();
  message('importMessage', 'מסיר את הסידור המיובא מתצוגת הלוח…', 'info');
  try {
    const result = (await call.displaySet({
      action: 'clear', month,
      request_id: displayRequestId('clear', month, generation, null, null),
      expected_generation: generation
    })).data;
    state.importDisplay = result;
    renderImportDisplayStatus();
    message('importMessage', 'הסידור המיובא הוסר מהלוח. נתוני הייבוא עצמם נשמרו ולא נמחקו.', 'ok');
    invalidateRange();
    await loadStationRange(month);
  } catch (error) {
    message('importMessage', errorText(error), 'err');
    await loadImportDisplayStatus(month);
  } finally {
    state.busy = false;
    updateImportDisplayAvailability();
  }
}

function renderSummary(summary) {
  const box = $('draftSummary'); clear(box); box.classList.remove('hide');
  const imported = summary.imported_below_minimum !== undefined;
  const values = imported ? [
    ['שובצו', summary.filled || 0], ['היעדרויות', summary.imported_absences || 0],
    ['ימים מתחת לקו', summary.imported_below_minimum || 0], ['יובא מהגיליון', 'כמות שהוא']
  ] : [
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
    ? 'הכן את הסידור' : 'פרסום הסידור';
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
  renderBoard(box, preview.days || [], { id: 'draftBoard', showAbsences: true,
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
  resetPublishRequest();
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
  if (!state.status || ['shadow', 'new'].indexOf(state.status.mode) === -1 || state.busy ||
      !state.draft || !state.draftPreview || !$('reviewDraft').checked) return;
  const preparing = state.status.mode === 'shadow';
  const gaps = Number((state.draft.summary || {}).blocking_gaps || 0);
  if (gaps > 0) { message('publishMessage', 'אי אפשר לפרסם: בטיוטה יש חוסרים חוסמים.', 'err'); return; }
  const confirmation = preparing
    ? 'להכין את הטיוטה לבדיקה? הסידור הקיים יישאר פעיל ולא תישלח הודעה לאיש.'
    : 'לפרסם את הטיוטה? הסידור יהפוך לפעיל והמשתמשים הרלוונטיים יקבלו עדכון.';
  if (!confirm(confirmation)) return;
  state.busy = true; $('publish').disabled = true;
  message('publishMessage', preparing
    ? 'מכין את הסידור לבדיקה בלבד…' : 'מפרסם את הסידור בפעולה אחת…', 'info');
  try {
    const draftId = state.draft.draft_id;
    const expectedContentDigest = state.draftPreview.expected_content_digest;
    const intent = preparing ? 'prepare' : 'publish';
    const result = (await call.publish({
      draft_id: draftId,
      expected_content_digest: expectedContentDigest,
      request_id: requestIdForPublication(draftId, expectedContentDigest, intent)
    })).data;
    if (preparing && (result.prepared !== true || result.notified_people !== 0)) {
      throw new Error('השרת לא אישר שהסידור הוכן בלבד וללא הודעות. יש לרענן לפני ניסיון נוסף.');
    }
    const successText = preparing
      ? 'הסידור הוכן לבדיקה בלבד. הוא לא הופעל, הסידור הקיים נשאר פעיל ולא נשלחו הודעות.'
      : 'הסידור פורסם בהצלחה. נוצרו ' + result.notified_people + ' עדכונים לשליחה.';
    message('publishMessage', successText, 'ok');
    resetPublishRequest();
    state.draft = null;
    state.draftPreview = null;
    state.previewStart = null;
    $('reviewDraft').checked = false;
    $('reviewDraft').disabled = true;
    $('draftPreviewCard').classList.add('hide');
    clear($('draftSummary'));
    $('draftSummary').classList.add('hide');
    invalidateRange();
    try {
      state.status = (await call.status({})).data;
      setMode(state.status); setRollbackAvailability();
      await Promise.all([loadMine(), loadMineRange(), loadStationRange()]);
      // ⭐ E (seq379) · אחרי הכנה המועמד קיים; מי שיש לו גם סמכות פיקוד
      // רואה אותו מיד, בלי לרענן את הדף.
      if (preparing && state.modeView && state.modeView.may_change === true) await loadModeOptions();
    } catch (_) {
      // The write already succeeded. Never invite a second write by presenting
      // a refresh failure as a failed prepare/publish operation.
      message('publishMessage', successText
        + ' מצב המסך לא התרענן; יש לרענן את הדף לפני פעולה נוספת.', 'warn');
    }
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
    renderImportStationMap();
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
    if (!$('importMonth').value) $('importMonth').value = monthStart();
    state.month = monthStart();
    showScheduleViews();
    await Promise.all([loadSetup(), loadModeOptions(), loadImportDisplayStatus($('importMonth').value)]);
    updateImportDisplayAvailability();
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
$('importCheck').addEventListener('click', managerAction(checkImport));
$('importPaste').addEventListener('input', () => {
  state.importAliases = {};
  state.importMatrix = null;
  state.importFileName = null;
  state.importedDraft = null;
  $('importFile').value = '';
  state.importSelectedFile = null;
  $('importFileStatus').textContent = 'מצב הדבקה ידנית.';
  invalidateImportReport();
});
async function loadImportFile(file) {
  state.importAliases = {};
  state.importMatrix = null;
  state.importFileName = null;
  state.importedDraft = null;
  state.importSelectedFile = file || null;
  if (!file) {
    $('importFileStatus').textContent = 'לא נבחר קובץ. אפשר לבחור XLSX, CSV או TSV.';
    invalidateImportReport();
    return;
  }
  $('importFileStatus').textContent = 'קורא את הקובץ…';
  try {
    const month = $('importMonth').value;
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('יש לבחור חודש לפני בחירת הקובץ.');
    const result = await readScheduleFile(file, { month });
    state.importMatrix = result.matrix;
    state.importFileName = result.name;
    $('importPaste').value = '';
    $('importFileStatus').textContent = result.name
      + (result.sheet ? ' · גיליון ' + result.sheet : '')
      + (result.month ? ' · ' + result.month : '')
      + ' · ' + result.matrix.length + ' שורות · נקרא מקומית';
    message('importMessage', 'הקובץ נקרא. לחץ/י על „בדוק תצוגה מקדימה" כדי לראות מה ייובא.', 'info');
  } catch (error) {
    $('importFile').value = '';
    state.importSelectedFile = null;
    $('importFileStatus').textContent = 'הקובץ לא נקרא.';
    message('importMessage', errorText(error), 'err');
  }
  invalidateImportReport();
}
$('importFile').addEventListener('change', async () => {
  const file = $('importFile').files && $('importFile').files[0];
  await loadImportFile(file);
});
$('importMonth').addEventListener('change', async () => {
  invalidateImportReport();
  state.importedDraft = null;
  updateImportDisplayAvailability();
  const file = state.importSelectedFile;
  if (file) {
    $('importFileStatus').textContent = 'החודש השתנה — קורא שוב את קובץ ה-Excel…';
    try {
      const result = await readScheduleFile(file, { month:$('importMonth').value });
      state.importMatrix = result.matrix;
      state.importFileName = result.name;
      $('importFileStatus').textContent = result.name + ' · ' + result.matrix.length + ' שורות · נקרא מקומית';
    } catch (error) {
      state.importMatrix = null;
      $('importFileStatus').textContent = 'הקובץ לא נקרא לחודש שנבחר.';
      message('importMessage', errorText(error), 'err');
    }
  }
  await loadImportDisplayStatus($('importMonth').value);
});
$('importAcceptMissing').addEventListener('change', invalidateImportReport);
$('importAcceptIgnored').addEventListener('change', invalidateImportReport);
$('importStationMapConfirm').addEventListener('change', invalidateImportReport);
$('importUnresolved').addEventListener('change', invalidateImportReport);
$('importRun').addEventListener('click', managerAction(importSheet));
$('importShow').addEventListener('click', managerAction(showImportedSchedule));
$('importClear').addEventListener('click', managerAction(clearImportedSchedule));
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
