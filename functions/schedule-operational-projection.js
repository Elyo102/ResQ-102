'use strict';

/**
 * A deliberately small, pure compatibility projection for operational work
 * queries while legacy rotations and the V2 daily plan coexist.
 *
 * It does not read, write, fetch, schedule work, or infer policy.  Callers
 * provide one complete source explicitly:
 *
 *   createOperationalProjection({
 *     source: 'legacy', station_id, roster, legacy: {
 *       rotations, overrides, approved_swaps
 *     }
 *   })
 *
 * or
 *
 *   createOperationalProjection({
 *     source: 'v2', station_id, roster, plan
 *   })
 *
 * Legacy is evaluated from its own crew rotation and approved reciprocal
 * swaps.  V2 is evaluated directly from the published plan rows.  In
 * particular, V2 rows are never converted into synthetic legacy rotations.
 * The only identity copied to query output is the supplied display identity;
 * email, phone, notes and every other profile field are intentionally ignored.
 *
 * Approved legacy swaps are order-sensitive because the legacy personWorks
 * helper returns the first matching approved row.  Pass approved_swaps (or
 * raw swaps) as an array in the authoritative upstream order.  A map is not
 * accepted here: sorting one would invent a different historical outcome.
 */

class OperationalProjectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OperationalProjectionError';
    this.code = code;
  }
}

const SOURCE = Object.freeze({ LEGACY: 'legacy', V2: 'v2' });
const OVERRIDE_KIND = Object.freeze({
  SWAP: 'swap', STANDBY: 'standby', HOLIDAY: 'holiday', TRAINING: 'training'
});
const MAX_WINDOW_DAYS = 93;
const MAX_ROSTER = 20000;
const MAX_ROTATIONS = 400;
const MAX_ROWS = 50000;
const MAX_SLOTS = 100000;
const MAX_SWAPS = 20000;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const AUTH_UID_RE = /^[^\u0000-\u001F\u007F/]{1,128}$/u;
const CONTROL_RE = /[\u0000-\u001F\u007F]/;

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function fail(code, message) {
  throw new OperationalProjectionError(code, message);
}

function validDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= monthDays[month - 1];
}

function dateOrdinal(value, code) {
  if (!validDateKey(value)) fail(code || 'date-invalid', 'תאריך לא תקין');
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const priorYear = year - 1;
  const leapBefore = Math.floor(priorYear / 4) - Math.floor(priorYear / 100)
    + Math.floor(priorYear / 400);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const beforeMonth = [0, 31, leap ? 60 : 59, leap ? 91 : 90, leap ? 121 : 120,
    leap ? 152 : 151, leap ? 182 : 181, leap ? 213 : 212, leap ? 244 : 243,
    leap ? 274 : 273, leap ? 305 : 304, leap ? 335 : 334][month - 1];
  return priorYear * 365 + leapBefore + beforeMonth + day - 1;
}

function nonEmptyText(value, code, label, maximum) {
  if (typeof value !== 'string') fail(code, label + ' חייב להיות טקסט');
  const out = value.trim();
  if (!out || CONTROL_RE.test(out) || out.length > (maximum || 160)) {
    fail(code, label + ' אינו תקין');
  }
  return out;
}

function idOf(value, code, label) {
  const out = nonEmptyText(value, code, label, 128);
  if (!ID_RE.test(out)) fail(code, label + ' אינו תקין');
  return out;
}

function uidOf(value, code, label) {
  if (typeof value !== 'string' || !AUTH_UID_RE.test(value)) {
    fail(code, label + ' אינו תקין');
  }
  return value;
}

function optionalText(value, code, label, maximum) {
  if (value === undefined || value === null || value === '') return null;
  return nonEmptyText(value, code, label, maximum || 120);
}

function collectionEntries(value, code, label, required) {
  if (value === undefined || value === null) {
    if (required) fail(code, 'חסר ' + label);
    return [];
  }
  if (Array.isArray(value)) {
    return value.map(function (item, index) {
      if (!plain(item)) fail(code, label + ' כולל רשומה לא תקינה');
      return { value: item, fallback: String(index) };
    });
  }
  if (plain(value)) {
    return Object.keys(value).sort().map(function (key) {
      if (!plain(value[key])) fail(code, label + ' כולל רשומה לא תקינה');
      return { value: value[key], fallback: key };
    });
  }
  fail(code, label + ' חייב להיות מערך או מפה');
}

