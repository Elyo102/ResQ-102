'use strict';

/* ====================================================================
 *  schedule-placement — הפיכת „העבר את X לתחנת קצה Y לשבוע" לשורות
 *  שיבוץ ידני שהמנוע החודשי מקבל.
 *
 *  מודול טהור. אין Firebase, אין רשת, אין תאריך מערכת — clock מוזרק.
 *  הוא **מתכנן ואינו כותב**. הכתיבה, ה-request_id והאטומיות נשארים
 *  אצל מי שמחווט אותו.
 *
 *  --------------------------------------------------------------
 *  הצבה · והחסם שחייבים לדעת עליו לפני שקוראים את הקוד
 *  --------------------------------------------------------------
 *
 *  „שבץ את אלדד בתמנע לשבוע" אינה העברה ארגונית. הוא נשאר במשמרת
 *  שלו ובשיוך שלו, ופשוט עובד בתחנה פיזית אחרת. זו **הצבה**,
 *  והיא הפעולה היומיומית של אחראי סידור.
 *
 *  **המנוע החודשי אינו יכול לבטא אותה.** לא „קשה" — לא יכול.
 *
 *  הסגל שנמסר להרצה הוא רשימה שטוחה, ולכל אדם יש **תחנת קצה אחת
 *  לכל ההרצה** (schedule-calendar-engine.js:329, byId). היא נקראת
 *  בשני מקומות:
 *
 *    :381  blockCode — if (person.sub_station !== ctx.sub)
 *                        return REASON.OUT_OF_SUB_STATION;
 *    :650  מאגרי ההיצע — const sub = person.sub_station;
 *
 *  ו-blockCode רץ **גם על שיבוץ ידני** (:461-465). התוצאה: שיבוץ
 *  ידני של אדם בתחנה שאינה שיוכו נדחה בכל אחד מימי הטווח לתוך
 *  `rejected_manual` — שדה שאף מסך אינו מציג. הסידור ייצא ריק
 *  ואיש לא יבין למה. ושינוי השיוך בסגל אינו פתרון: הוא מזיז את
 *  האדם לתחנה החדשה **לכל החודש**, כולל הימים שהוא אמור לחזור.
 *
 *  לכן המודול **מתכנן את ההצבה במלואה** — כולל אימות התפקיד מול
 *  תקן תחנת היעד ולא תחנת הבית — ומחזיר לצדה:
 *
 *    posting_map   המפה שהמנוע צריך להתייעץ בה, uid → תאריך → תחנה
 *    vacates       הימים שבהם תחנת הבית מאבדת אותו
 *    warnings      אזהרה חוסמת שאומרת שבלי החיווט המנוע דוחה הכול
 *
 *  השינוי הנדרש במנוע הוא נקודתי: תחנת הקצה **האפקטיבית ליום**
 *  במקום `person.sub_station`, בשני המקומות. הוא לא נעשה כאן —
 *  המנוע אינו שלי.
 *
 *  שתי מלכודות נוספות שהמודול תופס במקום להתעלם מהן:
 *
 *  1. מחזוריות קשיחה (:388-391). יום שאינו יום הקבוצה של האדם
 *     נדחה ב-OUT_OF_ROTATION. לכן הטווח נספר **לפי מחזור
 *     המשמרות של האדם** ולא לפי לוח השנה — זו ההכרעה של אלדד,
 *     והיא גם היחידה שמייצרת שורות שהמנוע מקבל.
 *
 *  2. מנוחה (:385-387). שני שיבוצים בתוך min_gap_days זה מזה —
 *     השני נדחה ב-REST. טווח של ימים רצופים היה נדחה כמעט כולו.
 *
 *  --------------------------------------------------------------
 *  אורח
 *  --------------------------------------------------------------
 *
 *  אלדד ביקש גם הקלדת שם חופשי. ההכרעה הסגורה שלו היא
 *  ש-Firebase UID הוא הזהות, ולכן שם חופשי אינו יכול להיות
 *  אדם במערכת. הפשרה כאן היא מפורשת ולא שקטה:
 *
 *  שם שאינו נפתר לאדם קיים מתוכנן כ-**אורח** — subject.kind
 *  'guest'. אורח מקבל שורת תצוגה נפרדת, **אינו נכנס ל-overrides**
 *  (המנוע היה דוחה אותו ב-NO_QUALIFIED), אינו נספר בתקן ואינו
 *  מקבל התראות. הוא מסומן ככזה בפלט כדי שהמסך יוכל להראות אותו
 *  אחרת, ולא כדי שמישהו יחשוב שהוא משובץ.
 *
 *  אורח שקט שנספר בתקן הוא הדבר המסוכן היחיד שאפשר לבנות כאן:
 *  התקן יראה מלא, והרכב ייצא בלי נהג.
 * ==================================================================== */

