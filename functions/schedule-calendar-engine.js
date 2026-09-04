'use strict';

/**
 * schedule-calendar-engine — מנוע הסידור החודשי של ResQ.
 *
 * מודול טהור. אינו קורא מהמסד, אינו כותב, אינו שולח התראה, אינו מפרסם.
 * מקבל מדיניות, סגל, זמינות ושיבוצים ידניים — ומחזיר **תוכנית**.
 *
 * ארבעה כללים שאין לשבור, ולכל אחד יש בדיקה ומוטציה:
 *   1. אין ברירות מחדל שקטות. נתון עסקי חסר = סירוב מפורש.
 *   2. אין העברת אדם בין תחנות קצה כדי לסתום חוסר. חוסר נשאר חור מנומק.
 *   3. גם שיבוץ ידני עובר את כל הבדיקות. „ידני" אינו „פטור".
 *   4. אין סיבות אישיות או רפואיות בפלט. אף פעם, בשום שדה.
 *
 * אינו דורס ואינו מייבא את functions/schedule-autofill.js.
 */

class CalendarError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CalendarError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ *
 * קודי סיבה · ניטרליים בכוונה                                        *
 * ------------------------------------------------------------------ */

/**
 * הסיבות שמותר להחזיר בפלט. **אין כאן שום קטגוריית היעדרות.**
 * „מחלה", „חופשה" ו„מילואים" קורסים כולם ל-not_available:
 * מי שקורא סידור אינו צריך לדעת למה אדם אינו זמין, וסידור מודפס
 * שנשאר על שולחן אינו אמור לחשוף מידע רפואי.
 */
const REASON = Object.freeze({
  NO_QUALIFIED: 'no_qualified',
  NOT_AVAILABLE: 'not_available',
  REST: 'rest',
  ALREADY_ASSIGNED: 'already_assigned',
  OUT_OF_SUB_STATION: 'out_of_sub_station',
  INACTIVE: 'inactive',
  OUT_OF_ROTATION: 'out_of_rotation'
});

const PUBLIC_REASONS = Object.freeze(Object.keys(REASON).map((k) => REASON[k]));

const LIMITS = Object.freeze({
  MAX_ROSTER: 20000,
  MAX_DAYS: 1000,
  MAX_SUB_STATIONS: 64,
  MAX_ROLES_PER_SUB: 32,
  MAX_COUNT_PER_ROLE: 500,
  MAX_MONTHS: 3,
  MAX_PLANNED_SLOTS: 1000000,
  MAX_CANDIDATE_EDGES: 50000000
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/* מפתחות שמסוכן להשתמש בהם כשם במפה רגילה: "__proto__" כמזהה אדם היה
 * כותב את העומס שלו ל-Object.prototype של התהליך החם. כל מזהה שמגיע
 * מבחוץ (אדם, תחנת קצה, תפקיד, קבוצת מחזוריות) נבדק כאן, וכל קריאה
 * ממפה עוברת דרך own() — לא דרך ירושה. */
const RESERVED_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
function isReservedKey(v) {
  return RESERVED_KEYS.indexOf(v) !== -1;
}
function isSafeKey(v) {
  return isNonEmptyString(v) && v.length <= 128 && !/[\u0000-\u001F\u007F]/.test(v) && !isReservedKey(v);
}
/* המפות הפנימיות הן null-prototype; החוצה יוצאים אובייקטים רגילים
 * (מסד הנתונים ו-JSON) — המפתחות כבר אומתו, אז אין כאן מפתח שמור. */
function plainMap(map) {
  return Object.assign({}, map);
}
function own(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}
function ownOr(obj, key, fallback) {
  return own(obj, key) ? obj[key] : fallback;
}

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  if (!Object.isFrozen(value)) Object.freeze(value);
  Object.keys(value).forEach((key) => deepFreeze(value[key]));
  return value;
}

/**
 * תאריך חוקי בלבד. 2026-02-30 נראה תקין בתבנית ואינו קיים —
 * ולכן נבדק גם בהמרה חזרה.
 */
function toDayNumber(iso, what) {
  if (typeof iso !== 'string' || !ISO_DATE.test(iso)) {
    throw new CalendarError('bad-date', what + ' חייב להיות תאריך בצורת YYYY-MM-DD');
  }
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    throw new CalendarError('impossible-date', what + ' אינו תאריך אפשרי');
  }
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    throw new CalendarError('impossible-date', what + ' אינו תאריך אפשרי');
  }
  return Math.floor(ms / DAY_MS);
}

function fromDayNumber(n) {
  const dt = new Date(n * DAY_MS);
  const p = (x) => String(x).padStart(2, '0');
  return dt.getUTCFullYear() + '-' + p(dt.getUTCMonth() + 1) + '-' + p(dt.getUTCDate());
}

/* ------------------------------------------------------------------ *
 * מדיניות · חובה במלואה                                              *
 * ------------------------------------------------------------------ */