function entryUid(entry, fields, code, label) {
  for (const field of fields) {
    if (own(entry.value, field) && entry.value[field] !== undefined && entry.value[field] !== null) {
      return uidOf(entry.value[field], code, label);
    }
  }
  return uidOf(entry.fallback, code, label);
}

function visibleIdentity(person, uid) {
  const names = ['display', 'display_name', 'name', 'full_name'];
  for (const field of names) {
    if (!own(person, field) || person[field] === undefined || person[field] === null
        || person[field] === '') continue;
    return nonEmptyText(person[field], 'roster-display', 'זהות תצוגה', 120);
  }
  return uid;
}

function activeState(person) {
  const fields = ['active', 'is_active'];
  const values = [];
  for (const field of fields) {
    if (!own(person, field) || person[field] === undefined || person[field] === null) continue;
    if (typeof person[field] !== 'boolean') {
      fail('roster-active', 'הסימון הפעיל של איש צוות אינו בוליאני');
    }
    values.push(person[field]);
  }
  if (values.length === 2 && values[0] !== values[1]) {
    fail('roster-active-conflict', 'לאיש צוות יש שני סימוני פעילות סותרים');
  }
  // Legacy user records historically omitted this field for active people.
  // Preserve that documented meaning, while an explicit false is always off.
  return values.length ? values[0] : true;
}

function normalizeRoster(rawRoster, options) {
  const opts = options || {};
  const entries = collectionEntries(rawRoster, 'roster-shape', 'רשימת הסגל', opts.required === true);
  if (entries.length > MAX_ROSTER) fail('roster-too-large', 'רשימת הסגל גדולה מדי');
  const people = new Map();
  entries.forEach(function (entry) {
    const uid = entryUid(entry, ['uid', 'id'], 'roster-uid', 'מזהה איש צוות');
    if (people.has(uid)) fail('roster-duplicate', 'מזהה איש צוות מופיע פעמיים');
    if (opts.stationId && own(entry.value, 'station_id')) {
      const personStation = idOf(entry.value.station_id, 'roster-station', 'תחנת איש צוות');
      if (personStation !== opts.stationId) {
        fail('roster-station-mismatch', 'איש צוות שייך לתחנה אחרת');
      }
    }
    const active = activeState(entry.value);
    const crew = optionalText(entry.value.crew, 'roster-crew', 'צוות', 80);
    if (opts.requireCrew === true && active && !crew) {
      fail('roster-crew', 'לאיש צוות פעיל חסר צוות');
    }
    people.set(uid, Object.freeze({
      uid: uid,
      active: active,
      crew: crew,
      display: visibleIdentity(entry.value, uid)
    }));
  });
  return people;
}

function activeRotation(value) {
  if (!own(value, 'is_active') || value.is_active === undefined || value.is_active === null) return true;
  if (typeof value.is_active !== 'boolean') {
    fail('rotation-active', 'הסימון הפעיל של מחזור אינו בוליאני');
  }
  return value.is_active;
}

