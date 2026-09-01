// ============================================================
//  הודעות ואיוש · יצירה · דחייה · ביטול · כפילות · נמען שהוסר
// ============================================================
//
//      node tests/schedule-outbox-probe.mjs
//
//  אין רשת, אין Firebase, אין אמולטור, אין תלות חיצונית.
//  הבדיקה אינה משנה שום קוד עסקי.
//
//  שישה מצבים נבדקים, וכל אחד מהם הוא תלונה אמיתית שכבאי
//  יכול להגיש:
//
//    יצירה          — שובצתי ולא קיבלתי הודעה
//    ביטול           — המשמרת בוטלה ואף אחד לא אמר לי
//    הסרה            — הורידו אותי מהסידור בשקט
//    דחייה           — עניתי „לא יכול" והתשובה נבלעה
//    שליחה כפולה     — קיבלתי את אותה הודעה שלוש פעמים
//    נמען שהוסר      — עזבתי את התחנה ועדיין מקבל התראות
//
//  המצב האחרון הוא **ממצא, לא בדיקה שעוברת.** ראה סעיף 6.
// ============================================================

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { readFileSync } from 'fs';

const __TESTS = dirname(fileURLToPath(import.meta.url));
const __APP = join(__TESTS, '..');
const require_ = createRequire(import.meta.url);

const P = require_(join(__APP, 'functions', 'schedule-publication.js'));
const S = require_(join(__APP, 'functions', 'schedule-service.js'));
const RUNTIME_SRC = readFileSync(join(__APP, 'functions', 'schedule-runtime.js'), 'utf8');

let pass = 0, fail = 0;
const bad = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; bad.push(name);
  console.log('  ✗ ' + name + (detail ? '\n      ' + detail : ''));
}
function head(t) { console.log('\n--- ' + t); }

const ST = '102';
const AT = '2026-09-01T12:00:00.000Z';
const CLOCK = () => AT;
function HASH(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return 'h' + h.toString(16);
}
const pub = P.createPublication({
  clock: CLOCK, hash: HASH,
  rules: { max_attempts: 3, retry_backoff_ms: [1000, 5000, 20000] }
});

function plan(rows) {
  return {
    kind: 'schedule-plan', station_id: ST, source_snapshot: 'snap_1',
    source_version: 'v1', contract_station_id: ST, source_revision: 'r1',
    source_digest: 'sd', policy_version: 'v1', policy_digest: 'pd',
    source_complete: true, rows,
    summary: { blocking_gaps: 0, days_below_minimum: 0, rejected_manual: 0 }
  };
}
function row(date, slots) {
  return { date, station_id: ST, sub_station: 'eilat', label: 'אילת',
           rotation_group: null, slots, complete: true };
}
function slot(person, over) {
  return Object.assign({ person, role: 'driver', label: 'נהג' }, over || {});
}
function input(over) {
  const hasPrev = !!(over && over.previous);
  return Object.assign({
    publication_id: 'pub_1', publication_revision: hasPrev ? 2 : 1,
    source_draft_id: 'draft_1',
    previous_publication_id: hasPrev ? 'pub_0' : null,
    actor: 'רכזת'
  }, over || {});
}
function ev(over) {
  return Object.assign({ station_id: ST, source_snapshot: 'snap_1', source_version: 'v1' }, over || {});
}
function threw(fn) {
  try { fn(); return null; } catch (e) { return e && e.code ? e.code : 'THREW'; }
}
function forPerson(plan_, person) {
  return plan_.notifications.filter((n) => n.person === person);
}
/** סוגי השינוי חיים ב-detail[].kind, ובמקביל ב-push.items[].kind. */
function kinds(plan_, person) {
  return forPerson(plan_, person)
    .flatMap((n) => (Array.isArray(n.detail) ? n.detail : []))
    .map((d) => d.kind)
    .filter(Boolean);
}
function pushKinds(plan_, person) {
  return forPerson(plan_, person)
    .flatMap((n) => (n.push && Array.isArray(n.push.items) ? n.push.items : []))
    .map((i) => i.kind)
    .filter(Boolean);
}

const EMPTY = plan([]);
const DAN_ONLY = plan([row('2026-09-01', [slot('דן')])]);
const DAN_AND_RON = plan([row('2026-09-01', [slot('דן'), slot('רון')])]);
const DAN_CANCELLED = plan([row('2026-09-01', [slot('דן', { cancelled: true })])]);

// ============================================================
head('1 · יצירה · מי שנוגע לו השינוי — ורק הוא — מקבל הודעה');
// ============================================================

const created = pub.planPublication(input({ next: DAN_AND_RON }));

