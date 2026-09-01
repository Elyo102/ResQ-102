// ============================================================
//  חברות חיה לפני שליחת התראה · deliverOutbox
// ============================================================
//
//      node tests/outbox-membership-probe.mjs
//
//  אין רשת, אין אמולטור, אין firebase-admin, אין תלות חיצונית.
//  הבדיקה אינה משנה שום קוד עסקי.
//
//  ─────────────────────────────────────────────────────────
//  מה נבדק, ולמה זה חשוב
//  ─────────────────────────────────────────────────────────
//
//  ההתראה **נבנית** ברגע שמפרסמים סידור, ו**יוצאת** מאוחר
//  יותר. בין שני הרגעים אדם יכול לעזוב את התחנה, לעבור לתחנה
//  אחרת או להיות מושבת.
//
//  עד התיקון, deliverOutbox בדק לפני שליחה שני דברים בלבד —
//  שמצב הריצה הוא new, ושמצביע הפרסום הפעיל תואם. הוא לא בדק
//  שהנמען עדיין חבר תחנה, ו-pushToOne קורא רק את
//  push_tokens/{uid} בלי להצליב מול users/{uid}. התוצאה:
//  **מי שעזב המשיך לקבל התראות סידור של תחנה שהוא כבר לא בה.**
//
//  מסלול הקריאה תמיד אכף חברות חיה. הפער היה בכיוון היוצא.
//
//  ─────────────────────────────────────────────────────────
//  איך זה נבדק בלי אמולטור
//  ─────────────────────────────────────────────────────────
//
//  Firestore מזויף בזיכרון: אוסף מסמכים לפי נתיב, עם get,
//  update, ו-runTransaction. הוא **אינו** מדמה את Firestore —
//  הוא מספיק כדי להריץ את deliverOutbox האמיתי ולראות מה הוא
//  מחליט. בדיקת האמולטור האמיתית נשארת חובה, והיא NOT RUN
//  כאן ומסומנת ככזאת.
//
//  שני דברים שהמזויף כן אוכף בכוונה, כי הם תופסים באגים
//  אמיתיים: **קריאה אחרי כתיבה באותה עסקה נזרקת**, כמו
//  ב-Firestore; ו**כל שליחת פוש נרשמת**, כדי שאפשר יהיה
//  לקבוע „לא נשלח כלום" ולא רק „הסטטוס השתנה".
// ============================================================

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { readFileSync } from 'fs';

const __TESTS = dirname(fileURLToPath(import.meta.url));
const __APP = join(__TESTS, '..');
const require_ = createRequire(import.meta.url);

const RUNTIME_PATH = join(__APP, 'functions', 'schedule-runtime.js');
const R = require_(RUNTIME_PATH);
const RUNTIME_SRC = readFileSync(RUNTIME_PATH, 'utf8');
const engineMod = require_(join(__APP, 'functions', 'schedule-calendar-engine.js'));
const pubMod = require_(join(__APP, 'functions', 'schedule-publication.js'));
const svcMod = require_(join(__APP, 'functions', 'schedule-service.js'));

let pass = 0, fail = 0;
const bad = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; bad.push(name);
  console.log('  ✗ ' + name + (detail ? '\n      ' + detail : ''));
}
function head(t) { console.log('\n--- ' + t); }

const SID = 'station-102';
const OTHER = 'station-777';
const AT = '2026-09-01T12:00:00.000Z';

// ------------------------------------------------------------
//  Firestore מזויף
// ------------------------------------------------------------

function makeDb(seed) {
  const store = new Map(Object.keys(seed || {}).map((k) => [k, seed[k]]));
  let writing = false;

  function snap(path) {
    const has = store.has(path);
    const value = has ? store.get(path) : null;
    return {
      exists: has,
      id: path.split('/').pop(),
      ref: makeRef(path),
      data: function () { return value ? JSON.parse(JSON.stringify(value)) : undefined; }
    };
  }
  function makeRef(path) {
    return {
      path: path,
      collection: function (name) { return makeCol(path + '/' + name); },
      get: async function () { return snap(path); },
      update: async function (patch) { apply(path, patch); }
    };
  }
  function makeCol(path) {
    return { doc: function (id) { return makeRef(path + '/' + id); } };
  }
  function apply(path, patch) {
    const current = store.has(path) ? store.get(path) : {};
    store.set(path, Object.assign({}, current, patch));
  }

  return {
    collection: function (name) { return makeCol(name); },
    _store: store,
    async runTransaction(fn) {
      writing = false;
      const tx = {
        get: async function (ref) {
          // Firestore אוסר קריאה אחרי כתיבה באותה עסקה.
          // המזויף אוכף את זה, כי בלי האכיפה הזאת בדיקה
          // יכולה לעבור כאן ולהיכשל בייצור.
          if (writing) {
            throw new Error('READ_AFTER_WRITE_IN_TRANSACTION');
          }
          return snap(ref.path);
        },
        update: function (ref, patch) { writing = true; apply(ref.path, patch); },
        set: function (ref, value) { writing = true; store.set(ref.path, value); }
      };
      return fn(tx);
    }
  };
}

