'use strict';

/**
 * Pure server-side coordinator for operational schedule reads.
 *
 * Storage, authorization lookup and the projection are injected.  This file
 * neither writes nor imports infrastructure clients.  In particular, the
 * caller cannot choose a station, source, publication or person: those come
 * from `resolveLiveContext` and the active publication pointer.
 *
 * `readActivePublication` must return this verified shape:
 * {
 *   pointer: { publication_id, revision, content_digest },
 *   publication: { station_id, status:'active', snapshot_complete:true,
 *                  revision, content_digest },
 *   snapshot: { content_digest, plan, roster }
 * }
 * The storage adapter is responsible for verifying the complete snapshot's
 * digest before it returns a range.  This module checks that all three digest
 * references agree and never falls back to legacy data in `new` mode.
 */

const MODE = Object.freeze({ OFF: 'off', SHADOW: 'shadow', NEW: 'new' });
const MAX_WINDOW_DAYS = 93;
const DAY_MS = 86400000;
const ID_RE = /^[A-Za-z0-9_-]{2,120}$/;
// Firebase Auth UIDs are a different namespace from station/publication IDs.
// They may contain dots and other printable characters, but ResQ also uses
// them as Firestore document ids, so path separators and controls stay closed.
const UID_RE = /^[^\u0000-\u001F\u007F/]{1,128}$/u;
const CONTROL_RE = /[\u0000-\u001F\u007F]/;
const LEGACY_ASSIGNMENT_SOURCES = Object.freeze([
  'legacy_rotation', 'legacy_override', 'legacy_standby', 'legacy_swap'
]);
const LEGACY_GUARD_STATUSES = Object.freeze(['open', 'staffed', 'done']);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_LEGACY_GUARD_EVENTS = 1000;
const MAX_LEGACY_GUARD_PEOPLE = 20;

class ScheduleEffectiveReaderError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ScheduleEffectiveReaderError';
    this.code = code;
  }
}

function fail(code) {
  throw new ScheduleEffectiveReaderError(code);
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.keys(value).forEach((key) => deepFreeze(value[key]));
  return value;
}

function exactKeys(value, expected, code) {
  if (!plain(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  if (actual.length !== wanted.length) fail(code);
  for (let index = 0; index < wanted.length; index += 1) {
    if (actual[index] !== wanted[index]) fail(code);
  }
}

function id(value, code) {
  if (typeof value !== 'string' || !ID_RE.test(value)) fail(code);
  return value;
}

function uid(value, code) {
  if (typeof value !== 'string' || !UID_RE.test(value)) fail(code);
  return value;
}

function text(value, code, maximum) {
  if (typeof value !== 'string') fail(code);
  const normalized = value.trim();
  if (!normalized || CONTROL_RE.test(normalized) || normalized.length > (maximum || 160)) fail(code);
  return normalized;
}

function optionalText(value, code, maximum) {
  if (value === undefined || value === null || value === '') return null;
  return text(value, code, maximum);
}

function time(value, code) {
  if (typeof value !== 'string' || !TIME_RE.test(value)) fail(code);
  return value;
}

function date(value, code) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(code);
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    fail(code);
  }
  return value;
}

function ordinal(iso) {
  return Math.floor(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10))) / DAY_MS);
}

function isoFromOrdinal(value) {
  const dateValue = new Date(value * DAY_MS);
  const pad = (part) => String(part).padStart(2, '0');
  return String(dateValue.getUTCFullYear()).padStart(4, '0') + '-'
    + pad(dateValue.getUTCMonth() + 1) + '-' + pad(dateValue.getUTCDate());
}

function normalizeRange(req) {
  if (!plain(req)) fail('request-required');
  exactKeys(req.data, ['from', 'to'], 'request-shape');
  const from = date(req.data.from, 'range-date');
  const to = date(req.data.to, 'range-date');
  const fromOrdinal = ordinal(from);
  const toOrdinal = ordinal(to);
  if (toOrdinal < fromOrdinal || toOrdinal - fromOrdinal + 1 > MAX_WINDOW_DAYS) fail('range-invalid');
  const dates = [];
  for (let day = fromOrdinal; day <= toOrdinal; day += 1) dates.push(isoFromOrdinal(day));
  return deepFreeze({ from, to, fromOrdinal, toOrdinal, dates });
}

function normalizeContext(raw) {
  if (!plain(raw)) fail('context-invalid');
  if (raw.active !== true) fail('context-inactive');
  return deepFreeze({
    station_id: id(raw.station_id, 'context-station'),
    uid: uid(raw.uid, 'context-uid'),
    active: true
  });
}

function normalizeRuntime(raw) {
  if (!plain(raw)) fail('runtime-invalid');
  if (raw.mode !== MODE.OFF && raw.mode !== MODE.SHADOW && raw.mode !== MODE.NEW) {
    fail('runtime-mode');
  }
  return raw.mode;
}

function suppliedStation(raw, stationId, code) {
  // The adapter must bind every projection envelope to the server-derived
  // station path.  Treat a missing station exactly like a foreign one: a
  // compatibility reader must never infer a station from a roster payload.
  if (!plain(raw) || raw.station_id !== stationId) fail(code + '-station');
}

