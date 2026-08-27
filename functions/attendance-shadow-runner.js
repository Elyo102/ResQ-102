'use strict';

// Firestore orchestration for v41A attendance Shadow.
//
// This module owns I/O, leases, retention and reports. The calculation itself
// lives in attendance-shadow.js and is deliberately pure. Most importantly,
// no path in this file can write to attendance or monthly_reports.

const crypto = require('node:crypto');
const engineDefault = require('./attendance-shadow');

const CONFIG_PATH = 'config/attendance_shadow_v41';
const GENERATOR_VERSION = 'v41a-1';
const RAW_RETENTION_DAYS = 90;
const REPORT_RETENTION_MONTHS = 13;
const BATCH_SIZE = 200;
const MAX_STATIONS = 50;
const MAX_USERS_PER_STATION = 5000;
const MAX_ATTENDANCE_PER_MONTH = 50000;
const MAX_EXPLANATIONS_PER_MONTH = 5000;
const MAX_ROSTER_PER_STATION = 5000;
const MAX_ROTATIONS_PER_STATION = 20;
const MAX_SUB_STATIONS_PER_STATION = 500;
const MAX_SWAP_DEPENDENCY_DATES = 64;
const MAX_SWAPS_PER_DATE_QUERY = 250;
const MAX_SWAPS_PER_CAPTURE = 1000;
const LEASE_MILLIS = 20 * 60 * 1000;

class AttendanceShadowError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'AttendanceShadowError';
    this.code = code;
  }
}

function safeStationId(value) {
  const sid = String(value || '');
  if (!/^[a-z0-9_-]{2,80}$/.test(sid)) {
    throw new AttendanceShadowError('invalid-station', 'Invalid station identifier.');
  }
  return sid;
}

function validMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''));
}

function daysInMonth(month) {
  if (!validMonth(month)) return 0;
  const parts = month.split('-').map(Number);
  return new Date(Date.UTC(parts[0], parts[1], 0)).getUTCDate();
}

function monthEnd(month) {
  return month + '-' + String(daysInMonth(month)).padStart(2, '0');
}

function dayKeysThrough(month, through) {
  if (!validMonth(month)) return [];
  const end = monthEnd(month);
  const last = through < month + '-01' ? '' : (through > end ? end : through);
  if (!last || !last.startsWith(month + '-')) return [];
  const out = [];
  for (let day = 1; day <= Number(last.slice(8, 10)); day++) {
    out.push(month + '-' + String(day).padStart(2, '0'));
  }
  return out;
}

function runIdFor(date) {
  return 'pre_shift__' + date + '__' + GENERATOR_VERSION.replace(/[^a-z0-9_-]/gi, '_');
}

function invocationId() {
  return crypto.randomBytes(12).toString('hex');
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  return new Date(value).getTime() || 0;
}

function docValues(snapshot) {
  if (!snapshot || !snapshot.exists) return null;
  // Firestore path identity is authoritative. A user-controlled `id` field in
  // the document must never replace the canonical document identifier.
  return Object.assign({}, snapshot.data() || {}, { id: snapshot.id });
}

function snapshotValues(snapshot) {
  return (snapshot && snapshot.docs || []).map(docValues);
}

function pick(object, keys) {
  const out = {};
  keys.forEach(function (key) {
    if (object[key] !== undefined) out[key] = object[key];
  });
  return out;
}

function safeOpaqueId(value, allowEmpty) {
  const id = String(value || '');
  if (!id && allowEmpty) return '';
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) {
    throw new AttendanceShadowError('privacy-violation',
      'A Shadow source identifier is not an opaque safe identifier.');
  }
  return id;
}

function safeUid(value, allowEmpty) {
  const uid = String(value || '');
  if (!uid && allowEmpty) return '';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
    throw new AttendanceShadowError('privacy-violation',
      'A Shadow UID is not a safe opaque identifier.');
  }
  return uid;
}

function strictEnum(value, allowed, field) {
  const text = String(value || '');
  if (allowed.indexOf(text) === -1) {
    throw new AttendanceShadowError('invalid-shadow-entry',
      'Invalid Shadow enum: ' + field + '.');
  }
  return text;
}

function safeCodes(value) {
  const list = Array.isArray(value) ? value.map(String) : [];
  if (list.length > 100 || new Set(list).size !== list.length ||
      list.some(function (code) { return !/^[a-z0-9_-]{1,80}$/.test(code); })) {
    throw new AttendanceShadowError('invalid-shadow-entry',
      'A Shadow code list failed validation.');
  }
  return list;
}

function safeErrorCode(value) {
  const code = String(value || 'internal').toLowerCase();
  return /^[a-z0-9_-]{1,80}$/.test(code) ? code : 'internal';
}

function strictHash(value, field, optional) {
  const hash = String(value || '');
  if (optional && !hash) return '';
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new AttendanceShadowError('invalid-shadow-entry',
      'Invalid Shadow hash: ' + field + '.');
  }
  return hash;
}

function strictNumber(value, minimum, maximum, field, optional) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new AttendanceShadowError('invalid-shadow-entry',
      'Invalid Shadow number: ' + field + '.');
  }
  return number;
}

function strictClock(value, field, optional) {
  const text = String(value || '');
  if (optional && !text) return '';
  if (!engineDefault.validClock(text)) {
    throw new AttendanceShadowError('invalid-shadow-entry',
      'Invalid Shadow clock: ' + field + '.');
  }
  return text;
}

function assertJsonSize(value, maximum, code) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximum) {
    throw new AttendanceShadowError(code, 'A Shadow document exceeds its byte limit.');
  }
}

