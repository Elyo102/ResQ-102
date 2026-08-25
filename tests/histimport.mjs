// ============================================================
//  ייבוא היסטוריית שעות
// ============================================================
//  שעות הן שכר. ייבוא ששוגה בשקט אינו באג במסך — הוא
//  היסטוריה שגויה שאיש לא יבדוק שוב, כי היא "כבר נקלטה".
//  לכן כל שורה פגומה חייבת להיעצר ולהופיע ברשימה, ולא
//  להיכנס עם ערך ברירת מחדל.

import { fileURLToPath as __f } from 'url';
import { dirname as __d, join as __j } from 'path';
import { pathToFileURL } from 'url';

const __TESTS = __d(__f(import.meta.url));
const __APP   = __j(__TESTS, '..');

const H = await import(pathToFileURL(__j(__APP, 'histimport.js')).href);

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

const ROSTER = [
  { uid: 'u1', emp: '101', name: 'אלדד יונה',   crew: 'A' },
  { uid: 'u2', emp: '201', name: 'רחמים חנן',   crew: 'A' },
  { uid: 'u3', emp: '301', name: 'מורגאן מרעי', crew: 'B' },
  { uid: 'u4', emp: '1481', name: 'אכרם חמזה',  crew: 'C' }
];

const HEAD = 'שם,מספר עובד,משמרת,תאריך,סוג יום,כניסה,יציאה,כניסה 2,יציאה 2,שעות,מקום,הערה';

// ============================================================
head('1 · קריאת CSV');
// ============================================================

is('שורה פשוטה', H.parseCsv('a,b,c'), [['a','b','c']]);
is('שתי שורות',  H.parseCsv('a,b\nc,d'), [['a','b'],['c','d']]);
is('CRLF אינו מזהם את הערך האחרון',
   H.parseCsv('a,b\r\nc,d'), [['a','b'],['c','d']]);
is('BOM בתחילת הקובץ נחתך',
   H.parseCsv('﻿שם,ב')[0][0], 'שם');
is('פסיק בתוך מרכאות אינו מפריד',
   H.parseCsv('a,"ב,ג",d'), [['a','ב,ג','d']]);
is('מרכאה כפולה בתוך ערך',
   H.parseCsv('a,"אמר ""שלום""",c'), [['a','אמר "שלום"','c']]);
is('שורה ריקה בסוף הקובץ נזרקת',
   H.parseCsv('a,b\n\n').length, 1);
is('ירידת שורה בתוך מרכאות אינה מסיימת שורה',
   H.parseCsv('a,"שורה\nשנייה"').length, 1);

// ============================================================
head('2 · חוזה העמודות');
// ============================================================

const hm = H.headerMap(HEAD.split(','));
is('בלי עמודות חסרות', hm.missing, []);
is('שם באינדקס 0',     hm.idx.name, 0);
is('הערה באינדקס 11',  hm.idx.notes, 11);

// סדר שונה — העמודות מזוהות לפי השם ולא לפי המקום.
const shuffled = H.headerMap('תאריך,שם,סוג יום,מספר עובד'.split(','));
is('עמודה שהוזזה עדיין נמצאת', shuffled.idx.date, 0);
is('ושם באינדקס 1',            shuffled.idx.name, 1);
is('עמודה חובה שחסרה נתפסת בשמה',
   H.headerMap('שם,מספר עובד,תאריך'.split(',')).missing, ['סוג יום']);

// ============================================================
head('3 · תרגום סוג היום');
// ============================================================
//
// כאן נמצאת הנקודה שבה ייבוא נאיבי משקר בשקט: Shift-eilat
// מערבב מה זה, מה הצורה ואיפה — ב-ResQ אלה שלושה שדות.

is('משמרת רגילה',  H.mapDayType('משמרת'),
   { day_type: 'regular', shape: 'regular' });
is('חופש',         H.mapDayType('חופש').day_type,  'vacation');
is('מחלה',         H.mapDayType('מחלה').day_type,  'sick');
is('מילואים',      H.mapDayType('מילואים').day_type, 'reserve');
is('המשך משמרת הוא צורה, לא סוג',
   H.mapDayType('המשך משמרת'),
   { day_type: 'regular', shape: 'continued' });
is('משמרת מפוצלת היא צורה, לא סוג',
   H.mapDayType('משמרת מפוצלת').shape, 'split');
