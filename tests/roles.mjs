// ============================================================
//  התפקידים — הלקוח מול השרת
// ============================================================
//
//  זו בדיקה נגד סוג באג אחד מסוים, והוא כבר קרה כאן פעמיים.
//
//  אותו נתון נשמר בשני מקומות: רשימת התפקידים ב-roles.js
//  (דפדפן) וב-functions/index.js (שרת), ולוג המשמרת מחזיק
//  את טקסטי המערכת בשניהם. השרת הוא CommonJS ואינו יכול
//  לייבא מודול דפדפן, ולכן הכפילות בלתי נמנעת — אבל
//  יציאה מסנכרון בין השניים בלתי נראית לחלוטין בקוד.
//
//  איך זה נראה כשזה קורה: אלדד מגדיר "מפקד צוות" במסך
//  הניהול, השרת דוחה את התפקיד ומחליף אותו ל-firefighter
//  בשקט, והאדם פשוט לא מקבל את מה שהוגדר לו. אף שגיאה
//  לא נזרקת.

import { fileURLToPath as __f } from 'url';
import { dirname as __d, join as __j } from 'path';
import { pathToFileURL } from 'url';
import { readFileSync } from 'fs';

const __TESTS = __d(__f(import.meta.url));
const __APP   = __j(__TESTS, '..');

const R = await import(pathToFileURL(__j(__APP, 'roles.js')).href);
const L = await import(pathToFileURL(__j(__APP, 'shiftlog.js')).href);

const SERVER = readFileSync(__j(__APP, 'functions', 'index.js'), 'utf8');
const SCHEDULE_RUNTIME = readFileSync(__j(__APP, 'functions', 'schedule-runtime.js'), 'utf8');
const BULLETIN_SERVER = readFileSync(__j(__APP, 'functions', 'bulletin.js'), 'utf8');
const RULES  = readFileSync(__j(__APP, 'firestore.rules'), 'utf8');

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

// ============================================================
head('1 · הרשימה בשרת מול הרשימה בדפדפן');
// ============================================================

const m = SERVER.match(/const VALID_ROLES = \[([\s\S]*?)\]/);
is('VALID_ROLES נמצאה ב-index.js', !!m, true);

const serverRoles = (m ? m[1] : '')
  .split(',').map(s => s.trim().replace(/^'|'$/g, ''))
  .filter(Boolean);

is('אותם תפקידים בדיוק, בשני הצדדים',
   serverRoles.slice().sort(), R.VALID_ROLES.slice().sort());

const bulletinMembersMatch = BULLETIN_SERVER.match(
  /const MEMBER_ROLES = Object\.freeze\(\[([\s\S]*?)\]\)/
);
is('MEMBER_ROLES של לוח המודעות נמצאה בשרת', !!bulletinMembersMatch, true);
const bulletinMembers = (bulletinMembersMatch ? bulletinMembersMatch[1] : '')
  .split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
is('לוח המודעות והלקוח מכירים אותם חברי תחנה',
   bulletinMembers.slice().sort(), R.MEMBER_ROLES.slice().sort());

// ============================================================
head('2 · כל תפקיד מוכר לכללי האבטחה');
// ============================================================
//
// תפקיד שקיים בשרת ולא בכללים הוא אדם שיכול להתחבר ואז
// נחסם מכל מסך, בלי שום הודעה שמסבירה למה.

const memberBlock = (RULES.match(/function member\(sid\)[\s\S]*?\n    \}/) || [''])[0];
R.MEMBER_ROLES.forEach(function (id) {
  is('member() מכיר את ' + id, memberBlock.indexOf("'" + id + "'") !== -1, true);
});

const staffBlock = (RULES.match(/function staff\(sid\)[\s\S]*?\n    \}/) || [''])[0];
is('🔒 מפקד צוות אינו staff',
   staffBlock.indexOf("'team_leader'") === -1, true);
is('🔒 סגן מפקד צוות אינו staff',
   staffBlock.indexOf("'deputy_team_leader'") === -1, true);

const logBlock = (RULES.match(/function logWriter\(sid\)[\s\S]*?\n    \}/) || [''])[0];
is('logWriter() קיים בכללים', logBlock.length > 0, true);
R.LOG_ROLES.forEach(function (id) {
  is('logWriter() מכיר את ' + id, logBlock.indexOf("'" + id + "'") !== -1, true);
});
is('🔒 לוחם אש אינו כותב בלוג',
   logBlock.indexOf("'firefighter'") === -1, true);

// ============================================================
head('3 · הרשאות');
// ============================================================

const FF   = { role: 'firefighter' };
const TL   = { role: 'team_leader' };
const DTL  = { role: 'deputy_team_leader' };
const CMD  = { role: 'commander' };
const SUP  = { role: 'firefighter', super: true };
const DIST = { role: 'district_commander' };

