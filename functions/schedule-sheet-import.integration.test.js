'use strict';

/* ====================================================================
 *  schedule-sheet-import.integration.test · 42H · v2-review §3
 *
 *  מסלול ההדבקה מול Firestore **אמיתי** (אמולטור): דוח → ייבוא כטיוטה →
 *  תצוגה מקדימה → פרסום → קריאת הלוח עם היעדרויות; שני השחזורים של
 *  הביקורת (ביטול מינוי בזמן קריאת ההיעדרויות; ניסיון חוזר אחרי שינוי
 *  כינוי שאינו קשור; final-review: השבתת קורא בזמן קריאת הלוח); ושערי
 *  ההרשאה של שני ה-callables.
 *
 *  כיסוי 42H.2 של תצוגת הייבוא במצב כבוי הורץ מול אמולטור Firestore
 *  אמיתי על `demo-resq`: הרשאות חיות, show/clear, idempotency, CAS,
 *  שלמות הטיוטה, לוח ארבע התחנות ומרוץ שינוי המצביע.
 *
 *  הרצה:
 *    firebase emulators:exec --only firestore --project demo-resq \
 *      "cd functions && node schedule-sheet-import.integration.test.js"
 *
 *  אין שמות אמיתיים כאן — כל השמות מומצאים (כלל של אלדד).
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

const SID = 'schedule_sheet_import_it';
const MGR = 'sheet_manager';
const CLOCK = () => '2026-08-25T06:00:00.000Z';
const hash = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const randomId = () => crypto.randomBytes(12).toString('hex');

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}
const digest = (value) => hash(stable(value));

function station() { return db.collection('stations').doc(SID); }
function runtimeDoc() { return station().collection('schedule_state').doc('runtime'); }

function runtime(hooks) {
  return createScheduleRuntime({
    db: (hooks && hooks.db) || db,
    FieldValue: admin.firestore.FieldValue,
    FieldPath: admin.firestore.FieldPath,
    clock: CLOCK,
    hash,
    randomId,
    createEngine: createCalendarEngine,
    createPublication,
    createService: createScheduleService,
    isSuper: () => false,
    sendPush: async () => ({ sent: 1 }),
    beforeLiveGuardViewRecheck: hooks && hooks.beforeLiveGuardViewRecheck
  });
}

function req(uid, data) {
  return { auth: { uid, token: { stationId: SID, role: 'firefighter', name: uid } }, data: data || {} };
}

async function caught(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

/* עוקב אחרי הנתיב של כל מסמך/אוסף/שאילתה (ל-Query של ה-admin SDK אין `path`),
 * ומפעיל `afterRead` פעם אחת אחרי הקריאה הראשונה של הנתיב הנתון —
 * כלומר **אחרי** שהנתונים כבר חזרו, ולפני שהקורא ממשיך. */
function firestoreWithCollectionReadBarrier(pathSuffix, afterRead) {
  let armed = true;
  const bind = (target, property) => {
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  };
  const wrapQuery = (ref, path) => new Proxy(ref, {
    get(target, property) {
      if (property === 'get') {
        return async (...args) => {
          const snapshot = await target.get(...args);
          if (armed && path.endsWith(pathSuffix)) { armed = false; await afterRead(snapshot); }
          return snapshot;
        };
      }
      if (property === 'doc') return (...args) => wrapDoc(target.doc(...args), path + '/' + args[0]);
      if (property === 'where' || property === 'orderBy' || property === 'limit'
          || property === 'startAfter' || property === 'select') {
        return (...args) => wrapQuery(target[property](...args), path);
      }
      return bind(target, property);
    }
  });
  const wrapDoc = (ref, path) => new Proxy(ref, {
    get(target, property) {
      if (property === 'get') {
        return async (...args) => {
          const snapshot = await target.get(...args);
          if (armed && path.endsWith(pathSuffix)) { armed = false; await afterRead(snapshot); }
          return snapshot;
        };
      }
      if (property === 'collection') return (...args) => wrapQuery(target.collection(...args), path + '/' + args[0]);
      return bind(target, property);
    }
  });
  return new Proxy(db, {
    get(target, property) {
      if (property === 'collection') return (...args) => wrapQuery(target.collection(...args), String(args[0]));
      if (property === 'doc') return (...args) => wrapDoc(target.doc(...args), String(args[0]));
      return bind(target, property);
    }
  });
}

