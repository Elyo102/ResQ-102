'use strict';

/**
 * Firestore wiring for the monthly ResQ schedule engine.
 *
 * The runtime is deliberately fail-closed:
 * - station and identity come only from authenticated server state;
 * - missing configuration means mode="off";
 * - source and policy documents are accepted only when their server-computed
 *   digests and declared document counts match;
 * - drafts/publications are immutable snapshots;
 * - notifications remain blocked until the active pointer is committed.
 */

class ScheduleRuntimeError extends Error {
  constructor(code, message, httpCode) {
    super(message);
    this.name = 'ScheduleRuntimeError';
    this.code = code;
    this.httpCode = httpCode || 'failed-precondition';
  }
}

const MODE = Object.freeze({ OFF: 'off', SHADOW: 'shadow', NEW: 'new' });
const MODES = Object.freeze(Object.keys(MODE).map((key) => MODE[key]));
const MANAGER_ROLES = Object.freeze(['deputy', 'commander', 'station_commander']);
const MEMBER_ROLES = Object.freeze([
  'firefighter', 'deputy_team_leader', 'team_leader',
  'deputy', 'commander', 'station_commander', 'hr_coordinator'
]);
const ID_RE = /^[A-Za-z0-9_-]{2,120}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BATCH_WRITES = 350;
const MAX_ROW_BYTES = 850000;
const MAX_OVERRIDES = 5000;
const MAX_SOURCE_PEOPLE = 20000;
const MAX_SOURCE_GROUP = 20000;
const MAX_SOURCE_TOTAL = 50000;
const OUTBOX_LEASE_MS = 10 * 60 * 1000;
const OUTBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DRAFT_PREVIEW_DAYS = 7;
const ROLLBACK_REASONS = Object.freeze([
  'configuration_error', 'wrong_roster', 'wrong_assignment', 'operational_safety', 'other'
]);

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function integer(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (plain(value)) {
    return '{' + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

// Digests must be identical on every OS and Node/ICU build. localeCompare()
// is locale-sensitive, so every order that feeds a digest uses code-unit order.
function compareCanonical(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : (a > b ? 1 : 0);
}

function isoDayOffset(iso, offset) {
  if (!DATE_RE.test(String(iso || ''))) {
    throw new ScheduleRuntimeError('date-invalid', 'התאריך חייב להיות בצורת YYYY-MM-DD', 'invalid-argument');
  }
  const value = new Date(iso + 'T00:00:00.000Z');
  if (Number.isNaN(value.getTime()) || value.toISOString().slice(0, 10) !== iso) {
    throw new ScheduleRuntimeError('date-invalid', 'התאריך אינו אפשרי', 'invalid-argument');
  }
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function createScheduleRuntime(deps) {
  const d = plain(deps) ? deps : {};
  const db = d.db;
  const FV = d.FieldValue;
  const clock = d.clock;
  const hash = d.hash;
  const randomId = d.randomId;
  const createEngine = d.createEngine;
  const createPublication = d.createPublication;
  const createService = d.createService;
  const isSuper = typeof d.isSuper === 'function' ? d.isSuper : function () { return false; };
  const sendPush = d.sendPush;

  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new ScheduleRuntimeError('db-required', 'חובה להזריק Firestore');
  }
  if (!FV || typeof FV.serverTimestamp !== 'function') {
    throw new ScheduleRuntimeError('field-value-required', 'חובה להזריק FieldValue');
  }
  if (typeof clock !== 'function' || typeof hash !== 'function' || typeof randomId !== 'function') {
    throw new ScheduleRuntimeError('runtime-dependencies', 'חסרות תלויות זמן, גיבוב או מזהים');
  }
  if (typeof createEngine !== 'function' || typeof createPublication !== 'function'
      || typeof createService !== 'function') {
    throw new ScheduleRuntimeError('schedule-modules-required', 'חסרים מודולי הסידור');
  }
  if (typeof sendPush !== 'function') {
    throw new ScheduleRuntimeError('push-required', 'חובה להזריק שולח התראות');
  }

  function digest(value) {
    return hash(stable(value));
  }

  function stationRef(sid) {
    return db.collection('stations').doc(sid);
  }

  function runtimeRef(sid) {
    return stationRef(sid).collection('schedule_state').doc('runtime');
  }

  function activeRef(sid) {
    return stationRef(sid).collection('schedule_state').doc('active');
  }

  function requireId(value, code, label) {
    const out = String(value || '').trim();
    if (!ID_RE.test(out)) {
      throw new ScheduleRuntimeError(code, label + ' אינו תקין', 'invalid-argument');
    }
    return out;
  }

  async function context(req) {
    if (!req || !req.auth || !req.auth.uid) {
      throw new ScheduleRuntimeError('unauthenticated', 'צריך להיות מחובר.', 'unauthenticated');
    }
    const data = plain(req.data) ? req.data : {};
    if (Object.prototype.hasOwnProperty.call(data, 'stationId')
        || Object.prototype.hasOwnProperty.call(data, 'station_id')) {
      throw new ScheduleRuntimeError('client-station-forbidden',
        'התחנה נקבעת מהחשבון ואינה מתקבלת מהלקוח.', 'invalid-argument');
    }
    const token = req.auth.token || {};
    const sid = String(token.stationId || '').trim();
    if (!ID_RE.test(sid)) {
      throw new ScheduleRuntimeError('station-required',
        'לחשבון אין שיוך תחנה תקין.', 'failed-precondition');
    }
    const userSnap = await stationRef(sid).collection('users').doc(req.auth.uid).get();
    if (!userSnap.exists) {
      throw new ScheduleRuntimeError('live-user-required',
        'החשבון אינו קיים ברשימת המשתמשים הפעילה של התחנה.', 'permission-denied');
    }
    const user = userSnap.data() || {};
    const liveStation = String(user.stationId || user.station_id || '');
    const conflictingStationFields = nonEmpty(user.stationId) && nonEmpty(user.station_id)
      && user.stationId !== user.station_id;
    const liveActive = user.is_active !== false && user.active !== false;
    if (!liveActive || conflictingStationFields || liveStation !== sid) {
      throw new ScheduleRuntimeError('live-user-inactive',
        'החשבון אינו פעיל או שאינו משויך לתחנה.', 'permission-denied');
    }
    const role = String(user.role || '');
    if (!isSuper(req.auth) && MEMBER_ROLES.indexOf(role) === -1) {
      throw new ScheduleRuntimeError('role-forbidden', 'לתפקיד אין גישה לסידור.', 'permission-denied');
    }
    if (!isSuper(req.auth) && String(token.role || '') !== role) {
      throw new ScheduleRuntimeError('claims-stale',
        'הרשאות החשבון אינן מסונכרנות. יש לצאת ולהיכנס מחדש.', 'permission-denied');
    }
    return Object.freeze({
      uid: req.auth.uid,
      sid,
      role,
      name: String(user.full_name || user.name || token.name || req.auth.uid).slice(0, 120),
      // מינוי אחראי סידור הוא claim חתום שהשרת בלבד יכול להנפיק.
      // לעולם אין סומכים על שדה במסמך הפרופיל שהלקוח קורא.
      manager: isSuper(req.auth)
        || token.schedule_manager === true
        || MANAGER_ROLES.indexOf(role) !== -1,
      user
    });
  }

  function actor(ctx) {
    return {
      id: ctx.uid,
      role: ctx.manager ? 'scheduler' : 'firefighter',
      station_id: ctx.sid,
      active: true
    };
  }

  function capabilities() {
    const view = ['view_my', 'view_station', 'respond_own'];
    return {
      firefighter: view,
      scheduler: view.concat(['edit_draft', 'run_planner', 'publish'])
    };
  }

  function serviceFor(ctx, engine, publication) {
    const safeEngine = engine || { planPeriod: function () {}, policy: { station_id: ctx.sid } };
    const safePublication = publication || { planPublication: function () {} };
    return createService({
      clock,
      engine: safeEngine,
      publication: safePublication,
      rules: { station_id: ctx.sid, capabilities: capabilities() }
    });
  }

  async function configuration(sid) {
    const snap = await runtimeRef(sid).get();
    const data = snap.exists ? (snap.data() || {}) : {};
    const mode = MODES.indexOf(data.mode) !== -1 ? data.mode : MODE.OFF;
    return Object.freeze({
      mode,
      active_policy_id: nonEmpty(data.active_policy_id) ? data.active_policy_id : null,
      active_source_id: nonEmpty(data.active_source_id) ? data.active_source_id : null
    });
  }

  function requireManager(ctx) {
    if (!ctx.manager) {
      throw new ScheduleRuntimeError('manager-required',
        'עריכה ופרסום מותרים לאחראי סידור ולקצינים בלבד.', 'permission-denied');
    }
  }

  function requireMode(config, allowed) {
    if (allowed.indexOf(config.mode) === -1) {
      throw new ScheduleRuntimeError('schedule-mode-blocked',
        'מנוע הסידור אינו מופעל לפעולה הזאת. מצב נוכחי: ' + config.mode);
    }
    if (!config.active_policy_id || !config.active_source_id) {
      throw new ScheduleRuntimeError('schedule-config-incomplete',
        'לא הוגדרו מדיניות ומקור נתונים פעילים.');
    }
  }

  async function readSorted(collection) {
    const snap = await collection.get();
    return snap.docs.slice().sort((a, b) => compareCanonical(a.id, b.id));
  }

  async function loadPolicy(ctx, id) {
    const policyId = requireId(id, 'policy-id', 'מזהה המדיניות');
    const snap = await stationRef(ctx.sid).collection('schedule_policies').doc(policyId).get();
    if (!snap.exists) throw new ScheduleRuntimeError('policy-not-found', 'מדיניות הסידור לא נמצאה.');
    const raw = snap.data() || {};
    if (raw.station_id !== ctx.sid || raw.complete !== true || !nonEmpty(raw.version)) {
      throw new ScheduleRuntimeError('policy-incomplete', 'מדיניות הסידור אינה מלאה או שייכת לתחנה אחרת.');
    }
    const basis = {
      station_id: raw.station_id,
      version: raw.version,
      sub_stations: raw.sub_stations,
      rest: raw.rest,
      rotation: Object.prototype.hasOwnProperty.call(raw, 'rotation') ? raw.rotation : undefined,
      max_shifts_per_month: Object.prototype.hasOwnProperty.call(raw, 'max_shifts_per_month')
        ? raw.max_shifts_per_month : undefined
    };
    const actual = digest(basis);
    if (!nonEmpty(raw.content_digest) || raw.content_digest !== actual) {
      throw new ScheduleRuntimeError('policy-digest-mismatch',
        'חתימת מדיניות הסידור אינה תואמת לתוכן.');
    }
    return Object.freeze({
      id: policyId,
      digest: actual,
      value: Object.assign({}, basis, { digest: actual })
    });
  }

  async function loadSource(ctx, id) {
    const sourceId = requireId(id, 'source-id', 'מזהה המקור');
    const ref = stationRef(ctx.sid).collection('schedule_sources').doc(sourceId);
    const snap = await ref.get();
    if (!snap.exists) throw new ScheduleRuntimeError('source-not-found', 'מקור הסידור לא נמצא.');
    const meta = snap.data() || {};
    if (meta.station_id !== ctx.sid || meta.complete !== true
        || !nonEmpty(meta.version) || !nonEmpty(meta.revision)) {
      throw new ScheduleRuntimeError('source-incomplete', 'מקור הסידור אינו מלא או שייך לתחנה אחרת.');
    }
    for (const field of ['person_count', 'availability_count', 'locked_count', 'event_count']) {
      if (!integer(meta[field]) || meta[field] < 0) {
        throw new ScheduleRuntimeError('source-count-required', 'למקור חסרה ספירה חתומה: ' + field);
      }
    }
    if (meta.person_count > MAX_SOURCE_PEOPLE
        || meta.availability_count > MAX_SOURCE_GROUP
        || meta.locked_count > MAX_SOURCE_GROUP
        || meta.event_count > MAX_SOURCE_GROUP
        || meta.person_count + meta.availability_count + meta.locked_count + meta.event_count
           > MAX_SOURCE_TOTAL) {
      throw new ScheduleRuntimeError('source-count-limit',
        'מקור הסידור גדול מהתקרה המאושרת ולכן לא ייקרא.', 'resource-exhausted');
    }
    const groups = await Promise.all([
      readSorted(ref.collection('people')),
      readSorted(ref.collection('availability')),
      readSorted(ref.collection('locked')),
      readSorted(ref.collection('events'))
    ]);
    if (groups[0].length !== meta.person_count || groups[1].length !== meta.availability_count
        || groups[2].length !== meta.locked_count || groups[3].length !== meta.event_count) {
      throw new ScheduleRuntimeError('source-count-mismatch',
        'מקור הסידור אינו שלם: מספר הרשומות אינו תואם לחוזה.');
    }
    const peopleRaw = groups[0].map((doc) => Object.assign({ id: doc.id }, doc.data() || {}));
    const availability = {};
    groups[1].forEach((doc) => { availability[doc.id] = (doc.data() || {}).days || {}; });
    const locked = {};
    groups[2].forEach((doc) => { locked[doc.id] = (doc.data() || {}).days || {}; });
    const eventsRaw = groups[3].map((doc) => Object.assign({ id: doc.id }, doc.data() || {}));
    const basis = {
      station_id: meta.station_id,
      version: meta.version,
      revision: meta.revision,
      carry: plain(meta.carry) ? meta.carry : {},
      counts: {
        people: meta.person_count,
        availability: meta.availability_count,
        locked: meta.locked_count,
        events: meta.event_count
      },
      people: peopleRaw,
      availability,
      locked,
      events: eventsRaw
    };
    const actual = digest(basis);
    if (!nonEmpty(meta.content_digest) || meta.content_digest !== actual) {
      throw new ScheduleRuntimeError('source-digest-mismatch',
        'חתימת מקור הסידור אינה תואמת לתוכן.');
    }
    return {
      id: sourceId,
      version: meta.version,
      revision: meta.revision,
      digest: actual,
      carry: plain(meta.carry) ? meta.carry : {},
      peopleRaw,
      availability,
      locked,
      eventsRaw
    };
  }

  function normalizeOverrides(value, policy) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > MAX_OVERRIDES) {
      throw new ScheduleRuntimeError('overrides-invalid',
        'רשימת השינויים הידניים אינה תקינה.', 'invalid-argument');
    }
    return value.map((entry) => {
      if (!plain(entry) || !DATE_RE.test(String(entry.date || ''))
          || !nonEmpty(entry.sub_station) || !nonEmpty(entry.person)
          || (entry.role !== null && entry.role !== undefined && !nonEmpty(entry.role))) {
        throw new ScheduleRuntimeError('override-invalid',
          'שינוי ידני חייב לכלול תאריך, תחנת קצה ואדם.', 'invalid-argument');
      }
      if (!policy.sub_stations[entry.sub_station]) {
        throw new ScheduleRuntimeError('override-sub-station',
          'תחנת הקצה בשינוי הידני אינה קיימת.', 'invalid-argument');
      }
      return {
        date: entry.date,
        sub_station: entry.sub_station,
        person: entry.person,
        role: entry.role || null
      };
    }).sort((a, b) => compareCanonical(stable(a), stable(b)));
  }

  function effectiveSource(ctx, source, policy, overrides) {
    const locked = JSON.parse(JSON.stringify(source.locked));
    overrides.forEach((entry) => {
      locked[entry.sub_station] = locked[entry.sub_station] || {};
      locked[entry.sub_station][entry.date] = locked[entry.sub_station][entry.date] || [];
      locked[entry.sub_station][entry.date].push({ person: entry.person, role: entry.role });
    });
    const effectiveDigest = digest({ source_digest: source.digest, overrides });
    const revision = source.revision + '-' + effectiveDigest.slice(0, 12);
    const snapshot = source.id + '-' + effectiveDigest.slice(0, 16);
    const roster = source.peopleRaw.map((person) => Object.assign({}, person, {
      station_id: ctx.sid,
      source_snapshot: snapshot,
      source_version: source.version,
      contract_station_id: ctx.sid,
      source_revision: revision,
      source_digest: effectiveDigest,
      source_complete: true
    }));
    const events = source.eventsRaw.map((event) => Object.assign({}, event, {
      station_id: ctx.sid,
      source_snapshot: snapshot,
      source_version: source.version
    }));
    return { snapshot, version: source.version, revision, digest: effectiveDigest,
      roster, availability: source.availability, locked, carry: source.carry, events,
      policy_digest: policy.digest };
  }

  function flattenPlanSet(set) {
    if (!set || !Array.isArray(set.periods) || !set.periods.length) {
      throw new ScheduleRuntimeError('plan-empty', 'המנוע לא החזיר תקופות לסידור.');
    }
    const first = set.periods[0];
    const last = set.periods[set.periods.length - 1];
    const rows = [];
    const summary = {
      filled: 0, blocking_gaps: 0, days_below_minimum: 0,
      rejected_manual: 0, open_rows: 0
    };
    set.periods.forEach((period) => {
      period.rows.forEach((row) => rows.push(row));
      Object.keys(summary).forEach((key) => { summary[key] += Number(period.summary[key] || 0); });
    });
    summary.load = last.summary.load;
    summary.fairness = last.summary.fairness;
    return {
      kind: 'schedule-plan',
      station_id: first.station_id,
      source_snapshot: first.source_snapshot,
      source_version: first.source_version,
      contract_station_id: first.contract_station_id,
      source_revision: first.source_revision,
      source_digest: first.source_digest,
      policy_version: first.policy_version,
      policy_digest: first.policy_digest,
      source_complete: true,
      generated_at: first.generated_at,
      from: first.from,
      to: last.to,
      rows,
      summary,
      carry: set.carry
    };
  }

  async function commitWrites(ops) {
    for (let i = 0; i < ops.length; i += MAX_BATCH_WRITES) {
      const batch = db.batch();
      ops.slice(i, i + MAX_BATCH_WRITES).forEach((op) => {
        if (op.kind === 'update') batch.update(op.ref, op.data);
        else if (op.kind === 'create') batch.create(op.ref, op.data);
        else batch.set(op.ref, op.data, op.options || undefined);
      });
      await batch.commit();
    }
  }

  function rowDocument(row) {
    const value = { date: row.date, sub_station: row.sub_station, row };
    if (Buffer.byteLength(stable(value), 'utf8') > MAX_ROW_BYTES) {
      throw new ScheduleRuntimeError('schedule-row-too-large',
        'שורת סידור גדולה מכדי להישמר בבטחה.');
    }
    return value;
  }

  async function stageSnapshot(ref, meta, plan, events, people) {
    const rows = plan.rows.slice().sort((a, b) => {
      const ak = a.date + '|' + a.sub_station;
      const bk = b.date + '|' + b.sub_station;
      return compareCanonical(ak, bk);
    });
    const orderedEvents = (events || []).slice().sort((a, b) => compareCanonical(a.id, b.id));
    const peopleById = new Map();
    (people || []).forEach((person) => {
      if (!person || !nonEmpty(person.id) || peopleById.has(person.id)) return;
      peopleById.set(person.id, {
        id: person.id,
        name: String(person.full_name || person.name || person.id).slice(0, 120),
        sub_station: person.sub_station || null,
        roles: Array.isArray(person.roles) ? person.roles.slice() : [],
        qualifications: Array.isArray(person.qualifications) ? person.qualifications.slice() : []
      });
    });
    const orderedPeople = Array.from(peopleById.keys()).sort().map((id) => peopleById.get(id));
    const contentDigest = digest({
      contract: {
        station_id: plan.station_id, source_snapshot: plan.source_snapshot,
        source_version: plan.source_version, source_revision: plan.source_revision,
        source_digest: plan.source_digest, policy_version: plan.policy_version,
        policy_digest: plan.policy_digest, source_complete: plan.source_complete
      }, rows, events: orderedEvents, people: orderedPeople
    });
    const ops = [];
    rows.forEach((row) => {
      ops.push({
        ref: ref.collection('rows').doc('r_' + digest(row.date + '|' + row.sub_station).slice(0, 40)),
        data: rowDocument(row), kind: 'set'
      });
    });
    orderedEvents.forEach((event) => {
      ops.push({
        ref: ref.collection('events').doc('e_' + digest(String(event.id)).slice(0, 40)),
        data: event, kind: 'set'
      });
    });
    orderedPeople.forEach((person) => {
      ops.push({
        ref: ref.collection('people').doc(person.id),
        data: person, kind: 'set'
      });
    });
    await commitWrites(ops);
    await ref.set(Object.assign({}, meta, {
      status: 'complete', row_count: rows.length, event_count: orderedEvents.length,
      person_count: peopleById.size,
      content_digest: contentDigest, completed_at: FV.serverTimestamp()
    }), { merge: true });
    return contentDigest;
  }

  async function readSnapshot(ref, meta, dates) {
    let rowsQuery = ref.collection('rows');
    let eventsQuery = ref.collection('events');
    if (Array.isArray(dates) && dates.length) {
      rowsQuery = rowsQuery.where('date', 'in', dates);
      eventsQuery = eventsQuery.where('date', 'in', dates);
    }
    const pair = await Promise.all([rowsQuery.get(), eventsQuery.get()]);
    const rows = pair[0].docs.map((doc) => (doc.data() || {}).row)
      .sort((a, b) => compareCanonical(a.date + '|' + a.sub_station, b.date + '|' + b.sub_station));
    const events = pair[1].docs.map((doc) => doc.data() || {})
      .sort((a, b) => compareCanonical(a.id, b.id));
    let peopleDocs;
    if (Array.isArray(dates) && dates.length) {
      const ids = new Set();
      rows.forEach((row) => (row.slots || []).forEach((slot) => ids.add(slot.person)));
      events.forEach((event) => (event.people || []).forEach((id) => ids.add(id)));
      const refs = Array.from(ids).sort().map((id) => ref.collection('people').doc(id));
      peopleDocs = refs.length ? await db.getAll.apply(db, refs) : [];
    } else {
      peopleDocs = (await ref.collection('people').get()).docs;
    }
    const roster = peopleDocs.filter((doc) => doc.exists).map((doc) => doc.data() || {});
    if (!dates && (rows.length !== meta.row_count || events.length !== meta.event_count)) {
      throw new ScheduleRuntimeError('snapshot-count-mismatch',
        'תמונת הסידור אינה שלמה ולכן נעצרה.');
    }
    if (!dates && roster.length !== Number(meta.person_count || 0)) {
      throw new ScheduleRuntimeError('snapshot-people-mismatch',
        'מילון השמות של תמונת הסידור אינו שלם.');
    }
    const plan = {
      kind: 'schedule-plan', station_id: meta.station_id,
      source_snapshot: meta.source_snapshot, source_version: meta.source_version,
      contract_station_id: meta.contract_station_id,
      source_revision: meta.source_revision, source_digest: meta.source_digest,
      policy_version: meta.policy_version, policy_digest: meta.policy_digest,
      source_complete: meta.source_complete === true,
      generated_at: meta.generated_at || null, from: meta.from, to: meta.to,
      rows, summary: meta.summary || { blocking_gaps: 0, days_below_minimum: 0, rejected_manual: 0 }
    };
    if (!dates) {
      const orderedPeople = roster.slice().sort((a, b) => compareCanonical(a.id, b.id));
      const actualDigest = digest({
        contract: {
          station_id: plan.station_id, source_snapshot: plan.source_snapshot,
          source_version: plan.source_version, source_revision: plan.source_revision,
          source_digest: plan.source_digest, policy_version: plan.policy_version,
          policy_digest: plan.policy_digest, source_complete: plan.source_complete
        }, rows, events, people: orderedPeople
      });
      if (!nonEmpty(meta.content_digest) || meta.content_digest !== actualDigest) {
        throw new ScheduleRuntimeError('snapshot-digest-mismatch',
          'תמונת הסידור השתנתה או אינה שלמה ולכן נעצרה.');
      }
    }
    return { plan, events, roster };
  }

  async function getStatus(req) {
    const ctx = await context(req);
    const config = await configuration(ctx.sid);
    const active = await activeRef(ctx.sid).get();
    const activeData = active.exists ? (active.data() || {}) : null;
    const activeView = activeData ? {
      publication_id: activeData.publication_id || null,
      revision: activeData.revision || 0
    } : null;
    if (activeView && ctx.manager) {
      activeView.previous_publication_id = activeData.previous_publication_id || null;
      activeView.can_rollback = nonEmpty(activeData.previous_publication_id);
      if (nonEmpty(activeView.publication_id)) {
        const delivery = await stationRef(ctx.sid).collection('schedule_publications')
          .doc(activeView.publication_id).collection('schedule_outbox')
          .where('status', 'in', ['retry', 'dead_letter']).limit(101).get();
        activeView.delivery_alerts = delivery.size;
        activeView.delivery_alerts_capped = delivery.size > 100;
      }
    }
    return {
      mode: config.mode,
      configured: Boolean(config.active_policy_id && config.active_source_id),
      manager: ctx.manager,
      active: activeView
    };
  }

  async function getManagerSetup(req) {
    const ctx = await context(req);
    requireManager(ctx);
    const config = await configuration(ctx.sid);
    if (!config.active_policy_id || !config.active_source_id) {
      return { mode: config.mode, configured: false, sub_stations: [], people: [] };
    }
    const policy = await loadPolicy(ctx, config.active_policy_id);
    const source = await loadSource(ctx, config.active_source_id);
    return {
      mode: config.mode,
      configured: true,
      policy: {
        id: policy.id,
        version: policy.value.version,
        digest: policy.digest,
        sub_stations: Object.keys(policy.value.sub_stations).sort().map((id) => ({
          id,
          label: policy.value.sub_stations[id].label,
          minimum: policy.value.sub_stations[id].minimum,
          requirements: policy.value.sub_stations[id].requirements
        }))
      },
      source: { id: source.id, version: source.version, revision: source.revision },
      people: source.peopleRaw.filter((person) => person.active === true).map((person) => ({
        id: person.id,
        name: String(person.full_name || person.name || person.id).slice(0, 120),
        sub_station: person.sub_station,
        roles: Array.isArray(person.roles) ? person.roles.slice() : []
      }))
    };
  }

  async function runPlanner(req) {
    const ctx = await context(req);
    requireManager(ctx);
    const config = await configuration(ctx.sid);
    requireMode(config, [MODE.SHADOW, MODE.NEW]);
    const data = plain(req.data) ? req.data : {};
    const requestId = requireId(data.request_id, 'request-id', 'מזהה הפעולה');
    const start = String(data.start || '');
    isoDayOffset(start, 0);
    if (start.slice(8, 10) !== '01') {
      throw new ScheduleRuntimeError('month-start-required',
        'תכנון חודשי חייב להתחיל ביום הראשון בחודש.', 'invalid-argument');
    }
    const months = Number(data.months);
    if (!integer(months) || months < 1 || months > 3) {
      throw new ScheduleRuntimeError('months-invalid', 'אפשר לתכנן חודש עד שלושה.', 'invalid-argument');
    }
    const policy = await loadPolicy(ctx, config.active_policy_id);
    const source = await loadSource(ctx, config.active_source_id);
    const overrides = normalizeOverrides(data.overrides, policy.value);
    const effective = effectiveSource(ctx, source, policy, overrides);
    const fingerprint = digest({ ctx: ctx.sid, uid: ctx.uid, requestId, start, months,
      source: effective.digest, policy: policy.digest, overrides });
    const draftId = 'd_' + hash(ctx.sid + '|' + ctx.uid + '|' + requestId).slice(0, 40);
    const ref = stationRef(ctx.sid).collection('schedule_drafts').doc(draftId);
    const existing = await ref.get();
    if (existing.exists) {
      const before = existing.data() || {};
      if (before.request_fingerprint !== fingerprint) {
        throw new ScheduleRuntimeError('request-conflict',
          'אותו מזהה פעולה כבר שימש לקלט אחר.', 'already-exists');
      }
      if (before.status !== 'complete') {
        throw new ScheduleRuntimeError('draft-staging', 'הטיוטה עדיין נבנית. נסה שוב בעוד רגע.', 'aborted');
      }
      return { duplicate: true, draft_id: draftId, summary: before.summary, from: before.from, to: before.to };
    }
    const engine = createEngine({ clock, policy: policy.value });
    const planSet = engine.planMonths({
      station_id: ctx.sid,
      source_snapshot: effective.snapshot,
      source_version: effective.version,
      contract_station_id: ctx.sid,
      source_revision: effective.revision,
      source_digest: effective.digest,
      policy_digest: policy.digest,
      source_complete: true,
      availability: effective.availability,
      locked: effective.locked,
      carry: effective.carry,
      roster: effective.roster,
      start,
      months
    });
    const plan = flattenPlanSet(planSet);
    await ref.create({
      station_id: ctx.sid, status: 'staging', request_id: requestId,
      request_fingerprint: fingerprint, source_id: source.id, policy_id: policy.id,
      base_source_digest: source.digest, base_policy_digest: policy.digest,
      created_by: ctx.uid, created_by_name: ctx.name, created_at: FV.serverTimestamp(),
      source_snapshot: plan.source_snapshot, source_version: plan.source_version,
      contract_station_id: plan.contract_station_id, source_revision: plan.source_revision,
      source_digest: plan.source_digest, source_complete: true,
      policy_version: plan.policy_version, policy_digest: plan.policy_digest,
      generated_at: plan.generated_at, from: plan.from, to: plan.to,
      summary: plan.summary, months
    });
    await stageSnapshot(ref, {}, plan, effective.events, effective.roster);
    return { duplicate: false, draft_id: draftId, summary: plan.summary, from: plan.from, to: plan.to };
  }

  async function getDraftPreview(req) {
    const ctx = await context(req);
    requireManager(ctx);
    const config = await configuration(ctx.sid);
    requireMode(config, [MODE.SHADOW, MODE.NEW]);
    const data = plain(req.data) ? req.data : {};
    const draftId = requireId(data.draft_id, 'draft-id', 'מזהה הטיוטה');
    const start = String(data.start || '');
    isoDayOffset(start, 0);
    const ref = stationRef(ctx.sid).collection('schedule_drafts').doc(draftId);
    const snap = await ref.get();
    const meta = snap.exists ? (snap.data() || {}) : {};
    if (!snap.exists || meta.status !== 'complete' || meta.station_id !== ctx.sid) {
      throw new ScheduleRuntimeError('draft-not-ready', 'הטיוטה אינה קיימת או טרם הושלמה.');
    }
    if (meta.source_id !== config.active_source_id || meta.policy_id !== config.active_policy_id) {
      throw new ScheduleRuntimeError('draft-stale', 'הטיוטה אינה מבוססת על המקור והמדיניות הפעילים.');
    }
    const current = await Promise.all([
      stationRef(ctx.sid).collection('schedule_policies').doc(meta.policy_id).get(),
      stationRef(ctx.sid).collection('schedule_sources').doc(meta.source_id).get()
    ]);
    const livePolicy = current[0].exists ? (current[0].data() || {}) : {};
    const liveSource = current[1].exists ? (current[1].data() || {}) : {};
    if (livePolicy.complete !== true || liveSource.complete !== true
        || livePolicy.content_digest !== meta.base_policy_digest
        || liveSource.content_digest !== meta.base_source_digest) {
      throw new ScheduleRuntimeError('draft-source-changed',
        'המדיניות או מקור הנתונים השתנו מאז בניית הטיוטה. יש לבנות טיוטה חדשה.', 'aborted');
    }
    if (start < meta.from || start > meta.to) {
      throw new ScheduleRuntimeError('preview-date-outside-draft',
        'תאריך התצוגה המקדימה נמצא מחוץ לטווח הטיוטה.', 'invalid-argument');
    }
    const dates = [];
    for (let index = 0; index < DRAFT_PREVIEW_DAYS; index += 1) {
      const date = isoDayOffset(start, index);
      if (date > meta.to) break;
      dates.push(date);
    }
    const snapshot = await readSnapshot(ref, meta, dates);
    const service = serviceFor(ctx);
    const days = dates.map((date) => service.buildStationSchedule({
      actor: actor(ctx), plan: snapshot.plan, events: snapshot.events,
      roster: snapshot.roster, date
    }).day);
    return {
      draft_id: draftId,
      expected_content_digest: meta.content_digest,
      from: meta.from,
      to: meta.to,
      week_start: start,
      days
    };
  }

  async function activeSnapshot(ctx, dates) {
    const pointer = await activeRef(ctx.sid).get();
    if (!pointer.exists || !nonEmpty((pointer.data() || {}).publication_id)) return null;
    const p = pointer.data() || {};
    const ref = stationRef(ctx.sid).collection('schedule_publications').doc(p.publication_id);
    const snap = await ref.get();
    if (!snap.exists || (snap.data() || {}).status !== 'active') {
      throw new ScheduleRuntimeError('active-publication-missing', 'הפרסום הפעיל אינו שלם.');
    }
    const meta = snap.data() || {};
    const value = await readSnapshot(ref, meta, dates);
    return { pointer: p, ref, meta, plan: value.plan, events: value.events, roster: value.roster };
  }

  async function publishedSnapshot(ctx, publicationId) {
    const id = requireId(publicationId, 'publication-id', 'מזהה הפרסום');
    const ref = stationRef(ctx.sid).collection('schedule_publications').doc(id);
    const snap = await ref.get();
    const meta = snap.exists ? (snap.data() || {}) : {};
    if (!snap.exists || meta.status !== 'active' || meta.station_id !== ctx.sid) {
      throw new ScheduleRuntimeError('rollback-target-missing',
        'גרסת היעד לחזרה אינה קיימת או אינה שלמה.');
    }
    const value = await readSnapshot(ref, meta);
    return { ref, meta, plan: value.plan, events: value.events, roster: value.roster };
  }

  async function queueOutbox(ref) {
    const snap = await ref.collection('schedule_outbox').where('status', '==', 'blocked').get();
    const ops = snap.docs.map((doc) => ({
      ref: doc.ref,
      data: { status: 'queued', queued_at: FV.serverTimestamp() },
      kind: 'update'
    }));
    await commitWrites(ops);
  }

  async function publish(req) {
    const ctx = await context(req);
    requireManager(ctx);
    const config = await configuration(ctx.sid);
    requireMode(config, [MODE.NEW]);
    const data = plain(req.data) ? req.data : {};
    const draftId = requireId(data.draft_id, 'draft-id', 'מזהה הטיוטה');
    const requestId = requireId(data.request_id, 'request-id', 'מזהה הפעולה');
    const expectedContentDigest = String(data.expected_content_digest || '');
    const draftRef = stationRef(ctx.sid).collection('schedule_drafts').doc(draftId);
    const draftSnap = await draftRef.get();
    if (!draftSnap.exists || (draftSnap.data() || {}).status !== 'complete') {
      throw new ScheduleRuntimeError('draft-not-ready', 'הטיוטה אינה קיימת או טרם הושלמה.');
    }
    const draftMeta = draftSnap.data() || {};
    if (!nonEmpty(expectedContentDigest) || expectedContentDigest !== draftMeta.content_digest) {
      throw new ScheduleRuntimeError('draft-preview-required',
        'יש לפתוח ולבדוק את התצוגה המקדימה העדכנית לפני הפרסום.', 'failed-precondition');
    }
    if (draftMeta.station_id !== ctx.sid || draftMeta.source_id !== config.active_source_id
        || draftMeta.policy_id !== config.active_policy_id) {
      throw new ScheduleRuntimeError('draft-stale', 'הטיוטה אינה מבוססת על המקור והמדיניות הפעילים.');
    }
    const currentPolicy = await loadPolicy(ctx, config.active_policy_id);
    const currentSource = await loadSource(ctx, config.active_source_id);
    if (draftMeta.base_policy_digest !== currentPolicy.digest
        || draftMeta.base_source_digest !== currentSource.digest) {
      throw new ScheduleRuntimeError('draft-source-changed',
        'המדיניות או מקור הנתונים השתנו מאז בניית הטיוטה. יש לבנות טיוטה חדשה.', 'aborted');
    }
    const next = await readSnapshot(draftRef, draftMeta);
    const before = await activeSnapshot(ctx);
    const previous = before ? before.plan : null;
    const previousEvents = before ? before.events : [];
    const revision = before ? Number(before.pointer.revision || 0) + 1 : 1;
    const pubId = 'p_' + hash(ctx.sid + '|' + ctx.uid + '|' + requestId).slice(0, 40);
    const pubRef = stationRef(ctx.sid).collection('schedule_publications').doc(pubId);
    const publication = createPublication({
      clock, hash,
      rules: { max_attempts: 3, retry_backoff_ms: [60000, 300000] }
    });
    const service = serviceFor(ctx, null, publication);
    const planned = service.publish({
      actor: actor(ctx),
      request: {
        next: next.plan,
        previous,
        next_events: next.events,
        previous_events: previousEvents,
        publication_id: pubId,
        publication_revision: revision,
        source_draft_id: draftId,
        previous_publication_id: before ? before.pointer.publication_id : null
      }
    });
    const expectedPrevious = before ? before.pointer.publication_id : null;
    const requestFingerprint = digest({
      station_id: ctx.sid, uid: ctx.uid, request_id: requestId,
      draft_id: draftId, revision,
      previous_publication_id: expectedPrevious,
      content_hash: planned.publication.content_hash
    });
    const existing = await pubRef.get();
    if (existing.exists) {
      const existingData = existing.data() || {};
      const active = await activeRef(ctx.sid).get();
      if (active.exists && (active.data() || {}).publication_id === pubId) {
        if (existingData.request_id !== requestId || existingData.source_draft_id !== draftId
            || existingData.published_by !== ctx.uid) {
          throw new ScheduleRuntimeError('publication-conflict',
            'מזהה הפרסום הפעיל אינו תואם לבקשה.', 'already-exists');
        }
        await queueOutbox(pubRef);
        return { duplicate: true, publication_id: pubId, revision: (active.data() || {}).revision };
      }
      if (existingData.request_fingerprint !== requestFingerprint) {
        throw new ScheduleRuntimeError('publication-conflict',
          'מזהה הפרסום כבר קיים עם תוכן אחר.', 'already-exists');
      }
    } else await pubRef.create({
      station_id: ctx.sid, status: 'staging', request_id: requestId,
      request_fingerprint: requestFingerprint,
      revision, source_id: draftMeta.source_id, policy_id: draftMeta.policy_id,
      source_draft_id: draftId,
      previous_publication_id: before ? before.pointer.publication_id : null,
      created_at: FV.serverTimestamp(),
      source_snapshot: next.plan.source_snapshot, source_version: next.plan.source_version,
      contract_station_id: next.plan.contract_station_id,
      source_revision: next.plan.source_revision, source_digest: next.plan.source_digest,
      source_complete: true, policy_version: next.plan.policy_version,
      policy_digest: next.plan.policy_digest, generated_at: next.plan.generated_at,
      from: next.plan.from, to: next.plan.to, summary: next.plan.summary,
      content_hash: planned.publication.content_hash,
      published_by: ctx.uid, published_by_name: ctx.name
    });
    await stageSnapshot(pubRef, {}, next.plan, next.events, next.roster);
    const outboxOps = planned.notifications.map((notification) => ({
      ref: pubRef.collection('schedule_outbox').doc('n_' + hash(notification.dedupe_key).slice(0, 40)),
      kind: 'set',
      data: {
        station_id: ctx.sid, publication_id: pubId, revision,
        person: notification.person, dedupe_key: notification.dedupe_key,
        push: notification.push, detail: notification.detail,
        changed_by: ctx.uid, attempt: 0, status: 'blocked',
        expires_at: new Date(Date.parse(clock()) + OUTBOX_TTL_MS),
        created_at: FV.serverTimestamp()
      }
    }));
    await commitWrites(outboxOps);
    await db.runTransaction(async (tx) => {
      const policyRef = stationRef(ctx.sid).collection('schedule_policies').doc(draftMeta.policy_id);
      const sourceRef = stationRef(ctx.sid).collection('schedule_sources').doc(draftMeta.source_id);
      const refs = [runtimeRef(ctx.sid), activeRef(ctx.sid), draftRef, pubRef, policyRef, sourceRef];
      const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
      const liveConfig = snaps[0].exists ? (snaps[0].data() || {}) : {};
      const liveActive = snaps[1].exists ? (snaps[1].data() || {}) : {};
      const liveDraft = snaps[2].exists ? (snaps[2].data() || {}) : {};
      const livePub = snaps[3].exists ? (snaps[3].data() || {}) : {};
      const livePolicy = snaps[4].exists ? (snaps[4].data() || {}) : {};
      const liveSource = snaps[5].exists ? (snaps[5].data() || {}) : {};
      if (liveConfig.mode !== MODE.NEW || liveConfig.active_source_id !== draftMeta.source_id
          || liveConfig.active_policy_id !== draftMeta.policy_id) {
        throw new ScheduleRuntimeError('publish-config-changed', 'הגדרות הסידור השתנו בזמן הפרסום.', 'aborted');
      }
      const actualPrevious = nonEmpty(liveActive.publication_id) ? liveActive.publication_id : null;
      if (actualPrevious !== expectedPrevious || Number(liveActive.revision || 0) !== revision - 1) {
        throw new ScheduleRuntimeError('publish-race', 'פורסם סידור אחר במקביל. יש לרענן.', 'aborted');
      }
      if (liveDraft.status !== 'complete' || livePub.status !== 'complete'
          || liveDraft.content_digest !== expectedContentDigest
          || livePub.content_digest !== expectedContentDigest
          || livePub.content_digest !== draftMeta.content_digest) {
        throw new ScheduleRuntimeError('publish-snapshot-changed', 'הטיוטה או הפרסום אינם שלמים.', 'aborted');
      }
      if (livePolicy.complete !== true || liveSource.complete !== true
          || livePolicy.content_digest !== draftMeta.base_policy_digest
          || liveSource.content_digest !== draftMeta.base_source_digest) {
        throw new ScheduleRuntimeError('publish-source-changed',
          'המדיניות או מקור הנתונים השתנו בזמן הפרסום.', 'aborted');
      }
      tx.update(pubRef, { status: 'active', activated_at: FV.serverTimestamp() });
      tx.set(activeRef(ctx.sid), {
        publication_id: pubId, revision, previous_publication_id: expectedPrevious,
        content_digest: livePub.content_digest, activated_at: FV.serverTimestamp(),
        activated_by: ctx.uid
      });
      tx.create(stationRef(ctx.sid).collection('schedule_audit').doc('a_' + randomId()), {
        action: 'publish', publication_id: pubId, revision,
        previous_publication_id: expectedPrevious, by: ctx.uid,
        at: FV.serverTimestamp()
      });
    });
    await queueOutbox(pubRef);
    return {
      duplicate: false,
      publication_id: pubId,
      revision,
      notified_people: planned.notifications.length,
      summary: next.plan.summary
    };
  }

  async function rollback(req) {
    const ctx = await context(req);
    requireManager(ctx);
    const config = await configuration(ctx.sid);
    requireMode(config, [MODE.NEW]);
    const data = plain(req.data) ? req.data : {};
    const requestId = requireId(data.request_id, 'request-id', 'מזהה הפעולה');
    const expectedActive = requireId(data.expected_active_publication_id,
      'active-publication-id', 'מזהה הפרסום הפעיל');
    const targetId = requireId(data.target_publication_id,
      'target-publication-id', 'מזהה גרסת היעד');
    const reasonCode = String(data.reason_code || '');
    if (ROLLBACK_REASONS.indexOf(reasonCode) === -1) {
      throw new ScheduleRuntimeError('rollback-reason-invalid',
        'יש לבחור סיבה תקינה לחזרה.', 'invalid-argument');
    }

    const pubId = 'p_rb_' + hash(ctx.sid + '|' + ctx.uid + '|' + requestId).slice(0, 40);
    const pubRef = stationRef(ctx.sid).collection('schedule_publications').doc(pubId);
    const firstPair = await Promise.all([pubRef.get(), activeRef(ctx.sid).get()]);
    const firstPub = firstPair[0].exists ? (firstPair[0].data() || {}) : {};
    const firstActive = firstPair[1].exists ? (firstPair[1].data() || {}) : {};
    if (firstPair[0].exists && firstActive.publication_id === pubId
        && firstPub.request_id === requestId && firstPub.published_by === ctx.uid
        && firstPub.rollback_from_publication_id === expectedActive
        && firstPub.rollback_target_publication_id === targetId
        && firstPub.rollback_reason_code === reasonCode) {
      await queueOutbox(pubRef);
      return { duplicate: true, publication_id: pubId, revision: firstActive.revision };
    }

    const current = await activeSnapshot(ctx);
    if (!current || current.pointer.publication_id !== expectedActive) {
      throw new ScheduleRuntimeError('rollback-race',
        'הסידור הפעיל השתנה. יש לרענן לפני החזרה.', 'aborted');
    }
    if (current.pointer.previous_publication_id !== targetId) {
      throw new ScheduleRuntimeError('rollback-target-forbidden',
        'אפשר לחזור רק לגרסה הקודמת המיידית.', 'failed-precondition');
    }
    const target = await publishedSnapshot(ctx, targetId);
    const revision = Number(current.pointer.revision || 0) + 1;
    const publication = createPublication({
      clock, hash, rules: { max_attempts: 3, retry_backoff_ms: [60000, 300000] }
    });
    const service = serviceFor(ctx, null, publication);
    const planned = service.publish({
      actor: actor(ctx),
      request: {
        next: target.plan,
        previous: current.plan,
        next_events: target.events,
        previous_events: current.events,
        publication_id: pubId,
        publication_revision: revision,
        source_draft_id: 'rollback_' + targetId,
        previous_publication_id: expectedActive
      }
    });
    const requestFingerprint = digest({
      station_id: ctx.sid, uid: ctx.uid, request_id: requestId,
      expected_active_publication_id: expectedActive,
      target_publication_id: targetId,
      target_content_digest: target.meta.content_digest,
      next_revision: revision, reason_code: reasonCode
    });
    const existing = await pubRef.get();
    if (existing.exists) {
      const existingData = existing.data() || {};
      const active = await activeRef(ctx.sid).get();
      if (active.exists && (active.data() || {}).publication_id === pubId
          && existingData.request_fingerprint === requestFingerprint) {
        await queueOutbox(pubRef);
        return { duplicate: true, publication_id: pubId, revision: (active.data() || {}).revision };
      }
      if (existingData.request_fingerprint !== requestFingerprint) {
        throw new ScheduleRuntimeError('rollback-conflict',
          'מזהה החזרה כבר שימש לפעולה אחרת.', 'already-exists');
      }
    } else {
      await pubRef.create({
        station_id: ctx.sid, status: 'staging', operation: 'rollback',
        request_id: requestId, request_fingerprint: requestFingerprint,
        revision, source_id: target.meta.source_id || null,
        policy_id: target.meta.policy_id || null,
        source_draft_id: 'rollback_' + targetId,
        previous_publication_id: expectedActive,
        rollback_from_publication_id: expectedActive,
        rollback_target_publication_id: targetId,
        rollback_reason_code: reasonCode,
        created_at: FV.serverTimestamp(),
        source_snapshot: target.plan.source_snapshot,
        source_version: target.plan.source_version,
        contract_station_id: target.plan.contract_station_id,
        source_revision: target.plan.source_revision,
        source_digest: target.plan.source_digest,
        source_complete: true,
        policy_version: target.plan.policy_version,
        policy_digest: target.plan.policy_digest,
        generated_at: target.plan.generated_at,
        from: target.plan.from, to: target.plan.to,
        summary: target.plan.summary,
        content_hash: planned.publication.content_hash,
        published_by: ctx.uid, published_by_name: ctx.name
      });
    }
    await stageSnapshot(pubRef, {}, target.plan, target.events, target.roster);
    const outboxOps = planned.notifications.map((notification) => ({
      ref: pubRef.collection('schedule_outbox').doc('n_' + hash(notification.dedupe_key).slice(0, 40)),
      kind: 'set',
      data: {
        station_id: ctx.sid, publication_id: pubId, revision,
        person: notification.person, dedupe_key: notification.dedupe_key,
        push: notification.push, detail: notification.detail,
        changed_by: ctx.uid, attempt: 0, status: 'blocked',
        expires_at: new Date(Date.parse(clock()) + OUTBOX_TTL_MS),
        created_at: FV.serverTimestamp()
      }
    }));
    await commitWrites(outboxOps);
    await db.runTransaction(async (tx) => {
      const refs = [runtimeRef(ctx.sid), activeRef(ctx.sid),
        current.ref, target.ref, pubRef];
      const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
      const liveConfig = snaps[0].exists ? (snaps[0].data() || {}) : {};
      const liveActive = snaps[1].exists ? (snaps[1].data() || {}) : {};
      const liveCurrent = snaps[2].exists ? (snaps[2].data() || {}) : {};
      const liveTarget = snaps[3].exists ? (snaps[3].data() || {}) : {};
      const livePub = snaps[4].exists ? (snaps[4].data() || {}) : {};
      if (liveConfig.mode !== MODE.NEW) {
        throw new ScheduleRuntimeError('rollback-mode-changed',
          'מצב המנוע השתנה בזמן החזרה.', 'aborted');
      }
      if (liveActive.publication_id !== expectedActive
          || Number(liveActive.revision || 0) !== revision - 1
          || liveActive.previous_publication_id !== targetId) {
        throw new ScheduleRuntimeError('rollback-race',
          'הסידור הפעיל השתנה בזמן החזרה.', 'aborted');
      }
      if (liveCurrent.status !== 'active' || liveTarget.status !== 'active'
          || liveTarget.content_digest !== target.meta.content_digest
          || livePub.status !== 'complete') {
        throw new ScheduleRuntimeError('rollback-snapshot-changed',
          'אחת מתמונות הסידור השתנתה בזמן החזרה.', 'aborted');
      }
      tx.update(pubRef, { status: 'active', activated_at: FV.serverTimestamp() });
      tx.set(activeRef(ctx.sid), {
        publication_id: pubId, revision,
        previous_publication_id: expectedActive,
        rollback_target_publication_id: targetId,
        content_digest: livePub.content_digest,
        activated_at: FV.serverTimestamp(), activated_by: ctx.uid
      });
      tx.create(stationRef(ctx.sid).collection('schedule_audit').doc('a_' + randomId()), {
        action: 'rollback', publication_id: pubId, revision,
        from_publication_id: expectedActive,
        target_publication_id: targetId,
        reason_code: reasonCode, by: ctx.uid, at: FV.serverTimestamp()
      });
    });
    await queueOutbox(pubRef);
    return {
      duplicate: false, publication_id: pubId, revision,
      rolled_back_to: targetId, notified_people: planned.notifications.length
    };
  }

  async function getMy(req) {
    const ctx = await context(req);
    const config = await configuration(ctx.sid);
    if (config.mode === MODE.OFF) return { mode: MODE.OFF, active: false, days: [] };
    const data = plain(req.data) ? req.data : {};
    const date = String(data.date || '');
    isoDayOffset(date, 0);
    const active = await activeSnapshot(ctx, [date]);
    if (!active) return { mode: config.mode, active: false, days: [] };
    const responseSnap = await stationRef(ctx.sid).collection('schedule_responses')
      .where('publication_id', '==', active.pointer.publication_id)
      .where('person', '==', ctx.uid).get();
    const answers = {};
    responseSnap.docs.forEach((doc) => {
      const value = doc.data() || {};
      if (value.person === ctx.uid && nonEmpty(value.item_id)) {
        answers[value.item_id] = { status: value.answer === 'confirm' ? 'confirmed' : 'declined' };
      }
    });
    const changeSnap = await active.ref.collection('schedule_outbox')
      .where('person', '==', ctx.uid).get();
    const changes = {};
    changeSnap.docs.forEach((doc) => {
      const value = doc.data() || {};
      (Array.isArray(value.detail) ? value.detail : []).forEach((change) => {
        if (!plain(change)) return;
        const itemId = nonEmpty(change.item_id) ? change.item_id : change.date;
        if (nonEmpty(itemId)) changes[itemId] = change;
      });
    });
    const view = serviceFor(ctx).buildMySchedule({
      actor: actor(ctx), plan: active.plan, events: active.events, roster: active.roster,
      changes_by_date: changes,
      answers_by_date: answers
    });
    return Object.assign({ mode: config.mode, active: true,
      publication_id: active.pointer.publication_id, revision: active.pointer.revision }, view);
  }

  async function getStation(req) {
    const ctx = await context(req);
    const config = await configuration(ctx.sid);
    const data = plain(req.data) ? req.data : {};
    const date = String(data.date || clock().slice(0, 10));
    const dates = [isoDayOffset(date, -1), date, isoDayOffset(date, 1)];
    if (config.mode === MODE.OFF) return { mode: MODE.OFF, active: false };
    const active = await activeSnapshot(ctx, dates);
    if (!active) return { mode: config.mode, active: false };
    const view = serviceFor(ctx).buildStationSchedule({
      actor: actor(ctx), plan: active.plan, events: active.events, roster: active.roster, date
    });
    return Object.assign({ mode: config.mode, active: true,
      publication_id: active.pointer.publication_id, revision: active.pointer.revision }, view);
  }

  async function respond(req) {
    const ctx = await context(req);
    const config = await configuration(ctx.sid);
    if (config.mode === MODE.OFF) {
      throw new ScheduleRuntimeError('schedule-mode-blocked', 'הסידור החדש כבוי.');
    }
    const data = plain(req.data) ? req.data : {};
    const requestId = requireId(data.request_id, 'request-id', 'מזהה הפעולה');
    const publicationId = requireId(data.publication_id, 'publication-id', 'מזהה הפרסום');
    const itemId = String(data.item_id || '');
    const isDateItem = DATE_RE.test(itemId);
    if (isDateItem) isoDayOffset(itemId, 0);
    else requireId(itemId, 'item-id', 'מזהה השיבוץ');
    const answer = String(data.answer || '');
    const responseId = 'r_' + hash(ctx.sid + '|' + ctx.uid + '|' + requestId).slice(0, 40);
    const ref = stationRef(ctx.sid).collection('schedule_responses').doc(responseId);
    return db.runTransaction(async (tx) => {
      const pointerSnap = await tx.get(activeRef(ctx.sid));
      const pointer = pointerSnap.exists ? (pointerSnap.data() || {}) : {};
      if (pointer.publication_id !== publicationId) {
        throw new ScheduleRuntimeError('publication-not-active', 'התגובה אינה לפרסום הפעיל.', 'aborted');
      }
      const pubRef = stationRef(ctx.sid).collection('schedule_publications').doc(publicationId);
      const assigned = [];
      if (isDateItem) {
        const rowSnap = await tx.get(pubRef.collection('rows').where('date', '==', itemId));
        rowSnap.docs.forEach((doc) => {
          const row = (doc.data() || {}).row || {};
          (row.slots || []).forEach((slot) => assigned.push({ id: itemId, person: slot.person }));
        });
      } else {
        const eventSnap = await tx.get(pubRef.collection('events').where('id', '==', itemId));
        eventSnap.docs.forEach((doc) => {
          const event = doc.data() || {};
          (event.people || []).forEach((person) => assigned.push({ id: itemId, person }));
        });
      }
      const existing = await tx.get(ref);
      const fingerprint = digest({ publicationId, itemId, answer, reason: data.reason_code || null });
      if (existing.exists) {
        const before = existing.data() || {};
        if (before.request_fingerprint !== fingerprint) {
          throw new ScheduleRuntimeError('response-conflict', 'אותו מזהה תגובה כבר שימש לתוכן אחר.', 'already-exists');
        }
        return { duplicate: true, response_id: responseId, answer: before.answer };
      }
      const result = serviceFor(ctx).respond({
        actor: actor(ctx), answer, reason_code: data.reason_code,
        request: {
          person: ctx.uid, request_id: requestId, publication_id: publicationId,
          publication_revision: Number(pointer.revision), item_id: itemId
        },
        active_publication: {
          id: publicationId, revision: Number(pointer.revision), station_id: ctx.sid,
          assigned_items: assigned
        }
      });
      tx.create(ref, {
        station_id: ctx.sid, publication_id: publicationId,
        publication_revision: Number(pointer.revision), person: ctx.uid,
        item_id: itemId, answer: result.answer, reason_code: result.reason_code || null,
        request_id: requestId, request_fingerprint: fingerprint,
        created_at: FV.serverTimestamp()
      });
      return { duplicate: false, response_id: responseId, answer: result.answer };
    });
  }

  /**
   * מחזיר סיבת ביטול יציבה אם הנמען כבר אינו חבר תחנה פעיל,
   * או null אם מותר לשלוח לו.
   *
   * שלוש הסיבות נפרדות בכוונה ולא מאוחדות לאחת: „לא נמצא"
   * ו„הושבת" ו„עבר תחנה" הם שלושה מצבים שונים, ומי שיקרא את
   * המסמך אחר כך צריך לדעת מה קרה. הסיבות הן קבועות ואינן
   * מכילות שם, מזהה או כל פרט מזהה אחר.
   *
   * אותם כללים בדיוק שאוכף context() בכיוון הקריאה, כדי ששני
   * הכיוונים לא ייפרדו.
   */
  function recipientCancelReason(memberSnap, stationId) {
    if (!memberSnap || !memberSnap.exists) return 'recipient-not-member';
    const user = memberSnap.data() || {};

    // אותה בדיקה בדיוק כמו ב-context(), שורה מול שורה. שתי
    // הגרסאות חייבות להישאר זהות: אם הכיוון היוצא יהיה מקל
    // יותר מהנכנס, נוצר חור; אם יהיה מחמיר יותר, אנשים
    // לגיטימיים יפסיקו לקבל התראות.
    const liveActive = user.is_active !== false && user.active !== false;
    if (!liveActive) return 'recipient-inactive';

    const liveStation = String(user.stationId || user.station_id || '');
    const conflictingStationFields = nonEmpty(user.stationId) && nonEmpty(user.station_id)
      && user.stationId !== user.station_id;
    if (conflictingStationFields || liveStation !== stationId) {
      return 'recipient-station-mismatch';
    }
    return null;
  }

  async function deliverOutbox(ref) {
    if (!ref || typeof ref.get !== 'function') return { skipped: true };
    let claimed = null;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const data = snap.data() || {};
      if (data.status !== 'queued') return;
      const runtime = await tx.get(runtimeRef(data.station_id));
      const runtimeData = runtime.exists ? (runtime.data() || {}) : {};
      if (runtimeData.mode !== MODE.NEW) {
        tx.update(ref, {
          status: 'cancelled', cancel_reason: 'runtime-not-new',
          cancelled_at: FV.serverTimestamp(), lease_token: null, lease_until: null
        });
        return;
      }
      const pointer = await tx.get(activeRef(data.station_id));
      if (!pointer.exists || (pointer.data() || {}).publication_id !== data.publication_id) {
        tx.update(ref, { status: 'cancelled', cancelled_at: FV.serverTimestamp() });
        return;
      }
      // בדיקת חברות חיה ברגע השליחה, לא ברגע הפרסום.
      //
      // ההודעה נבנית כשמפרסמים סידור, והיא יוצאת מאוחר יותר.
      // בין שני הרגעים אדם יכול לעזוב את התחנה, לעבור לתחנה
      // אחרת או להיות מושבת. עד עכשיו המסלול הזה בדק רק שני
      // דברים — שמצב הריצה הוא new ושמצביע הפרסום תואם —
      // ולכן מי שעזב עדיין קיבל התראה, כל עוד נשאר לו מסמך
      // טוקן פוש. pushToOne קורא את push_tokens/{uid} ואינו
      // מצליב מול users/{uid}.
      //
      // מסלול **הקריאה** כבר אוכף חברות חיה ב-context(), ולכן
      // הפער היה בכיוון היוצא בלבד. כאן הוא נסגר, באותם כללים
      // בדיוק: מסמך קיים · פעיל · ומשויך לאותה תחנה.
      //
      // הקריאה נעשית לפני כל כתיבה בעסקה, כי Firestore אוסר
      // קריאה אחרי כתיבה באותה עסקה.
      //
      // הביטול סופי ואידמפוטנטי: המסמך עובר ל-cancelled עם
      // סיבה יציבה ואינו חוזר לתור. ניסיון חוזר אינו הדרך
      // לטפל באדם שעזב — הוא לא יחזור להיות חבר בגלל שנחכה.
      const memberSnap = await tx.get(
        stationRef(data.station_id).collection('users').doc(String(data.person || ''))
      );
      const memberCancel = recipientCancelReason(memberSnap, data.station_id);
      if (memberCancel) {
        tx.update(ref, {
          status: 'cancelled', cancel_reason: memberCancel,
          cancelled_at: FV.serverTimestamp(), lease_token: null, lease_until: null
        });
        return;
      }

      const leaseToken = 'l_' + randomId();
      tx.update(ref, {
        status: 'sending', claimed_at: FV.serverTimestamp(), lease_token: leaseToken,
        lease_until: new Date(Date.parse(clock()) + OUTBOX_LEASE_MS)
      });
      claimed = Object.assign({}, data, { lease_token: leaseToken });
    });
    if (!claimed) return { skipped: true };
    try {
      const push = claimed.push || {};
      const delivery = await sendPush(claimed.station_id, claimed.person, 'schedule_mine',
        push.title || 'ResQ · הסידור שלך', push.body || 'הסידור שלך עודכן',
        './schedule-management.html?tab=mine', true);
      if (!delivery || Number(delivery.sent || 0) < 1) {
        const error = new Error('NO_ACTIVE_PUSH_TOKEN');
        error.code = 'NO_ACTIVE_PUSH_TOKEN';
        throw error;
      }
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const live = snap.exists ? (snap.data() || {}) : {};
        if (live.status === 'sending' && live.lease_token === claimed.lease_token) {
          tx.update(ref, {
            status: 'sent', sent_at: FV.serverTimestamp(), last_error: null,
            delivered_devices: Number(delivery.sent),
            lease_token: null, lease_until: null
          });
        }
      });
      return { sent: true };
    } catch (error) {
      const publication = createPublication({
        clock, hash, rules: { max_attempts: 3, retry_backoff_ms: [60000, 300000] }
      });
      const retry = publication.planRetry({
        notification: Object.assign({}, claimed, { attempt: Number(claimed.attempt || 0) }),
        error_code: String((error && error.code) || 'SEND_FAILED')
      });
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const live = snap.exists ? (snap.data() || {}) : {};
        if (live.status !== 'sending' || live.lease_token !== claimed.lease_token) return;
        tx.update(ref, {
          status: retry.status,
          attempt: retry.attempt,
          next_attempt_at: retry.next_attempt_at || null,
          last_error: retry.last_error,
          lease_token: null, lease_until: null,
          updated_at: FV.serverTimestamp()
        });
      });
      return { sent: false, status: retry.status };
    }
  }

  async function resumeOutbox() {
    const snap = await db.collectionGroup('schedule_outbox')
      .where('status', 'in', ['blocked', 'retry', 'sending', 'queued']).limit(100).get();
    let queued = 0;
    const now = Date.parse(clock());
    const modeByStation = new Map();
    for (const doc of snap.docs) {
      const value = doc.data() || {};
      if (!ID_RE.test(String(value.station_id || '')) || !ID_RE.test(String(value.publication_id || ''))) continue;
      if (value.status === 'sending') {
        const until = value.lease_until && typeof value.lease_until.toMillis === 'function'
          ? value.lease_until.toMillis() : Date.parse(value.lease_until || '');
        if (Number.isFinite(until) && until > now) continue;
      }
      if (value.status === 'retry' && nonEmpty(value.next_attempt_at)
          && Date.parse(value.next_attempt_at) > now) continue;
      if (!modeByStation.has(value.station_id)) {
        const runtime = await runtimeRef(value.station_id).get();
        const runtimeData = runtime.exists ? (runtime.data() || {}) : {};
        modeByStation.set(value.station_id, runtimeData.mode === MODE.NEW ? MODE.NEW : MODE.OFF);
      }
      if (modeByStation.get(value.station_id) !== MODE.NEW) {
        await doc.ref.update({
          status: 'cancelled', cancel_reason: 'runtime-not-new',
          cancelled_at: FV.serverTimestamp(), lease_token: null, lease_until: null
        });
        continue;
      }
      const pointer = await activeRef(value.station_id).get();
      if (pointer.exists && (pointer.data() || {}).publication_id === value.publication_id) {
        if (value.status === 'queued') await deliverOutbox(doc.ref);
        else await doc.ref.update({
          status: 'queued', queued_at: FV.serverTimestamp(), lease_token: null, lease_until: null
        });
        queued += 1;
      } else {
        await doc.ref.update({ status: 'cancelled', cancelled_at: FV.serverTimestamp() });
      }
    }
    return { scanned: snap.size, queued };
  }

  return Object.freeze({
    getStatus,
    getManagerSetup,
    runPlanner,
    getDraftPreview,
    publish,
    rollback,
    getMy,
    getStation,
    respond,
    deliverOutbox,
    resumeOutbox,
    MODE
  });
}

module.exports = {
  createScheduleRuntime,
  ScheduleRuntimeError,
  MODE,
  MANAGER_ROLES,
  MEMBER_ROLES
};
