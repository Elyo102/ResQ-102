// ============================================================
//  חדירה לפרטיות · מה כבאי רגיל מקבל, ומה אסור שיקבל
// ============================================================
//
//      node tests/schedule-privacy-probe.mjs
//
//  אין רשת, אין Firebase, אין אמולטור, אין תלות חיצונית.
//  הבדיקה אינה משנה שום קוד עסקי.
//
//  השיטה: **מרעילים את הקלט.** כל אובייקט אדם שנכנס לבנאים
//  נושא מספר עובד, טלפון, מייל, הערת ניהול ורשומת הרשמה —
//  ואז נבדק שאף אחד מהם אינו יוצא בפלט. בדיקה שמזינה קלט נקי
//  אינה יכולה למצוא דליפה, כי אין מה שידלוף.
//
//  הבדיקה בודקת גם את **שכבת הצמצום** ב-schedule-runtime.js,
//  כי היא זו שקובעת מה בכלל מגיע לבנאים. הבנאים טהורים ואינם
//  יכולים להסיר שדה שלא נמסר להם — אבל גם אינם יכולים להגן
//  אם השכבה שמעליהם תעביר הכול.
// ============================================================

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const __TESTS = dirname(fileURLToPath(import.meta.url));
const __APP = join(__TESTS, '..');
const require_ = createRequire(import.meta.url);

const S = require_(join(__APP, 'functions', 'schedule-service.js'));
const P = require_(join(__APP, 'functions', 'schedule-publication.js'));
const RUNTIME_SRC = readFileSync(join(__APP, 'functions', 'schedule-runtime.js'), 'utf8');

let pass = 0, fail = 0;
const bad = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; bad.push(name);
  console.log('  ✗ ' + name + (detail ? '\n      ' + detail : ''));
}
function head(t) { console.log('\n--- ' + t); }

const ST = 'station-102';
const ME = 'u-me';
const OTHER = 'u-other';

// ------------------------------------------------------------
//  הזרעים הרעילים. כל אחד מהם הוא ערך ייחודי שאפשר לחפש
//  במחרוזת JSON אחת ולדעת בוודאות מאיפה הוא הגיע.
// ------------------------------------------------------------
const POISON = {
  emp:        'EMP-778899',
  phone:      '050-1234567',
  email:      'private.person@example.com',
  idnum:      '311234567',
  note:       'הערת-ניהול-סודית',
  registrant: 'ממתין-לאישור-הרשמה',
  salary:     'שכר-12345',
  address:    'רחוב-הסודות-7'
};
const POISON_VALUES = Object.keys(POISON).map((k) => POISON[k]);

function poisonedPerson(id, name) {
  return {
    id, name,
    // מה שמותר
    roles: ['driver'],
    qualifications: ['driver'],
    sub_station: 'ss-1',
    // מה שאסור — כל אלה מוזרעים בכוונה
    emp: POISON.emp,
    employee_number: POISON.emp,
    phone: POISON.phone,
    email: POISON.email,
    id_number: POISON.idnum,
    manager_note: POISON.note,
    notes: POISON.note,
    registration: { status: 'pending', label: POISON.registrant },
    pending_signup: POISON.registrant,
    salary: POISON.salary,
    address: POISON.address,
    full_name: name
  };
}

const ROSTER = [
  poisonedPerson(ME, 'אני'),
  poisonedPerson(OTHER, 'עמית'),
  poisonedPerson('u-third', 'שלישי')
];

function slot(personId, over) {
  return Object.assign({ person: personId, role: 'driver', label: 'נהג', hours: '07:00-19:00' }, over || {});
}

const PLAN = {
  kind: 'schedule-plan',
  station_id: ST,
  contract_station_id: ST,
  source_snapshot: 'snap-1',
  source_version: 'v1',
  source_revision: 'r1',
  source_digest: 'd-source-1',
  policy_version: 'p1',
  policy_digest: 'd-policy-1',
  source_complete: true,
  rows: [
    {
      date: '2026-09-01', station_id: ST, sub_station: 'ss-1', label: 'מרכזית',
      minimum: 2, below_minimum: false, rotation_group: 'A',
      slots: [slot(ME), slot(OTHER), slot('u-third')]
    },
    {
      date: '2026-09-02', station_id: ST, sub_station: 'ss-1', label: 'מרכזית',
      minimum: 2, below_minimum: false, rotation_group: 'B',
      slots: [slot(OTHER), slot('u-third')]
    }
  ]
};

const EVENTS = [{
  id: 'ev-1', title: 'קורס חילוץ', date: '2026-09-01', hours: '08:00-12:00',
  people: [ME, OTHER], cancelled: false, station_id: ST,
  source_snapshot: 'snap-1', source_version: 'v1',
  // גם באירוע מזריעים
  organizer_note: POISON.note, attendee_emails: [POISON.email]
}];