function rawEntry(entry, runId, capturedAt, expiresAt) {
  const row = entry || {};
  const value = {
    schema_version: 1,
    station_id: safeStationId(row.station_id),
    uid: safeUid(row.uid),
    date: String(row.date || ''),
    month: String(row.month || ''),
    role: strictEnum(row.role, engineDefault.ROLES.concat(['unknown']), 'role'),
    home_crew: strictEnum(row.home_crew, engineDefault.CREWS.concat(['']), 'home_crew'),
    state: strictEnum(row.state, ['ready', 'off', 'conflict'], 'state'),
    planned_work: row.planned_work === true,
    effective_crew: strictEnum(row.effective_crew,
      engineDefault.CREWS.concat(['']), 'effective_crew'),
    source_kind: strictEnum(row.source_kind,
      ['rotation', 'override', 'standby', 'swap'], 'source_kind'),
    covered_uid: safeUid(row.covered_uid, true),
    swap_id: safeOpaqueId(row.swap_id, true),
    override_id: safeOpaqueId(row.override_id, true),
    sub_station: safeOpaqueId(row.sub_station, true),
    station_source: strictEnum(row.station_source,
      ['assigned_slot', 'covered_slot', 'configured_default', ''], 'station_source'),
    slot_ids: (Array.isArray(row.slot_ids) ? row.slot_ids : []).map(function (id) {
      return safeOpaqueId(id, false);
    }),
    planned_start: strictClock(row.planned_start, 'planned_start', true),
    planned_end: strictClock(row.planned_end, 'planned_end', true),
    planned_end_day: strictNumber(row.planned_end_day, 0, 2, 'planned_end_day', false),
    planned_minutes: strictNumber(row.planned_minutes, 0, 2880, 'planned_minutes', false),
    planned_hours: strictNumber(row.planned_hours, 0, 48, 'planned_hours', false),
    hours_rule: strictEnum(row.hours_rule,
      ['regular', 'commander', 'site_fixed', ''], 'hours_rule'),
    rotation_ids: (Array.isArray(row.rotation_ids) ? row.rotation_ids : [])
      .map(function (id) { return safeOpaqueId(id, false); }),
    conflict_codes: safeCodes(row.conflict_codes),
    warning_codes: safeCodes(row.warning_codes),
    input_hash: strictHash(row.input_hash, 'input_hash', false),
    run_id: safeOpaqueId(runId, false),
    captured_at: capturedAt,
    expires_at: expiresAt
  };
  if (!engineDefault.validDateKey(value.date) ||
      value.month !== value.date.slice(0, 7) || !value.input_hash) {
    throw new AttendanceShadowError('invalid-shadow-entry',
      'A raw Shadow entry failed schema validation.');
  }
  if (value.slot_ids.length > 100 || value.rotation_ids.length > 20) {
    throw new AttendanceShadowError('invalid-shadow-entry',
      'A raw Shadow entry contains too many identifiers.');
  }
  if (!engineDefault.privacySafe(value)) {
    throw new AttendanceShadowError('privacy-violation',
      'A raw Shadow entry contains a forbidden identity field.');
  }
  assertJsonSize(value, 16 * 1024, 'shadow-entry-too-large');
  return value;
}

function reportIssue(row) {
  const item = row || {};
  return {
    date: engineDefault.validDateKey(item.date) ? item.date : '',
    state: strictEnum(item.state,
      ['match', 'mismatch', 'explained', 'uncomparable', 'pending'], 'state'),
    planned_state: strictEnum(item.planned_state,
      ['ready', 'off', 'conflict'], 'planned_state'),
    planned_work: item.planned_work === true,
    planned_hours: strictNumber(item.planned_hours, 0, 48, 'planned_hours', false),
    planned_station: safeOpaqueId(item.planned_station, true),
    planned_start: strictClock(item.planned_start, 'planned_start', true),
    planned_end: strictClock(item.planned_end, 'planned_end', true),
    planned_end_day: strictNumber(item.planned_end_day, 0, 2, 'planned_end_day', false),
    actual_state: strictEnum(item.actual_state,
      ['present', 'missing', 'duplicate'], 'actual_state'),
    actual_status: strictEnum(item.actual_status,
      ['draft', 'submitted', 'approved', 'rejected', 'unknown', ''], 'actual_status'),
    actual_source: strictEnum(item.actual_source,
      ['legacy', 'import', 'manual', 'automatic', 'system', 'unknown', ''], 'actual_source'),
    actual_hours: strictNumber(item.actual_hours, 0, 168, 'actual_hours', true),
    actual_station: safeOpaqueId(item.actual_station, true),
    actual_start: strictClock(item.actual_start, 'actual_start', true),
    actual_end: strictClock(item.actual_end, 'actual_end', true),
    actual_end_day: strictNumber(item.actual_end_day, 0, 7, 'actual_end_day', false),
    mismatch_codes: safeCodes(item.mismatch_codes),
    warning_codes: safeCodes(item.warning_codes),
    hour_delta: strictNumber(item.hour_delta, -168, 168, 'hour_delta', true),
    snapshot_hash: strictHash(item.snapshot_hash, 'snapshot_hash', false),
    actual_hash: strictHash(item.actual_hash, 'actual_hash', true)
  };
}

function reportRetentionDate(now) {
  const source = new Date(now);
  const targetMonth = source.getUTCMonth() + REPORT_RETENTION_MONTHS;
  const year = source.getUTCFullYear() + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(source.getUTCDate(), lastDay),
    source.getUTCHours(), source.getUTCMinutes(), source.getUTCSeconds(),
    source.getUTCMilliseconds()));
}