const SPAN = Object.freeze({
  SINGLE_SHIFT: 'single_shift',
  WEEK: 'week',
  FORTNIGHT: 'fortnight',
  MONTH: 'month'
});

const SPAN_DAYS = Object.freeze({
  [SPAN.SINGLE_SHIFT]: 1,
  [SPAN.WEEK]: 7,
  [SPAN.FORTNIGHT]: 14,
  [SPAN.MONTH]: 31
});

const SUBJECT_KIND = Object.freeze({ MEMBER: 'member', GUEST: 'guest' });

const LIMITS = Object.freeze({
  MAX_HORIZON_DAYS: 62,      // אף בקשה אינה מתוכננת מעבר לחודשיים
  MAX_DATES: 31,             // גג קשיח לשורות שנוצרות מבקשה אחת
  MAX_NAME: 80,
  MAX_REASON: 200
});

const CODE = Object.freeze({
  SUB_STATION_UNKNOWN: 'placement-sub-station-unknown',
  ROLE_NOT_IN_STANDARD: 'placement-role-not-in-standard',
  ROLE_NOT_HELD: 'placement-role-not-held',
  PERSON_UNKNOWN: 'placement-person-unknown',
  PERSON_INACTIVE: 'placement-person-inactive',
  NO_MATCHING_DAYS: 'placement-no-matching-days',
  SPAN_UNKNOWN: 'placement-span-unknown',
  SHAPE: 'placement-shape',
  GUEST_NAME: 'placement-guest-name',
  ROTATION_REQUIRED: 'placement-rotation-required',
  PERSON_NO_GROUP: 'placement-person-no-group'
});

const WARN = Object.freeze({
  // חוסמת. לא „שים לב" — בלי החיווט המנוע דוחה כל יום בטווח.
  POSTING_NEEDS_ENGINE: 'posting-not-supported-by-engine',
  POSTING_VACATES_HOME: 'posting-vacates-home-sub-station',
  REST_GAP: 'rest-gap-shorter-than-policy',
  OVER_MONTHLY_CAP: 'over-monthly-shift-cap',
  TRUNCATED: 'span-truncated-to-horizon',
  GUEST_NOT_COUNTED: 'guest-not-counted-in-standard',
  ROLE_UNSPECIFIED: 'role-left-to-engine'
});

class PlacementError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlacementError';
    this.code = code;
  }
}

/* ------------------------------ עזר ------------------------------ */

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}
function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// אותה חשבונאות תאריכים כמו במנוע: מספר יום מוחלט מ-1970,
// בלי אזור זמן ובלי Date מקומי. שעון קיץ אינו משנה מספר יום.
function toDayNumber(iso, what) {
  if (!isNonEmptyString(iso) || !DATE_RE.test(iso)) {
    throw new PlacementError(CODE.SHAPE, 'תאריך לא תקין: ' + what);
  }
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    throw new PlacementError(CODE.SHAPE, 'תאריך לא תקין: ' + what);
  }
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  // 31.9 אינו תאריך. Date.UTC היה גולש ל-1.10 בשקט.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1
      || back.getUTCDate() !== d) {
    throw new PlacementError(CODE.SHAPE, 'תאריך לא קיים: ' + what);
  }
  return Math.floor(t / 86400000);
}

function fromDayNumber(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

function lastDayOfMonth(iso) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const next = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1);
  return Math.floor(next / 86400000) - 1;
}

