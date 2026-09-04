/* ====================================================================
 *  schedule-policy-write-probe
 *
 *  נתיב הכתיבה של חוקי התחנה, מקצה לקצה, בלי Firebase.
 *
 *  ----------------------------------------------------------------
 *  למה זה קיים ולמה דווקא כך
 *  ----------------------------------------------------------------
 *
 *  `savePolicy` כותב מסמך, ו-`loadPolicy` קורא אותו ומחשב מחדש את
 *  חתימת התוכן. שני הצדדים חיים באותו קובץ אבל אינם מדברים זה עם
 *  זה: אם הכותב יחתום על בסיס אחר מזה שהקורא בונה — הכתיבה תצליח,
 *  המסך יראה „נשמר", והמנוע ייפול ב-`policy-digest-mismatch` בפעם
 *  הראשונה שמישהו ינסה להריץ אותו. אצל מישהו אחר. מאוחר.
 *
 *  ⭐ לכן הבדיקה המרכזית כאן היא **הלוך ושוב**: לכתוב דרך
 *  `savePolicy`, ואז לקרוא את אותו מסמך דרך `runPlanner` — ולראות
 *  שהוא עובר. אמולטור יוכיח את אותו דבר עם Firestore אמיתי; זה
 *  מוכיח אותו עכשיו, בשנייה אחת, ובכל הרצה.
 *
 *  ה-Firestore כאן הוא כפיל בזיכרון. הוא **אינו** מדמה כללי
 *  אבטחה, אינדקסים, או התנגשויות אמיתיות של טרנזקציות — הדברים
 *  האלה נבדקים באמולטור ולא כאן, וזה נאמר במפורש בסוף הפלט.
 *
 *  יציאה: 0 עבר · 1 נכשל · 2 לא רץ.
 * ==================================================================== */

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const FN = resolve(HERE, '..', 'functions');
const require_ = createRequire(import.meta.url);

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  ok(name, a === b, 'קיבלתי ' + a + ' במקום ' + b);
}
async function throwsCode(name, fn, code) {
  try { await fn(); } catch (e) {
    ok(name, e && e.code === code, 'קוד ' + (e && e.code) + ' במקום ' + code); return;
  }
  ok(name, false, 'לא נזרקה שגיאה כלל');
}

let runtimeMod, calendarMod, publicationMod, serviceMod;
try {
  runtimeMod = require_(resolve(FN, 'schedule-runtime.js'));
  calendarMod = require_(resolve(FN, 'schedule-calendar-engine.js'));
  publicationMod = require_(resolve(FN, 'schedule-publication.js'));
  serviceMod = require_(resolve(FN, 'schedule-service.js'));
} catch (e) {
  console.error('NOT RUN — לא ניתן לטעון את מודולי הסידור: ' + e.message);
  process.exit(2);
}

/* ==================================================================
 *  כפיל Firestore · מפה שטוחה מנתיב → מסמך
 * ================================================================== */

function createFakeDb() {
  const docs = new Map();
  let writes = 0;

  function snapshot(path) {
    const has = docs.has(path);
    const value = has ? docs.get(path) : null;
    return {
      exists: has,
      id: path.slice(path.lastIndexOf('/') + 1),
      ref: docRef(path),
      data: () => (has ? JSON.parse(JSON.stringify(value)) : undefined)
    };
  }

  function collectionRef(path) {
    return {
      path,
      doc: (id) => docRef(path + '/' + String(id)),
      async get() {
        const prefix = path + '/';
        const out = [];
        for (const key of Array.from(docs.keys()).sort()) {
          if (key.indexOf(prefix) !== 0) continue;
          if (key.slice(prefix.length).indexOf('/') !== -1) continue;
          out.push(snapshot(key));
        }
        return { docs: out, size: out.length, empty: out.length === 0 };
      },
      where() { return this; },
      limit() { return this; }
    };
  }

  function docRef(path) {
    return {
      path,
      id: path.slice(path.lastIndexOf('/') + 1),
      collection: (name) => collectionRef(path + '/' + name),
      async get() { return snapshot(path); },
      async set(value, options) {
        writes++;
        const plainValue = JSON.parse(JSON.stringify(value));
        if (options && options.merge && docs.has(path)) {
          docs.set(path, Object.assign({}, docs.get(path), plainValue));
        } else docs.set(path, plainValue);
      }
    };
  }

  return {
    collection: (name) => collectionRef(name),
    async getAll(...refs) { return Promise.all(refs.map((ref) => ref.get())); },
    async runTransaction(fn) {
      // כפיל, ולא טרנזקציה. אין כאן זיהוי התנגשות אמיתי — הוא
      // נבדק באמולטור. מה שכן נאכף: קריאות לפני כתיבות, כי זו
      // המגבלה שמפילה קוד כזה בייצור.
      const staged = [];
      let wroteAlready = false;
      const tx = {
        async get(ref) {
          if (wroteAlready) {
            const error = new Error('Firestore transactions require all reads before all writes');
            error.code = 'transaction-read-after-write';
            throw error;
          }
          return ref.get();
        },
        set(ref, value, options) { wroteAlready = true; staged.push([ref, value, options]); }
      };
      const result = await fn(tx);
      for (const [ref, value, options] of staged) await ref.set(value, options);
      return result;
    },
    _docs: docs,
    _writes: () => writes,
    _put(path, value) { docs.set(path, JSON.parse(JSON.stringify(value))); },
    _get(path) { return docs.has(path) ? JSON.parse(JSON.stringify(docs.get(path))) : null; },
    _paths(prefix) {
      return Array.from(docs.keys()).filter((k) => k.indexOf(prefix) === 0).sort();
    }
  };
}

