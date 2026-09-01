'use strict';

// =====================================================================
//  אירועי אבטחה בסידור · היטל בטוח
//
//  **מודול טהור.** אין Firebase, אין רשת, אין I/O, אין שעון, אין
//  אקראיות, אין תלות חדשה. הוא מקבל מסמכי אבטחה **שכבר נקראו
//  מהתחנה הנכונה** ומחזיר את מה שמותר להגיע למסך.
//
//  התובנה שמארגנת את הכול
//  -----------------------
//  **מסמך אבטחה נושא הרבה יותר ממה שסידור צריך.** יש בו הערות,
//  מיקום, הרשמות, כשירויות נדרשות ומי יצר אותו. כל אלה נכתבו
//  למסך האבטחות, שבו יש להם הקשר — ואין להם שום עסק בסידור.
//
//  לכן המודול אינו „מסיר שדות רגישים". **הוא בונה עצם חדש
//  משבעה שדות מותרים בלבד.** ההבדל אינו סגנוני: הסרה היא רשימה
//  שתופסת רק את מה שחשבו עליו מראש, ושדה שיתווסף למסמך מחר
//  יזלוג דרכה. בנייה מרשימה לבנה אינה יכולה לזלוג.
//
//  והמיפוי שאסור שייבלע
//  ---------------------
//  במסמך האבטחה השדה נקרא **`assigned`**. בשכבת הסידור אותו
//  נתון נקרא **`people`**. שני שמות לאותו דבר, בשתי שכבות —
//  בדיוק הדפוס שכבר הפיל בדיקה בפרויקט הזה. המיפוי כאן מפורש,
//  במקום אחד, ובדיקת המקור אוכפת שהוא לא נעלם.
//
//      node functions/guard-events.test.js
// =====================================================================

// שבעת השדות שיוצאים החוצה. **זו הרשימה כולה.**
const EVENT_FIELDS = Object.freeze([
  'id', 'date', 'title', 'start', 'end', 'status', 'people'
]);

// ארבעת המצבים מתוך `guards.js`. רשימה סגורה: מצב שאינו כאן
// הוא מסמך פגום, ולא „מצב חדש שנתמוך בו בשקט".
const GUARD_STATUSES = Object.freeze(['open', 'staffed', 'done', 'cancelled']);
const CANCELLED = 'cancelled';

const ID_PATTERN = /^[A-Za-z0-9_-]{2,120}$/;
// Firebase Authentication UIDs are document-key segments, not schedule or
// guard ids. A dot is valid and must survive an end-to-end assignment; a
// slash or a control character cannot safely name one Firestore document.
// Do not trim or normalize an already-issued UID.
const AUTH_UID_PATTERN = /^[^\u0000-\u001F\u007F/]{1,128}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATION_PATTERN = /^[a-z0-9_-]{2,80}$/;
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060\ufeff]/;
const TITLE_MAX = 80;

const MONTH_DAYS = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

const DROP = Object.freeze({
  REQUEST_INVALID:        'request_invalid',
  DATES_INVALID:          'dates_invalid',
  VIEWER_NOT_ACTIVE:      'viewer_not_active',
  GUARD_MALFORMED:        'guard_malformed',
  GUARD_ID_INVALID:       'guard_id_invalid',
  GUARD_DATE_INVALID:     'guard_date_invalid',
  GUARD_DATE_OUT_OF_RANGE:'guard_date_out_of_range',
  GUARD_TITLE_INVALID:    'guard_title_invalid',
  GUARD_TIME_INVALID:     'guard_time_invalid',
  GUARD_STATUS_INVALID:   'guard_status_invalid',
  GUARD_CANCELLED:        'guard_cancelled',
  GUARD_STATION_MISMATCH: 'guard_station_mismatch',
  GUARD_ASSIGNED_INVALID: 'guard_assigned_invalid',
  ASSIGNEE_NOT_ACTIVE:    'assignee_not_active',
  NOT_MINE:               'not_mine'
});

const DROP_CODES = Object.freeze(
  Object.keys(DROP).map(function (key) { return DROP[key]; })
);

// ---------------------------------------------------------------------
//  עזרים
// ---------------------------------------------------------------------

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCleanString(value, max) {
  return typeof value === 'string' && value.length > 0 &&
         value.length <= max && !INVISIBLE.test(value);
}

// תאריך לוח אמיתי, **בלי `new Date`.** בנייה של אובייקט תאריך
// כדי לאמת מחרוזת מכניסה למודול טהור התנהגות שתלויה באזור זמן
// ובגרסת מנוע. חשבון פשוט אינו תלוי בכלום.
function isRealDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  let max = MONTH_DAYS[month - 1];
  if (month === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) max = 29;
  return day <= max;
}