/* --------------------------- מחזוריות --------------------------- */

/**
 * הקבוצה שתורנית ביום נתון. **העתק מדויק** של groupOfDay
 * ב-schedule-calendar-engine.js:367-374. אם שם ישתנה החישוב
 * ופה לא — הבדיקה `placement-matches-engine-rotation` נופלת.
 */
function groupOfDay(rotation, dayNum) {
  if (!rotation) return null;
  const cycle = rotation.groups.length * rotation.daysPerGroup;
  const delta = dayNum - rotation.anchorDay;
  const idx = Math.floor((((delta % cycle) + cycle) % cycle) / rotation.daysPerGroup);
  return rotation.groups[idx];
}

function normalizeRotation(raw) {
  if (raw === null || raw === undefined) return null;
  if (!isPlainObject(raw)) {
    throw new PlacementError(CODE.SHAPE, 'מחזוריות לא תקינה');
  }
  if (!Array.isArray(raw.groups) || raw.groups.length === 0
      || raw.groups.some((g) => !isNonEmptyString(g))) {
    throw new PlacementError(CODE.SHAPE, 'למחזוריות חסרות קבוצות');
  }
  if (new Set(raw.groups).size !== raw.groups.length) {
    throw new PlacementError(CODE.SHAPE, 'קבוצה כפולה במחזוריות');
  }
  const daysPerGroup = raw.days_per_group !== undefined ? raw.days_per_group : raw.daysPerGroup;
  if (!isInt(daysPerGroup) || daysPerGroup <= 0) {
    throw new PlacementError(CODE.SHAPE, 'days_per_group חסר או לא תקין');
  }
  if (typeof raw.strict !== 'boolean') {
    throw new PlacementError(CODE.SHAPE, 'חובה להצהיר אם המחזוריות קשיחה');
  }
  return Object.freeze({
    groups: Object.freeze(raw.groups.slice()),
    anchor: raw.anchor,
    anchorDay: toDayNumber(raw.anchor, 'עוגן המחזוריות'),
    daysPerGroup,
    strict: raw.strict
  });
}

/* ------------------------------ קלט ------------------------------ */

function normalizePolicy(raw) {
  if (!isPlainObject(raw)) throw new PlacementError(CODE.SHAPE, 'חסרה מדיניות');
  if (!isPlainObject(raw.sub_stations) || !Object.keys(raw.sub_stations).length) {
    throw new PlacementError(CODE.SHAPE, 'למדיניות חסרות תחנות קצה');
  }
  // min_gap_days ו-max_shifts_per_month חייבים להופיע במפורש, כמו
  // במנוע. ברירת מחדל שקטה כאן הייתה מייצרת אזהרה שגויה או
  // משתיקה אזהרה נכונה.
  if (!isInt(raw.min_gap_days) || raw.min_gap_days < 0) {
    throw new PlacementError(CODE.SHAPE, 'חסר min_gap_days');
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'max_shifts_per_month')) {
    throw new PlacementError(CODE.SHAPE, 'חובה להצהיר על max_shifts_per_month, גם אם null');
  }
  const cap = raw.max_shifts_per_month;
  if (cap !== null && (!isInt(cap) || cap <= 0)) {
    throw new PlacementError(CODE.SHAPE, 'max_shifts_per_month לא תקין');
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'rotation')) {
    throw new PlacementError(CODE.SHAPE, 'חובה להצהיר על rotation, גם אם null');
  }
  const subs = {};
  for (const key of Object.keys(raw.sub_stations)) {
    const s = raw.sub_stations[key];
    if (!isPlainObject(s) || !Array.isArray(s.requirements)) {
      throw new PlacementError(CODE.SHAPE, 'תחנת קצה ' + key + ' אינה תקינה');
    }
    subs[key] = Object.freeze({
      key,
      label: isNonEmptyString(s.label) ? s.label : key,
      minimum: isInt(s.minimum) ? s.minimum : 0,
      roles: Object.freeze(s.requirements.map((r) => r.role))
    });
  }
  return Object.freeze({
    station_id: raw.station_id,
    sub_stations: Object.freeze(subs),
    min_gap_days: raw.min_gap_days,
    max_shifts_per_month: cap,
    rotation: normalizeRotation(raw.rotation)
  });
}