is('יטבתה היא מקום, לא סוג',
   H.mapDayType('יטבתה'),
   { day_type: 'regular', shape: 'regular', site: 'yotvata' });
is('🔒 סוג לא מוכר אינו הופך ל"רגיל" בשקט',
   H.mapDayType('משהו אחר'), null);
is('רווחים בקצוות נסבלים', H.mapDayType('  חופש  ').day_type, 'vacation');

// ============================================================
head('4 · התאמת אדם');
// ============================================================
//
// מספר עובד קודם לשם תמיד. "רמי" מול "רחמים חנן" הוא בדיוק
// הכינוי שגרם ל-266 שעות להיספר כאפס במערכת הקודמת.

is('לפי מספר עובד',
   H.matchPerson({ emp: '201', name: 'שם אחר לגמרי' }, ROSTER).person.uid, 'u2');
is('והדרך נרשמת',
   H.matchPerson({ emp: '201', name: 'שם אחר' }, ROSTER).how, 'emp');
is('לפי שם, כשאין מספר',
   H.matchPerson({ emp: '', name: 'אלדד יונה' }, ROSTER).person.uid, 'u1');
is('כינוי "רמי" מוצא את רחמים חנן',
   H.matchPerson({ emp: '', name: 'רמי' }, ROSTER).person.uid, 'u2');
is('והדרך נרשמת ככינוי',
   H.matchPerson({ emp: '', name: 'רמי' }, ROSTER).how, 'alias');
is('כינוי "מורגן"',
   H.matchPerson({ emp: '', name: 'מורגן' }, ROSTER).person.uid, 'u3');
is('גרשיים בשם אינם מפריעים',
   H.matchPerson({ emp: '', name: 'אלדד  יונה' }, ROSTER).person.uid, 'u1');
is('🔒 מי שאינו במערכת אינו מותאם',
   H.matchPerson({ emp: '999', name: 'מישהו' }, ROSTER).person, null);
is('🔒 מספר עובד שגוי אינו נופל חזרה לשם באופן שקרי',
   H.matchPerson({ emp: '999', name: 'אלדד יונה' }, ROSTER).how, 'name');

// ============================================================
head('5 · בניית הרשומה');
// ============================================================

const P = ROSTER[0];

const r1 = H.toAttendance({ date: '2026-03-04', type: 'משמרת',
  start: '7:00', end: '07:00', hours: '24' }, P);
is('רשומה תקינה נבנית', !!r1.rec, true);
is('שעה חד-ספרתית מתוקנת', r1.rec.start, '07:00');
is('מפתח הרשומה = עובד_תאריך', r1.id, '101_2026-03-04');
is('חודש נגזר מהתאריך', r1.rec.month, '2026-03');
is('🔒 הסטטוס הוא imported ולא approved', r1.rec.status, 'imported');
is('המקור נרשם', r1.rec.imported_from, 'shift-eilat');

// השעות נלקחות מהקובץ ולא מחושבות מחדש — אחרת ההיסטוריה
// שנקלטת סותרת דוחות שכבר נשלחו למשאבי אנוש.
const r2 = H.toAttendance({ date: '2026-03-05', type: 'יטבתה',
  start: '07:00', end: '08:00', hours: '25' }, P);
is('יטבתה נכנסת כמקום', r2.rec.sub_station, 'yotvata');
is('ו-25 השעות נשמרות כמו שהן', r2.rec.hours, 25);

const r3 = H.toAttendance({ date: '2026-03-06', type: 'משמרת מפוצלת',
  start: '07:00', end: '12:00', start2: '18:00', end2: '22:00',
  hours: '9' }, P);
is('מפוצלת שומרת קטע שני', [r3.rec.start2, r3.rec.end2], ['18:00','22:00']);
is('והצורה נרשמת', r3.rec.shape, 'split');

is('🔒 מפוצלת בלי קטע שני נעצרת',
   !!H.toAttendance({ date: '2026-03-07', type: 'משמרת מפוצלת',
     start: '07:00', end: '12:00', hours: '5' }, P).error, true);

const r4 = H.toAttendance({ date: '2026-03-08', type: 'המשך משמרת',
  start: '07:00', end: '10:00', hours: '27' }, P);
is('המשך משמרת מסומן כחוצה יום', r4.rec.end_day, 1);