function normalizePolicy(raw) {
  if (!isPlainObject(raw)) {
    throw new CalendarError('policy-required', 'חובה למסור מדיניות תחנה. המנוע אינו מניח ערכים.');
  }
  if (!isNonEmptyString(raw.station_id)) {
    throw new CalendarError('policy-station', 'למדיניות חייב להיות station_id');
  }
  if (!isNonEmptyString(raw.version)) {
    throw new CalendarError('policy-version', 'למדיניות חייבת להיות גרסה');
  }
  if (!isNonEmptyString(raw.digest)) {
    throw new CalendarError('policy-digest', 'למדיניות חייבת להיות חתימת תוכן שנוצרה בשרת');
  }

  const subs = raw.sub_stations;
  if (!isPlainObject(subs) || Object.keys(subs).length === 0) {
    throw new CalendarError('policy-sub-stations', 'חובה להגדיר לפחות תחנת קצה אחת');
  }
  const subKeys = Object.keys(subs);
  if (subKeys.length > LIMITS.MAX_SUB_STATIONS) {
    throw new CalendarError('too-many-sub-stations', 'יותר מדי תחנות קצה');
  }

  const outSubs = Object.create(null);
  for (const key of subKeys) {
    if (!isSafeKey(key)) {
      throw new CalendarError('sub-station-key-reserved', 'מפתח תחנת קצה אינו חוקי: ' + key);
    }
    const s = subs[key];
    if (!isPlainObject(s)) throw new CalendarError('sub-station-shape', 'תחנת קצה ' + key + ' אינה תקינה');
    if (!isNonEmptyString(s.label)) {
      throw new CalendarError('sub-station-label', 'לתחנת קצה ' + key + ' חסרה תווית');
    }
    // קו המינימום הוא נתון עסקי. אין לו ברירת מחדל.
    if (!isInt(s.minimum) || s.minimum < 0) {
      throw new CalendarError('sub-station-minimum', 'לתחנת קצה ' + key + ' חסר קו מינימום');
    }
    const rows = s.requirements;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new CalendarError('sub-station-requirements', 'לתחנת קצה ' + key + ' אין דרישות תקן');
    }
    if (rows.length > LIMITS.MAX_ROLES_PER_SUB) {
      throw new CalendarError('too-many-roles', 'יותר מדי תפקידים בתחנת קצה ' + key);
    }
    const seen = new Set();
    const reqs = rows.map((row, i) => {
      if (!isPlainObject(row)) throw new CalendarError('requirement-shape', 'דרישה ' + i + ' בתחנת קצה ' + key);
      if (!isSafeKey(row.role)) {
        throw new CalendarError('requirement-role', 'דרישה ' + i + ' בתחנת קצה ' + key + ' בלי תפקיד חוקי');
      }
      if (seen.has(row.role)) {
        throw new CalendarError('requirement-duplicate', 'התפקיד ' + row.role + ' כפול בתחנת קצה ' + key);
      }
      seen.add(row.role);
      if (!isInt(row.count) || row.count < 0 || row.count > LIMITS.MAX_COUNT_PER_ROLE) {
        throw new CalendarError('requirement-count', 'כמות לא תקינה לתפקיד ' + row.role);
      }
      if (typeof row.required !== 'boolean') {
        throw new CalendarError('requirement-required', 'לדרישה ' + row.role + ' חסר סימון חובה/רשות מפורש');
      }
      return Object.freeze({
        role: row.role,
        label: isNonEmptyString(row.label) ? row.label : row.role,
        count: row.count,
        required: row.required
      });
    });
    outSubs[key] = Object.freeze({ key, label: s.label, minimum: s.minimum, requirements: Object.freeze(reqs) });
  }

  // מנוחה — נתון עסקי, חובה מפורשת.
  if (!isPlainObject(raw.rest) || !isInt(raw.rest.min_gap_days) || raw.rest.min_gap_days < 0) {
    throw new CalendarError('policy-rest', 'חובה להגדיר rest.min_gap_days. אין ברירת מחדל.');
  }

  // מחזוריות — חייבת להופיע, גם אם במפורש כ-null.
  if (!Object.prototype.hasOwnProperty.call(raw, 'rotation')) {
    throw new CalendarError('policy-rotation-missing', 'חובה להצהיר על rotation, גם אם היא null');
  }
  let rotation = null;
  if (raw.rotation !== null) {
    const r = raw.rotation;
    if (!isPlainObject(r)) throw new CalendarError('policy-rotation', 'מחזוריות לא תקינה');
    if (!Array.isArray(r.groups) || r.groups.length === 0 || r.groups.some((g) => !isNonEmptyString(g))) {
      throw new CalendarError('rotation-groups', 'למחזוריות חסרות קבוצות');
    }
    if (new Set(r.groups).size !== r.groups.length) {
      throw new CalendarError('rotation-groups', 'קבוצה כפולה במחזוריות');
    }
    const anchorDay = toDayNumber(r.anchor, 'עוגן המחזוריות');
    if (!isInt(r.days_per_group) || r.days_per_group <= 0) {
      throw new CalendarError('rotation-span', 'חובה להגדיר days_per_group');
    }
    if (typeof r.strict !== 'boolean') {
      throw new CalendarError('rotation-strict', 'חובה להצהיר אם המחזוריות קשיחה');
    }
    rotation = Object.freeze({
      groups: Object.freeze(r.groups.slice()),
      anchor: r.anchor,
      anchorDay,
      daysPerGroup: r.days_per_group,
      strict: r.strict
    });
  }

  // תקרת משמרות — חייבת להופיע, ומזהירה ואינה חוסמת.
  if (!Object.prototype.hasOwnProperty.call(raw, 'max_shifts_per_month')) {
    throw new CalendarError('policy-limit-missing', 'חובה להצהיר על max_shifts_per_month, גם אם null');
  }
  const maxShifts = raw.max_shifts_per_month;
  if (maxShifts !== null && (!isInt(maxShifts) || maxShifts <= 0)) {
    throw new CalendarError('policy-limit', 'max_shifts_per_month לא תקין');
  }

  return Object.freeze({
    station_id: raw.station_id,
    version: raw.version,
    digest: raw.digest,
    sub_stations: Object.freeze(outSubs),
    sub_keys: Object.freeze(subKeys.slice()),
    min_gap_days: raw.rest.min_gap_days,
    rotation,
    max_shifts_per_month: maxShifts
  });
}

