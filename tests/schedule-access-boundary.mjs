// ============================================================
//  גבולות ההרשאה של סידור העבודה · בדיקה עצמאית
// ============================================================
//
//      node tests/schedule-access-boundary.mjs
//
//  אין רשת, אין Firebase, אין אמולטור, אין תלות חיצונית.
//  הבדיקה אינה משנה שום קוד עסקי.
//
//  ההחלטה שהיא שומרת עליה, מילה במילה:
//
//    „דרגה פיקודית אינה סמכות סידור. מפקד, סגן, רכזת ומנהל-על
//     מקבלים צפייה כמו כל חבר תחנה, ולא עריכה. עריכה מגיעה אך
//     ורק מרשומת מינוי חיה, מקומית לתחנה."
//
//  שתי שכבות נבדקות, ובמכוון:
//
//    1. **התנהגות** — schedule-service.js מריץ את שער ההרשאה
//       האמיתי מול מפת היכולות האמיתית.
//    2. **מקור** — schedule-runtime.js הוא המקום היחיד שקובע
//       מי הוא scheduler. בדיקת התנהגות לבדה לא תתפוס שינוי
//       שם, כי היא מקבלת את המפה בהזרקה.
//
//  ובסוף — מוטציות. הגנה שלא נבדק שהיא נופלת על קוד שבור
//  אינה הגנה שנבדקה.
// ============================================================

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const __TESTS = dirname(fileURLToPath(import.meta.url));
const __APP = join(__TESTS, '..');
const require_ = createRequire(import.meta.url);

const SERVICE_PATH = join(__APP, 'functions', 'schedule-service.js');
const RUNTIME_PATH = join(__APP, 'functions', 'schedule-runtime.js');

const S = require_(SERVICE_PATH);
const RUNTIME_SRC = readFileSync(RUNTIME_PATH, 'utf8');

// ------------------------------------------------------------
//  שער התאמה · המינוי אינו קיים בכל ענף
// ------------------------------------------------------------
//
//  „אחראי/ת סידור" חי בענף codex/resq-schedule-manager-role
//  ואינו ב-main. הרצה של הבדיקה על main הייתה מייצרת שבעה
//  כשלים על **היעדר קוד**, ולא על הפרת אבטחה — וזה בדיוק סוג
//  האזהרה שמפסיקים לקרוא אחרי פעמיים.
//
//  לכן יציאה 2 ולא 0 ולא 1: **NOT RUN**. לא „עבר", כי שום
//  דבר לא נבדק; לא „נכשל", כי שום דבר לא שבור. אותה מוסכמה
//  בדיוק שבה משתמשות בדיקות האינטגרציה כשאין אמולטור.
//  הסמן הוא **מסמך המינוי החי** — hasLiveScheduleManagerGrant —
//  ולא capabilities() או ctx.manager, ששניהם קיימים כבר ב-main
//  מ-42F. שבע הקביעות שנופלות הן בדיוק אלה שבודקות את המינוי,
//  ולכן זה הסמן הנכון.
if (!/hasLiveScheduleManagerGrant/.test(RUNTIME_SRC) ||
    !/SCHEDULE_MANAGER_GRANTS/.test(RUNTIME_SRC)) {
  console.error('NOT RUN — מסלול „אחראי/ת סידור" אינו קיים ב-schedule-runtime.js.');
  console.error('הבדיקה שייכת לענף codex/resq-schedule-manager-role.');
  console.error('  git checkout codex/resq-schedule-manager-role');
  console.error('  node tests/schedule-access-boundary.mjs');
  process.exit(2);
}

let pass = 0, fail = 0;
const bad = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; bad.push(name);
  console.log('  ✗ ' + name + (detail ? '\n      ' + detail : ''));
}
function head(t) { console.log('\n--- ' + t); }

const ST = 'station-102';
const OTHER = 'station-777';

