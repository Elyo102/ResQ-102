/**
 * מצב הצי · גבול הדפדפן לעריכת רכבים.
 *
 * הכרעת אלדד (6.9): מפקד משמרת, סגן מפקד משמרת, מפקד תחנה ומנהל-על
 * עורכים את הצי. רכזת כוח אדם היא `staff` לכל דבר אחר — סידור, שעות,
 * כוח אדם — ולכן היא **הבדיקה החשובה כאן**: היא כן כותבת את מסמך
 * הלוח (שרשרת פיקוד), ואינה נוגעת ברכבים.
 *
 * שלוש הטענות שנבדקות מול האמולטור ולא מול המסך:
 *   1. רק fleetManager כותב את אוסף `vehicles`; מחיקה חסומה לכולם,
 *      כי הורדה מהצי היא `active:false` ולא מחיקה.
 *   2. כתיבה למסמך `config/board` ש**משנה** את מערך הרכבים דורשת
 *      fleetManager; כתיבה שמשנה רק את שרשרת הפיקוד נשארת ל-staff.
 *   3. כבאי אינו כותב כלום, וקורא הכל — הצי הוא מידע מבצעי.
 *
 * מזהי תחנה וכתובות מומצאים בלבד. הרצה מול האמולטור:
 *   firebase emulators:exec --only firestore --project demo-resq "cd rules-test && npm test"
 */

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

const SID = 'it_fleet';
let passed = 0;

async function blocked(label, action) {
  try {
    await assertFails(action);
    passed += 1;
    console.log('✓ ' + label);
  } catch (error) {
    throw new Error('Browser boundary opened: ' + label + '\n' + (error && error.message || error));
  }
}
async function allowed(label, action) {
  try {
    await assertSucceeds(action);
    passed += 1;
    console.log('✓ ' + label);
  } catch (error) {
    throw new Error('Expected operation to succeed: ' + label + '\n' + (error && error.message || error));
  }
}

const env = await initializeTestEnvironment({
  projectId: 'resq-fleet-rules',
  firestore: {
    rules: readFileSync('../firestore.rules', 'utf8'),
    host: '127.0.0.1',
    port: 8080
  }
});
await env.clearFirestore();

const client = (uid, email, claims) =>
  env.authenticatedContext(uid, Object.assign({ email }, claims)).firestore();

const base = { stationId: SID, districtId: 'south', shift: 'A' };
const firefighter = client('ff', 'ff@example.test', Object.assign({ emp: '3001', role: 'firefighter' }, base));
const deputy = client('dep', 'dep@example.test', Object.assign({ emp: '3002', role: 'deputy' }, base));
const commander = client('cmd', 'cmd@example.test', Object.assign({ emp: '3003', role: 'commander' }, base));
const stationCommander = client('stcmd', 'stcmd@example.test', Object.assign({ emp: '3004', role: 'station_commander', shift: '' }, base));
const hr = client('hr', 'hr@example.test', Object.assign({ emp: '3005', role: 'hr_coordinator', shift: '' }, base));
const superUser = client('sup', 'sup@example.test', { super: true });
const outsider = client('out', 'out@example.test', { emp: '3006', role: 'commander', stationId: 'it_other', districtId: 'north', shift: 'B' });

/* מצב הלוח כפי שהוא נשמר: רכבים + שרשרת פיקוד באותו מסמך. */
const VEHICLES = [
  { id: 'v1', name: 'רכב א', role: 'כיבוי', slots: [{ id: 's11', job: 'נהג', req: '' }] },
  { id: 'v2', name: 'רכב ב', role: 'חילוץ', slots: [{ id: 's21', job: 'כבאי', req: '' }] }
];
const COMMAND = [{ id: 'c1', rank: 'מפקד משמרת', req: '' }];
const boardDoc = (vehicles, command) => ({
  vehicles: vehicles, command: command, updated_at: new Date().toISOString(), by: 'seed'
});