function normalizeActiveSnapshot(raw, stationId) {
  if (!plain(raw)) fail('active-publication-missing');
  const pointer = raw.pointer;
  const publication = raw.publication;
  const snapshot = raw.snapshot;
  if (!plain(pointer) || !plain(publication) || !plain(snapshot)) fail('active-publication-invalid');

  const publicationId = id(pointer.publication_id, 'active-pointer-id');
  if (!Number.isSafeInteger(pointer.revision) || pointer.revision < 1) fail('active-pointer-revision');
  const digest = text(pointer.content_digest, 'active-pointer-digest', 256);
  if (publication.station_id !== stationId || publication.status !== 'active'
      || publication.snapshot_complete !== true) fail('active-publication-invalid');
  if (!Number.isSafeInteger(publication.revision) || publication.revision !== pointer.revision) {
    fail('active-publication-revision');
  }
  if (text(publication.content_digest, 'active-publication-digest', 256) !== digest
      || text(snapshot.content_digest, 'active-snapshot-digest', 256) !== digest) {
    fail('active-publication-digest-mismatch');
  }
  if (pointer.station_id !== stationId) fail('active-pointer-station');
  if (publication.id !== publicationId || publication.publication_id !== publicationId) {
    fail('active-publication-id');
  }
  if (snapshot.publication_id !== publicationId) fail('active-snapshot-id');
  if (!plain(snapshot.plan) || !Array.isArray(snapshot.roster)) fail('active-snapshot-invalid');
  return {
    publication_id: publicationId,
    revision: pointer.revision,
    content_digest: digest,
    plan: snapshot.plan,
    roster: snapshot.roster
  };
}

function sanitizeAssignment(raw, source) {
  if (!plain(raw)) fail('projection-assignment');
  const assignmentUid = uid(raw.uid, 'projection-assignment-uid');
  const display = text(raw.display, 'projection-assignment-display', 120);
  const assignmentSource = text(raw.source, 'projection-assignment-source', 40);
  const out = { uid: assignmentUid, display };
  if (source === 'v2') {
    if (assignmentSource !== 'v2') fail('projection-assignment-source');
    const subStation = optionalText(raw.sub_station, 'projection-assignment-sub-station', 120);
    const role = optionalText(raw.role, 'projection-assignment-role', 120);
    if (subStation !== null) out.sub_station = subStation;
    if (role !== null) out.role = role;
  } else {
    if (LEGACY_ASSIGNMENT_SOURCES.indexOf(assignmentSource) === -1) {
      fail('projection-assignment-source');
    }
    const crew = optionalText(raw.crew, 'projection-assignment-crew', 80);
    if (crew !== null) out.crew = crew;
  }
  out.source = assignmentSource;
  return deepFreeze(out);
}

function sanitizeLegacyEvent(raw, range) {
  exactKeys(raw, ['id', 'date', 'title', 'start', 'end', 'status', 'people'], 'projection-event');
  const eventId = id(raw.id, 'projection-event-id');
  const eventDate = date(raw.date, 'projection-event-date');
  if (range.dates.indexOf(eventDate) === -1) fail('projection-event-range');
  const title = text(raw.title, 'projection-event-title', 80);
  const start = time(raw.start, 'projection-event-time');
  const end = time(raw.end, 'projection-event-time');
  if (LEGACY_GUARD_STATUSES.indexOf(raw.status) === -1) fail('projection-event-status');
  if (!Array.isArray(raw.people) || raw.people.length > MAX_LEGACY_GUARD_PEOPLE) {
    fail('projection-event-people');
  }
  const seen = new Set();
  const people = raw.people.map((person) => {
    exactKeys(person, ['uid', 'display'], 'projection-event-person');
    const personUid = uid(person.uid, 'projection-event-person');
    if (seen.has(personUid)) fail('projection-event-person-duplicate');
    seen.add(personUid);
    return deepFreeze({ uid: personUid,
      display: text(person.display, 'projection-event-person', 120) });
  }).sort((left, right) => (left.uid < right.uid ? -1 : (left.uid > right.uid ? 1 : 0)));
  return deepFreeze({ id: eventId, date: eventDate, title, start, end, status: raw.status, people });
}

function sanitizeLegacyEvents(raw, range) {
  // Existing legacy data did not have a schedule event projection at all.
  // Treat an absent projection as an empty list for compatibility; when the
  // adapter does supply events, validate every field again before it reaches
  // a response.
  if (raw === undefined) return deepFreeze([]);
  if (!Array.isArray(raw) || raw.length > MAX_LEGACY_GUARD_EVENTS) fail('projection-events');
  const ids = new Set();
  const events = raw.map((event) => {
    const safe = sanitizeLegacyEvent(event, range);
    if (ids.has(safe.id)) fail('projection-event-duplicate');
    ids.add(safe.id);
    return safe;
  }).sort((left, right) => {
    const leftKey = left.date + '|' + left.start + '|' + left.id;
    const rightKey = right.date + '|' + right.start + '|' + right.id;
    return leftKey < rightKey ? -1 : (leftKey > rightKey ? 1 : 0);
  });
  return deepFreeze(events);
}