// ------------------------------------------------------------
//  מפת היכולות החיה, מועתקת מ-schedule-runtime.js capabilities()
//  סעיף 3 למטה אוכף שהעותק הזה לא נפרד מהמקור.
// ------------------------------------------------------------
const VIEW = ['view_my', 'view_station', 'respond_own'];
const LIVE_CAPS = {
  firefighter: VIEW,
  scheduler: VIEW.concat(['edit_draft', 'run_planner', 'publish'])
};

function service(caps) {
  return S.createScheduleService({
    clock: () => '2026-09-01T00:00:00.000Z',
    engine: { planPeriod() {}, planMonths() {}, policy: { station_id: ST } },
    publication: { planPublication() {} },
    rules: { station_id: ST, capabilities: caps || LIVE_CAPS }
  });
}

// כל אחד מהם חבר תחנה פעיל. ההבדל היחיד הוא המינוי.
function person(role, over) {
  return Object.assign({ id: 'u-' + role, role, station_id: ST, active: true }, over || {});
}

function denied(fn) {
  try { fn(); return null; } catch (e) { return e && e.code ? e.code : 'THREW'; }
}

const PRIVILEGED = ['edit_draft', 'run_planner', 'publish'];

// ============================================================
head('1 · דרגה ללא מינוי — צפייה בלבד');
// ============================================================
//
//  actor() ב-schedule-runtime ממפה כל דרגה תחנתית ל-firefighter
//  אלא אם קיים מינוי חי. לכן „מפקד ללא מינוי" הוא firefighter
//  בשם אחר, וזה בדיוק מה שנבדק כאן.

const svc = service();
const ff = person('firefighter');

for (const action of PRIVILEGED) {
  ok('כבאי ללא מינוי · ' + action + ' חסום',
     denied(() => svc.assertMay(action, ff)) === 'forbidden');
}
ok('כבאי רואה את הסידור שלו', svc.assertMay('view_my', ff) === true);
ok('כבאי רואה את סידור התחנה', svc.assertMay('view_station', ff) === true);
ok('כבאי עונה על השיבוץ שלו', svc.assertMay('respond_own', ff, ff.id) === true);

// הדרגות שההחלטה נוקבת בהן בשמן. אף אחת מהן אינה תפקיד מוכר
// במפת היכולות — וזו ההגנה: תפקיד לא מוכר נחסם, ולא מקבל
// ברירת מחדל שקטה.
head('2 · הדרגות מההחלטה — אף אחת אינה מקבלת יכולת');
for (const rank of ['commander', 'deputy', 'station_commander',
                    'hr_coordinator', 'superadmin', 'admin']) {
  const code = denied(() => svc.assertMay('view_my', person(rank)));
  ok(rank + ' אינו תפקיד מוכר במפה · נחסם', code === 'role-unknown',
     'קוד שהתקבל: ' + code);
  for (const action of PRIVILEGED) {
    ok(rank + ' · ' + action + ' חסום', denied(() => svc.assertMay(action, person(rank))) !== null);
  }
}

// ============================================================
head('3 · מינוי חי — ורק הוא — פותח עריכה');
// ============================================================

const mgr = person('scheduler');
for (const action of PRIVILEGED) {
  ok('אחראי סידור · ' + action + ' מותר', svc.assertMay(action, mgr) === true);
}
ok('אחראי סידור עדיין רואה', svc.assertMay('view_station', mgr) === true);

// ההסרה. אותה זהות בדיוק, בלי המינוי.
const sameHumanNoGrant = Object.assign({}, mgr, { role: 'firefighter' });
for (const action of PRIVILEGED) {
  ok('אותו אדם אחרי הסרת המינוי · ' + action + ' חסום',
     denied(() => svc.assertMay(action, sameHumanNoGrant)) === 'forbidden');
}
ok('ואחרי ההסרה נשארה לו צפייה',
   svc.assertMay('view_station', sameHumanNoGrant) === true);

