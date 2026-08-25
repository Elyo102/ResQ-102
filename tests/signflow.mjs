// ============================================================
//  חוקיות החתימות
// ============================================================
//  חתימה היא הדבר היחיד במערכת שמייצג הסכמה של אדם. באג כאן
//  אינו "מסך שנראה לא טוב" — הוא מסמך שנחתם בידי מי שלא היה
//  אמור לחתום עליו, או שכר שמתעכב כי מישהו לא יכול לחתום.

import { fileURLToPath as __f } from 'url';
import { dirname as __d, join as __j } from 'path';
import { pathToFileURL } from 'url';

const __TESTS = __d(__f(import.meta.url));
const __APP   = __j(__TESTS, '..');

const S = await import(pathToFileURL(__j(__APP, 'signflow.js')).href);

let pass = 0, fail = 0;
const bad = [];

function is(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  \x1b[32m✓\x1b[0m ' : '  \x1b[31m✗\x1b[0m ') + name +
              (ok ? '' : '   \x1b[2mקיבלתי ' + JSON.stringify(got) +
                         ' · ציפיתי ' + JSON.stringify(want) + '\x1b[0m'));
  ok ? pass++ : (fail++, bad.push(name));
}
function head(t) { console.log('\n\x1b[1m--- ' + t + '\x1b[0m'); }

const FF   = { uid: 'u1', role: 'firefighter',       shift: 'א', emp: '101' };
const CMDA = { uid: 'u2', role: 'commander',         shift: 'א', emp: '201' };
const CMDB = { uid: 'u3', role: 'commander',         shift: 'ב', emp: '202' };
const DEP  = { uid: 'u4', role: 'deputy',            shift: 'א', emp: '203' };
const ST   = { uid: 'u5', role: 'station_commander', shift: '',  emp: '301' };
const HR   = { uid: 'u6', role: 'hr_coordinator',    shift: '',  emp: '401' };
const SUP  = { uid: 'u7', role: 'super', super: true, shift: '', emp: '1' };

const sig = (who) => ({ image: 'data:image/png;base64,AAA', uid: who, at: 'x' });

console.log('\n\x1b[1m═══ חוקיות החתימות ═══\x1b[0m');

head('1 · כמה חתימות דרושות');

is('דוח שעות — כבאי וראש משמרת',
   S.requiredSteps('monthly_report', {}), ['employee', 'commander']);
is('אי-החתמת כרטיס — כבאי וראש משמרת',
   S.requiredSteps('missed_punch', {}), ['employee', 'commander']);
is('מסירת אחריות — שני הצדדים',
   S.requiredSteps('handover', {}), ['employee', 'commander']);
is('חופשה בארץ — כבאי וראש משמרת',
   S.requiredSteps('vacation', { where: 'אילת' }), ['employee', 'commander']);

head('2 · חופשה בחו"ל — החריג היחיד');

is('חופשה בחו"ל — נוסף מפקד תחנה',
   S.requiredSteps('vacation', { where: 'חו"ל' }),
   ['employee', 'commander', 'station_commander']);
is('גם בכתיב חו״ל עם גרש עברי',
   S.requiredSteps('vacation', { where: 'טיול בחו״ל' }).length, 3);
is('גם כשהשדה הוא abroad:true',
   S.requiredSteps('vacation', { abroad: true }).length, 3);
is('גם כשהערך יושב בתוך values',
   S.requiredSteps('vacation', { values: { where: 'חופשה בחו"ל' } }).length, 3);
is('"חולון" אינו חו"ל',
   S.requiredSteps('vacation', { where: 'חולון' }), ['employee', 'commander']);
is('"רחוב החולה" אינו חו"ל',
   S.requiredSteps('vacation', { where: 'רחוב החולה 5' }), ['employee', 'commander']);

head('3 · מצב המסמך');

const empty  = {};
const step1  = { signatures: { employee: sig('u1') } };
const done   = { signatures: { employee: sig('u1'), commander: sig('u2') } };

is('מסמך ריק — ממתין לכבאי',      S.signState('monthly_report', empty).next, 'employee');
is('אחרי הכבאי — ממתין למפקד',    S.signState('monthly_report', step1).next, 'commander');
is('אחרי שניהם — סגור',           S.signState('monthly_report', done).complete, true);
is('חו"ל אחרי שניים — עוד פתוח',
   S.signState('vacation', Object.assign({ where: 'חו"ל' }, done)).next,
   'station_commander');

head('4 · מי רשאי לחתום');

is('כבאי חותם על שלו',
   S.canSign('monthly_report', { emp_number: '101' }, FF).allowed, true);
is('כבאי אחר לא חותם עליו',
   S.canSign('monthly_report', { emp_number: '999' }, FF).allowed, false);
is('ראש משמרת א מאשר אחרי הכבאי',
   S.canSign('monthly_report', Object.assign({ crew: 'א' }, step1), CMDA).allowed, true);
is('🔒 ראש משמרת ב לא מאשר במשמרת א',
   S.canSign('monthly_report', Object.assign({ crew: 'א' }, step1), CMDB).allowed, false);
is('סגן — סמכות זהה לראש המשמרת',
   S.canSign('monthly_report', Object.assign({ crew: 'א' }, step1), DEP).allowed, true);
is('מפקד תחנה אינו נעול למשמרת',
   S.canSign('monthly_report', Object.assign({ crew: 'ב' }, step1), ST).allowed, true);
is('רכזת כוח אדם אינה נעולה',
   S.canSign('monthly_report', Object.assign({ crew: 'ב' }, step1), HR).allowed, true);

head('5 · חתימה במקום כבאי שלא חתם');

const onb = S.canSign('monthly_report', { crew: 'א', emp_number: '101' }, CMDA);
is('ראש משמרת רשאי לחתום במקומו', onb.allowed, true);
is('והחתימה מסומנת כחתימה בשם',   onb.onBehalf,  true);
is('ויש אזהרה למסך',              !!onb.warn,    true);
is('🔒 כבאי אחר לא חותם בשם חבר',
   S.canSign('monthly_report', { crew: 'א', emp_number: '999' },
             { uid: 'x', role: 'firefighter', shift: 'א', emp: '888' }).allowed, false);

const rec = S.signatureRecord ? null : null;

head('6 · מפקד אינו מאשר לעצמו');

is('🔒 מפקד שהגיש בקשה לא מאשר אותה',
   S.canSign('vacation',
     Object.assign({ crew: 'א', by_uid: 'u2', emp_number: '201', where: 'אילת' }, step1),
     CMDA).allowed, false);
is('מנהל-על כן — הוא מי שמתקן כשנתקע',
   S.canSign('vacation',
     Object.assign({ crew: 'א', by_uid: 'u7', where: 'אילת' }, step1),
     SUP).allowed, true);
is('🔒 ראש משמרת לא מאשר חו"ל בשלב מפקד התחנה',
   S.canSign('vacation',
     Object.assign({ crew: 'א', where: 'חו"ל' },
       { signatures: { employee: sig('u1'), commander: sig('u2') } }),
     CMDA).allowed, false);
is('מפקד התחנה כן',
   S.canSign('vacation',
     Object.assign({ crew: 'א', where: 'חו"ל' },
       { signatures: { employee: sig('u1'), commander: sig('u2') } }),
     ST).allowed, true);

head('7 · נעילה אחרי חתימה');

is('מסמך בלי חתימות — פתוח לעריכה', S.isLocked(empty), false);
is('🔒 אחרי חתימה אחת — נעול',      S.isLocked(step1), true);
is('🔒 אחרי הכל — נעול',            S.isLocked(done),  true);

head('8 · רשומת החתימה');

const r1 = S.signatureRecord('data:x', { uid: 'u2', full_name: 'רז בכור',
                                         emp_number: '201', role: 'commander' });
is('נשמר מי חתם',   r1.name, 'רז בכור');
is('נשמר מספר עובד', r1.emp, '201');
is('נשמרת שעה',      !!r1.at, true);
is('בלי חתימה בשם — אין שדה', r1.on_behalf_of, undefined);

const r2 = S.signatureRecord('data:x',
  { uid: 'u2', full_name: 'רז בכור', emp_number: '201', role: 'commander' },
  { on_behalf_of: 'u1', on_behalf_name: 'אלדד יונה', reason: 'לא חתם עד סוף החודש' });
is('חתימה בשם — נרשם מי החותם האמיתי', r2.name, 'רז בכור');
is('ונרשם בשם מי',                      r2.on_behalf_name, 'אלדד יונה');
is('ונרשמת הסיבה',                      r2.reason, 'לא חתם עד סוף החודש');

// ============================================================
head('9 · טופס שהוגש — המבנה שבפועל במסד');
// ============================================================
//  מה שנבדק כאן אינו הלוגיקה אלא **התאמת שמות השדות**.
//  אותו נתון נקרא crew במסמך ו-shift בטוקן, ובעל המסמך
//  מזוהה פעם לפי by_uid ופעם לפי emp_number. אי-התאמה כזאת
//  לא נראית בקוד — היא נראית כשמפקד לוחץ "אשר" ומקבל
//  "אינך רשאי", בלי שאיש יבין למה.

const empSig = S.signatureRecord('data:img', {
  uid: 'u1', full_name: 'כבאי א', emp_number: '101', role: 'firefighter' });

// טופס חופשה בארץ, כפי ש-forms.html כותב אותו.
const subHome = {
  form_id: 'leave', kind: 'vacation',
  values: { from: '2026-09-10', to: '2026-09-12', where: 'בארץ' },
  signatures: { employee: empSig },
  status: 'submitted', by_uid: 'u1', by_emp: '101', crew: 'א'
};
const subAbroad = Object.assign({}, subHome, {
  values: { from: '2026-09-10', to: '2026-09-20', where: 'בחו״ל' } });

is('חופשה בארץ — שני שלבים',
   S.requiredSteps('vacation', subHome).length, 2);
is('חופשה בחו״ל — שלושה שלבים',
   S.requiredSteps('vacation', subAbroad).length, 3);
is('זיהוי חו״ל מתוך values.where', S.isAbroad(subAbroad), true);
is('בארץ אינו חו״ל',               S.isAbroad(subHome),   false);

is('בעלות לפי by_uid',  S.isOwnerOf(subHome, FF), true);
is('בעלות לפי by_emp',  S.isOwnerOf(subHome, { uid: 'other', emp: '101' }), true);
is('מפקד אינו הבעלים',  S.isOwnerOf(subHome, CMDA), false);
is('מספר עובד כמספר ולא כמחרוזת עדיין תופס',
   S.isOwnerOf({ emp_number: 417 }, { uid: 'x', emp: '417' }), true);

is('ראש המשמרת רשאי לחתום על טופס במשמרתו',
   S.canSign('vacation', subHome, CMDA).allowed, true);
is('והשלב שלו הוא commander',
   S.canSign('vacation', subHome, CMDA).step, 'commander');

is('🔒 ראש משמרת ממשמרת אחרת אינו רשאי',
   S.canSign('vacation', subHome, CMDB).allowed, false);

// חופשת חו"ל אחרי חתימת ראש המשמרת.
const cmdSig = S.signatureRecord('data:img', {
  uid: 'u2', full_name: 'מפקד א', emp_number: '201', role: 'commander' });
const subAtStation = Object.assign({}, subAbroad, {
  signatures: { employee: empSig, commander: cmdSig },
  status: 'pending_station' });

is('אחרי ראש המשמרת — הבא בתור הוא מפקד התחנה',
   S.signState('vacation', subAtStation).next, 'station_commander');
is('🔒 ראש המשמרת אינו יכול לחתום שוב',
   S.canSign('vacation', subAtStation, CMDA).allowed, false);
is('מפקד התחנה כן',
   S.canSign('vacation', subAtStation, ST).allowed, true);
is('ואז המסמך סגור',
   S.signState('vacation', Object.assign({}, subAtStation, {
     signatures: { employee: empSig, commander: cmdSig,
                   station_commander: cmdSig } })).complete, true);

// המקרה שהמסך מסתמך עליו: בקשה שראש המשמרת עצמו הגיש.
const subByCmd = Object.assign({}, subHome, { by_uid: 'u2', by_emp: '201' });
is('🔒 ראש משמרת אינו מאשר בקשה שהגיש בעצמו',
   S.canSign('vacation', subByCmd, CMDA).allowed, false);
is('היא עוברת למפקד התחנה',
   S.canSign('vacation', subByCmd, ST).allowed, true);

console.log('\n\x1b[1m════════════════════════════════════\x1b[0m');
if (fail === 0) {
  console.log('\x1b[32m\x1b[1m  ✓ כל ' + pass + ' הבדיקות עברו\x1b[0m');
} else {
  console.log('\x1b[31m\x1b[1m  ✗ ' + fail + ' נכשלו · ' + pass + ' עברו\x1b[0m');
  bad.forEach(b => console.log('    ' + b));
}
console.log('\x1b[1m════════════════════════════════════\x1b[0m\n');
process.exit(fail === 0 ? 0 : 1);