const SID = 'station-102';
const UID = 'uid-manager-1';
let now = Date.UTC(2026, 8, 2, 6, 0, 0);

function buildRuntime(db) {
  return runtimeMod.createScheduleRuntime({
    db,
    FieldValue: { serverTimestamp: () => '__ts__' },
    FieldPath: function FieldPath() {},
    clock: () => new Date(now).toISOString(),
    hash: (value) => createHash('sha256').update(String(value), 'utf8').digest('hex'),
    randomId: () => 'rnd',
    createEngine: calendarMod.createCalendarEngine,
    createPublication: publicationMod.createPublication,
    createService: serviceMod.createScheduleService,
    isSuper: () => false,
    sendPush: async () => ({ sent: 1 })
  });
}

function seed(db, options) {
  const opts = options || {};
  db._put('stations/' + SID + '/users/' + UID, {
    station_id: SID, is_active: true, active: true,
    role: 'firefighter', full_name: 'אחראי סידור'
  });
  if (opts.manager !== false) {
    db._put('stations/' + SID + '/schedule_access/' + UID, {
      schema_version: 1, station_id: SID, uid: UID,
      roles: ['schedule_manager'], active: true, revision: 3
    });
  }
  if (opts.mode) {
    db._put('stations/' + SID + '/schedule_state/runtime', { mode: opts.mode });
  }
}

function request(data) {
  return { auth: { uid: UID, token: { stationId: SID, role: 'firefighter' } }, data };
}

function draft(over) {
  const base = {
    sub_stations: {
      rashit: {
        label: 'ראשית', minimum: 6,
        requirements: [
          { role: 'officer', label: 'קצין', count: 1, required: true },
          { role: 'driver', label: 'נהג', count: 2, required: true },
          { role: 'ff', label: 'כבאי', count: 3, required: false }
        ]
      },
      timna: {
        label: 'תמנע', minimum: 3,
        requirements: [
          { role: 'driver', label: 'נהג', count: 1, required: true },
          { role: 'ff', label: 'כבאי', count: 2, required: true }
        ]
      }
    },
    rest: { min_gap_days: 2 },
    rotation: null,
    max_shifts_per_month: 12
  };
  return Object.assign(base, over || {});
}

const POLICIES = 'stations/' + SID + '/schedule_policies/';

/* ==================================================================
 * 1 · שמירה ראשונה
 * ================================================================== */