function normalizeLegacyRotations(raw) {
  const entries = collectionEntries(raw, 'rotations-shape', 'מחזורי הסידור', true);
  if (entries.length > MAX_ROTATIONS) fail('rotations-too-large', 'יש יותר מדי מחזורי סידור');
  const rotations = entries.filter(function (entry) { return activeRotation(entry.value); });
  if (!rotations.length) fail('rotations-missing', 'אין מחזור סידור פעיל');

  let anchor = null;
  let cycleDays = null;
  const positions = new Map();
  const crews = new Set();
  rotations.forEach(function (entry) {
    const value = entry.value;
    const rowAnchor = String(value.anchor_date || '');
    if (!validDateKey(rowAnchor)) fail('rotation-anchor', 'תאריך העוגן של המחזור אינו תקין');
    const rowCycle = value.cycle_days;
    if (!Number.isSafeInteger(rowCycle) || rowCycle < 1 || rowCycle > 366) {
      fail('rotation-cycle', 'אורך מחזור הסידור אינו תקין');
    }
    if (anchor !== null && anchor !== rowAnchor) fail('rotation-anchor-conflict', 'תאריכי העוגן סותרים');
    if (cycleDays !== null && cycleDays !== rowCycle) fail('rotation-cycle-conflict', 'אורכי המחזור סותרים');
    anchor = rowAnchor;
    cycleDays = rowCycle;
    if (!Number.isSafeInteger(value.position_in_cycle) || value.position_in_cycle < 0
        || value.position_in_cycle >= rowCycle) {
      fail('rotation-position', 'מיקום במחזור אינו תקין');
    }
    if (positions.has(value.position_in_cycle)) fail('rotation-position-duplicate', 'מיקום במחזור מופיע פעמיים');
    const crew = nonEmptyText(value.crew, 'rotation-crew', 'צוות מחזור', 80);
    positions.set(value.position_in_cycle, crew);
    crews.add(crew);
  });
  for (let position = 0; position < cycleDays; position += 1) {
    if (!positions.has(position)) fail('rotation-gap', 'למחזור חסר יום מוגדר');
  }
  return Object.freeze({ anchor: anchor, cycleDays: cycleDays, positions: positions, crews: crews });
}

function requireKnownCrew(value, rotations, code, label) {
  const crew = nonEmptyText(value, code, label, 80);
  if (!rotations.crews.has(crew)) fail(code, label + ' אינו קיים במחזור הפעיל');
  return crew;
}

function normalizeLegacyOverrides(raw, rotations) {
  const entries = collectionEntries(raw, 'overrides-shape', 'חריגי הסידור', false);
  const byDate = new Map();
  entries.forEach(function (entry) {
    const value = entry.value;
    const date = own(value, 'date') && value.date !== undefined && value.date !== null && value.date !== ''
      ? String(value.date) : String(entry.fallback);
    if (!validDateKey(date)) fail('override-date', 'תאריך חריג אינו תקין');
    if (byDate.has(date)) fail('override-duplicate', 'יש יותר מחריג אחד לאותו תאריך');
    const kind = nonEmptyText(value.kind, 'override-kind', 'סוג חריג', 40);
    if (Object.keys(OVERRIDE_KIND).map(function (key) { return OVERRIDE_KIND[key]; })
      .indexOf(kind) === -1) fail('override-kind', 'סוג החריג אינו נתמך');
    const extra = value.extra_crews === undefined || value.extra_crews === null ? [] : value.extra_crews;
    if (!Array.isArray(extra)) fail('override-extra-crews', 'צוותי הכוננות חייבים להיות רשימה');
    const extras = extra.map(function (crew) {
      return requireKnownCrew(crew, rotations, 'override-extra-crew', 'צוות כוננות');
    });
    if (new Set(extras).size !== extras.length) fail('override-extra-crew-duplicate', 'צוות כוננות מופיע פעמיים');
    const crew = optionalText(value.crew, 'override-crew', 'צוות חריג', 80);
    let normalized;
    if (kind === OVERRIDE_KIND.SWAP) {
      if (extras.length) fail('override-extra-unexpected', 'לחריג החלפת צוות אסור צוות נוסף');
      normalized = { kind: kind, crew: requireKnownCrew(crew, rotations, 'override-crew', 'צוות חריג'), extras: [] };
    } else if (kind === OVERRIDE_KIND.STANDBY) {
      if (crew) fail('override-crew-unexpected', 'לחריג כוננות אסור צוות מחליף');
      if (!extras.length) fail('override-extra-missing', 'לחריג כוננות חסר צוות נוסף');
      normalized = { kind: kind, crew: null, extras: extras.slice().sort() };
    } else {
      if (crew || extras.length) fail('override-assignment-unexpected', 'לחריג זה אסור לשנות צוותים');
      normalized = { kind: kind, crew: null, extras: [] };
    }
    byDate.set(date, Object.freeze(normalized));
  });
  return byDate;
}

