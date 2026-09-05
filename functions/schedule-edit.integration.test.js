'use strict';

/* ====================================================================
 *  schedule-edit.integration.test · 42H.2 חבילה א׳ — עריכת סידור שפורסם
 *
 *  מסלול העריכה מול Firestore **אמיתי** (אמולטור): גיליון → ייבוא → פרסום
 *  ב-new → previewScheduleEdit (דוח, בלי כתיבה) → applyScheduleEdit
 *  (טיוטה נגזרת → publish → revision חדש, CAS, יומן, outbox — הודעה אחת
 *  לאדם) → הלוח → ניסיון חוזר → בסיס ישן נדחה → rollback הקיים.
 *  הסביבה (Firestore בזיכרון, seed, מחסום קריאה) הועתקה מקובץ הייבוא.
 *
 *  ⚠ הקובץ **לא הורץ** על ידי מי שכתב אותו — אין אמולטור בסביבה שלו
 *  (הורדת ה-jar חסומה ב-proxy). נבדק ב-`node --check` ונכתב מול אותן
 *  חתימות שה-probe בזיכרון (`tests/sheet-import-runtime-probe.mjs`)
 *  מריץ בהצלחה על ה-runtime האמיתי. Codex מריץ על `demo-resq`.
 *
 *  הרצה:
 *    firebase emulators:exec --only firestore --project demo-resq \
 *      "cd functions && node schedule-edit.integration.test.js"
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

const SID = 'schedule_edit_it';
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
    beforeSnapshotFinalize: hooks && hooks.beforeSnapshotFinalize,
    FieldValue: admin.firestore.FieldValue,
    FieldPath: admin.firestore.FieldPath,
    clock: CLOCK,
    hash,
    randomId,
    createEngine: createCalendarEngine,
    createPublication,
    createService: createScheduleService,
    isSuper: () => false,
    sendPush: async () => ({ sent: 1 })
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
  const expectedOf = (pointer) => ({ publication_id: pointer.publication_id, revision: pointer.revision, content_digest: pointer.content_digest });
  let pointer = null;

  await test('seed: import the sheet, switch to new (test-only direct write), publish revision 1', async () => {
    const ready = await api.previewScheduleImport(req(MGR, { month: '2026-09', paste: SHEET, aliases }));
    assert.equal(ready.blocked, false, JSON.stringify(ready.blocked_by));
    const imported = await api.importScheduleSheet(req(MGR, { request_id: 'edit_seed_import', month: '2026-09', paste: SHEET, aliases, expected_report_digest: ready.report_digest }));
    const preview = await api.getDraftPreview(req(MGR, { draft_id: imported.draft_id, start: '2026-09-01' }));
    const cfg = (await runtimeDoc().get()).data() || {};
    /* ⭐ המעבר ל-new הוא של אלדד בלבד (promoteToNew). כתיבה ישירה — רק כדי לבדוק. */
    await runtimeDoc().set({ mode: 'new', active_policy_id: cfg.active_policy_id, active_source_id: cfg.active_source_id });
    const published = await api.publish(req(MGR, { request_id: 'edit_seed_publish', draft_id: imported.draft_id, expected_content_digest: preview.expected_content_digest, gap_acknowledgement: preview.gaps && preview.gaps.digest }));
    assert.ok(published.publication_id);
    pointer = (await station().collection('schedule_state').doc('active').get()).data();
    assert.equal(pointer.revision, 1);
  });

  await test('edit gates: viewer refused; wrong base is stale; report writes nothing', async () => {
    const edits = [{ kind: 'unassign', uid: 'u1', dates: ['2026-09-01'] }];
    const denied = await caught(() => api.previewScheduleEdit(req('viewer', { expected: expectedOf(pointer), edits })));
    assert.equal(denied && denied.code, 'manager-required');
    const stale = await caught(() => api.previewScheduleEdit(req(MGR, { expected: Object.assign(expectedOf(pointer), { revision: 5 }), edits })));
    assert.equal(stale && stale.code, 'edit-base-stale');
    const draftsBefore = (await station().collection('schedule_drafts').get()).size;
    const report = await api.previewScheduleEdit(req(MGR, { expected: expectedOf(pointer), edits }));
    assert.equal(report.counts.changes, 1);
    assert.equal((await station().collection('schedule_drafts').get()).size, draftsBefore);
  });

  let applied = null;
  let editDigest = null;
  let gapDigest = null;
  const edits = [
    { kind: 'assign', uid: 'u1', dates: ['2026-09-01', '2026-09-02'], sub_station: 'shahmon' },
    { kind: 'absence', uid: 'u2', dates: ['2026-09-03'], absence: { kind: 'leave', location: 'abroad' } },
    { kind: 'unassign', uid: 'u3', dates: ['2026-09-01'] }
  ];
  await test('apply: derived draft → new revision with CAS, audit, one outbox entry per changed person', async () => {
    const report = await api.previewScheduleEdit(req(MGR, { expected: expectedOf(pointer), edits }));
    editDigest = report.edit_digest;
    gapDigest = report.gaps.digest;
    const stale = await caught(() => api.applyScheduleEdit(req(MGR, { request_id: 'edit_1', expected: expectedOf(pointer), edits })));
    assert.equal(stale && stale.code, 'edit-report-stale');
    applied = await api.applyScheduleEdit(req(MGR, { request_id: 'edit_1', expected: expectedOf(pointer), edits, expected_edit_digest: editDigest, gap_acknowledgement: report.gaps.digest }));
    assert.deepEqual([applied.duplicate, applied.revision], [false, 2]);
    const active = (await station().collection('schedule_state').doc('active').get()).data();
    assert.deepEqual([active.publication_id, active.revision, active.previous_publication_id], [applied.publication_id, 2, pointer.publication_id]);
    const pub = (await station().collection('schedule_publications').doc(applied.publication_id).get()).data();
    assert.deepEqual([pub.edited, pub.edit_base.revision, pub.status], [true, 1, 'active']);
    const oldPub = (await station().collection('schedule_publications').doc(pointer.publication_id).get()).data();
    assert.equal(oldPub.content_digest, pointer.content_digest, 'the previous snapshot must stay untouched');
    const outbox = await station().collection('schedule_publications').doc(applied.publication_id).collection('schedule_outbox').get();
    const perPerson = {};
    outbox.docs.forEach((doc) => { const p = doc.data().person; perPerson[p] = (perPerson[p] || 0) + 1; });
    /* ⭐ ביקורת Codex §2: גם u2 (היעדרות בלבד) מקבל הודעה — אחת, בלי הסוג ובלי המיקום. */
    assert.ok(perPerson.u1 === 1 && perPerson.u2 === 1 && perPerson.u3 === 1 && Object.values(perPerson).every((n) => n === 1), JSON.stringify(perPerson));
    const u2Push = outbox.docs.map((doc) => doc.data()).find((n) => n.person === 'u2');
    assert.ok(/היעדרות/.test(u2Push.push.body) && !/leave|abroad|חופש/.test(JSON.stringify(u2Push)), JSON.stringify(u2Push.push));
    const audit = (await station().collection('schedule_audit').get()).docs.map((doc) => doc.data());
    const editAudit = audit.find((a) => a.action === 'edit-draft');
    const publishAudit = audit.find((a) => a.action === 'publish' && a.revision === 2);
    assert.ok(editAudit && editAudit.change_count === 4 && editAudit.changes.every((c) => !c.name));
    assert.ok(publishAudit && publishAudit.edited_from && publishAudit.edited_from.publication_id === pointer.publication_id);
    assert.equal(JSON.stringify(audit).indexOf('רועי'), -1, 'audit must not carry names');
  });

  await test('the board shows the edit; a retry returns the same receipt; the old base is refused', async () => {
    const range = await api.getStationRange(req('viewer', { from: '2026-09-01', to: '2026-09-03' }));
    assert.equal(range.revision, 2);
    const d1 = range.days[0];
    assert.equal(d1.sub_stations.find((s) => s.sub_station === 'shahmon').people.some((p) => p.uid === 'u1'), true);
    assert.equal(d1.sub_stations.find((s) => s.sub_station === 'eilat').people.some((p) => p.uid === 'u1'), false);
    assert.equal(d1.sub_stations.some((s) => s.people.some((p) => p.uid === 'u3')), false);
    assert.deepEqual(range.days[2].absences.filter((a) => a.uid === 'u2').map((a) => a.kind + ':' + a.location), ['leave:abroad']);
    const again = await api.applyScheduleEdit(req(MGR, { request_id: 'edit_1', expected: expectedOf(pointer), edits, expected_edit_digest: editDigest, gap_acknowledgement: gapDigest }));
    assert.deepEqual([again.duplicate, again.publication_id], [true, applied.publication_id]);
    assert.equal(((await station().collection('schedule_state').doc('active').get()).data() || {}).revision, 2);
    const conflict = await caught(() => api.applyScheduleEdit(req(MGR, { request_id: 'edit_1', expected: expectedOf(pointer), edits: edits.slice(0, 1), expected_edit_digest: 'x' })));
    assert.equal(conflict && conflict.code, 'request-conflict');
    const stale = await caught(() => api.previewScheduleEdit(req(MGR, { expected: expectedOf(pointer), edits: [{ kind: 'unassign', uid: 'u1', dates: ['2026-09-02'] }] })));
    assert.equal(stale && stale.code, 'edit-base-stale');
  });

  await test('a competing publication between report and apply is refused inside the transaction', async () => {
    const current = (await station().collection('schedule_state').doc('active').get()).data();
    const mine = [{ kind: 'unassign', uid: 'u1', dates: ['2026-09-02'] }];
    const report = await api.previewScheduleEdit(req(MGR, { expected: expectedOf(current), edits: mine }));
    // עריכה מתחרה שמתפרסמת קודם
    const other = await api.previewScheduleEdit(req(MGR, { expected: expectedOf(current), edits: [{ kind: 'absence', uid: 'u4', dates: ['2026-09-01'], absence: { kind: 'course' } }] }));
    await api.applyScheduleEdit(req(MGR, { request_id: 'edit_other', expected: expectedOf(current), edits: [{ kind: 'absence', uid: 'u4', dates: ['2026-09-01'], absence: { kind: 'course' } }], expected_edit_digest: other.edit_digest, gap_acknowledgement: other.gaps.digest }));
    const draftsBefore = (await station().collection('schedule_drafts').get()).size;
    const error = await caught(() => api.applyScheduleEdit(req(MGR, { request_id: 'edit_2', expected: expectedOf(current), edits: mine, expected_edit_digest: report.edit_digest, gap_acknowledgement: report.gaps.digest })));
    assert.equal(error && error.code, 'edit-base-stale', error && error.message);
    assert.equal((await station().collection('schedule_drafts').get()).size, draftsBefore, 'no draft for a refused edit');
    assert.equal(((await station().collection('schedule_state').doc('active').get()).data() || {}).revision, 3);
  });

  await test('§1 the gap gate is decided inside the publish transaction: a gap-policy change after the early check refuses the publication', async () => {
    const current = (await station().collection('schedule_state').doc('active').get()).data();
    await api.saveGapPolicy(req(MGR, { request_id: 'edit_gp1', station_minimum: 20 }));
    const mine = [{ kind: 'unassign', uid: 'u8', dates: ['2026-09-02'] }];
    const report = await api.previewScheduleEdit(req(MGR, { expected: expectedOf(current), edits: mine }));
    assert.ok(report.gaps.acknowledgeable.length > 0 && report.gaps.digest);
    // ה-seam רץ אחרי הבדיקה המוקדמת ולפני עסקת הפרסום — בדיוק החלון של TOCTOU.
    const racing = runtime({
      beforeSnapshotFinalize: async (event) => {
        if (event.kind === 'publication') {
          await station().collection('schedule_state').doc('gap_policy').set({ station_id: SID, station_minimum: 25, revision: 2 });
        }
      }
    });
    const refused = await caught(() => racing.applyScheduleEdit(req(MGR, { request_id: 'edit_toctou', expected: expectedOf(current), edits: mine, expected_edit_digest: report.edit_digest, gap_acknowledgement: report.gaps.digest })));
    assert.equal(refused && refused.code, 'gaps-acknowledgement-required', refused && refused.message);
    assert.equal(((await station().collection('schedule_state').doc('active').get()).data() || {}).revision, current.revision, 'the pointer must not move');
    // ניסיון חוזר של אותה בקשה (הפרסום נשאר ב-staging) עם אישור על הרשימה הנוכחית — משלים.
    const fresh = await api.getGapReport(req(MGR, {}));
    const stagingReport = await api.previewScheduleEdit(req(MGR, { expected: expectedOf(current), edits: mine }));
    const done = await api.applyScheduleEdit(req(MGR, { request_id: 'edit_toctou', expected: expectedOf(current), edits: mine, expected_edit_digest: report.edit_digest, gap_acknowledgement: stagingReport.gaps.digest }));
    assert.equal(done.revision, current.revision + 1);
    const pub = (await station().collection('schedule_publications').doc(done.publication_id).get()).data();
    assert.equal(pub.gap_report && pub.gap_report.checked_in_transaction, true);
    assert.ok(fresh && fresh.summary);
    await station().collection('schedule_state').doc('gap_policy').delete();
  });

  await test('§2 an absence-only edit notifies the person once, naming the date and never the reason', async () => {
    const current = (await station().collection('schedule_state').doc('active').get()).data();
    const mine = [{ kind: 'absence', uid: 'u5', dates: ['2026-09-02'], absence: { kind: 'sick' } }];
    const report = await api.previewScheduleEdit(req(MGR, { expected: expectedOf(current), edits: mine }));
    assert.deepEqual([report.counts.people, report.notifications], [1, 1]);
    const done = await api.applyScheduleEdit(req(MGR, { request_id: 'edit_abs', expected: expectedOf(current), edits: mine, expected_edit_digest: report.edit_digest, gap_acknowledgement: report.gaps.digest }));
    const outbox = await station().collection('schedule_publications').doc(done.publication_id).collection('schedule_outbox').get();
    const notes = outbox.docs.map((doc) => doc.data());
    assert.deepEqual(notes.map((n) => n.person), ['u5']);
    assert.ok(/נרשמה היעדרות/.test(notes[0].push.body) && /2\/9/.test(notes[0].push.body) && !/sick|מחלה/.test(JSON.stringify(notes[0])), JSON.stringify(notes[0].push));
  });

  await test('§3/§6 edits are refused for a foreign sub-station key and an unknown role; after a policy change the rows are rebased, not refused', async () => {
    const current = (await station().collection('schedule_state').doc('active').get()).data();
    const foreign = await caught(() => api.previewScheduleEdit(req(MGR, { expected: expectedOf(current), edits: [{ kind: 'assign', uid: 'u9', dates: ['2026-09-02'], sub_station: 'main', role: 'ff' }] })));
    assert.equal(foreign && foreign.code, 'edit-sub-station-unknown');
    const role = await caught(() => api.previewScheduleEdit(req(MGR, { expected: expectedOf(current), edits: [{ kind: 'assign', uid: 'u9', dates: ['2026-09-02'], sub_station: 'timna', role: 'boss' }] })));
    assert.equal(role && role.code, 'edit-role-unknown');
    const cfg = (await runtimeDoc().get()).data() || {};
    const changed = await api.savePolicy(req(MGR, {
      request_id: 'edit_policy_2', activate: true, expected_policy_id: cfg.active_policy_id, confirm_weakening: true,
      draft: {
        sub_stations: {
          eilat: { label: 'אילת', minimum: 5, requirements: [{ role: 'ff', count: 5, required: true }] },
          shahmon: { label: 'שחמון', minimum: 2, requirements: [{ role: 'ff', count: 2, required: false }] },
          timna: { label: 'תמנע', minimum: 0, requirements: [{ role: 'ff', count: 1, required: false }] },
          yotvata: { label: 'יטבתה', minimum: 0, requirements: [{ role: 'ff', count: 1, required: false }] }
        },
        rest: { min_gap_days: 1 }, rotation: null, max_shifts_per_month: null
      }
    }));
    assert.ok(changed.policy_id && changed.policy_id !== cfg.active_policy_id);
    /* הכרעת אלדד (5.9): עריכה ידנית תמיד אפשרית — השורות מיושרות למדיניות הפעילה. */
    const rebased = await api.previewScheduleEdit(req(MGR, { expected: expectedOf(current), edits: [{ kind: 'unassign', uid: 'u9', dates: ['2026-09-02'] }] }));
    assert.ok(rebased.policy_changed && rebased.policy_changed.rows_rebased > 0, JSON.stringify(rebased.policy_changed));
    // קו אילת בפרסום מיובא קבוע על 7 (חוזה ההטלה הקנונית); היישור נראה בתוויות/קווים אחרים.
    assert.ok(rebased.below_minimum.every((row) => row.sub_station !== 'eilat' || row.minimum === 7));
    // מחזירים את המדיניות המקורית כדי שה-rollback שלמטה ירוץ על אותו בסיס.
    await runtimeDoc().set({ active_policy_id: cfg.active_policy_id }, { merge: true });
  });

  await test('the existing rollback returns to the pre-edit publication', async () => {
    const current = (await station().collection('schedule_state').doc('active').get()).data();
    const rolled = await api.rollback(req(MGR, { request_id: 'edit_rb', target_publication_id: pointer.publication_id, expected_active_publication_id: current.publication_id, reason_code: 'wrong_assignment' }));
    assert.ok(rolled && rolled.publication_id);
    const back = await api.getStationRange(req('viewer', { from: '2026-09-01', to: '2026-09-01' }));
    assert.equal(back.days[0].sub_stations.find((s) => s.sub_station === 'eilat').people.some((p) => p.uid === 'u1'), true);
  });

  await runtimeDoc().set({ mode: 'off' }, { merge: true });
  console.log('\n' + passed + ' schedule-edit Firestore integration checks passed.');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
