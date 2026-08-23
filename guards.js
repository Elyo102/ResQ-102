// אבטחות ואירועים.
//
// אבטחה היא הצבת כוח באירוע — משחק, הופעה, עבודות חמות, כינוס.
// היא לא משמרת ולא החלפה; היא משימה עם תאריך, שעות, מספר
// מקומות, ולפעמים דרישת כשירות.
//
// ------------------------------------------------------------------
//  שתי אבטחות שנראות זהות ואינן זהות
// ------------------------------------------------------------------
//
// אבטחה שנופלת ביום שהכבאי ממילא במשמרת נבלעת בתוך 24 השעות
// שלו. אין שעות נוספות ואין שכר נוסף — הוא היה בתחנה ממילא.
//
// אבטחה שנופלת ביום החופש שלו היא משהו אחר לגמרי: הוא קם
// מהבית, מגיע, ומקבל שעות על כך.
//
// לכן המערכת סופרת אותן **בנפרד**, ומדד ההוגנות מסתכל בעיקר
// על אלה שביום חופש. אדם שעשה שמונה אבטחות בתוך המשמרות שלו
// לא עמוס יותר ממי שעשה חמש בימי החופש שלו — הוא עשה את
// עבודתו, וזה עשה טובה.
//
// טעות זו היא הטעות המתבקשת כאן, ולכן היא כתובה במפורש.

import { personWorks, fromKey } from './rotation.js?v=19';

// ------------------------------------------------------------------
//  מצבים
// ------------------------------------------------------------------
//
// open      נפתחה. כבאים יכולים להירשם
// staffed   המפקד שיבץ. אפשר עוד לשנות
// done      התקיימה
// cancelled בוטלה
//
// אין מצב "מלאה" — מספר הנרשמים אינו סוגר את ההרשמה. הרשמה
// היא הבעת עניין, לא תפיסת מקום; אחרת מי שזריז תופס הכל, וזו
// בדיוק הבעיה שהמסך הזה בא לפתור.

export const GUARD_STATES = [
  { id: 'open',      he: 'פתוחה להרשמה', color: '#4d94ff' },
  { id: 'staffed',   he: 'משובצת',        color: '#35c46b' },
  { id: 'done',      he: 'התקיימה',       color: '#9aa0a6' },
  { id: 'cancelled', he: 'בוטלה',         color: '#ef5350' }
];

export function stateHe(id) {
  const s = GUARD_STATES.filter(function (x) { return x.id === id; })[0];
  return s ? s.he : String(id || '');
}
export function stateColor(id) {
  const s = GUARD_STATES.filter(function (x) { return x.id === id; })[0];
  return s ? s.color : '#9aa0a6';
}

// סוגי אירוע. רשימה פתוחה — המפקד יכול לכתוב משלו.
export const GUARD_KINDS = [
  { id: 'sport',   he: 'אירוע ספורט' },
  { id: 'show',    he: 'הופעה או פסטיבל' },
  { id: 'hotwork', he: 'עבודות חמות' },
  { id: 'crowd',   he: 'כינוס או טקס' },
  { id: 'school',  he: 'הדרכה או בית ספר' },
  { id: 'other',   he: 'אחר' }
];

export function kindHe(id) {
  const k = GUARD_KINDS.filter(function (x) { return x.id === id; })[0];
  return k ? k.he : 'אחר';
}

// ------------------------------------------------------------------
//  עזר
// ------------------------------------------------------------------

export function toKey(d) {
  if (typeof d === 'string') return d;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const a = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + a;
}

export function dmy(key) {
  const p = String(key || '').split('-');
  return p.length === 3 ? Number(p[2]) + '.' + Number(p[1]) + '.' + p[0] : String(key || '');
}

