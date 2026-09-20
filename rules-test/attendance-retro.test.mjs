// דיווח נוכחות רטרואקטיבי — אכיפת „מתי דווח" מול אמולטור אמיתי (demo-resq).
//
// NOT RUN בסביבה הזו: אין אמולטור Firestore במיכל. להרצה:
//   firebase emulators:exec --only firestore --project demo-resq \
//     "cd rules-test && node attendance-retro.test.mjs"
//
// מה הקובץ הזה מוכיח, ולמה הוא נחוץ דווקא כאן:
//
// דיווח נוכחות עצמי נכתב **ישירות מהדפדפן** ל-Firestore — אין callable
// באמצע. לכן כל שדה שהלקוח שולח הוא טענה של הלקוח, ו„מתי דווח" יכול
// להיות אמין רק אם הכללים עצמם כופים אותו. הגזירה של „רטרואקטיבי"
// נבדקת ב-tests/retro-report.mjs; כאן נבדקת האכיפה.
//
// חמש הטענות:
//   1. יצירה בלי `reported_at` — נדחית.
//   2. יצירה עם חותמת שהלקוח בחר (עבר או עתיד) — נדחית.
//   3. יצירה עם `serverTimestamp()` — מתקבלת, וזו הדרך היחידה.
//   4. עריכה שמנסה לשנות את `reported_at` — נדחית.
//   5. עריכה שמשאירה אותו כמו שהוא — מתקבלת, כולל על יום שכבר עבר.
//
// Real client SDK + actual rules. Fixtures are tracked and deleted exactly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDocFromServer, setDoc, updateDoc, serverTimestamp, Timestamp, waitForPendingWrites }
  from 'firebase/firestore';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
assert.match(endpoint, /^(127\.0\.0\.1|localhost):\d+$/, 'loopback emulator only');
assert.ok(!process.env.GCLOUD_PROJECT || process.env.GCLOUD_PROJECT === 'demo-resq', 'demo project only');
const [host, portText] = endpoint.split(':'), port = Number(portText);
const rules = readFileSync(fileURLToPath(new URL('../firestore.rules', import.meta.url)), 'utf8');
assert.ok(/request\.resource\.data\.reported_at == request\.time/.test(rules),
  'firestore.rules must pin reported_at to the request time');

const run = randomBytes(6).toString('hex');
const sid = 'it_retro_' + run;
const uid = run + '_worker';
const emp = '9501';
const claims = { role: 'firefighter', emp, stationId: sid, shift: 'A', districtId: 'synthetic',
  crew: 'A', email: uid + '@example.invalid', email_verified: true };

/* יום שכבר עבר — זה כל העניין. דיווח עליו מותר, והוא מסומן רטרואקטיבי
 * על סמך ההפרש בין התאריך הזה לבין הזמן שהשרת חתם עליו. */
const pastDay = '2026-09-01';
const recordId = emp + '_' + pastDay;
const target = 'stations/' + sid + '/attendance/' + recordId;

const body = () => ({
  emp_number: emp, date: pastDay, status: 'draft', crew: 'A',
  day_type: 'regular', day_type_he: 'רגיל', site_name: '', reason_required: false,
  hours: 24, updated_at: serverTimestamp()
});

const env = await initializeTestEnvironment({ projectId: 'demo-resq', firestore: { host, port, rules } });
let passed = 0;
let activeDb = null;
async function allowed(label, operation) {
  await operation();
  await waitForPendingWrites(activeDb);
  ++passed; console.log('✓ ' + label);
}
async function refused(label, operation) {
  await assert.rejects(operation, (error) => error?.code === 'permission-denied',
    label + ' must fail specifically with permission-denied');
  ++passed; console.log('✓ ' + label);
}

try {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'stations/' + sid), { name: 'Synthetic station', districtId: 'synthetic', active: true });
    await setDoc(doc(db, 'stations/' + sid + '/users/' + uid), {
      uid, role: 'firefighter', stationId: sid, employee_number: emp, crew: 'A',
      active: true, is_active: true, full_name: 'Synthetic fixture'
    });
  });

  const db = env.authenticatedContext(uid, claims).firestore();
  activeDb = db;

  await refused('a self report with no reported_at is refused',
    () => setDoc(doc(db, target), body()));

  await refused('a reported_at the client chose in the past is refused',
    () => setDoc(doc(db, target), { ...body(), reported_at: Timestamp.fromMillis(Date.parse(pastDay + 'T08:00:00+03:00')) }));

  await refused('and one in the future is refused just the same',
    () => setDoc(doc(db, target), { ...body(), reported_at: Timestamp.fromMillis(Date.now() + 86400000) }));

  /* ⭐ זו הדרך היחידה שעוברת, וזו הנקודה: „מתי דווח" הוא זמן הבקשה
   * ולא דבר שהמדווח מחליט עליו. */
  await allowed('a self report whose reported_at is the request time is accepted, on a day that already passed',
    () => setDoc(doc(db, target), { ...body(), reported_at: serverTimestamp() }));

  const stored = (await getDocFromServer(doc(db, target))).data();
  assert.ok(stored.reported_at, 'the stamp was stored');
  assert.ok(stored.reported_at.toMillis() > Date.parse(pastDay + 'T23:59:59+03:00'),
    'and it is later than the day being reported — which is what makes it retroactive');
  ++passed; console.log('✓ the stored stamp is later than the reported day');

  await refused('an edit may not move when it was first reported',
    () => updateDoc(doc(db, target), { hours: 12, reported_at: serverTimestamp() }));

  await refused('nor may it erase it',
    () => setDoc(doc(db, target), body()));

  await allowed('an ordinary edit that leaves the stamp alone is accepted',
    () => setDoc(doc(db, target), { ...body(), reported_at: stored.reported_at, hours: 12 }));

} finally {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (const path of [target, 'stations/' + sid + '/users/' + uid, 'stations/' + sid]) {
      await deleteDoc(doc(db, path)).catch(() => {});
    }
  });
  await env.cleanup();
}

console.log('\n' + passed + ' attendance retroactive rule checks passed.');