function legacyCrewState(rotations, overrides, date) {
  const position = ((dateOrdinal(date, 'query-date') - dateOrdinal(rotations.anchor, 'rotation-anchor'))
    % rotations.cycleDays + rotations.cycleDays) % rotations.cycleDays;
  const baseCrew = rotations.positions.get(position);
  if (!baseCrew) fail('rotation-gap', 'למחזור חסר יום מוגדר');
  const override = overrides.get(date);
  if (!override) return { crews: [baseCrew], source: 'legacy_rotation' };
  if (override.kind === OVERRIDE_KIND.SWAP) return { crews: [override.crew], source: 'legacy_override' };
  if (override.kind === OVERRIDE_KIND.STANDBY) {
    return { crews: Array.from(new Set([baseCrew].concat(override.extras))).sort(), source: 'legacy_standby' };
  }
  return { crews: [baseCrew], source: 'legacy_override' };
}

function legacySourceValue(input, key) {
  const legacy = plain(input.legacy) ? input.legacy : input;
  return legacy[key];
}

function approvedSwapValue(input) {
  const legacy = plain(input.legacy) ? input.legacy : input;
  const hasApproved = own(legacy, 'approved_swaps');
  const hasAll = own(legacy, 'swaps');
  if (hasApproved && hasAll) fail('swaps-ambiguous', 'יש למסור approved_swaps או swaps, לא את שניהם');
  return { value: hasApproved ? legacy.approved_swaps : legacy.swaps, explicitlyApproved: hasApproved };
}

function basePersonWorks(person, state) {
  return person.active === true && !!person.crew && state.crews.indexOf(person.crew) !== -1;
}

function knownLegacyCrew(value, rotations) {
  if (typeof value !== 'string') return null;
  const crew = value.trim();
  return crew && !CONTROL_RE.test(crew) && crew.length <= 80 && rotations.crews.has(crew)
    ? crew : null;
}

function orderedApprovedSwapRows(raw, explicitlyApproved) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    fail('swaps-order', 'החלפות מאושרות חייבות להיות מערך לפי סדר המקור');
  }
  if (raw.length > MAX_SWAPS) fail('swaps-too-large', 'יש יותר מדי החלפות');
  const rows = [];
  raw.forEach(function (value, index) {
    // The existing legacy loop skips malformed/unapproved raw rows.  Keep that
    // behavior instead of turning a historical record into a startup failure.
    if (!plain(value)) return;
    // `approved_swaps` is an asserted server-side filter, not a second raw
    // collection.  A pending/rejected row in that envelope is therefore a
    // contradictory snapshot: never apply it and never silently turn it into
    // an "approved" operational effect.
    if (explicitlyApproved && value.status !== 'approved') {
      fail('approved-swaps-status', 'מעטפת ההחלפות המאושרות כוללת החלפה שאינה מאושרת');
    }
    if (!explicitlyApproved && value.status !== 'approved') return;
    rows.push({ value: value, index: index });
  });
  return rows;
}

function swapEffectFor(orderedRows, uid, date, rotations) {
  // This intentionally mirrors rotation.js: first matching approved row wins,
  // before checking the person's normal crew assignment.
  for (let index = 0; index < orderedRows.length; index += 1) {
    const value = orderedRows[index].value;
    if (date === value.from_date) {
      if (uid === value.from_uid) return { action: 'out', row: orderedRows[index] };
      if (uid === value.to_uid) {
        return { action: 'in', crew: knownLegacyCrew(value.from_crew, rotations), row: orderedRows[index] };
      }
    }
    if (date === value.to_date) {
      if (uid === value.to_uid) return { action: 'out', row: orderedRows[index] };
      if (uid === value.from_uid) {
        return { action: 'in', crew: knownLegacyCrew(value.to_crew, rotations), row: orderedRows[index] };
      }
    }
  }
  return null;
}

function swapRowIsHistoricalAnomaly(value, roster, rotations, overrides, explicitlyApproved) {
  const fromUid = value.from_uid;
  const toUid = value.to_uid;
  const fromDate = value.from_date;
  const toDate = value.to_date;
  if (!explicitlyApproved && value.status !== 'approved') return false;
  if (explicitlyApproved && own(value, 'status') && value.status !== 'approved') return true;
  if (typeof fromUid !== 'string' || typeof toUid !== 'string' || fromUid === toUid
      || !validDateKey(fromDate) || !validDateKey(toDate) || fromDate === toDate) return true;
  const from = roster.get(fromUid);
  const to = roster.get(toUid);
  const fromCrew = knownLegacyCrew(value.from_crew, rotations);
  const toCrew = knownLegacyCrew(value.to_crew, rotations);
  if (!from || !to || !from.active || !to.active || !fromCrew || !toCrew
      || from.crew !== fromCrew || to.crew !== toCrew) return true;
  const fromState = legacyCrewState(rotations, overrides, fromDate);
  const toState = legacyCrewState(rotations, overrides, toDate);
  return !basePersonWorks(from, fromState) || !basePersonWorks(to, toState)
    || basePersonWorks(from, toState) || basePersonWorks(to, fromState);
}