// שעות האבטחה. חוצה חצות מטופל.
export function guardHours(g) {
  const s = String((g || {}).start || '').split(':').map(Number);
  const e = String((g || {}).end || '').split(':').map(Number);
  if (s.length !== 2 || e.length !== 2 || isNaN(s[0]) || isNaN(e[0])) return null;
  let diff = (e[0] * 60 + e[1]) - (s[0] * 60 + s[1]);
  if (diff <= 0) diff += 24 * 60;
  return Math.round((diff / 60) * 100) / 100;
}

export function assignedOf(g) {
  const a = (g || {}).assigned;
  return Array.isArray(a) ? a.filter(Boolean) : [];
}

export function signupsOf(g) {
  const s = (g || {}).signups || {};
  return Object.keys(s).map(function (uid) {
    return Object.assign({ uid: uid }, s[uid] || {});
  });
}

export function isAssigned(g, uid) {
  return assignedOf(g).indexOf(uid) !== -1;
}
export function isSignedUp(g, uid) {
  return !!((g || {}).signups || {})[uid];
}

export function openSlots(g) {
  const need = Number((g || {}).slots || 0);
  return Math.max(0, need - assignedOf(g).length);
}

// ------------------------------------------------------------------
//  במשמרת או ביום חופש
// ------------------------------------------------------------------
//
// זו השאלה שקובעת אם האבטחה מזכה בשעות, ואם היא נספרת כנטל.
// התשובה נגזרת מהסבב ומההחלפות המאושרות — אותה פונקציה בדיוק
// שמצייר בה מסך הסידור, כדי ששני המסכים לא יסתרו זה את זה.

export function onDutyAt(ctx, uid, crew, dateKey) {
  const c = ctx || {};
  if (!crew) return false;
  // rotation.js עובד עם אובייקט Date, ואבטחה נשמרת עם מחרוזת
  // תאריך. ההמרה כאן ולא שם — הסבב הוא המודול הוותיק, ואין
  // סיבה לשנות את החתימה שלו בשביל קורא חדש.
  const key = String(dateKey || '');
  if (key.length !== 10) return false;
  return personWorks(c.rotations, crew, fromKey(key),
                     c.overrides, c.swaps, uid) === true;
}

// 'shift'  האבטחה בתוך המשמרת — נבלעת ב-24 השעות
// 'off'    יום חופש — הכבאי בא מהבית
export function dutyKind(ctx, uid, crew, dateKey) {
  return onDutyAt(ctx, uid, crew, dateKey) ? 'shift' : 'off';
}

export const DUTY_HE = { shift: 'בתוך המשמרת', off: 'ביום חופש' };

// ------------------------------------------------------------------
//  חלוקת עומס
// ------------------------------------------------------------------
//
// סופר לכל אדם כמה אבטחות עשה בחלון זמן, מופרד לפי סוג.
//
// people   [{uid, name, crew, emp}]
// guards   רשימת אבטחות
// ctx      {rotations, overrides, swaps} — לקביעת במשמרת/חופש
// sinceKey מאיזה תאריך לספור. ריק = הכל
//
// מחזיר מפה uid → { off, shift, total, hours, last }

export function loadByPerson(people, guards, ctx, sinceKey) {
  const out = {};
  (people || []).forEach(function (p) {
    out[p.uid] = { uid: p.uid, name: p.name || '', crew: p.crew || '',
                   emp: p.emp || '', off: 0, shift: 0, total: 0,
                   hours: 0, last: '' };
  });

  (guards || []).forEach(function (g) {
    if (!g || g.status === 'cancelled') return;
    const key = String(g.date || '');
    if (sinceKey && key < sinceKey) return;

    const hrs = guardHours(g) || 0;
    assignedOf(g).forEach(function (uid) {
      const rec = out[uid];
      if (!rec) return;                       // מי שכבר לא בסגל
      const kind = dutyKind(ctx, uid, rec.crew, key);
      if (kind === 'off') { rec.off++; rec.hours += hrs; }
      else rec.shift++;
      rec.total++;
      if (key > rec.last) rec.last = key;
    });
  });

  Object.keys(out).forEach(function (u) {
    out[u].hours = Math.round(out[u].hours * 100) / 100;
  });
  return out;
}