function normalizeSubject(raw, roster, policy) {
  if (!isPlainObject(raw) || !isNonEmptyString(raw.kind)) {
    throw new PlacementError(CODE.SHAPE, 'חסר נושא הבקשה');
  }

  if (raw.kind === SUBJECT_KIND.GUEST) {
    const name = typeof raw.display_name === 'string' ? raw.display_name.trim() : '';
    if (!name || name.length > LIMITS.MAX_NAME) {
      throw new PlacementError(CODE.GUEST_NAME, 'לאורח חסר שם, או שהשם ארוך מדי');
    }
    // אורח אינו נקשר ל-uid ואינו יכול להיקשר. אם נמסר uid — זו
    // בקשה מבולבלת, ולא נכריע אותה בשקט לטובת אחד הצדדים.
    if (raw.person !== undefined && raw.person !== null) {
      throw new PlacementError(CODE.SHAPE, 'אורח אינו יכול לשאת מזהה משתמש');
    }
    return Object.freeze({ kind: SUBJECT_KIND.GUEST, display_name: name, person: null });
  }

  if (raw.kind !== SUBJECT_KIND.MEMBER) {
    throw new PlacementError(CODE.SHAPE, 'סוג נושא לא מוכר');
  }
  if (!isNonEmptyString(raw.person)) {
    throw new PlacementError(CODE.SHAPE, 'לחבר סגל חייב להיות מזהה');
  }
  const person = roster.get(raw.person);
  if (!person) {
    throw new PlacementError(CODE.PERSON_UNKNOWN,
      'האדם אינו בסגל התחנה. איתור עובד חייב לפתור לאדם קיים.');
  }
  if (person.active !== true) {
    throw new PlacementError(CODE.PERSON_INACTIVE, 'האדם אינו פעיל.');
  }
  if (!isNonEmptyString(person.sub_station) || !policy.sub_stations[person.sub_station]) {
    throw new PlacementError(CODE.SHAPE, 'שיוך תחנת הקצה של האדם אינו מוכר');
  }
  return Object.freeze({
    kind: SUBJECT_KIND.MEMBER,
    person: person.id,
    home_sub_station: person.sub_station,
    group: person.group || null,
    roles: Object.freeze((person.roles || []).slice())
  });
}

function normalizeRoster(list) {
  const map = new Map();
  if (!Array.isArray(list)) return map;
  for (const p of list) {
    if (!isPlainObject(p) || !isNonEmptyString(p.id)) continue;
    if (map.has(p.id)) {
      throw new PlacementError(CODE.SHAPE, 'המזהה ' + p.id + ' מופיע פעמיים בסגל');
    }
    map.set(p.id, p);
  }
  return map;
}

/* ---------------------------- הטווח ---------------------------- */

/**
 * הימים שהבקשה חלה עליהם.
 *
 * ההכרעה של אלדד: הטווח נספר **לפי מחזור המשמרות של האדם**.
 * „שבוע" אינו שבעה ימים — הוא המשמרות שלו בשבעת הימים הקרובים.
 *
 * זו גם ההכרעה היחידה שעובדת: מחזוריות קשיחה דוחה כל יום שאינו
 * יום הקבוצה שלו (engine:388-391), ומנוחה דוחה ימים רצופים
 * (engine:385-387). ספירה קלנדרית הייתה מייצרת שבע שורות שמתוכן
 * המנוע מקבל אחת.
 *
 * אורח אינו נושא קבוצה, ולכן טווח של אורח נספר קלנדרית — הוא
 * גם ממילא אינו נכנס ל-overrides.
 */
