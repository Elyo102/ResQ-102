// =====================================================================
//  תחנה 102 - מנוע חישוב הסידור
//
//  הרעיון: הסידור לא נשמר כ-365 שורות בשנה. נשמר רק "כלל" -
//  תאריך עוגן, ומי עבד בו. מכאן כל תאריך מחושב בזיכרון, בלי
//  אף קריאה למסד הנתונים.
// =====================================================================

export const CREWS = ['A', 'B', 'C'];

export const CREW_HE = {
  A: "משמרת א'",
  B: "משמרת ב'",
  C: "משמרת ג'"
};

export const CREW_SHORT = { A: "א'", B: "ב'", C: "ג'" };


// ---------- עזרי תאריכים ----------

// מספר הימים בין שני תאריכים, בלי שעות ובלי שעון קיץ.
export function daysBetween(from, to) {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}

export function toKey(date) {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return date.getFullYear() + '-' + m + '-' + d;
}

export function fromKey(key) {
  const p = String(key).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

export function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}


// ---------- חריגות ----------
//
// המחזור הוא נוסחה מושלמת שלא נשברת לעולם. המציאות נשברת:
// משמרת מחליפה משמרת, חג, יום אימון, כוננות מיוחדת.
//
// חריגה גוברת על המחזור בכל מקום שבו שואלים "מי עובד היום" —
// הלוח, סימון הכשירות, ומילוי דוח הנוכחות מראש. אם היא תגבור
// רק במקום אחד, שני המסכים יראו ימים שונים לאותו אדם.
//
// המפה מגיעה כ-{ 'YYYY-MM-DD': {kind, crew, extra_crews, note} }.
//
//   swap      crew = מי עובד במקום מי שהמחזור קבע
//   holiday   חג. crew ריק = המחזור הרגיל, אבל היום מסומן
//   training  אימון. אותו דבר, סימון אחר
//   standby   כוננות. extra_crews = משמרות נוספות באותו יום

export const OVERRIDE_KINDS = [
  { id: 'swap',     he: 'משמרת מחליפה משמרת', picksCrew: true  },
  { id: 'holiday',  he: 'חג או מועד',          picksCrew: false },
  { id: 'training', he: 'אימון או הדרכה',      picksCrew: false },
  { id: 'standby',  he: 'כוננות מיוחדת',       picksCrew: false }
];

export function overrideKindHe(id) {
  const k = OVERRIDE_KINDS.filter(function (x) { return x.id === id; })[0];
  return k ? k.he : id;
}

export function overrideOn(overrides, date) {
  if (!overrides) return null;
  return overrides[toKey(date)] || null;
}


// ---------- הלב: איזו משמרת עובדת בתאריך נתון ----------

// rotations = מערך של מסמכי rotations מ-Firestore
// overrides = מפה אופציונלית של חריגות לפי תאריך
// מחזיר את אות המשמרת ('A'/'B'/'C') או null אם אין מחזור פעיל.
export function crewOnDate(rotations, date, overrides) {
  // חריגה שקובעת מי עובד גוברת על הנוסחה. היא נבדקת לפני
  // המחזור ולא אחריו — אחרת יום שהמחזור לא מכיר בכלל
  // (למשל תחנה בלי מחזור מוגדר) היה מחזיר null למרות שיש חריגה.
  const ov = overrideOn(overrides, date);
  if (ov && ov.crew && CREWS.indexOf(ov.crew) !== -1) return ov.crew;

  if (!rotations || !rotations.length) return null;

  const active = rotations.filter(r => r.is_active !== false);
  if (!active.length) return null;

  const base  = active[0];
  const cycle = Number(base.cycle_days) || CREWS.length;
  const anchor = base.anchor_date instanceof Date
    ? base.anchor_date
    : fromKey(base.anchor_date);

  const diff = daysBetween(anchor, date);
  const idx  = ((diff % cycle) + cycle) % cycle;

  const match = active.find(r => Number(r.position_in_cycle) === idx);
  return match ? match.crew : null;
}

// האם משמרת מסוימת עובדת בתאריך נתון
export function isCrewWorking(rotations, crew, date, overrides) {
  if (crewOnDate(rotations, date, overrides) === crew) return true;
  // כוננות מיוחדת: יותר ממשמרת אחת באותו יום.
  const ov = overrideOn(overrides, date);
  return !!(ov && Array.isArray(ov.extra_crews) &&
            ov.extra_crews.indexOf(crew) !== -1);
}