// ------------------------------------------------------------------
//  דירוג הוגנות
// ------------------------------------------------------------------
//
// הסדר: קודם מי שעשה הכי פחות אבטחות ביום חופש. שוויון נשבר
// לפי מי שלא יצא הכי הרבה זמן, ואז לפי אבטחות בתוך משמרת,
// ואז לפי שם — כדי שהסדר יהיה יציב ולא יקפוץ בין רענונים.
//
// סדר יציב חשוב יותר משהוא נשמע: מפקד שרואה רשימה שמשתנה
// בכל כניסה מפסיק לסמוך עליה.

export function fairnessRank(loadMap) {
  const list = Object.keys(loadMap || {}).map(function (u) { return loadMap[u]; });
  list.sort(function (a, b) {
    if (a.off !== b.off) return a.off - b.off;
    if (a.last !== b.last) return String(a.last).localeCompare(String(b.last));
    if (a.shift !== b.shift) return a.shift - b.shift;
    return String(a.name).localeCompare(String(b.name), 'he');
  });
  return list;
}

// ------------------------------------------------------------------
//  זמינות
// ------------------------------------------------------------------
//
// מי לא יכול לצאת לאבטחה הזו, ולמה. הסיבה מוחזרת כטקסט —
// "לא זמין" בלי סיבה שולח את המפקד לחפש.
//
// busy  מפה dateKey → מפה uid → סיבה בעברית (חופש, מחלה, מילואים)

export function unavailableWhy(g, uid, ctx, busy) {
  const key = String((g || {}).date || '');
  const b = ((busy || {})[key] || {})[uid];
  if (b) return b;

  // אבטחה אחרת באותו יום ובשעות חופפות.
  const others = (ctx && ctx.guards) || [];
  for (const o of others) {
    if (!o || o.id === g.id) continue;
    if (String(o.date || '') !== key) continue;
    if (o.status === 'cancelled') continue;
    if (!isAssigned(o, uid)) continue;
    if (overlaps(g, o)) return 'משובץ ל' + (o.title || 'אבטחה אחרת') + ' באותן שעות';
  }
  return '';
}

function mins(t) {
  const p = String(t || '').split(':').map(Number);
  return (p.length === 2 && !isNaN(p[0])) ? p[0] * 60 + p[1] : null;
}

export function overlaps(a, b) {
  const a1 = mins(a.start), b1 = mins(b.start);
  let a2 = mins(a.end),   b2 = mins(b.end);
  if (a1 == null || b1 == null || a2 == null || b2 == null) return true;
  if (a2 <= a1) a2 += 24 * 60;
  if (b2 <= b1) b2 += 24 * 60;
  return a1 < b2 && b1 < a2;
}

// ------------------------------------------------------------------
//  ההמלצה
// ------------------------------------------------------------------
//
// מי לשבץ לאבטחה הזו. מחזיר רשימה מדורגת עם סיבה לכל אדם.
//
// הכלל: מתוך הנרשמים בלבד, אם יש נרשמים. הרשמה היא הסכמה
// מראש, ושיבוץ מי שלא נרשם כשיש נרשמים הוא בזבוז של רצון טוב.
// אם אין נרשמים כלל — כל הסגל הזמין, לפי הוגנות.
//
// opts.needQuals  מזהי כשירות נדרשים
// opts.memberQuals מפה uid → [qualIds]

