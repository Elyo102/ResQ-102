// בדיקת תקרת שיבוץ התפקידים, ובדיקת חיווט כלב השמירה.
//
// **מה נבדק כאן ולמה.**
//
// ב-25.8.2026 נפתחה setUserRole לרכז/ת כוח אדם. עד אז היא
// הייתה נעולה למנהל-על בלבד, ולכן לא היה מה לבדוק: או שאתה
// מנהל-על או שנדחית.
//
// עכשיו יש תקרה, ותקרה היא בדיוק סוג הכלל שנשחק בשקט. די
// שמישהו יוסיף תפקיד לרשימה בלי דרגה, או ישכח לעדכן את
// הטבלה בשרת אחרי שעדכן אותה בדפדפן, וההגנה תיפתח בלי
// שאף מסך ייראה שונה.
//
// הבדיקה השנייה שמורה במיוחד: **הטבלה מוכפלת בשני קבצים.**
// roles.js הוא מודול דפדפן ו-functions/index.js הוא CommonJS,
// והשרת אינו יכול לייבא את הראשון. לכן ROLE_RANK ו-
// ASSIGN_MAX_RANK כתובים פעמיים — וכאן נבדק שהם זהים.
// אם הם יוצאים מסנכרון, המסך יציג אפשרות שהשרת ידחה, או
// גרוע מזה: השרת יאשר משהו שהמסך לא התכוון להציע.
//
// הרצה:  node assign.mjs
import fs from 'fs';
import { fileURLToPath as __f, pathToFileURL as __u } from 'url';
import { dirname as __d, join as __j } from 'path';
const __TESTS = __d(__f(import.meta.url));
const __APP   = __j(__TESTS, '..');

const R = await import(__u(__j(__APP, 'roles.js')).href);
const srv = fs.readFileSync(__j(__APP, 'functions', 'index.js'), 'utf8');

let pass = 0, fail = 0;
function is(name, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  console.log('  ✗ ' + name + '  · קיבלתי ' + JSON.stringify(got) +
              ' · ציפיתי ' + JSON.stringify(want));
}
function ok(name, cond) { is(name, !!cond, true); }

const HR    = { role: 'hr_coordinator' };
const SUPER = { super: true };
const FF    = { role: 'firefighter' };
const CMD   = { role: 'commander' };

console.log('תקרת שיבוץ · רכז/ת כוח אדם');

// מה שמותר לה
is('לוחם אש',          R.mayAssignRole(HR, 'firefighter', ''),        true);
is('סגן מפקד צוות',    R.mayAssignRole(HR, 'deputy_team_leader', ''), true);
is('מפקד צוות',        R.mayAssignRole(HR, 'team_leader', ''),        true);

// מה שאסור לה — מעל התקרה
is('סגן מפקד משמרת',   R.mayAssignRole(HR, 'deputy', ''),             false);
is('מפקד משמרת',       R.mayAssignRole(HR, 'commander', ''),          false);
is('מפקד תחנה',        R.mayAssignRole(HR, 'station_commander', ''),  false);
is('מפקד מחוז',        R.mayAssignRole(HR, 'district_commander', ''), false);

// **הבדיקה החשובה ביותר.** בלעדיה כל התקרה חסרת ערך: רכזת
// שיכולה למנות רכזת נוספת יכולה למנות אותה ואז השתיים ממנות
// זו את זו לכל דבר.
is('רכזת נוספת',       R.mayAssignRole(HR, 'hr_coordinator', ''),     false);

// הורדה בדרגה היא שינוי סמכות בדיוק כמו העלאה. בלי הבדיקה
// הזאת הרכזת יכולה להדיח מפקד משמרת לדרגת לוחם — פעולה
// שהתפקיד החדש בה מתחת לתקרה.
is('הדחת מפקד ללוחם',  R.mayAssignRole(HR, 'firefighter', 'commander'), false);
is('הדחת מפקד תחנה',   R.mayAssignRole(HR, 'firefighter', 'station_commander'), false);
is('העברת מפקד צוות',  R.mayAssignRole(HR, 'firefighter', 'team_leader'), true);

console.log('מי בכלל רשאי לשבץ');
is('לוחם אש',          R.mayAssignRole(FF, 'firefighter', ''),  false);
is('מפקד משמרת',       R.mayAssignRole(CMD, 'firefighter', ''), false);
is('מנהל-על',          R.mayAssignRole(SUPER, 'station_commander', 'commander'), true);
is('בלי claims',       R.mayAssignRole(null, 'firefighter', ''), false);
is('תפקיד לא מוכר',    R.mayAssignRole({ role: 'zzz' }, 'firefighter', ''), false);

