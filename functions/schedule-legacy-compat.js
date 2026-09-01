'use strict';

// Pure, allow-listed projection for the two legacy collections that still
// feed operational screens while the monthly engine is off or in shadow.
// Firestore paths, authentication and limits stay in schedule-runtime.js;
// this module has no I/O and can never return an unknown document field.

const LEGACY_MODES = Object.freeze(['off', 'shadow']);
const MAX_ROTATIONS = 20;
const MAX_OVERRIDES = 500;
const ROTATION_FIELDS = Object.freeze([
  'crew', 'position_in_cycle', 'cycle_days', 'anchor_date', 'is_active',
  'shift_start', 'shift_end', 'shift_hours', 'commander_start',
  'commander_shift_hours', 'special_end', 'special_shift_hours'
]);
const OVERRIDE_FIELDS = Object.freeze(['date', 'kind', 'crew', 'extra_crews']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CREWS = Object.freeze(['A', 'B', 'C']);
const OVERRIDE_KINDS = Object.freeze(['swap', 'holiday', 'training', 'standby']);
const ROTATION_CLOCK_FIELDS = Object.freeze([
  'shift_start', 'shift_end', 'commander_start', 'special_end'
]);
const ROTATION_HOUR_FIELDS = Object.freeze([
  'shift_hours', 'commander_shift_hours', 'special_shift_hours'
]);
const ROTATION_TIMING_DEFAULTS = Object.freeze({
  shift_start: '07:00', shift_end: '07:00', shift_hours: 24,
  commander_start: '', commander_shift_hours: 24.25,
  special_end: '08:00', special_shift_hours: 25
});

class LegacyScheduleCompatibilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LegacyScheduleCompatibilityError';
    this.code = code;
  }
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function realDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function safeScalar(value, field) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new LegacyScheduleCompatibilityError('legacy-field-invalid',
    'Legacy schedule field is not a safe scalar: ' + field);
}

function fail(code, message) {
  throw new LegacyScheduleCompatibilityError(code, message);
}

function strictNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return NaN;
}

function validHours(value) {
  const hours = strictNumber(value);
  const minutes = hours * 60;
  return Number.isFinite(hours) && hours > 0 && hours <= 48 && Number.isInteger(minutes);
}

function envelope(entry, kind) {
  if (!plain(entry) || typeof entry.id !== 'string' || !plain(entry.value)) {
    throw new LegacyScheduleCompatibilityError('legacy-document-invalid',
      'Legacy ' + kind + ' document is malformed.');
  }
  return entry;
}

function projectRotation(entry, timing) {
  const value = envelope(entry, 'rotation').value;
  const out = {};
  for (const field of ROTATION_FIELDS) {
    if (own(timing, field)) out[field] = timing[field];
    else if (field === 'cycle_days' || field === 'position_in_cycle') out[field] = strictNumber(value[field]);
    else if (own(value, field)) out[field] = safeScalar(value[field], field);
  }
  return Object.freeze(out);
}

function validateConsistentRotationFields(active, fields, validate, normalize, code) {
  const consensus = {};
  for (const field of fields) {
    const explicit = active.filter((row) => own(row.value, field)
      && row.value[field] != null && row.value[field] !== '');
    for (const row of explicit) {
      if (!validate(row.value[field])) fail(code, 'Invalid legacy rotation field: ' + field);
    }
    const values = new Set(explicit.map((row) => normalize(row.value[field])));
    if (values.size > 1) {
      fail('legacy-rotation-field-consistency',
        'Legacy active rotations disagree about field value: ' + field);
    }
    consensus[field] = values.size === 1
      ? explicit.map((row) => normalize(row.value[field]))[0]
      : ROTATION_TIMING_DEFAULTS[field];
  }
  return consensus;
}

function projectRotations(entries) {
  const rows = entries.map((entry) => {
    const doc = envelope(entry, 'rotation');
    if (own(doc.value, 'is_active') && typeof doc.value.is_active !== 'boolean') {
      fail('legacy-rotation-active-flag', 'Legacy rotation active flag must be boolean.');
    }
    return doc;
  });
  const active = rows.filter((row) => row.value.is_active !== false);
  if (active.length !== CREWS.length) {
    fail('legacy-rotation-active-cycle', 'Legacy rotation must contain active A, B and C crews.');
  }

  const crews = new Set();
  const positions = new Set();
  let anchor = null;
  let cycle = null;
  for (const row of active) {
    const value = row.value;
    if (typeof value.crew !== 'string' || CREWS.indexOf(value.crew) === -1
        || crews.has(value.crew)) {
      fail('legacy-rotation-crew', 'Legacy rotation crews must be exactly A, B and C.');
    }
    crews.add(value.crew);
    if (!realDate(value.anchor_date)) {
      fail('legacy-rotation-anchor', 'Legacy rotation anchor must be a canonical date.');
    }
    if (anchor === null) anchor = value.anchor_date;
    else if (anchor !== value.anchor_date) {
      fail('legacy-rotation-anchor', 'Legacy rotation anchors must match.');
    }
    const rowCycle = strictNumber(value.cycle_days);
    if (!Number.isSafeInteger(rowCycle) || rowCycle <= 0) {
      fail('legacy-rotation-cycle', 'Legacy rotation cycle must be a positive integer.');
    }
    if (cycle === null) cycle = rowCycle;
    else if (cycle !== rowCycle) {
      fail('legacy-rotation-cycle', 'Legacy rotation cycle lengths must match.');
    }
    const position = strictNumber(value.position_in_cycle);
    if (!Number.isSafeInteger(position) || position < 0 || positions.has(position)) {
      fail('legacy-rotation-position', 'Legacy rotation positions must be unique non-negative integers.');
    }
    positions.add(position);
  }
  if (cycle !== CREWS.length) {
    fail('legacy-rotation-cycle', 'Legacy rotation cycle must match the complete A, B and C cycle.');
  }
  if (CREWS.some((unused, position) => !positions.has(position))) {
    fail('legacy-rotation-position', 'Legacy rotation positions must completely cover 0, 1 and 2.');
  }

  const timing = Object.assign({}, validateConsistentRotationFields(active, ROTATION_CLOCK_FIELDS,
    (value) => typeof value === 'string' && CLOCK_RE.test(value), String,
    'legacy-rotation-time'), validateConsistentRotationFields(active, ROTATION_HOUR_FIELDS,
    validHours, strictNumber, 'legacy-rotation-hours'));

  return active.slice().sort((left, right) =>
    strictNumber(left.value.position_in_cycle) - strictNumber(right.value.position_in_cycle))
    .map((row) => projectRotation(row, timing));
}