is('לוחם אש הוא member',          R.isMember(FF),  true);
is('מפקד צוות הוא member',        R.isMember(TL),  true);
is('🔒 מפקד מחוז אינו member',    R.isMember(DIST), false);
is('🔒 לוחם אש אינו staff',       R.isStaff(FF),   false);
is('🔒 מפקד צוות אינו staff',     R.isStaff(TL),   false);
is('🔒 סגן מפקד צוות אינו staff', R.isStaff(DTL),  false);
is('מפקד משמרת הוא staff',        R.isStaff(CMD),  true);
is('מנהל-על הוא staff גם כלוחם אש', R.isStaff(SUP), true);

is('🔒 לוחם אש אינו כותב בלוג',   R.mayWriteLog(FF),  false);
is('מפקד צוות כותב בלוג',         R.mayWriteLog(TL),  true);
is('סגן מפקד צוות כותב בלוג',     R.mayWriteLog(DTL), true);
is('מפקד משמרת כותב בלוג',        R.mayWriteLog(CMD), true);
is('🔒 מפקד מחוז אינו כותב בלוג', R.mayWriteLog(DIST), false);

// ============================================================
head('4 · שמות בעברית');
// ============================================================

R.VALID_ROLES.forEach(function (id) {
  const he = R.roleHe(id);
  is('ל-' + id + ' יש שם בעברית', he !== id && /[֐-׿]/.test(he), true);
});
is('מפקד צוות',      R.roleHe('team_leader'),        'מפקד צוות');
is('סגן מפקד צוות',  R.roleHe('deputy_team_leader'), 'סגן מפקד צוות');
is('תפקיד לא מוכר מוחזר כמו שהוא', R.roleHe('nope'), 'nope');

// ============================================================
head('5 · בורר התפקידים');
// ============================================================
//
// הבורר במסך הניהול נכתב פעם ביד, וחסרו בו סגן מפקד משמרת
// ומפקד תחנה — שני תפקידים שכבר היו קיימים ואי אפשר היה
// להגדיר אותם דרך המסך בכלל.

const opts = R.roleOptionsHtml();
R.VALID_ROLES.forEach(function (id) {
  is('הבורר כולל את ' + id, opts.indexOf('value="' + id + '"') !== -1, true);
});
is('תוספת חיצונית נכנסת',
   R.roleOptionsHtml([{ id: 'none', he: 'הסרה' }]).indexOf('value="none"') !== -1, true);

// ============================================================
head('6 · טקסטי המערכת בלוג — שרת מול דפדפן');
// ============================================================

const SW = { from_name: 'אלדד', to_name: 'רמי',
             from_date: '2026-09-12', to_date: '2026-09-14' };

['open','peer','cmd_from','cmd_to','approved','rejected','cancelled']
  .forEach(function (st) {
    const client = L.swapSystemText(st, SW);
    is('יש טקסט למצב ' + st, client.length > 0, true);
    // אותה מחרוזת בדיוק חייבת להופיע בקוד השרת, אחרת
    // ההודעה שתיכתב בפועל אינה זו שנבדקה כאן.
    const lit = SW_LITERAL(st);
    is('השרת מחזיק את אותו טקסט למצב ' + st,
       SERVER.indexOf(lit) !== -1, true);
  });

// החלק הקבוע של כל הודעה — מה שאפשר לחפש בקוד השרת בלי
// לשחזר את כל ההשרשור.
function SW_LITERAL(st) {
  return {
    open:      "' פרסם בקשת החלפה ל-'",
    peer:      "' ביקש להחליף עם '",
    cmd_from:  "' הסכים להחלפה עם '",
    cmd_to:    "'מפקד המשמרת של '",
    approved:  "'✅ ההחלפה אושרה: '",
    rejected:  "'❌ ההחלפה בין '",
    cancelled: "'הבקשה של '"
  }[st];
}

is('מצב לא מוכר מחזיר ריק', L.swapSystemText('nope', SW), '');

// ============================================================
head('7 · המסכים מכירים את כל התפקידים');
// ============================================================
//
//  **הבאג שהבדיקה הזאת נועדה למנוע.**
//
//  ב-25.8.2026 נוספו מפקד צוות וסגן מפקד צוות ל-roles.js
//  ולכללי האבטחה — אבל **תשעה מסכים החזיקו את רשימת
//  התפקידים כתובה ביד**, בלי השניים החדשים.
//
//  התוצאה: התפריט (שקורא מ-roles.js) הציג להם את כל
//  הכפתורים, והמסך עצמו ענה "אין הרשאה". השרת דווקא התיר —
//  כלומר החסימה הייתה במסך בלבד, והמשתמש חווה מערכת שבורה.
//
//  הבדיקה אוסרת על רשימת תפקידים קשיחה בכל מסך. מי שמוסיף
//  תפקיד מעכשיו — מוסיף אותו במקום אחד.

import { readdirSync } from 'fs';