console.log('הבורר במסך');
is('רכזת רואה 3',      R.assignableRoles(HR).length, 3);
is('מנהל-על רואה הכל', R.assignableRoles(SUPER).length, R.ROLES.length);
is('לוחם רואה 0',      R.assignableRoles(FF).length, 0);
ok('הבורר לא מכיל deputy',
   R.assignableRoleOptionsHtml(HR).indexOf('"deputy"') === -1);
ok('הבורר כן מכיל team_leader',
   R.assignableRoleOptionsHtml(HR).indexOf('"team_leader"') !== -1);

console.log('סנכרון בין הדפדפן לשרת');

// חילוץ הטבלאות מקוד השרת, בלי להריץ אותו — index.js דורש
// firebase-admin ומתחבר לפרויקט אמיתי בזמן טעינה.
function grab(name) {
  const m = srv.match(new RegExp('const\\s+' + name + '\\s*=\\s*\\{([^}]*)\\}'));
  if (!m) return null;
  const out = {};
  m[1].split(',').forEach(function (part) {
    const kv = part.split(':');
    if (kv.length < 2) return;
    const k = kv[0].replace(/[^A-Za-z_]/g, '');
    const v = Number(kv[1].trim());
    if (k && isFinite(v)) out[k] = v;
  });
  return out;
}

const srvRank   = grab('ROLE_RANK');
const srvAssign = grab('ASSIGN_MAX_RANK');

ok('ROLE_RANK קיים בשרת', srvRank && Object.keys(srvRank).length > 0);
ok('ASSIGN_MAX_RANK קיים בשרת', srvAssign && Object.keys(srvAssign).length > 0);

if (srvRank) {
  R.ROLES.forEach(function (r) {
    is('דרגת ' + r.id + ' זהה בשרת', srvRank[r.id], r.rank);
  });
  is('אין תפקיד עודף בשרת',
     Object.keys(srvRank).length, R.ROLES.length);
}
if (srvAssign) {
  Object.keys(R.ASSIGN_MAX_RANK).forEach(function (k) {
    is('תקרת ' + k + ' זהה בשרת', srvAssign[k], R.ASSIGN_MAX_RANK[k]);
  });
  is('אין תקרה עודפת בשרת',
     Object.keys(srvAssign).length, Object.keys(R.ASSIGN_MAX_RANK).length);
}

console.log('שער השרת');
ok('setUserRole כבר לא requireSuperAdmin',
   /exports\.setUserRole[\s\S]{0,900}?requireRoleSetter/.test(srv));