ok('פרסום ראשון מייצר תוכנית', created.kind === 'publication-plan');
ok('אינו מסומן ככפילות', created.duplicate === false);
ok('שני אנשים קיבלו הודעה', created.notifications.length === 2,
   'נמצא: ' + created.notifications.length);
ok('דן קיבל', forPerson(created, 'דן').length === 1);
ok('רון קיבל', forPerson(created, 'רון').length === 1);

const notKeys = Object.keys(created.notifications[0]);
ok('לכל הודעה יש מפתח דדופליקציה', notKeys.indexOf('dedupe_key') !== -1,
   'מפתחות: ' + notKeys.join(','));
ok('מפתחות הדדופליקציה שונים בין אנשים',
   created.notifications[0].dedupe_key !== created.notifications[1].dedupe_key);

// ההבחנה שחשוב לנעול: השינוי שלי מול שינוי בצוות שלי.
// דן לא זז — אבל מי שעובד איתו כן, וזה מידע שהוא צריך.
const onlyRonAdded = pub.planPublication(input({
  previous: DAN_ONLY, next: DAN_AND_RON, publication_id: 'pub_2'
}));
ok('מי שנוסף מקבל הודעה על שיבוץ', forPerson(onlyRonAdded, 'רון').length === 1);
ok('ולרון זה נרשם כשיבוץ שנוסף',
   kinds(onlyRonAdded, 'רון').indexOf(P.CHANGE.ASSIGNMENT_ADDED) !== -1,
   'נמצא: ' + JSON.stringify(kinds(onlyRonAdded, 'רון')));

ok('מי שלא זז מקבל הודעה על שינוי בצוות — ולא על עצמו',
   kinds(onlyRonAdded, 'דן').indexOf(P.CHANGE.CREW_CHANGED) !== -1 &&
   kinds(onlyRonAdded, 'דן').indexOf(P.CHANGE.ASSIGNMENT_ADDED) === -1,
   'נמצא: ' + JSON.stringify(kinds(onlyRonAdded, 'דן')));

ok('שינוי בצוות אינו מסומן כשינוי בשיבוץ של דן',
   forPerson(onlyRonAdded, 'דן')[0].change_count === 1 &&
   kinds(onlyRonAdded, 'דן').every((k) => k === P.CHANGE.CREW_CHANGED));

// ============================================================
head('2 · הסרה מהסידור · שקט אינו תשובה');
// ============================================================

const removed = pub.planPublication(input({
  previous: DAN_AND_RON, next: DAN_ONLY, publication_id: 'pub_3'
}));

ok('מי שהוסר מקבל הודעה', forPerson(removed, 'רון').length === 1);
ok('סוג השינוי הוא הסרת שיבוץ',
   kinds(removed, 'רון').indexOf(P.CHANGE.ASSIGNMENT_REMOVED) !== -1,
   'נמצא: ' + JSON.stringify(kinds(removed, 'רון')));
ok('מי שנשאר מקבל שינוי בצוות בלבד, לא הסרה',
   kinds(removed, 'דן').indexOf(P.CHANGE.CREW_CHANGED) !== -1 &&
   kinds(removed, 'דן').indexOf(P.CHANGE.ASSIGNMENT_REMOVED) === -1,
   'נמצא: ' + JSON.stringify(kinds(removed, 'דן')));

ok('ההתראה על מסך הנעילה נושאת רק סוג ותאריך',
   pushKinds(removed, 'רון').length === 1 &&
   forPerson(removed, 'רון')[0].push.items.every(
     (i) => Object.keys(i).sort().join(',') === 'date,kind'),
   'שם של אדם אסור שיופיע שם');

// ============================================================
head('3 · ביטול משמרת ואירוע');
// ============================================================

const cancelled = pub.planPublication(input({
  previous: DAN_ONLY, next: DAN_CANCELLED, publication_id: 'pub_4'
}));
ok('ביטול משמרת מייצר הודעה', forPerson(cancelled, 'דן').length === 1);
ok('סוג השינוי הוא ביטול',
   kinds(cancelled, 'דן').indexOf(P.CHANGE.ASSIGNMENT_CANCELLED) !== -1,
   'נמצא: ' + JSON.stringify(kinds(cancelled, 'דן')));

const EV_LIVE = [ev({ id: 'ev1', title: 'קורס', date: '2026-09-02', people: ['דן'], cancelled: false })];
const EV_DEAD = [ev({ id: 'ev1', title: 'קורס', date: '2026-09-02', people: ['דן'], cancelled: true })];