export function recommend(g, people, loadMap, ctx, busy, opts) {
  const o = opts || {};
  const signed = signupsOf(g).map(function (s) { return s.uid; });
  const pool = signed.length ? signed : (people || []).map(function (p) { return p.uid; });
  const already = assignedOf(g);
  const need = Array.isArray(o.needQuals) ? o.needQuals.filter(Boolean) : [];
  const mq = o.memberQuals || {};

  const rows = [];
  pool.forEach(function (uid) {
    if (already.indexOf(uid) !== -1) return;      // כבר משובץ
    const load = (loadMap || {})[uid];
    if (!load) return;                            // לא בסגל פעיל

    const why = unavailableWhy(g, uid, ctx, busy);
    const mine = Array.isArray(mq[uid]) ? mq[uid] : [];
    const missing = need.filter(function (q) { return mine.indexOf(q) === -1; });

    rows.push({
      uid: uid, name: load.name, crew: load.crew, emp: load.emp,
      off: load.off, shift: load.shift, total: load.total, last: load.last,
      signed: signed.indexOf(uid) !== -1,
      blocked: !!why, why: why,
      missingQuals: missing,
      duty: dutyKind(ctx, uid, load.crew, String(g.date || ''))
    });
  });

  // חסומים לתחתית, חסרי כשירות מעליהם, והשאר לפי הוגנות.
  rows.sort(function (a, b) {
    if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
    const am = a.missingQuals.length, bm = b.missingQuals.length;
    if (am !== bm) return am - bm;
    if (a.off !== b.off) return a.off - b.off;
    if (a.last !== b.last) return String(a.last).localeCompare(String(b.last));
    if (a.shift !== b.shift) return a.shift - b.shift;
    return String(a.name).localeCompare(String(b.name), 'he');
  });
  return rows;
}

// הבחירה האוטומטית: הראשונים ברשימה שאינם חסומים ואינם חסרי
// כשירות, עד למספר המקומות הפנויים.
export function autoPick(g, rows) {
  const room = openSlots(g);
  const out = [];
  for (const r of rows || []) {
    if (out.length >= room) break;
    if (r.blocked) continue;
    if (r.missingQuals.length) continue;
    out.push(r.uid);
  }
  return out;
}

// משפט קצר שמסביר למה האדם הזה מוצע, ובאיזה מקום הוא בסדר.
//
// מקבל גם שורת המלצה (עם blocked ו-missingQuals) וגם שורת עומס
// פשוטה מ-fairnessRank, שאין בה שדות כאלה. שני המסכים שואלים
// את אותה שאלה ולכן שני המסכים מקבלים את אותה תשובה.
export function whyPicked(r) {
  if (!r) return '';
  if (r.blocked) return r.why || 'לא זמין';
  if ((r.missingQuals || []).length) return 'חסרה כשירות נדרשת';
  if (!r.off) return 'עוד לא יצא לאבטחה ביום חופש';
  const last = r.last ? ' · אחרונה ' + dmy(r.last) : '';
  return r.off + ' אבטחות ביום חופש' + last;
}

// ------------------------------------------------------------------
//  לוג
// ------------------------------------------------------------------
//
// שורה לכל יציאה, לא לכל אבטחה. השאלה שהמפקד שואל היא "מי יצא
// ולכמה", ולכן היחידה היא האדם־באבטחה.

export function logRows(guards, people, ctx) {
  const byUid = {};
  (people || []).forEach(function (p) { byUid[p.uid] = p; });

  const rows = [];
  (guards || []).forEach(function (g) {
    if (!g || g.status === 'cancelled') return;
    assignedOf(g).forEach(function (uid) {
      const p = byUid[uid] || {};
      rows.push({
        date: String(g.date || ''), title: g.title || '', place: g.place || '',
        uid: uid, name: p.name || uid, crew: p.crew || '',
        hours: guardHours(g),
        duty: dutyKind(ctx, uid, p.crew || '', String(g.date || '')),
        status: g.status || ''
      });
    });
  });
  rows.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  return rows;
}

// חלון ברירת מחדל לספירת עומס: שנה אחורה. קצר מדי מעניש את מי
// שיצא לאחרונה; ארוך מדי גורר לנצח מישהו שעזב את המשמרת.
export function defaultSince(today) {
  const d = today ? new Date(today) : new Date();
  d.setFullYear(d.getFullYear() - 1);
  return toKey(d);
}