let firstSave = null;
try {
  const db = createFakeDb();
  seed(db, { mode: 'shadow' });
  const rt = buildRuntime(db);
  firstSave = await rt.savePolicy(request({
    request_id: 'req_first_1', draft: draft(), activate: true
  }));
  eq('1.1 נכתב', firstSave.written, true);
  eq('1.2 הופעל', firstSave.activated, true);
  eq('1.3 גרסה', firstSave.version, 'v1');
  eq('1.4 סוג', firstSave.kind, 'created');
  ok('1.5 המסמך קיים', !!db._get(POLICIES + firstSave.policy_id));

  const doc = db._get(POLICIES + firstSave.policy_id);
  eq('1.6 המסמך שלם', doc.complete, true);
  eq('1.7 שייך לתחנה', doc.station_id, SID);
  eq('1.8 המצביע עודכן',
    db._get('stations/' + SID + '/schedule_state/runtime').active_policy_id,
    firstSave.policy_id);

  // ⭐ שמירת מדיניות אינה מדליקה מנוע.
  eq('1.9 המצב לא השתנה',
    db._get('stations/' + SID + '/schedule_state/runtime').mode, 'shadow');
  eq('1.10 והתשובה אומרת זאת', firstSave.mode, 'shadow');

  ok('1.11 נכתב יומן', db._paths('stations/' + SID + '/schedule_policy_audit/').length === 1);
  ok('1.12 נכתבה רשומת פעולה',
    db._paths('stations/' + SID + '/schedule_policy_operations/').length === 1);
} catch (e) {
  ok('1.x שמירה ראשונה', false, (e && e.code) + ' · ' + (e && e.message));
}

/* ==================================================================
 * 2 · ⭐ הלוך ושוב · מה שנכתב נקרא בהצלחה
 *
 * `runPlanner` הוא הצרכן האמיתי. הוא קורא `loadPolicy`, שמחשב
 * מחדש את חתימת התוכן. אם החתימה לא תתאים, נקבל כאן
 * `policy-digest-mismatch` — וזה בדיוק מה שאסור שיקרה בייצור.
 * ================================================================== */

try {
  const db = createFakeDb();
  seed(db, { mode: 'new' });
  const rt = buildRuntime(db);
  const saved = await rt.savePolicy(request({
    request_id: 'req_roundtrip', draft: draft(), activate: true
  }));

  // מקור אינו קיים, ולכן `runPlanner` ייעצר — אבל **אחרי**
  // בדיקת התצורה. הקוד שמעניין אותנו הוא הקוד שנקבל.
  let code = null;
  try {
    await rt.runPlanner(request({
      request_id: 'req_plan', start: '2026-10-01', months: 1, overrides: []
    }));
  } catch (e) { code = e.code; }

  ok('2.1 לא נפלנו על חתימת מדיניות', code !== 'policy-digest-mismatch',
    'החתימה שנכתבה אינה זו ש-loadPolicy מחשב');
  ok('2.2 לא נפלנו על מדיניות חלקית', code !== 'policy-incomplete');
  eq('2.3 נעצרנו על מה שבאמת חסר — מקור', code, 'schedule-config-incomplete');

  // וכעת עם מצביע מקור מזויף: `loadPolicy` ירוץ באמת.
  db._put('stations/' + SID + '/schedule_state/runtime', {
    mode: 'new', active_policy_id: saved.policy_id, active_source_id: 'src_missing'
  });
  let code2 = null;
  try {
    await rt.runPlanner(request({
      request_id: 'req_plan_2', start: '2026-10-01', months: 1, overrides: []
    }));
  } catch (e) { code2 = e.code; }
  // ⭐ העצירה חייבת להיות על המקור החסר, ולא על המדיניות.
  eq('2.4 loadPolicy עבר, והמקור הוא שנעצר', code2, 'source-not-found');
} catch (e) {
  ok('2.x הלוך ושוב', false, (e && e.code) + ' · ' + (e && e.message));
}

/* ==================================================================
 * 3 · הרשאה
 * ================================================================== */

await (async () => {
  const db = createFakeDb();
  seed(db, { mode: 'shadow', manager: false });
  const rt = buildRuntime(db);
  await throwsCode('3.1 בלי מינוי אין כתיבה',
    () => rt.savePolicy(request({ request_id: 'r1', draft: draft(), activate: true })),
    'manager-required');
  await throwsCode('3.2 בלי מינוי אין גם תצוגה מקדימה',
    () => rt.previewPolicy(request({ draft: draft() })), 'manager-required');
  eq('3.3 שום דבר לא נכתב', db._paths(POLICIES).length, 0);
})();

await (async () => {
  const db = createFakeDb();
  seed(db, { mode: 'shadow' });
  // מינוי שבוטל — `active:false`. עדיין רשומה קיימת.
  db._put('stations/' + SID + '/schedule_access/' + UID, {
    schema_version: 1, station_id: SID, uid: UID,
    roles: [], active: false, revision: 4
  });
  const rt = buildRuntime(db);
  await throwsCode('3.4 מינוי שבוטל אינו מאפשר כתיבה',
    () => rt.savePolicy(request({ request_id: 'r2', draft: draft(), activate: true })),
    'manager-required');
})();