// **שעת סיום מוקדמת משעת התחלה אינה שגיאה.** אבטחת לילה
// 22:00–06:00 היא המקרה הרגיל ולא החריג, ו-`guards.js` עצמו
// מוסיף 1440 דקות כשהסיום קטן מההתחלה. פסילה כאן הייתה מוחקת
// מהסידור בדיוק את המשמרות שהכי חשוב שיופיעו בו.
function isTime(value) {
  return typeof value === 'string' && TIME_PATTERN.test(value);
}

// לתצוגת לוח אין ערך לאבטחה בלי טווח שעות מפורש. המסך אינו משלים
// שעה חסרה ואינו מנחש אותה, גם אם מסך עריכת האבטחות מאפשר טיוטה כזו.
function readTime(value) {
  if (!isTime(value)) return { ok: false };
  return { ok: true, value: value };
}

// סגל פעיל → קבוצת מזהים. מקבל מחרוזות או עצמים, ומכבד סימון
// מפורש של אי-פעילות גם אם הרשימה כבר סוננה במעלה הזרם.
function activeUidSet(roster) {
  const set = Object.create(null);
  if (!Array.isArray(roster)) return { ok: false, set: set };
  for (let i = 0; i < roster.length; i++) {
    const entry = roster[i];
    if (typeof entry === 'string') {
      if (AUTH_UID_PATTERN.test(entry)) set[entry] = true;
      continue;
    }
    if (!isObject(entry)) continue;
    const uid = entry.uid;
    if (typeof uid !== 'string' || !AUTH_UID_PATTERN.test(uid)) continue;
    if (entry.is_active === false || entry.active === false) continue;
    set[uid] = true;
  }
  return { ok: true, set: set };
}

function readDateSet(dates) {
  const set = Object.create(null);
  if (!Array.isArray(dates) || dates.length === 0) return { ok: false, set: set };
  for (let i = 0; i < dates.length; i++) {
    if (!isRealDate(dates[i])) return { ok: false, set: set };
    set[dates[i]] = true;
  }
  return { ok: true, set: set };
}

function counter() {
  const counts = Object.create(null);
  return {
    add: function (code, howMany) {
      counts[code] = (counts[code] || 0) + (howMany === undefined ? 1 : howMany);
    },
    frozen: function () { return Object.freeze(Object.assign({}, counts)); }
  };
}

function result(events, dropped) {
  return Object.freeze({
    events: Object.freeze(events),
    dropped: dropped
  });
}

// חסימה מלאה עם סיבה אחת. **אינה עוברת דרך `drops.add`** כדי
// שכל קריאה ל-`drops.add` במודול תישא קבוע מתוך `DROP` ולא
// משתנה — וכך בדיקת המקור יכולה לאכוף שאין סיבה מורכבת.
function empty(code) {
  const counts = Object.create(null);
  counts[code] = 1;
  return result([], Object.freeze(Object.assign({}, counts)));
}

// סדר יציב: תאריך, ואז שעת התחלה, ואז מזהה. בלי זה שתי קריאות
// זהות יכולות להחזיר סדר שונה, ואז „הפלט השתנה" אינו אומר כלום.
function byDateThenStartThenId(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const as = a.start === null ? '' : a.start;
  const bs = b.start === null ? '' : b.start;
  if (as !== bs) return as < bs ? -1 : 1;
  return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
}

// ---------------------------------------------------------------------
//  הליבה
// ---------------------------------------------------------------------
//
//  מחזירה את השדות המותרים בלבד, או null עם סיבה. **אין כאן
//  העתקה של המסמך ואין `delete`** — נבנה עצם חדש, שדה שדה.