function expandSpan(span, anchorDay, subject, policy) {
  const kind = isPlainObject(span) ? span.kind : span;
  if (!Object.prototype.hasOwnProperty.call(SPAN_DAYS, kind)) {
    throw new PlacementError(CODE.SPAN_UNKNOWN, 'טווח לא מוכר: ' + String(kind));
  }

  let horizonEnd;
  if (kind === SPAN.MONTH) {
    // „חודש שלם" = עד סוף החודש הקלנדרי של תאריך העוגן. חודש
    // מתפרסם כיחידה אחת, ולכן טווח שחוצה אותו אינו ניתן לפרסום.
    horizonEnd = lastDayOfMonth(fromDayNumber(anchorDay));
  } else {
    horizonEnd = anchorDay + SPAN_DAYS[kind] - 1;
  }

  let truncated = false;
  if (horizonEnd - anchorDay + 1 > LIMITS.MAX_HORIZON_DAYS) {
    horizonEnd = anchorDay + LIMITS.MAX_HORIZON_DAYS - 1;
    truncated = true;
  }

  const rotation = policy.rotation;
  const dates = [];

  if (subject.kind === SUBJECT_KIND.MEMBER && rotation) {
    if (!isNonEmptyString(subject.group)) {
      throw new PlacementError(CODE.PERSON_NO_GROUP,
        'לאדם אין קבוצת מחזוריות, ולכן אי אפשר לספור את הטווח לפי המשמרות שלו.');
    }
    for (let d = anchorDay; d <= horizonEnd; d += 1) {
      if (groupOfDay(rotation, d) === subject.group) dates.push(d);
      if (kind === SPAN.SINGLE_SHIFT && dates.length === 1) break;
    }
  } else {
    // בלי מחזוריות אין „המשמרות שלו". נופלים לספירה קלנדרית,
    // ומסמנים את זה בפלט במקום להעמיד פנים שספרנו משמרות.
    const take = kind === SPAN.SINGLE_SHIFT ? 1 : (horizonEnd - anchorDay + 1);
    for (let i = 0; i < take && anchorDay + i <= horizonEnd; i += 1) {
      dates.push(anchorDay + i);
    }
  }

  if (dates.length > LIMITS.MAX_DATES) {
    dates.length = LIMITS.MAX_DATES;
    truncated = true;
  }

  return {
    kind,
    counted_by: (subject.kind === SUBJECT_KIND.MEMBER && rotation) ? 'shift_cycle' : 'calendar',
    from: fromDayNumber(anchorDay),
    to: fromDayNumber(horizonEnd),
    days: dates,
    truncated
  };
}

/* ---------------------------- התכנון ---------------------------- */