// ---------- החלפות מאושרות ----------
//
// חריגה משנה מי עובד ברמת המשמרת. החלפה משנה את זה ברמת
// האדם: כל השאר במשמרת עובדים, ושניים התחלפו ביניהם.
//
// בלי השכבה הזו האישור נרשם ולא קורה כלום — הסידור ממשיך
// להראות את מי שיצא, ודוח הנוכחות ממשיך למלא לו את היום
// מראש. זה בדיוק המצב שבו המערכת אומרת דבר אחד והמציאות
// אומרת אחר.
//
// swaps = מערך מסמכי swaps. רק status === 'approved' נספר.

export function swapEffect(swaps, uid, dateKey) {
  if (!swaps || !uid || !dateKey) return null;
  for (let i = 0; i < swaps.length; i++) {
    const s = swaps[i];
    if (!s || s.status !== 'approved') continue;

    if (dateKey === s.from_date) {
      if (uid === s.from_uid) return 'out';
      if (uid === s.to_uid)   return 'in';
    }
    if (dateKey === s.to_date) {
      if (uid === s.to_uid)   return 'out';
      if (uid === s.from_uid) return 'in';
    }
  }
  return null;
}

// האם אדם מסוים עובד בתאריך מסוים — אחרי מחזור, חריגות
// והחלפות מאושרות. זו השאלה שכל מסך באמת שואל.
export function personWorks(rotations, crew, date, overrides, swaps, uid) {
  const eff = swapEffect(swaps, uid, toKey(date));
  if (eff === 'out') return false;
  if (eff === 'in')  return true;
  return isCrewWorking(rotations, crew, date, overrides);
}


// ---------- שעות המשמרת לפי תפקיד ----------

// מחזיר { start, end, hours, label }
// role: 'commander' מתחיל מוקדם יותר.
// special: משמרת יטבתה מסתיימת מאוחר יותר.
export function shiftTimes(rotation, role, special) {
  const r = rotation || {};
  const start = (role === 'commander' && r.commander_start)
    ? r.commander_start
    : (r.shift_start || '07:00');

  let end   = r.shift_end || '07:00';
  let hours = Number(r.shift_hours) || 24;

  if (role === 'commander') {
    hours = Number(r.commander_shift_hours) || 24.25;
  }

  if (special) {
    end   = r.special_end || '08:00';
    hours = Number(r.special_shift_hours) || 25;
  }

  return {
    start: start,
    end: end,
    hours: hours,
    label: start + '–' + end
  };
}


// ---------- כל המשמרות של אדם בחודש ----------

// מחזיר מערך של אובייקטים: { date, key, crew, times }
export function shiftsInMonth(rotations, crew, role, year, month, overrides) {
  const out = [];
  if (!crew) return out;

  const last = new Date(year, month + 1, 0).getDate();
  const base = (rotations && rotations.length) ? rotations[0] : null;

  for (let d = 1; d <= last; d++) {
    const date = new Date(year, month, d);
    if (isCrewWorking(rotations, crew, date, overrides)) {
      const ov = overrideOn(overrides, date);
      out.push({
        date: date,
        key: toKey(date),
        crew: crew,
        override: ov,
        times: shiftTimes(base, role, false)
      });
    }
  }
  return out;
}

// סך השעות בחודש
export function hoursInMonth(rotations, crew, role, year, month, overrides) {
  return shiftsInMonth(rotations, crew, role, year, month, overrides)
    .reduce((sum, s) => sum + s.times.hours, 0);
}


// ---------- המשמרת הבאה ----------

export function nextShift(rotations, crew, fromDate, overrides) {
  if (!crew) return null;
  const start = fromDate || new Date();
  for (let i = 0; i < 40; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (isCrewWorking(rotations, crew, d, overrides)) return d;
  }
  return null;
}


