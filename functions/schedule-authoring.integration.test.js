'use strict';

/* ====================================================================
 *  schedule-authoring.integration.test · 42G · seq329
 *
 *  ----------------------------------------------------------------
 *  למה הקובץ הזה קיים
 *  ----------------------------------------------------------------
 *
 *  Codex אימת ב-grep שאף בדיקה קיימת אינה מפעילה את נתיבי הכתיבה
 *  החדשים מול Firestore. ה-probes משתמשים ב-double בלבד. זה חור
 *  קבלה אמיתי: כל מה שהוכח עד כה הוא שההכרעות **הטהורות** נכונות.
 *
 *  ⭐ מה שאינו מוכח בלי אמולטור: הכתיבה המדורגת, הטרנזקציה הסוגרת,
 *  התנגשות בין שתי בקשות, replay, ושחרור ה-outbox. אלה בדיוק
 *  המקומות שבהם מסמך נשמר חצי ונקרא כשלם.
 *
 *  ----------------------------------------------------------------
 *  ⚠ הקובץ הזה **לא הורץ** על ידי מי שכתב אותו
 *  ----------------------------------------------------------------
 *
 *  אין לי אמולטור. `firebase emulators:exec` נכשל כאן בהורדת
 *  `cloud-firestore-emulator-*.jar`: ה-proxy הארגוני מחזיר 403 על
 *  `storage.googleapis.com`. התקנתי firebase-tools 15.29.0 ו-JDK 21
 *  קיים — החסם הוא הרשת בלבד.
 *
 *  לכן: הקובץ נבדק תחבירית (`node --check`) ונכתב מול חתימות
 *  ה-API האמיתיות, אבל **לא רץ מעולם**. אני לא מציג אותו כירוק, וייתכן
 *  שיידרשו תיקונים בהרצה הראשונה. זה לא „כנראה עובד" — זה „לא נבדק".
 *
 *  הרצה:
 *    firebase emulators:exec --only firestore --project demo-resq \
 *      "cd functions && node schedule-authoring.integration.test.js"
 * ==================================================================== */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is required; refusing to use a real project.');
  process.exit(2);
}

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-resq' });
const db = admin.firestore();
const { createCalendarEngine } = require('./schedule-calendar-engine');
const { createPublication } = require('./schedule-publication');
const { createScheduleService } = require('./schedule-service');
const { createScheduleRuntime } = require('./schedule-runtime');
const { REASON: CUTOVER_REASON } = require('./schedule-cutover');

const SID = 'schedule_authoring_it';
const CLOCK = () => '2026-09-01T06:00:00.000Z';
const hash = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const randomId = () => crypto.randomBytes(12).toString('hex');

function station() { return db.collection('stations').doc(SID); }
function runtimeDoc() { return station().collection('schedule_state').doc('runtime'); }

function runtime(testHooks) {
  const hooks = testHooks || {};
  return createScheduleRuntime({
    db: hooks.db || db,
    FieldValue: admin.firestore.FieldValue,
    FieldPath: admin.firestore.FieldPath,
    clock: typeof hooks.clock === 'function' ? hooks.clock : CLOCK,
    hash,
    randomId,
    createEngine: createCalendarEngine,
    createPublication,
    createService: hooks.createService || createScheduleService,
    isSuper: typeof hooks.isSuper === 'function' ? hooks.isSuper : () => false,
    sendPush: hooks.sendPush || (async () => ({ sent: 1 })),
    beforeSnapshotFinalize: hooks.beforeSnapshotFinalize,
    sourceWriteChunkSize: hooks.sourceWriteChunkSize,
    afterSourceWriteChunk: hooks.afterSourceWriteChunk,
    sourceSweepCandidateLimit: hooks.sourceSweepCandidateLimit,
    sourceSweepChildLimit: hooks.sourceSweepChildLimit,
    sourceSweepChunkSize: hooks.sourceSweepChunkSize,
    afterSourceSweepClaim: hooks.afterSourceSweepClaim,
    afterSourceSweepChunk: hooks.afterSourceSweepChunk,
    reportError: hooks.reportError
  });
}

/* ⭐ התחנה **לעולם** אינה מגיעה מהלקוח. ה-token נושא אותה, וזה
 * המקום היחיד. בדיקה שמעבירה station ב-data נועדה להיכשל. */
function req(uid, role, data, extraToken) {
  return {
    auth: { uid, token: Object.assign({ stationId: SID, role, name: uid }, extraToken || {}) },
    data: data || {}
  };
}

async function caught(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

function stableValue(value) {
  if (Array.isArray(value)) return '[' + value.map(stableValue).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ':' + stableValue(value[key])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

async function resignSource(ref) {
  const meta = (await ref.get()).data() || {};
  const groups = await Promise.all(['people', 'availability', 'locked', 'events']
    .map((name) => ref.collection(name).get()));
  const sorted = groups.map((snapshot) => snapshot.docs.slice()
    .sort((left, right) => left.id < right.id ? -1 : (left.id > right.id ? 1 : 0)));
  const people = sorted[0].map((doc) => Object.assign({ id: doc.id }, doc.data() || {}));
  const availability = {};
  sorted[1].forEach((doc) => { availability[doc.id] = (doc.data() || {}).days || {}; });
  const locked = {};
  sorted[2].forEach((doc) => { locked[doc.id] = (doc.data() || {}).days || {}; });
  const events = sorted[3].map((doc) => Object.assign({ id: doc.id }, doc.data() || {}));
  const counts = {
    people: people.length, availability: sorted[1].length,
    locked: sorted[2].length, events: events.length
  };
  const basis = {
    station_id: meta.station_id, version: meta.version, revision: meta.revision,
    carry: meta.carry || {}, counts, people, availability, locked, events
  };
  await ref.set({
    person_count: counts.people,
    availability_count: counts.availability,
    locked_count: counts.locked,
    event_count: counts.events,
    content_digest: hash(stableValue(basis))
  }, { merge: true });
  return basis;
}

const SOURCE_GROUPS = Object.freeze(['people', 'availability', 'locked', 'events']);

async function sourceTree(ref) {
  const parent = await ref.get();
  assert.equal(parent.exists, true, 'מקור הבסיס לבדיקה אינו קיים: ' + ref.path);
  const groups = {};
  for (const name of SOURCE_GROUPS) {
    const snapshot = await ref.collection(name).get();
    groups[name] = snapshot.docs.slice()
      .sort((left, right) => left.id < right.id ? -1 : (left.id > right.id ? 1 : 0))
      .map((doc) => ({ id: doc.id, data: doc.data() || {} }));
  }
  return { meta: parent.data() || {}, groups };
}

async function writeSourceTree(ref, tree, metaPatch) {
  const batch = db.batch();
  batch.set(ref, Object.assign({}, tree.meta, metaPatch || {}));
  for (const name of SOURCE_GROUPS) {
    for (const item of tree.groups[name]) {
      batch.set(ref.collection(name).doc(item.id), item.data);
    }
  }
  await batch.commit();
}

async function deleteSourceTree(ref) {
  const groups = await Promise.all(SOURCE_GROUPS.map((name) => ref.collection(name).get()));
  const batch = db.batch();
  groups.forEach((snapshot) => snapshot.docs.forEach((doc) => batch.delete(doc.ref)));
  batch.delete(ref);
  await batch.commit();
}

async function collectionIds(ref) {
  return (await ref.get()).docs.map((doc) => doc.id).sort();
}

async function collectionState(ref) {
  const snapshot = await ref.get();
  return snapshot.docs.slice()
    .sort((left, right) => left.id < right.id ? -1 : (left.id > right.id ? 1 : 0))
    .map((doc) => ({ id: doc.id, data: doc.data() || {} }));
}

function sourceAuditRef(requestId) {
  return station().collection('schedule_source_audit')
    .doc('sa_' + hash('source-audit|' + SID + '|' + requestId).slice(0, 48));
}

function sourceOperationRef(requestId) {
  return station().collection('schedule_source_operations').doc(requestId);
}

async function cleanupSourceRequest(requestId) {
  await Promise.all([
    sourceOperationRef(requestId).delete(),
    sourceAuditRef(requestId).delete()
  ]);
}

async function writeExpiredStage(sourceIdValue, requestId, groups, patch) {
  const ref = station().collection('schedule_sources').doc(sourceIdValue);
  const meta = Object.assign({
    station_id: SID,
    complete: false,
    staged_by_request: requestId,
    staged_request_hash: hash('sweep|' + requestId),
    staged_owner_token: 'writer_' + requestId,
    expires_at: new Date(Date.parse(CLOCK()) - 60000)
  }, patch || {});
  const batch = db.batch();
  batch.set(ref, meta);
  const sourceGroups = groups || {};
  for (const name of SOURCE_GROUPS) {
    (sourceGroups[name] || []).forEach((id) => {
      const value = { marker: name };
      // The sweeper never reads child payloads; this value proves a
      // PII-bearing document is actually removed rather than ignored.
      if (name === 'people') value.full_name = 'שם פרטי לבדיקה';
      batch.set(ref.collection(name).doc(id), value);
    });
  }
  await batch.commit();
  return ref;
}

function changedSourceRows() {
  const rows = sourceRows().map((row) => Object.assign({}, row, { roles: row.roles.slice() }));
  // תוכן שונה משני המקורות שכבר נכתבו בקובץ, כדי שמקור מדורג לא
  // ידרוס fixture קיים גם אם המימוש הפגום חוזר ל-revision 1.
  rows[5].roles = ['firefighter'];
  return rows;
}

function unchangedSourceRows() {
  const rows = sourceRows().map((row) => Object.assign({}, row, { roles: row.roles.slice() }));
  // זהו הסגל שהפך לפעיל בבדיקת carry שמעל: אותו content_key בדיוק.
  rows[0].active = false;
  return rows;
}

function sourceRequestHash(requestId, data) {
  return hash(stableValue({
    station_id: SID,
    actor_uid: 'manager',
    request_id: requestId,
    rows: data.rows,
    expected: data.expected_source_id === undefined || data.expected_source_id === null
      ? null : data.expected_source_id,
    activate: data.activate,
    accept_rejected: data.accept_rejected === undefined ? null : data.accept_rejected,
    accept_carry_dropped: data.accept_carry_dropped === undefined
      ? null : data.accept_carry_dropped,
    accept_missing: data.accept_missing === undefined ? null : data.accept_missing
  }));
}

function withoutDuplicate(value) {
  const copy = Object.assign({}, value || {});
  delete copy.duplicate;
  return copy;
}

/* מעטפת בדיקה בלבד: היא עוצרת שתי קריאות אחרי שהן קראו את אותו
 * operation snapshot ולפני שהן ממשיכות. כל שאר Firestore נשאר אמיתי. */
function firestoreWithDocumentReadBarrier(path, afterRead) {
  let wrapCollection;
  const bind = (target, property) => {
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  };
  const wrapDocument = (ref) => new Proxy(ref, {
    get(target, property) {
      if (property === 'get') {
        return async (...args) => {
          const snapshot = await target.get(...args);
          if (target.path === path) await afterRead(snapshot);
          return snapshot;
        };
      }
      if (property === 'collection') {
        return (...args) => wrapCollection(target.collection(...args));
      }
      return bind(target, property);
    }
  });
  wrapCollection = (ref) => new Proxy(ref, {
    get(target, property) {
      if (property === 'doc') return (...args) => wrapDocument(target.doc(...args));
      return bind(target, property);
    }
  });
  return new Proxy(db, {
    get(target, property) {
      if (property === 'collection') return (...args) => wrapCollection(target.collection(...args));
      return bind(target, property);
    }
  });
}

function bounded(signal, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' timed out')), 10000);
    signal.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function draftRefFor(requestId) {
  return station().collection('schedule_drafts')
    .doc('d_' + hash(SID + '|manager|' + requestId).slice(0, 40));
}

/* --- טיוטת מדיניות. כל הערכים מפורשים; אין ברירות מחדל עסקיות. --- */
function policyDraft(over) {
  return Object.assign({
    sub_stations: {
      a: {
        label: 'תחנה ראשית', minimum: 2,
        requirements: [
          { role: 'driver', label: 'נהג', count: 1, required: true },
          { role: 'firefighter', label: 'לוחם', count: 1, required: true }
        ]
      }
    },
    rest: { min_gap_days: 1 },
    rotation: null,
    max_shifts_per_month: 12
  }, over || {});
}

/* --- שורות מקור. כל השמות מומצאים; אין כאן איש אמיתי. --- */
function sourceRows() {
  return [
    { row: 2, employee_number: '9001', full_name: 'בדיקה אלף', sub_station: 'a', active: true, roles: ['driver'] },
    { row: 3, employee_number: '9002', full_name: 'בדיקה בית', sub_station: 'a', active: true, roles: ['firefighter'] },
    { row: 4, employee_number: '9003', full_name: 'בדיקה גימל', sub_station: 'a', active: true, roles: ['driver', 'firefighter'] },
    { row: 5, employee_number: '9004', full_name: 'בדיקה דלת', sub_station: 'a', active: true, roles: ['driver'] },
    { row: 6, employee_number: '9005', full_name: 'בדיקה הא', sub_station: 'a', active: true, roles: ['firefighter'] },
    { row: 7, employee_number: '9006', full_name: 'בדיקה וו', sub_station: 'a', active: true, roles: ['driver', 'firefighter'] }
  ];
}