function normalizeApprovedSwaps(raw, explicitlyApproved, roster, rotations, overrides) {
  const orderedRows = orderedApprovedSwapRows(raw, explicitlyApproved).map(function (row) {
    return Object.freeze({
      value: row.value,
      index: row.index,
      historicalAnomaly: swapRowIsHistoricalAnomaly(
        row.value, roster, rotations, overrides, explicitlyApproved
      )
    });
  });

  function anomaliesOn(date) {
    const codes = new Set();
    const claimed = new Set();
    orderedRows.forEach(function (row) {
      const value = row.value;
      const touchesDate = date === value.from_date || date === value.to_date;
      if (!touchesDate) return;
      if (row.historicalAnomaly) codes.add('legacy_swap_historical_anomaly');
      [value.from_uid, value.to_uid].forEach(function (uid) {
        if (typeof uid !== 'string') return;
        const effect = swapEffectFor([row], uid, date, rotations);
        if (!effect) return;
        if (claimed.has(uid)) codes.add('legacy_swap_ordered_overlap');
        claimed.add(uid);
      });
    });
    return Array.from(codes).sort();
  }

  return Object.freeze({
    effectFor: function effectFor(uid, date) {
      return swapEffectFor(orderedRows, uid, date, rotations);
    },
    anomaliesOn: anomaliesOn
  });
}

function legacyModel(input, stationId) {
  const roster = normalizeRoster(input.roster, {
    required: true, requireCrew: false, stationId: stationId
  });
  const rotations = normalizeLegacyRotations(legacySourceValue(input, 'rotations'));
  roster.forEach(function (person) {
    if (person.active && person.crew && !rotations.crews.has(person.crew)) {
      fail('roster-crew-unknown', 'צוות של איש צוות אינו מופיע במחזור');
    }
  });
  const overrides = normalizeLegacyOverrides(legacySourceValue(input, 'overrides'), rotations);
  const swapInput = approvedSwapValue(input);
  const swaps = normalizeApprovedSwaps(swapInput.value, swapInput.explicitlyApproved,
    roster, rotations, overrides);

  function personWorks(uid, date, state) {
    const effect = swaps.effectFor(uid, date);
    if (effect && effect.action === 'out') return false;
    if (effect && effect.action === 'in') return true;
    const person = roster.get(uid);
    return !!person && basePersonWorks(person, state);
  }

  function assignmentsOn(date) {
    const state = legacyCrewState(rotations, overrides, date);
    const rows = new Map();
    roster.forEach(function (person) {
      const effect = swaps.effectFor(person.uid, date);
      if (!personWorks(person.uid, date, state)) return;
      rows.set(person.uid, Object.freeze({
        uid: person.uid,
        display: person.display,
        crew: effect && effect.action === 'in' && effect.crew ? effect.crew : person.crew,
        source: effect ? 'legacy_swap' : state.source
      }));
    });
    return Array.from(rows.values()).sort(function (left, right) {
      return left.uid < right.uid ? -1 : (left.uid > right.uid ? 1 : 0);
    });
  }

  return Object.freeze({
    source: SOURCE.LEGACY,
    station_id: stationId,
    assignmentsOn: assignmentsOn,
    anomaliesOn: swaps.anomaliesOn,
    isPersonWorking: function isPersonWorking(uid, date) {
      return personWorks(uid, date, legacyCrewState(rotations, overrides, date));
    }
  });
}

