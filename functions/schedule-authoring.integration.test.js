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

const SID = 'schedule_authoring_it';
const CLOCK = () => '2026-09-01T06:00:00.000Z';
const hash = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const randomId = () => crypto.randomBytes(12).toString('hex');

function station() { return db.collection('stations').doc(SID); }
function runtimeDoc() { return station().collection('schedule_state').doc('runtime'); }

function runtime(testHooks) {
  const hooks = testHooks || {};
  return createScheduleRuntime({
    db,
    FieldValue: admin.firestore.FieldValue,
    FieldPath: admin.firestore.FieldPath,
    clock: CLOCK,
    hash,
    randomId,
    createEngine: createCalendarEngine,
    createPublication,
    createService: createScheduleService,
    isSuper: typeof hooks.isSuper === 'function' ? hooks.isSuper : () => false,
    sendPush: hooks.sendPush || (async () => ({ sent: 1 })),
    beforeSnapshotFinalize: hooks.beforeSnapshotFinalize,
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

/* --- טיוטת מדיניות. כל הערכים מפורשים; אין ברירות מחדל עסקיות. --- */
function policyDraft(over) {
  return Object.assign({
    sub_stations: {
      main: {
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
    { row: 2, employee_number: '9001', full_name: 'בדיקה אלף', sub_station: 'main', active: true, roles: ['driver'] },
    { row: 3, employee_number: '9002', full_name: 'בדיקה בית', sub_station: 'main', active: true, roles: ['firefighter'] },
    { row: 4, employee_number: '9003', full_name: 'בדיקה גימל', sub_station: 'main', active: true, roles: ['driver', 'firefighter'] }
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
    station().collection('users').doc('9001').set({ station: SID, employee_number: '9001', active: true }),
    station().collection('users').doc('9002').set({ station: SID, employee_number: '9002', active: true }),
    station().collection('users').doc('9003').set({ station: SID, employee_number: '9003', active: true })
  ]);
  await runtimeDoc().set({ mode: 'off' });
}

/* מזהה הפרסום המוכן, מהבדיקה שיוצרת אותו לבדיקות שצורכות אותו. */
let preparedId = null;

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
      sub_stations: policyDraft().sub_stations,
      rest: policyDraft().rest, rotation: null, max_shifts_per_month: 12
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
      sub_stations: policyDraft().sub_stations,
      rest: policyDraft().rest, rotation: null, max_shifts_per_month: 12
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
      sub_stations: policyDraft().sub_stations,
      rest: policyDraft().rest, rotation: null, max_shifts_per_month: 12
    }));
    assert.equal(again.duplicate, true);
    assert.equal((await station().collection('schedule_policies').get()).size, before);
  });

  await test('the same request-id with different content is refused', async () => {
    const error = await caught(() => api.savePolicy(req('manager', 'firefighter', {
      request_id: 'pol_1', activate: true, expected_policy_id: null,
      sub_stations: policyDraft({ rest: { min_gap_days: 3 } }).sub_stations,
      rest: { min_gap_days: 3 }, rotation: null, max_shifts_per_month: 12
    })));
    assert.ok(error, 'שימוש חוזר בתוכן אחר לא נחסם');
    assert.match(String(error.code || ''), /reused|already/i);
  });

  await test('a stale expected_policy_id loses the compare-and-set', async () => {
    const error = await caught(() => api.savePolicy(req('manager', 'firefighter', {
      request_id: 'pol_stale', activate: true, expected_policy_id: null,
      sub_stations: policyDraft().sub_stations,
      rest: { min_gap_days: 2 }, rotation: null, max_shifts_per_month: 12
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
    const availability = { [people[0]]: { '2026-09-01': 'yes' } };
    const locked = { [people[1]]: { '2026-09-10': 'course' } };
    const events = [{ id: 'ev_it_1', title: 'תרגיל בדיקה', date: '2026-09-05' }];
    const meta = (await ref.get()).data() || {};
    const batch = db.batch();
    Object.keys(availability).forEach((uid) =>
      batch.set(ref.collection('availability').doc(uid), { days: availability[uid] }));
    Object.keys(locked).forEach((uid) =>
      batch.set(ref.collection('locked').doc(uid), { days: locked[uid] }));
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
    const stable = (value) => {
      if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
      if (value && typeof value === 'object') {
        return '{' + Object.keys(value).sort()
          .map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
      }
      return JSON.stringify(value === undefined ? null : value);
    };
    await ref.set({ content_digest: hash(stable(basis)) }, { merge: true });

    // ועכשיו — יבוא סגל חדש, עם אדם נוסף.
    const rows = sourceRows();
    rows.push({ row: 5, employee_number: '9001', full_name: 'בדיקה אלף', sub_station: 'main', active: false, roles: ['driver'] });
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

    // והמקור החדש **נקרא** — כלומר החתימה שנכתבה תואמת לתוכן.
    const status = await api.getStatus(req('manager', 'firefighter', {}));
    assert.ok(status, 'המקור החדש אינו נקרא');
    sourceId = result.source_id;
  });

  /* ================================================================
   * 3 · התחנה מהזהות בלבד
   * ================================================================ */

  await test('a station in the payload is rejected, never honoured', async () => {
    const error = await caught(() => api.savePolicy(req('manager', 'firefighter', {
      request_id: 'pol_station', activate: true, expected_policy_id: policyId,
      station_id: 'other_station',
      sub_stations: policyDraft().sub_stations,
      rest: policyDraft().rest, rotation: null, max_shifts_per_month: 12
    })));
    assert.ok(error, 'תחנה מהלקוח לא נדחתה');
    assert.match(String(error.code || ''), /client-station-forbidden|station/i);
  });

  await test('a manager appointment in another station grants nothing here', async () => {
    const error = await caught(() => api.previewPolicy({
      auth: { uid: 'manager', token: { stationId: 'other_station', role: 'firefighter' } },
      data: {}
    }));
    assert.ok(error, 'מינוי בתחנה זרה עבד');
  });

  await test('an inactive user is refused even with a live appointment', async () => {
    const userRef = station().collection('users').doc('manager');
    const before = (await userRef.get()).data() || {};
    await userRef.set({ active: false }, { merge: true });
    try {
      const error = await caught(() => api.previewPolicy(req('manager', 'firefighter', {})));
      assert.ok(error, 'משתמש לא פעיל לא נחסם');
    } finally {
      await userRef.set(before);
    }
  });

  await test('a revoked appointment fails the closing transaction, not the staging', async () => {
    const accessRef = station().collection('schedule_access').doc('manager');
    const before = (await accessRef.get()).data() || {};
    const hooked = runtime({
      beforeSnapshotFinalize: async () => {
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
      const cfg = (await runtimeDoc().get()).data() || {};
      assert.equal(cfg.active_source_id, sourceId, 'מצביע זז למרות שהמינוי הוסר');
    } finally {
      await accessRef.set(before);
    }
  });

  /* ================================================================
   * 4 · מטריצת המצב
   * ================================================================ */

  await test('a schedule manager alone cannot move the engine mode', async () => {
    const error = await caught(() => api.setRuntimeMode(req('manager', 'firefighter', {
      request_id: 'mode_mgr', target: 'shadow', expected_mode: 'off', confirm: 'shadow'
    })));
    assert.ok(error, 'אחראי סידור הזיז מצב');
    assert.equal(error.httpErrorCode || error.http || 'permission-denied', 'permission-denied');
  });

  await test('a station_commander cannot move the engine mode either', async () => {
    const error = await caught(() => api.setRuntimeMode(req('station_cmd', 'station_commander', {
      request_id: 'mode_sc', target: 'shadow', expected_mode: 'off', confirm: 'shadow'
    })));
    assert.ok(error, 'station_commander הזיז מצב');
  });

  await test('off to new directly is forbidden', async () => {
    const error = await caught(() => api.setRuntimeMode(req('commander', 'commander', {
      request_id: 'mode_jump', target: 'new', expected_mode: 'off', confirm: 'new'
    })));
    assert.ok(error, 'קפיצה ישירה מ-off ל-new עברה');
  });

  await test('a commander moves off to shadow', async () => {
    const result = await api.setRuntimeMode(req('commander', 'commander', {
      request_id: 'mode_shadow', target: 'shadow', expected_mode: 'off', confirm: 'shadow'
    }));
    assert.ok(result);
    assert.equal(((await runtimeDoc().get()).data() || {}).mode, 'shadow');
  });

  await test('a stale expected_mode is refused', async () => {
    const error = await caught(() => api.setRuntimeMode(req('commander', 'commander', {
      request_id: 'mode_stale', target: 'off', expected_mode: 'off', confirm: 'off'
    })));
    assert.ok(error, 'expected_mode ישן לא נחסם');
  });

  /* ================================================================
   * 5 · ⭐ P0-2 · הכנה ומעבר
   * ================================================================ */

  await test('publishing while in shadow prepares and notifies nobody', async () => {
    const draft = await api.runPlanner(req('manager', 'firefighter', {
      request_id: 'plan_1', from: '2026-09-01', to: '2026-09-07'
    }));
    assert.ok(draft && draft.draft_id, 'המנוע לא בנה טיוטה ב-shadow');
    const preview = await api.getDraftPreview(req('manager', 'firefighter', {
      draft_id: draft.draft_id, from: '2026-09-01'
    }));
    const result = await api.publish(req('manager', 'firefighter', {
      request_id: 'pub_1', draft_id: draft.draft_id,
      expected_content_digest: preview.content_digest || draft.content_digest
    }));
    assert.equal(result.prepared, true, 'פרסום ב-shadow הפעיל במקום להכין');
    assert.equal(result.notified_people, 0, 'הכנה שלחה הודעות');
    const pub = (await station().collection('schedule_publications')
      .doc(result.publication_id).get()).data() || {};
    assert.equal(pub.status, 'prepared');
    // ⭐ המצביע לא זז, ולכן אין סידור פעיל.
    const pointer = await station().collection('schedule_state').doc('active').get();
    assert.equal(pointer.exists, false, 'המצביע זז בזמן הכנה');
    // וההודעות ממתינות חסומות, לא בוטלו.
    const outbox = await station().collection('schedule_publications')
      .doc(result.publication_id).collection('schedule_outbox').get();
    assert.ok(outbox.size > 0, 'לא נוצרו הודעות ממתינות');
    outbox.docs.forEach((doc) => assert.equal((doc.data() || {}).status, 'blocked'));
    preparedId = result.publication_id;
  });

  await test('resumeOutbox does not cancel a prepared publication while it waits', async () => {
    await api.resumeOutbox();
    const outbox = await station().collection('schedule_publications')
      .doc(pubId).collection('schedule_outbox').get();
    // ⭐ בלי התיקון בשומרי המתזמן, כל אלה היו מבוטלות — והמעבר היה
    // קורה בלי שאיש יקבל הודעה.
    outbox.docs.forEach((doc) =>
      assert.equal((doc.data() || {}).status, 'blocked',
        'הודעה של פרסום מוכן בוטלה בזמן ההמתנה'));
  });

  await test('a viewer in shadow sees the legacy schedule, never an empty board', async () => {
    const view = await api.getMy(req('viewer', 'firefighter', { date: '2026-09-01' }));
    assert.ok(view, 'אין תשובה לתצוגה האישית');
    assert.notEqual(view.active, false, 'הקורא קיבל לוח ריק');
  });

  await test('previewCutover signs a report that carries no identifiers', async () => {
    const report = await api.previewCutover(req('manager', 'firefighter', {
      candidate_publication_id: preparedId
    }));
    assert.ok(report.signature, 'הדוח אינו חתום');
    const text = JSON.stringify(report);
    for (const uid of ['manager', 'viewer', 'commander', '9001', '9002', '9003']) {
      assert.equal(text.indexOf(uid), -1, 'הדוח מכיל מזהה: ' + uid);
    }
    const stored = (await station().collection('schedule_preflight')
      .doc(preparedId).get()).data() || {};
    assert.equal(stored.signature, report.signature);
  });

  await test('a schedule manager cannot perform the cutover', async () => {
    const error = await caught(() => api.promoteToNew(req('manager', 'firefighter', {
      request_id: 'cut_mgr', candidate_publication_id: preparedId,
      expected_mode: 'shadow'
    })));
    assert.ok(error, 'אחראי סידור ביצע מעבר');
  });

  await test('the cutover activates publication, pointer and mode together', async () => {
    const report = await api.previewCutover(req('manager', 'firefighter', {
      candidate_publication_id: preparedId
    }));
    if (report.blocked) {
      // ⭐ אם ה-preflight חוסם — זה ממצא, לא תקלה בבדיקה. עוצרים
      // ומדווחים במקום „לתקן" בכך שמדלגים.
      assert.fail('preflight חסם את המעבר: ' + JSON.stringify(report.by_reason));
    }
    const result = await api.promoteToNew(req('commander', 'commander', {
      request_id: 'cut_1', candidate_publication_id: preparedId,
      expected_mode: 'shadow'
    }));
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
      expected_mode: 'shadow'
    }));
    assert.equal(again.duplicate, true, 'אותה בקשה בוצעה פעמיים');
    // ובקשה חדשה על אותו פרסום — הוא כבר פעיל.
    const error = await caught(() => api.promoteToNew(req('commander', 'commander', {
      request_id: 'cut_2', candidate_publication_id: preparedId,
      expected_mode: 'shadow'
    })));
    assert.ok(error, 'מעבר שני על פרסום פעיל לא נחסם');
  });

  await test('a viewer in new sees a full board', async () => {
    const view = await api.getMy(req('viewer', 'firefighter', { date: '2026-09-01' }));
    assert.notEqual(view.active, false, 'לוח ריק אחרי מעבר');
  });

  await test('turning the engine off is never blocked', async () => {
    const result = await api.setRuntimeMode(req('commander', 'commander', {
      request_id: 'mode_off', target: 'off', expected_mode: 'new', confirm: 'off',
      reason_code: 'engine_problem'
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
      rows: [{ row: 2, employee_number: 'לא-מספר', full_name: 'בדיקה סודית', sub_station: 'main', active: true, roles: ['driver'] }]
    })));
    assert.ok(error, 'שורה פגומה לא נדחתה');
    const audits = await station().collection('schedule_source_audit').get();
    const text = JSON.stringify(audits.docs.map((doc) => doc.data()));
    for (const secret of ['בדיקה אלף', 'בדיקה בית', 'בדיקה סודית', '9001', '9002', '9003']) {
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