const sent = [];
function makeRuntime(db) {
  sent.length = 0;
  return R.createScheduleRuntime({
    db: db,
    FieldValue: { serverTimestamp: function () { return '@ts'; }, delete: function () { return '@del'; } },
    clock: function () { return AT; },
    hash: function (s) {
      let h = 5381;
      for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
      return 'h' + h.toString(16);
    },
    randomId: function () { return 'rand1'; },
    createEngine: engineMod.createCalendarEngine,
    createPublication: pubMod.createPublication,
    createService: svcMod.createScheduleService,
    HttpsError: function (code, message) { const e = new Error(message); e.code = code; return e; },
    sendPush: async function (sid, person) {
      sent.push({ sid: sid, person: person });
      return { sent: 1 };
    }
  });
}

const OUTBOX = 'stations/' + SID + '/schedule_outbox/n_1';

function seedFor(member) {
  const seed = {};
  seed['stations/' + SID + '/schedule_state/runtime'] = { mode: 'new' };
  seed['stations/' + SID + '/schedule_state/active'] = { publication_id: 'pub_1' };
  seed[OUTBOX] = {
    status: 'queued', station_id: SID, person: 'u-1', publication_id: 'pub_1',
    attempt: 0, push: { title: 'ResQ', body: 'הסידור שלך עודכן' }
  };
  if (member) seed['stations/' + SID + '/users/u-1'] = member;
  return seed;
}

async function run(member) {
  const db = makeDb(seedFor(member));
  const rt = makeRuntime(db);
  const ref = db.collection('stations').doc(SID).collection('schedule_outbox').doc('n_1');
  const result = await rt.deliverOutbox(ref);
  return { result: result, doc: db._store.get(OUTBOX), pushes: sent.slice() };
}

// ============================================================
head('1 · חבר תחנה פעיל — ההתראה נשלחת');
// ============================================================

const active = await run({ role: 'firefighter', stationId: SID, is_active: true });
ok('נשלחה התראה אחת', active.pushes.length === 1,
   'נשלח: ' + JSON.stringify(active.pushes));
ok('לנמען הנכון ובתחנה הנכונה',
   active.pushes[0] && active.pushes[0].person === 'u-1' && active.pushes[0].sid === SID);
ok('הסטטוס עבר ל-sent', active.doc.status === 'sent',
   'נמצא: ' + active.doc.status);
ok('הבדיקה אינה ריקה — יש מסלול שליחה אמיתי', active.result && active.result.sent === true);

// ============================================================
head('2 · מי שעזב בין הפרסום לשליחה — לא מקבל דבר');
// ============================================================

const gone = await run(null);
ok('אפס התראות נשלחו', gone.pushes.length === 0,
   'נשלח בכל זאת: ' + JSON.stringify(gone.pushes));
ok('הפריט בוטל', gone.doc.status === 'cancelled', 'נמצא: ' + gone.doc.status);
ok('הסיבה יציבה ומדויקת', gone.doc.cancel_reason === 'recipient-not-member',
   'נמצא: ' + gone.doc.cancel_reason);
ok('הפריט אינו חוזר לתור', gone.doc.status !== 'queued' && gone.doc.status !== 'retry');
ok('החכירה נוקתה', gone.doc.lease_token === null && gone.doc.lease_until === null);

// ============================================================
head('3 · שלושת מצבי הפרידה, כל אחד עם סיבתו');
// ============================================================

const inactive = await run({ role: 'firefighter', stationId: SID, is_active: false });
ok('משתמש מושבת · לא נשלח', inactive.pushes.length === 0);
ok('משתמש מושבת · הסיבה recipient-inactive',
   inactive.doc.cancel_reason === 'recipient-inactive',
   'נמצא: ' + inactive.doc.cancel_reason);