// ============================================================
head('4 · מצבי קצה של הזהות');
// ============================================================

ok('משתמש לא פעיל נחסם גם עם מינוי',
   denied(() => svc.assertMay('edit_draft', person('scheduler', { active: false }))) === 'actor-inactive');
ok('active חסר נחסם ואינו מניח פעיל',
   denied(() => svc.assertMay('view_my', { id: 'u', role: 'firefighter', station_id: ST })) === 'actor-active');
ok('תחנה זרה נחסמת גם עם מינוי',
   denied(() => svc.assertMay('edit_draft', person('scheduler', { station_id: OTHER }))) === 'actor-station-mismatch');
ok('בלי מזהה נחסם',
   denied(() => svc.assertMay('view_my', { role: 'firefighter', station_id: ST, active: true })) === 'actor-id');
ok('פעולה לא מוכרת נחסמת',
   denied(() => svc.assertMay('delete_everything', mgr)) === 'action-unknown');

// תגובה בשם אדם אחר — גם לאחראי הסידור.
ok('אחראי סידור אינו עונה בשם אחר',
   denied(() => svc.assertMay('respond_own', mgr, 'u-someone-else')) === 'not-your-answer');
ok('כבאי אינו עונה בשם אחר',
   denied(() => svc.assertMay('respond_own', ff, 'u-someone-else')) === 'not-your-answer');
ok('respond_own בלי יעד נחסם',
   denied(() => svc.assertMay('respond_own', ff)) === 'target-required');

// ============================================================
head('5 · מקור · schedule-runtime הוא הקובע היחיד');
// ============================================================
//
//  שכבת ההתנהגות מקבלת את מפת היכולות בהזרקה, ולכן לא תתפוס
//  לעולם שינוי במקור שממנו המפה מגיעה. הקביעות כאן הן ההגנה
//  היחידה על כך שדרגה לא תזלוג לתוך scheduler.

const FLAT = RUNTIME_SRC.replace(/\s+/g, ' ');