async function seed() {
  await station().set({ name: 'Authoring Integration Station' });
  const users = [
    ['manager', 'firefighter', 'אחראי סידור בדיקה'],
    ['commander', 'commander', 'מפקד בדיקה'],
    ['deputy', 'deputy', 'סגן בדיקה'],
    ['station_cmd', 'station_commander', 'מפקד תחנה בדיקה'],
    ['hr', 'hr_coordinator', 'רכזת בדיקה'],
    ['viewer', 'firefighter', 'כבאי בדיקה'],
    ['outsider', 'firefighter', 'איש תחנה אחרת']
  ];
  await Promise.all(users.map(([uid, role, name]) =>
    station().collection('users').doc(uid).set({
      station: SID, role, full_name: name, active: true
    })));
  // מי שאינו שייך לתחנה הזאת בכלל.
  await db.collection('stations').doc('other_station').collection('users').doc('outsider')
    .set({ station: 'other_station', role: 'firefighter', full_name: 'איש תחנה אחרת' });

  await station().collection('schedule_access').doc('manager').set({
    schema_version: 1, station_id: SID, uid: 'manager',
    roles: ['schedule_manager'], active: true, revision: 1
  });
  await Promise.all([
    station().collection('users').doc('worker_a').set({
      station: SID, employee_number: '9001', full_name: 'פרופיל אלף', active: true
    }),
    station().collection('users').doc('worker_b').set({
      station: SID, employee_number: '9002', full_name: 'פרופיל בית', active: true
    }),
    station().collection('users').doc('worker_c').set({
      station: SID, employee_number: '9003', full_name: 'פרופיל גימל', active: true
    }),
    station().collection('users').doc('worker_d').set({
      station: SID, employee_number: '9004', full_name: 'פרופיל דלת', active: true
    }),
    station().collection('users').doc('worker_e').set({
      station: SID, employee_number: '9005', full_name: 'פרופיל הא', active: true
    }),
    station().collection('users').doc('worker_f').set({
      station: SID, employee_number: '9006', full_name: 'פרופיל וו', active: true
    })
  ]);
  // Shadow reads the verified legacy projection.  Seed the complete A/B/C
  // rotation used in production, but keep the viewer outside a crew so this
  // display fixture cannot manufacture a MISSING cutover finding.  A live
  // guard gives the viewer real content without changing legacy person-days.
  const legacy = db.batch();
  legacy.set(station().collection('roster').doc('viewer'), {
    full_name: 'כבאי בדיקה', active: true
  });
  ['A', 'B', 'C'].forEach((crew, position) => legacy.set(
    station().collection('rotations').doc('r' + crew), {
      crew, position_in_cycle: position, cycle_days: 3,
      anchor_date: '2026-09-01', is_active: true
    }));
  legacy.set(station().collection('guards').doc('guard_shadow_viewer'), {
    title: 'אבטחת בדיקה', date: '2026-09-01',
    start: '08:00', end: '09:00', slots: 1,
    status: 'staffed', assigned: ['viewer']
  });
  await legacy.commit();
  await runtimeDoc().set({ mode: 'off' });
}

/* מזהה הפרסום המוכן, מהבדיקה שיוצרת אותו לבדיקות שצורכות אותו. */
let preparedId = null;
let preflightSignature = null;
let preflightChanges = 0;

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log('✓ ' + name);
}