await (async () => {
  const db = createFakeDb();
  seed(db, { mode: 'shadow' });
  // מינוי לתחנה אחרת אינו מינוי כאן.
  db._put('stations/' + SID + '/schedule_access/' + UID, {
    schema_version: 1, station_id: 'station-999', uid: UID,
    roles: ['schedule_manager'], active: true, revision: 2
  });
  const rt = buildRuntime(db);
  await throwsCode('3.5 מינוי בתחנה זרה אינו נספר',
    () => rt.savePolicy(request({ request_id: 'r3', draft: draft(), activate: true })),
    'manager-required');
})();

/* ==================================================================
 * 4 · התחנה אינה מתקבלת מהלקוח
 * ================================================================== */

await (async () => {
  const db = createFakeDb();
  seed(db, { mode: 'shadow' });
  const rt = buildRuntime(db);
  // ⭐ שליחת תחנה בגוף הבקשה אינה „מתעלמים ממנה" — היא נדחית.
  // זו ההתנהגות הנכונה: בקשה שמנסה לבחור תחנה היא בקשה שגויה,
  // ושתיקה עליה מלמדת את הלקוח שמותר לנסות.
  await throwsCode('4.1 תחנה בגוף הבקשה נדחית', () => rt.savePolicy({
    auth: { uid: UID, token: { stationId: SID, role: 'firefighter' } },
    data: { request_id: 'r_station', draft: draft(), activate: true, station_id: 'station-999' }
  }), 'client-station-forbidden');
  eq('4.2 שום דבר לא נכתב', db._paths(POLICIES).length, 0);
  eq('4.3 ובוודאי לא לתחנה שנשלחה', db._paths('stations/station-999/').length, 0);

  // ובלי השדה — עובר, ונכתב לתחנה של הזהות.
  const saved = await rt.savePolicy(request({
    request_id: 'r_station_ok', draft: draft(), activate: true
  }));
  eq('4.4 המסמך נכתב לתחנה של הזהות',
    db._get(POLICIES + saved.policy_id).station_id, SID);
})();

/* ==================================================================
 * 5 · אידמפוטנטיות והתנגשות
 * ================================================================== */

await (async () => {
  const db = createFakeDb();
  seed(db, { mode: 'shadow' });
  const rt = buildRuntime(db);
  const a = await rt.savePolicy(request({ request_id: 'rid_1', draft: draft(), activate: true }));
  const before = db._paths(POLICIES).length;
  const b = await rt.savePolicy(request({ request_id: 'rid_1', draft: draft(), activate: true }));
  eq('5.1 חזרה על אותה בקשה מסומנת ככפולה', b.duplicate, true);
  eq('5.2 אותה תוצאה', b.policy_id, a.policy_id);
  eq('5.3 ולא נוצר מסמך שני', db._paths(POLICIES).length, before);

  // אותו מזהה בקשה עם תוכן אחר — ניסיון להחליף פעולה שכבר בוצעה.
  await throwsCode('5.4 מזהה בקשה שמשמש לתוכן אחר נדחה', () => rt.savePolicy(request({
    request_id: 'rid_1', draft: draft({ rest: { min_gap_days: 5 } }), activate: true
  })), 'policy-request-reused');

  // שתי לשוניות: השנייה חושבת שאין מדיניות פעילה.
  await throwsCode('5.5 שמירה מעל מצב שהשתנה נעצרת', () => rt.savePolicy(request({
    request_id: 'rid_2', draft: draft({ rest: { min_gap_days: 4 } }),
    activate: true, expected_policy_id: null
  })), 'policy-conflict');

  // עם המצב הנכון — עובר.
  const c = await rt.savePolicy(request({
    request_id: 'rid_3', draft: draft({ rest: { min_gap_days: 4 } }),
    activate: true, expected_policy_id: a.policy_id
  }));
  eq('5.6 עם המצב הנכון השמירה עוברת', c.written, true);
  eq('5.7 והגרסה עולה', c.version, 'v2');
  eq('5.8 המסמך הקודם נשמר', db._paths(POLICIES).length, 2);
  eq('5.9 supersedes מצביע לקודם',
    db._get(POLICIES + c.policy_id).supersedes, a.policy_id);
})();

/* ==================================================================
 * 6 · „לא השתנה כלום" אינו יוצר גרסה
 * ================================================================== */