// ---------- מנוחה בין משמרות ----------
//
// כבאי לא עובד 48 שעות רצוף. משמרת היא 24 שעות, ולכן שתי
// משמרות בימים צמודים הן 48 שעות בלי לעצור — וזה הכלל שאלדד
// הגדיר: מי שעובד ביום א', המוקדם ביותר שאפשר להחליף אליו
// הוא יום ג'. יום שלם של מנוחה ביניהם.
//
// הסבב הרגיל של שלוש משמרות ממילא לא מייצר ימים צמודים.
// הכלל הזה נוגע רק להחלפות, כי החלפה היא הדרך היחידה שאדם
// נכנס ליום שאינו יום המשמרת שלו.
//
// הערה על אכיפה: הבדיקה כאן היא בצד הלקוח ובמסך האישור של
// המפקד. כללי Firestore אינם יכולים לבצע חשבון תאריכים על
// פני מסמכים אחרים, ולכן אכיפה מלאה בשרת הייתה מחייבת
// להעביר את יצירת ההחלפה ואת האישור לפונקציית ענן. השער
// האמיתי הוא המפקד, שרואה את ההפרה לפני שהוא מאשר.

export const MIN_REST_DAYS = 1;   // יום מנוחה מלא בין משמרות

export function addDays(key, n) {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return toKey(d);
}

// האם האדם יעבוד ביום מסוים, בהינתן החלפה מוצעת שעדיין לא
// נשמרה. gainKey הוא היום שהוא נכנס אליו, loseKey היום שהוא
// יוצא ממנו.
export function wouldWork(rotations, crew, overrides, swaps, uid,
                          key, gainKey, loseKey) {
  if (!key) return false;
  if (loseKey && key === loseKey) return false;
  if (gainKey && key === gainKey) return true;
  if (!crew) return false;
  return personWorks(rotations, crew, fromKey(key), overrides, swaps, uid) === true;
}

// הימים הצמודים שבהם האדם כבר עובד, ושהופכים את היום החדש
// ל-48 שעות רצוף. רשימה ריקה = תקין.
export function restConflicts(rotations, crew, overrides, swaps, uid,
                              gainKey, loseKey) {
  const out = [];
  if (!gainKey) return out;
  const before = addDays(gainKey, -1);
  const after  = addDays(gainKey, 1);
  if (wouldWork(rotations, crew, overrides, swaps, uid, before, gainKey, loseKey)) {
    out.push(before);
  }
  if (wouldWork(rotations, crew, overrides, swaps, uid, after, gainKey, loseKey)) {
    out.push(after);
  }
  return out;
}

// בדיקת שני הצדדים של החלפה. מחזיר רשימת הפרות עם שם ותאריכים.
//
// a = { uid, crew, name, gain, lose }
export function swapRestCheck(rotations, overrides, swaps, a, b) {
  const out = [];
  [a, b].forEach(function (p) {
    if (!p || !p.gain) return;
    const hits = restConflicts(rotations, p.crew, overrides, swaps,
                               p.uid, p.gain, p.lose);
    if (hits.length) {
      out.push({ uid: p.uid, name: p.name || '', gain: p.gain, days: hits });
    }
  });
  return out;
}

export function restWhy(v) {
  if (!v) return '';
  const d = v.days.map(function (k) {
    const p = String(k).split('-');
    return Number(p[2]) + '.' + Number(p[1]);
  }).join(' ו-');
  const g = String(v.gain).split('-');
  return (v.name || 'הכבאי') + ' עובד ב-' + d +
         ', והחלפה ל-' + Number(g[2]) + '.' + Number(g[1]) +
         ' תיצור 48 שעות רצוף.';
}

// ---------- ריבוי בעברית ----------
//
// "1 תקלות פתוחות" ו"1 רכבים משביתים" הופיעו בכל המערכת.
// זו לא קפדנות לשונית: המסכים האלה נקראים באמצע משמרת, וניסוח
// רשלני נקרא כנתון רשלני. מפקד שרואה "1 רכבים" עוצר לשנייה
// לבדוק אם המספר נכון — וזו שנייה שאין לו.
//
//   plural(1, 'תקלה אחת', 'תקלות')  →  'תקלה אחת'
//   plural(4, 'תקלה אחת', 'תקלות')  →  '4 תקלות'
//
// שתי צורות בלבד ולא שלוש. לזוגי יש צורה משלו בעברית (שעתיים,
// יומיים), אבל בהקשר של ספירה — "2 תקלות" — היא לא בשימוש.
export function plural(n, one, many) {
  return Number(n) === 1 ? one : n + ' ' + many;
}