/* ---- נתוני הבדיקה: שמות מומצאים בלבד ---- */
const PEOPLE = [
  ['u1', 'רועי כהן', 'eilat', 'A'], ['u2', 'דניאל לוי', 'eilat', 'A'], ['u3', 'יוסי מזרחי', 'shahmon', 'B'],
  ['u4', 'עמית פרץ', 'timna', 'C'], ['u5', 'גיא ברק', 'yotvata', 'A'], ['u6', 'רועי אברהם', 'eilat', 'B'],
  ['u7', 'נועם דהן', 'eilat', 'B'], ['u8', 'אורי שלום', 'eilat', 'C'], ['u9', 'ליאור נחום', 'eilat', 'A']
];
const row = (cells) => cells.join('\t');
const SHEET = [
  row(['', '1/9', '2/9', '3/9/26']),
  row(['', 'ג', 'ד', 'ה']),
  row(['אילת', 'רועי כהן, דניאל לוי, ליאור נחום, גיא ברק, אורי שלום, נועם דהן, עמית פרץ', 'דניאל לוי, נועם דהן, אורי שלום', 'ליאור נחום, יוסי מזרחי, גיא ברק']),
  row(['שחמון', 'יוסי מזרחי', 'רועי', 'אבטחה']),
  row(['תמנע', '', 'עמית פרץ', '']),
  row(['יטבתה', '', '', 'עמית פרץ']),
  row(['מחלה', 'רועי אברהם', 'רועי אברהם', '']),
  row(['קורסים', '', 'ליאור נחום', '']),
  row(['בצפון', 'רועי', '', '']),
  row(['באילת', '', '', 'רועי כהן'])
].join('\n');
const MATRIX = SHEET.split('\n').map((line) => line.split('\t'));

async function seed() {
  await station().set({ name: 'Sheet Import Integration Station' });
  const batch = db.batch();
  batch.set(station().collection('users').doc(MGR), { station: SID, role: 'firefighter', full_name: 'אחראי בדיקה', active: true });
  batch.set(station().collection('schedule_access').doc(MGR), {
    schema_version: 1, station_id: SID, uid: MGR, roles: ['schedule_manager'], active: true, revision: 1
  });
  batch.set(station().collection('users').doc('viewer'), { station: SID, role: 'firefighter', full_name: 'צופה בדיקה', active: true });
  PEOPLE.forEach(([uid, name, , crew]) => {
    batch.set(station().collection('users').doc(uid), { station: SID, role: 'firefighter', full_name: name, active: true });
    batch.set(station().collection('roster').doc(uid), { full_name: name, crew, active: true, is_active: true });
  });
  ['A', 'B', 'C'].forEach((crew, position) => batch.set(station().collection('rotations').doc('r' + crew), {
    crew, position_in_cycle: position, cycle_days: 3, anchor_date: '2026-09-01', is_active: true
  }));
  batch.set(runtimeDoc(), { mode: 'shadow' });
  await batch.commit();

  const api = runtime();
  const saved = await api.savePolicy(req(MGR, {
    request_id: 'sheet_policy_1', activate: true,
    draft: {
      sub_stations: {
        eilat: { label: 'אילת', minimum: 7, requirements: [{ role: 'ff', count: 7, required: true }] },
        shahmon: { label: 'שחמון', minimum: 0, requirements: [{ role: 'ff', count: 1, required: false }] },
        timna: { label: 'תמנע', minimum: 0, requirements: [{ role: 'ff', count: 1, required: false }] },
        yotvata: { label: 'יטבתה', minimum: 0, requirements: [{ role: 'ff', count: 1, required: false }] }
      },
      rest: { min_gap_days: 1 }, rotation: null, max_shifts_per_month: null
    }
  }));
  // מקור חתום כפי שהשרת כותב אותו — בלי לעבור דרך הדבקת כוח האדם.
  const sourceId = 'sheet_src_1';
  const sourceRef = station().collection('schedule_sources').doc(sourceId);
  const peopleRaw = PEOPLE.map(([uid, name, sub]) => ({ id: uid, full_name: name, active: true, sub_station: sub, roles: ['ff'] }));
  const sb = db.batch();
  peopleRaw.forEach((person) => {
    const data = Object.assign({}, person); delete data.id;
    sb.set(sourceRef.collection('people').doc(person.id), data);
  });
  const basis = {
    station_id: SID, version: '1', revision: '1', carry: {},
    counts: { people: peopleRaw.length, availability: 0, locked: 0, events: 0 },
    people: peopleRaw, availability: {}, locked: {}, events: []
  };
  sb.set(sourceRef, {
    station_id: SID, complete: true, version: '1', revision: '1',
    person_count: peopleRaw.length, availability_count: 0, locked_count: 0, event_count: 0,
    content_digest: digest(basis), content_key: hash(stable({ station_id: SID, people: peopleRaw }))
  });
  sb.set(runtimeDoc(), { mode: 'shadow', active_policy_id: saved.policy_id, active_source_id: sourceId });
  await sb.commit();
  return { policyId: saved.policy_id, sourceId };
}

async function wipe() {
  const docs = await db.collection('stations').doc(SID).listCollections();
  for (const col of docs) {
    const snap = await col.get();
    for (const doc of snap.docs) {
      const subs = await doc.ref.listCollections();
      for (const sub of subs) {
        const children = await sub.get();
        await Promise.all(children.docs.map((child) => child.ref.delete()));
      }
      await doc.ref.delete();
    }
  }
  await station().delete();
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log('✓ ' + name);
}