const SCREENS = readdirSync(__APP).filter(f => f.endsWith('.html'));
const HARDCODED = /\[\s*'firefighter'[^\]]*\]\s*\.indexOf\s*\(\s*c\.role/;

SCREENS.forEach(function (f) {
  const src = readFileSync(__j(__APP, f), 'utf8');
  is('🔒 ' + f + ' אינו מחזיק רשימת תפקידים קשיחה',
     HARDCODED.test(src), false);
});

// וכל מסך שבודק תפקיד חייב לייבא את הרשימה מהמקור
SCREENS.forEach(function (f) {
  const src = readFileSync(__j(__APP, f), 'utf8');
  if (src.indexOf('MEMBER_ROLES') === -1) return;
  is(f + ' מייבא את MEMBER_ROLES מ-roles.js',
     /import\s*\{[^}]*MEMBER_ROLES[^}]*\}\s*from\s*'\.\/roles\.js/.test(src), true);
});

// ============================================================
head('8 · מפקד צוות אינו חלש מלוחם אש');
// ============================================================
//
//  התפקידים האלה אמורים להיות "לוחם אש ועוד כתיבה בלוג".
//  guardSignup עבר לשער schedule-runtime, לכן הבדיקה חייבת
//  לבדוק את שני שערי ההרשאה שם ולא רשימת תפקידים ישנה בעטיפה.

const scheduleMembersMatch = SCHEDULE_RUNTIME.match(
  /const MEMBER_ROLES = Object\.freeze\(\[([\s\S]*?)\]\);/
);
const scheduleMembers = (scheduleMembersMatch ? scheduleMembersMatch[1] : '')
  .split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
const signupStart = SCHEDULE_RUNTIME.indexOf('async function signupGuard(req) {');
const modeStart = SCHEDULE_RUNTIME.indexOf('function requireMode(config, allowed) {', signupStart);
const signupBody = signupStart === -1 || modeStart === -1
  ? '' : SCHEDULE_RUNTIME.slice(signupStart, modeStart);
const signupWrapperStart = SERVER.indexOf('exports.guardSignup =');
const assignWrapperStart = SERVER.indexOf('exports.assignGuard =', signupWrapperStart);
const signupWrapper = signupWrapperStart === -1 || assignWrapperStart === -1
  ? '' : SERVER.slice(signupWrapperStart, assignWrapperStart);

is('MEMBER_ROLES של שער הסידור נמצאה בשרת', !!scheduleMembersMatch, true);
is('שער הסידור והלקוח מכירים אותם חברי תחנה',
   scheduleMembers.slice().sort(), R.MEMBER_ROLES.slice().sort());
is('עטיפת guardSignup מעבירה לשער הסידור עם App Check',
   /onCall\(\{\s*enforceAppCheck:\s*true\s*\}[\s\S]*invokeSchedule\('signupGuard',\s*req\)/.test(signupWrapper), true);
is('guardSignup נכנס קודם לשער זהות חי',
   /const ctx\s*=\s*await context\(req\);/.test(signupBody), true);
is('guardSignup קורא מחדש משתמש חי בתוך העסקה',
   /tx\.get\(liveUserRef\(ctx\.sid, ctx\.uid\)\)/.test(signupBody), true);
is('guardSignup מאמת חברות פעילה בתוך העסקה',
   /scheduleAccess\.activeMember\(user, ctx\.sid\)/.test(signupBody), true);
is('guardSignup מאמת תפקיד חי מול MEMBER_ROLES בתוך העסקה',
   /MEMBER_ROLES\.indexOf\(String\(user && user\.role \|\| ''\)\)/.test(signupBody), true);
is('guardSignup חוסם claim תפקיד מיושן בתוך העסקה',
   /String\(user && user\.role \|\| ''\) !== ctx\.role/.test(signupBody), true);

['team_leader', 'deputy_team_leader'].forEach(function (r) {
  const bcBody = (SERVER.match(/exports\.sendBroadcast[\s\S]*?\n\}\);/) || [''])[0];
  const bc = bcBody.match(/if \(!wide && \[([\s\S]*?)\]/);
  is('sendBroadcast מתיר ל-' + r,
     !!bc && bc[1].indexOf("'" + r + "'") !== -1, true);
  is('guardSignup מתיר ל-' + r,
     scheduleMembers.indexOf(r) !== -1, true);
});

console.log('\n\x1b[1m════════════════════════════════════\x1b[0m');
if (fail === 0) {
  console.log('\x1b[32m\x1b[1m  ✓ כל ' + pass + ' הבדיקות עברו\x1b[0m');
} else {
  console.log('\x1b[31m\x1b[1m  ✗ ' + fail + ' נכשלו · ' + pass + ' עברו\x1b[0m');
  bad.forEach(b => console.log('    ' + b));
}
console.log('\x1b[1m════════════════════════════════════\x1b[0m\n');
process.exit(fail === 0 ? 0 : 1);