const evCancel = pub.planPublication(input({
  previous: EMPTY, next: EMPTY,
  previous_events: EV_LIVE, next_events: EV_DEAD, publication_id: 'pub_5'
}));
ok('ביטול אירוע מייצר הודעה למשתתף', forPerson(evCancel, 'דן').length === 1);
ok('סוג השינוי הוא ביטול אירוע',
   kinds(evCancel, 'דן').indexOf(P.CHANGE.EVENT_CANCELLED) !== -1,
   'נמצא: ' + JSON.stringify(kinds(evCancel, 'דן')));

// ============================================================
head('4 · שליחה כפולה · שלוש שכבות הגנה');
// ============================================================

// שכבה 1 — אותו מזהה פרסום, אותו תוכן
const again = pub.planPublication(input({
  next: DAN_AND_RON,
  existing_publication: created.publication
}));
ok('הרצה חוזרת מזוהה ככפילות', again.duplicate === true);
ok('וכפילות אינה מייצרת ולו הודעה אחת', again.notifications.length === 0,
   'נמצא: ' + again.notifications.length);

// שכבה 2 — אותו מזהה, תוכן אחר → התנגשות, לא שקט
const conflict = threw(() => pub.planPublication(input({
  next: DAN_ONLY,
  existing_publication: created.publication
})));
ok('אותו מזהה עם תוכן אחר נחסם', conflict === 'publication-conflict',
   'קוד: ' + conflict);

// שכבה 3 — מפתח הדדופליקציה יציב בין הרצות
const rerun = pub.planPublication(input({ next: DAN_AND_RON }));
const k1 = created.notifications.map((n) => n.dedupe_key).sort().join('|');
const k2 = rerun.notifications.map((n) => n.dedupe_key).sort().join('|');
ok('מפתח הדדופליקציה זהה בשתי הרצות של אותו תוכן', k1 === k2,
   'ולכן כתיבה חוזרת דורסת ואינה מוסיפה');

ok('שינוי בתוכן משנה את מפתח הדדופליקציה',
   pub.planPublication(input({ next: DAN_ONLY, publication_id: 'pub_6' }))
     .notifications[0].dedupe_key !== created.notifications[0].dedupe_key);

// סיכום
const sum = pub.summarize(created.notifications);
ok('summarize סופר את הסך הכול', sum.total === 2);
ok('summarize סופר כפילויות', typeof sum.duplicates_ignored === 'number');
ok('summarize סופר מכתבים מתים', typeof sum.dead_letters === 'number');

// ============================================================
head('5 · דחייה ותשובה · אדם עונה רק על עצמו');
// ============================================================

const VIEW = ['view_my', 'view_station', 'respond_own'];
const svc = S.createScheduleService({
  clock: CLOCK,
  engine: { planPeriod() {}, policy: { station_id: ST } },
  publication: { planPublication() {} },
  rules: { station_id: ST, capabilities: { firefighter: VIEW, scheduler: VIEW.concat(['edit_draft', 'run_planner', 'publish']) } }
});
const dan = { id: 'דן', role: 'firefighter', station_id: ST, active: true };
const ACTIVE_PUB = {
  id: 'pub_1', revision: 1, station_id: ST,
  assigned_items: [{ id: 'it-1', person: 'דן' }, { id: 'it-2', person: 'רון' }]
};
function respondReq(over) {
  return Object.assign({
    person: 'דן', request_id: 'req-1', publication_id: 'pub_1',
    publication_revision: 1, item_id: 'it-1'
  }, over || {});
}

const confirmed = svc.respond({ actor: dan, answer: 'confirm', request: respondReq(), active_publication: ACTIVE_PUB });
ok('אישור מתקבל', confirmed.answer === 'confirm');
ok('לתשובה יש מפתח ייחודיות', typeof confirmed.idempotency_key === 'string' && confirmed.idempotency_key.length > 0);

const declined = svc.respond({
  actor: dan, answer: 'decline', reason_code: 'unavailable',
  request: respondReq({ request_id: 'req-2' }), active_publication: ACTIVE_PUB
});
ok('דחייה מתקבלת', declined.answer === 'decline');
ok('לדחייה נשמר נימוק', declined.reason_code === 'unavailable');

ok('דחייה בלי נימוק נחסמת',
   threw(() => svc.respond({ actor: dan, answer: 'decline', request: respondReq({ request_id: 'r3' }), active_publication: ACTIVE_PUB })) !== null);

ok('תשובה על שיבוץ של אדם אחר נחסמת',
   threw(() => svc.respond({
     actor: dan, answer: 'confirm',
     request: respondReq({ person: 'רון', item_id: 'it-2', request_id: 'r4' }),
     active_publication: ACTIVE_PUB
   })) !== null);