function v2Model(input, stationId) {
  if (!plain(input.plan)) fail('plan-required', 'חסרה תוכנית V2 פעילה');
  const plan = input.plan;
  if (plan.kind !== 'schedule-plan') fail('plan-kind', 'התוכנית אינה תוכנית סידור V2');
  if (plan.station_id !== stationId) fail('plan-station', 'התוכנית שייכת לתחנה אחרת');
  const from = String(plan.from || '');
  const to = String(plan.to || '');
  const fromOrdinal = dateOrdinal(from, 'plan-range');
  const toOrdinal = dateOrdinal(to, 'plan-range');
  if (toOrdinal < fromOrdinal || toOrdinal - fromOrdinal + 1 > MAX_WINDOW_DAYS) {
    fail('plan-range', 'טווח תוכנית V2 אינו תקין');
  }
  if (!Array.isArray(plan.rows) || !plan.rows.length || plan.rows.length > MAX_ROWS) {
    fail('plan-rows', 'שורות תוכנית V2 אינן תקינות');
  }
  const roster = normalizeRoster(input.roster, {
    required: false, requireCrew: false, stationId: stationId
  });
  const days = new Map();
  let slots = 0;
  plan.rows.forEach(function (row) {
    if (!plain(row) || row.station_id !== stationId) fail('plan-row-station', 'שורת תוכנית שייכת לתחנה אחרת');
    const date = String(row.date || '');
    const ordinal = dateOrdinal(date, 'plan-row-date');
    if (ordinal < fromOrdinal || ordinal > toOrdinal) fail('plan-row-range', 'שורת תוכנית מחוץ לטווח');
    const subStation = nonEmptyText(row.sub_station, 'plan-row-sub-station', 'תחנת קצה', 120);
    if (!Array.isArray(row.slots)) fail('plan-row-slots', 'לשורת תוכנית חסרות משבצות');
    if (!days.has(date)) days.set(date, new Map());
    const people = days.get(date);
    row.slots.forEach(function (slot) {
      slots += 1;
      if (slots > MAX_SLOTS) fail('plan-slots-too-large', 'בתוכנית יש יותר מדי משבצות');
      if (!plain(slot)) fail('plan-slot', 'משבצת תוכנית אינה תקינה');
      if (slot.cancelled !== undefined && typeof slot.cancelled !== 'boolean') {
        fail('plan-slot-cancelled', 'סימון ביטול משבצת אינו בוליאני');
      }
      if (slot.cancelled === true) return;
      const uid = uidOf(slot.person, 'plan-slot-person', 'מזהה משובץ');
      if (people.has(uid)) fail('plan-person-duplicate-day', 'אדם משובץ פעמיים באותו יום');
      const role = optionalText(slot.role, 'plan-slot-role', 'תפקיד משובץ', 120);
      const identity = roster.get(uid);
      // A V2 publication is an immutable, self-contained snapshot.  Unlike
      // legacy historical swaps, it may never render an unknown UID merely
      // because its people dictionary was truncated or tampered with.
      if (!identity) {
        fail('plan-person-missing', 'משבצת V2 מפנה לאיש צוות שאינו בתמונת הפרסום');
      }
      if (identity.active !== true) {
        fail('plan-person-inactive', 'תוכנית V2 משבצת איש צוות שאינו פעיל');
      }
      people.set(uid, Object.freeze({
        uid: uid,
        display: identity ? identity.display : uid,
        sub_station: subStation,
        role: role,
        source: 'v2'
      }));
    });
  });

  function assignmentsOn(date) {
    const rows = days.get(date);
    return rows ? Array.from(rows.values()).sort(function (left, right) {
      return left.uid < right.uid ? -1 : (left.uid > right.uid ? 1 : 0);
    }) : [];
  }

  return Object.freeze({
    source: SOURCE.V2,
    station_id: stationId,
    from: from,
    to: to,
    fromOrdinal: fromOrdinal,
    toOrdinal: toOrdinal,
    assignmentsOn: assignmentsOn
  });
}