function project(guard, dateSet, activeSet, stationId, drops) {
  if (!isObject(guard)) { drops.add(DROP.GUARD_MALFORMED); return null; }

  if (!isCleanString(guard.id, 200) || !ID_PATTERN.test(guard.id)) {
    drops.add(DROP.GUARD_ID_INVALID); return null;
  }
  if (!isRealDate(guard.date)) { drops.add(DROP.GUARD_DATE_INVALID); return null; }
  if (!dateSet[guard.date]) { drops.add(DROP.GUARD_DATE_OUT_OF_RANGE); return null; }
  if (!isCleanString(guard.title, TITLE_MAX)) {
    drops.add(DROP.GUARD_TITLE_INVALID); return null;
  }

  const start = readTime(guard.start);
  const end = readTime(guard.end);
  if (!start.ok || !end.ok) { drops.add(DROP.GUARD_TIME_INVALID); return null; }

  if (typeof guard.status !== 'string' || GUARD_STATUSES.indexOf(guard.status) === -1) {
    drops.add(DROP.GUARD_STATUS_INVALID); return null;
  }
  if (guard.status === CANCELLED) { drops.add(DROP.GUARD_CANCELLED); return null; }

  // שיוך תחנה נבדק **רק** אם המסמך נושא אותו ואם נמסרה תחנה.
  // הקורא כבר קרא מהתחנה הנכונה; זו רשת ולא שער.
  if (stationId !== null) {
    const carried = guard.stationId !== undefined ? guard.stationId
                  : (guard.station_id !== undefined ? guard.station_id
                  : (guard.station !== undefined ? guard.station : undefined));
    if (carried !== undefined && carried !== null && carried !== '' && carried !== stationId) {
      drops.add(DROP.GUARD_STATION_MISMATCH); return null;
    }
  }

  // **נקודת הקריאה היחידה מ-`assigned`.** בדיקת המקור אוכפת
  // שהיא נשארת אחת: שתי נקודות קריאה הן שתי הזדמנויות לשכוח
  // אחת מהן כשהחוזה משתנה.
  const assignedField = guard.assigned;
  const assignedRaw = assignedField === undefined || assignedField === null
    ? [] : assignedField;
  if (!Array.isArray(assignedRaw)) { drops.add(DROP.GUARD_ASSIGNED_INVALID); return null; }

  // **המיפוי: `assigned` במסמך → `people` בסידור.**
  // ורק מי שנמצא בסגל הפעיל. מזהה שאינו שם אינו מוחזר בשום
  // צורה — לא כמזהה, לא כמניין ולא כ„משובץ לא ידוע".
  const people = [];
  let rejected = 0;
  for (let i = 0; i < assignedRaw.length; i++) {
    const uid = assignedRaw[i];
    if (typeof uid !== 'string' || !AUTH_UID_PATTERN.test(uid)) {
      drops.add(DROP.GUARD_ASSIGNED_INVALID); return null;
    }
    if (!activeSet[uid]) { rejected++; continue; }
    if (people.indexOf(uid) === -1) people.push(uid);
  }
  if (rejected) drops.add(DROP.ASSIGNEE_NOT_ACTIVE, rejected);

  return {
    id: guard.id,
    date: guard.date,
    title: guard.title,
    start: start.value,
    end: end.value,
    status: guard.status,
    people: Object.freeze(people.slice().sort())
  };
}

function prepare(input) {
  if (!isObject(input)) return { ok: false, code: DROP.REQUEST_INVALID };
  const dateSet = readDateSet(input.dates);
  if (!dateSet.ok) return { ok: false, code: DROP.DATES_INVALID };
  const roster = activeUidSet(input.roster);
  if (!roster.ok) return { ok: false, code: DROP.REQUEST_INVALID };
  if (!Array.isArray(input.guards)) return { ok: false, code: DROP.REQUEST_INVALID };

  let stationId = null;
  if (input.station_id !== undefined && input.station_id !== null && input.station_id !== '') {
    if (typeof input.station_id !== 'string' || !STATION_PATTERN.test(input.station_id)) {
      return { ok: false, code: DROP.REQUEST_INVALID };
    }
    stationId = input.station_id;
  }
  return { ok: true, dateSet: dateSet.set, activeSet: roster.set, stationId: stationId };
}

// ---------------------------------------------------------------------
//  סידור תחנתי · משובצים פעילים בלבד
// ---------------------------------------------------------------------

function stationGuardEvents(input) {
  const ready = prepare(input);
  if (!ready.ok) return empty(ready.code);

  const drops = counter();
  const events = [];
  const guards = input.guards;
  for (let i = 0; i < guards.length; i++) {
    const event = project(guards[i], ready.dateSet, ready.activeSet, ready.stationId, drops);
    if (event) events.push(Object.freeze(event));
  }
  events.sort(byDateThenStartThenId);
  return result(events, drops.frozen());
}

// ---------------------------------------------------------------------
//  סידור אישי · רק שלו, ובלי עמיתים
// ---------------------------------------------------------------------
//
//  `people` מוחזר עם מזהה אחד — של הצופה עצמו. זה שומר על אותה
//  צורת שדה שבה שכבת הסידור כבר משתמשת, **ואין בו ולו מזהה אחד
//  של עמית.** הצופה אינו „עמית" של עצמו.

function personalGuardEvents(input) {
  const ready = prepare(input);
  if (!ready.ok) return empty(ready.code);

  const viewer = isObject(input) ? input.viewer_uid : null;
  if (typeof viewer !== 'string' || viewer === '' || !ready.activeSet[viewer]) {
    return empty(DROP.VIEWER_NOT_ACTIVE);
  }

  const drops = counter();
  const events = [];
  const guards = input.guards;
  for (let i = 0; i < guards.length; i++) {
    const event = project(guards[i], ready.dateSet, ready.activeSet, ready.stationId, drops);
    if (!event) continue;
    if (event.people.indexOf(viewer) === -1) { drops.add(DROP.NOT_MINE); continue; }
    events.push(Object.freeze({
      id: event.id,
      date: event.date,
      title: event.title,
      start: event.start,
      end: event.end,
      status: event.status,
      people: Object.freeze([viewer])
    }));
  }
  events.sort(byDateThenStartThenId);
  return result(events, drops.frozen());
}

module.exports = {
  stationGuardEvents,
  personalGuardEvents,
  EVENT_FIELDS,
  GUARD_STATUSES,
  DROP,
  DROP_CODES
};