/* ------------------------------------------------------------------ *
 * מקור אחד · אותה תחנה, אותה גרסה, אותו צילום                        *
 * ------------------------------------------------------------------ */

function assertSameSource(policy, input) {
  if (!isNonEmptyString(input.station_id)) {
    throw new CalendarError('station-required', 'חובה למסור station_id');
  }
  if (!isNonEmptyString(input.source_snapshot)) {
    throw new CalendarError('snapshot-required', 'חובה למסור צילום מקור');
  }
  if (!isNonEmptyString(input.source_version)) {
    throw new CalendarError('version-required', 'חובה למסור גרסת מקור');
  }
  if (input.station_id !== policy.station_id) {
    throw new CalendarError('station-mismatch', 'התחנה בקלט אינה התחנה שבמדיניות');
  }
  if (!isNonEmptyString(input.contract_station_id) || input.contract_station_id !== input.station_id) {
    throw new CalendarError('contract-station-mismatch', 'חוזה המקור אינו שייך לתחנה שבקלט');
  }
  if (!isNonEmptyString(input.source_revision)) {
    throw new CalendarError('source-revision-required', 'חובה למסור מהדורת מקור');
  }
  if (!isNonEmptyString(input.source_digest)) {
    throw new CalendarError('source-digest-required', 'חובה למסור גיבוב של מקור הנתונים');
  }
  if (!isNonEmptyString(input.policy_digest) || input.policy_digest !== policy.digest) {
    throw new CalendarError('policy-digest-mismatch', 'חתימת המדיניות אינה תואמת למדיניות שהוזרקה למנוע');
  }
  if (input.source_complete !== true) {
    throw new CalendarError('source-incomplete', 'מקור הנתונים אינו מסומן כמלא');
  }
}

function normalizeRoster(roster, policy, input) {
  if (!Array.isArray(roster) || roster.length === 0) {
    throw new CalendarError('roster-required', 'חובה למסור סגל');
  }
  if (roster.length > LIMITS.MAX_ROSTER) {
    throw new CalendarError('roster-too-large', 'הסגל גדול מהמותר');
  }
  const byId = new Map();
  const knownRoles = new Set();
  for (const sub of policy.sub_keys) {
    for (const requirement of policy.sub_stations[sub].requirements) knownRoles.add(requirement.role);
  }
  for (const p of roster) {
    if (!isPlainObject(p) || !isNonEmptyString(p.id)) {
      throw new CalendarError('roster-shape', 'לכל אדם בסגל חייב להיות מזהה');
    }
    if (!isSafeKey(p.id)) {
      throw new CalendarError('roster-id-reserved', 'מזהה אדם אינו חוקי כמפתח');
    }
    if (byId.has(p.id)) {
      throw new CalendarError('roster-duplicate', 'המזהה ' + p.id + ' מופיע פעמיים');
    }
    if (!isNonEmptyString(p.station_id)) {
      throw new CalendarError('person-station', 'לאדם ' + p.id + ' חסרה תחנה');
    }
    if (p.station_id !== policy.station_id) {
      throw new CalendarError('person-station-mismatch', 'האדם ' + p.id + ' אינו שייך לתחנה');
    }
    if (!isNonEmptyString(p.sub_station)) {
      throw new CalendarError('person-sub-station', 'לאדם ' + p.id + ' חסרה תחנת שיוך');
    }
    if (!own(policy.sub_stations, p.sub_station)) {
      throw new CalendarError('person-sub-station-unknown', 'תחנת השיוך של ' + p.id + ' אינה מוכרת');
    }
    if (typeof p.active !== 'boolean') {
      throw new CalendarError('person-active', 'לאדם ' + p.id + ' חסר סימון פעיל/לא פעיל מפורש');
    }
    if (!Array.isArray(p.roles)) {
      throw new CalendarError('person-roles', 'לאדם ' + p.id + ' חסרה רשימת תפקידים');
    }
    const roleSet = new Set();
    for (const role of p.roles) {
      if (!isNonEmptyString(role) || !knownRoles.has(role)) {
        throw new CalendarError('person-role-unknown', 'לאדם ' + p.id + ' יש תפקיד סידור לא מוכר');
      }
      if (roleSet.has(role)) {
        throw new CalendarError('person-role-duplicate', 'לאדם ' + p.id + ' יש תפקיד סידור כפול');
      }
      roleSet.add(role);
    }
    if (p.source_snapshot !== input.source_snapshot) {
      throw new CalendarError('person-snapshot-mismatch', 'האדם ' + p.id + ' מצילום מקור אחר');
    }
    if (!isNonEmptyString(p.source_version) || p.source_version !== input.source_version) {
      throw new CalendarError('person-version-mismatch', 'האדם ' + p.id + ' מגרסת מקור אחרת');
    }
    if (p.contract_station_id !== input.contract_station_id
        || p.source_revision !== input.source_revision
        || p.source_digest !== input.source_digest
        || p.source_complete !== true) {
      throw new CalendarError('person-source-contract', 'האדם ' + p.id + ' אינו מאותו חוזה מקור מלא');
    }
    byId.set(p.id, p);
  }
  return byId;
}