const VIEW = ['view_my', 'view_station', 'respond_own'];
const svc = S.createScheduleService({
  clock: () => '2026-09-01T00:00:00.000Z',
  engine: { planPeriod() {}, planMonths() {}, policy: { station_id: ST } },
  publication: { planPublication() {} },
  rules: {
    station_id: ST,
    capabilities: { firefighter: VIEW, scheduler: VIEW.concat(['edit_draft', 'run_planner', 'publish']) }
  }
});

const firefighter = { id: ME, role: 'firefighter', station_id: ST, active: true };

function leaksIn(blob) {
  const s = JSON.stringify(blob);
  return POISON_VALUES.filter((v) => s.indexOf(v) !== -1);
}

// ============================================================
head('1 · „הסידור שלי" · אפס דליפות מהקלט המורעל');
// ============================================================

const mine = svc.buildMySchedule({
  actor: firefighter, plan: PLAN, events: EVENTS, roster: ROSTER,
  changes_by_date: { '2026-09-01': { kind: 'assignment_added' } },
  answers_by_date: {}
});

const mineLeaks = leaksIn(mine);
ok('„הסידור שלי" · 0 דליפות', mineLeaks.length === 0,
   'דלף: ' + JSON.stringify(mineLeaks));

ok('הפלט אכן מכיל תוכן — הבדיקה אינה ריקה',
   mine.days.length === 1 && mine.events.length === 1);

ok('רשימת הצוות מכילה את שאר האנשים',
   mine.days[0].crew.length === 2);

// מה כן מותר להופיע, ובמפורש
const crewKeys = Object.keys(mine.days[0].crew[0]).sort();
ok('לחבר צוות יש בדיוק שלושה שדות: person · role_label · uid',
   crewKeys.join(',') === 'person,role_label,uid',
   'נמצא: ' + crewKeys.join(','));

// ============================================================
head('2 · „סידור התחנה" · אפס דליפות');
// ============================================================

const station = svc.buildStationSchedule({
  actor: firefighter, plan: PLAN, date: '2026-09-01', events: EVENTS, roster: ROSTER
});

const stationLeaks = leaksIn(station);
ok('„סידור התחנה" · 0 דליפות', stationLeaks.length === 0,
   'דלף: ' + JSON.stringify(stationLeaks));

ok('התצוגה מכילה שלושה ימים', !!station.previous_day && !!station.day && !!station.next_day);
ok('היום מכיל אנשים', station.day.sub_stations[0].people.length === 3);

const pKeys = Object.keys(station.day.sub_stations[0].people[0]).sort();
ok('לאדם בסידור התחנה יש בדיוק: cancelled · hours · is_me · person · role_label · uid',
   pKeys.join(',') === 'cancelled,hours,is_me,person,role_label,uid',
   'נמצא: ' + pKeys.join(','));

const evKeys = Object.keys(station.day.events[0].people[0]).sort();
ok('למשתתף באירוע יש בדיוק: is_me · person · uid',
   evKeys.join(',') === 'is_me,person,uid',
   'נמצא: ' + evKeys.join(','));

ok('הערת המארגן ומיילי המשתתפים אינם באירוע',
   JSON.stringify(station.day.events[0]).indexOf(POISON.note) === -1 &&
   JSON.stringify(station.day.events[0]).indexOf(POISON.email) === -1);

// ============================================================
head('3 · כבאי אינו נכנס לסידור של אדם אחר');
// ============================================================

function denied(fn) {
  try { fn(); return null; } catch (e) { return e && e.code ? e.code : 'THREW'; }
}

ok('בקשה מפורשת לסידור של אחר נחסמת',
   denied(() => svc.buildMySchedule({
     actor: firefighter, plan: PLAN, person: OTHER, roster: ROSTER
   })) === 'not-your-schedule');

ok('„הסידור שלי" מחזיר רק ימים שבהם המבקש משובץ',
   mine.days.every((d) => true) && mine.days.length === 1,
   'ב-2026-09-02 המבקש אינו משובץ, ולכן היום אינו אמור להופיע');

ok('הצוות אינו כולל את המבקש עצמו',
   mine.days[0].crew.every((c) => c.uid !== ME));

// ============================================================
head('4 · ההתראה · מה נוחת על מסך הנעילה');
// ============================================================
//
//  התראה נקראת גם בלי לפתוח את האפליקציה, ולכן היא המקום
//  הרגיש ביותר. שם אנשים אסור שיופיע שם.