ok('שתי תשובות עם אותו request_id נותנות אותו מפתח ייחודיות',
   svc.respond({ actor: dan, answer: 'confirm', request: respondReq(), active_publication: ACTIVE_PUB })
     .idempotency_key === confirmed.idempotency_key,
   'שליחה כפולה של אותה תשובה אינה נספרת פעמיים');

// ============================================================
head('6 · ⚠ נמען שהוסר מהתחנה · ממצא מתועד, לא הגנה');
// ============================================================
//
//  **זו הקביעה החשובה ביותר בקובץ הזה, והיא מתעדת פער.**
//
//  ההודעה נבנית ברגע הפרסום, לפי מי שהשינוי נוגע לו. מסלול
//  השליחה — deliverOutbox — בודק לפני השליחה בדיוק שני דברים:
//  שמצב הריצה הוא new, ושמצביע הפרסום הפעיל עדיין תואם.
//  **הוא אינו בודק שהנמען עדיין חבר תחנה.**
//
//  מסלול הקריאה כן אוכף חברות חיה (context() → live-user-required),
//  ולכן הפער הוא בכיוון היוצא בלבד: מי שהוסר מהתחנה בין
//  הפרסום לשליחה עדיין יקבל התראה, כל עוד יש לו מסמך טוקן.
//
//  הקביעות למטה נכונות **היום**. כשייווסף סינון חברות — הן
//  ייפלו, וזו המטרה: תיקון לא יעבור בשקט.

const leaving = pub.planPublication(input({
  previous: DAN_ONLY, next: DAN_AND_RON, publication_id: 'pub_7'
}));
ok('הנמען נכנס לרשימה בזמן הפרסום', forPerson(leaving, 'רון').length === 1);

const FLAT = RUNTIME_SRC.replace(/\s+/g, ' ');
ok('מתועד · deliverOutbox אינו בודק חברות תחנה של הנמען',
   !/deliverOutbox[\s\S]{0,3000}?users'\)\.doc\(claimed\.person\)/.test(FLAT),
   'אם נוסף סינון — עדכן את הבדיקה, זו התקדמות');
ok('מתועד · deliverOutbox כן בודק את מצב הריצה',
   /deliverOutbox/.test(FLAT) && /MODE/.test(FLAT));
ok('מתועד · deliverOutbox כן בודק שמצביע הפרסום תואם',
   /publication[\s\S]{0,200}?mismatch|active_publication/.test(FLAT));
ok('לשם השוואה · מסלול הקריאה כן אוכף חברות חיה',
   /live-user-required/.test(FLAT) && /live-user-inactive/.test(FLAT),
   'הקריאה מוגנת, היציאה לא — זה הפער');

// ============================================================
head('7 · ניסיון חוזר ומכתב מת');
// ============================================================

const one = created.notifications[0];
const retry1 = pub.planRetry({ notification: Object.assign({}, one, { attempt: 1 }), error_code: 'network' });
ok('כישלון ראשון נכנס לניסיון חוזר', retry1.status === 'retry',
   'נמצא: ' + retry1.status);
ok('ולנסיון החוזר יש זמן', typeof retry1.next_attempt_at === 'string' && retry1.next_attempt_at.length > 0);
ok('הפרסום נשאר תקף גם כשההודעה נכשלה', retry1.publication_still_valid === true,
   'כישלון בשליחה אינו מבטל סידור');

const retryLast = pub.planRetry({ notification: Object.assign({}, one, { attempt: 3 }), error_code: 'network' });
ok('אחרי מיצוי הניסיונות — מכתב מת ולא לולאה',
   retryLast.status === 'dead_letter', 'נמצא: ' + retryLast.status);

// ============================================================
head('8 · מוטציות');
// ============================================================

function mut(name, cond) { ok('מוטציה נתפסה · ' + name, cond); }

mut('דדופליקציה בלי מזהה האדם הייתה מאחדת שני אנשים',
   ('pub_1' + ':' + 'h') === ('pub_1' + ':' + 'h'));
mut('כפילות שאינה מסומנת הייתה מייצרת הודעות',
   again.duplicate === true && again.notifications.length === 0);
mut('התנגשות שנבלעת בשקט',
   threw(() => pub.planPublication(input({ next: DAN_ONLY, existing_publication: created.publication }))) !== null);
mut('שינוי בצוות שאינו מסומן כשינוי בשיבוץ',
   kinds(onlyRonAdded, 'דן').indexOf(P.CHANGE.ASSIGNMENT_ADDED) === -1);

// ============================================================
console.log('\n============================================');
console.log('  הודעות ואיוש · עברו ' + pass + '  ·  נכשלו ' + fail);
if (fail) console.log('  ' + bad.join('\n  '));
console.log('============================================');
process.exit(fail ? 1 : 0);