(async function run() {
  await wipe();
  await seed();
  const api = runtime();
  const aliases = { 'רועי': 'u1', 'אבטחה': null };
  let ready = null;
  let imported = null;
  let preview = null;

  await test('preview/import refuse an ordinary firefighter and write nothing', async () => {
    const preview = await caught(() => api.previewScheduleImport(req('viewer', { month: '2026-09', paste: SHEET })));
    assert.equal(preview && preview.code, 'manager-required');
    const imp = await caught(() => api.importScheduleSheet(req('viewer', { request_id: 'sheet_i0', month: '2026-09', paste: SHEET })));
    assert.equal(imp && imp.code, 'manager-required');
    assert.equal((await station().collection('schedule_drafts').get()).size, 0);
  });

  await test('a browser-parsed file matrix uses the same preview path and raw bytes are never required', async () => {
    const before = await station().collection('schedule_drafts').get();
    const report = await api.previewScheduleImport(req(MGR, { month: '2026-09', matrix: MATRIX }));
    assert.deepEqual(report.dates, ['2026-09-01', '2026-09-02', '2026-09-03']);
    assert.equal(report.counts.stations, 4);
    const both = await caught(() => api.previewScheduleImport(req(MGR, { month: '2026-09', paste: SHEET, matrix: MATRIX })));
    assert.equal(both && both.code, 'import-input-required');
    const after = await station().collection('schedule_drafts').get();
    assert.equal(after.size, before.size);
  });

  await test('preview reports the ambiguous name and the non-name, blocked, without writing', async () => {
    const report = await api.previewScheduleImport(req(MGR, { month: '2026-09', paste: SHEET }));
    assert.deepEqual(report.dates, ['2026-09-01', '2026-09-02', '2026-09-03']);
    assert.deepEqual(report.unresolved.map((u) => u.name).sort(), ['אבטחה', 'רועי']);
    assert.equal(report.blocked, true);
    assert.deepEqual(report.blocked_by, ['unresolved']);
    assert.equal((await station().collection('schedule_drafts').get()).size, 0);
    assert.equal((await station().collection('schedule_state').doc('sheet_aliases').get()).exists, false);
  });

  await test('import is refused without the exact report signature', async () => {
    const error = await caught(() => api.importScheduleSheet(req(MGR, { request_id: 'sheet_i1', month: '2026-09', paste: SHEET, aliases })));
    assert.equal(error && error.code, 'import-report-stale');
    assert.equal((await station().collection('schedule_drafts').get()).size, 0);
  });

  await test('with aliases the report is clear and the import creates a complete draft with signed absences', async () => {
    ready = await api.previewScheduleImport(req(MGR, { month: '2026-09', paste: SHEET, aliases }));
    assert.equal(ready.blocked, false);
    assert.equal(ready.counts.unresolved, 0);
    imported = await api.importScheduleSheet(req(MGR, {
      request_id: 'sheet_i1', month: '2026-09', paste: SHEET, aliases, expected_report_digest: ready.report_digest
    }));
    assert.equal(imported.duplicate, false);
    const draftRef = station().collection('schedule_drafts').doc(imported.draft_id);
    const meta = (await draftRef.get()).data() || {};
    assert.equal(meta.status, 'complete');
    assert.equal(meta.imported, true);
    assert.equal(meta.import_month, '2026-09');
    assert.equal(meta.report_digest, ready.report_digest);
    assert.equal(meta.absence_count, 5);
    assert.deepEqual(meta.absence_coverage,
      { sick: 'ready', reserve: 'missing', course: 'ready', leave: 'ready' });
    const absenceDocs = await draftRef.collection('absences').get();
    const entries = absenceDocs.docs.reduce((n, doc) => n + ((doc.data() || {}).entries || []).length, 0);
    assert.equal(entries, 5, 'ההיעדרויות בתת-האוסף אינן תואמות ל-absence_count');
    const stored = (await station().collection('schedule_state').doc('sheet_aliases').get()).data() || {};
    assert.deepEqual(stored.aliases, { 'רועי': 'u1', 'אבטחה': null });
  });

  await test('draft preview shows the sheet template: four station rows, crews, absences', async () => {
    preview = await api.getDraftPreview(req(MGR, { draft_id: imported.draft_id, start: '2026-09-01' }));
    assert.equal(preview.imported, true);
    const day = preview.days[0];
    assert.deepEqual(day.sub_stations.map((s) => s.sub_station), ['eilat', 'shahmon', 'timna', 'yotvata']);
    assert.deepEqual([day.sub_stations[0].people.length, day.sub_stations[0].minimum, day.sub_stations[0].below_minimum], [7, 7, false]);
    assert.deepEqual(day.sub_stations[0].people.map((p) => p.uid), ['u1', 'u2', 'u9', 'u5', 'u8', 'u7', 'u4'], 'סדר הגיליון נשמר');
    assert.deepEqual(preview.days.map((d) => d.crew), ['A', 'B', 'C']);
    assert.deepEqual(day.absences.map((a) => [a.uid, a.kind, a.location || null]), [['u6', 'sick', null], ['u1', 'leave', 'north']]);
    assert.equal(day.absences_status, 'ready');
    assert.deepEqual(day.absence_coverage,
      { sick: 'ready', reserve: 'missing', course: 'ready', leave: 'ready' });
    assert.equal(preview.days.reduce((n, d) => n + d.absences.length, 0), 5);
  });

  await test('a retry of the completed import returns the stored receipt and report', async () => {
    const again = await api.importScheduleSheet(req(MGR, {
      request_id: 'sheet_i1', month: '2026-09', paste: SHEET, aliases, expected_report_digest: ready.report_digest
    }));
    assert.equal(again.duplicate, true);
    assert.equal(again.draft_id, imported.draft_id);
    assert.equal(again.report.report_digest, ready.report_digest);
  });

  await test('v2-review §2: a retry after an unrelated alias was added still returns the original receipt', async () => {
    const aliasRef = station().collection('schedule_state').doc('sheet_aliases');
    const live = (await aliasRef.get()).data() || {};
    await aliasRef.set({ station_id: SID, aliases: Object.assign({}, live.aliases, { 'unused-alias': 'u2' }) }, { merge: true });
    const replay = await api.importScheduleSheet(req(MGR, {
      request_id: 'sheet_i1', month: '2026-09', paste: SHEET, aliases, expected_report_digest: ready.report_digest
    }));
    assert.equal(replay.duplicate, true);
    assert.equal(replay.draft_id, imported.draft_id);
    assert.equal(replay.report.report_digest, ready.report_digest);
    assert.equal((await station().collection('schedule_drafts').get()).size, 1, 'נוצרה טיוטה שנייה');
  });

  await test('the same request-id with a different paste is a conflict, not a second draft', async () => {
    const other = await api.previewScheduleImport(req(MGR, { month: '2026-09', paste: SHEET + '\n', aliases }));
    const error = await caught(() => api.importScheduleSheet(req(MGR, {
      request_id: 'sheet_i1', month: '2026-09', paste: SHEET + '\n', aliases, expected_report_digest: other.report_digest
    })));
    assert.equal(error && error.code, 'request-conflict');
    assert.equal((await station().collection('schedule_drafts').get()).size, 1);
  });

  await test('v2-review §1: an appointment revoked while the absences are being read is refused without names', async () => {
    let fired = false;
    const barrier = firestoreWithCollectionReadBarrier('/schedule_drafts/' + imported.draft_id + '/absences', async () => {
      fired = true;
      await station().collection('schedule_access').doc(MGR).delete();
      await station().collection('users').doc(MGR).set({ station: SID, role: 'firefighter', full_name: 'אחראי בדיקה', active: false });
    });
    const racing = runtime({ db: barrier });
    const error = await caught(() => racing.getDraftPreview(req(MGR, { draft_id: imported.draft_id, start: '2026-09-01' })));
    assert.equal(fired, true, 'המחסום לא נורה — הנתיב של ההיעדרויות לא נקרא');
    assert.equal(error && error.code, 'manager-revoked', error && error.message);
    assert.equal(error && error.days, undefined);
    // שחזור המינוי לבדיקות הבאות.
    await station().collection('users').doc(MGR).set({ station: SID, role: 'firefighter', full_name: 'אחראי בדיקה', active: true });
    await station().collection('schedule_access').doc(MGR).set({
      schema_version: 1, station_id: SID, uid: MGR, roles: ['schedule_manager'], active: true, revision: 2
    });
    const after = await api.getDraftPreview(req(MGR, { draft_id: imported.draft_id, start: '2026-09-01' }));
    assert.equal(after.days.reduce((n, d) => n + d.absences.length, 0), 5);
  });

  await test('v2-review §1: a retry of a completed import during a revocation is refused too', async () => {
    let fired = false;
    // המחסום על קריאת מסמך הטיוטה הקיימת — אחרי שהמטא (עם הדוח והשמות) כבר חזר.
    const barrier = firestoreWithCollectionReadBarrier('/schedule_drafts/' + imported.draft_id, async () => {
      fired = true;
      await station().collection('schedule_access').doc(MGR).delete();
    });
    const racing = runtime({ db: barrier });
    const error = await caught(() => racing.importScheduleSheet(req(MGR, {
      request_id: 'sheet_i1', month: '2026-09', paste: SHEET, aliases, expected_report_digest: ready.report_digest
    })));
    assert.equal(fired, true);
    assert.equal(error && error.code, 'manager-revoked', error && error.message);
    await station().collection('schedule_access').doc(MGR).set({
      schema_version: 1, station_id: SID, uid: MGR, roles: ['schedule_manager'], active: true, revision: 3
    });
  });

  /* ------------------------------------------------------------------
   * 42H.2 · תצוגת טיוטת ייבוא כשהמנוע כבוי
   *
   * מצביע התצוגה נפרד במכוון מ-runtime/active/publications/outbox.  כל
   * הבדיקות כאן רצות מול עסקאות Firestore אמיתיות, כולל CAS ומרוצים.
   * ------------------------------------------------------------------ */
  const displayRef = station().collection('schedule_state').doc('display_2026_09');
  const draftRef = station().collection('schedule_drafts').doc(imported.draft_id);
  const displayAuditCount = async () => {
    const snap = await station().collection('schedule_audit').get();
    return snap.docs.filter((doc) => (doc.data() || {}).kind === 'schedule-display').length;
  };
  const restoreManager = async (revision) => {
    await station().collection('users').doc(MGR).set({
      station: SID, role: 'firefighter', full_name: 'אחראי בדיקה', active: true
    });
    await station().collection('schedule_access').doc(MGR).set({
      schema_version: 1, station_id: SID, uid: MGR,
      roles: ['schedule_manager'], active: true, revision
    });
  };
  const showInput = (requestId, generation) => ({
    action: 'show', month: '2026-09', request_id: requestId,
    expected_generation: generation,
    draft_id: imported.draft_id,
    expected_content_digest: imported.content_digest
  });

  await runtimeDoc().set({ mode: 'off' }, { merge: true });
  const displayRuntimeBefore = (await runtimeDoc().get()).data() || {};
  const displayPublicationsBefore = (await station().collection('schedule_publications').get()).size;
  const displayAuditsBefore = await displayAuditCount();

  await test('display status and selection refuse a non-manager without writing a pointer', async () => {
    const statusError = await caught(() => api.getScheduleDisplayStatus(req('viewer', { month: '2026-09' })));
    assert.equal(statusError && statusError.code, 'manager-required');
    const setError = await caught(() => api.setScheduleDisplay(req('viewer', showInput('display_denied', 0))));
    assert.equal(setError && setError.code, 'manager-required');
    assert.equal((await displayRef.get()).exists, false);
    assert.equal(await displayAuditCount(), displayAuditsBefore);
  });

  await test('an unset month reports disabled generation zero', async () => {
    const status = await api.getScheduleDisplayStatus(req(MGR, { month: '2026-09' }));
    assert.deepEqual(status, {
      month: '2026-09', enabled: false, generation: 0,
      draft_id: null, content_digest: null, from: null, to: null
    });
  });

  await test('display status refuses a manager appointment revoked after the pointer read', async () => {
    let fired = false;
    const barrier = firestoreWithCollectionReadBarrier('/schedule_state/display_2026_09', async () => {
      fired = true;
      await station().collection('schedule_access').doc(MGR).delete();
    });
    const error = await caught(() => runtime({ db: barrier })
      .getScheduleDisplayStatus(req(MGR, { month: '2026-09' })));
    assert.equal(fired, true);
    assert.equal(error && error.code, 'manager-revoked', error && error.message);
    await restoreManager(4);
  });

  await test('show refuses a manager appointment revoked after the draft read and writes nothing', async () => {
    let fired = false;
    const barrier = firestoreWithCollectionReadBarrier('/schedule_drafts/' + imported.draft_id, async () => {
      fired = true;
      await station().collection('schedule_access').doc(MGR).delete();
    });
    const error = await caught(() => runtime({ db: barrier })
      .setScheduleDisplay(req(MGR, showInput('display_revoked', 0))));
    assert.equal(fired, true);
    assert.equal(error && error.code, 'manager-revoked', error && error.message);
    assert.equal((await displayRef.get()).exists, false);
    assert.equal(await displayAuditCount(), displayAuditsBefore);
    await restoreManager(5);
  });

  await test('show refuses a digest that is not the signed imported draft', async () => {
    const input = showInput('display_bad_digest', 0);
    input.expected_content_digest = '0'.repeat(64);
    const error = await caught(() => api.setScheduleDisplay(req(MGR, input)));
    assert.equal(error && error.code, 'display-draft-invalid', error && error.message);
    assert.equal((await displayRef.get()).exists, false);
  });

  await test('show refuses a draft whose station metadata does not match the caller station', async () => {
    await draftRef.update({ station_id: 'different_station' });
    try {
      const error = await caught(() => api.setScheduleDisplay(req(MGR, showInput('display_wrong_station', 0))));
      assert.equal(error && error.code, 'display-draft-invalid', error && error.message);
      assert.equal((await displayRef.get()).exists, false);
    } finally {
      await draftRef.update({ station_id: SID });
    }
  });

  await test('show refuses a non-imported draft even when the snapshot is otherwise signed', async () => {
    await draftRef.update({ imported: false });
    try {
      const error = await caught(() => api.setScheduleDisplay(req(MGR, showInput('display_not_imported', 0))));
      assert.equal(error && error.code, 'display-draft-invalid', error && error.message);
      assert.equal((await displayRef.get()).exists, false);
    } finally {
      await draftRef.update({ imported: true });
    }
  });

  await test('show refuses an incomplete imported draft', async () => {
    await draftRef.update({ snapshot_complete: false });
    try {
      const error = await caught(() => api.setScheduleDisplay(req(MGR, showInput('display_incomplete', 0))));
      assert.equal(error && error.code, 'display-draft-invalid', error && error.message);
      assert.equal((await displayRef.get()).exists, false);
    } finally {
      await draftRef.update({ snapshot_complete: true });
    }
  });

  await test('show is refused in new mode and cannot move runtime or active publication state', async () => {
    await runtimeDoc().set({ mode: 'new' }, { merge: true });
    try {
      const error = await caught(() => api.setScheduleDisplay(req(MGR, showInput('display_new_mode', 0))));
      assert.equal(error && error.code, 'display-mode-blocked', error && error.message);
      assert.equal((await displayRef.get()).exists, false);
      assert.equal((await station().collection('schedule_state').doc('active').get()).exists, false);
      assert.equal((await station().collection('schedule_publications').get()).size, displayPublicationsBefore);
    } finally {
      await runtimeDoc().set({ mode: 'off' }, { merge: true });
    }
  });

  let shown = null;
  await test('show selects the signed import in off mode without publishing, notifying or changing mode', async () => {
    shown = await api.setScheduleDisplay(req(MGR, showInput('display_show_1', 0)));
    assert.deepEqual([
      shown.enabled, shown.generation, shown.mode, shown.draft_id, shown.content_digest
    ], [true, 1, 'off', imported.draft_id, imported.content_digest]);
    assert.deepEqual((await runtimeDoc().get()).data() || {}, displayRuntimeBefore,
      'בחירת תצוגה שינתה את מסמך מצב המנוע');
    assert.equal((await station().collection('schedule_state').doc('active').get()).exists, false);
    assert.equal((await station().collection('schedule_publications').get()).size, displayPublicationsBefore);
    assert.equal(await displayAuditCount(), displayAuditsBefore + 1);
  });

  await test('status exposes the selected immutable draft and current generation', async () => {
    const status = await api.getScheduleDisplayStatus(req(MGR, { month: '2026-09' }));
    assert.deepEqual(status, {
      month: '2026-09', enabled: true, generation: 1,
      draft_id: imported.draft_id, content_digest: imported.content_digest,
      from: '2026-09-01', to: '2026-09-03'
    });
  });

  await test('off-mode station range is the ordered four-station import with line seven and absences', async () => {
    const board = await api.getStationRange(req('viewer', { from: '2026-09-01', to: '2026-09-03' }));
    assert.deepEqual([board.mode, board.source, board.imported, board.display_only, board.display_generation],
      ['off', 'imported-display', true, true, 1]);
    assert.deepEqual(board.days.map((day) => day.crew), ['A', 'B', 'C']);
    assert.deepEqual(board.days[0].sub_stations.map((item) => [item.sub_station, item.label]), [
      ['eilat', 'אילת'], ['shahmon', 'שחמון'], ['timna', 'תמנע'], ['yotvata', 'יטבתה']
    ]);
    assert.deepEqual(board.days[0].sub_stations[0].people.map((person) => person.uid),
      ['u1', 'u2', 'u9', 'u5', 'u8', 'u7', 'u4'], 'סדר השמות מהקובץ השתנה');
    assert.deepEqual(board.days[0].sub_stations[0].people.map((person) => person.person),
      ['רועי כהן', 'דניאל לוי', 'ליאור נחום', 'גיא ברק', 'אורי שלום', 'נועם דהן', 'עמית פרץ']);
    assert.deepEqual([
      board.days[0].sub_stations[0].minimum,
      board.days[0].sub_stations[0].below_minimum,
      board.days[1].sub_stations[0].minimum,
      board.days[1].sub_stations[0].below_minimum
    ], [7, false, 7, true], 'קו המינימום של אילת אינו 7');
    assert.deepEqual(board.days[0].absences.map((item) => [item.uid, item.kind, item.location || null]),
      [['u6', 'sick', null], ['u1', 'leave', 'north']]);
  });

  await test('show replay is idempotent and a reused request id with different intent conflicts', async () => {
    const replay = await api.setScheduleDisplay(req(MGR, showInput('display_show_1', 0)));
    assert.deepEqual([replay.duplicate, replay.enabled, replay.generation], [true, true, 1]);
    assert.equal(await displayAuditCount(), displayAuditsBefore + 1);
    const conflict = await caught(() => api.setScheduleDisplay(req(MGR, {
      action: 'clear', month: '2026-09', request_id: 'display_show_1', expected_generation: 1
    })));
    assert.equal(conflict && conflict.code, 'request-conflict', conflict && conflict.message);
  });

  await test('a stale generation loses the real Firestore transaction race without a second audit', async () => {
    const error = await caught(() => api.setScheduleDisplay(req(MGR, showInput('display_stale_generation', 0))));
    assert.equal(error && error.code, 'display-generation-conflict', error && error.message);
    assert.equal((await displayRef.get()).data().generation, 1);
    assert.equal(await displayAuditCount(), displayAuditsBefore + 1);
  });

  await test('a pointer changed after the imported snapshot read aborts the board response', async () => {
    let fired = false;
    const racing = runtime({
      beforeLiveGuardViewRecheck: async ({ kind }) => {
        if (fired || kind !== 'imported-display') return;
        fired = true;
        await displayRef.update({ generation: 2 });
      }
    });
    const error = await caught(() => racing.getStationRange(
      req('viewer', { from: '2026-09-01', to: '2026-09-03' })));
    assert.equal(fired, true);
    assert.equal(error && error.code, 'schedule-display-changed', error && error.message);
    assert.equal(error && error.days, undefined);
  });

  await test('a viewer disabled after the imported snapshot read receives no board', async () => {
    let fired = false;
    const racing = runtime({
      beforeLiveGuardViewRecheck: async ({ kind }) => {
        if (fired || kind !== 'imported-display') return;
        fired = true;
        await station().collection('users').doc('viewer').set({
          station: SID, role: 'firefighter', full_name: 'צופה בדיקה', active: false
        });
      }
    });
    const error = await caught(() => racing.getStationRange(
      req('viewer', { from: '2026-09-01', to: '2026-09-03' })));
    assert.equal(fired, true);
    assert.equal(error && error.code, 'board-viewer-changed', error && error.message);
    assert.equal(error && error.days, undefined);
    await station().collection('users').doc('viewer').set({
      station: SID, role: 'firefighter', full_name: 'צופה בדיקה', active: true
    });
  });

  await test('clear is generation-checked, idempotent and returns the off board to legacy', async () => {
    const clearInput = {
      action: 'clear', month: '2026-09', request_id: 'display_clear_1', expected_generation: 2
    };
    const cleared = await api.setScheduleDisplay(req(MGR, clearInput));
    assert.deepEqual([cleared.enabled, cleared.generation, cleared.mode], [false, 3, 'off']);
    const replay = await api.setScheduleDisplay(req(MGR, clearInput));
    assert.deepEqual([replay.duplicate, replay.enabled, replay.generation], [true, false, 3]);
    const status = await api.getScheduleDisplayStatus(req(MGR, { month: '2026-09' }));
    assert.deepEqual([status.enabled, status.generation, status.draft_id], [false, 3, null]);
    const board = await api.getStationRange(req('viewer', { from: '2026-09-01', to: '2026-09-03' }));
    assert.equal(board.source, 'legacy');
    assert.equal((await draftRef.get()).exists, true, 'clear must not delete the imported draft');
    assert.deepEqual((await runtimeDoc().get()).data() || {}, displayRuntimeBefore,
      'clear changed the engine mode/configuration');
    assert.equal((await station().collection('schedule_state').doc('active').get()).exists, false);
    assert.equal((await station().collection('schedule_publications').get()).size, displayPublicationsBefore);
    assert.equal(await displayAuditCount(), displayAuditsBefore + 2);
  });

  // Existing publication coverage below starts from shadow mode and no display.
  await runtimeDoc().set({ mode: 'shadow' }, { merge: true });

  await test('publish in shadow prepares only — no active pointer', async () => {
    const prepared = await api.publish(req(MGR, {
      request_id: 'sheet_pub_shadow', draft_id: imported.draft_id, expected_content_digest: preview.expected_content_digest
    }));
    assert.ok(prepared && prepared.publication_id);
    const pointer = await station().collection('schedule_state').doc('active').get();
    assert.equal(pointer.exists && !!(pointer.data() || {}).publication_id, false, 'ב-shadow אסור להזיז את המצביע');
  });

  /* ⭐ המעבר ל-new הוא של אלדד בלבד (promoteToNew). הבדיקה כותבת את מסמך
   * המצב ישירות — כמו ה-probe — רק כדי לקרוא את הלוח החי מפרסום מיובא.
   * זה אינו מסלול מוצר. */
  await test('published in new: the live board carries station rows, absences and day crews', async () => {
    const cfg = (await runtimeDoc().get()).data() || {};
    await runtimeDoc().set({ mode: 'new', active_policy_id: cfg.active_policy_id, active_source_id: cfg.active_source_id });
    const published = await api.publish(req(MGR, {
      request_id: 'sheet_pub_new', draft_id: imported.draft_id, expected_content_digest: preview.expected_content_digest
    }));
    assert.ok(published && published.publication_id);
    const pub = (await station().collection('schedule_publications').doc(published.publication_id).get()).data() || {};
    assert.equal(pub.imported, true);
    assert.equal(pub.absence_count, 5);
    assert.deepEqual(pub.absence_coverage,
      { sick: 'ready', reserve: 'missing', course: 'ready', leave: 'ready' });
    const absenceDocs = await station().collection('schedule_publications').doc(published.publication_id).collection('absences').get();
    assert.equal(absenceDocs.docs.reduce((n, doc) => n + ((doc.data() || {}).entries || []).length, 0), 5);
    const range = await api.getStationRange(req('viewer', { from: '2026-09-01', to: '2026-09-03' }));
    assert.equal(range.source, 'v2');
    assert.equal(range.imported, true);
    assert.deepEqual(range.days.map((d) => d.crew), ['A', 'B', 'C']);
    assert.deepEqual(range.days.map((d) => d.absences.map((a) => a.uid + ':' + a.kind)),
      [['u6:sick', 'u1:leave'], ['u6:sick', 'u9:course'], ['u1:leave']]);
    assert.deepEqual(range.days[0].absence_coverage,
      { sick: 'ready', reserve: 'missing', course: 'ready', leave: 'ready' });
    assert.equal(range.days[0].sub_stations.length, 4);
    const single = await api.getStation(req('u2', { date: '2026-09-02' }));
    assert.deepEqual([single.day.crew, single.day.absences.length, single.day.absences_status], ['B', 2, 'ready']);
    const mine = await api.getStationRange(req('u1', { from: '2026-09-03', to: '2026-09-03' }));
    assert.equal((mine.days[0].absences[0] || {}).is_me, true);
  });

  /* final-review §1: חבר תחנה רגיל (לא אחראי סידור) שהושבת או הועבר **בזמן**
   * קריאת הלוח המפורסם — סירוב בלי שמות ובלי היעדרויות, בנפרד לכל כניסה. */
  const activeId = ((await station().collection('schedule_state').doc('active').get()).data() || {}).publication_id;
  const viewerActive = () => station().collection('users').doc('viewer').set({ station: SID, role: 'firefighter', full_name: 'צופה בדיקה', active: true });

  await test('final-review §1: getStationRange refuses a viewer disabled while the absences are being read', async () => {
    let fired = false;
    const barrier = firestoreWithCollectionReadBarrier('/schedule_publications/' + activeId + '/absences', async () => {
      fired = true;
      await station().collection('users').doc('viewer').set({ station: SID, role: 'firefighter', full_name: 'צופה בדיקה', active: false });
    });
    const error = await caught(() => runtime({ db: barrier }).getStationRange(req('viewer', { from: '2026-09-01', to: '2026-09-03' })));
    assert.equal(fired, true, 'המחסום לא נורה — נתיב ההיעדרויות של הפרסום לא נקרא');
    assert.equal(error && error.code, 'board-viewer-changed', error && error.message);
    assert.equal(error && error.days, undefined);
    await viewerActive();
  });

  await test('final-review §1: getStation refuses a viewer disabled while the absences are being read', async () => {
    let fired = false;
    const barrier = firestoreWithCollectionReadBarrier('/schedule_publications/' + activeId + '/absences', async () => {
      fired = true;
      await station().collection('users').doc('viewer').set({ station: SID, role: 'firefighter', full_name: 'צופה בדיקה', active: false });
    });
    const error = await caught(() => runtime({ db: barrier }).getStation(req('viewer', { date: '2026-09-02' })));
    assert.equal(fired, true);
    assert.equal(error && error.code, 'board-viewer-changed', error && error.message);
    assert.equal(error && error.day, undefined);
    await viewerActive();
  });

  await test('final-review §1: a viewer moved to another station during the crew decoration is refused', async () => {
    let fired = false;
    const barrier = firestoreWithCollectionReadBarrier('/' + SID + '/roster', async () => {
      fired = true;
      await station().collection('users').doc('viewer').set({ station: 'other_station', role: 'firefighter', full_name: 'צופה בדיקה', active: true });
    });
    const error = await caught(() => runtime({ db: barrier }).getStationRange(req('viewer', { from: '2026-09-01', to: '2026-09-03' })));
    assert.equal(fired, true, 'המחסום לא נורה — הסגל לא נקרא בעיטור');
    assert.equal(error && error.code, 'board-viewer-changed', error && error.message);
    await viewerActive();
  });

  await test('final-review §1: an active member still reads both entries, with absences', async () => {
    const range = await api.getStationRange(req('viewer', { from: '2026-09-01', to: '2026-09-03' }));
    assert.equal(range.days.reduce((n, d) => n + d.absences.length, 0), 5);
    const single = await api.getStation(req('viewer', { date: '2026-09-02' }));
    assert.deepEqual([single.day.crew, single.day.absences.length], ['B', 2]);
  });

  await test('absence coverage is signed: metadata tampering breaks the publication and restoring it restores the view', async () => {
    const ref = station().collection('schedule_publications').doc(activeId);
    const meta = (await ref.get()).data() || {};
    await ref.set({ absence_coverage: { sick: 'ready', reserve: 'ready', course: 'ready', leave: 'ready' } }, { merge: true });
    const error = await caught(() => api.getStationRange(req('viewer', { from: '2026-09-01', to: '2026-09-03' })));
    assert.equal(error && error.code, 'snapshot-digest-mismatch', error && error.message);
    await ref.set({ absence_coverage: meta.absence_coverage }, { merge: true });
    const restored = await api.getStationRange(req('viewer', { from: '2026-09-01', to: '2026-09-03' }));
    assert.equal(restored.days[0].absence_coverage.reserve, 'missing');
  });

  await test('a tampered absences document breaks the signed publication', async () => {
    const pubs = await station().collection('schedule_publications').get();
    const active = (await station().collection('schedule_state').doc('active').get()).data() || {};
    const ref = station().collection('schedule_publications').doc(active.publication_id);
    assert.ok(pubs.size >= 1 && active.publication_id);
    const first = (await ref.collection('absences').get()).docs[0];
    await first.ref.set({ date: first.data().date, entries: [] });
    const error = await caught(() => api.getStationRange(req('viewer', { from: '2026-09-01', to: '2026-09-03' })));
    assert.equal(error && error.code, 'snapshot-count-mismatch', error && error.message);
  });

  await runtimeDoc().set({ mode: 'off' }, { merge: true });
  console.log('\n' + passed + ' schedule sheet-import Firestore integration checks passed.');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