await (async () => {
  const db = createFakeDb();
  seed(db, { mode: 'shadow' });
  const rt = buildRuntime(db);
  const a = await rt.savePolicy(request({ request_id: 'nc_1', draft: draft(), activate: true }));
  const same = await rt.savePolicy(request({
    request_id: 'nc_2', draft: draft(), activate: true, expected_policy_id: a.policy_id
  }));
  eq('6.1 מדווח כ-unchanged', same.kind, 'unchanged');
  eq('6.2 לא נכתב', same.written, false);
  eq('6.3 ולא נוצר מסמך שני', db._paths(POLICIES).length, 1);
  eq('6.4 המצביע לא זז',
    db._get('stations/' + SID + '/schedule_state/runtime').active_policy_id, a.policy_id);
})();

/* ==================================================================
 * 7 · החלשה דורשת אמירה מפורשת
 * ================================================================== */

await (async () => {
  const db = createFakeDb();
  seed(db, { mode: 'shadow' });
  const rt = buildRuntime(db);
  const a = await rt.savePolicy(request({ request_id: 'w_1', draft: draft(), activate: true }));

  const lower = draft();
  lower.sub_stations.rashit.minimum = 4;

  await throwsCode('7.1 הורדת קו מינימום בלי אישור נעצרת', () => rt.savePolicy(request({
    request_id: 'w_2', draft: lower, activate: true, expected_policy_id: a.policy_id
  })), 'policy-weakening-unconfirmed');
  eq('7.2 ולא נכתב דבר', db._paths(POLICIES).length, 1);

  const done = await rt.savePolicy(request({
    request_id: 'w_3', draft: lower, activate: true,
    expected_policy_id: a.policy_id, confirm_weakening: true
  }));
  eq('7.3 עם אישור מפורש — נכתב', done.written, true);
  eq('7.4 ההחלשה מדווחת', done.weakening.length, 1);
  eq('7.5 והיומן סופר אותה',
    db._get(db._paths('stations/' + SID + '/schedule_policy_audit/')[1]
      || db._paths('stations/' + SID + '/schedule_policy_audit/')[0]).weakening_count !== undefined,
    true);

  // חיזוק התקן אינו דורש אישור.
  const higher = draft();
  higher.sub_stations.rashit.minimum = 9;
  const up = await rt.savePolicy(request({
    request_id: 'w_4', draft: higher, activate: true, expected_policy_id: done.policy_id
  }));
  eq('7.6 חיזוק עובר בלי אישור', up.written, true);
  eq('7.7 ואין בו החלשות', up.weakening, []);
})();

/* ==================================================================
 * 8 · שמירה בלי הפעלה
 * ================================================================== */

await (async () => {
  const db = createFakeDb();
  seed(db, { mode: 'shadow' });
  const rt = buildRuntime(db);
  const saved = await rt.savePolicy(request({
    request_id: 'na_1', draft: draft(), activate: false
  }));
  eq('8.1 נכתב', saved.written, true);
  eq('8.2 לא הופעל', saved.activated, false);
  ok('8.3 המסמך קיים', !!db._get(POLICIES + saved.policy_id));
  const runtimeDoc = db._get('stations/' + SID + '/schedule_state/runtime');
  ok('8.4 המצביע לא הופנה אליו',
    !runtimeDoc || runtimeDoc.active_policy_id !== saved.policy_id);

  await throwsCode('8.5 הפעלה חייבת להיות מוצהרת', () => rt.savePolicy({
    auth: { uid: UID, token: { stationId: SID, role: 'firefighter' } },
    data: { request_id: 'na_2', draft: draft() }
  }), 'policy-activate-required');
})();

/* ==================================================================
 * 9 · תצוגה מקדימה אינה כותבת
 * ================================================================== */

await (async () => {
  const db = createFakeDb();
  seed(db, { mode: 'shadow' });
  const rt = buildRuntime(db);
  const before = db._writes();
  const preview = await rt.previewPolicy(request({ draft: draft() }));
  eq('9.1 שום כתיבה', db._writes(), before);
  eq('9.2 מדווח מה ייווצר', preview.kind, 'created');
  eq('9.3 עם גרסה', preview.version, 'v1');
  ok('9.4 עם אזהרות אם יש', Array.isArray(preview.warnings));

  // ⭐ המסמך עצמו אינו יוצא לדפדפן. הוא הדבר שעליו חותמים.
  ok('9.5 המסמך אינו מוחזר', preview.document === undefined);
  ok('9.6 ובשמירה גם לא', (await rt.savePolicy(request({
    request_id: 'pv_1', draft: draft(), activate: false
  }))).document === undefined);
})();