try {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, `stations/${SID}`), {
      name: 'Fleet', districtId: 'south', status: 'active', active: true, lifecycle: { revision: 1 }
    });
    for (const [uid, role] of [['ff', 'firefighter'], ['dep', 'deputy'], ['cmd', 'commander'],
                               ['stcmd', 'station_commander'], ['hr', 'hr_coordinator']]) {
      await setDoc(doc(db, `stations/${SID}/users/${uid}`), {
        full_name: 'Test ' + uid, employee_number: '1', role, crew: 'A', is_active: true
      });
    }
    await setDoc(doc(db, `stations/${SID}/config/board`), boardDoc(VEHICLES, COMMAND));
    await setDoc(doc(db, `stations/${SID}/vehicles/an1`), {
      name: 'טרנזיט', plate: '12-345-67', kind: 'anchor', active: true
    });
  });

  /* ---------- 1. אוסף רכבי הצי ---------- */

  await allowed('כבאי קורא את הצי — מידע מבצעי לכל חבר תחנה',
    getDoc(doc(firefighter, `stations/${SID}/vehicles/an1`)));
  await blocked('חבר תחנה אחרת אינו קורא את הצי',
    getDoc(doc(outsider, `stations/${SID}/vehicles/an1`)));

  await blocked('כבאי אינו מוסיף רכב',
    setDoc(doc(firefighter, `stations/${SID}/vehicles/new1`), { name: 'רכב', plate: '', kind: 'anchor' }));
  await blocked('כבאי אינו משנה שם רכב',
    updateDoc(doc(firefighter, `stations/${SID}/vehicles/an1`), { name: 'שם אחר' }));
  await blocked('כבאי אינו מוריד רכב מהצי',
    updateDoc(doc(firefighter, `stations/${SID}/vehicles/an1`), { active: false }));

  await blocked('רכזת כוח אדם אינה מוסיפה רכב — היא staff, אך לא fleetManager',
    setDoc(doc(hr, `stations/${SID}/vehicles/new2`), { name: 'רכב', plate: '', kind: 'anchor' }));
  await blocked('רכזת כוח אדם אינה משנה שם רכב',
    updateDoc(doc(hr, `stations/${SID}/vehicles/an1`), { name: 'שם אחר' }));
  await blocked('רכזת כוח אדם אינה מורידה רכב מהצי',
    updateDoc(doc(hr, `stations/${SID}/vehicles/an1`), { active: false }));

  await blocked('מפקד משמרת של תחנה אחרת אינו נוגע בצי הזה',
    updateDoc(doc(outsider, `stations/${SID}/vehicles/an1`), { name: 'שם אחר' }));

  await allowed('סגן מפקד משמרת מוסיף רכב',
    setDoc(doc(deputy, `stations/${SID}/vehicles/new_dep`), { name: 'רכב סגן', plate: '11-111-11', kind: 'anchor', active: true }));
  await allowed('מפקד משמרת משנה שם ומספר רישוי',
    updateDoc(doc(commander, `stations/${SID}/vehicles/an1`), { name: 'טרנזיט לבן', plate: '98-765-43' }));
  await allowed('מפקד תחנה מוריד רכב מהצי',
    updateDoc(doc(stationCommander, `stations/${SID}/vehicles/an1`), { active: false }));
  await allowed('מנהל-על מחזיר רכב לצי',
    updateDoc(doc(superUser, `stations/${SID}/vehicles/an1`), { active: true }));

  /* מחיקה חסומה לכולם: היסטוריית התקלות נכתבה על שם הרכב. */
  for (const [name, actor] of [['כבאי', firefighter], ['רכזת כוח אדם', hr], ['סגן', deputy],
                               ['מפקד משמרת', commander], ['מפקד תחנה', stationCommander], ['מנהל-על', superUser]]) {
    await blocked(name + ' אינו מוחק רכב — הורדה מהצי היא active:false',
      deleteDoc(doc(actor, `stations/${SID}/vehicles/an1`)));
  }

  /* ---------- 2. מסמך הלוח: רכבים מול שרשרת פיקוד ---------- */

  const renamed = [Object.assign({}, VEHICLES[0], { name: 'שם חדש' }), VEHICLES[1]];
  const deactivated = [Object.assign({}, VEHICLES[0], { active: false }), VEHICLES[1]];
  const added = VEHICLES.concat([{ id: 'v3', name: 'רכב ג', role: '', slots: [] }]);
  const otherCommand = [{ id: 'c1', rank: 'מפקד משמרת', req: '' }, { id: 'c2', rank: 'סגן', req: '' }];

  await blocked('רכזת כוח אדם אינה משנה שם של רכב מבצעי במסמך הלוח',
    setDoc(doc(hr, `stations/${SID}/config/board`), boardDoc(renamed, COMMAND)));
  await blocked('רכזת כוח אדם אינה מורידה רכב מבצעי מהצי',
    setDoc(doc(hr, `stations/${SID}/config/board`), boardDoc(deactivated, COMMAND)));
  await blocked('רכזת כוח אדם אינה מוסיפה רכב מבצעי',
    setDoc(doc(hr, `stations/${SID}/config/board`), boardDoc(added, COMMAND)));
  await blocked('כבאי אינו כותב את מסמך הלוח בכלל',
    setDoc(doc(firefighter, `stations/${SID}/config/board`), boardDoc(VEHICLES, otherCommand)));

  // הגבול המדויק: אותה רכזת, אותו מסמך, מערך רכבים ללא שינוי — עוברת.
  await allowed('רכזת כוח אדם כן עורכת את שרשרת הפיקוד, כשמערך הרכבים אינו משתנה',
    setDoc(doc(hr, `stations/${SID}/config/board`), boardDoc(VEHICLES, otherCommand)));

  await allowed('מפקד משמרת משנה שם של רכב מבצעי',
    setDoc(doc(commander, `stations/${SID}/config/board`), boardDoc(renamed, otherCommand)));
  await allowed('סגן מוריד רכב מבצעי מהצי',
    setDoc(doc(deputy, `stations/${SID}/config/board`), boardDoc(deactivated, otherCommand)));
  await allowed('מנהל-על מוסיף רכב מבצעי',
    setDoc(doc(superUser, `stations/${SID}/config/board`), boardDoc(added, otherCommand)));

  await blocked('מפקד משמרת של תחנה אחרת אינו כותב את הלוח הזה',
    setDoc(doc(outsider, `stations/${SID}/config/board`), boardDoc(added, COMMAND)));

  /* ---------- 3. גבולות הסכימה נשמרים ---------- */

  await blocked('מפקד משמרת אינו מבריח שדה נוסף למסמך הלוח',
    setDoc(doc(commander, `stations/${SID}/config/board`),
      Object.assign(boardDoc(VEHICLES, COMMAND), { secret: 'x' })));

  const tooMany = [];
  for (let i = 0; i < 41; i += 1) tooMany.push({ id: 'x' + i, name: 'רכב ' + i, slots: [] });
  await blocked('מפקד משמרת אינו עובר את תקרת 40 הרכבים',
    setDoc(doc(commander, `stations/${SID}/config/board`), boardDoc(tooMany, COMMAND)));

  for (const [name, actor] of [['HR', hr], ['commander', commander], ['super', superUser]]) {
    await blocked(name + ' cannot delete the canonical board',
      deleteDoc(doc(actor, `stations/${SID}/config/board`)));
  }
  const roleOnly = client('role-only', 'role@example.test', { role:'super_admin' });
  const emailOnly = client('ff', 'fleet-manager@example.invalid', Object.assign({ role:'firefighter', emp:'3001' }, base));
  await blocked('super_admin role alone is not signed super authority',
    setDoc(doc(roleOnly, `stations/${SID}/vehicles/role_only`), { name:'blocked' }));
  await blocked('email alone cannot elevate a firefighter to fleet manager',
    setDoc(doc(emailOnly, `stations/${SID}/vehicles/email_only`), { name:'blocked' }));
  await env.withSecurityRulesDisabled(async context => {
    await updateDoc(doc(context.firestore(), `stations/${SID}/users/cmd`), { is_active:false });
  });
  await blocked('stale commander claim cannot write after live membership deactivation',
    updateDoc(doc(commander, `stations/${SID}/vehicles/an1`), { name:'blocked' }));
  console.log('\n' + passed + ' fleet rules checks passed.');
} finally {
  await env.cleanup();
}
