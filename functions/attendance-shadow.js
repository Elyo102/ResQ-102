'use strict';

// Pure planning and comparison engine for the attendance shadow workflow.
//
// Deliberate boundaries:
//   * no Firebase/Admin SDK
//   * no I/O and no writes
//   * UID is the only persisted person identifier
//   * uncertainty becomes a conflict; identity matching is UID-only

const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const TIME_ZONE = 'Asia/Jerusalem';
const CREWS = Object.freeze(['A', 'B', 'C']);
const ROLES = Object.freeze([
  'firefighter', 'deputy_team_leader', 'team_leader',
  'deputy', 'commander', 'station_commander', 'hr_coordinator'
]);
const OVERRIDE_KINDS = Object.freeze(['swap', 'holiday', 'training', 'standby']);
const EXCEPTION_TYPES = Object.freeze([
  'vacation', 'sick', 'reserve', 'guard', 'extra', 'meeting', 'swap'
]);
const FORBIDDEN_SHADOW_KEYS = Object.freeze([
  'name', 'full_name', 'full_name_snapshot', 'email', 'phone', 'telephone',
  'emp', 'emp_number', 'employee_number', 'notes', 'note', 'by_name',
  'attendance_doc_id', 'attendance_doc_ids', 'overtime_reason'
]);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uniqueSorted(values) {
  return Array.from(new Set((values || []).map(String))).sort();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!plainObject(value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return value;
  }
  const out = {};
  Object.keys(value).sort().forEach(function (key) {
    if (value[key] !== undefined) out[key] = canonicalize(value[key]);
  });
  return out;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalHash(value) {
  return crypto.createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

function validDateKey(value) {
  const key = String(value || '');
  const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function dateOrdinal(key) {
  if (!validDateKey(key)) return null;
  const parts = String(key).split('-').map(Number);
  return Math.floor(Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86400000);
}

function addDays(key, amount) {
  const ordinal = dateOrdinal(key);
  if (ordinal === null || !Number.isInteger(Number(amount))) return '';
  return new Date((ordinal + Number(amount)) * 86400000).toISOString().slice(0, 10);
}

function localDateKey(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value == null ? Date.now() : value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const map = {};
  parts.forEach(function (part) { map[part.type] = part.value; });
  return map.year + '-' + map.month + '-' + map.day;
}

function validClock(value) {
  return /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(String(value || ''));
}

function clockMinutes(value) {
  if (!validClock(value)) return null;
  const parts = String(value).split(':').map(Number);
  return parts[0] * 60 + parts[1];
}

function hoursMinutes(value) {
  const hours = Number(value);
  const minutes = hours * 60;
  if (!Number.isFinite(hours) || hours <= 0 || hours > 48 ||
      !Number.isInteger(minutes)) return null;
  return minutes;
}

function endFrom(start, durationMinutes) {
  const startMinutes = clockMinutes(start);
  if (startMinutes === null || !Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    return null;
  }
  const total = startMinutes + durationMinutes;
  const endMinutes = total % 1440;
  return {
    end: String(Math.floor(endMinutes / 60)).padStart(2, '0') + ':' +
      String(endMinutes % 60).padStart(2, '0'),
    endDay: Math.floor(total / 1440)
  };
}

function docId(doc, fallback) {
  return String((doc && (doc.id || doc.uid)) || fallback || '');
}

function normalizeDocs(value) {
  if (Array.isArray(value)) {
    return value.map(function (item, index) {
      if (Array.isArray(item) && item.length >= 2) {
        return Object.assign({}, item[1] || {}, { id: String(item[0]) });
      }
      return Object.assign({}, item || {}, { id: docId(item, String(index)) });
    });
  }
  if (plainObject(value)) {
    return Object.keys(value).map(function (id) {
      return Object.assign({}, value[id] || {}, { id: id });
    });
  }
  return [];
}

function fieldConsensus(docs, field, fallback) {
  const values = uniqueSorted(docs.filter(function (doc) {
    return doc[field] !== undefined && doc[field] !== null && doc[field] !== '';
  }).map(function (doc) { return doc[field]; }));
  return {
    value: values.length === 1 ? docs.find(function (doc) {
      return String(doc[field]) === values[0];
    })[field] : fallback,
    explicit: values.length === 1,
    conflict: values.length > 1
  };
}

function validateRotations(rawRotations) {
  const active = normalizeDocs(rawRotations).filter(function (rotation) {
    return rotation.is_active !== false;
  });
  const conflicts = [];
  if (!active.length) conflicts.push('missing_rotations');

  const anchors = uniqueSorted(active.map(function (rotation) {
    return rotation.anchor_date;
  }).filter(Boolean));
  const cycles = uniqueSorted(active.map(function (rotation) {
    return rotation.cycle_days;
  }).filter(function (value) { return value !== undefined && value !== null; }));
  if (anchors.length !== 1 || !validDateKey(anchors[0])) conflicts.push('inconsistent_anchor');
  if (cycles.length !== 1 || !Number.isInteger(Number(cycles[0])) || Number(cycles[0]) <= 0) {
    conflicts.push('inconsistent_cycle');
  }

  const positions = {};
  active.forEach(function (rotation) {
    const crew = String(rotation.crew || '');
    const position = Number(rotation.position_in_cycle);
    if (CREWS.indexOf(crew) === -1) conflicts.push('invalid_rotation_crew');
    if (!Number.isInteger(position) || position < 0) conflicts.push('invalid_rotation_position');
    const key = String(position);
    if (positions[key]) conflicts.push('duplicate_rotation_position');
    else positions[key] = crew;
  });

  const defaults = {
    shift_start: '07:00', shift_end: '07:00', shift_hours: 24,
    commander_start: '', commander_shift_hours: 24.25,
    special_end: '08:00', special_shift_hours: 25
  };
  const time = {};
  const explicit = {};
  Object.keys(defaults).forEach(function (field) {
    const found = fieldConsensus(active, field, defaults[field]);
    time[field] = found.value;
    explicit[field] = found.explicit;
    if (found.conflict) conflicts.push('inconsistent_' + field);
  });

  ['shift_start', 'shift_end', 'commander_start', 'special_end'].forEach(function (field) {
    if (time[field] && !validClock(time[field])) conflicts.push('invalid_' + field);
  });
  ['shift_hours', 'commander_shift_hours', 'special_shift_hours'].forEach(function (field) {
    if (hoursMinutes(time[field]) === null) conflicts.push('invalid_' + field);
  });

  return {
    ok: conflicts.length === 0,
    conflicts: uniqueSorted(conflicts),
    ids: active.map(function (rotation) { return docId(rotation); }).sort(),
    anchorDate: anchors.length === 1 ? anchors[0] : '',
    cycleDays: cycles.length === 1 ? Number(cycles[0]) : 0,
    positions: positions,
    time: time,
    explicit: explicit
  };
}

function normalizeOverrides(rawOverrides) {
  const byDate = {};
  const duplicates = {};
  normalizeDocs(rawOverrides).forEach(function (override) {
    const id = docId(override);
    const date = validDateKey(override.date) ? String(override.date) : id;
    if (!validDateKey(date)) return;
    if (byDate[date]) duplicates[date] = true;
    else byDate[date] = Object.assign({}, override, { id: id, date: date });
  });
  return { byDate: byDate, duplicates: duplicates };
}

function crewStateOnDate(rotationModel, rawOverrides, date) {
  const conflicts = [];
  const warnings = [];
  if (!validDateKey(date)) return { crews: [], conflicts: ['invalid_date'], warnings: [] };
  if (!rotationModel || !rotationModel.ok) {
    return { crews: [], conflicts: (rotationModel && rotationModel.conflicts) ||
      ['missing_rotations'], warnings: [] };
  }

  const index = ((dateOrdinal(date) - dateOrdinal(rotationModel.anchorDate)) %
    rotationModel.cycleDays + rotationModel.cycleDays) % rotationModel.cycleDays;
  const baseCrew = rotationModel.positions[String(index)] || '';
  if (!baseCrew) conflicts.push('rotation_gap');

  const normalized = rawOverrides && rawOverrides.byDate
    ? rawOverrides : normalizeOverrides(rawOverrides);
  if (normalized.duplicates[date]) conflicts.push('duplicate_override');
  const override = normalized.byDate[date] || null;
  let crews = baseCrew ? [baseCrew] : [];
  let sourceKind = 'rotation';
  let overrideId = '';

  if (override) {
    overrideId = override.id;
    const kind = String(override.kind || '');
    const crew = String(override.crew || '');
    const extras = Array.isArray(override.extra_crews)
      ? override.extra_crews.map(String) : [];
    if (OVERRIDE_KINDS.indexOf(kind) === -1) conflicts.push('invalid_override_kind');
    if (kind === 'swap') {
      if (CREWS.indexOf(crew) === -1) conflicts.push('invalid_override_crew');
      if (extras.length) conflicts.push('unexpected_override_extra_crews');
      if (!conflicts.length) crews = [crew];
      sourceKind = 'override';
    } else if (kind === 'standby') {
      if (crew) conflicts.push('unexpected_override_crew');
      if (!extras.length) conflicts.push('missing_standby_crews');
      if (extras.some(function (item) { return CREWS.indexOf(item) === -1; })) {
        conflicts.push('invalid_standby_crew');
      }
      crews = uniqueSorted(crews.concat(extras.filter(function (item) {
        return CREWS.indexOf(item) !== -1;
      })));
      sourceKind = 'standby';
    } else if (kind === 'holiday' || kind === 'training') {
      if (crew || extras.length) conflicts.push('unexpected_override_assignment');
      sourceKind = 'override';
    }
  }

  return {
    crews: uniqueSorted(crews),
    baseCrew: baseCrew,
    sourceKind: sourceKind,
    overrideId: overrideId,
    conflicts: uniqueSorted(conflicts),
    warnings: uniqueSorted(warnings)
  };
}

function personMap(rawUsers, rawRoster) {
  const users = normalizeDocs(rawUsers);
  const roster = normalizeDocs(rawRoster);
  const rosterByUid = {};
  roster.forEach(function (person) { rosterByUid[docId(person)] = person; });
  const empGroups = {};
  users.filter(function (person) { return person.is_active !== false; })
    .forEach(function (person) {
      const emp = String(person.employee_number || person.emp_number || '').trim();
      if (emp) (empGroups[emp] = empGroups[emp] || []).push(docId(person));
    });

  const people = {};
  users.forEach(function (person) {
    const uid = docId(person);
    if (!uid || person.is_active === false) return;
    const conflicts = [], warnings = [];
    const rawCrew = String(person.crew || '');
    const rawRole = String(person.role || '');
    const crew = CREWS.indexOf(rawCrew) === -1 ? '' : rawCrew;
    const role = ROLES.indexOf(rawRole) === -1 ? 'unknown' : rawRole;
    const emp = String(person.employee_number || person.emp_number || '').trim();
    if (!emp) conflicts.push('missing_emp');
    else if ((empGroups[emp] || []).length > 1) conflicts.push('duplicate_emp');
    if (CREWS.indexOf(rawCrew) === -1) conflicts.push('missing_or_invalid_crew');
    if (ROLES.indexOf(rawRole) === -1) conflicts.push('unknown_role');

    const mirror = rosterByUid[uid];
    if (!mirror || mirror.is_active === false) conflicts.push('missing_roster');
    else {
      if (String(mirror.crew || '') !== rawCrew) conflicts.push('roster_crew_mismatch');
      if (String(mirror.role || '') !== rawRole) conflicts.push('roster_role_mismatch');
      if (String(mirror.full_name || '') !== String(person.full_name || '')) {
        warnings.push('roster_name_mismatch');
      }
    }
    people[uid] = {
      uid: uid,
      role: role,
      crew: crew,
      emp: emp,
      conflicts: uniqueSorted(conflicts),
      warnings: uniqueSorted(warnings)
    };
  });
  return people;
}

function prelimSwap(raw, people, rotationModel, overrides) {
  const swap = Object.assign({}, raw);
  swap.id = docId(raw);
  swap.from_uid = String(raw.from_uid || '');
  swap.to_uid = String(raw.to_uid || '');
  swap.from_crew = String(raw.from_crew || '');
  swap.to_crew = String(raw.to_crew || '');
  swap.from_date = String(raw.from_date || '');
  swap.to_date = String(raw.to_date || '');
  swap.conflicts = [];
  if (!swap.id) swap.conflicts.push('missing_swap_id');
  if (!swap.from_uid || !swap.to_uid) swap.conflicts.push('missing_swap_party');
  if (swap.from_uid && swap.from_uid === swap.to_uid) swap.conflicts.push('same_swap_party');
  if (!people[swap.from_uid] || !people[swap.to_uid]) swap.conflicts.push('unknown_swap_party');
  if (!validDateKey(swap.from_date) || !validDateKey(swap.to_date)) {
    swap.conflicts.push('invalid_swap_date');
  } else if (swap.from_date === swap.to_date) swap.conflicts.push('same_swap_date');
  if (CREWS.indexOf(swap.from_crew) === -1 || CREWS.indexOf(swap.to_crew) === -1) {
    swap.conflicts.push('invalid_swap_crew');
  }
  if (people[swap.from_uid] && people[swap.from_uid].crew !== swap.from_crew) {
    swap.conflicts.push('from_crew_mismatch');
  }
  if (people[swap.to_uid] && people[swap.to_uid].crew !== swap.to_crew) {
    swap.conflicts.push('to_crew_mismatch');
  }
  if (validDateKey(swap.from_date)) {
    const state = crewStateOnDate(rotationModel, overrides, swap.from_date);
    if (state.conflicts.length || state.crews.indexOf(swap.from_crew) === -1) {
      swap.conflicts.push('from_date_not_scheduled');
    }
  }
  if (validDateKey(swap.to_date)) {
    const state = crewStateOnDate(rotationModel, overrides, swap.to_date);
    if (state.conflicts.length || state.crews.indexOf(swap.to_crew) === -1) {
      swap.conflicts.push('to_date_not_scheduled');
    }
  }
  swap.conflicts = uniqueSorted(swap.conflicts);
  return swap;
}

function effectsOf(swap) {
  return [
    { uid: swap.from_uid, date: swap.from_date, kind: 'out', swap: swap },
    { uid: swap.from_uid, date: swap.to_date, kind: 'in', coveredUid: swap.to_uid,
      effectiveCrew: swap.to_crew, swap: swap },
    { uid: swap.to_uid, date: swap.to_date, kind: 'out', swap: swap },
    { uid: swap.to_uid, date: swap.from_date, kind: 'in', coveredUid: swap.from_uid,
      effectiveCrew: swap.from_crew, swap: swap }
  ];
}

function validateApprovedSwaps(rawSwaps, people, rotationModel, overrides) {
  const swaps = normalizeDocs(rawSwaps).filter(function (swap) {
    return swap.status === 'approved';
  }).map(function (swap) {
    return prelimSwap(swap, people, rotationModel, overrides);
  });

  const effectIndex = {};
  swaps.forEach(function (swap) {
    effectsOf(swap).forEach(function (effect) {
      if (!effect.uid || !validDateKey(effect.date)) return;
      const key = effect.uid + '|' + effect.date;
      (effectIndex[key] = effectIndex[key] || []).push(effect);
    });
  });
  Object.keys(effectIndex).forEach(function (key) {
    if (effectIndex[key].length <= 1) return;
    effectIndex[key].forEach(function (effect) {
      effect.swap.conflicts.push('multiple_swap_effects');
    });
  });

  function worksIgnoring(uid, crew, date, ignoredSwapId, gain, lose) {
    if (date === lose) return false;
    if (date === gain) return true;
    const other = (effectIndex[uid + '|' + date] || []).filter(function (effect) {
      return effect.swap.id !== ignoredSwapId && effect.swap.conflicts.length === 0;
    });
    if (other.length === 1) return other[0].kind === 'in';
    if (other.length > 1) return null;
    const state = crewStateOnDate(rotationModel, overrides, date);
    if (state.conflicts.length) return null;
    return state.crews.indexOf(crew) !== -1;
  }

  swaps.forEach(function (swap) {
    if (swap.conflicts.length) return;
    const sides = [
      { uid: swap.from_uid, crew: swap.from_crew,
        gain: swap.to_date, lose: swap.from_date },
      { uid: swap.to_uid, crew: swap.to_crew,
        gain: swap.from_date, lose: swap.to_date }
    ];
    sides.forEach(function (side) {
      [-1, 1].forEach(function (offset) {
        const adjacent = addDays(side.gain, offset);
        const works = worksIgnoring(side.uid, side.crew, adjacent,
          swap.id, side.gain, side.lose);
        if (works === true) swap.conflicts.push('rest_violation');
        if (works === null) swap.conflicts.push('rest_check_ambiguous');
      });
    });
    swap.conflicts = uniqueSorted(swap.conflicts);
  });

  const finalEffects = {};
  swaps.forEach(function (swap) {
    swap.conflicts = uniqueSorted(swap.conflicts);
    effectsOf(swap).forEach(function (effect) {
      if (!effect.uid || !validDateKey(effect.date)) return;
      const key = effect.uid + '|' + effect.date;
      (finalEffects[key] = finalEffects[key] || []).push(effect);
    });
  });
  return { swaps: swaps, effects: finalEffects };
}

function swapDecision(swapModel, uid, date) {
  const effects = (swapModel.effects[uid + '|' + date] || []).slice();
  const conflicts = [];
  effects.forEach(function (effect) {
    effect.swap.conflicts.forEach(function (code) {
      conflicts.push('swap_' + code);
    });
  });
  if (effects.length > 1) conflicts.push('swap_multiple_effects');
  if (conflicts.length) return { effect: null, conflicts: uniqueSorted(conflicts) };
  return { effect: effects[0] || null, conflicts: [] };
}

function subStationAvailable(site) {
  if (!plainObject(site)) return false;
  const state = String(site.status || '').toLowerCase();
  return site.is_active !== false && site.active !== false && site.archived !== true &&
    state !== 'inactive' && state !== 'archived';
}

function boardIndex(rawBoard) {
  const board = plainObject(rawBoard) ? rawBoard : {};
  const slots = {};
  const conflicts = [];
  function add(slot, kind) {
    if (!plainObject(slot) || !slot.id) { conflicts.push('invalid_board_slot'); return; }
    const id = String(slot.id);
    if (slots[id]) conflicts.push('duplicate_board_slot');
    else slots[id] = { id: id, site: String(slot.site || ''), kind: kind };
  }
  (Array.isArray(board.command) ? board.command : []).forEach(function (slot) {
    add(slot, 'command');
  });
  (Array.isArray(board.vehicles) ? board.vehicles : []).forEach(function (vehicle) {
    (Array.isArray(vehicle.slots) ? vehicle.slots : []).forEach(function (slot) {
      add(slot, 'vehicle');
    });
  });
  return { slots: slots, conflicts: uniqueSorted(conflicts) };
}

function siteMap(rawSites) {
  const out = {};
  normalizeDocs(rawSites).forEach(function (site) {
    out[docId(site)] = site;
  });
  return out;
}

function resolveStation(options) {
  const opts = options || {};
  const conflicts = [], warnings = [];
  const crew = String(opts.crew || '');
  const uid = String(opts.targetUid || '');
  const shift = plainObject(opts.shifts && opts.shifts[crew])
    ? opts.shifts[crew] : null;
  const index = opts.boardModel || boardIndex(opts.board);
  const sites = opts.siteModel || siteMap(opts.subStations);
  if (index.conflicts.length) conflicts.push.apply(conflicts, index.conflicts);
  if (!shift || !plainObject(shift.assign)) conflicts.push('missing_shift_assignment');
  const assigned = shift && plainObject(shift.assign) ? Object.keys(shift.assign).filter(function (slotId) {
    return String(shift.assign[slotId] || '') === uid;
  }).sort() : [];
  if (!assigned.length) conflicts.push('missing_assignment');

  const siteIds = [];
  let unlocated = 0;
  assigned.forEach(function (slotId) {
    const slot = index.slots[slotId];
    if (!slot) { conflicts.push('unknown_assigned_slot'); return; }
    if (!slot.site) { unlocated++; return; }
    siteIds.push(slot.site);
  });
  const uniqueSites = uniqueSorted(siteIds);
  let siteId = '';
  let source = opts.coveredUid ? 'covered_slot' : 'assigned_slot';
  if (uniqueSites.length > 1) conflicts.push('ambiguous_station');
  else if (uniqueSites.length === 1) siteId = uniqueSites[0];
  else if (assigned.length && opts.defaultSubStation) {
    siteId = String(opts.defaultSubStation);
    source = 'configured_default';
    warnings.push('default_station_used');
  } else if (assigned.length) conflicts.push('missing_station');
  if (unlocated && siteId) warnings.push('unlocated_slots');

  const site = siteId ? sites[siteId] : null;
  if (siteId && (!site || !subStationAvailable(site))) conflicts.push('inactive_or_unknown_station');
  const fixedHours = site ? Number(site.fixed_hours || 0) : 0;
  if (site && (!Number.isFinite(fixedHours) || fixedHours < 0 || fixedHours > 48 ||
      !Number.isInteger(fixedHours * 60))) conflicts.push('invalid_station_hours');

  return {
    subStation: siteId,
    fixedHours: fixedHours,
    stationSource: source,
    slotIds: assigned,
    conflicts: uniqueSorted(conflicts),
    warnings: uniqueSorted(warnings)
  };
}

function resolvePlannedTimes(role, station, rotationModel) {
  const conflicts = [], warnings = [];
  const time = rotationModel.time || {};
  let start = String(time.shift_start || '');
  let minutes = hoursMinutes(time.shift_hours);
  let rule = 'regular';
  const fixedHours = Number((station && station.fixedHours) || 0);

  if (role === 'commander') {
    rule = 'commander';
    if (!rotationModel.explicit.commander_start) conflicts.push('missing_commander_start');
    start = String(time.commander_start || '');
    minutes = hoursMinutes(time.commander_shift_hours);
    if (fixedHours > 0) conflicts.push('commander_site_hours_unresolved');
  } else if (fixedHours > 0) {
    rule = 'site_fixed';
    minutes = hoursMinutes(fixedHours);
  }

  if (!validClock(start)) conflicts.push('invalid_planned_start');
  if (minutes === null) conflicts.push('invalid_planned_duration');
  const derived = conflicts.length ? null : endFrom(start, minutes);
  if (derived && rule !== 'site_fixed' && String(time.shift_end || '') !== derived.end) {
    conflicts.push('time_config_inconsistent');
  }
  return {
    start: derived ? start : '',
    end: derived ? derived.end : '',
    endDay: derived ? derived.endDay : 0,
    minutes: derived ? minutes : 0,
    hours: derived ? Math.round((minutes / 60) * 100) / 100 : 0,
    rule: rule,
    conflicts: uniqueSorted(conflicts),
    warnings: uniqueSorted(warnings)
  };
}

function sanitizedSource(input, people, rotationModel, overrides, swaps) {
  const board = plainObject(input.board) ? input.board : {};
  const cleanSlots = [];
  function pushSlots(items, kind) {
    (Array.isArray(items) ? items : []).forEach(function (slot) {
      cleanSlots.push({ id: String(slot.id || ''), site: String(slot.site || ''), kind: kind });
    });
  }
  pushSlots(board.command, 'command');
  (Array.isArray(board.vehicles) ? board.vehicles : []).forEach(function (vehicle) {
    pushSlots(vehicle.slots, 'vehicle');
  });
  const safePeople = Object.keys(people).sort().map(function (uid) {
    const p = people[uid];
    return { uid: uid, role: p.role, crew: p.crew,
      identity_conflicts: p.conflicts, identity_warnings: p.warnings };
  });
  const safeOverrides = Object.keys(overrides.byDate).sort().map(function (date) {
    const item = overrides.byDate[date];
    return { id: item.id, date: date, kind: String(item.kind || ''),
      crew: String(item.crew || ''), extra_crews: uniqueSorted(item.extra_crews || []) };
  });
  const safeSwaps = swaps.swaps.map(function (swap) {
    return { id: swap.id, from_uid: swap.from_uid, to_uid: swap.to_uid,
      from_crew: swap.from_crew, to_crew: swap.to_crew,
      from_date: swap.from_date, to_date: swap.to_date,
      conflicts: swap.conflicts };
  }).sort(function (a, b) { return a.id.localeCompare(b.id); });
  const safeSites = normalizeDocs(input.subStations).map(function (site) {
    return { id: docId(site), fixed_hours: Number(site.fixed_hours || 0),
      available: subStationAvailable(site) };
  }).sort(function (a, b) { return a.id.localeCompare(b.id); });
  const safeShifts = {};
  CREWS.forEach(function (crew) {
    const shift = input.shifts && input.shifts[crew];
    safeShifts[crew] = plainObject(shift && shift.assign)
      ? canonicalize(shift.assign) : null;
  });
  return {
    schema_version: SCHEMA_VERSION,
    station_id: String(input.stationId || ''), date: String(input.date || ''),
    people: safePeople,
    rotation: rotationModel,
    overrides: safeOverrides,
    swaps: safeSwaps,
    board_slots: cleanSlots.sort(function (a, b) { return a.id.localeCompare(b.id); }),
    shifts: safeShifts,
    sites: safeSites,
    default_sub_station: String((input.config && input.config.default_sub_station) || '')
  };
}

function buildShadowEntries(input) {
  const data = input || {};
  const date = String(data.date || '');
  const rotationModel = validateRotations(data.rotations);
  const overrides = normalizeOverrides(data.overrides);
  const people = personMap(data.users, data.roster);
  const swaps = validateApprovedSwaps(data.swaps, people, rotationModel, overrides);
  const crewState = crewStateOnDate(rotationModel, overrides, date);
  const boardModel = boardIndex(data.board);
  const sites = siteMap(data.subStations);
  const entries = [];

  Object.keys(people).sort().forEach(function (uid) {
    const person = people[uid];
    const conflicts = person.conflicts.slice().concat(crewState.conflicts);
    const warnings = person.warnings.slice().concat(crewState.warnings);
    const swap = swapDecision(swaps, uid, date);
    conflicts.push.apply(conflicts, swap.conflicts);

    let plannedWork = crewState.crews.indexOf(person.crew) !== -1;
    let effectiveCrew = person.crew;
    let coveredUid = '';
    let swapId = '';
    let sourceKind = crewState.sourceKind || 'rotation';
    if (swap.effect) {
      swapId = swap.effect.swap.id;
      sourceKind = 'swap';
      if (swap.effect.kind === 'out') plannedWork = false;
      else {
        plannedWork = true;
        effectiveCrew = swap.effect.effectiveCrew;
        coveredUid = swap.effect.coveredUid;
      }
    }

    let station = { subStation: '', fixedHours: 0, stationSource: '', slotIds: [],
      conflicts: [], warnings: [] };
    let times = { start: '', end: '', endDay: 0, minutes: 0, hours: 0,
      rule: '', conflicts: [], warnings: [] };
    if (plannedWork && !conflicts.length) {
      station = resolveStation({
        targetUid: coveredUid || uid,
        coveredUid: coveredUid,
        crew: effectiveCrew,
        shifts: data.shifts || {},
        boardModel: boardModel,
        siteModel: sites,
        defaultSubStation: data.config && data.config.default_sub_station
      });
      conflicts.push.apply(conflicts, station.conflicts);
      warnings.push.apply(warnings, station.warnings);
      if (!conflicts.length) {
        times = resolvePlannedTimes(person.role, station, rotationModel);
        conflicts.push.apply(conflicts, times.conflicts);
        warnings.push.apply(warnings, times.warnings);
      }
    }

    const entry = {
      schema_version: SCHEMA_VERSION,
      station_id: String(data.stationId || ''),
      uid: uid,
      date: date,
      month: validDateKey(date) ? date.slice(0, 7) : '',
      role: person.role,
      home_crew: person.crew,
      state: conflicts.length ? 'conflict' : (plannedWork ? 'ready' : 'off'),
      planned_work: !!plannedWork,
      effective_crew: effectiveCrew,
      source_kind: sourceKind,
      covered_uid: coveredUid,
      swap_id: swapId,
      override_id: crewState.overrideId || '',
      sub_station: station.subStation,
      station_source: station.stationSource,
      slot_ids: station.slotIds,
      planned_start: times.start,
      planned_end: times.end,
      planned_end_day: times.endDay,
      planned_minutes: times.minutes,
      planned_hours: times.hours,
      hours_rule: times.rule,
      rotation_ids: rotationModel.ids,
      conflict_codes: uniqueSorted(conflicts),
      warning_codes: uniqueSorted(warnings)
    };
    entry.input_hash = canonicalHash(entry);
    entries.push(entry);
  });

  const conflictCounts = {};
  entries.forEach(function (entry) {
    entry.conflict_codes.forEach(function (code) {
      conflictCounts[code] = (conflictCounts[code] || 0) + 1;
    });
  });
  const source = sanitizedSource(data, people, rotationModel, overrides, swaps);
  return {
    schema_version: SCHEMA_VERSION,
    station_id: String(data.stationId || ''),
    date: date,
    month: validDateKey(date) ? date.slice(0, 7) : '',
    time_zone: TIME_ZONE,
    entries: entries,
    source_digest: canonicalHash(source),
    rows_digest: canonicalHash(entries.map(function (entry) {
      return { uid: entry.uid, hash: entry.input_hash };
    })),
    result_counts: {
      ready_working: entries.filter(function (entry) { return entry.state === 'ready'; }).length,
      ready_off: entries.filter(function (entry) { return entry.state === 'off'; }).length,
      conflict: entries.filter(function (entry) { return entry.state === 'conflict'; }).length,
      warning: entries.filter(function (entry) { return entry.warning_codes.length > 0; }).length
    },
    conflict_counts: conflictCounts
  };
}

function sourceOf(record) {
  const source = String(record && record.source || '');
  if (!source) return record && record.imported_from ? 'import' : 'legacy';
  return ['legacy', 'import', 'manual', 'automatic', 'system'].indexOf(source) !== -1
    ? source : 'unknown';
}

function actualStatusOf(record) {
  const status = String(record && record.status || '');
  return ['draft', 'submitted', 'approved', 'rejected', ''].indexOf(status) !== -1
    ? status : 'unknown';
}

function safeActualStation(record) {
  const station = String(record && record.sub_station || '');
  return !station || /^[A-Za-z0-9_-]{1,160}$/.test(station) ? station : '';
}

function actualHash(record) {
  const rec = record || {};
  return canonicalHash({
    uid: String(rec.uid || ''), date: String(rec.date || ''),
    crew: String(rec.crew || ''), day_type: String(rec.day_type || ''),
    start: String(rec.start || ''), end: String(rec.end || ''),
    end_day: Number(rec.end_day || 0), hours: Number(rec.hours),
    sub_station: String(rec.sub_station || ''), status: String(rec.status || ''),
    source: sourceOf(rec)
  });
}

function compareTimes(entry, actual, mismatches) {
  const start = String(actual.start || '');
  const end = String(actual.end || '');
  const endDay = actual.end_day === undefined || actual.end_day === null
    ? (validClock(start) && validClock(end) && clockMinutes(end) <= clockMinutes(start) ? 1 : 0)
    : Number(actual.end_day);
  if (start !== entry.planned_start || end !== entry.planned_end ||
      endDay !== entry.planned_end_day) mismatches.push('time_mismatch');
}

function compareShadowEntries(options) {
  const opts = options || {};
  const entries = Array.isArray(opts.entries) ? opts.entries : [];
  const attendance = normalizeDocs(opts.attendance);
  const asOfDate = validDateKey(opts.asOfDate) ? String(opts.asOfDate) : '';
  const users = normalizeDocs(opts.users);
  const usersByUid = {};
  users.forEach(function (user) {
    usersByUid[docId(user)] = user;
  });
  const attendanceByUidDate = {};
  attendance.forEach(function (record) {
    const key = String(record.uid || '') + '|' + String(record.date || '');
    (attendanceByUidDate[key] = attendanceByUidDate[key] || []).push(record);
  });
  const guardKeys = new Set();
  normalizeDocs(opts.guards).forEach(function (guard) {
    const date = String(guard.date || '');
    if (guard.status === 'cancelled' || !validDateKey(date) ||
        !Array.isArray(guard.assigned)) return;
    guard.assigned.map(String).forEach(function (uid) {
      if (uid) guardKeys.add(uid + '|' + date);
    });
  });
  const leaveRangesByUid = {};
  normalizeDocs(opts.submissions).forEach(function (submission) {
    const values = submission.values || {};
    const uid = String(submission.by_uid || '');
    const from = String(values.from || ''), to = String(values.to || '');
    if (submission.form_id !== 'leave' || submission.status !== 'approved' ||
        !uid || !validDateKey(from) || !validDateKey(to) || from > to) return;
    (leaveRangesByUid[uid] = leaveRangesByUid[uid] || []).push({ from: from, to: to });
  });
  function hasVerifiedGuard(uid, date) {
    return guardKeys.has(uid + '|' + date);
  }
  function hasVerifiedLeave(uid, date) {
    return (leaveRangesByUid[uid] || []).some(function (range) {
      return date >= range.from && date <= range.to;
    });
  }

  const rows = entries.map(function (entry) {
    const mismatches = [], warnings = [];
    const user = usersByUid[entry.uid] || null;
    if (!user) mismatches.push('comparison_user_missing');
    const emp = user ? String(user.employee_number || user.emp_number || '').trim() : '';
    if (user && !emp) mismatches.push('comparison_emp_missing');

    const candidates = attendanceByUidDate[entry.uid + '|' + entry.date] || [];
    if (candidates.length > 1) mismatches.push('duplicate_actual');
    const actual = candidates.length === 1 ? candidates[0] : null;
    if (actual && actual.uid && String(actual.uid) !== entry.uid) {
      mismatches.push('actual_uid_mismatch');
    }
    if (actual && emp && String(actual.emp_number || actual.employee_number || '') !== emp) {
      mismatches.push('actual_emp_mismatch');
    }
    if (entry.state === 'conflict') mismatches.push('snapshot_conflict');

    let state = 'uncomparable';
    let actualState = actual ? 'present' : 'missing';
    if (candidates.length > 1) actualState = 'duplicate';
    if (mismatches.some(function (code) {
      return ['comparison_user_missing', 'comparison_emp_missing', 'duplicate_actual',
        'actual_uid_mismatch', 'actual_emp_mismatch', 'snapshot_conflict'].indexOf(code) !== -1;
    })) {
      state = 'uncomparable';
    } else if (!entry.planned_work && !actual) {
      state = 'match';
    } else if (entry.planned_work && !actual) {
      if (asOfDate && entry.date >= asOfDate) {
        mismatches.push('pending');
        state = 'pending';
      } else {
        mismatches.push('missing_attendance');
        state = 'mismatch';
      }
    } else if (!entry.planned_work && actual) {
      const type = String(actual.day_type || '');
      const explainedGuard = type === 'guard' && hasVerifiedGuard(entry.uid, entry.date);
      const explainedLeave = type === 'vacation' &&
        hasVerifiedLeave(entry.uid, entry.date);
      const reasoned = ['extra', 'meeting', 'swap'].indexOf(type) !== -1 &&
        !!String(actual.overtime_reason || '').trim();
      if (explainedGuard || explainedLeave || type === 'sick' || type === 'reserve' || reasoned) {
        state = 'explained';
        if (type === 'sick' || type === 'reserve') warnings.push('exception_requires_review');
      } else {
        mismatches.push('unexpected_attendance');
        state = 'mismatch';
      }
    } else if (entry.planned_work && actual) {
      const type = String(actual.day_type || 'regular');
      if (EXCEPTION_TYPES.indexOf(type) !== -1 && type !== 'swap') {
        const leaveOk = type !== 'vacation' ||
          hasVerifiedLeave(entry.uid, entry.date);
        const guardOk = type !== 'guard' ||
          hasVerifiedGuard(entry.uid, entry.date);
        if (leaveOk && guardOk) state = 'explained';
        else {
          mismatches.push('unverified_exception');
          state = 'mismatch';
        }
      } else {
        if (String(actual.crew || '') !== entry.home_crew) mismatches.push('crew_mismatch');
        const actualHours = Number(actual.hours);
        if (!Number.isFinite(actualHours) ||
            Math.abs(actualHours - Number(entry.planned_hours)) > 0.01) {
          mismatches.push('hours_mismatch');
        }
        const actualSite = String(actual.sub_station || '');
        if (!actualSite && entry.sub_station) mismatches.push('missing_actual_station');
        else if (actualSite !== String(entry.sub_station || '')) mismatches.push('station_mismatch');
        compareTimes(entry, actual, mismatches);
        state = mismatches.length ? 'mismatch' : 'match';
      }
    }
    if (actual && sourceOf(actual) === 'legacy') warnings.push('legacy_source');
    if (actual && sourceOf(actual) === 'unknown') warnings.push('unknown_actual_source');
    if (actual && actualStatusOf(actual) === 'unknown') warnings.push('unknown_actual_status');
    if (actual && String(actual.sub_station || '') && !safeActualStation(actual)) {
      warnings.push('invalid_actual_station_id');
    }
    if (actual && String(actual.start || '') && !validClock(actual.start)) {
      warnings.push('invalid_actual_start');
    }
    if (actual && String(actual.end || '') && !validClock(actual.end)) {
      warnings.push('invalid_actual_end');
    }
    const normalizedEndDay = actual && Number.isFinite(Number(actual.end_day)) &&
      Number(actual.end_day) >= 0 && Number(actual.end_day) <= 7
      ? Number(actual.end_day) : 0;
    if (actual && actual.end_day !== undefined && actual.end_day !== null &&
        normalizedEndDay !== Number(actual.end_day)) warnings.push('invalid_actual_end_day');
    const normalizedHours = actual && Number.isFinite(Number(actual.hours)) &&
      Number(actual.hours) >= 0 && Number(actual.hours) <= 168
      ? Number(actual.hours) : null;
    if (actual && normalizedHours === null) warnings.push('invalid_actual_hours');

    const row = {
      schema_version: SCHEMA_VERSION,
      uid: entry.uid,
      date: entry.date,
      planned_state: entry.state,
      planned_work: entry.planned_work,
      planned_hours: entry.planned_hours,
      planned_station: entry.sub_station,
      planned_start: entry.planned_start,
      planned_end: entry.planned_end,
      planned_end_day: entry.planned_end_day,
      actual_state: actualState,
      actual_status: actual ? actualStatusOf(actual) : '',
      actual_source: actual ? sourceOf(actual) : '',
      actual_hours: normalizedHours,
      actual_station: actual ? safeActualStation(actual) : '',
      actual_start: actual && validClock(actual.start) ? String(actual.start) : '',
      actual_end: actual && validClock(actual.end) ? String(actual.end) : '',
      actual_end_day: actual ? normalizedEndDay : 0,
      state: state,
      mismatch_codes: uniqueSorted(mismatches),
      warning_codes: uniqueSorted(warnings),
      hour_delta: normalizedHours !== null
        ? Math.round((normalizedHours - Number(entry.planned_hours)) * 100) / 100 : null,
      snapshot_hash: String(entry.input_hash || canonicalHash(entry)),
      actual_hash: actual ? actualHash(actual) : ''
    };
    return row;
  });

  const entryUids = new Set(entries.map(function (entry) { return String(entry.uid || ''); }));
  const globalConflictCounts = {};
  attendance.forEach(function (record) {
    const uid = String(record.uid || '');
    let code = '';
    if (!uid) code = 'attendance_missing_uid';
    else if (!entryUids.has(uid)) code = 'attendance_uid_not_in_snapshot';
    if (code) globalConflictCounts[code] = (globalConflictCounts[code] || 0) + 1;
  });
  const globalConflicts = Object.keys(globalConflictCounts).sort().map(function (code) {
    return { code: code, count: globalConflictCounts[code] };
  });
  const summary = summarizeComparisons(rows);
  summary.identity_conflict += globalConflicts.reduce(function (sum, item) {
    return sum + item.count;
  }, 0);
  return { schema_version: SCHEMA_VERSION, as_of_date: asOfDate,
    rows: rows, comparisons: rows, summary: summary,
    global_conflicts: globalConflicts,
    rows_digest: canonicalHash(rows.map(function (row) {
      return { uid: row.uid, date: row.date,
        snapshot_hash: row.snapshot_hash, actual_hash: row.actual_hash,
        state: row.state, mismatch_codes: row.mismatch_codes };
    })) };
}

function summarizeComparisons(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const totals = {
    snapshot_rows: list.length,
    planned_work_rows: 0,
    planned_off_rows: 0,
    source_conflicts: 0,
    actual_rows: 0,
    exact_matches: 0,
    explained_exceptions: 0,
    missing_attendance: 0,
    unexpected_attendance: 0,
    hours_mismatch: 0,
    station_mismatch: 0,
    identity_conflict: 0,
    duplicate_actual: 0,
    pending: 0
  };
  list.forEach(function (row) {
    if (row.planned_work) totals.planned_work_rows++;
    else totals.planned_off_rows++;
    if (row.planned_state === 'conflict') totals.source_conflicts++;
    if (row.actual_state === 'present') totals.actual_rows++;
    if (row.state === 'match' && row.planned_work) totals.exact_matches++;
    if (row.state === 'explained') totals.explained_exceptions++;
    if (row.mismatch_codes.indexOf('missing_attendance') !== -1) totals.missing_attendance++;
    if (row.mismatch_codes.indexOf('unexpected_attendance') !== -1) totals.unexpected_attendance++;
    if (row.mismatch_codes.indexOf('hours_mismatch') !== -1) totals.hours_mismatch++;
    if (row.mismatch_codes.some(function (code) {
      return code === 'station_mismatch' || code === 'missing_actual_station';
    })) totals.station_mismatch++;
    if (row.mismatch_codes.some(function (code) {
      return code.indexOf('uid_mismatch') !== -1 || code.indexOf('emp_') !== -1 ||
        code === 'comparison_user_missing';
    })) totals.identity_conflict++;
    if (row.mismatch_codes.indexOf('duplicate_actual') !== -1) totals.duplicate_actual++;
    if (row.state === 'pending') totals.pending++;
  });
  return totals;
}

function privacyViolations(value, path) {
  const where = path || '$';
  const out = [];
  if (Array.isArray(value)) {
    value.forEach(function (item, index) {
      out.push.apply(out, privacyViolations(item, where + '[' + index + ']'));
    });
    return out;
  }
  if (!plainObject(value)) return out;
  Object.keys(value).forEach(function (key) {
    if (FORBIDDEN_SHADOW_KEYS.indexOf(key.toLowerCase()) !== -1) {
      out.push(where + '.' + key);
    }
    out.push.apply(out, privacyViolations(value[key], where + '.' + key));
  });
  return out;
}

function privacySafe(value) {
  return privacyViolations(value).length === 0;
}

module.exports = {
  SCHEMA_VERSION: SCHEMA_VERSION,
  TIME_ZONE: TIME_ZONE,
  CREWS: CREWS,
  ROLES: ROLES,
  FORBIDDEN_SHADOW_KEYS: FORBIDDEN_SHADOW_KEYS,
  canonicalize: canonicalize,
  canonicalStringify: canonicalStringify,
  canonicalHash: canonicalHash,
  validDateKey: validDateKey,
  dateOrdinal: dateOrdinal,
  addDays: addDays,
  localDateKey: localDateKey,
  validClock: validClock,
  clockMinutes: clockMinutes,
  endFrom: endFrom,
  validateRotations: validateRotations,
  normalizeOverrides: normalizeOverrides,
  crewStateOnDate: crewStateOnDate,
  personMap: personMap,
  validateApprovedSwaps: validateApprovedSwaps,
  swapDecision: swapDecision,
  resolveStation: resolveStation,
  resolvePlannedTimes: resolvePlannedTimes,
  buildDailySnapshot: buildShadowEntries,
  buildShadowEntries: buildShadowEntries,
  compareShadowEntries: compareShadowEntries,
  summarizeComparisons: summarizeComparisons,
  privacyViolations: privacyViolations,
  privacySafe: privacySafe
};