function normalizeDays(days) {
  if (!Array.isArray(days) || days.length === 0) {
    throw new CalendarError('days-required', 'חובה למסור ימים');
  }
  if (days.length > LIMITS.MAX_DAYS) {
    throw new CalendarError('days-too-many', 'יותר מדי ימים בתקופה');
  }
  const seen = new Set();
  const out = days.map((d, i) => {
    if (seen.has(d)) throw new CalendarError('duplicate-date', 'התאריך ' + d + ' מופיע פעמיים');
    seen.add(d);
    return { date: d, day: toDayNumber(d, 'יום ' + i) };
  });
  for (let i = 1; i < out.length; i += 1) {
    if (out[i].day <= out[i - 1].day) {
      throw new CalendarError('days-not-ascending', 'חובה למסור את הימים בסדר עולה');
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */

function createCalendarEngine(deps) {
  const d = isPlainObject(deps) ? deps : {};
  const clock = d.clock;
  if (typeof clock !== 'function') {
    throw new CalendarError('clock-required', 'חובה להזריק clock');
  }
  const policy = normalizePolicy(d.policy);

  /* ---------------- כשירות ---------------- */

  function groupOfDay(dayNum) {
    if (!policy.rotation) return null;
    const r = policy.rotation;
    const cycle = r.groups.length * r.daysPerGroup;
    const delta = dayNum - r.anchorDay;
    const idx = Math.floor((((delta % cycle) + cycle) % cycle) / r.daysPerGroup);
    return r.groups[idx];
  }

  /**
   * מחזיר null אם האדם כשיר, אחרת **קוד סיבה ניטרלי**.
   * לעולם לא קטגוריית היעדרות ולעולם לא טקסט חופשי מהקלט.
   */
  function blockCode(person, role, ctx) {
    if (person.sub_station !== ctx.sub) return REASON.OUT_OF_SUB_STATION;
    if (person.active !== true) return REASON.INACTIVE;
    if (person.roles.indexOf(role) === -1) return REASON.NO_QUALIFIED;
    if (ctx.unavailable) return REASON.NOT_AVAILABLE;
    if (ctx.taken.has(person.id)) return REASON.ALREADY_ASSIGNED;
    const last = ownOr(ctx.state.lastDay, person.id, undefined);
    if (last !== undefined && ctx.day > last && ctx.day - last <= policy.min_gap_days) {
      return REASON.REST;
    }
    if (policy.rotation && policy.rotation.strict && person.group && ctx.group
        && person.group !== ctx.group) {
      return REASON.OUT_OF_ROTATION;
    }
    return null;
  }

  function rankKey(person, role, ctx) {
    const inGroup = policy.rotation && person.group && ctx.group && person.group === ctx.group ? 0 : 1;
    const load = ownOr(ctx.state.load, person.id, 0);
    const roleLoad = ownOr(ownOr(ctx.state.byRole, person.id, null), role, 0) || 0;
    const versatility = person.roles.length;
    return [inGroup, load, roleLoad, versatility, person.id];
  }

  function cmpKey(a, b) {
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] === b[i]) continue;
      return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  }

  function isUnavailable(availability, id, date) {
    const forPerson = ownOr(availability, id, null);
    return !!(forPerson && own(forPerson, date) && forPerson[date]);
  }

  /* ---------------- יום אחד ---------------- */

  function planOneDay(entry, index, ctx) {
    const { date, day } = entry;
    const group = groupOfDay(day);
    const taken = new Set();
    const rows = [];

    for (const sub of policy.sub_keys) {
      const spec = policy.sub_stations[sub];
      const need = Object.create(null);
      spec.requirements.forEach((r) => { need[r.role] = r.count; });

      const slots = [];
      const gaps = [];

      /* --- שיבוץ ידני קודם, ועובר את אותן בדיקות בדיוק --- *
       * רשומה ידנית היא מזהה, או { person, role } כשאחראי הסידור
       * גורר אדם למשבצת תפקיד מסוימת. תפקיד שנקבע במפורש **נבדק**:
       * „ידני" אינו „פטור מכשירות".                                  */
      const lockedHere = (own(ctx.locked, sub) && ctx.locked[sub] && own(ctx.locked[sub], date) && ctx.locked[sub][date]) || [];
      const rejected = [];
      for (const raw of lockedHere) {
        const entry = isPlainObject(raw) ? raw : { person: raw, role: null };
        const id = entry.person;
        if (!isNonEmptyString(id)) {
          throw new CalendarError('locked-shape', 'רשומת שיבוץ ידני לא תקינה בתאריך ' + date);
        }
        const wantedRole = isNonEmptyString(entry.role) ? entry.role : null;
        if (wantedRole !== null && !spec.requirements.some((r) => r.role === wantedRole)) {
          throw new CalendarError('locked-role-unknown',
            'התפקיד ' + wantedRole + ' אינו בתקן של תחנת הקצה ' + sub);
        }

        const person = ctx.byId.get(id);
        if (!person) {
          rejected.push({ person: id, code: REASON.NO_QUALIFIED });
          continue;
        }
        const roleCandidates = person.roles.filter((rk) => need[rk] > 0);
        const probeRole = wantedRole !== null
          ? wantedRole
          : (roleCandidates.length ? roleCandidates[0] : (person.roles[0] || null));
        const code = probeRole === null
          ? REASON.NO_QUALIFIED
          : blockCode(person, probeRole, {
            sub, day, group, taken, state: ctx.state,
            unavailable: isUnavailable(ctx.availability, id, date)
          });
        if (code) {
          // ידני שאינו חוקי אינו משובץ ואינו נמחק בשקט — הוא מדווח.
          rejected.push({ person: id, code });
          continue;
        }
        taken.add(id);
        ctx.state.load[id] = ownOr(ctx.state.load, id, 0) + 1;
        ctx.state.lastDay[id] = day;
        if (!own(ctx.state.byRole, id)) ctx.state.byRole[id] = Object.create(null);
        let assignedRole = null;
        if (wantedRole !== null) {
          assignedRole = wantedRole;
          if (need[assignedRole] > 0) need[assignedRole] -= 1;
        } else if (roleCandidates.length) {
          assignedRole = roleCandidates[0];
          need[assignedRole] -= 1;
        }
        if (assignedRole) {
          ctx.state.byRole[id][assignedRole] = ownOr(ctx.state.byRole[id], assignedRole, 0) + 1;
        }
        slots.push({
          person: id,
          role: assignedRole,
          label: assignedRole ? labelOf(spec, assignedRole) : null,
          source: 'manual'
        });
      }

      /* --- מילוי אוטומטי: התאמה מלאה ודטרמיניסטית --- *
       * בחירה חמדנית של האדם הטוב ביותר לכל תפקיד יכולה להשאיר חור
       * אף שקיים שיבוץ מלא (למשל אדם רב-תכליתי נלקח מוקדם מדי).
       * לכן מרחיבים את התקן למשבצות ומריצים התאמה דו-צדדית עם מסלול
       * הגדלה. כך אדם שכבר נבחר יכול לעבור לתפקיד חלופי כדי לפנות
       * את התפקיד היחיד שאדם אחר מסוגל לבצע.                         */
      const order = spec.requirements.slice().sort((a, b) => {
        if (a.required !== b.required) return a.required ? -1 : 1;
        const sa = ownOr(ctx.supply[sub], a.role, 0);
        const sb = ownOr(ctx.supply[sub], b.role, 0);
        if (sa !== sb) return sa - sb;
        return a.role < b.role ? -1 : 1;
      });

      const demands = [];
      for (const row of order) {
        for (let k = 0; k < need[row.role]; k += 1) {
          demands.push({ role: row.role, label: row.label, required: row.required, ordinal: k });
        }
      }

      const candidateCache = Object.create(null);
      const candidates = demands.map((demand) => {
        if (own(candidateCache, demand.role)) {
          ctx.edgeCount += candidateCache[demand.role].length;
          if (ctx.edgeCount > LIMITS.MAX_CANDIDATE_EDGES) {
            throw new CalendarError('candidate-edges-too-many', 'יותר מדי אפשרויות שיבוץ בהרצה אחת');
          }
          return candidateCache[demand.role];
        }
        const eligible = [];
        const pool = ownOr(ctx.pools[sub], demand.role, []);
        for (const person of pool) {
          const code = blockCode(person, demand.role, {
            sub, day, group, taken, state: ctx.state,
            unavailable: isUnavailable(ctx.availability, person.id, date)
          });
          if (!code) eligible.push(person);
        }
        ctx.edgeCount += eligible.length;
        if (ctx.edgeCount > LIMITS.MAX_CANDIDATE_EDGES) {
          throw new CalendarError('candidate-edges-too-many', 'יותר מדי אפשרויות שיבוץ בהרצה אחת');
        }
        eligible.sort((a, b) => cmpKey(
          rankKey(a, demand.role, { state: ctx.state, group }),
          rankKey(b, demand.role, { state: ctx.state, group })
        ));
        candidateCache[demand.role] = eligible;
        return eligible;
      });

      const personDemand = new Map();
      const demandPerson = new Map();
      function augment(demandIndex, seenPeople, seenDemands) {
        if (seenDemands.has(demandIndex)) return false;
        seenDemands.add(demandIndex);
        // קודם אדם פנוי: שומר על העדפת התפקידים הנדירים שכבר שובצו.
        for (const person of candidates[demandIndex]) {
          if (seenPeople.has(person.id)) continue;
          if (personDemand.has(person.id)) continue;
          seenPeople.add(person.id);
          personDemand.set(person.id, demandIndex);
          demandPerson.set(demandIndex, person);
          return true;
        }
        // רק כשאין אדם פנוי, מחפשים מסלול הגדלה ומזיזים שיבוץ קיים.
        for (const person of candidates[demandIndex]) {
          if (seenPeople.has(person.id)) continue;
          seenPeople.add(person.id);
          const current = personDemand.get(person.id);
          if (augment(current, seenPeople, seenDemands)) {
            personDemand.set(person.id, demandIndex);
            demandPerson.set(demandIndex, person);
            return true;
          }
        }
        return false;
      }
      for (let i = 0; i < demands.length; i += 1) {
        augment(i, new Set(), new Set());
      }

      for (let i = 0; i < demands.length; i += 1) {
        const row = demands[i];
        const best = demandPerson.get(i);
        if (!best) {
          const counts = Object.create(null);
          const pool = ownOr(ctx.pools[sub], row.role, []);
          for (const person of pool) {
            const code = blockCode(person, row.role, {
              sub, day, group, taken: new Set([...taken, ...personDemand.keys()]), state: ctx.state,
              unavailable: isUnavailable(ctx.availability, person.id, date)
            });
            const reason = code || REASON.ALREADY_ASSIGNED;
            counts[reason] = (counts[reason] || 0) + 1;
          }
          if (!Object.keys(counts).length) counts[REASON.NO_QUALIFIED] = 0;
          gaps.push({
            role: row.role,
            label: row.label,
            required: row.required,
            reasons: Object.keys(counts).sort().map((c) => ({ code: c, count: counts[c] }))
          });
          continue;
        }
        taken.add(best.id);
        ctx.state.load[best.id] = ownOr(ctx.state.load, best.id, 0) + 1;
        ctx.state.lastDay[best.id] = day;
        if (!own(ctx.state.byRole, best.id)) ctx.state.byRole[best.id] = Object.create(null);
        ctx.state.byRole[best.id][row.role] = ownOr(ctx.state.byRole[best.id], row.role, 0) + 1;
        const slot = { person: best.id, role: row.role, label: row.label, source: 'auto' };
        if (policy.max_shifts_per_month !== null
            && ctx.state.load[best.id] > policy.max_shifts_per_month) {
          slot.over_limit = true;
        }
        slots.push(slot);
      }

      const blocking = gaps.filter((g) => g.required).length;
      rows.push({
        date,
        station_id: policy.station_id,
        sub_station: sub,
        label: spec.label,
        rotation_group: group,
        minimum: spec.minimum,
        slots,
        gaps,
        rejected_manual: rejected,
        below_minimum: slots.length < spec.minimum,
        complete: blocking === 0 && slots.length >= spec.minimum && rejected.length === 0
      });
    }
    return rows;
  }

  function labelOf(spec, role) {
    const r = spec.requirements.filter((x) => x.role === role)[0];
    return r ? r.label : role;
  }

  /* ---------------- תקופה ---------------- */

  function buildIndexes(byId) {
    const pools = Object.create(null);
    const supply = Object.create(null);
    for (const sub of policy.sub_keys) {
      pools[sub] = Object.create(null);
      supply[sub] = Object.create(null);
      for (const row of policy.sub_stations[sub].requirements) {
        pools[sub][row.role] = [];
        supply[sub][row.role] = 0;
      }
    }
    for (const person of byId.values()) {
      const sub = person.sub_station;
      if (!pools[sub]) continue;
      for (const role of person.roles) {
        if (!own(pools[sub], role)) continue;
        if (person.active !== true) continue;
        pools[sub][role].push(person);
        supply[sub][role] += 1;
      }
    }
    for (const sub of policy.sub_keys) {
      for (const role of Object.keys(pools[sub])) {
        pools[sub][role].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      }
    }
    return { pools, supply };
  }

  function planPeriod(input) {
    const inp = isPlainObject(input) ? input : {};
    assertSameSource(policy, inp);

    const days = normalizeDays(inp.days);
    const byId = normalizeRoster(inp.roster, policy, inp);
    const slotsPerDay = policy.sub_keys.reduce((sum, sub) => sum
      + policy.sub_stations[sub].requirements.reduce((n, row) => n + row.count, 0), 0);
    if (slotsPerDay * days.length > LIMITS.MAX_PLANNED_SLOTS) {
      throw new CalendarError('planned-slots-too-many', 'יותר מדי משבצות בהרצה אחת');
    }

    if (!Object.prototype.hasOwnProperty.call(inp, 'availability') || !isPlainObject(inp.availability)) {
      throw new CalendarError('availability-required', 'חובה למסור תמונת זמינות מלאה, גם כשהיא ריקה');
    }
    if (!Object.prototype.hasOwnProperty.call(inp, 'locked') || !isPlainObject(inp.locked)) {
      throw new CalendarError('locked-required', 'חובה למסור תמונת שיבוצים ידניים מלאה, גם כשהיא ריקה');
    }
    if (!Object.prototype.hasOwnProperty.call(inp, 'carry') || !isPlainObject(inp.carry)) {
      throw new CalendarError('carry-required', 'חובה למסור מצב המשך מלא, גם כשהוא ריק');
    }
    const availability = inp.availability;
    const locked = inp.locked;
    for (const sub of Object.keys(locked)) {
      if (!own(policy.sub_stations, sub)) {
        throw new CalendarError('locked-sub-station-unknown', 'שיבוץ ידני לתחנת קצה לא מוכרת: ' + sub);
      }
    }

    const carry = inp.carry;
    const state = {
      load: isPlainObject(carry.load) ? Object.assign(Object.create(null), carry.load) : Object.create(null),
      lastDay: isPlainObject(carry.lastDay) ? Object.assign(Object.create(null), carry.lastDay) : Object.create(null),
      byRole: isPlainObject(carry.byRole)
        ? Object.keys(carry.byRole).reduce((acc, id) => {
          acc[id] = isPlainObject(carry.byRole[id]) ? Object.assign(Object.create(null), carry.byRole[id]) : carry.byRole[id];
          return acc;
        }, Object.create(null))
        : Object.create(null)
    };
    const firstDay = days[0].day;
    for (const id of Object.keys(state.lastDay)) {
      if (!byId.has(id) || !isInt(state.lastDay[id]) || state.lastDay[id] >= firstDay) {
        throw new CalendarError('carry-last-day-invalid', 'מצב ההמשך כולל יום אחרון עתידי או אדם לא מוכר');
      }
    }
    for (const id of Object.keys(state.load)) {
      if (!byId.has(id) || !isInt(state.load[id]) || state.load[id] < 0) {
        throw new CalendarError('carry-load-invalid', 'מצב ההמשך כולל עומס לא תקין');
      }
    }
    for (const id of Object.keys(state.byRole)) {
      if (!byId.has(id) || !isPlainObject(state.byRole[id])) {
        throw new CalendarError('carry-role-load-invalid', 'מצב ההמשך כולל אדם או מבנה תפקידים לא תקין');
      }
      for (const role of Object.keys(state.byRole[id])) {
        if (byId.get(id).roles.indexOf(role) === -1
            || !isInt(state.byRole[id][role]) || state.byRole[id][role] < 0) {
          throw new CalendarError('carry-role-load-invalid', 'מצב ההמשך כולל עומס תפקיד לא תקין');
        }
      }
    }

    const { pools, supply } = buildIndexes(byId);
    const candidateUpperBound = days.length * policy.sub_keys.reduce((sum, sub) => sum
      + policy.sub_stations[sub].requirements.reduce((n, row) => n
        + row.count * ownOr(pools[sub], row.role, []).length, 0), 0);
    if (candidateUpperBound > LIMITS.MAX_CANDIDATE_EDGES) {
      throw new CalendarError('candidate-edges-too-many', 'יותר מדי אפשרויות שיבוץ בהרצה אחת');
    }
    const ctx = { byId, availability, locked, state, pools, supply, edgeCount: 0 };

    const rows = [];
    days.forEach((entry, i) => {
      planOneDay(entry, i, ctx).forEach((r) => rows.push(Object.freeze(r)));
    });

    let filled = 0;
    let blocking = 0;
    let belowMin = 0;
    let rejectedManual = 0;
    for (const r of rows) {
      filled += r.slots.length;
      blocking += r.gaps.filter((g) => g.required).length;
      if (r.below_minimum) belowMin += 1;
      rejectedManual += r.rejected_manual.length;
    }
    const loads = Object.keys(state.load).map((k) => state.load[k]);
    const min = loads.length ? Math.min.apply(null, loads) : 0;
    const max = loads.length ? Math.max.apply(null, loads) : 0;

    return deepFreeze({
      kind: 'schedule-plan',
      station_id: policy.station_id,
      source_snapshot: inp.source_snapshot,
      source_version: inp.source_version,
      contract_station_id: inp.contract_station_id,
      source_revision: inp.source_revision,
      source_digest: inp.source_digest,
      policy_digest: inp.policy_digest,
      source_complete: true,
      policy_version: policy.version,
      generated_at: clock(),
      from: days[0].date,
      to: days[days.length - 1].date,
      rows,
      summary: {
        filled,
        blocking_gaps: blocking,
        days_below_minimum: belowMin,
        rejected_manual: rejectedManual,
        open_rows: rows.filter((r) => !r.complete).length,
        load: plainMap(state.load),
        fairness: { min, max, spread: max - min }
      },
      carry: {
        load: plainMap(state.load),
        lastDay: plainMap(state.lastDay),
        byRole: Object.keys(state.byRole).reduce((acc, id) => {
          acc[id] = plainMap(state.byRole[id]);
          return acc;
        }, {})
      }
    });
  }

  function daysBetween(from, to) {
    const a = toDayNumber(from, 'תאריך התחלה');
    const b = toDayNumber(to, 'תאריך סיום');
    if (b < a) throw new CalendarError('bad-range', 'תאריך הסיום קודם לתאריך ההתחלה');
    if (b - a + 1 > LIMITS.MAX_DAYS) throw new CalendarError('days-too-many', 'טווח ארוך מדי');
    const out = [];
    for (let n = a; n <= b; n += 1) out.push(fromDayNumber(n));
    return out;
  }

  /** חודש, חודשיים או שלושה — תקופות נפרדות, עם רצף ביניהן. */
  function planMonths(input) {
    const inp = isPlainObject(input) ? input : {};
    const months = inp.months;
    if (!isInt(months) || months < 1 || months > LIMITS.MAX_MONTHS) {
      throw new CalendarError('months-range', 'אפשר להכין חודש, חודשיים או שלושה');
    }
    toDayNumber(inp.start, 'תאריך התחלה');
    if (inp.start.slice(8, 10) !== '01') {
      throw new CalendarError('month-start-required', 'תכנון חודשי חייב להתחיל ביום הראשון של החודש');
    }
    const startYear = Number(inp.start.slice(0, 4));
    const startMonth = Number(inp.start.slice(5, 7)) - 1;

    const periods = [];
    let carry = inp.carry;
    for (let m = 0; m < months; m += 1) {
      const days = [];
      const from = Math.floor(Date.UTC(startYear, startMonth + m, 1) / DAY_MS);
      const until = Math.floor(Date.UTC(startYear, startMonth + m + 1, 1) / DAY_MS);
      for (let n = from; n < until; n += 1) days.push(fromDayNumber(n));
      // עומס ושוויון תפקידים הם חודשיים. רק יום העבודה האחרון
      // ממשיך בין חודשים כדי לא לעקוף את כלל המנוחה בגבול חודש.
      const monthCarry = {
        load: {},
        lastDay: isPlainObject(carry) && isPlainObject(carry.lastDay) ? carry.lastDay : {},
        byRole: {}
      };
      const period = planPeriod(Object.assign({}, inp, { days, carry: monthCarry }));
      periods.push(period);
      carry = period.carry;
    }
    return Object.freeze({ kind: 'schedule-plan-set', months, periods: Object.freeze(periods), carry });
  }

  /** מה שאחראי הסידור קורא לפני שהוא נוגע בכפתור פרסום. */
  function explain(plan) {
    if (!isPlainObject(plan) || !Array.isArray(plan.rows)) {
      throw new CalendarError('bad-plan', 'תוכנית לא תקינה');
    }
    const s = plan.summary;
    const parts = ['שובצו ' + s.filled + ' תפקידים'];
    parts.push(s.blocking_gaps ? s.blocking_gaps + ' תקנים לא אוישו' : 'כל התקנים אוישו');
    if (s.days_below_minimum) parts.push(s.days_below_minimum + ' משבצות מתחת לקו המינימום');
    if (s.rejected_manual) parts.push(s.rejected_manual + ' שיבוצים ידניים נדחו');
    parts.push('פער עומס ' + s.fairness.spread);
    return parts.join(' · ') + '. זו טיוטה — דבר לא פורסם ואיש לא קיבל התראה.';
  }

  return Object.freeze({
    planPeriod,
    planMonths,
    daysBetween,
    explain,
    policy,
    REASON,
    LIMITS
  });
}

module.exports = { createCalendarEngine, CalendarError, REASON, PUBLIC_REASONS, LIMITS };