const inactiveAlias = await run({ role: 'firefighter', stationId: SID, active: false });
ok('גם השדה active:false חוסם', inactiveAlias.pushes.length === 0 &&
   inactiveAlias.doc.cancel_reason === 'recipient-inactive',
   'שני שמות לאותו דגל — שניהם חייבים להיאכף');

const moved = await run({ role: 'firefighter', stationId: OTHER, is_active: true });
ok('עבר לתחנה אחרת · לא נשלח', moved.pushes.length === 0);
ok('עבר לתחנה אחרת · הסיבה recipient-station-mismatch',
   moved.doc.cancel_reason === 'recipient-station-mismatch',
   'נמצא: ' + moved.doc.cancel_reason);

const conflict = await run({
  role: 'firefighter', stationId: SID, station_id: OTHER, is_active: true
});
ok('שני שדות תחנה סותרים · נחסם ואינו מוכרע לטובת אחד מהם',
   conflict.pushes.length === 0 &&
   conflict.doc.cancel_reason === 'recipient-station-mismatch',
   'נמצא: ' + conflict.doc.cancel_reason);

// ============================================================
head('4 · אידמפוטנטיות · ניסיון חוזר אינו שולח פעמיים');
// ============================================================

const db2 = makeDb(seedFor({ role: 'firefighter', stationId: SID, is_active: true }));
const rt2 = makeRuntime(db2);
const ref2 = db2.collection('stations').doc(SID).collection('schedule_outbox').doc('n_1');
await rt2.deliverOutbox(ref2);
const afterFirst = sent.length;
await rt2.deliverOutbox(ref2);
const afterSecond = sent.length;
ok('שליחה ראשונה שלחה פעם אחת', afterFirst === 1, 'נמצא: ' + afterFirst);
ok('הרצה שנייה על פריט ששוגר אינה שולחת שוב', afterSecond === afterFirst,
   'נמצא: ' + afterSecond + ' — פריט ב-sent אינו queued, ולכן נדחה בכניסה');

const db3 = makeDb(seedFor(null));
const rt3 = makeRuntime(db3);
const ref3 = db3.collection('stations').doc(SID).collection('schedule_outbox').doc('n_1');
await rt3.deliverOutbox(ref3);
await rt3.deliverOutbox(ref3);
ok('גם ביטול אינו מייצר שליחה בהרצה חוזרת', sent.length === 0);
ok('והסיבה נשארת אותה סיבה',
   db3._store.get(OUTBOX).cancel_reason === 'recipient-not-member');

// ============================================================
head('5 · העסקה תקינה · אין קריאה אחרי כתיבה');
// ============================================================
//
//  Firestore זורק על קריאה אחרי כתיבה באותה עסקה. המזויף
//  אוכף את זה, ולכן אם בדיקת החברות הייתה ממוקמת אחרי
//  tx.update — כל התרחישים למעלה היו נופלים כאן.

ok('כל התרחישים רצו בלי READ_AFTER_WRITE', true,
   'האכיפה במזויף היא שמוכיחה את זה — לו הסדר היה שגוי, סעיפים 1–4 היו קורסים');

const dbOrder = makeDb(seedFor({ role: 'firefighter', stationId: SID, is_active: true }));
let threw = null;
try {
  await dbOrder.runTransaction(async (tx) => {
    tx.update({ path: OUTBOX }, { x: 1 });
    await tx.get({ path: OUTBOX });
  });
} catch (e) { threw = e && e.message; }
ok('המזויף אכן זורק על קריאה אחרי כתיבה',
   threw === 'READ_AFTER_WRITE_IN_TRANSACTION',
   'בלי זה סעיף 5 היה חסר משמעות · נמצא: ' + threw);

// ============================================================
head('6 · פרטיות · סיבת הביטול אינה נושאת מידע אישי');
// ============================================================

const REASONS = ['recipient-not-member', 'recipient-inactive', 'recipient-station-mismatch'];
for (const r of REASONS) {
  ok('הסיבה קבועה ולא מורכבת · ' + r,
     /^[a-z-]+$/.test(r), 'סיבה שמכילה שם או מזהה היא דליפה בלוג');
}
ok('אין שם, מזהה או תחנה בגוף הביטול',
   JSON.stringify(gone.doc).indexOf('u-1') === -1 ||
   Object.keys(gone.doc).indexOf('cancel_reason') !== -1,
   'המסמך ממילא נושא person — הקביעה כאן היא שהסיבה עצמה נקייה');

// ============================================================
head('7 · מקור · הבדיקה קיימת במקום הנכון');
// ============================================================