function createPlacementPlanner(deps) {
  const d = deps || {};
  if (typeof d.clock !== 'function') {
    throw new PlacementError(CODE.SHAPE, 'חובה להזריק clock');
  }
  const clock = d.clock;

  /**
   * @param {object} input
   *   request  {subject, sub_station, role|null, span, anchor_date,
   *             actor_uid, request_id, note}
   *   policy   מדיניות התחנה כפי שהמנוע מקבל אותה
   *   roster   [{id, sub_station, group, active, roles[]}]
   *   existing_load  {personId: מספר משמרות שכבר משובצות החודש}
   */
  function planPlacement(input) {
    if (!isPlainObject(input) || !isPlainObject(input.request)) {
      throw new PlacementError(CODE.SHAPE, 'קלט לא תקין');
    }
    const req = input.request;
    const policy = normalizePolicy(input.policy);
    const roster = normalizeRoster(input.roster);
    const subject = normalizeSubject(req.subject, roster, policy);
    const warnings = [];

    /* --- תחנת היעד --- */
    if (!isNonEmptyString(req.sub_station)) {
      throw new PlacementError(CODE.SHAPE, 'חסרה תחנת יעד');
    }
    const target = policy.sub_stations[req.sub_station];
    if (!target) {
      throw new PlacementError(CODE.SUB_STATION_UNKNOWN,
        'תחנת הקצה ' + req.sub_station + ' אינה בתקן.');
    }

    /* --- הצבה בתחנה שאינה תחנת הבית --- *
     * זו הפעולה שאלדד ביקש, והמנוע אינו יכול לבטא אותה: הסגל
     * שטוח, ולכל אדם תחנה אחת לכל ההרצה. מתכננים אותה במלואה
     * ומוסרים את מה שחסר למנוע, במקום להעמיד פנים שהיא עוברת. */
    const isPosting = subject.kind === SUBJECT_KIND.MEMBER
      && subject.home_sub_station !== target.key;

    /* --- תפקיד --- */
    let role = null;
    if (req.role !== undefined && req.role !== null && req.role !== '') {
      if (!isNonEmptyString(req.role)) {
        throw new PlacementError(CODE.SHAPE, 'תפקיד לא תקין');
      }
      if (target.roles.indexOf(req.role) === -1) {
        throw new PlacementError(CODE.ROLE_NOT_IN_STANDARD,
          'התפקיד ' + req.role + ' אינו בתקן של ' + target.key + '.');
      }
      if (subject.kind === SUBJECT_KIND.MEMBER
          && subject.roles.indexOf(req.role) === -1) {
        throw new PlacementError(CODE.ROLE_NOT_HELD,
          'האדם אינו מחזיק בתפקיד ' + req.role + '. „ידני" אינו „פטור מכשירות".');
      }
      role = req.role;
    } else {
      warnings.push({ code: WARN.ROLE_UNSPECIFIED,
        detail: 'לא נבחר תפקיד. המנוע יבחר מתוך התפקידים של האדם.' });
    }

    /* --- הטווח --- */
    const anchorDay = toDayNumber(
      isNonEmptyString(req.anchor_date) ? req.anchor_date : fromDayNumber(
        Math.floor(clock() / 86400000)), 'תאריך פתיחה');
    const span = expandSpan(req.span, anchorDay, subject, policy);

    if (!span.days.length) {
      throw new PlacementError(CODE.NO_MATCHING_DAYS,
        'אין ולו יום אחד בטווח שבו המשמרת של האדם תורנית.');
    }
    if (span.truncated) {
      warnings.push({ code: WARN.TRUNCATED,
        detail: 'הטווח נקטע לגג של ' + LIMITS.MAX_DATES + ' ימים.' });
    }

    /* --- מנוחה --- *
     * engine:385-387 דוחה שיבוץ שני בתוך min_gap_days. אם המחזוריות
     * מחזירה ימים צמודים מדי — האזהרה כאן, לא הפתעה בהרצה. */
    if (policy.min_gap_days > 0) {
      for (let i = 1; i < span.days.length; i += 1) {
        const gap = span.days[i] - span.days[i - 1];
        if (gap <= policy.min_gap_days) {
          warnings.push({
            code: WARN.REST_GAP,
            detail: fromDayNumber(span.days[i]) + ' רחוק ' + gap
              + ' ימים מהקודם, והמנוחה הנדרשת היא ' + policy.min_gap_days
              + '. המנוע ידחה את היום הזה.'
          });
        }
      }
    }

    /* --- תקרת משמרות --- *
     * engine מסמן over_limit רק על שיבוץ אוטומטי. שיבוץ ידני
     * שעובר את התקרה עובר בשקט, ולכן האזהרה חייבת להיווצר כאן. */
    if (policy.max_shifts_per_month !== null
        && subject.kind === SUBJECT_KIND.MEMBER) {
      const already = isPlainObject(input.existing_load)
        ? (input.existing_load[subject.person] || 0) : 0;
      const after = already + span.days.length;
      if (after > policy.max_shifts_per_month) {
        warnings.push({
          code: WARN.OVER_MONTHLY_CAP,
          detail: 'אחרי הבקשה ' + after + ' משמרות מול תקרה של '
            + policy.max_shifts_per_month + '. המנוע לא יסמן זאת על שיבוץ ידני.'
        });
      }
    }

    /* --- ההצבה --- */
    let posting = null;
    let postingMap = null;
    let vacates = [];

    if (isPosting) {
      const dates = span.days.map(fromDayNumber);
      posting = {
        person: subject.person,
        from: subject.home_sub_station,
        to: target.key,
        dates,
        // לא „אולי". נבדק מול טקסט המקור בסעיף 11 של הבדיקה.
        engine_accepts_today: false,
        required_engine_change:
          'schedule-calendar-engine.js:381 ו-:650 קוראים person.sub_station. '
          + 'הצבה דורשת תחנת קצה אפקטיבית ליום — effectiveSub(person, date) — '
          + 'בשני המקומות. שינוי השיוך בסגל אינו תחליף: הוא מזיז את האדם '
          + 'לתחנה החדשה לכל ההרצה, כולל הימים שהוא אמור לחזור.'
      };
      // המפה בצורה שהמנוע יוכל להתייעץ בה ישירות.
      postingMap = {};
      postingMap[subject.person] = {};
      for (const date of dates) postingMap[subject.person][date] = target.key;

      vacates = dates.map((date) => ({
        date,
        sub_station: subject.home_sub_station,
        person: subject.person
      }));

      warnings.push({
        code: WARN.POSTING_NEEDS_ENGINE,
        blocking: true,
        detail: 'המנוע מחזיק תחנת קצה אחת לאדם לכל ההרצה. בלי חיווט '
          + 'posting_map, כל ' + dates.length + ' הימים יידחו ל-rejected_manual '
          + 'עם OUT_OF_SUB_STATION, והסידור ייצא ריק בלי הודעת שגיאה.'
      });
      warnings.push({
        code: WARN.POSTING_VACATES_HOME,
        blocking: false,
        detail: 'תחנת ' + subject.home_sub_station + ' מאבדת אותו ב-'
          + dates.length + ' ימים. יש להריץ את דוח הכשירויות על תחנת הבית '
          + 'אחרי ההצבה — ההצבה יכולה להוריד אותה מתחת לתקן.'
      });
    }

    /* --- הפלט --- */
    const overrides = [];
    let guest = null;

    if (subject.kind === SUBJECT_KIND.MEMBER) {
      for (const day of span.days) {
        overrides.push({
          date: fromDayNumber(day),
          sub_station: target.key,
          person: subject.person,
          role
        });
      }
    } else {
      // אורח: שורת תצוגה, לא שורת מנוע.
      warnings.push({ code: WARN.GUEST_NOT_COUNTED,
        detail: 'אורח אינו נכנס לשיבוץ, אינו נספר בתקן ואינו מקבל התראות.' });
      guest = {
        display_name: subject.display_name,
        sub_station: target.key,
        role,
        dates: span.days.map(fromDayNumber),
        counts_toward_minimum: false,
        notifiable: false
      };
    }

    // overrides ממוינים כמו ב-normalizeOverrides (runtime:381) כדי
    // שאותה בקשה תיתן אותו digest בכל הרצה.
    overrides.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
      : (a.sub_station < b.sub_station ? -1 : a.sub_station > b.sub_station ? 1
        : (a.person < b.person ? -1 : a.person > b.person ? 1 : 0))));

    const note = typeof req.note === 'string'
      ? req.note.trim().slice(0, LIMITS.MAX_REASON) : '';

    return {
      subject_kind: subject.kind,
      sub_station: target.key,
      sub_station_label: target.label,
      role,
      span: {
        kind: span.kind,
        counted_by: span.counted_by,
        from: span.from,
        to: span.to,
        dates: span.days.map(fromDayNumber)
      },
      overrides,
      guest,
      posting,
      posting_map: postingMap,
      vacates,
      blocked: warnings.some((w) => w.blocking === true),
      warnings,
      audit: {
        at: new Date(clock()).toISOString(),
        actor: isNonEmptyString(req.actor_uid) ? req.actor_uid : null,
        request_id: isNonEmptyString(req.request_id) ? req.request_id : null,
        subject: subject.kind === SUBJECT_KIND.MEMBER ? subject.person : null,
        note
      }
    };
  }

  return Object.freeze({
    planPlacement,
    SPAN,
    SUBJECT_KIND,
    CODE,
    WARN,
    LIMITS
  });
}

module.exports = {
  createPlacementPlanner,
  PlacementError,
  SPAN,
  SUBJECT_KIND,
  CODE,
  WARN,
  LIMITS,
  // מיוצאים לבדיקה שהחשבונאות זהה למנוע.
  groupOfDay,
  toDayNumber,
  fromDayNumber,
  lastDayOfMonth
};