is('🔒 תאריך לא תקין נעצר',
   !!H.toAttendance({ date: '4.3.2026', type: 'משמרת', hours: '24' }, P).error, true);
is('🔒 סוג לא מוכר נעצר',
   !!H.toAttendance({ date: '2026-03-04', type: 'זבל', hours: '24' }, P).error, true);
is('🔒 שעות לא סבירות נעצרות',
   !!H.toAttendance({ date: '2026-03-04', type: 'משמרת', hours: '99' }, P).error, true);
is('שעות ריקות נכנסות כאפס ולא כשגיאה',
   H.toAttendance({ date: '2026-03-04', type: 'חופש', hours: '' }, P).rec.hours, 0);
is('שעה שאינה שעה מנוקה לריק',
   H.toAttendance({ date: '2026-03-04', type: 'משמרת', start: 'בוקר',
     hours: '24' }, P).rec.start, '');

// ============================================================
head('6 · הרצה יבשה על קובץ שלם');
// ============================================================

const CSV = [
  HEAD,
  'אלדד יונה,101,A,2026-03-01,משמרת,07:00,07:00,,,24,,',
  'רמי,,A,2026-03-01,משמרת,06:45,07:00,,,24.25,,ראש משמרת',
  'מורגן,,B,2026-03-02,חופש,,,,,0,,',
  'אכרם חמזה,1481,C,2026-03-02,יטבתה,07:00,08:00,,,25,,',
  'מישהו לא מוכר,999,A,2026-03-03,משמרת,07:00,07:00,,,24,,',
  'אלדד יונה,101,A,2026-03-04,זבל,07:00,07:00,,,24,,',
  'אלדד יונה,101,2026-03-01,,,,,,,,,'.replace('2026-03-01','A') // תאריך חסר
].join('\n');

const dry = H.dryRun(CSV, ROSTER);
is('בלי כשל קטלני',        dry.fatal, '');
is('ארבע שורות מוכנות',    dry.ready.length, 4);
is('שלוש שורות נדחו',      dry.errors.length, 3);
is('הסכום מדויק',          dry.totalHours, 73.25);
is('חודש אחד',             Object.keys(dry.months), ['2026-03']);
is('כינוי הותאם — לרמי יש שורה',
   !!dry.perPerson['רחמים חנן'], true);
is('ומספר העובד שלו נכנס נכון',
   dry.ready.filter(o => o.rec.full_name === 'רחמים חנן')[0].rec.emp_number, '201');
is('מי שלא נמצא מדווח בשמו',
   Object.keys(dry.unknownPeople).length, 1);
is('מספר השורה מופיע בשגיאה', dry.errors[0].line > 1, true);

// כפילות: אותו אדם ואותו יום פעמיים. קורה כשמדביקים שני
// ייצואים של אותו חודש.
const dup = H.dryRun([HEAD,
  'אלדד יונה,101,A,2026-03-01,משמרת,07:00,07:00,,,24,,',
  'אלדד יונה,101,A,2026-03-01,משמרת,07:00,07:00,,,24,,'].join('\n'), ROSTER);
is('כפילות נספרת ולא נכתבת פעמיים', dup.dupes, 1);
is('ונשארת שורה אחת',               dup.ready.length, 1);

is('🔒 קובץ בלי עמודות חובה נעצר לגמרי',
   H.dryRun('שם,תאריך\nא,2026-01-01', ROSTER).fatal.indexOf('חסרות עמודות') !== -1, true);
is('🔒 קובץ ריק נעצר',
   H.dryRun('', ROSTER).fatal !== '', true);
is('🔒 כותרת בלבד נעצרת',
   H.dryRun(HEAD, ROSTER).fatal !== '', true);

console.log('\n\x1b[1m════════════════════════════════════\x1b[0m');
if (fail === 0) {
  console.log('\x1b[32m\x1b[1m  ✓ כל ' + pass + ' הבדיקות עברו\x1b[0m');
} else {
  console.log('\x1b[31m\x1b[1m  ✗ ' + fail + ' נכשלו · ' + pass + ' עברו\x1b[0m');
  bad.forEach(b => console.log('    ' + b));
}
console.log('\x1b[1m════════════════════════════════════\x1b[0m\n');
process.exit(fail === 0 ? 0 : 1);