function createAttendanceShadowService(options) {
  const opts = options || {};
  const db = opts.db;
  const admin = opts.admin;
  const engine = opts.engine || engineDefault;
  const now = typeof opts.now === 'function' ? opts.now : function () { return new Date(); };
  if (!db || !admin || !admin.firestore || !admin.firestore.Timestamp) {
    throw new Error('createAttendanceShadowService requires Firebase Admin and Firestore.');
  }
  const Timestamp = admin.firestore.Timestamp;

  function timestamp(date) {
    return Timestamp.fromMillis(new Date(date).getTime());
  }

  function metrics() {
    return { reads: 0, writes: 0, started: Date.now() };
  }

  async function readDoc(path, meter) {
    const snap = await db.doc(path).get();
    if (meter) meter.reads += 1;
    return snap;
  }

  async function readBoundedCollection(path, maximum, errorCode, meter) {
    const snap = await db.collection(path).limit(maximum + 1).get();
    if (meter) meter.reads += snap.size;
    if (snap.size > maximum) {
      throw new AttendanceShadowError(errorCode,
        'A bounded Shadow source exceeded its safety limit.');
    }
    return snapshotValues(snap);
  }

  async function readConfig(meter) {
    const snap = await readDoc(CONFIG_PATH, meter);
    const value = snap.exists ? (snap.data() || {}) : {};
    const stationIds = Array.isArray(value.station_ids)
      ? Array.from(new Set(value.station_ids.map(String))).filter(function (sid) {
        return /^[a-z0-9_-]{2,80}$/.test(sid);
      }).slice(0, MAX_STATIONS) : [];
    return {
      mode: value.mode === 'shadow' ? 'shadow' : 'off',
      station_ids: stationIds,
      default_sub_station: String(value.default_sub_station || '')
    };
  }

  function enabledFor(config, sid) {
    return config.mode === 'shadow' && config.station_ids.indexOf(sid) !== -1;
  }

  async function readScheduleDependencies(sid, date, meter) {
    const pending = [date];
    const dates = new Set();
    const found = {};
    while (pending.length) {
      const key = pending.shift();
      if (!engine.validDateKey(key) || dates.has(key)) continue;
      dates.add(key);
      if (dates.size > MAX_SWAP_DEPENDENCY_DATES) {
        throw new AttendanceShadowError('swap-dependency-limit',
          'Swap dependency graph exceeds the safe date limit.');
      }
      for (const field of ['from_date', 'to_date']) {
        const snap = await db.collection('stations/' + sid + '/swaps')
          .where(field, '==', key).limit(MAX_SWAPS_PER_DATE_QUERY + 1).get();
        meter.reads += snap.size;
        if (snap.size > MAX_SWAPS_PER_DATE_QUERY) {
          throw new AttendanceShadowError('too-many-swaps-on-date',
            'Swap dependency query exceeded its safety limit.');
        }
        snap.docs.forEach(function (item) {
          const value = Object.assign({}, item.data() || {}, { id: item.id });
          // A date equality is bounded and uses Firestore's automatic
          // single-field index. Filtering the approval state in memory avoids
          // introducing two extra composite indexes for this small day slice.
          if (value.status !== 'approved') return;
          found[item.id] = value;
          [String(value.from_date || ''), String(value.to_date || '')]
            .forEach(function (endpoint) {
              if (!engine.validDateKey(endpoint)) return;
              [engine.addDays(endpoint, -1), endpoint, engine.addDays(endpoint, 1)]
                .forEach(function (dependency) {
                  if (!dates.has(dependency)) pending.push(dependency);
                });
            });
        });
      }
      if (Object.keys(found).length > MAX_SWAPS_PER_CAPTURE) {
        throw new AttendanceShadowError('too-many-swap-dependencies',
          'Swap dependency graph exceeds the safe document limit.');
      }
    }
    const overrides = [];
    for (const key of Array.from(dates).sort()) {
      const snap = await readDoc('stations/' + sid + '/shift_overrides/' + key, meter);
      if (snap.exists) {
        overrides.push(Object.assign({}, snap.data() || {}, { id: snap.id, date: key }));
      }
    }
    return {
      dates: Array.from(dates).sort(),
      overrides: overrides,
      swaps: Object.keys(found).sort().map(function (id) { return found[id]; })
    };
  }

  async function loadDaySources(sid, date, config, meter) {
    const base = 'stations/' + sid + '/';
    const values = await Promise.all([
      readBoundedCollection(base + 'users', MAX_USERS_PER_STATION,
        'station-too-large', meter),
      readBoundedCollection(base + 'roster', MAX_ROSTER_PER_STATION,
        'roster-too-large', meter),
      readBoundedCollection(base + 'rotations', MAX_ROTATIONS_PER_STATION,
        'rotations-too-large', meter),
      readDoc(base + 'config/board', meter),
      readBoundedCollection(base + 'sub_stations', MAX_SUB_STATIONS_PER_STATION,
        'sub-stations-too-large', meter),
      readScheduleDependencies(sid, date, meter),
      Promise.all(['A', 'B', 'C'].map(function (crew) {
        return readDoc(base + 'shifts/' + crew, meter);
      }))
    ]);
    const shifts = {};
    ['A', 'B', 'C'].forEach(function (crew, index) {
      shifts[crew] = values[6][index].exists ? (values[6][index].data() || {}) : null;
    });
    return {
      date: date,
      stationId: sid,
      users: values[0],
      roster: values[1],
      rotations: values[2],
      board: values[3].exists ? (values[3].data() || {}) : null,
      subStations: values[4],
      overrides: values[5].overrides,
      swaps: values[5].swaps,
      dependencyDates: values[5].dates,
      shifts: shifts,
      config: { default_sub_station: config.default_sub_station }
    };
  }

  function assertRunOwner(value, acquired) {
    if (!value || value.status !== 'building' || value.lease_owner !== acquired.owner) {
      throw new AttendanceShadowError('run-lost',
        'The Shadow run lease is owned by another invocation.');
    }
  }

  async function ownedRunUpdate(acquired, fields, meter) {
    await db.runTransaction(async function (tx) {
      const snap = await tx.get(acquired.ref);
      meter.reads += 1;
      assertRunOwner(snap.exists ? (snap.data() || {}) : null, acquired);
      const value = Object.assign({}, fields || {});
      if (value.status === undefined || value.status === 'building') {
        value.lease_owner = acquired.owner;
        value.lease_until = timestamp(new Date(now().getTime() + LEASE_MILLIS));
      }
      tx.set(acquired.ref, value, { merge: true });
      meter.writes += 1;
    });
  }

  async function markRunFailure(acquired, code, meter) {
    return db.runTransaction(async function (tx) {
      const snap = await tx.get(acquired.ref);
      meter.reads += 1;
      const value = snap.exists ? (snap.data() || {}) : null;
      if (!value || value.status !== 'building' || value.lease_owner !== acquired.owner) {
        return false;
      }
      tx.set(acquired.ref, {
        status: 'failed', error_code: safeErrorCode(code),
        completed_at: timestamp(now()), lease_until: null, lease_owner: '',
        duration_ms: Math.max(0, Date.now() - meter.started),
        read_count: meter.reads, write_count: meter.writes + 1
      }, { merge: true });
      meter.writes += 1;
      return true;
    });
  }

  async function acquireRun(sid, date, trigger, requestedBy, meter) {
    const runId = runIdFor(date);
    const ref = db.doc('stations/' + sid + '/attendance_shadow_runs/' + runId);
    const owner = invocationId();
    const nowDate = now();
    const nowTs = timestamp(nowDate);
    const leaseTs = timestamp(new Date(nowDate.getTime() + LEASE_MILLIS));
    const expires = timestamp(new Date(nowDate.getTime() + RAW_RETENTION_DAYS * 86400000));
    const requester = requestedBy === 'scheduler'
      ? 'scheduler' : safeUid(requestedBy, true);
    const triggerKind = strictEnum(trigger || 'scheduled',
      ['manual', 'scheduled'], 'trigger');
    const result = await db.runTransaction(async function (tx) {
      const priorSnap = await tx.get(ref);
      meter.reads += 1;
      const prior = priorSnap.exists ? (priorSnap.data() || {}) : {};
      if (prior.status === 'complete') {
        return { duplicate: true, ref: ref, id: runId, prior: prior };
      }
      if (prior.status === 'building' && timestampMillis(prior.lease_until) > nowDate.getTime()) {
        throw new AttendanceShadowError('run-in-progress', 'The daily Shadow run is in progress.');
      }
      const resumable = prior.status === 'building';
      const startedAt = resumable && prior.started_at ? prior.started_at : nowTs;
      const checkpoint = resumable
        ? Math.max(0, Math.floor(Number(prior.checkpoint || 0))) : 0;
      tx.set(ref, {
        schema_version: 1, kind: 'schedule_capture', mode: 'shadow',
        station_id: sid, timezone: engine.TIME_ZONE,
        target_date: date, target_month: date.slice(0, 7), canonical: true,
        trigger: triggerKind, generator_version: GENERATOR_VERSION,
        status: 'building', checkpoint: checkpoint,
        started_at: startedAt, completed_at: null,
        requested_by: requester,
        lease_owner: owner, lease_until: leaseTs,
        expires_at: expires, error_code: '',
        source_digest: resumable ? String(prior.source_digest || '') : '',
        rows_digest: resumable ? String(prior.rows_digest || '') : '',
        entry_count: resumable ? Number(prior.entry_count || 0) : 0,
        result_counts: resumable ? (prior.result_counts || {}) : {},
        conflict_counts: resumable ? (prior.conflict_counts || {}) : {}
      }, { merge: true });
      meter.writes += 1;
      return { duplicate: false, ref: ref, id: runId, owner: owner,
        checkpoint: checkpoint, prior: prior, startedAt: startedAt,
        capturedAt: startedAt, expiresAt: expires,
        resumeSourceDigest: resumable ? String(prior.source_digest || '') : '' };
    });
    return result;
  }

  async function ensureStillEnabled(sid, acquired, meter) {
    const config = await readConfig(meter);
    if (enabledFor(config, sid)) return true;
    await ownedRunUpdate(acquired, { status: 'cancelled', error_code: 'shadow-disabled',
      completed_at: timestamp(now()), lease_until: null, lease_owner: '' }, meter);
    return false;
  }

  async function clearEntries(acquired, meter) {
    const col = acquired.ref.collection('attendance_shadow_entries');
    const snap = await col.limit(MAX_USERS_PER_STATION + 1).get();
    meter.reads += snap.size;
    if (snap.size > MAX_USERS_PER_STATION) {
      throw new AttendanceShadowError('too-many-shadow-entries',
        'A partial run exceeds the safe cleanup limit.');
    }
    for (let offset = 0; offset < snap.docs.length; offset += BATCH_SIZE) {
      const slice = snap.docs.slice(offset, offset + BATCH_SIZE);
      await db.runTransaction(async function (tx) {
        const runSnap = await tx.get(acquired.ref);
        meter.reads += 1;
        assertRunOwner(runSnap.exists ? (runSnap.data() || {}) : null, acquired);
        slice.forEach(function (item) { tx.delete(item.ref); });
        tx.set(acquired.ref, {
          lease_owner: acquired.owner,
          lease_until: timestamp(new Date(now().getTime() + LEASE_MILLIS)),
          updated_at: timestamp(now())
        }, { merge: true });
        meter.writes += slice.length + 1;
      });
    }
  }

  async function writeEntries(acquired, plan, sid, meter) {
    const entries = plan.entries.slice().sort(function (a, b) {
      return String(a.uid).localeCompare(String(b.uid));
    });
    if (acquired.checkpoint > entries.length) {
      throw new AttendanceShadowError('invalid-checkpoint', 'Run checkpoint exceeds row count.');
    }
    for (let offset = acquired.checkpoint; offset < entries.length; offset += BATCH_SIZE) {
      if (!(await ensureStillEnabled(sid, acquired, meter))) {
        return { cancelled: true, entries: offset };
      }
      const slice = entries.slice(offset, offset + BATCH_SIZE);
      const prepared = slice.map(function (entry) {
        const id = entry.date + '__' + entry.uid;
        const ref = acquired.ref.collection('attendance_shadow_entries').doc(id);
        return { ref: ref,
          value: rawEntry(entry, acquired.id, acquired.capturedAt, acquired.expiresAt) };
      });
      const next = offset + slice.length;
      await db.runTransaction(async function (tx) {
        const runSnap = await tx.get(acquired.ref);
        meter.reads += 1;
        assertRunOwner(runSnap.exists ? (runSnap.data() || {}) : null, acquired);
        const existing = prepared.length
          ? await tx.getAll.apply(tx, prepared.map(function (item) { return item.ref; })) : [];
        meter.reads += existing.length;
        existing.forEach(function (snap, index) {
          if (!snap.exists) return;
          const before = snap.data() || {};
          if (before.run_id !== acquired.id ||
              before.input_hash !== prepared[index].value.input_hash) {
            throw new AttendanceShadowError('entry-collision',
              'An immutable Shadow entry conflicts with the current plan.');
          }
        });
        prepared.forEach(function (item) { tx.set(item.ref, item.value); });
        tx.set(acquired.ref, {
          checkpoint: next,
          lease_owner: acquired.owner,
          lease_until: timestamp(new Date(now().getTime() + LEASE_MILLIS)),
          updated_at: timestamp(now())
        }, { merge: true });
        meter.writes += slice.length + 1;
      });
    }
    return { cancelled: false, entries: entries.length };
  }

  async function readMonthExplanations(sid, month, meter) {
    const base = 'stations/' + sid + '/';
    const start = month + '-01';
    const end = monthEnd(month);
    const guardSnap = await db.collection(base + 'guards')
      .where('date', '>=', start).where('date', '<=', end)
      .limit(MAX_EXPLANATIONS_PER_MONTH + 1).get();
    meter.reads += guardSnap.size;
    if (guardSnap.size > MAX_EXPLANATIONS_PER_MONTH) {
      throw new AttendanceShadowError('too-many-guards', 'Guard explanation limit exceeded.');
    }
    const leaveSnap = await db.collection(base + 'submissions')
      .where('form_id', '==', 'leave').where('status', '==', 'approved')
      .where('values.to', '>=', start).limit(MAX_EXPLANATIONS_PER_MONTH + 1).get();
    meter.reads += leaveSnap.size;
    if (leaveSnap.size > MAX_EXPLANATIONS_PER_MONTH) {
      throw new AttendanceShadowError('too-many-leaves', 'Leave explanation limit exceeded.');
    }
    const leaves = snapshotValues(leaveSnap).filter(function (item) {
      return String(item.values && item.values.from || '') <= end;
    });
    return { guards: snapshotValues(guardSnap), submissions: leaves };
  }

  async function loadCompletedEntries(sid, month, through, meter) {
    const entries = [];
    const missingDays = [];
    const runIds = [];
    for (const date of dayKeysThrough(month, through)) {
      const runId = runIdFor(date);
      const ref = db.doc('stations/' + sid + '/attendance_shadow_runs/' + runId);
      const runSnap = await ref.get();
      meter.reads += 1;
      if (!runSnap.exists || (runSnap.data() || {}).status !== 'complete') {
        missingDays.push(date);
        continue;
      }
      const entrySnap = await ref.collection('attendance_shadow_entries')
        .limit(MAX_USERS_PER_STATION + 1).get();
      meter.reads += entrySnap.size;
      if (entrySnap.size > MAX_USERS_PER_STATION) {
        throw new AttendanceShadowError('too-many-shadow-entries',
          'A daily Shadow capture exceeds its safety limit.');
      }
      entries.push.apply(entries, snapshotValues(entrySnap));
      if (entries.length > MAX_ATTENDANCE_PER_MONTH) {
        throw new AttendanceShadowError('too-many-shadow-report-rows',
          'Monthly Shadow evidence exceeds its safety limit.');
      }
      runIds.push(runId);
    }
    return { entries: entries, missingDays: missingDays, runIds: runIds };
  }

  function assertReportOwner(value, acquired) {
    if (!value || value.build_status !== 'building' ||
        value.build_owner !== acquired.owner ||
        value.build_generation_id !== acquired.generationId) {
      throw new AttendanceShadowError('report-lost',
        'The Shadow report lease is owned by another invocation.');
    }
  }

  async function acquireReport(sid, month, meter) {
    const reportRef = db.doc('stations/' + sid + '/attendance_shadow_reports/' + month);
    const owner = invocationId();
    const generationId = month + '__' + Date.now().toString(36) + '__' + owner;
    const generationRef = reportRef.collection('attendance_shadow_generations')
      .doc(generationId);
    const nowDate = now();
    const expiresAt = timestamp(reportRetentionDate(nowDate));
    const leaseUntil = timestamp(new Date(nowDate.getTime() + LEASE_MILLIS));
    const prior = await db.runTransaction(async function (tx) {
      const snap = await tx.get(reportRef);
      meter.reads += 1;
      const before = snap.exists ? (snap.data() || {}) : {};
      if (before.build_status === 'building' &&
          timestampMillis(before.build_lease_until) > nowDate.getTime()) {
        throw new AttendanceShadowError('report-in-progress',
          'The monthly Shadow report is already being built.');
      }
      const hasActive = !!String(before.active_generation_id || '');
      tx.set(reportRef, {
        schema_version: 1, station_id: sid, month: month,
        generator_version: GENERATOR_VERSION,
        status: hasActive ? 'complete' : 'building',
        build_status: 'building', build_owner: owner,
        build_generation_id: generationId, build_started_at: timestamp(nowDate),
        build_lease_until: leaseUntil, last_build_error_code: '',
        expires_at: expiresAt
      }, { merge: true });
      tx.set(generationRef, {
        schema_version: 1, station_id: sid, month: month,
        generation_id: generationId, generator_version: GENERATOR_VERSION,
        status: 'building', owner: owner, started_at: timestamp(nowDate),
        lease_until: leaseUntil, expires_at: expiresAt
      });
      meter.writes += 2;
      return before;
    });
    return { reportRef: reportRef, generationRef: generationRef,
      owner: owner, generationId: generationId, expiresAt: expiresAt, prior: prior };
  }

  async function writeReportPeople(acquired, people, meter) {
    const col = acquired.generationRef.collection('attendance_shadow_people');
    for (let offset = 0; offset < people.length; offset += BATCH_SIZE) {
      const slice = people.slice(offset, offset + BATCH_SIZE);
      await db.runTransaction(async function (tx) {
        const reportSnap = await tx.get(acquired.reportRef);
        meter.reads += 1;
        assertReportOwner(reportSnap.exists ? (reportSnap.data() || {}) : null, acquired);
        slice.forEach(function (person) { tx.set(col.doc(person.uid), person); });
        const leaseUntil = timestamp(new Date(now().getTime() + LEASE_MILLIS));
        tx.set(acquired.reportRef, { build_lease_until: leaseUntil }, { merge: true });
        tx.set(acquired.generationRef, { lease_until: leaseUntil }, { merge: true });
        meter.writes += slice.length + 2;
      });
    }
  }

  async function finalizeReport(acquired, fields, meter) {
    await db.runTransaction(async function (tx) {
      const reportSnap = await tx.get(acquired.reportRef);
      meter.reads += 1;
      assertReportOwner(reportSnap.exists ? (reportSnap.data() || {}) : null, acquired);
      tx.set(acquired.reportRef, Object.assign({}, fields, {
        status: 'complete', active_generation_id: acquired.generationId,
        build_status: 'complete', build_owner: '', build_lease_until: null,
        last_build_error_code: ''
      }), { merge: true });
      tx.set(acquired.generationRef, {
        status: 'complete', owner: '', lease_until: null,
        completed_at: fields.completed_at, expires_at: acquired.expiresAt
      }, { merge: true });
      meter.writes += 2;
    });
  }

  async function failReport(acquired, code, meter) {
    return db.runTransaction(async function (tx) {
      const reportSnap = await tx.get(acquired.reportRef);
      meter.reads += 1;
      const value = reportSnap.exists ? (reportSnap.data() || {}) : null;
      if (!value || value.build_owner !== acquired.owner ||
          value.build_generation_id !== acquired.generationId) return false;
      const hasActive = !!String(value.active_generation_id || '');
      const errorCode = safeErrorCode(code);
      tx.set(acquired.reportRef, {
        status: hasActive ? 'complete' : 'failed',
        build_status: 'failed', build_owner: '', build_lease_until: null,
        last_build_error_code: errorCode, completed_at: timestamp(now()),
        expires_at: acquired.expiresAt
      }, { merge: true });
      tx.set(acquired.generationRef, {
        status: 'failed', owner: '', lease_until: null,
        error_code: errorCode, completed_at: timestamp(now()),
        expires_at: acquired.expiresAt
      }, { merge: true });
      meter.writes += 2;
      return true;
    });
  }

  async function rebuildReport(sidValue, monthValue, asOfValue, meterValue) {
    const sid = safeStationId(sidValue);
    const month = String(monthValue || '');
    if (!validMonth(month)) throw new AttendanceShadowError('invalid-month', 'Invalid report month.');
    const meter = meterValue || metrics();
    const asOf = engine.validDateKey(asOfValue) ? asOfValue : engine.localDateKey(now());
    const through = asOf < month + '-01' ? '' : (asOf > monthEnd(month) ? monthEnd(month) : asOf);
    const acquired = await acquireReport(sid, month, meter);
    try {
      const raw = await loadCompletedEntries(sid, month, through, meter);
      const base = 'stations/' + sid + '/';
      const values = await Promise.all([
        readBoundedCollection(base + 'users', MAX_USERS_PER_STATION,
          'station-too-large', meter),
        db.collection(base + 'attendance').where('month', '==', month)
          .limit(MAX_ATTENDANCE_PER_MONTH + 1).get(),
        readMonthExplanations(sid, month, meter)
      ]);
      meter.reads += values[1].size;
      if (values[1].size > MAX_ATTENDANCE_PER_MONTH) {
        throw new AttendanceShadowError('too-many-attendance-rows',
          'Attendance comparison limit exceeded.');
      }
      const compared = engine.compareShadowEntries({
        entries: raw.entries,
        attendance: snapshotValues(values[1]),
        users: values[0],
        guards: values[2].guards,
        submissions: values[2].submissions,
        asOfDate: asOf
      });
      if (!engine.privacySafe(compared.rows)) {
        throw new AttendanceShadowError('privacy-violation',
          'A derived Shadow report contains a forbidden identity field.');
      }
      const entryByKey = {};
      raw.entries.forEach(function (entry) { entryByKey[entry.uid + '|' + entry.date] = entry; });
      const grouped = {};
      compared.rows.forEach(function (row) {
        const warnings = Array.isArray(row.warning_codes) ? row.warning_codes : [];
        const blockingWarnings = warnings.filter(function (code) {
          // Existing ResQ rows predate the `source` field. Their data can still
          // match exactly, so legacy_source is measured but is not by itself a
          // migration blocker. Unknown or malformed metadata remains blocking.
          return code !== 'legacy_source';
        });
        if (row.state === 'match' && !blockingWarnings.length) return;
        const uid = safeUid(row.uid, false);
        const item = grouped[uid] || { uid: uid, rows: [], crew: '' };
        const source = entryByKey[row.uid + '|' + row.date];
        if (source) item.crew = source.home_crew || '';
        item.rows.push(reportIssue(row));
        grouped[uid] = item;
      });
      const people = Object.keys(grouped).sort().map(function (uid) {
        const item = grouped[uid];
        if (item.rows.length > daysInMonth(month)) {
          throw new AttendanceShadowError('invalid-person-report',
            'A person report contains too many daily issues.');
        }
        const person = {
          schema_version: 1, uid: safeUid(uid, false),
          home_crew: strictEnum(item.crew, engine.CREWS.concat(['']), 'home_crew'),
          issue_count: item.rows.length, issues: item.rows,
          generation_id: acquired.generationId, generated_at: timestamp(now()),
          expires_at: acquired.expiresAt
        };
        if (!engine.privacySafe(person)) {
          throw new AttendanceShadowError('privacy-violation',
            'A person report contains a forbidden identity field.');
        }
        // 200 documents × 32KiB stays below Firestore's 10MiB transaction
        // request ceiling even after paths and transaction metadata are added.
        if (Buffer.byteLength(JSON.stringify(person), 'utf8') > 32 * 1024) {
          throw new AttendanceShadowError('person-report-too-large',
            'A person Shadow report exceeds its byte limit.');
        }
        return person;
      });
      if (people.length > MAX_USERS_PER_STATION) {
        throw new AttendanceShadowError('too-many-report-people',
          'Monthly issue people exceed the station safety limit.');
      }
      await writeReportPeople(acquired, people, meter);

      const totals = Object.assign({}, compared.summary || {});
      totals.pending = Number(totals.pending || 0);
      totals.mismatches = compared.rows.filter(function (row) {
        return row.state === 'mismatch';
      }).length;
      totals.uncomparable = compared.rows.filter(function (row) {
        return row.state === 'uncomparable';
      }).length;
      totals.warning_rows = compared.rows.filter(function (row) {
        return Array.isArray(row.warning_codes) && row.warning_codes.length > 0;
      }).length;
      totals.legacy_source_rows = compared.rows.filter(function (row) {
        return Array.isArray(row.warning_codes) &&
          row.warning_codes.indexOf('legacy_source') !== -1;
      }).length;
      totals.blocking_warning_rows = compared.rows.filter(function (row) {
        return Array.isArray(row.warning_codes) && row.warning_codes.some(function (code) {
          return code !== 'legacy_source';
        });
      }).length;
      const gateReasons = [];
      if (!through) gateReasons.push('future_period');
      if (!raw.runIds.length) gateReasons.push('no_snapshot_runs');
      if (!raw.entries.length) gateReasons.push('no_snapshot_rows');
      if (raw.missingDays.length) gateReasons.push('missing_snapshot_days');
      if (totals.source_conflicts) gateReasons.push('source_conflicts');
      if (totals.identity_conflict) gateReasons.push('identity_conflicts');
      if (totals.blocking_warning_rows) gateReasons.push('data_warnings');
      if (totals.mismatches) gateReasons.push('mismatches');
      if (totals.uncomparable) gateReasons.push('uncomparable');
      if (totals.pending) gateReasons.push('pending');
      if (totals.explained_exceptions) gateReasons.push('exceptions_require_review');
      const completedAt = timestamp(now());
      const globalConflicts = (compared.global_conflicts || []).map(function (item) {
        return { code: strictEnum(item.code,
          ['attendance_missing_uid', 'attendance_uid_not_in_snapshot'], 'global_conflict'),
        count: Math.max(0, Math.floor(Number(item.count || 0))) };
      });
      await finalizeReport(acquired, {
        compared_through: through,
        snapshot_run_ids: raw.runIds, missing_snapshot_days: raw.missingDays,
        totals: totals, gate_pass: gateReasons.length === 0,
        gate_reasons: gateReasons, auto_activation_allowed: false,
        global_conflicts: globalConflicts,
        rows_digest: compared.rows_digest, people_count: people.length,
        generated_at: completedAt, completed_at: completedAt,
        duration_ms: Math.max(0, Date.now() - meter.started),
        read_count: meter.reads, write_count: meter.writes + 2,
        expires_at: acquired.expiresAt
      }, meter);
      return { month: month, people: people.length, totals: totals,
        gatePass: gateReasons.length === 0, missingDays: raw.missingDays };
    } catch (error) {
      await failReport(acquired, error.code || 'internal', meter);
      throw error;
    }
  }

  async function runStation(runOptions) {
    const input = runOptions || {};
    const sid = safeStationId(input.sid);
    const date = engine.validDateKey(input.date)
      ? String(input.date) : engine.localDateKey(now());
    const meter = metrics();
    const config = await readConfig(meter);
    if (!enabledFor(config, sid)) {
      throw new AttendanceShadowError('shadow-disabled', 'Attendance Shadow is disabled.');
    }
    const acquired = await acquireRun(sid, date, input.trigger,
      input.requestedBy, meter);
    if (acquired.duplicate) {
      const report = await rebuildReport(sid, date.slice(0, 7),
        engine.localDateKey(now()), meter);
      return { ok: true, duplicate: true,
        entries: Number(acquired.prior.entry_count || 0), report: report };
    }
    let sealed = false;
    try {
      if (acquired.checkpoint === 0) await clearEntries(acquired, meter);
      const source = await loadDaySources(sid, date, config, meter);
      const plan = engine.buildDailySnapshot(source);
      if (!engine.privacySafe(plan.entries)) {
        throw new AttendanceShadowError('privacy-violation',
          'Planner emitted a forbidden identity field.');
      }
      if (plan.entries.length > MAX_USERS_PER_STATION) {
        throw new AttendanceShadowError('station-too-large',
          'Planner row count exceeds the station safety limit.');
      }
      // Validate every persisted value before the first chunk is committed, so
      // a malformed late row cannot leave a needlessly partial capture.
      plan.entries.forEach(function (entry) {
        rawEntry(entry, acquired.id, acquired.capturedAt, acquired.expiresAt);
      });
      if (acquired.resumeSourceDigest &&
          acquired.resumeSourceDigest !== plan.source_digest) {
        throw new AttendanceShadowError('source-changed',
          'Source changed while resuming the daily run.');
      }
      await ownedRunUpdate(acquired, {
        source_digest: plan.source_digest, rows_digest: plan.rows_digest,
        entry_count: plan.entries.length,
        source_counts: {
          users: source.users.length, roster: source.roster.length,
          rotations: source.rotations.length, overrides: source.overrides.length,
          approved_swaps: source.swaps.length, sub_stations: source.subStations.length,
          dependency_dates: source.dependencyDates.length
        },
        result_counts: plan.result_counts,
        conflict_counts: plan.conflict_counts
      }, meter);
      const written = await writeEntries(acquired, plan, sid, meter);
      if (written.cancelled) return { ok: false, cancelled: true, entries: written.entries };

      // Reload the authoritative inputs after all chunks. A changed digest does
      // not rewrite the completed evidence; it invalidates this run instead.
      const freshConfig = await readConfig(meter);
      if (!enabledFor(freshConfig, sid)) {
        await ownedRunUpdate(acquired, { status: 'cancelled', error_code: 'shadow-disabled',
          completed_at: timestamp(now()), lease_until: null, lease_owner: '' }, meter);
        return { ok: false, cancelled: true, entries: written.entries };
      }
      const freshSource = await loadDaySources(sid, date, freshConfig, meter);
      const freshPlan = engine.buildDailySnapshot(freshSource);
      if (freshPlan.source_digest !== plan.source_digest ||
          freshPlan.rows_digest !== plan.rows_digest) {
        throw new AttendanceShadowError('source-changed',
          'Source changed before the daily capture was sealed.');
      }
      await ownedRunUpdate(acquired, {
        status: 'complete', checkpoint: plan.entries.length,
        completed_at: timestamp(now()), lease_until: null, lease_owner: '',
        duration_ms: Math.max(0, Date.now() - meter.started),
        read_count: meter.reads, write_count: meter.writes + 1
      }, meter);
      sealed = true;
      let report;
      try {
        report = await rebuildReport(sid, date.slice(0, 7),
          engine.localDateKey(now()), meter);
      } catch (reportError) {
        // The canonical pre-shift evidence was already sealed successfully.
        // A derived report failure must remain visible, but must never rewrite
        // that immutable fact as a failed capture.
        throw reportError;
      }
      return { ok: true, duplicate: false, entries: plan.entries.length,
        conflicts: Number(plan.result_counts.conflict || 0), report: report };
    } catch (error) {
      if (!sealed) await markRunFailure(acquired, error.code || 'internal', meter);
      throw error;
    }
  }

  async function status(sidValue) {
    const sid = safeStationId(sidValue);
    const meter = metrics();
    const config = await readConfig(meter);
    const snap = await db.collection('stations/' + sid + '/attendance_shadow_runs')
      .orderBy('target_date', 'desc').limit(1).get();
    meter.reads += snap.size;
    const last = snap.empty ? null : pick(snap.docs[0].data() || {}, [
      'target_date', 'status', 'started_at', 'completed_at',
      'entry_count', 'result_counts', 'conflict_counts', 'generator_version'
    ]);
    return { mode: enabledFor(config, sid) ? 'shadow' : 'off',
      station_id: sid, generator_version: GENERATOR_VERSION, last_run: last };
  }

  async function configuredStations() {
    const config = await readConfig();
    return { mode: config.mode, stationIds: config.station_ids };
  }

  return {
    runStation: runStation,
    rebuildReport: rebuildReport,
    status: status,
    configuredStations: configuredStations,
    readConfig: readConfig
  };
}

module.exports = {
  CONFIG_PATH: CONFIG_PATH,
  GENERATOR_VERSION: GENERATOR_VERSION,
  RAW_RETENTION_DAYS: RAW_RETENTION_DAYS,
  REPORT_RETENTION_MONTHS: REPORT_RETENTION_MONTHS,
  BATCH_SIZE: BATCH_SIZE,
  runIdFor: runIdFor,
  validMonth: validMonth,
  dayKeysThrough: dayKeysThrough,
  AttendanceShadowError: AttendanceShadowError,
  createAttendanceShadowService: createAttendanceShadowService
};