ok('assertMayAssign נקראת ב-setUserRole',
   /exports\.setUserRole[\s\S]{0,3000}?assertMayAssign\(/.test(srv));
ok('התקרה נבדקת לפני מסלול none',
   srv.indexOf('assertMayAssign(gate') < srv.indexOf("if (role === 'none')"));
ok('מספר עובד נעול בפני מי שאינו מנהל-על',
   /gate\.cap !== Infinity[\s\S]{0,400}?שינוי מספר עובד/.test(srv));
ok('אי אפשר לשבץ את עצמך',
   /targetUid === gate\.auth\.uid/.test(srv));
ok('דגל מנהל-על חסום',
   /wantSuper \|\| \(targetBefore \|\| \{\}\)\.super === true/.test(srv));

console.log('כלב השמירה');
ok('systemHealth מיוצא',      /exports\.systemHealth\s*=\s*onSchedule/.test(srv));
ok('רץ כל בוקר',              /schedule: '0 6 \* \* \*'/.test(srv));
ok('אזור זמן ישראל',          /systemHealth[\s\S]{0,400}?timeZone: 'Asia\/Jerusalem'/.test(srv));
ok('שולח למנהל-על',           /systemHealth[\s\S]*?sendMail\(SUPER_ADMIN_EMAIL/.test(srv));
ok('שקט פירושו תקין',         /if \(!found\.length\) return;/.test(srv));
ok('רושם גם כשאין ממצאים',
   srv.indexOf("'/health/' + today") < srv.indexOf('if (!found.length) return;'));
ok('כל בדיקה עטופה',          /async function check\(name, fn\)/.test(srv));
ok('בדיקה שנפלה היא ממצא',    /'בדיקה נכשלה · ' \+ name/.test(srv));
ok('בודק מצב ניסוי',          /המערכת עדיין במצב ניסוי/.test(srv));
ok('בודק אוספים שגדלו',       /WHOLE_READ_COLS/.test(srv));
ok('בודק גבול מסמך',          /DOC_WARN_BYTES/.test(srv));
ok('בודק משימות ששתקו',       /nightlyScan לא רץ ביומיים/.test(srv));
ok('בודק יתומים במפתח',       /מספרי עובד מצביעים על משתמש שאינו קיים/.test(srv));

// שדות שהכלב קורא חייבים להיות השדות שהמערכת באמת כותבת.
// טעות כאן אינה מייצרת שגיאה — היא מייצרת בדיקה ששותקת לנצח.
ok('mail_failures.at נכתב באמת', /mail_failures'\)\.add\(\{[\s\S]{0,200}?at: FV\.serverTimestamp\(\)/.test(srv));
ok('scans.ran_at נכתב באמת',     /ran_at: FV\.serverTimestamp\(\)/.test(srv));


// ---------------------------------------------------------------
//  מסך תיקון השעות
// ---------------------------------------------------------------
//
// attendance.html נכתב במקור סביב ME בלבד, ובכל מקום שנגע
// בנתונים היה כתוב ME.emp במפורש. ב-25.8 הופרדו **מי מחובר**
// (ME) מ**על מי מסתכלים** (SUBJ).
//
// הבדיקות כאן קיימות כי הטעות בשינוי הזה שקטה לחלוטין: נתיב
// שנשאר עם ME ייראה תקין ב-100% מהמקרים כשאתה מסתכל על עצמך,
// ויכתוב לרשומה של האדם הלא נכון בפעם הראשונה שרכזת פותחת
// מישהו אחר. אין שגיאה, אין הודעה — פשוט שעות אצל מי שלא עבד.
const att = fs.readFileSync(__j(__APP, 'attendance.html'), 'utf8');

console.log('מסך תיקון השעות');

// כל נתיב נתונים חייב SUBJ. מותר ME רק בהקשרי זהות מוצהרים.
const dataPaths = [
  ["where('emp_number', '==', snapshot.emp)", 'טעינת החודש'],
  ['recordId(SUBJ.emp, key)',             'כתיבת יום'],
  ['emp_number: SUBJ.emp',                'מספר עובד ברשומה'],
  ['crew: SUBJ.crew',                     'משמרת ברשומה'],
  ["'shifts', snapshot.crew)",            'לוח המשמרת'],
  ['swapEffect(swaps, SUBJ.uid, key)',    'החלפות'],
  ['personWorks(rotations, SUBJ.crew',    'האם עובד ביום הזה']
];
dataPaths.forEach(function (pair) {
  ok(pair[1] + ' עובר דרך SUBJ', att.indexOf(pair[0]) !== -1);
});
ok('טעינת חודש לוכדת snapshot', /const snapshot = \{[\s\S]{0,180}?subject: subjectGeneration/.test(att));
ok('חודש ישן אינו מתפרסם', /generation === monthLoadGeneration/.test(att));
ok('אבטחות נקראות בחודש המוצג במדויק',
   /function guardMonthRange\(year, month\)[\s\S]{0,180}?from: dateKey\(year, month, 1\)[\s\S]{0,180}?to: dateKey\(year, month, daysInMonth\(year, month\)\)/.test(att));
ok('אבטחות אישיות נקראות רק לחשבון המחובר',
   /function readMyGuardAttendance\(snapshot\)[\s\S]{0,700}?snapshot\.subjectUid !== snapshot\.viewerUid\) return \[\]/.test(att));
ok('תוצאת אבטחות ישנה אינה יכולה לדרוס חדשה',
   /let guardLoadGeneration = 0;/.test(att) &&
   /function beginMyGuardAttendance\(snapshot\)[\s\S]{0,220}?\+\+guardLoadGeneration/.test(att) &&
   /guardResult\.generation === guardLoadGeneration/.test(att) &&
   /freshGuards\.generation === guardLoadGeneration/.test(att));
ok('טווח האבטחות לא מקבל subject או uid מהדפדפן',
   /callMyGuardAttendance\(range\)/.test(att) &&
   !/callMyGuardAttendance\(\{[\s\S]{0,200}?(?:subject|uid)/.test(att));
ok('המסך אינו קורא מסמכי אבטחה גולמיים',
   !/collection\(db, 'stations', snapshot\.sid, 'guards'\)/.test(att) &&
   !/guardHasMe/.test(att));
ok('אדם ישן אינו מתפרסם', /generation === staticLoadGeneration/.test(att));
ok('מעבר אדם מאפס מידע שתלוי ב-uid',
   /const previousUid = SUBJ && SUBJ\.uid[\s\S]{0,260}?previousUid !== SUBJ\.uid[\s\S]{0,180}?mySite = ''[\s\S]{0,100}?myGuards = \[\]/.test(att));
ok('מילוי אוטומטי של אבטחה אינו משתמש במקום',
   /notes: g\.title \|\| ''/.test(att) && !/g\.place/.test(att));
ok('טעינת חודש נועלת גם את פעולות שעון המשמרת',
   /function setMonthBusy\(busy\)[\s\S]{0,320}?'btnStart','btnStop'/.test(att));
ok('שחרור פעולה מכבד חודש שעדיין בטעינה',
   /function releaseMonthAction\(button\)[\s\S]{0,180}?aria-busy[\s\S]{0,80}?=== 'true'/.test(att));
is('שלוש פעולות החודש משתחררות דרך שומר הטעינה',
   (att.match(/releaseMonthAction\(b\)/g) || []).length, 3);

// אין שריד. ME.emp מותר רק בשלושה מקומות מוצהרים: ההשוואה
// ב-onOther, הכותרת, וההשוואה באישור חודש.
const meEmpLines = att.split('\n')
  .map(function (l, i) { return { n: i + 1, t: l }; })
  .filter(function (o) {
    return /ME\.emp|ME\.crew|ME\.uid/.test(o.t) &&
           o.t.indexOf('//') === -1;
  });
const allowed = [
  'SUBJ.emp !== ME.emp',           // onOther
  "' · מס׳ ' + ME.emp",            // כותרת הזהות
  'CREW_HE[ME.crew]',              // כותרת הזהות
  'watchCallouts(db, SID, ME.uid', // קריאות פתע — למי שמחובר
  'viewerUid: ME && ME.uid',       // גבול קריאת אבטחות אישית
  'viewerUid:ME && ME.uid',        // אותו גבול בתוך פעולת סנכרון
  'ME && ME.uid === snapshot.viewerUid', // אימות דור הטעינה של אותה זהות
  'action.viewerUid === (ME && ME.uid)', // התאמת סנכרון לזהות שפתחה את הפעולה
  'emp !== ME.emp',                // האם צריך לחתום על האישור
  'edited_by:      ME.uid',        // חותמת
  'body.edited_by      = ME.uid',  // חותמת באישור
  'approved_by: ME.uid',           // מי אישר
  'reopened_by: ME.uid'            // מי פתח מחדש
];
const strays = meEmpLines.filter(function (o) {
  return !allowed.some(function (a) { return o.t.indexOf(a) !== -1; });
});
strays.forEach(function (o) {
  console.log('  ✗ שורה ' + o.n + ' עדיין על ME: ' + o.t.trim().slice(0, 70));
});
is('אין נתיב נתונים שנשאר על ME', strays.length, 0);

console.log('חתימת התיעוד');
ok('stamp מוגדרת',            /function stamp\(body\)/.test(att));
ok('edited_by הוא ה-uid האמיתי', /edited_by:\s+ME\.uid/.test(att));
ok('עריכה עצמית לא נחתמת',    /if \(!onOther\(\)\) return body;/.test(att));
ok('שמירת יום נחתמת',         /recordId\(SUBJ\.emp, key\)\), stamp\(body\)\)/.test(att));
ok('מילוי אצווה נחתם',        /stamp\(rec\)/.test(att));
ok('הוספה אוטומטית נחתמת',    /stamp\(add\)/.test(att));
ok('תיקון שעות נחתם',         /stamp\(\{ hours: h/.test(att));
ok('אישור חודש נחתם',         /body\.edited_by      = ME\.uid/.test(att));

console.log('גבולות המסך');
ok('הבורר לרכזת ולמנהל-על בלבד',
   /CAN_EDIT_OTHERS = isSuper \|\| c\.role === 'hr_coordinator'/.test(att));
ok('מפקד משמרת אינו מקבל את הבורר',
   att.indexOf("CAN_EDIT_OTHERS = isSuper || c.role === 'commander'") === -1);
ok('פס אזהרה כשעורכים אחר',   /otherBar/.test(att));
ok('אי אפשר להצהיר בשם אחר',
   /btnSubmit'\)\.classList\.toggle\('hide',\s*\n?\s*onOther\(\)/.test(att));
ok('הרשימה נקראת מ-users ולא מ-roster',
   /loadPeople[\s\S]{0,400}?'users'\)/.test(att));


console.log('');
console.log(fail ? (fail + ' נכשלו · ' + pass + ' עברו')
                 : ('כל ' + pass + ' הבדיקות עברו'));
process.exit(fail ? 1 : 0);