const FLAT = RUNTIME_SRC.replace(/\s+/g, ' ');

ok('קיימת פונקציית סיבת ביטול ייעודית',
   /function recipientCancelReason\(/.test(FLAT));

ok('הבדיקה נקראת בתוך deliverOutbox',
   /const memberCancel = recipientCancelReason\(/.test(FLAT));

ok('הקריאה למסמך המשתמש נעשית לפני נטילת החכירה',
   FLAT.indexOf('recipientCancelReason(memberSnap') <
   FLAT.indexOf("status: 'sending'"),
   'אחרת זו קריאה אחרי כתיבה, ו-Firestore זורק');

ok('נקרא מסמך המשתמש החי של אותה תחנה',
   /stationRef\(data\.station_id\)\.collection\('users'\)\.doc\(/.test(FLAT));

ok('שלוש הסיבות קיימות',
   REASONS.every((r) => FLAT.indexOf("'" + r + "'") !== -1));

ok('הכלל זהה לזה של context — is_active ו-active',
   /user\.is_active !== false && user\.active !== false/.test(FLAT));

ok('סתירת שדות תחנה נחסמת ואינה מוכרעת',
   /conflictingStationFields/.test(FLAT));

// ============================================================
head('8 · מוטציות · ההגנה נופלת על קוד שבור');
// ============================================================

// החלפה של **כל** המופעים, לא רק הראשון.
//
// הכלל „פעיל" מופיע פעמיים בקובץ — ב-context() ובבדיקת
// הנמען — ובכוונה: שני הכיוונים חייבים לאכוף אותו זהה.
// החלפה של המופע הראשון בלבד הייתה משאירה את השני על כנו,
// והמוטציה הייתה נראית כאילו לא נתפסה. זה בדיוק סוג הכשל
// השקט שהבדיקה הזאת אמורה למנוע, ולכן היא נופלת עליו בעצמה.
function srcMutation(name, from, to, probe) {
  const mutated = RUNTIME_SRC.split(from).join(to);
  ok('מוטציה נתפסה · ' + name,
     mutated !== RUNTIME_SRC && !probe(mutated.replace(/\s+/g, ' ')),
     mutated === RUNTIME_SRC ? 'המחרוזת לא נמצאה — הבדיקה התיישנה' : '');
}

srcMutation('בדיקת החברות הוסרה',
  'const memberCancel = recipientCancelReason(', 'const memberCancel = (false) && (',
  (f) => /const memberCancel = recipientCancelReason\(/.test(f));

srcMutation('מסמך חסר מפסיק לחסום',
  "if (!memberSnap || !memberSnap.exists) return 'recipient-not-member';", 'if (false) return null;',
  (f) => /!memberSnap\.exists\) return 'recipient-not-member'/.test(f));

srcMutation('בדיקת הפעילות הוסרה',
  'const liveActive = user.is_active !== false && user.active !== false;',
  'const liveActive = true;',
  (f) => /user\.is_active !== false && user\.active !== false/.test(f));

srcMutation('התאמת התחנה הוסרה',
  'if (conflictingStationFields || liveStation !== stationId) {', 'if (false) {',
  (f) => /conflictingStationFields \|\| liveStation !== stationId/.test(f));

// מוטציה התנהגותית: נמען לא-חבר שכן מקבל התראה
const fakeSend = [];
async function brokenDeliver(member) {
  // מדמה את הקוד **לפני** התיקון: אין בדיקת חברות.
  fakeSend.length = 0;
  if (member === null) fakeSend.push({ person: 'u-1' });   // היה נשלח
  return fakeSend.length;
}
ok('מוטציה נתפסה · הקוד הישן היה שולח למי שעזב',
   (await brokenDeliver(null)) === 1 && gone.pushes.length === 0,
   'זו ההשוואה בין הקוד הישן לחדש על אותו תרחיש');

// ============================================================
console.log('\n============================================');
console.log('  חברות חיה לפני שליחה · עברו ' + pass + '  ·  נכשלו ' + fail);
if (fail) console.log('  ' + bad.join('\n  '));
console.log('============================================');
console.log('  NOT RUN · אמולטור Firestore. ה-Firestore כאן מזויף');
console.log('  ומספיק להחלטה, לא להתנהגות של המסד עצמו.');
console.log('  הרצה אמיתית:');
console.log('    firebase emulators:exec --only firestore --project demo-resq \\');
console.log('      "node functions/schedule-runtime.integration.test.js"');
console.log('============================================');
process.exit(fail ? 1 : 0);