function projectOverride(entry) {
  const doc = envelope(entry, 'override');
  if (!realDate(doc.id)) {
    throw new LegacyScheduleCompatibilityError('legacy-override-date-invalid',
      'Legacy override document id is not a canonical date.');
  }
  const value = doc.value;
  if (own(value, 'date') && value.date !== undefined && value.date !== null
      && value.date !== '' && value.date !== doc.id) {
    throw new LegacyScheduleCompatibilityError('legacy-override-date-mismatch',
      'Legacy override date conflicts with its document id.');
  }
  // Keep the browser contract total and deterministic. Historic records often
  // omit `crew` or `extra_crews` when a kind does not use them; returning
  // defaults here prevents four clients from interpreting an absent field in
  // four different ways, without copying any raw document data.
  const out = { date: doc.id, kind: '', crew: '', extra_crews: Object.freeze([]) };
  for (const field of OVERRIDE_FIELDS) {
    if (field === 'date' || !own(value, field) || value[field] === null) continue;
    if (field === 'extra_crews') {
      if (!Array.isArray(value.extra_crews)
          || value.extra_crews.some((crew) => typeof crew !== 'string')) {
        throw new LegacyScheduleCompatibilityError('legacy-field-invalid',
          'Legacy schedule field is not a safe string array: extra_crews');
      }
      out.extra_crews = Object.freeze(value.extra_crews.slice());
    } else if (typeof value[field] === 'string') {
      out[field] = value[field];
    } else {
      throw new LegacyScheduleCompatibilityError('legacy-field-invalid',
        'Legacy schedule field is not a safe string: ' + field);
    }
  }
  if (OVERRIDE_KINDS.indexOf(out.kind) === -1) {
    fail('legacy-override-kind', 'Legacy override kind is not supported.');
  }
  if (out.kind === 'swap') {
    if (CREWS.indexOf(out.crew) === -1) {
      fail('legacy-override-crew', 'A swap override must select one known crew.');
    }
    if (out.extra_crews.length !== 0) {
      fail('legacy-override-assignment', 'A swap override cannot contain extra crews.');
    }
  } else if (out.kind === 'standby') {
    if (out.crew !== '') {
      fail('legacy-override-assignment', 'A standby override cannot replace the base crew.');
    }
    if (out.extra_crews.length === 0
        || out.extra_crews.some((crew) => CREWS.indexOf(crew) === -1)
        || new Set(out.extra_crews).size !== out.extra_crews.length) {
      fail('legacy-override-extra-crews',
        'A standby override requires unique known extra crews.');
    }
  } else if (out.crew !== '' || out.extra_crews.length !== 0) {
    fail('legacy-override-assignment',
      'Holiday and training overrides cannot change crew assignments.');
  }
  return Object.freeze(out);
}

function projectLegacyScheduleCompatibility(input) {
  if (!plain(input) || LEGACY_MODES.indexOf(input.mode) === -1
      || !Array.isArray(input.rotations) || !Array.isArray(input.overrides)) {
    throw new LegacyScheduleCompatibilityError('legacy-compatibility-input',
      'Legacy compatibility input is incomplete.');
  }
  if (input.rotations.length > MAX_ROTATIONS) {
    throw new LegacyScheduleCompatibilityError('legacy-rotations-too-large',
      'Legacy rotations exceed the compatibility cap.');
  }
  if (input.overrides.length > MAX_OVERRIDES) {
    throw new LegacyScheduleCompatibilityError('legacy-overrides-too-large',
      'Legacy overrides exceed the compatibility cap.');
  }

  const rotations = projectRotations(input.rotations);

  const overrides = {};
  input.overrides.slice().sort((left, right) => {
    const a = String(left && left.id || '');
    const b = String(right && right.id || '');
    return a < b ? -1 : (a > b ? 1 : 0);
  }).forEach((entry) => {
    const projected = projectOverride(entry);
    if (own(overrides, projected.date)) {
      throw new LegacyScheduleCompatibilityError('legacy-override-duplicate',
        'Legacy override date appears more than once.');
    }
    overrides[projected.date] = projected;
  });

  return Object.freeze({
    mode: input.mode,
    rotations: Object.freeze(rotations),
    overrides: Object.freeze(overrides)
  });
}

module.exports = Object.freeze({
  projectLegacyScheduleCompatibility,
  LegacyScheduleCompatibilityError,
  ROTATION_FIELDS,
  OVERRIDE_FIELDS,
  CREWS,
  OVERRIDE_KINDS,
  MAX_ROTATIONS,
  MAX_OVERRIDES
});