function sanitizeWindow(raw, source, stationId, range) {
  if (!plain(raw) || raw.source !== source || raw.station_id !== stationId || !Array.isArray(raw.days)) {
    fail('projection-window-invalid');
  }
  if (raw.days.length !== range.dates.length) fail('projection-window-range');
  const days = raw.days.map((day, index) => {
    if (!plain(day) || day.date !== range.dates[index] || !Array.isArray(day.assignments)) {
      fail('projection-window-day');
    }
    const seen = new Set();
    const assignments = day.assignments.map((assignment) => {
      const safe = sanitizeAssignment(assignment, source);
      if (seen.has(safe.uid)) fail('projection-assignment-duplicate');
      seen.add(safe.uid);
      return safe;
    }).sort((left, right) => (left.uid < right.uid ? -1 : (left.uid > right.uid ? 1 : 0)));
    return deepFreeze({ date: day.date, assignments: deepFreeze(assignments) });
  });
  return deepFreeze(days);
}

function provenance(mode, source, active) {
  return deepFreeze({
    mode,
    source,
    publication_id: active ? active.publication_id : null,
    revision: active ? active.revision : null,
    content_digest: active ? active.content_digest : null
  });
}

function createScheduleEffectiveReader(deps) {
  const options = plain(deps) ? deps : {};
  const resolveLiveContext = options.resolveLiveContext;
  const readRuntime = options.readRuntime;
  const readLegacy = options.readLegacy;
  const readActivePublication = options.readActivePublication;
  const createOperationalProjection = options.createOperationalProjection;
  if (typeof resolveLiveContext !== 'function' || typeof readRuntime !== 'function'
      || typeof readLegacy !== 'function' || typeof readActivePublication !== 'function'
      || typeof createOperationalProjection !== 'function') {
    throw new ScheduleEffectiveReaderError('dependencies-required');
  }

  function project(input, source, stationId, range) {
    suppliedStation(input, stationId, source + '-source-invalid');
    const projectionInput = Object.assign({}, input, { source, station_id: stationId });
    const projection = createOperationalProjection(projectionInput);
    if (!plain(projection) || typeof projection.stationWindow !== 'function') {
      fail('projection-invalid');
    }
    return sanitizeWindow(projection.stationWindow({ from: range.from, to: range.to }), source, stationId, range);
  }

  async function resolve(req, range) {
    // Validate the client envelope before handing it to a dependency.  The
    // data shape has no station, uid, source or publication selector.
    const safeRange = range || normalizeRange(req);
    const ctx = normalizeContext(await resolveLiveContext(req));
    const mode = normalizeRuntime(await readRuntime(ctx));
    if (mode === MODE.OFF || mode === MODE.SHADOW) {
      const legacy = await readLegacy(ctx, safeRange);
      const days = project(legacy, 'legacy', ctx.station_id, safeRange);
      return { ctx, mode, source: 'legacy', days,
        events: sanitizeLegacyEvents(legacy.events, safeRange), active: null };
    }

    // `new` is a hard boundary.  Any missing, stale or malformed active
    // snapshot stops the request instead of quietly yielding legacy work.
    const active = normalizeActiveSnapshot(await readActivePublication(ctx, safeRange), ctx.station_id);
    const days = project({ station_id: ctx.station_id, roster: active.roster, plan: active.plan },
      'v2', ctx.station_id, safeRange);
    return { ctx, mode, source: 'v2', days, events: deepFreeze([]), active };
  }

  function response(kind, resolved, range, uid) {
    const days = resolved.days.map((day) => {
      const assignments = uid
        ? day.assignments.filter((assignment) => assignment.uid === uid)
        : day.assignments.slice();
      return deepFreeze({ date: day.date, assignments: deepFreeze(assignments) });
    });
    const events = (resolved.events || []).filter((event) => !uid
      || event.people.some((person) => person.uid === uid)).map((event) => {
      const people = uid
        ? event.people.filter((person) => person.uid === uid)
        : event.people.slice();
      return deepFreeze({
        id: event.id, date: event.date, title: event.title, start: event.start,
        end: event.end, status: event.status, people: deepFreeze(people)
      });
    });
    return deepFreeze({
      kind,
      source: resolved.source,
      from: range.from,
      to: range.to,
      provenance: provenance(resolved.mode, resolved.source, resolved.active),
      days: deepFreeze(days),
      events: deepFreeze(events)
    });
  }

  return Object.freeze({
    getMy: async function getMy(req) {
      const range = normalizeRange(req);
      const resolved = await resolve(req, range);
      return response('schedule-effective-my-window', resolved, range, resolved.ctx.uid);
    },
    getStation: async function getStation(req) {
      const range = normalizeRange(req);
      return response('schedule-effective-station-window', await resolve(req, range), range, null);
    }
  });
}

module.exports = Object.freeze({
  MODE,
  MAX_WINDOW_DAYS,
  ScheduleEffectiveReaderError,
  createScheduleEffectiveReader
});
