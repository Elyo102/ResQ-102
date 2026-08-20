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


// ---------- הלב: איזו משמרת עובדת בתאריך נתון ----------

// rotations = מערך של מסמכי rotations מ-Firestore
// מחזיר את אות המשמרת ('A'/'B'/'C') או null אם אין מחזור פעיל.
export function crewOnDate(rotations, date) {
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
export function isCrewWorking(rotations, crew, date) {
  return crewOnDate(rotations, date) === crew;
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
export function shiftsInMonth(rotations, crew, role, year, month) {
  const out = [];
  if (!crew) return out;

  const last = new Date(year, month + 1, 0).getDate();
  const base = (rotations && rotations.length) ? rotations[0] : null;

  for (let d = 1; d <= last; d++) {
    const date = new Date(year, month, d);
    if (crewOnDate(rotations, date) === crew) {
      out.push({
        date: date,
        key: toKey(date),
        crew: crew,
        times: shiftTimes(base, role, false)
      });
    }
  }
  return out;
}

// סך השעות בחודש
export function hoursInMonth(rotations, crew, role, year, month) {
  return shiftsInMonth(rotations, crew, role, year, month)
    .reduce((sum, s) => sum + s.times.hours, 0);
}


// ---------- המשמרת הבאה ----------

export function nextShift(rotations, crew, fromDate) {
  if (!crew) return null;
  const start = fromDate || new Date();
  for (let i = 0; i < 40; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (crewOnDate(rotations, d) === crew) return d;
  }
  return null;
}
