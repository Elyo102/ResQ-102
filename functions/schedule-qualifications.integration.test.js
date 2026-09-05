'use strict';

/* ====================================================================
 *  schedule-qualifications.integration.test · 42H.2 חבילה ב׳ — קטלוג כשירויות
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
 *      "cd functions && node schedule-qualifications.integration.test.js"
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

const SID = 'schedule_qualifications_it';
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

  await test('gate: a viewer cannot read or write the catalog', async () => {
    for (const call of [
      () => api.getQualificationCatalog(req('viewer', {})),
      () => api.saveQualification(req('viewer', { request_id: 'v1', key: 'diver', label: 'צוללן' })),
      () => api.setPersonQualifications(req('viewer', { request_id: 'v2', person: 'u1', qualifications: [] }))
    ]) {
      const error = await caught(call);
      assert.equal(error && error.code, 'manager-required');
    }
  });

  await test('the built-in catalog comes in the fixed order with three critical entries and the active source people', async () => {
    const view = await api.getQualificationCatalog(req(MGR, {}));
    assert.deepEqual(view.catalog.map((q) => q.key), ['shift_lead', 'deputy', 'officer', 'crew_commander', 'driver', 'hazmat', 'monitoring', 'ylm', 'firefighter']);
    assert.deepEqual(view.catalog.filter((q) => q.critical).map((q) => q.key), ['shift_lead', 'deputy', 'officer']);
    assert.equal(view.people.length, PEOPLE.length);
  });

  await test('create, retry, conflict, CAS update and audit on a real transaction', async () => {
    const created = await api.saveQualification(req(MGR, { request_id: 'q_create', key: 'diver', label: 'צוללן', minimum: 1, order: 150 }));
    assert.deepEqual([created.duplicate, created.revision], [false, 1]);
    const again = await api.saveQualification(req(MGR, { request_id: 'q_create', key: 'diver', label: 'צוללן', minimum: 1, order: 150 }));
    assert.equal(again.duplicate, true);
    const conflict = await caught(() => api.saveQualification(req(MGR, { request_id: 'q_create', key: 'diver', label: 'צוללנית' })));
    assert.equal(conflict && conflict.code, 'request-conflict');
    const stale = await caught(() => api.saveQualification(req(MGR, { request_id: 'q_stale', key: 'diver', label: 'צוללן עמוק', expected_revision: 0 })));
    assert.equal(stale && stale.code, 'qualification-revision-stale');
    const updated = await api.saveQualification(req(MGR, { request_id: 'q_upd', key: 'diver', label: 'צוללן עמוק', expected_revision: 1 }));
    assert.equal(updated.revision, 2);
    const doc = (await station().collection('schedule_qualifications').doc('diver').get()).data();
    assert.deepEqual([doc.label, doc.revision, doc.builtin, doc.station_id], ['צוללן עמוק', 2, false, SID]);
    const audit = (await station().collection('schedule_qualification_audit').get()).docs.map((d) => d.data());
    assert.deepEqual(audit.map((a) => a.action).sort(), ['create', 'update']);
  });

  await test('several qualifications per person, independent of roles; inactive or unknown refused', async () => {
    await api.saveQualification(req(MGR, { request_id: 'q_off', key: 'monitoring', active: false }));
    const inactive = await caught(() => api.setPersonQualifications(req(MGR, { request_id: 'h_inactive', person: 'u2', qualifications: ['monitoring'] })));
    assert.equal(inactive && inactive.code, 'holdings-inactive');
    const held = await api.setPersonQualifications(req(MGR, { request_id: 'h1', person: 'u2', qualifications: ['diver', 'firefighter', 'shift_lead'] }));
    assert.deepEqual([held.qualifications, held.revision], [['shift_lead', 'firefighter', 'diver'], 1]);
    const ghost = await caught(() => api.setPersonQualifications(req(MGR, { request_id: 'h_ghost', person: 'nobody', qualifications: ['driver'] })));
    assert.equal(ghost && ghost.code, 'person-not-member');
    const view = await api.getQualificationCatalog(req(MGR, {}));
    assert.deepEqual(view.holders, { shift_lead: 1, firefighter: 1, diver: 1 });
    assert.deepEqual(view.people.find((p) => p.uid === 'u2').qualifications, ['shift_lead', 'firefighter', 'diver']);
  });

  await test('delete: refused for built-ins and for a used custom entry; allowed once no one holds it; retry is a duplicate', async () => {
    const builtin = await caught(() => api.deleteQualification(req(MGR, { request_id: 'd_builtin', key: 'driver', expected_revision: 0 })));
    assert.equal(builtin && builtin.code, 'qualification-builtin');
    const inUse = await caught(() => api.deleteQualification(req(MGR, { request_id: 'd_inuse', key: 'diver', expected_revision: 2 })));
    assert.equal(inUse && inUse.code, 'qualification-in-use');
    await api.setPersonQualifications(req(MGR, { request_id: 'h2', person: 'u2', qualifications: ['firefighter'], expected_revision: 1 }));
    const deleted = await api.deleteQualification(req(MGR, { request_id: 'd_ok', key: 'diver', expected_revision: 2 }));
    assert.equal(deleted.duplicate, false);
    assert.equal((await station().collection('schedule_qualifications').doc('diver').get()).exists, false);
    const again = await api.deleteQualification(req(MGR, { request_id: 'd_ok', key: 'diver', expected_revision: 2 }));
    assert.equal(again.duplicate, true);
  });

  await test('a concurrent holding added between the holder count and the delete transaction refuses the delete', async () => {
    await api.saveQualification(req(MGR, { request_id: 'q_pilot', key: 'pilot', label: 'טייס' }));
    const barrier = firestoreWithCollectionReadBarrier('/' + SID + '/schedule_person_qualifications', async () => {
      await api.setPersonQualifications(req(MGR, { request_id: 'h_race', person: 'u3', qualifications: ['pilot'] }));
    });
    const error = await caught(() => runtime({ db: barrier }).deleteQualification(req(MGR, { request_id: 'd_race', key: 'pilot', expected_revision: 1 })));
    assert.equal(error && error.code, 'qualification-holders-changed', error && error.message);
    assert.equal((await station().collection('schedule_qualifications').doc('pilot').get()).exists, true);
  });

  /* ⭐ seq463 · מרוצים אמיתיים (Promise.all על עסקאות Firestore אמיתיות), לא הזרקה לפני העסקה.
   * ההוכחה: בדיוק שמירה אחת מתחייבת; השנייה נדחית בעסקה; אין מסמך חלקי; ניסיון חוזר
   * של אותו request_id מחזיר את אותה קבלה בלי כתיבה נוספת. */
  await test('seq463-a: two concurrent saves with the same label and different keys — exactly one commits, the other is refused inside the transaction', async () => {
    const before = (await station().collection('schedule_qualifications').get()).size;
    const results = await Promise.allSettled([
      api.saveQualification(req(MGR, { request_id: 'race_label_1', key: 'race_a', label: 'תווית מרוץ', order: 300 })),
      api.saveQualification(req(MGR, { request_id: 'race_label_2', key: 'race_b', label: 'תווית מרוץ', order: 301 }))
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1, 'exactly one save must commit: ' + JSON.stringify(results.map((r) => r.status === 'rejected' ? r.reason.code : 'ok')));
    assert.equal(failed.length, 1);
    assert.ok(['qualification-label-duplicate', 'qualification-catalog-changed'].indexOf(failed[0].reason.code) !== -1, failed[0].reason.code + ' · ' + failed[0].reason.message);
    const after = await station().collection('schedule_qualifications').get();
    assert.equal(after.size, before + 1, 'no partial document for the loser');
    const holders = after.docs.filter((doc) => (doc.data() || {}).label === 'תווית מרוץ');
    assert.equal(holders.length, 1);
    // idempotency: the winner's request_id again → same receipt, no new revision; the loser's request_id again → still refused, still no document.
    const winnerId = ok[0].value.key === 'race_a' ? 'race_label_1' : 'race_label_2';
    const winnerKey = ok[0].value.key;
    const replay = await api.saveQualification(req(MGR, { request_id: winnerId, key: winnerKey, label: 'תווית מרוץ', order: winnerKey === 'race_a' ? 300 : 301 }));
    assert.deepEqual([replay.duplicate, replay.key, replay.revision], [true, winnerKey, 1]);
    assert.equal((await station().collection('schedule_qualifications').get()).size, before + 1);
    const loserKey = winnerKey === 'race_a' ? 'race_b' : 'race_a';
    const loserReplay = await caught(() => api.saveQualification(req(MGR, { request_id: winnerKey === 'race_a' ? 'race_label_2' : 'race_label_1', key: loserKey, label: 'תווית מרוץ', order: loserKey === 'race_a' ? 300 : 301 })));
    assert.ok(loserReplay && loserReplay.code === 'qualification-label-duplicate', loserReplay && loserReplay.code);
    assert.equal((await station().collection('schedule_qualifications').doc(loserKey).get()).exists, false);
  });

  await test('seq463-b: two concurrent saves at the custom quota edge — exactly one commits, the quota holds, no partial document', async () => {
    const { MAX_CUSTOM } = require('./schedule-qualifications');
    const catalogNow = await api.getQualificationCatalog(req(MGR, {}));
    const customNow = catalogNow.catalog.filter((entry) => !entry.builtin).length;
    // ממלאים עד MAX_CUSTOM − 1 מותאמות (סדרתית; אלה לא חלק מהמרוץ).
    for (let i = customNow; i < MAX_CUSTOM - 1; i += 1) {
      await api.saveQualification(req(MGR, { request_id: 'fill_' + i, key: 'fill_' + i, label: 'מילוי ' + i, order: 400 + i }));
    }
    const before = (await station().collection('schedule_qualifications').get()).size;
    const results = await Promise.allSettled([
      api.saveQualification(req(MGR, { request_id: 'race_cap_1', key: 'cap_a', label: 'מכסה א', order: 900 })),
      api.saveQualification(req(MGR, { request_id: 'race_cap_2', key: 'cap_b', label: 'מכסה ב', order: 901 }))
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1, 'exactly one save must commit at the quota edge: ' + JSON.stringify(results.map((r) => r.status === 'rejected' ? r.reason.code : 'ok')));
    assert.ok(['qualification-limit', 'qualification-catalog-changed'].indexOf(failed[0].reason.code) !== -1, failed[0].reason.code + ' · ' + failed[0].reason.message);
    const after = await api.getQualificationCatalog(req(MGR, {}));
    assert.equal(after.catalog.filter((entry) => !entry.builtin).length, MAX_CUSTOM, 'the quota is exactly full, never exceeded');
    assert.equal((await station().collection('schedule_qualifications').get()).size, before + 1, 'no partial document for the loser');
    // a third save after the race is refused deterministically
    const over = await caught(() => api.saveQualification(req(MGR, { request_id: 'race_cap_3', key: 'cap_c', label: 'מכסה ג', order: 902 })));
    assert.equal(over && over.code, 'qualification-limit');
  });

  console.log('\n' + passed + ' schedule-qualifications Firestore integration checks passed.');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