function dateRange(argument, second, model) {
  const value = plain(argument) ? argument : { from: argument, to: second };
  const from = String(value.from || '');
  const to = String(value.to || '');
  const fromOrdinal = dateOrdinal(from, 'window-date');
  const toOrdinal = dateOrdinal(to, 'window-date');
  if (toOrdinal < fromOrdinal || toOrdinal - fromOrdinal + 1 > MAX_WINDOW_DAYS) {
    fail('window-range', 'טווח החלון אינו תקין');
  }
  if (model.source === SOURCE.V2 && (fromOrdinal < model.fromOrdinal || toOrdinal > model.toOrdinal)) {
    fail('window-outside-plan', 'טווח החלון מחוץ לתוכנית V2 הפעילה');
  }
  return { from: from, to: to, fromOrdinal: fromOrdinal, toOrdinal: toOrdinal };
}

function dateFromOrdinal(ordinal) {
  // Binary search the civil year.  This is deterministic calendar arithmetic,
  // not a clock read, and keeps the module free of local-time assumptions.
  let low = 1;
  let high = 9999;
  while (low <= high) {
    const year = Math.floor((low + high) / 2);
    const start = dateOrdinal(String(year).padStart(4, '0') + '-01-01', 'date-invalid');
    const next = year === 9999 ? Number.MAX_SAFE_INTEGER
      : dateOrdinal(String(year + 1).padStart(4, '0') + '-01-01', 'date-invalid');
    if (ordinal < start) high = year - 1;
    else if (ordinal >= next) low = year + 1;
    else {
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      let remaining = ordinal - start;
      let month = 0;
      while (remaining >= days[month]) {
        remaining -= days[month];
        month += 1;
      }
      return String(year).padStart(4, '0') + '-' + String(month + 1).padStart(2, '0')
        + '-' + String(remaining + 1).padStart(2, '0');
    }
  }
  fail('date-invalid', 'תאריך לא תקין');
}

function freezeWindow(model, range) {
  const days = [];
  for (let ordinal = range.fromOrdinal; ordinal <= range.toOrdinal; ordinal += 1) {
    const date = dateFromOrdinal(ordinal);
    const assignments = model.assignmentsOn(date).map(function (assignment) {
      return Object.freeze(Object.assign({}, assignment));
    });
    const day = { date: date, assignments: Object.freeze(assignments) };
    const anomalies = model.anomaliesOn ? model.anomaliesOn(date) : [];
    if (anomalies.length) day.anomaly_codes = Object.freeze(anomalies.slice());
    days.push(Object.freeze(day));
  }
  return Object.freeze({
    kind: 'operational-station-window',
    source: model.source,
    station_id: model.station_id,
    from: range.from,
    to: range.to,
    days: Object.freeze(days)
  });
}

function createOperationalProjection(input) {
  if (!plain(input)) fail('input-required', 'חובה למסור קלט לסידור התפעולי');
  const source = input.source;
  if (source !== SOURCE.LEGACY && source !== SOURCE.V2) {
    fail('source-invalid', 'יש לבחור מקור legacy או v2 במפורש');
  }
  const stationId = idOf(input.station_id, 'station-id', 'מזהה תחנה');
  const model = source === SOURCE.LEGACY ? legacyModel(input, stationId) : v2Model(input, stationId);

  function checkedDate(date) {
    const out = String(date || '');
    dateOrdinal(out, 'query-date');
    if (model.source === SOURCE.V2) {
      const ordinal = dateOrdinal(out, 'query-date');
      if (ordinal < model.fromOrdinal || ordinal > model.toOrdinal) {
        fail('query-outside-plan', 'התאריך מחוץ לתוכנית V2 הפעילה');
      }
    }
    return out;
  }

  return Object.freeze({
    source: model.source,
    station_id: stationId,
    isPersonWorking: function isPersonWorking(uid, date) {
      const person = uidOf(uid, 'query-uid', 'מזהה איש צוות');
      const day = checkedDate(date);
      if (model.isPersonWorking) return model.isPersonWorking(person, day);
      return model.assignmentsOn(day).some(function (assignment) { return assignment.uid === person; });
    },
    stationWindow: function stationWindow(range, to) {
      return freezeWindow(model, dateRange(range, to, model));
    }
  });
}

module.exports = Object.freeze({
  SOURCE: SOURCE,
  OVERRIDE_KIND: OVERRIDE_KIND,
  MAX_WINDOW_DAYS: MAX_WINDOW_DAYS,
  OperationalProjectionError: OperationalProjectionError,
  validDateKey: validDateKey,
  createOperationalProjection: createOperationalProjection
});
