'use strict';

/* ====================================================================
 *  schedule-gaps.integration.test · 42H.2 חבילה ג׳ — בקרת פערים
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
 *      "cd functions && node schedule-gaps.integration.test.js"
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

const SID = 'schedule_gaps_it';
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
  const aliases = { 'רועי': 'u1', 'אבטחה': null };
  let imported = null;
  let preview = null;

  await test('seed: import the sheet; the draft preview reports the below-line days as acknowledgeable gaps', async () => {
    const ready = await api.previewScheduleImport(req(MGR, { month: '2026-09', paste: SHEET, aliases }));
    assert.equal(ready.blocked, false, JSON.stringify(ready.blocked_by));
    imported = await api.importScheduleSheet(req(MGR, { request_id: 'gap_seed_import', month: '2026-09', paste: SHEET, aliases, expected_report_digest: ready.report_digest }));
    preview = await api.getDraftPreview(req(MGR, { draft_id: imported.draft_id, start: '2026-09-01' }));
    assert.ok(preview.gaps && preview.gaps.summary.other_gaps >= 1, JSON.stringify(preview.gaps && preview.gaps.summary));
    assert.equal(preview.gaps.blocking.length, 0);
    assert.equal(typeof preview.gaps.digest, 'string');
  });

  await test('publish without the acknowledgement is refused; with a wrong digest refused; with the exact digest it prepares (shadow)', async () => {
    const missing = await caught(() => api.publish(req(MGR, { request_id: 'gap_pub', draft_id: imported.draft_id, expected_content_digest: preview.expected_content_digest })));
    assert.equal(missing && missing.code, 'gaps-acknowledgement-required', missing && missing.message);
    assert.ok(missing.detail && missing.detail.digest === preview.gaps.digest);
    const wrong = await caught(() => api.publish(req(MGR, { request_id: 'gap_pub', draft_id: imported.draft_id, expected_content_digest: preview.expected_content_digest, gap_acknowledgement: 'nope' })));
    assert.equal(wrong && wrong.code, 'gaps-acknowledgement-required');
    assert.equal((await station().collection('schedule_publications').get()).size, 0, 'nothing written for a refused publish');
    const prepared = await api.publish(req(MGR, { request_id: 'gap_pub', draft_id: imported.draft_id, expected_content_digest: preview.expected_content_digest, gap_acknowledgement: preview.gaps.digest }));
    assert.equal(prepared.prepared, true);
    const pub = (await station().collection('schedule_publications').doc(prepared.publication_id).get()).data();
    assert.deepEqual([pub.gap_report.acknowledged, pub.gap_report.digest, pub.gap_report.acknowledged_by], [true, preview.gaps.digest, MGR]);
    const audit = (await station().collection('schedule_audit').get()).docs.map((d) => d.data()).find((a) => a.action === 'prepare');
    assert.equal(audit.gaps_acknowledged, preview.gaps.digest);
  });

  await test('a critical qualification minimum with no holder blocks a new draft publish; a candidate is offered, never assigned', async () => {
    await api.saveQualification(req(MGR, { request_id: 'gap_lead', key: 'shift_lead', minimum: 1 }));
    await api.setPersonQualifications(req(MGR, { request_id: 'gap_hold', person: 'u4', qualifications: ['shift_lead'] }));
    const ready = await api.previewScheduleImport(req(MGR, { month: '2026-09', paste: SHEET, aliases }));
    const second = await api.importScheduleSheet(req(MGR, { request_id: 'gap_import2', month: '2026-09', paste: SHEET, aliases, expected_report_digest: ready.report_digest }));
    const preview2 = await api.getDraftPreview(req(MGR, { draft_id: second.draft_id, start: '2026-09-01' }));
    assert.ok(preview2.gaps.blocking.length >= 1 && preview2.gaps.blocking.every((g) => g.key === 'shift_lead'), JSON.stringify(preview2.gaps.blocking));
    const blocked = await caught(() => api.publish(req(MGR, { request_id: 'gap_pub2', draft_id: second.draft_id, expected_content_digest: preview2.expected_content_digest, gap_acknowledgement: preview2.gaps.digest || '' })));
    assert.equal(blocked && blocked.code, 'gaps-critical', blocked && blocked.message);
    const report = await api.getGapReport(req(MGR, { draft_id: second.draft_id }));
    const dayGap = report.days.find((d) => d.has_critical_gap);
    assert.ok(dayGap, 'a day with a critical gap');
    const lead = dayGap.qualifications.find((q) => q.key === 'shift_lead');
    // u4 מחזיק ראש משמרת; ביום שבו הוא פנוי הוא מועמד — והטיוטה לא השתנתה.
    const dayWithCandidate = report.days.find((d) => d.qualifications.find((q) => q.key === 'shift_lead').candidates.some((c) => c.uid === 'u4'));
    assert.ok(dayWithCandidate, 'u4 offered as a candidate somewhere');
    assert.ok(lead.gap >= 1);
    const stillDraft = (await station().collection('schedule_drafts').doc(second.draft_id).get()).data();
    assert.equal(stillDraft.content_digest, preview2.expected_content_digest, 'the draft was not touched by the gap report');
  });

  await test('station minimum: saved with CAS and audit; a retry is a duplicate', async () => {
    const saved = await api.saveGapPolicy(req(MGR, { request_id: 'gp1', station_minimum: 9 }));
    assert.deepEqual([saved.station_minimum, saved.revision, saved.duplicate], [9, 1, false]);
    const again = await api.saveGapPolicy(req(MGR, { request_id: 'gp1', station_minimum: 9 }));
    assert.equal(again.duplicate, true);
    const stale = await caught(() => api.saveGapPolicy(req(MGR, { request_id: 'gp2', station_minimum: 3, expected_revision: 0 })));
    assert.equal(stale && stale.code, 'gap-policy-revision-stale');
    const view = await api.getQualificationCatalog(req(MGR, {}));
    assert.deepEqual(view.gap_policy, { station_minimum: 9, revision: 1 });
  });

  await runtimeDoc().set({ mode: 'off' }, { merge: true });
  console.log('\n' + passed + ' schedule-gaps Firestore integration checks passed.');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