(async function run() {
  await seed();
  const api = runtime();

  /* ================================================================
   * 1 · מדיניות · תצוגה מקדימה אינה כותבת
   * ================================================================ */

  await test('previewPolicy writes nothing at all', async () => {
    const before = await station().collection('schedule_policies').get();
    const view = await api.previewPolicy(req('manager', 'firefighter', {
      draft: policyDraft()
    }));
    assert.ok(view && view.digest, 'התצוגה המקדימה לא החזירה חתימה');
    const after = await station().collection('schedule_policies').get();
    // ⭐ אפס מסמכים חדשים. „תצוגה מקדימה" שכותבת אינה תצוגה מקדימה.
    assert.equal(after.size, before.size);
    const cfg = (await runtimeDoc().get()).data() || {};
    assert.equal(cfg.active_policy_id, undefined);
  });

  let policyId = null;
  await test('savePolicy writes complete + digest and moves the pointer', async () => {
    const result = await api.savePolicy(req('manager', 'firefighter', {
      request_id: 'pol_1', activate: true, expected_policy_id: null,
      draft: policyDraft()
    }));
    assert.equal(result.duplicate, false);
    policyId = result.policy_id;
    assert.ok(policyId, 'לא הוחזר מזהה מדיניות');
    const doc = (await station().collection('schedule_policies').doc(policyId).get()).data() || {};
    assert.equal(doc.complete, true);
    assert.ok(doc.content_digest, 'המדיניות נשמרה בלי חתימה');
    const cfg = (await runtimeDoc().get()).data() || {};
    assert.equal(cfg.active_policy_id, policyId);
    // ⭐ ושמירת מדיניות אינה מדליקה את המנוע.
    assert.equal(cfg.mode, 'off');
  });

  await test('an identical request-id replays instead of writing twice', async () => {
    const before = (await station().collection('schedule_policies').get()).size;
    const again = await api.savePolicy(req('manager', 'firefighter', {
      request_id: 'pol_1', activate: true, expected_policy_id: null,
      draft: policyDraft()
    }));
    assert.equal(again.duplicate, true);
    assert.equal((await station().collection('schedule_policies').get()).size, before);
  });

  await test('the same request-id with different content is refused', async () => {
    const error = await caught(() => api.savePolicy(req('manager', 'firefighter', {
      request_id: 'pol_1', activate: true, expected_policy_id: null,
      draft: policyDraft({ rest: { min_gap_days: 3 } })
    })));
    assert.ok(error, 'שימוש חוזר בתוכן אחר לא נחסם');
    assert.match(String(error.code || ''), /reused|already/i);
  });

  await test('a stale expected_policy_id loses the compare-and-set', async () => {
    const error = await caught(() => api.savePolicy(req('manager', 'firefighter', {
      request_id: 'pol_stale', activate: true, expected_policy_id: null,
      draft: policyDraft({ rest: { min_gap_days: 2 } })
    })));
    // המצביע כבר זז, ולכן `expected: null` אינו נכון עוד.
    assert.ok(error, 'CAS לא נאכף');
    assert.match(String(error.code || ''), /conflict/i);
  });

  /* ================================================================
   * 2 · מקור כוח אדם
   * ================================================================ */

  await test('previewSource writes nothing', async () => {
    const before = (await station().collection('schedule_sources').get()).size;
    const view = await api.previewSource(req('manager', 'firefighter', { rows: sourceRows() }));
    assert.ok(view, 'התצוגה המקדימה לא החזירה דבר');
    assert.equal(view.blocked, false, 'מקור תקין סומן כחסום');
    assert.equal(view.report.total, 6);
    assert.equal(view.report.accepted, 6);
    assert.equal(view.report.rejected, 0);
    assert.equal(view.report.by_code['row-profile-name-missing'] || 0, 0);
    assert.equal(view.missing_staff, 0);
    assert.equal((await station().collection('schedule_sources').get()).size, before);
  });

  let sourceId = null;
  await test('saveSource stages, then completes with matching counts and digest', async () => {
    const result = await api.saveSource(req('manager', 'firefighter', {
      request_id: 'src_1', activate: true, expected_source_id: null, rows: sourceRows()
    }));
    sourceId = result.source_id;
    assert.ok(sourceId);
    const ref = station().collection('schedule_sources').doc(sourceId);
    const meta = (await ref.get()).data() || {};
    assert.equal(meta.complete, true);
    assert.ok(meta.content_digest);
    const people = await ref.collection('people').get();
    // ⭐ הספירה החתומה חייבת לתאום למסמכים בפועל, אחרת `loadSource`
    // נופל על count-mismatch — מקור שנשמר ואי אפשר להריץ.
    assert.equal(people.size, meta.person_count);
    const firstPerson = (await ref.collection('people').doc('worker_a').get()).data() || {};
    assert.equal(firstPerson.full_name, 'פרופיל אלף');
    assert.notEqual(firstPerson.full_name, sourceRows()[0].full_name,
      'השם מהגיליון גבר על השם החי');
    const cfg = (await runtimeDoc().get()).data() || {};
    assert.equal(cfg.active_source_id, sourceId);
    assert.equal(cfg.mode, 'off');
  });

  /* ⭐ P0-1 · הבדיקה החשובה ביותר בקובץ הזה.
   * יבוא סגל אינו מוחק זמינות, נעילות ואירועים. */
  await test('a workforce import carries availability, locks and events across', async () => {
    const ref = station().collection('schedule_sources').doc(sourceId);
    const people = (await ref.collection('people').get()).docs.map((doc) => doc.id);
    assert.ok(people.length >= 2, 'צריך לפחות שני אנשים לבדיקה הזאת');

    // מזריקים תוכן למקור הפעיל, בדיוק בצורה ש-`loadSource` בונה.
    const availability = { worker_a: { '2026-09-01': 'yes' } };
    const locked = {
      a: { '2026-09-01': [{ person: 'worker_b', role: 'firefighter' }] }
    };
    // אירוע לא מאויש הוא מצב חוקי; החוזה דורש מערך מפורש ולא שדה חסר.
    const events = [{
      id: 'ev_it_1', title: 'תרגיל בדיקה', date: '2026-09-05', people: []
    }];
    const meta = (await ref.get()).data() || {};
    const batch = db.batch();
    Object.keys(availability).forEach((uid) =>
      batch.set(ref.collection('availability').doc(uid), { days: availability[uid] }));
    Object.keys(locked).forEach((sub) =>
      batch.set(ref.collection('locked').doc(sub), { days: locked[sub] }));
    events.forEach((event) => batch.set(ref.collection('events').doc(event.id), event));
    await batch.commit();
    // הספירות והחתימה חייבות לשקף את מה שהוזרק, אחרת המקור לא ייקרא.
    const { createSourceAuthor } = require('./schedule-source-author');
    const author = createSourceAuthor({ clock: CLOCK, hash });
    void author;
    await ref.set({
      availability_count: Object.keys(availability).length,
      locked_count: Object.keys(locked).length,
      event_count: events.length
    }, { merge: true });
    // החתימה מחושבת מחדש בדיוק כפי ש-`loadSource` יחשב אותה.
    const basis = {
      station_id: meta.station_id, version: meta.version, revision: meta.revision,
      carry: meta.carry || {},
      counts: {
        people: meta.person_count, availability: Object.keys(availability).length,
        locked: Object.keys(locked).length, events: events.length
      },
      people: (await ref.collection('people').get()).docs
        .map((doc) => Object.assign({ id: doc.id }, doc.data())),
      availability, locked, events
    };
    await ref.set({ content_digest: hash(stableValue(basis)) }, { merge: true });

    // ועכשיו — יבוא סגל חדש, עם אדם נוסף.
    const rows = sourceRows();
    rows.push({ row: 5, employee_number: '9001', full_name: 'בדיקה אלף', sub_station: 'a', active: false, roles: ['driver'] });
    const changed = sourceRows();
    changed[0].active = false;
    const result = await api.saveSource(req('manager', 'firefighter', {
      request_id: 'src_2', activate: true, expected_source_id: sourceId, rows: changed
    }));
    const nextRef = station().collection('schedule_sources').doc(result.source_id);
    const nextMeta = (await nextRef.get()).data() || {};

    // ⭐ הליבה: שלושת התת-אוספים עברו, ולא נמחקו.
    assert.equal((await nextRef.collection('availability').get()).size, 1,
      'הזמינות נמחקה ביבוא סגל — זה בדיוק P0-1');
    assert.equal((await nextRef.collection('locked').get()).size, 1, 'הנעילות נמחקו');
    assert.equal((await nextRef.collection('events').get()).size, 1, 'האירועים נמחקו');
    assert.equal(nextMeta.availability_count, 1);
    assert.equal(nextMeta.locked_count, 1);
    assert.equal(nextMeta.event_count, 1);
    const carriedLock = (await nextRef.collection('locked').doc('a').get()).data() || {};
    assert.deepEqual(carriedLock.days, locked.a,
      'השיבוץ הידני לא נשמר בצורת תחנת-קצה → יום → אדם');
    assert.equal((await nextRef.collection('locked').doc('worker_b').get()).exists, false,
      'מזהה העובד נכתב בטעות כמזהה מסמך נעילות');

    // והמקור החדש **נקרא** — כלומר החתימה שנכתבה תואמת לתוכן.
    const setup = await api.getManagerSetup(req('manager', 'firefighter', {}));
    assert.equal(setup.source.id, result.source_id,
      'המקור החדש לא נטען בפועל דרך מסלול ההגדרות');
    sourceId = result.source_id;
  });

  /* ================================================================
   * 3 · התחנה מהזהות בלבד
   * ================================================================ */

  await test('a station in the payload is rejected, never honoured', async () => {
    const error = await caught(() => api.savePolicy(req('manager', 'firefighter', {
      request_id: 'pol_station', activate: true, expected_policy_id: policyId,
      station_id: 'other_station',
      draft: policyDraft()
    })));
    assert.ok(error, 'תחנה מהלקוח לא נדחתה');
    assert.equal(error.code, 'client-station-forbidden');
  });

  await test('a manager appointment in another station grants nothing here', async () => {
    const error = await caught(() => api.previewPolicy({
      auth: { uid: 'manager', token: { stationId: 'other_station', role: 'firefighter' } },
      data: { draft: policyDraft() }
    }));
    assert.ok(error, 'מינוי בתחנה זרה עבד');
    assert.equal(error.code, 'live-user-required');
  });

  await test('an inactive user is refused even with a live appointment', async () => {
    const userRef = station().collection('users').doc('manager');
    const before = (await userRef.get()).data() || {};
    await userRef.set({ active: false }, { merge: true });
    try {
      const error = await caught(() => api.previewPolicy(req('manager', 'firefighter', {
        draft: policyDraft()
      })));
      assert.ok(error, 'משתמש לא פעיל לא נחסם');
      assert.equal(error.code, 'live-user-inactive');
    } finally {
      await userRef.set(before);
    }
  });

  await test('a revoked appointment fails the closing transaction, not the staging', async () => {
    const accessRef = station().collection('schedule_access').doc('manager');
    const before = (await accessRef.get()).data() || {};
    const runtimeBefore = (await runtimeDoc().get()).data() || {};
    const preview = await api.previewSource(req('manager', 'firefighter', { rows: sourceRows() }));
    assert.equal(preview.blocked, false);
    const stagedBaseId = preview.source_id;
    const previewRef = station().collection('schedule_sources').doc(stagedBaseId);
    assert.equal((await previewRef.get()).exists, false);
    let stagedRef = null;
    let sourceFinalizers = 0;
    const hooked = runtime({
      beforeSnapshotFinalize: async (info) => {
        if (!info || info.kind !== 'source') return;
        sourceFinalizers += 1;
        stagedRef = info.ref;
        // ⭐ המינוי מוסר **בין** הכתיבה המדורגת לבין הסגירה. זה
        // בדיוק הרגע שבו מסמך חצי-כתוב יכול להפוך לפעיל.
        await accessRef.set({ active: false }, { merge: true });
      }
    });
    try {
      const error = await caught(() => hooked.saveSource(req('manager', 'firefighter', {
        request_id: 'src_revoked', activate: true,
        expected_source_id: sourceId, rows: sourceRows()
      })));
      assert.ok(error, 'הסרת מינוי באמצע לא נחסמה');
      assert.equal(error.code, 'manager-revoked');
      assert.equal(sourceFinalizers, 1);
      assert.ok(stagedRef.id.startsWith(stagedBaseId + '_'),
        'מזהה ה-staging אינו קשור לתוכן שנבדק בתצוגה המקדימה');
      const cfg = (await runtimeDoc().get()).data() || {};
      assert.deepEqual(cfg, runtimeBefore, 'מצב הסידור השתנה למרות שהמינוי הוסר');
      assert.equal((await stagedRef.get()).exists, false,
        'מסמך staging נשאר לאחר דחיית הרשאה');
      for (const group of ['people', 'availability', 'locked', 'events']) {
        assert.equal((await stagedRef.collection(group).get()).size, 0,
          'תת-אוסף staging נשאר לאחר דחיית הרשאה: ' + group);
      }
      assert.equal((await station().collection('schedule_source_operations')
        .doc('src_revoked').get()).exists, false);
      assert.equal((await station().collection('schedule_source_audit')
        .where('request_id', '==', 'src_revoked').get()).size, 0);
    } finally {
      await accessRef.set(before);
    }
  });

  /* ⭐ P0 · `saveSource` חייב לקרוא את המקור הפעיל באותו חוזה קשיח
   * שבו המנוע קורא אותו. מצביע שבור או מקור חצי-כתוב אינם שקולים
   * ל"אין מקור קודם": אחרת יבוא סגל מוחק תוכן ומכשיר מקור חדש. */
  async function assertMalformedActiveRejected(spec) {
    const sourcesRef = station().collection('schedule_sources');
    const goodRef = sourcesRef.doc(sourceId);
    const keepSourceIds = await collectionIds(sourcesRef);
    const badRef = sourcesRef.doc(spec.sourceId);
    const requestId = spec.requestId;
    try {
      await deleteSourceTree(badRef);
      if (spec.clone !== false) {
        const tree = await sourceTree(goodRef);
        const patch = typeof spec.metaPatch === 'function'
          ? spec.metaPatch(tree.meta) : (spec.metaPatch || {});
        await writeSourceTree(badRef, tree, patch);
        if (typeof spec.afterClone === 'function') await spec.afterClone(badRef, tree);
      }
      await runtimeDoc().set({ active_source_id: spec.sourceId }, { merge: true });

      const beforeRuntime = (await runtimeDoc().get()).data() || {};
      const beforeSources = await collectionIds(sourcesRef);
      const beforeOperations = await collectionIds(
        station().collection('schedule_source_operations'));
      const beforeAudits = await collectionIds(station().collection('schedule_source_audit'));
      let finalizers = 0;
      const hooked = runtime({
        beforeSnapshotFinalize: async (info) => {
          if (info && info.kind === 'source') finalizers += 1;
        }
      });

      const error = await caught(() => hooked.saveSource(req('manager', 'firefighter', {
        request_id: requestId,
        activate: true,
        expected_source_id: spec.sourceId,
        rows: changedSourceRows()
      })));

      assert.ok(error, spec.label + ': מקור פעיל פגום הוכשר');
      assert.equal(error.code, spec.code, spec.label + ': קוד הכשל אינו מדויק');
      assert.equal(finalizers, 0, spec.label + ': נכתב staging לפני אימות המקור הפעיל');
      assert.equal(stableValue((await runtimeDoc().get()).data() || {}), stableValue(beforeRuntime),
        spec.label + ': מצביע המקור או מצב הריצה השתנו');
      assert.deepEqual(await collectionIds(sourcesRef), beforeSources,
        spec.label + ': נוצר מקור מדורג למרות שהמקור הפעיל פגום');
      assert.deepEqual(await collectionIds(station().collection('schedule_source_operations')),
        beforeOperations, spec.label + ': נכתבה פעולת idempotency');
      assert.deepEqual(await collectionIds(station().collection('schedule_source_audit')),
        beforeAudits, spec.label + ': נכתבה רשומת ביקורת');
    } finally {
      await runtimeDoc().set({ active_source_id: sourceId }, { merge: true });
      await cleanupSourceRequest(requestId);
      const currentIds = await collectionIds(sourcesRef);
      for (const id of currentIds) {
        if (keepSourceIds.indexOf(id) === -1) await deleteSourceTree(sourcesRef.doc(id));
      }
    }
  }

  await test('saveSource rejects a pointer to a missing active source before staging', async () => {
    await assertMalformedActiveRejected({
      label: 'missing active source', sourceId: 'it_active_source_missing',
      requestId: 'src_active_missing', clone: false, code: 'source-not-found'
    });
  });

  await test('saveSource rejects complete=false on the active source before staging', async () => {
    await assertMalformedActiveRejected({
      label: 'incomplete active source', sourceId: 'it_active_source_incomplete',
      requestId: 'src_active_incomplete', metaPatch: { complete: false },
      code: 'source-incomplete'
    });
  });

  await test('saveSource rejects signed count mismatch on the active source before staging', async () => {
    await assertMalformedActiveRejected({
      label: 'active source count mismatch', sourceId: 'it_active_source_bad_count',
      requestId: 'src_active_bad_count',
      metaPatch: (meta) => ({ person_count: Number(meta.person_count) + 1 }),
      code: 'source-count-mismatch'
    });
  });

  await test('saveSource rejects digest mismatch on the active source before staging', async () => {
    await assertMalformedActiveRejected({
      label: 'active source digest mismatch', sourceId: 'it_active_source_bad_digest',
      requestId: 'src_active_bad_digest', metaPatch: { content_digest: '0'.repeat(64) },
      code: 'source-digest-mismatch'
    });
  });

  await test('saveSource rejects unsigned content_key corruption before staging', async () => {
    await assertMalformedActiveRejected({
      label: 'active source content key mismatch', sourceId: 'it_active_source_bad_content_key',
      requestId: 'src_active_bad_content_key', metaPatch: { content_key: '0'.repeat(64) },
      code: 'source-content-key-mismatch'
    });
  });

  await test('saveSource rejects a missing signed child before staging', async () => {
    await assertMalformedActiveRejected({
      label: 'active source missing child', sourceId: 'it_active_source_missing_child',
      requestId: 'src_active_missing_child', code: 'source-count-mismatch',
      afterClone: async (ref, tree) => {
        assert.ok(tree.groups.people.length, 'אין מסמך people להסרה ב-fixture');
        await ref.collection('people').doc(tree.groups.people[0].id).delete();
      }
    });
  });

  /* ⭐ P0 · שתי בקשות שונות אך זהות בתוכן חייבות לקבל staging נפרד.
   * המפסידה רשאית לקבל replay/conflict, אך הניקוי שלה לעולם אינו
   * רשאי למחוק את המקור שהבקשה המנצחת כבר הפעילה. */
  await test('concurrent identical saveSource calls preserve the winning source and all children', async () => {
    const requestIds = ['src_race_a', 'src_race_b'];
    const sourcesRef = station().collection('schedule_sources');
    const keepSourceIds = await collectionIds(sourcesRef);
    const previousTree = await sourceTree(sourcesRef.doc(sourceId));
    let release;
    const closingGate = new Promise((resolve) => { release = resolve; });
    let bothArrived;
    const bothAtClosingGate = new Promise((resolve) => { bothArrived = resolve; });
    const staged = [];
    const hooked = runtime({
      beforeSnapshotFinalize: async (info) => {
        if (!info || info.kind !== 'source') return;
        const meta = (await info.ref.get()).data() || {};
        staged.push({ ref: info.ref, meta });
        if (staged.length === 2) bothArrived();
        await closingGate;
      }
    });
    const common = {
      activate: true, expected_source_id: sourceId, rows: changedSourceRows()
    };
    const settle = (promise) => promise.then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason })
    );
    const outcomesPromise = Promise.all(requestIds.map((requestId) => settle(
      hooked.saveSource(req('manager', 'firefighter', Object.assign({}, common, {
        request_id: requestId
      }))))));

    let barrierError = null;
    try {
      await bounded(bothAtClosingGate, 'two source writers at the closing gate');
      assert.equal(staged.length, 2);
      assert.notEqual(staged[0].ref.path, staged[1].ref.path,
        'שתי בקשות שונות חלקו מסמך staging ולכן ניקוי מפסידה ימחק מנצחת');
      assert.deepEqual(staged.map((item) => item.meta.staged_by_request).sort(),
        requestIds.slice().sort(), 'בעלות ה-staging אינה חתומה לפי request_id');
      assert.ok(staged.every((item) => item.meta.complete === false));
      assert.ok(staged.every((item) => /^[a-f0-9]{64}$/.test(
        String(item.meta.staged_content_digest || ''))), 'חתימת תוכן staging חסרה');
      assert.equal(staged[0].meta.staged_content_digest,
        staged[1].meta.staged_content_digest, 'תוכן זהה קיבל שתי חתימות שונות');
      for (const item of staged) {
        const counts = {
          people: item.meta.person_count,
          availability: item.meta.availability_count,
          locked: item.meta.locked_count,
          events: item.meta.event_count
        };
        for (const group of SOURCE_GROUPS) {
          assert.equal((await item.ref.collection(group).get()).size, counts[group],
            'staging הגיע לסגירה בלי כל מסמכי ' + group);
        }
      }
    } catch (error) {
      barrierError = error;
    } finally {
      release();
    }

    const outcomes = await outcomesPromise;
    try {
      if (barrierError) throw barrierError;
      const activations = outcomes.filter((item) => item.status === 'fulfilled'
        && item.value && item.value.duplicate !== true && item.value.activated === true);
      assert.equal(activations.length, 1, 'לא הייתה בדיוק הפעלה חדשה אחת');
      const activeId = ((await runtimeDoc().get()).data() || {}).active_source_id;
      assert.equal(activeId, activations[0].value.source_id,
        'המצביע אינו מצביע למקור של הבקשה המנצחת');

      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled') {
          assert.equal(outcome.value.source_id, activeId,
            'replay החזיר מקור שאינו המקור הפעיל');
        } else {
          assert.match(String(outcome.reason && outcome.reason.code || ''),
            /^source-(?:conflict|reserved|in-progress)$/,
            'הבקשה המפסידה נכשלה מסיבה שאינה conflict/replay');
        }
      }

      const activeRef = sourcesRef.doc(activeId);
      const activeTree = await sourceTree(activeRef);
      assert.equal(activeTree.meta.complete, true, 'המקור הפעיל נשאר חלקי');
      assert.ok(activeTree.meta.content_digest, 'למקור הפעיל אין חתימה');
      const countFields = {
        people: 'person_count', availability: 'availability_count',
        locked: 'locked_count', events: 'event_count'
      };
      for (const group of SOURCE_GROUPS) {
        assert.equal(activeTree.groups[group].length, activeTree.meta[countFields[group]],
          'המקור הפעיל חסר מסמכי ' + group);
        assert.ok(activeTree.groups[group].length > 0,
          'fixture המירוץ לא הוכיח הישרדות של ' + group);
      }
      for (const group of ['availability', 'locked', 'events']) {
        assert.equal(stableValue(activeTree.groups[group]), stableValue(previousTree.groups[group]),
          'תוכן ' + group + ' לא שרד את המירוץ');
      }
      const setup = await api.getManagerSetup(req('manager', 'firefighter', {}));
      assert.equal(setup.source.id, activeId,
        'המקור המנצח נכתב אך אינו ניתן לטעינה בחוזה המנוע');

      const auditDocs = await Promise.all(requestIds.map((id) => sourceAuditRef(id).get()));
      const activationAudits = auditDocs.filter((doc) => doc.exists
        && (doc.data() || {}).activated === true);
      assert.equal(activationAudits.length, 1, 'נכתבו שתי הפעלות ביומן');
      assert.equal((activationAudits[0].data() || {}).source_id, activeId);

      for (const item of staged) {
        if (item.ref.id === activeId) continue;
        assert.equal((await item.ref.get()).exists, false,
          'מסמך ה-staging המפסיד לא נוקה');
        for (const group of SOURCE_GROUPS) {
          assert.equal((await item.ref.collection(group).get()).size, 0,
            'ילדי staging מפסיד לא נוקו: ' + group);
        }
      }
    } finally {
      await runtimeDoc().set({ active_source_id: sourceId }, { merge: true });
      for (const requestId of requestIds) await cleanupSourceRequest(requestId);
      const currentIds = await collectionIds(sourcesRef);
      for (const id of currentIds) {
        if (keepSourceIds.indexOf(id) === -1) await deleteSourceTree(sourcesRef.doc(id));
      }
    }
  });

  await test('the first staged writer owns a shared request_id against an unchanged payload', async () => {
    const requestId = 'src_same_id_changed_vs_unchanged';
    const sourcesRef = station().collection('schedule_sources');
    const keepSourceIds = await collectionIds(sourcesRef);
    await cleanupSourceRequest(requestId);
    const changedData = {
      request_id: requestId,
      activate: true,
      expected_source_id: sourceId,
      rows: changedSourceRows()
    };
    const unchangedData = {
      request_id: requestId,
      activate: true,
      expected_source_id: sourceId,
      rows: unchangedSourceRows()
    };
    const unchangedPreview = await api.previewSource(req('manager', 'firefighter', {
      rows: unchangedData.rows
    }));
    assert.equal(unchangedPreview.kind, 'unchanged', 'fixture הבקרה אינו unchanged');

    let release;
    const closingGate = new Promise((resolve) => { release = resolve; });
    let arrived;
    const atClosingGate = new Promise((resolve) => { arrived = resolve; });
    let stagedRef = null;
    const hooked = runtime({
      beforeSnapshotFinalize: async (info) => {
        if (!info || info.kind !== 'source') return;
        stagedRef = info.ref;
        arrived();
        await closingGate;
      }
    });
    const settle = (promise) => promise.then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason })
    );
    const firstPromise = settle(hooked.saveSource(req('manager', 'firefighter', changedData)));
    let secondPromise = null;
    let secondOutcome = null;
    let barrierError = null;
    try {
      await bounded(atClosingGate, 'changed source writer at the closing gate');
      secondPromise = settle(api.saveSource(req('manager', 'firefighter', unchangedData)));
      secondOutcome = await bounded(secondPromise,
        'unchanged contender with an already-owned request_id');
    } catch (error) {
      barrierError = error;
    } finally {
      release();
    }
    const firstOutcome = await firstPromise;
    if (secondPromise && !secondOutcome) secondOutcome = await secondPromise;

    try {
      if (barrierError) throw barrierError;
      assert.ok(stagedRef, 'הכותב הראשון לא הגיע ל-staging');
      assert.equal(secondOutcome.status, 'rejected',
        'בקשת unchanged מאוחרת השתלטה על request_id שכבר בביצוע');
      assert.equal(secondOutcome.reason.code, 'source-request-reused');
      assert.equal(firstOutcome.status, 'fulfilled',
        'הכותב הראשון איבד request_id אחרי שכבר כתב staging');
      assert.equal(firstOutcome.value.duplicate, false);
      assert.equal(firstOutcome.value.activated, true);
      assert.equal(firstOutcome.value.source_id, stagedRef.id);

      const runtimeAfter = (await runtimeDoc().get()).data() || {};
      assert.equal(runtimeAfter.active_source_id, firstOutcome.value.source_id);
      const operation = await sourceOperationRef(requestId).get();
      assert.equal(operation.exists, true, 'הפעולה המנצחת לא נשמרה');
      const operationData = operation.data() || {};
      assert.equal(operationData.request_hash, sourceRequestHash(requestId, changedData),
        'operation hash שייך לבקשה המפסידה');
      assert.equal(stableValue(operationData.result),
        stableValue(withoutDuplicate(firstOutcome.value)),
        'תוצאת ה-operation אינה תוצאת הכותב המנצח');

      const audit = await sourceAuditRef(requestId).get();
      assert.equal(audit.exists, true, 'אין רשומת ביקורת לבקשה המנצחת');
      assert.equal((audit.data() || {}).source_id, firstOutcome.value.source_id);
      const replay = await api.saveSource(req('manager', 'firefighter', changedData));
      assert.equal(replay.duplicate, true);
      assert.equal(stableValue(withoutDuplicate(replay)),
        stableValue(withoutDuplicate(firstOutcome.value)),
        'replay אינו מחזיר את התוצאה שנקבעה ב-operation');
      const losingReplay = await caught(() => api.saveSource(
        req('manager', 'firefighter', unchangedData)));
      assert.ok(losingReplay, 'התוכן המפסיד קיבל replay של תוצאה זרה');
      assert.equal(losingReplay.code, 'source-request-reused');
    } finally {
      await runtimeDoc().set({ active_source_id: sourceId }, { merge: true });
      await cleanupSourceRequest(requestId);
      const currentIds = await collectionIds(sourcesRef);
      for (const id of currentIds) {
        if (keepSourceIds.indexOf(id) === -1) await deleteSourceTree(sourcesRef.doc(id));
      }
    }
  });

  await test('concurrent unchanged retries have one result and duplicate semantics', async () => {
    const requestId = 'src_same_id_unchanged_race';
    const data = {
      request_id: requestId,
      activate: true,
      expected_source_id: sourceId,
      rows: unchangedSourceRows()
    };
    await cleanupSourceRequest(requestId);
    const preview = await api.previewSource(req('manager', 'firefighter', { rows: data.rows }));
    assert.equal(preview.kind, 'unchanged', 'fixture המירוץ אינו unchanged');
    const sourcesBefore = await collectionIds(station().collection('schedule_sources'));
    const runtimeBefore = (await runtimeDoc().get()).data() || {};
    const auditsBefore = await collectionIds(station().collection('schedule_source_audit'));

    let reads = 0;
    let release;
    const readGate = new Promise((resolve) => { release = resolve; });
    let bothRead;
    const bothReadAbsent = new Promise((resolve) => { bothRead = resolve; });
    const operationPath = sourceOperationRef(requestId).path;
    const barrierDb = firestoreWithDocumentReadBarrier(operationPath, async (snapshot) => {
      assert.equal(snapshot.exists, false, 'operation ישן זיהם את fixture המירוץ');
      reads += 1;
      if (reads === 2) bothRead();
      await readGate;
    });
    let sourceFinalizers = 0;
    const hooked = runtime({
      db: barrierDb,
      beforeSnapshotFinalize: async (info) => {
        if (info && info.kind === 'source') sourceFinalizers += 1;
      }
    });
    const settle = (promise) => promise.then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason })
    );
    const outcomesPromise = Promise.all([
      settle(hooked.saveSource(req('manager', 'firefighter', data))),
      settle(hooked.saveSource(req('manager', 'firefighter', data)))
    ]);
    let barrierError = null;
    try {
      await bounded(bothReadAbsent, 'two unchanged writers after an absent operation read');
    } catch (error) {
      barrierError = error;
    } finally {
      release();
    }
    const outcomes = await outcomesPromise;

    try {
      if (barrierError) throw barrierError;
      assert.equal(reads, 2);
      assert.ok(outcomes.every((item) => item.status === 'fulfilled'),
        'retry זהה נכשל במקום לקבל תוצאה/replay');
      const values = outcomes.map((item) => item.value);
      assert.equal(values.filter((value) => value.duplicate === false).length, 1,
        'שתי קריאות unchanged דיווחו שהן יצרו את אותה פעולה');
      assert.equal(values.filter((value) => value.duplicate === true).length, 1,
        'לא התקבלה סמנטיקת duplicate לקריאה הזהה המפסידה');
      assert.equal(stableValue(withoutDuplicate(values[0])),
        stableValue(withoutDuplicate(values[1])), 'שתי הקריאות החזירו תוצאות שונות');
      assert.equal(sourceFinalizers, 0, 'unchanged כתב staging');
      assert.equal(stableValue((await runtimeDoc().get()).data() || {}),
        stableValue(runtimeBefore), 'unchanged הזיז את מצביע המקור');
      assert.deepEqual(await collectionIds(station().collection('schedule_sources')),
        sourcesBefore, 'unchanged יצר מקור חדש');
      assert.deepEqual(await collectionIds(station().collection('schedule_source_audit')),
        auditsBefore, 'unchanged כתב רשומת ביקורת כאילו הופעל מקור');

      const operation = await sourceOperationRef(requestId).get();
      assert.equal(operation.exists, true);
      const operationData = operation.data() || {};
      assert.equal(operationData.request_hash, sourceRequestHash(requestId, data));
      const firstResult = values.find((value) => value.duplicate === false);
      assert.equal(stableValue(operationData.result), stableValue(withoutDuplicate(firstResult)),
        'ה-operation אינו מחזיק את התוצאה היחידה שנקבעה');
      const replay = await api.saveSource(req('manager', 'firefighter', data));
      assert.equal(replay.duplicate, true);
      assert.equal(stableValue(withoutDuplicate(replay)),
        stableValue(operationData.result), 'replay מאוחר סטה מתוצאת ה-operation');
    } finally {
      await cleanupSourceRequest(requestId);
    }
  });

  await test('an expired saveSource lease is taken over without stale-writer cleanup loss', async () => {
    const requestId = 'src_lease_takeover';
    const sourcesRef = station().collection('schedule_sources');
    const keepSourceIds = await collectionIds(sourcesRef);
    await cleanupSourceRequest(requestId);
    const data = {
      request_id: requestId,
      activate: true,
      expected_source_id: sourceId,
      rows: changedSourceRows()
    };
    let now = Date.parse(CLOCK());
    const movingClock = () => new Date(now).toISOString();
    const settle = (promise) => promise.then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason })
    );

    let releaseW1;
    let releaseW2;
    const w1Gate = new Promise((resolve) => { releaseW1 = resolve; });
    const w2Gate = new Promise((resolve) => { releaseW2 = resolve; });
    let arriveW1;
    let arriveW2;
    const w1AtFinalize = new Promise((resolve) => { arriveW1 = resolve; });
    const w2AtFinalize = new Promise((resolve) => { arriveW2 = resolve; });
    let w1Stage = null;
    let w2Stage = null;
    const w1 = runtime({
      clock: movingClock,
      beforeSnapshotFinalize: async (info) => {
        if (!info || info.kind !== 'source') return;
        w1Stage = { ref: info.ref, meta: (await info.ref.get()).data() || {} };
        arriveW1();
        await w1Gate;
      }
    });
    const w2 = runtime({
      clock: movingClock,
      beforeSnapshotFinalize: async (info) => {
        if (!info || info.kind !== 'source') return;
        w2Stage = { ref: info.ref, meta: (await info.ref.get()).data() || {} };
        arriveW2();
        await w2Gate;
      }
    });
    let w1OutcomePromise = null;
    let w2OutcomePromise = null;

    try {
      w1OutcomePromise = settle(w1.saveSource(req('manager', 'firefighter', data)));
      await bounded(w1AtFinalize, 'W1 source writer at finalize');
      assert.ok(w1Stage, 'W1 לא הגיע ל-staging');
      assert.equal(w1Stage.meta.staged_by_request, requestId);
      assert.equal(w1Stage.meta.staged_request_hash, sourceRequestHash(requestId, data));
      assert.ok(typeof w1Stage.meta.staged_owner_token === 'string'
        && w1Stage.meta.staged_owner_token.length > 0, 'W1 לא חתם owner token');
      const operationAtW1 = await sourceOperationRef(requestId).get();
      assert.equal(operationAtW1.exists, true, 'W1 הגיע ל-staging בלי לתפוס operation');
      assert.equal((operationAtW1.data() || {}).request_hash,
        sourceRequestHash(requestId, data));

      // OUTBOX_LEASE_MS הוא עשר דקות. קפיצה של אחת-עשרה דקות מחייבת
      // takeover, בלי להסתמך על השעון האמיתי או על המתנה בקיר.
      now += 11 * 60 * 1000;
      w2OutcomePromise = settle(w2.saveSource(req('manager', 'firefighter', data)));
      await bounded(w2AtFinalize, 'W2 source writer after lease expiry');
      assert.ok(w2Stage, 'W2 לא תפס lease שפג');
      assert.equal(w2Stage.ref.path, w1Stage.ref.path,
        'retry זהה לא חזר למסמך ה-staging הדטרמיניסטי');
      assert.equal(w2Stage.meta.staged_by_request, requestId);
      assert.equal(w2Stage.meta.staged_request_hash, sourceRequestHash(requestId, data));
      assert.ok(typeof w2Stage.meta.staged_owner_token === 'string'
        && w2Stage.meta.staged_owner_token.length > 0, 'W2 לא חתם owner token');
      assert.notEqual(w2Stage.meta.staged_owner_token, w1Stage.meta.staged_owner_token,
        'takeover השאיר לכותב החדש את owner token של הכותב הישן');

      releaseW1();
      const w1Outcome = await bounded(w1OutcomePromise, 'W1 losing its expired lease');
      assert.equal(w1Outcome.status, 'rejected', 'W1 השלים אחרי שאיבד את ה-lease');
      assert.match(String(w1Outcome.reason && w1Outcome.reason.code || ''),
        /^source-(?:staging-changed|owner-lost|lease-lost|operation-lost|request-in-flight)$/,
        'W1 לא נכשל כשגיאת אובדן בעלות');

      // W1 כבר עבר ב-catch וב-cleanup. אם הניקוי אינו תובע בעלות,
      // כאן מסמך האב או אחד מארבעת תתי-האוספים של W2 כבר ייעלמו.
      const afterW1 = await w2Stage.ref.get();
      assert.equal(afterW1.exists, true, 'ניקוי W1 מחק את מסמך W2');
      const afterW1Meta = afterW1.data() || {};
      assert.equal(afterW1Meta.complete, false);
      assert.equal(afterW1Meta.staged_owner_token, w2Stage.meta.staged_owner_token,
        'ניקוי W1 שינה את הבעלות של W2');
      const countFields = {
        people: 'person_count', availability: 'availability_count',
        locked: 'locked_count', events: 'event_count'
      };
      for (const group of SOURCE_GROUPS) {
        assert.equal((await w2Stage.ref.collection(group).get()).size,
          afterW1Meta[countFields[group]], 'ניקוי W1 מחק ילדים של W2: ' + group);
      }

      releaseW2();
      const w2Outcome = await bounded(w2OutcomePromise, 'W2 completing the takeover');
      assert.equal(w2Outcome.status, 'fulfilled', 'W2 לא השלים takeover חוקי');
      assert.equal(w2Outcome.value.duplicate, false);
      assert.equal(w2Outcome.value.activated, true);
      assert.equal(w2Outcome.value.source_id, w2Stage.ref.id);
      const activeRuntime = (await runtimeDoc().get()).data() || {};
      assert.equal(activeRuntime.active_source_id, w2Outcome.value.source_id);
      const complete = (await w2Stage.ref.get()).data() || {};
      assert.equal(complete.complete, true);
      assert.ok(complete.content_digest);
      assert.equal(Object.prototype.hasOwnProperty.call(complete, 'staged_owner_token'), false,
        'owner token נשאר על מקור complete');
      for (const group of SOURCE_GROUPS) {
        assert.equal((await w2Stage.ref.collection(group).get()).size,
          complete[countFields[group]], 'המקור שהופעל חסר ילדים: ' + group);
      }

      const operation = (await sourceOperationRef(requestId).get()).data() || {};
      assert.equal(operation.request_hash, sourceRequestHash(requestId, data));
      assert.equal(stableValue(operation.result), stableValue(withoutDuplicate(w2Outcome.value)),
        'operation לא מחזיק את תוצאת בעל ה-lease החדש');
      const replay = await api.saveSource(req('manager', 'firefighter', data));
      assert.equal(replay.duplicate, true);
      assert.equal(stableValue(withoutDuplicate(replay)), stableValue(operation.result));
      const setup = await api.getManagerSetup(req('manager', 'firefighter', {}));
      assert.equal(setup.source.id, w2Outcome.value.source_id,
        'מקור ה-takeover הופעל אך אינו ניתן לטעינה');
      const audit = await sourceAuditRef(requestId).get();
      assert.equal(audit.exists, true);
      assert.equal((audit.data() || {}).source_id, w2Outcome.value.source_id);
    } finally {
      releaseW1();
      releaseW2();
      if (w1OutcomePromise) await w1OutcomePromise;
      if (w2OutcomePromise) await w2OutcomePromise;
      await runtimeDoc().set({ active_source_id: sourceId }, { merge: true });
      await cleanupSourceRequest(requestId);
      const currentIds = await collectionIds(sourcesRef);
      for (const id of currentIds) {
        if (keepSourceIds.indexOf(id) === -1) await deleteSourceTree(sourcesRef.doc(id));
      }
    }
  });

  await test('a stale writer cannot recreate orphan children after takeover cleanup', async () => {
    const requestId = 'src_chunk_takeover_orphan';
    const sourcesRef = station().collection('schedule_sources');
    const keepSourceIds = await collectionIds(sourcesRef);
    const runtimeBefore = (await runtimeDoc().get()).data() || {};
    await cleanupSourceRequest(requestId);
    const data = {
      request_id: requestId,
      activate: true,
      expected_source_id: sourceId,
      rows: changedSourceRows()
    };
    let now = Date.parse(CLOCK());
    const movingClock = () => new Date(now).toISOString();
    const settle = (promise) => promise.then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason })
    );
    let releaseW1;
    const firstChunkGate = new Promise((resolve) => { releaseW1 = resolve; });
    let firstChunkArrived;
    const w1AfterFirstChunk = new Promise((resolve) => { firstChunkArrived = resolve; });
    let w1ChunkCalls = 0;
    let stagedRef = null;
    const w1 = runtime({
      clock: movingClock,
      sourceWriteChunkSize: 1,
      afterSourceWriteChunk: async (info) => {
        w1ChunkCalls += 1;
        if (w1ChunkCalls !== 1) return;
        stagedRef = info && info.ref;
        firstChunkArrived();
        await firstChunkGate;
      }
    });
    const intentionalW2Failure = new Error('intentional W2 failure after child writes');
    let w2FinalizeCalls = 0;
    const w2 = runtime({
      clock: movingClock,
      sourceWriteChunkSize: 1,
      beforeSnapshotFinalize: async (info) => {
        if (!info || info.kind !== 'source') return;
        w2FinalizeCalls += 1;
        assert.equal(info.ref.path, stagedRef.path,
          'takeover זהה לא השתמש במסמך staging הדטרמיניסטי');
        throw intentionalW2Failure;
      }
    });
    let w1OutcomePromise = null;
    let w2OutcomePromise = null;

    try {
      w1OutcomePromise = settle(w1.saveSource(req('manager', 'firefighter', data)));
      await bounded(w1AfterFirstChunk, 'W1 after its first guarded source chunk');
      assert.ok(stagedRef && stagedRef.path, 'seam ה-chunk לא מסר את מסמך ה-staging');
      assert.equal(w1ChunkCalls, 1, 'W1 לא נעצר מיד אחרי ה-chunk הראשון');
      let childrenAfterFirstChunk = 0;
      for (const group of SOURCE_GROUPS) {
        childrenAfterFirstChunk += (await stagedRef.collection(group).get()).size;
      }
      assert.equal(childrenAfterFirstChunk, 1,
        'sourceWriteChunkSize=1 לא יצר נקודת מרוץ אחרי ילד יחיד');
      const w1Meta = (await stagedRef.get()).data() || {};
      assert.equal(w1Meta.complete, false);
      assert.ok(w1Meta.staged_owner_token);

      now += 11 * 60 * 1000;
      w2OutcomePromise = settle(w2.saveSource(req('manager', 'firefighter', data)));
      const w2Outcome = await bounded(w2OutcomePromise,
        'W2 takeover, intentional failure and cleanup');
      assert.equal(w2Outcome.status, 'rejected', 'W2 לא נכשל בכוונה');
      assert.equal(w2Outcome.reason, intentionalW2Failure,
        'W2 נכשל לפני seam הכשל המכוון');
      assert.equal(w2FinalizeCalls, 1, 'W2 לא הגיע ל-finalize לאחר takeover');

      // בשלב הזה W2 כבר סיים catch+cleanup, בעוד W1 עדיין עצור אחרי
      // ילד יחיד. המקור וכל ילדיו חייבים להיות מחוקים.
      assert.equal((await stagedRef.get()).exists, false, 'ניקוי W2 השאיר מסמך אב');
      for (const group of SOURCE_GROUPS) {
        assert.equal((await stagedRef.collection(group).get()).size, 0,
          'ניקוי W2 השאיר ילדים ב-' + group);
      }
      assert.equal((await sourceOperationRef(requestId).get()).exists, false,
        'W2 השאיר operation claim אחרי כשל');

      releaseW1();
      const w1Outcome = await bounded(w1OutcomePromise,
        'W1 attempting another chunk after ownership loss');
      assert.equal(w1Outcome.status, 'rejected',
        'W1 המשיך לכתוב אחרי שה-stage וה-operation נמחקו');
      assert.match(String(w1Outcome.reason && w1Outcome.reason.code || ''),
        /^source-(?:operation-lost|staging-lost|owner-lost|lease-lost)$/,
        'W1 לא נכשל כאובדן בעלות לפני ה-chunk הבא');

      // זו בדיקת המוטציה ל-batch לא מגודר: אם W1 כותב את יתר הילדים
      // אחרי השחרור בלי לקרוא opRef+stage, האב יישאר חסר אבל הסכום כאן
      // יהיה גדול מאפס.
      assert.equal((await stagedRef.get()).exists, false,
        'W1 יצר מחדש את מסמך האב לאחר ניקוי W2');
      for (const group of SOURCE_GROUPS) {
        assert.equal((await stagedRef.collection(group).get()).size, 0,
          'כתיבת batch לא מגודרת השאירה orphan ב-' + group);
      }
      assert.equal(stableValue((await runtimeDoc().get()).data() || {}),
        stableValue(runtimeBefore), 'מרוץ orphan הזיז את המקור הפעיל');
      assert.equal((await sourceOperationRef(requestId).get()).exists, false);
      assert.equal((await sourceAuditRef(requestId).get()).exists, false);
      assert.deepEqual(await collectionIds(sourcesRef), keepSourceIds,
        'מרוץ orphan השאיר מקור מדורג');
    } finally {
      releaseW1();
      if (w1OutcomePromise) await w1OutcomePromise;
      if (w2OutcomePromise) await w2OutcomePromise;
      await runtimeDoc().set({ active_source_id: sourceId }, { merge: true });
      await cleanupSourceRequest(requestId);
      const currentIds = await collectionIds(sourcesRef);
      for (const id of currentIds) {
        if (keepSourceIds.indexOf(id) === -1) await deleteSourceTree(sourcesRef.doc(id));
      }
    }
  });

  /* ================================================================
   * 3B · ניקוי מקורות מדורגים שננטשו
   * ================================================================ */

  await test('the source sweeper deletes expired incomplete children before the parent', async () => {
    const ref = await writeExpiredStage('sweep_expired_clean', 'sweep_req_clean', {
      people: ['person_a'], availability: ['availability_a'],
      locked: ['locked_a'], events: ['event_a']
    });
    try {
      const result = await api.sweepExpiredSources();
      assert.equal(result.deleted_sources, 1);
      assert.equal(result.deleted_children, 4);
      assert.equal((await ref.get()).exists, false, 'ה-sweeper השאיר את האב');
      for (const group of SOURCE_GROUPS) {
        assert.equal((await ref.collection(group).get()).size, 0,
          'ה-sweeper השאיר ילדים ב-' + group);
      }
    } finally {
      await deleteSourceTree(ref);
    }
  });

  await test('the source sweeper leaves future, complete, active and live-operation sources untouched', async () => {
    const runtimeBefore = (await runtimeDoc().get()).data() || {};
    const futureRef = await writeExpiredStage('sweep_future', 'sweep_req_future', {
      people: ['future_person']
    }, { expires_at: new Date(Date.parse(CLOCK()) + 60 * 60 * 1000) });
    const completeRef = await writeExpiredStage('sweep_complete', 'sweep_req_complete', {
      people: ['complete_person']
    }, { complete: true });
    const activeRefValue = await writeExpiredStage('sweep_active', 'sweep_req_active', {
      people: ['active_person']
    });
    const liveRef = await writeExpiredStage('sweep_live_op', 'sweep_req_live_op', {
      people: ['live_person']
    });
    const liveOp = sourceOperationRef('sweep_req_live_op');
    try {
      await runtimeDoc().set({ active_source_id: activeRefValue.id }, { merge: true });
      await liveOp.set({
        status: 'pending', owner_token: 'live_writer', request_hash: 'live_hash',
        lease_until: new Date(Date.parse(CLOCK()) + 60 * 60 * 1000)
      });
      const result = await api.sweepExpiredSources();
      assert.equal(result.deleted_sources, 0);
      for (const ref of [futureRef, completeRef, activeRefValue, liveRef]) {
        assert.equal((await ref.get()).exists, true, 'מקור מוגן נמחק: ' + ref.id);
        assert.equal((await ref.collection('people').get()).size, 1,
          'ילד של מקור מוגן נמחק: ' + ref.id);
      }
    } finally {
      await runtimeDoc().set({ active_source_id: runtimeBefore.active_source_id || null }, { merge: true });
      await liveOp.delete();
      for (const ref of [futureRef, completeRef, activeRefValue, liveRef]) {
        await deleteSourceTree(ref);
      }
    }
  });

  await test('only one concurrent source sweeper owns a live cleanup lease', async () => {
    const ref = await writeExpiredStage('sweep_concurrent', 'sweep_req_concurrent', {
      people: ['person_a', 'person_b']
    });
    let releaseClaim;
    let claimArrived;
    const gate = new Promise((resolve) => { releaseClaim = resolve; });
    const arrived = new Promise((resolve) => { claimArrived = resolve; });
    const first = runtime({
      afterSourceSweepClaim: async (info) => {
        if (!info || info.ref.path !== ref.path) return;
        claimArrived();
        await gate;
      }
    });
    let firstPromise = null;
    try {
      firstPromise = first.sweepExpiredSources();
      await bounded(arrived, 'first sweeper claim');
      const second = await api.sweepExpiredSources();
      assert.equal(second.deleted_sources, 0, 'sweeper שני מחק מקור בבעלות חיה');
      assert.ok(second.skipped >= 1, 'sweeper שני לא דיווח על דילוג claim');
      assert.equal((await ref.get()).exists, true, 'המקור נמחק לפני שחרור הבעלים');
      releaseClaim();
      const winner = await bounded(firstPromise, 'first sweeper completion');
      assert.equal(winner.deleted_sources, 1);
      assert.equal((await ref.get()).exists, false);
    } finally {
      releaseClaim();
      if (firstPromise) await firstPromise.catch(() => {});
      await deleteSourceTree(ref);
    }
  });

  await test('a crashed source sweep keeps its parent anchor and a later run resumes safely', async () => {
    const ref = await writeExpiredStage('sweep_crash_resume', 'sweep_req_crash', {
      people: ['person_a', 'person_b'], events: ['event_a']
    });
    let now = Date.parse(CLOCK());
    let chunks = 0;
    const crashing = runtime({
      clock: () => new Date(now).toISOString(),
      sourceSweepChunkSize: 1,
      afterSourceSweepChunk: async () => {
        chunks += 1;
        if (chunks === 1) throw new Error('intentional source sweep crash');
      },
      reportError: () => {}
    });
    try {
      const error = await caught(() => crashing.sweepExpiredSources());
      assert.ok(error, 'קריסת sweep לא הוחזרה כשגיאה');
      assert.equal(error.code, 'source-sweep-partial-failure');
      assert.equal((await ref.get()).exists, true, 'קריסה מחקה את עוגן האב');
      assert.equal((await ref.collection('people').get()).size, 1,
        'הקריסה לא התרחשה אחרי chunk יחיד');

      now += 11 * 60 * 1000;
      const resumed = await runtime({ clock: () => new Date(now).toISOString() })
        .sweepExpiredSources();
      assert.equal(resumed.deleted_sources, 1);
      assert.equal((await ref.get()).exists, false);
      for (const group of SOURCE_GROUPS) {
        assert.equal((await ref.collection(group).get()).size, 0,
          'resume השאיר orphan ב-' + group);
      }
    } finally {
      await deleteSourceTree(ref);
    }
  });

  await test('the source sweep child cap retains and releases the parent for the next run', async () => {
    const ref = await writeExpiredStage('sweep_bounded', 'sweep_req_bounded', {
      people: ['person_a', 'person_b', 'person_c']
    });
    try {
      const limited = await runtime({
        sourceSweepChildLimit: 1,
        sourceSweepChunkSize: 1
      }).sweepExpiredSources();
      assert.equal(limited.deleted_children, 1);
      assert.equal(limited.deleted_sources, 0);
      assert.equal(limited.pending, 1);
      const retained = await ref.get();
      assert.equal(retained.exists, true, 'ה-cap מחק אב עם ילדים');
      assert.equal((await ref.collection('people').get()).size, 2);
      assert.equal(Object.prototype.hasOwnProperty.call(retained.data() || {}, 'cleanup_claimed_by'),
        false, 'claim לא שוחרר אחרי עצירה מתוכננת');

      const resumed = await api.sweepExpiredSources();
      assert.equal(resumed.deleted_sources, 1);
      assert.equal((await ref.get()).exists, false);
    } finally {
      await deleteSourceTree(ref);
    }
  });

  /* ================================================================
   * 4 · מטריצת המצב
   * ================================================================ */

  await test('a schedule manager alone cannot move the engine mode', async () => {
    const error = await caught(() => api.setRuntimeMode(req('manager', 'firefighter', {
      request_id: 'mode_mgr', target: 'shadow', expected_mode: 'off',
      confirmation: 'shadow', reason_code: 'initial_activation'
    })));
    assert.ok(error, 'אחראי סידור הזיז מצב');
    assert.equal(error.code, 'mode-authority-forbidden');
    assert.equal(error.httpCode, 'permission-denied');
  });

  await test('a station_commander cannot move the engine mode either', async () => {
    const error = await caught(() => api.setRuntimeMode(req('station_cmd', 'station_commander', {
      request_id: 'mode_sc', target: 'shadow', expected_mode: 'off',
      confirmation: 'shadow', reason_code: 'initial_activation'
    })));
    assert.ok(error, 'station_commander הזיז מצב');
    assert.equal(error.code, 'mode-authority-forbidden');
    assert.equal(error.httpCode, 'permission-denied');
  });

  await test('the generic mode setter cannot activate new', async () => {
    const error = await caught(() => api.setRuntimeMode(req('commander', 'commander', {
      request_id: 'mode_jump', target: 'new', expected_mode: 'off',
      confirmation: 'new', reason_code: 'initial_activation'
    })));
    assert.ok(error, 'הפעלת new דרך המתג הכללי עברה');
    assert.equal(error.code, 'cutover-required');
    assert.equal(error.httpCode, 'failed-precondition');
  });

  await test('a role revoked before the mode transaction cannot enable shadow', async () => {
    const commanderRef = station().collection('users').doc('commander');
    const commanderBefore = (await commanderRef.get()).data() || {};
    const runtimeBefore = (await runtimeDoc().get()).data() || {};
    let hooks = 0;
    const hooked = runtime({
      beforeSnapshotFinalize: async (info) => {
        if (!info || info.kind !== 'mode') return;
        hooks += 1;
        await commanderRef.set({ role: 'firefighter' }, { merge: true });
      }
    });
    try {
      const error = await caught(() => hooked.setRuntimeMode(req('commander', 'commander', {
        request_id: 'mode_role_race', target: 'shadow', expected_mode: 'off',
        confirmation: 'shadow', reason_code: 'initial_activation'
      })));
      assert.ok(error, 'הסרת תפקיד פיקודי בזמן הפעולה לא נחסמה');
      assert.equal(error.code, 'mode-authority-forbidden');
      assert.equal(error.httpCode, 'permission-denied');
      assert.equal(hooks, 1);
      assert.deepEqual((await runtimeDoc().get()).data() || {}, runtimeBefore);
      assert.equal((await station().collection('schedule_mode_operations')
        .doc('mode_role_race').get()).exists, false);
      assert.equal((await station().collection('schedule_mode_audit')
        .where('request_id', '==', 'mode_role_race').get()).size, 0);
    } finally {
      await commanderRef.set(commanderBefore);
    }
  });

  await test('a commander moves off to shadow', async () => {
    const result = await api.setRuntimeMode(req('commander', 'commander', {
      request_id: 'mode_shadow', target: 'shadow', expected_mode: 'off',
      confirmation: 'shadow', reason_code: 'initial_activation'
    }));
    assert.ok(result);
    assert.equal(((await runtimeDoc().get()).data() || {}).mode, 'shadow');
  });

  await test('a stale expected_mode is refused', async () => {
    const error = await caught(() => api.setRuntimeMode(req('commander', 'commander', {
      request_id: 'mode_stale', target: 'off', expected_mode: 'off',
      confirmation: 'off', reason_code: 'operational_safety'
    })));
    assert.ok(error, 'expected_mode ישן לא נחסם');
    assert.equal(error.code, 'mode-conflict');
    assert.equal(error.httpCode, 'aborted');
  });

  await test('commander, deputy and super cannot activate new even when ready', async () => {
    const options = await api.getModeOptions(req('commander', 'commander', {}));
    assert.equal(options.ready, true, 'הפיקסצ׳ר אינו מוכן ולכן אינו מוכיח containment');
    assert.deepEqual(options.targets.map((target) => target.to), ['off'],
      'שרת האפשרויות עדיין מציע new ב-shadow');
    const actors = [
      { uid: 'commander', role: 'commander', api, requestId: 'mode_new_commander' },
      { uid: 'deputy', role: 'deputy', api, requestId: 'mode_new_deputy' },
      { uid: 'viewer', role: 'firefighter',
        api: runtime({ isSuper: (auth) => auth && auth.uid === 'viewer' }),
        requestId: 'mode_new_super' }
    ];
    for (const actor of actors) {
      const error = await caught(() => actor.api.setRuntimeMode(req(actor.uid, actor.role, {
        request_id: actor.requestId, target: 'new', expected_mode: 'shadow',
        confirmation: 'new', reason_code: 'validation_complete'
      })));
      assert.ok(error, actor.uid + ' הפעיל new דרך המתג הכללי');
      assert.equal(error.code, 'cutover-required');
      assert.equal(error.httpCode, 'failed-precondition');
      assert.equal((await station().collection('schedule_mode_operations')
        .doc(actor.requestId).get()).exists, false,
      actor.uid + ' השאיר operation למרות חסימת ההפעלה');
    }
    assert.equal(((await runtimeDoc().get()).data() || {}).mode, 'shadow');
  });

  await test('shadow to off and off to shadow remain available', async () => {
    const disabled = await api.setRuntimeMode(req('deputy', 'deputy', {
      request_id: 'mode_shadow_off', target: 'off', expected_mode: 'shadow',
      confirmation: 'off', reason_code: 'operational_safety'
    }));
    assert.equal(disabled.to, 'off');
    assert.equal(((await runtimeDoc().get()).data() || {}).mode, 'off');
    const restored = await api.setRuntimeMode(req('commander', 'commander', {
      request_id: 'mode_off_shadow_again', target: 'shadow', expected_mode: 'off',
      confirmation: 'shadow', reason_code: 'initial_activation'
    }));
    assert.equal(restored.to, 'shadow');
    assert.equal(((await runtimeDoc().get()).data() || {}).mode, 'shadow');
  });

  await test('malformed locked source is rejected before any draft write', async () => {
    const ref = station().collection('schedule_sources').doc(sourceId);
    const lockRef = ref.collection('locked').doc('a');
    const foreignRef = ref.collection('locked').doc('foreign');
    const canonicalDays = {
      '2026-09-01': [{ person: 'worker_b', role: 'firefighter' }]
    };
    const cases = [
      {
        requestId: 'plan_lock_shape', code: 'source-locked-shape',
        arrange: () => lockRef.set({ days: { '2026-09-01': 'worker_b' } })
      },
      {
        requestId: 'plan_lock_date', code: 'source-locked-date-invalid',
        arrange: () => lockRef.set({ days: { '2026-02-30': [] } })
      },
      {
        requestId: 'plan_lock_person', code: 'source-locked-person-unknown',
        arrange: () => lockRef.set({
          days: { '2026-09-01': [{ person: 'missing_worker', role: 'firefighter' }] }
        })
      },
      {
        requestId: 'plan_lock_role', code: 'source-locked-role-unknown',
        arrange: () => lockRef.set({
          days: { '2026-09-01': [{ person: 'worker_b', role: 'pilot' }] }
        })
      },
      {
        requestId: 'plan_lock_sub', code: 'source-locked-sub-station-unknown',
        arrange: () => foreignRef.set({
          days: { '2026-09-01': [{ person: 'worker_b', role: 'firefighter' }] }
        })
      }
    ];
    for (const item of cases) {
      await lockRef.set({ days: canonicalDays });
      await foreignRef.delete();
      await item.arrange();
      await resignSource(ref);
      const error = await caught(() => api.runPlanner(req('manager', 'firefighter', {
        request_id: item.requestId, start: '2026-09-01', months: 1, overrides: []
      })));
      assert.ok(error, item.requestId + ' לא נחסם');
      assert.equal(error.code, item.code, item.requestId + ' נחסם מסיבה שגויה');
      assert.equal((await draftRefFor(item.requestId).get()).exists, false,
        item.requestId + ' כתב טיוטה למרות מקור פגום');
    }
    await foreignRef.delete();
    await lockRef.set({ days: canonicalDays });
    await resignSource(ref);
  });

  /* ================================================================
   * 5 · ⭐ P0-2 · הכנה ומעבר
   * ================================================================ */

  await test('publishing while in shadow prepares and notifies nobody', async () => {
    const draft = await api.runPlanner(req('manager', 'firefighter', {
      request_id: 'plan_1', start: '2026-09-01', months: 1, overrides: []
    }));
    assert.ok(draft && draft.draft_id, 'המנוע לא בנה טיוטה ב-shadow');
    assert.equal(draft.summary.blocking_gaps, 0, 'הפיקסצ׳ר יצר חוסר תפקיד חוסם');
    assert.equal(draft.summary.days_below_minimum, 0, 'הפיקסצ׳ר ירד מתחת לקו המינימום');
    assert.equal(draft.summary.rejected_manual, 0, 'השיבוץ הידני בפיקסצ׳ר נדחה');
    const storedRows = await station().collection('schedule_drafts')
      .doc(draft.draft_id).collection('rows').get();
    const manualRow = storedRows.docs.map((doc) => (doc.data() || {}).row)
      .find((row) => row && row.date === '2026-09-01' && row.sub_station === 'a');
    assert.ok(manualRow, 'תחנת קצה חוקית בתו יחיד לא הופיעה בטיוטה');
    assert.ok((manualRow.slots || []).some((slot) => slot.person === 'worker_b'
      && slot.role === 'firefighter' && slot.source === 'manual'),
    'השיבוץ הידני הקנוני לא הגיע לטיוטה מקצה לקצה');
    const preview = await api.getDraftPreview(req('manager', 'firefighter', {
      draft_id: draft.draft_id, start: '2026-09-01'
    }));
    const result = await api.publish(req('manager', 'firefighter', {
      request_id: 'pub_1', draft_id: draft.draft_id,
      expected_content_digest: preview.expected_content_digest
    }));
    assert.equal(result.prepared, true, 'פרסום ב-shadow הפעיל במקום להכין');
    assert.equal(result.notified_people, 0, 'הכנה שלחה הודעות');
    const pub = (await station().collection('schedule_publications')
      .doc(result.publication_id).get()).data() || {};
    assert.equal(pub.status, 'prepared');
    assert.equal(pub.snapshot_complete, true, 'הפרסום המוכן אינו תמונה שלמה');
    assert.equal(pub.content_digest, preview.expected_content_digest,
      'הפרסום המוכן אינו קשור לטיוטה שנבדקה');
    // ⭐ המצביע לא זז, ולכן אין סידור פעיל.
    const pointer = await station().collection('schedule_state').doc('active').get();
    assert.equal(pointer.exists, false, 'המצביע זז בזמן הכנה');
    // וההודעות ממתינות חסומות, לא בוטלו.
    const outbox = await station().collection('schedule_publications')
      .doc(result.publication_id).collection('schedule_outbox').get();
    assert.ok(outbox.size > 0, 'לא נוצרו הודעות ממתינות');
    assert.equal(result.blocked_notifications, outbox.size,
      'ספירת ההודעות החסומות אינה תואמת ל-outbox');
    outbox.docs.forEach((doc) => assert.equal((doc.data() || {}).status, 'blocked'));
    preparedId = result.publication_id;
    preparedDraftId = draft.draft_id;
    preparedDigest = preview.expected_content_digest;
  });

  await test('shadow never treats a prepared request as an active replay or releases it', async () => {
    const publicationRef = station().collection('schedule_publications').doc(preparedId);
    const activeRef = station().collection('schedule_state').doc('active');
    const originalPublication = (await publicationRef.get()).data() || {};
    const outboxBefore = await collectionState(publicationRef.collection('schedule_outbox'));
    try {
      await publicationRef.set({ status: 'active' }, { merge: true });
      await activeRef.set({
        publication_id: preparedId, revision: originalPublication.revision,
        content_digest: originalPublication.content_digest
      });
      const error = await caught(() => api.publish(req('manager', 'firefighter', {
        request_id: 'pub_1', draft_id: preparedDraftId,
        expected_content_digest: preparedDigest
      })));
      assert.ok(error, 'shadow accepted an active-publication replay');
      assert.ok(['publication-conflict', 'publication-prepared-replay-invalid'].includes(error.code));
      const outboxAfter = await collectionState(publicationRef.collection('schedule_outbox'));
      assert.equal(stableValue(outboxAfter), stableValue(outboxBefore),
        'shadow active replay released or rewrote an outbox row');
      outboxAfter.forEach((row) => assert.equal(row.data.status, 'blocked'));
    } finally {
      await publicationRef.set(originalPublication);
      await activeRef.delete();
    }
  });

  await test('a lost prepared response replays without any write or audit', async () => {
    const publicationRef = station().collection('schedule_publications').doc(preparedId);
    const draftBefore = (await station().collection('schedule_drafts')
      .doc(preparedDraftId).get()).data() || {};
    const auditQuery = station().collection('schedule_audit')
      .where('publication_id', '==', preparedId);
    const before = {
      publication: (await publicationRef.get()).data() || {},
      rows: await collectionState(publicationRef.collection('rows')),
      events: await collectionState(publicationRef.collection('events')),
      people: await collectionState(publicationRef.collection('people')),
      outbox: await collectionState(publicationRef.collection('schedule_outbox')),
      audit: await collectionState(auditQuery)
    };
    assert.notEqual(draftBefore.source_digest, draftBefore.base_source_digest,
      'the fixture does not distinguish effective and base source digests');
    assert.equal(before.publication.source_digest, draftBefore.source_digest,
      'the publication did not preserve the draft effective source digest');
    for (const field of [
      'source_snapshot', 'source_version', 'contract_station_id',
      'source_revision', 'source_digest', 'source_complete',
      'policy_version', 'policy_digest'
    ]) {
      assert.equal(before.publication[field], draftBefore[field],
        'the publication detached ' + field + ' from its draft');
    }
    const replay = await api.publish(req('manager', 'firefighter', {
      request_id: 'pub_1', draft_id: preparedDraftId,
      expected_content_digest: preparedDigest
    }));
    assert.deepEqual(replay, {
      duplicate: true, prepared: true, publication_id: preparedId,
      revision: 1, notified_people: 0,
      blocked_notifications: before.outbox.length,
      summary: before.publication.summary
    });
    const after = {
      publication: (await publicationRef.get()).data() || {},
      rows: await collectionState(publicationRef.collection('rows')),
      events: await collectionState(publicationRef.collection('events')),
      people: await collectionState(publicationRef.collection('people')),
      outbox: await collectionState(publicationRef.collection('schedule_outbox')),
      audit: await collectionState(auditQuery)
    };
    assert.equal(stableValue(after), stableValue(before),
      'prepared replay wrote snapshot, outbox or audit data');
    assert.equal((await station().collection('schedule_state').doc('active').get()).exists,
      false, 'prepared replay moved the active pointer');
  });

  await test('prepared replay fails closed on every signed publication invariant', async () => {
    const publicationRef = station().collection('schedule_publications').doc(preparedId);
    const original = (await publicationRef.get()).data() || {};
    const cases = [
      ['status', 'complete'],
      ['snapshot_complete', false],
      ['content_digest', 'bad_digest'],
      ['source_draft_id', 'other_draft'],
      ['published_by', 'other_manager'],
      ['revision', 2],
      ['previous_publication_id', 'other_publication'],
      ['source_snapshot', 'other_snapshot'],
      ['source_version', 'other_source_version'],
      ['contract_station_id', 'other_station'],
      ['source_revision', 'other_source_revision'],
      ['source_digest', 'bad_source_digest'],
      ['source_complete', false],
      ['policy_version', 'other_policy_version'],
      ['policy_digest', 'bad_policy_digest']
    ];
    for (const [field, invalid] of cases) {
      await publicationRef.set(Object.assign({}, original, { [field]: invalid }));
      const error = await caught(() => api.publish(req('manager', 'firefighter', {
        request_id: 'pub_1', draft_id: preparedDraftId,
        expected_content_digest: preparedDigest
      })));
      assert.ok(error, field + ' mismatch was accepted as a prepared replay');
      assert.ok(['publication-prepared-replay-invalid', 'publication-conflict']
        .includes(error.code), field + ' failed with an unrelated error: ' + error.code);
      assert.equal((await station().collection('schedule_state').doc('active').get()).exists,
        false, field + ' mismatch moved the active pointer');
    }
    await publicationRef.set(original);
  });

  await test('prepared replay requires the exact complete blocked outbox manifest', async () => {
    const publicationRef = station().collection('schedule_publications').doc(preparedId);
    const outbox = await publicationRef.collection('schedule_outbox').get();
    assert.ok(outbox.size > 0, 'the prepared fixture has no outbox to corrupt');
    const first = outbox.docs[0];
    const original = first.data() || {};
    const replay = () => api.publish(req('manager', 'firefighter', {
      request_id: 'pub_1', draft_id: preparedDraftId,
      expected_content_digest: preparedDigest
    }));
    try {
      await first.ref.delete();
      let error = await caught(replay);
      assert.ok(error, 'a missing outbox row was accepted');
      assert.equal(error.code, 'publication-prepared-replay-invalid');
      await first.ref.set(original);

      await first.ref.set({ status: 'queued' }, { merge: true });
      error = await caught(replay);
      assert.ok(error, 'a non-blocked outbox row was accepted');
      assert.equal(error.code, 'publication-prepared-replay-invalid');
      await first.ref.set(original);

      await first.ref.set({ expires_at: new Date(Date.parse(CLOCK()) - 1) }, { merge: true });
      error = await caught(replay);
      assert.ok(error, 'an expired outbox row was accepted');
      assert.equal(error.code, 'publication-prepared-replay-invalid');
      await first.ref.set(original);

      for (const [field, invalid] of [
        ['station_id', 'other_station'],
        ['publication_id', 'other_publication'],
        ['revision', Number(original.revision) + 1],
        ['person', 'other_person'],
        ['dedupe_key', original.dedupe_key + ':tampered'],
        ['changed_by', 'other_manager'],
        ['attempt', 1],
        ['push', { title: 'tampered' }],
        ['detail', { kind: 'tampered' }]
      ]) {
        await first.ref.set(Object.assign({}, original, { [field]: invalid }));
        error = await caught(replay);
        assert.ok(error, 'a modified outbox ' + field + ' was accepted');
        assert.equal(error.code, 'publication-prepared-replay-invalid');
        await first.ref.set(original);
      }

      const extraRef = publicationRef.collection('schedule_outbox').doc('n_unexpected');
      await extraRef.set(original);
      error = await caught(replay);
      assert.ok(error, 'an unexpected outbox row was accepted');
      assert.equal(error.code, 'publication-prepared-replay-invalid');
      await extraRef.delete();
    } finally {
      await first.ref.set(original);
      await publicationRef.collection('schedule_outbox').doc('n_unexpected').delete();
    }
  });

  await test('prepared replay rechecks live authority after its race boundary', async () => {
    const accessRef = station().collection('schedule_access').doc('manager');
    const original = (await accessRef.get()).data() || {};
    let hooks = 0;
    const hooked = runtime({
      beforeSnapshotFinalize: async (info) => {
        if (!info || info.kind !== 'prepared-replay') return;
        hooks += 1;
        await accessRef.set({ active: false }, { merge: true });
      }
    });
    try {
      const error = await caught(() => hooked.publish(req('manager', 'firefighter', {
        request_id: 'pub_1', draft_id: preparedDraftId,
        expected_content_digest: preparedDigest
      })));
      assert.ok(error, 'revoked manager replayed a prepared publication');
      assert.equal(error.code, 'manager-revoked');
      assert.equal(error.httpCode, 'permission-denied');
      assert.equal(hooks, 1);
      assert.equal((await station().collection('schedule_state').doc('active').get()).exists,
        false, 'revoked replay moved the active pointer');
    } finally {
      await accessRef.set(original);
    }
  });

  await test('prepared replay rejects runtime and predecessor drift after its first reads', async () => {
    const runtimeRef = runtimeDoc();
    const originalRuntime = (await runtimeRef.get()).data() || {};
    const activeRef = station().collection('schedule_state').doc('active');
    const request = () => req('manager', 'firefighter', {
      request_id: 'pub_1', draft_id: preparedDraftId,
      expected_content_digest: preparedDigest
    });
    const modeHooked = runtime({
      beforeSnapshotFinalize: async (info) => {
        if (info && info.kind === 'prepared-replay') {
          await runtimeRef.set({ mode: 'off' }, { merge: true });
        }
      }
    });
    try {
      let error = await caught(() => modeHooked.publish(request()));
      assert.ok(error, 'runtime mode drift was accepted');
      assert.equal(error.code, 'publication-prepared-replay-invalid');
    } finally {
      await runtimeRef.set(originalRuntime);
    }

    const pointerHooked = runtime({
      beforeSnapshotFinalize: async (info) => {
        if (info && info.kind === 'prepared-replay') {
          await activeRef.set({
            publication_id: 'other_publication', revision: 1,
            content_digest: 'other_digest'
          });
        }
      }
    });
    try {
      const error = await caught(() => pointerHooked.publish(request()));
      assert.ok(error, 'active predecessor drift was accepted');
      assert.equal(error.code, 'publication-prepared-replay-invalid');
    } finally {
      await activeRef.delete();
    }
  });

  await test('a prepared publication with an exact empty outbox also replays safely', async () => {
    function createZeroNotificationService(deps) {
      const base = createScheduleService(deps);
      return Object.freeze(Object.assign({}, base, {
        publish(input) {
          const planned = base.publish(input);
          return Object.freeze(Object.assign({}, planned, {
            notifications: Object.freeze([])
          }));
        }
      }));
    }
    const zeroApi = runtime({ createService: createZeroNotificationService });
    const first = await zeroApi.publish(req('manager', 'firefighter', {
      request_id: 'pub_zero_notifications', draft_id: preparedDraftId,
      expected_content_digest: preparedDigest
    }));
    assert.equal(first.prepared, true);
    assert.equal(first.blocked_notifications, 0);
    const zeroRef = station().collection('schedule_publications').doc(first.publication_id);
    assert.equal((await zeroRef.collection('schedule_outbox').get()).size, 0);
    const auditBefore = await station().collection('schedule_audit')
      .where('publication_id', '==', first.publication_id).get();
    const replay = await zeroApi.publish(req('manager', 'firefighter', {
      request_id: 'pub_zero_notifications', draft_id: preparedDraftId,
      expected_content_digest: preparedDigest
    }));
    assert.equal(replay.duplicate, true);
    assert.equal(replay.prepared, true);
    assert.equal(replay.publication_id, first.publication_id);
    assert.equal(replay.revision, first.revision);
    assert.equal(replay.notified_people, 0);
    assert.equal(replay.blocked_notifications, 0);
    assert.deepEqual(replay.summary, first.summary);
    assert.equal((await station().collection('schedule_audit')
      .where('publication_id', '==', first.publication_id).get()).size, auditBefore.size,
    'empty-manifest replay wrote a duplicate audit');
    assert.equal((await zeroRef.collection('schedule_outbox').get()).size, 0,
      'empty-manifest replay created an outbox row');
  });

  await test('resumeOutbox does not cancel a prepared publication while it waits', async () => {
    await api.resumeOutbox();
    const outbox = await station().collection('schedule_publications')
      .doc(preparedId).collection('schedule_outbox').get();
    assert.ok(outbox.size > 0, 'בדיקת ה-resume לא מצאה הודעות לבדיקה');
    // ⭐ בלי התיקון בשומרי המתזמן, כל אלה היו מבוטלות — והמעבר היה
    // קורה בלי שאיש יקבל הודעה.
    outbox.docs.forEach((doc) =>
      assert.equal((doc.data() || {}).status, 'blocked',
        'הודעה של פרסום מוכן בוטלה בזמן ההמתנה'));
  });

  await test('a viewer in shadow sees the legacy schedule, never an empty board', async () => {
    const view = await api.getMy(req('viewer', 'firefighter', { date: '2026-09-01' }));
    assert.equal(view.mode, 'shadow');
    assert.equal(view.source, 'legacy');
    assert.equal(view.active, true);
    assert.deepEqual(view.provenance, {
      mode: 'shadow', source: 'legacy', publication_id: null,
      revision: null, content_digest: null
    });
    assert.equal(view.days.length, 0, 'viewer ללא צוות הוצג בטעות כמשובץ');
    assert.deepEqual(view.events.map((event) => event.id), ['guard_shadow_viewer']);
    assert.equal((await station().collection('schedule_state').doc('active').get()).exists,
      false, 'פרסום מוכן הזיז את המצביע הפעיל');
  });

  await test('shadow to new is refused as a direct mode change', async () => {
    /* ⭐ המסלול היחיד ל-new הוא המעבר החתום. החלפת מצב ישירה — גם
     * בידי מפקד — משאירה את התחנה בלי לוח, ולכן נדחית בקוד משלה. */
    const runtimeBefore = (await runtimeDoc().get()).data() || {};
    const error = await caught(() => api.setRuntimeMode(req('commander', 'commander', {
      request_id: 'mode_direct_new', target: 'new', expected_mode: 'shadow',
      confirmation: 'new', reason_code: 'initial_activation'
    })));
    assert.ok(error, 'מעבר ישיר ל-new עבר');
    assert.equal(error.code, 'cutover-required');
    assert.deepEqual((await runtimeDoc().get()).data() || {}, runtimeBefore);
    assert.equal((await station().collection('schedule_mode_operations')
      .doc('mode_direct_new').get()).exists, false);
  });

  await test('a schedule manager cannot even preview the cutover', async () => {
    /* ⭐ P0-2. הבדיקה הזאת הצהירה בעבר ש-`manager` מקבל דוח; זה היה
     * `requireManager` שנעל את המפקד בחוץ ופתח את השלב הראשון למי
     * שאינו רשאי לבצע את השני. שער אחד לשני השלבים: פיקוד. */
    const error = await caught(() => api.previewCutover(req('manager', 'firefighter', {
      candidate_publication_id: preparedId
    })));
    assert.ok(error, 'אחראי סידור קיבל דוח מעבר');
    assert.equal(error.code, 'mode-authority-forbidden');
    assert.equal((await station().collection('schedule_preflight')
      .doc(preparedId).get()).exists, false, 'דוח נכתב למרות הסירוב');
  });

  await test('previewCutover signs a report that carries no identifiers', async () => {
    const candidateRows = await station().collection('schedule_publications')
      .doc(preparedId).collection('rows').get();
    const expectedDates = new Set(candidateRows.docs.map((doc) => {
      const stored = doc.data() || {};
      return String((stored.row || {}).date || '');
    }).filter(Boolean));
    assert.ok(expectedDates.size > 0, 'הפרסום המוכן ריק ולכן ה-preflight אינו נבדק');
    const report = await api.previewCutover(req('commander', 'commander', {
      candidate_publication_id: preparedId
    }));
    assert.ok(report.signature, 'הדוח אינו חתום');
    assert.equal(report.counts.next_days, expectedDates.size,
      'ה-preflight לא ספר במדויק את ימי הפרסום המוכן');
    assert.ok(report.counts.next_days > 0,
      'ה-preflight חזר ירוק על מועמד ריק');
    assert.ok(report.expires_at && report.generated_at, 'הדוח ללא זמן ותפוגה');
    assert.ok(report.changes && Number.isInteger(report.changes.count),
      'הדוח אינו מונה שינויים מול הסידור הקיים');
    assert.equal(report.by_reason[CUTOVER_REASON.MISSING], 0,
      'פיקסצ׳ר התצוגה יצר MISSING מלאכותי בדוח המעבר');
    assert.equal(report.by_reason[CUTOVER_REASON.FOREIGN], 0,
      'ה-preflight מצא שיבוץ למזהה שאינו במקור');
    assert.equal(report.by_reason[CUTOVER_REASON.DUPLICATE], 0,
      'ה-preflight מצא שיבוץ כפול באותו יום');
    assert.equal(report.by_reason[CUTOVER_REASON.OUT_OF_RANGE], 0,
      'ה-preflight מצא יום מחוץ לטווח הפרסום');
    assert.equal(report.blocked, false, 'דוח המעבר נחסם על פיקסצ׳ר legacy');
    const text = JSON.stringify(report);
    for (const uid of ['manager', 'viewer', 'commander',
      'worker_a', 'worker_b', 'worker_c', 'worker_d', 'worker_e', 'worker_f',
      '9001', '9002', '9003', '9004', '9005', '9006']) {
      assert.equal(text.indexOf(uid), -1, 'הדוח מכיל מזהה: ' + uid);
    }
    const stored = (await station().collection('schedule_preflight')
      .doc(preparedId).get()).data() || {};
    assert.equal(stored.signature, report.signature);
    /* ⭐ P0-4. השדות החתומים חייבים לשרוד את Firestore. `expires_at`
     * נשמר כפי שנחתם; ה-TTL יושב בשדה נפרד. אחרת החתימה נשברת
     * מול עצמה בקריאה הבאה — וכל מעבר נחסם. */
    assert.equal(stored.expires_at, report.expires_at, 'expires_at החתום נדרס');
    assert.ok(stored.ttl_expires_at && typeof stored.ttl_expires_at.toDate === 'function',
      'אין ttl_expires_at נפרד לתפוגת המסמך');
    preflightSignature = report.signature;
    preflightChanges = Number(report.changes.count || 0);
  });

  await test('promotion without the exact report signature is refused', async () => {
    const runtimeBefore = (await runtimeDoc().get()).data() || {};
    const missing = await caught(() => api.promoteToNew(req('commander', 'commander', {
      request_id: 'cut_nosig', candidate_publication_id: preparedId,
      expected_mode: 'shadow'
    })));
    assert.ok(missing, 'מעבר בלי חתימת דוח עבר');
    assert.equal(missing.code, 'cutover-signature-required');
    const wrong = await caught(() => api.promoteToNew(req('commander', 'commander', {
      request_id: 'cut_badsig', candidate_publication_id: preparedId,
      expected_mode: 'shadow', expected_preflight_signature: 'not-the-report'
    })));
    assert.ok(wrong, 'מעבר עם חתימה זרה עבר');
    assert.equal(wrong.code, 'cutover-signature-mismatch');
    assert.deepEqual((await runtimeDoc().get()).data() || {}, runtimeBefore);
    assert.equal(((await station().collection('schedule_publications')
      .doc(preparedId).get()).data() || {}).status, 'prepared');
    for (const id of ['cut_nosig', 'cut_badsig']) {
      assert.equal((await station().collection('schedule_mode_operations')
        .doc(id).get()).exists, false, 'רשומת פעולה נכתבה לבקשה שנדחתה: ' + id);
    }
  });

  await test('a schedule manager cannot perform the cutover', async () => {
    const error = await caught(() => api.promoteToNew(req('manager', 'firefighter', {
      request_id: 'cut_mgr', candidate_publication_id: preparedId,
      expected_mode: 'shadow', expected_preflight_signature: preflightSignature,
      accept_changes: preflightChanges > 0 ? preflightSignature : undefined
    })));
    assert.ok(error, 'אחראי סידור ביצע מעבר');
    assert.equal(error.code, 'mode-authority-forbidden');
  });

  await test('a role revoked before the cutover transaction cannot promote', async () => {
    const commanderRef = station().collection('users').doc('commander');
    const commanderBefore = (await commanderRef.get()).data() || {};
    const runtimeBefore = (await runtimeDoc().get()).data() || {};
    const activeBefore = await station().collection('schedule_state').doc('active').get();
    const publicationRef = station().collection('schedule_publications').doc(preparedId);
    const outboxBefore = await publicationRef.collection('schedule_outbox').get();
    assert.ok(outboxBefore.size > 0);
    let hooks = 0;
    const hooked = runtime({
      beforeSnapshotFinalize: async (info) => {
        if (!info || info.kind !== 'cutover') return;
        hooks += 1;
        await commanderRef.set({ role: 'firefighter' }, { merge: true });
      }
    });
    try {
      const error = await caught(() => hooked.promoteToNew(req('commander', 'commander', {
        request_id: 'cut_role_race', candidate_publication_id: preparedId,
        expected_mode: 'shadow', expected_preflight_signature: preflightSignature,
        accept_changes: preflightChanges > 0 ? preflightSignature : undefined
      })));
      assert.ok(error, 'הסרת תפקיד פיקודי בזמן המעבר לא נחסמה');
      assert.equal(error.code, 'mode-authority-forbidden');
      assert.equal(error.httpCode, 'permission-denied');
      assert.equal(hooks, 1);
      assert.deepEqual((await runtimeDoc().get()).data() || {}, runtimeBefore);
      const activeAfter = await station().collection('schedule_state').doc('active').get();
      assert.equal(activeAfter.exists, activeBefore.exists);
      if (activeBefore.exists) assert.deepEqual(activeAfter.data(), activeBefore.data());
      assert.equal(((await publicationRef.get()).data() || {}).status, 'prepared');
      const outboxAfter = await publicationRef.collection('schedule_outbox').get();
      assert.equal(outboxAfter.size, outboxBefore.size);
      outboxAfter.docs.forEach((doc) => assert.equal((doc.data() || {}).status, 'blocked'));
      assert.equal((await station().collection('schedule_mode_operations')
        .doc('cut_role_race').get()).exists, false);
      assert.equal((await station().collection('schedule_mode_audit')
        .where('request_id', '==', 'cut_role_race').get()).size, 0);
    } finally {
      await commanderRef.set(commanderBefore);
    }
  });

  /* ⭐ A (seq379) · הסידור הישן משתנה **אחרי** ה-preview ולפני ה-commit.
   * הדוח נחתם על legacy_revision; ההפעלה קוראת את קלטי ה-legacy בתוך
   * העסקה, ולכן רואה את השינוי ודוחה. שום דבר לא זז. */
  await test('a legacy change between preview and commit is refused inside the transaction', async () => {
    const rosterRef = station().collection('roster').doc('worker_a');
    const runtimeBefore = (await runtimeDoc().get()).data() || {};
    const activeBefore = await station().collection('schedule_state').doc('active').get();
    const publicationRef = station().collection('schedule_publications').doc(preparedId);
    let hooks = 0;
    const hooked = runtime({
      beforeSnapshotFinalize: async (info) => {
        if (!info || info.kind !== 'cutover') return;
        hooks += 1;
        // אדם נכנס לצוות A במחזור הקיים — יום-אדם חדש ב-legacy.
        await rosterRef.set({ full_name: 'פרופיל אלף', crew: 'A', active: true });
      }
    });
    try {
      const error = await caught(() => hooked.promoteToNew(req('commander', 'commander', {
        request_id: 'cut_legacy_race', candidate_publication_id: preparedId,
        expected_mode: 'shadow', expected_preflight_signature: preflightSignature,
        accept_changes: preflightChanges > 0 ? preflightSignature : undefined
      })));
      assert.ok(error, 'שינוי בסידור הישן אחרי הבדיקה לא נחסם');
      assert.equal(error.code, 'cutover-preflight-stale');
      assert.equal(hooks, 1);
      assert.deepEqual((await runtimeDoc().get()).data() || {}, runtimeBefore);
      const activeAfter = await station().collection('schedule_state').doc('active').get();
      assert.equal(activeAfter.exists, activeBefore.exists);
      assert.equal(((await publicationRef.get()).data() || {}).status, 'prepared');
      assert.equal((await station().collection('schedule_mode_operations')
        .doc('cut_legacy_race').get()).exists, false, 'נכתבה רשומת פעולה למעבר שנדחה');
    } finally {
      await rosterRef.delete();
    }
  });

  /* ⭐ B (seq379) · תור ההודעות של המועמד נבדק ברגע ה-commit מול המניפסט
   * שנכתב בהכנה: שורה שפגה, שורה זרה, שורה חסרה — כולן מפנות להכנה
   * מחדש. אין חידוש פושים בשקט. */
  await test('a prepared candidate with a stale or altered outbox is not activated', async () => {
    const publicationRef = station().collection('schedule_publications').doc(preparedId);
    const manifest = ((await publicationRef.get()).data() || {}).outbox_manifest;
    assert.ok(manifest && Number.isInteger(manifest.count) && manifest.digest,
      'להכנה אין מניפסט תור');
    const outbox = await publicationRef.collection('schedule_outbox').get();
    assert.equal(outbox.size, manifest.count, 'המניפסט אינו סופר את התור');
    assert.ok(outbox.size > 0, 'הפיקסצ׳ר צריך לפחות שורת תור אחת לבדיקה הזאת');
    const first = outbox.docs[0];
    const firstBefore = first.data() || {};
    const runtimeBefore = (await runtimeDoc().get()).data() || {};
    const promote = (requestId) => caught(() => api.promoteToNew(req('commander', 'commander', {
      request_id: requestId, candidate_publication_id: preparedId,
      expected_mode: 'shadow', expected_preflight_signature: preflightSignature,
      accept_changes: preflightChanges > 0 ? preflightSignature : undefined
    })));
    try {
      // שורה שפגה.
      await first.ref.set({ expires_at: new Date(Date.now() - 60000) }, { merge: true });
      const expired = await promote('cut_outbox_expired');
      assert.ok(expired, 'תור שפג הופעל');
      assert.equal(expired.code, 'cutover-outbox-expired');
      await first.ref.set(firstBefore);
      // שורה זרה שנוספה לתור.
      const extraRef = publicationRef.collection('schedule_outbox').doc('n_unexpected_cutover');
      await extraRef.set(Object.assign({}, firstBefore, { person: 'stranger', dedupe_key: 'x' }));
      const extra = await promote('cut_outbox_extra');
      assert.ok(extra, 'תור עם שורה זרה הופעל');
      assert.equal(extra.code, 'cutover-outbox-manifest-mismatch');
      await extraRef.delete();
      // שורה שכבר שוחררה.
      await first.ref.set({ status: 'queued' }, { merge: true });
      const released = await promote('cut_outbox_released');
      assert.ok(released, 'תור ששוחרר חלקית הופעל');
      assert.equal(released.code, 'cutover-outbox-row-invalid');
    } finally {
      await first.ref.set(firstBefore);
    }
    assert.deepEqual((await runtimeDoc().get()).data() || {}, runtimeBefore);
    assert.equal(((await publicationRef.get()).data() || {}).status, 'prepared');
    for (const id of ['cut_outbox_expired', 'cut_outbox_extra', 'cut_outbox_released']) {
      assert.equal((await station().collection('schedule_mode_operations').doc(id).get()).exists,
        false, 'נכתבה רשומת פעולה למעבר שנדחה: ' + id);
    }
    // ⭐ ואחרי השחזור המלא המועמד עדיין תקין לבדיקה הבאה.
    const restored = await publicationRef.collection('schedule_outbox').get();
    assert.equal(restored.size, manifest.count);
  });

  await test('the cutover activates publication, pointer and mode together', async () => {
    const report = await api.previewCutover(req('commander', 'commander', {
      candidate_publication_id: preparedId
    }));
    if (report.blocked) {
      // ⭐ אם ה-preflight חוסם — זה ממצא, לא תקלה בבדיקה. עוצרים
      // ומדווחים במקום „לתקן" בכך שמדלגים.
      assert.fail('preflight חסם את המעבר: ' + JSON.stringify(report.by_reason));
    }
    /* ⭐ אישור השינויים הוא חתימת הדוח שהוצג — לא דגל. כשאין שינויים
     * אין מה לאשר, וכשיש, רק החתימה המדויקת מאשרת אותם. */
    if (Number(report.changes.count || 0) > 0) {
      const unacknowledged = await caught(() => api.promoteToNew(req('commander', 'commander', {
        request_id: 'cut_unack', candidate_publication_id: preparedId,
        expected_mode: 'shadow', expected_preflight_signature: report.signature
      })));
      assert.ok(unacknowledged, 'מעבר עם שינויים לא מאושרים עבר');
      assert.equal(unacknowledged.code, 'cutover-changes-unacknowledged');
    }
    /* ⭐ C (seq379) · שני promoters עם **אותו** מזהה בקשה, במקביל. אחד
     * מבצע; השני קורא את רשומת הפעולה בתוך העסקה ומחזיר את התוצאה
     * (duplicate) — לא הפעלה שנייה, לא audit שני. */
    const payload = {
      request_id: 'cut_1', candidate_publication_id: preparedId,
      expected_mode: 'shadow', expected_preflight_signature: report.signature,
      accept_changes: Number(report.changes.count || 0) > 0 ? report.signature : undefined
    };
    const both = await Promise.all([
      api.promoteToNew(req('commander', 'commander', payload)),
      api.promoteToNew(req('commander', 'commander', payload))
    ]);
    const result = both.find((r) => r.duplicate === false);
    const echoed = both.find((r) => r.duplicate === true);
    assert.ok(result && echoed, 'שני promoters מקבילים לא הסתיימו באחד מבצע ואחד מהדהד: '
      + JSON.stringify(both));
    assert.equal(echoed.publication_id, result.publication_id);
    assert.equal((await station().collection('schedule_mode_audit')
      .where('request_id', '==', 'cut_1').get()).size, 1, 'המעבר נרשם ביומן פעמיים');
    preflightSignature = report.signature;
    preflightChanges = Number(report.changes.count || 0);
    assert.equal(result.duplicate, false);
    const cfg = (await runtimeDoc().get()).data() || {};
    assert.equal(cfg.mode, 'new');
    const pointer = (await station().collection('schedule_state').doc('active').get()).data() || {};
    assert.equal(pointer.publication_id, preparedId);
    const pub = (await station().collection('schedule_publications')
      .doc(preparedId).get()).data() || {};
    assert.equal(pub.status, 'active');
  });

  await test('the outbox is released only after the cutover commits', async () => {
    const outbox = await station().collection('schedule_publications')
      .doc(preparedId).collection('schedule_outbox').get();
    outbox.docs.forEach((doc) =>
      assert.notEqual((doc.data() || {}).status, 'blocked',
        'הודעה נשארה חסומה אחרי מעבר מוצלח'));
  });

  await test('a second competing promotion does not run twice', async () => {
    const again = await api.promoteToNew(req('commander', 'commander', {
      request_id: 'cut_1', candidate_publication_id: preparedId,
      expected_mode: 'shadow', expected_preflight_signature: preflightSignature,
      accept_changes: preflightChanges > 0 ? preflightSignature : undefined
    }));
    assert.equal(again.duplicate, true, 'אותה בקשה בוצעה פעמיים');
    // ⭐ C · אותו מזהה עם כוונה אחרת (חתימה/אישור שונים) — נדחה, לא מהדהד.
    const reused = await caught(() => api.promoteToNew(req('commander', 'commander', {
      request_id: 'cut_1', candidate_publication_id: preparedId,
      expected_mode: 'shadow', expected_preflight_signature: 'another-report'
    })));
    assert.ok(reused, 'מזהה בקשה שימש לכוונה אחרת ועבר');
    assert.equal(reused.code, 'cutover-request-reused');
    // ובקשה חדשה על אותו פרסום — הוא כבר פעיל.
    const error = await caught(() => api.promoteToNew(req('commander', 'commander', {
      request_id: 'cut_2', candidate_publication_id: preparedId,
      expected_mode: 'shadow', expected_preflight_signature: preflightSignature,
      accept_changes: preflightChanges > 0 ? preflightSignature : undefined
    })));
    assert.ok(error, 'מעבר שני על פרסום פעיל לא נחסם');
  });

  await test('a viewer in new sees a full board', async () => {
    const view = await api.getMy(req('viewer', 'firefighter', { date: '2026-09-01' }));
    assert.notEqual(view.active, false, 'לוח ריק אחרי מעבר');
  });

  await test('turning the engine off is never blocked', async () => {
    const result = await api.setRuntimeMode(req('commander', 'commander', {
      request_id: 'mode_off', target: 'off', expected_mode: 'new',
      confirmation: 'off', reason_code: 'operational_safety'
    }));
    assert.ok(result);
    assert.equal(((await runtimeDoc().get()).data() || {}).mode, 'off');
  });

  /* ================================================================
   * 6 · אין מידע אישי בכשלים וביומן
   * ================================================================ */

  await test('failures and audit records carry no names or employee numbers', async () => {
    const error = await caught(() => api.saveSource(req('manager', 'firefighter', {
      request_id: 'src_bad', activate: true, expected_source_id: sourceId,
      rows: [{ row: 2, employee_number: 'לא-מספר', full_name: 'בדיקה סודית', sub_station: 'a', active: true, roles: ['driver'] }]
    })));
    assert.ok(error, 'שורה פגומה לא נדחתה');
    const audits = await station().collection('schedule_source_audit').get();
    const text = JSON.stringify(audits.docs.map((doc) => doc.data()));
    for (const secret of ['בדיקה אלף', 'בדיקה בית', 'בדיקה סודית',
      'פרופיל אלף', 'פרופיל בית', 'פרופיל גימל', 'פרופיל דלת', 'פרופיל הא', 'פרופיל וו',
      '9001', '9002', '9003', '9004', '9005', '9006']) {
      assert.equal(text.indexOf(secret), -1, 'היומן מכיל מידע אישי: ' + secret);
    }
    const modeAudits = await station().collection('schedule_mode_audit').get();
    const modeText = JSON.stringify(modeAudits.docs.map((doc) => doc.data()));
    for (const secret of ['בדיקה אלף', '9001']) {
      assert.equal(modeText.indexOf(secret), -1, 'יומן המצב מכיל מידע אישי');
    }
  });

  console.log('\n' + passed + ' schedule authoring Firestore integration checks passed.');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