ok('capabilities() מגדיר בדיוק שני תפקידים',
   /return \{ firefighter: view, scheduler: view\.concat\(/.test(FLAT),
   'כל תפקיד שלישי במפה הוא דרך לעקוף את המינוי');

ok('התפקיד נגזר מ-ctx.manager בלבד',
   /role: ctx\.manager \? 'scheduler' : 'firefighter'/.test(FLAT),
   'אם התפקיד נגזר מ-ctx.role או מ-token.role — דרגה הפכה לסמכות');

ok('שלוש הפעולות הרגישות שייכות ל-scheduler בלבד',
   /view\.concat\(\['edit_draft', 'run_planner', 'publish'\]\)/.test(FLAT));

ok('הצפייה כוללת respond_own ואינה כוללת פעולה רגישה',
   /const view = \['view_my', 'view_station', 'respond_own'\];/.test(FLAT));

ok('manager דורש managerEligible וגם מסמך מינוי חי',
   /const manager = managerEligible && await hasLiveScheduleManagerGrant\(/.test(FLAT));

ok('מינוי דורש claim חתום',
   /token\.schedule_manager !== true\) return false/.test(FLAT));

ok('מינוי דורש מסמך פעיל, uid ותחנה תואמים וגרסה תואמת',
   /grant\.active === true/.test(FLAT) &&
   /String\(grant\.uid \|\| ''\) === String\(uid\)/.test(FLAT) &&
   /String\(grant\.stationId \|\| ''\) === String\(sid\)/.test(FLAT) &&
   /String\(grant\.version \|\| ''\) === version/.test(FLAT),
   'ארבע ההשוואות יחד הן מה שהופך ביטול למיידי');

ok('מנהל-על אינו מקבל עריכה אוטומטית',
   /managerEligible = MEMBER_ROLES\.indexOf\(role\) !== -1/.test(FLAT),
   'super אינו מייצר managerEligible בפני עצמו');

ok('התחנה אינה מתקבלת מהלקוח',
   /client-station-forbidden/.test(FLAT));

ok('נדרש משתמש חי ופעיל ברשימת התחנה',
   /live-user-required/.test(FLAT) && /live-user-inactive/.test(FLAT));

ok('PRIVILEGED במודול השירות נשאר שלוש הפעולות',
   S.PRIVILEGED.length === 3 &&
   PRIVILEGED.every((a) => S.PRIVILEGED.indexOf(a) !== -1));

// ============================================================
head('6 · מוטציות · כל הגנה נופלת על קוד שבור');
// ============================================================
//
//  בדיקה שעוברת על קוד תקין ואינה נופלת על קוד שבור אינה
//  מוכיחה דבר. כל מוטציה כאן שוברת דבר אחד בלבד.

function mutation(name, caps, expectCatch) {
  let caught = false;
  try {
    const s = service(caps);
    caught = !expectCatch(s);
  } catch (e) {
    caught = true;
  }
  ok('מוטציה נתפסה · ' + name, caught);
}

mutation('כבאי מקבל edit_draft',
  { firefighter: VIEW.concat(['edit_draft']), scheduler: LIVE_CAPS.scheduler },
  (s) => denied(() => s.assertMay('edit_draft', person('firefighter'))) === 'forbidden');

mutation('כבאי מקבל publish',
  { firefighter: VIEW.concat(['publish']), scheduler: LIVE_CAPS.scheduler },
  (s) => denied(() => s.assertMay('publish', person('firefighter'))) === 'forbidden');

mutation('נוסף תפקיד commander עם עריכה',
  Object.assign({}, LIVE_CAPS, { commander: VIEW.concat(['edit_draft']) }),
  (s) => denied(() => s.assertMay('edit_draft', person('commander'))) !== null);

mutation('נוסף תפקיד hr_coordinator עם הרצה',
  Object.assign({}, LIVE_CAPS, { hr_coordinator: VIEW.concat(['run_planner']) }),
  (s) => denied(() => s.assertMay('run_planner', person('hr_coordinator'))) !== null);

mutation('אחראי הסידור מאבד את העריכה',
  { firefighter: VIEW, scheduler: VIEW },
  (s) => s.assertMay('edit_draft', person('scheduler')) === true);

// מוטציות על המקור — טקסט שבור במקום קובץ שבור.
function srcMutation(name, broken, probe) {
  const mutated = RUNTIME_SRC.replace(broken.from, broken.to);
  ok('מוטציית מקור נתפסה · ' + name,
     mutated !== RUNTIME_SRC && !probe(mutated.replace(/\s+/g, ' ')),
     mutated === RUNTIME_SRC ? 'המחרוזת לא נמצאה — הבדיקה התיישנה' : '');
}

srcMutation('התפקיד נגזר מהדרגה במקום מהמינוי',
  { from: "role: ctx.manager ? 'scheduler' : 'firefighter'", to: 'role: ctx.role' },
  (f) => /role: ctx\.manager \? 'scheduler' : 'firefighter'/.test(f));

srcMutation('בדיקת הגרסה הוסרה מהמינוי',
  { from: "String(grant.version || '') === version", to: 'true' },
  (f) => /String\(grant\.version \|\| ''\) === version/.test(f));

srcMutation('בדיקת התחנה הוסרה מהמינוי',
  { from: "String(grant.stationId || '') === String(sid)", to: 'true' },
  (f) => /String\(grant\.stationId \|\| ''\) === String\(sid\)/.test(f));

srcMutation('active הוסר מהמינוי',
  { from: 'grant.active === true', to: 'true' },
  (f) => /grant\.active === true/.test(f));

// ============================================================
console.log('\n============================================');
console.log('  גבולות הרשאות · עברו ' + pass + '  ·  נכשלו ' + fail);
if (fail) console.log('  ' + bad.join('\n  '));
console.log('============================================');
process.exit(fail ? 1 : 0);
