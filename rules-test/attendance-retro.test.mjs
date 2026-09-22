// דיווח נוכחות רטרואקטיבי — אכיפת „מתי דווח" מול אמולטור אמיתי (demo-resq).
//
// NOT RUN בסביבה הזו: אין אמולטור Firestore במיכל. להרצה:
//   firebase emulators:exec --only firestore --project demo-resq \
//     "cd rules-test && node attendance-retro.test.mjs"
//
// מה הקובץ הזה מוכיח, ולמה הוא נחוץ דווקא כאן:
//
// דיווח נוכחות עצמי עובר כעת דרך callable שמפיק זהות, חישוב וחותמת
// שרת. לכן הכללים חייבים לדחות כל ניסיון כתיבה ישירה מהדפדפן.
//
// הטענות: יצירה עצמית, עדכון ומחיקה ישירים נדחים — גם כאשר הלקוח
// שולח serverTimestamp. Admin SDK של ה-callable אינו כפוף לכללים.
//
// Real client SDK + actual rules. Fixtures are tracked and deleted exactly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteDoc, doc, setDoc, updateDoc, serverTimestamp }
  from 'firebase/firestore';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
assert.match(endpoint, /^(127\.0\.0\.1|localhost):\d+$/, 'loopback emulator only');
assert.ok(!process.env.GCLOUD_PROJECT || process.env.GCLOUD_PROJECT === 'demo-resq', 'demo project only');
const [host, portText] = endpoint.split(':'), port = Number(portText);
const rules = readFileSync(fileURLToPath(new URL('../firestore.rules', import.meta.url)), 'utf8');
assert.ok(/match \/attendance\/\{docId\}[\s\S]{0,2600}?allow update, delete: if false;/.test(rules),
  'firestore.rules must close direct employee attendance writes');

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
  await refused('a self report with no reported_at is refused',
    () => setDoc(doc(db, target), body()));

  await refused('even serverTimestamp cannot authorize a direct browser create',
    () => setDoc(doc(db, target), { ...body(), reported_at: serverTimestamp() }));

  await env.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), target), { ...body(), reported_at: new Date() });
  });

  await refused('an edit may not move when it was first reported',
    () => updateDoc(doc(db, target), { hours: 12, reported_at: serverTimestamp() }));

  await refused('an ordinary edit is also refused',
    () => updateDoc(doc(db, target), { hours: 12 }));
  await refused('a direct employee delete is refused', () => deleteDoc(doc(db, target)));

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