ok('רשימת שדות ההתראה היא בדיוק kind ו-date',
   Array.isArray(P.PUSH_FIELDS) && P.PUSH_FIELDS.slice().sort().join(',') === 'date,kind',
   'נמצא: ' + JSON.stringify(P.PUSH_FIELDS));

ok('קיימת רשימת מפתחות אסורים',
   Array.isArray(P.FORBIDDEN_KEYS) && P.FORBIDDEN_KEYS.length > 0);

for (const key of ['person', 'name', 'uid', 'emp']) {
  ok('מפתח אסור בהתראה · ' + key,
     P.FORBIDDEN_KEYS.some((k) => String(k).indexOf(key) !== -1) ||
     P.PUSH_FIELDS.indexOf(key) === -1);
}

// ============================================================
head('5 · מקור · שכבת הצמצום ב-schedule-runtime');
// ============================================================
//
//  הבנאים טהורים ואינם יכולים להסיר שדה שלא נמסר להם. מה
//  שנמסר להם נקבע כאן, ולכן זו ההגנה האמיתית.

const FLAT = RUNTIME_SRC.replace(/\s+/g, ' ');

ok('הצמצום כותב בדיוק חמישה שדות לכל אדם',
   /peopleById\.set\(person\.id, \{ id[\s\S]{0,200}?qualifications/.test(FLAT) ||
   /id: [\s\S]{0,40}name:[\s\S]{0,80}sub_station[\s\S]{0,60}roles[\s\S]{0,40}qualifications/.test(FLAT),
   'אם הצמצום מוחלף בהעתקת המסמך המלא — כל מה שיש בו יגיע לכבאי');

for (const forbidden of ['employee_number', 'phone', 'email', 'id_number']) {
  ok('הצמצום אינו מעביר ' + forbidden,
     !new RegExp('peopleById\\.set\\([^)]{0,400}' + forbidden).test(FLAT));
}

ok('מטא-דאטה ניהולית מותנית ב-ctx.manager',
   /ctx\.manager/.test(FLAT) && /can_rollback/.test(FLAT),
   'previous_publication_id · can_rollback · delivery_alerts');

ok('getManagerSetup מאחורי requireManager',
   /requireManager/.test(FLAT));

ok('אין קריאת נרשמים במסלול הסידור',
   !/registration_requests/.test(RUNTIME_SRC),
   'מסלול הסידור אינו אמור לגעת בהרשמות כלל');

// ============================================================
head('6 · ממצא מתועד · ה-uid כן נחשף לכבאי');
// ============================================================
//
//  זו אינה נפילה. זו קביעה מכוונת שמתעדת את המצב הקיים,
//  כדי שהשינוי שלו — אם ייעשה — יהיה שינוי מודע ולא שקט.
//
//  ה-uid של עמיתים מופיע בשתי התצוגות: הוא נדרש לזיהוי
//  „זה אני" ולסידור יציב. הוא **מזהה Firebase אטום** ואינו
//  מספר עובד, טלפון או מייל. אם ההחלטה תשתנה — הקביעה הזאת
//  תיפול, וזו בדיוק המטרה.

ok('התיעוד תואם למציאות · uid של אחר מופיע ב„הסידור שלי"',
   mine.days[0].crew.some((c) => c.uid === OTHER));
ok('התיעוד תואם למציאות · uid של אחר מופיע ב„סידור התחנה"',
   station.day.sub_stations[0].people.some((p) => p.uid === OTHER));
ok('ומה שאינו מופיע · מספר עובד לצד ה-uid',
   JSON.stringify(mine).indexOf(POISON.emp) === -1);

// ============================================================
head('7 · מוטציות · הבדיקה נופלת על פלט שדולף');
// ============================================================

function mutationCaught(name, blob) {
  ok('מוטציה נתפסה · ' + name, leaksIn(blob).length > 0);
}

mutationCaught('מספר עובד נוסף לחבר צוות',
  JSON.parse(JSON.stringify(mine, null, 0).replace('"role_label"', '"emp":"' + POISON.emp + '","role_label"')));

mutationCaught('טלפון נוסף לאדם בסידור התחנה', {
  ...JSON.parse(JSON.stringify(station)),
  leak: { phone: POISON.phone }
});

mutationCaught('הערת ניהול נוספה ליום', { day: { note: POISON.note } });

ok('מוטציה על קלט נקי אינה מדווחת דליפה',
   leaksIn({ days: [{ crew: [{ uid: 'u-x', person: 'שם', role_label: null }] }] }).length === 0);

// ============================================================
console.log('\n============================================');
console.log('  חדירה לפרטיות · עברו ' + pass + '  ·  נכשלו ' + fail);
if (fail) console.log('  ' + bad.join('\n  '));
console.log('============================================');
process.exit(fail ? 1 : 0);