/* ==================================================================
 * 10 · שגיאות המודול מגיעות כקודים מובנים
 * ================================================================== */

await (async () => {
  const db = createFakeDb();
  seed(db, { mode: 'shadow' });
  const rt = buildRuntime(db);
  const noMinimum = draft();
  delete noMinimum.sub_stations.rashit.minimum;
  await throwsCode('10.1 קו מינימום חסר עולה כקוד', () => rt.savePolicy(request({
    request_id: 'e_1', draft: noMinimum, activate: true
  })), 'policy-author-minimum-missing');

  const noRest = draft();
  delete noRest.rest;
  await throwsCode('10.2 מנוחה חסרה עולה כקוד', () => rt.savePolicy(request({
    request_id: 'e_2', draft: noRest, activate: true
  })), 'policy-author-rest-missing');

  await throwsCode('10.3 בלי טיוטה כלל', () => rt.savePolicy(request({
    request_id: 'e_3', activate: true
  })), 'policy-draft-required');

  eq('10.4 ואף מסמך לא נכתב', db._paths(POLICIES).length, 0);
})();

/* ==================================================================
 * 11 · פרטיות · שום שם ושום דוא"ל במה שנכתב
 * ================================================================== */

await (async () => {
  const db = createFakeDb();
  seed(db, { mode: 'shadow' });
  const rt = buildRuntime(db);
  const dirty = draft();
  dirty.sub_stations.rashit.note = 'לתאם עם דני כהן, dani@example.com';
  const saved = await rt.savePolicy(request({
    request_id: 'p_1', draft: dirty, activate: true
  }));
  const all = JSON.stringify([
    db._get(POLICIES + saved.policy_id),
    db._get(db._paths('stations/' + SID + '/schedule_policy_audit/')[0]),
    db._get(db._paths('stations/' + SID + '/schedule_policy_operations/')[0])
  ]);
  ok('11.1 אין דוא"ל', all.indexOf('dani@example.com') === -1);
  ok('11.2 אין שם', all.indexOf('דני כהן') === -1);
  ok('11.3 אין הערה חופשית', all.indexOf('לתאם עם') === -1);
  ok('11.4 היומן מחזיק uid בלבד',
    db._get(db._paths('stations/' + SID + '/schedule_policy_audit/')[0]).actor_uid === UID);
  ok('11.5 והיומן אינו מחזיק שם',
    JSON.stringify(db._get(db._paths('stations/' + SID + '/schedule_policy_audit/')[0]))
      .indexOf('אחראי סידור') === -1);
})();

/* ==================================================================
 * 12 · הטרנזקציה · קריאות לפני כתיבות
 *
 * הכפיל זורק אם נקראה קריאה אחרי כתיבה. זו המגבלה האמיתית של
 * Firestore, והיא מפילה קוד כזה בייצור ולא בפיתוח.
 * ================================================================== */

await (async () => {
  const db = createFakeDb();
  seed(db, { mode: 'shadow' });
  const rt = buildRuntime(db);
  let ordered = true;
  try {
    const a = await rt.savePolicy(request({ request_id: 't_1', draft: draft(), activate: true }));
    await rt.savePolicy(request({
      request_id: 't_2', draft: draft({ rest: { min_gap_days: 3 } }),
      activate: true, expected_policy_id: a.policy_id
    }));
  } catch (e) {
    if (e && e.code === 'transaction-read-after-write') ordered = false;
    else throw e;
  }
  ok('12.1 כל הקריאות לפני כל הכתיבות', ordered,
    'savePolicy קורא מסמך אחרי שכתב — Firestore יסרב');
})();

/* ==================================================================
 * סיכום
 * ================================================================== */

if (fails.length) {
  console.error('schedule-policy-write-probe · נכשל');
  for (const f of fails) console.error('  ✗ ' + f);
  console.error('  ' + pass + ' עברו · ' + fails.length + ' נכשלו');
  process.exit(1);
}
console.log('schedule-policy-write-probe · ' + pass + '/' + pass + ' עברו');
console.log('  לא נבדק כאן: כללי Firestore, אינדקסים, והתנגשות טרנזקציה');
console.log('  אמיתית. אלה דורשים אמולטור ולא הורצו בריצה הזאת.');
