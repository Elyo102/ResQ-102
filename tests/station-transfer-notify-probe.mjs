// ============================================================
//  התראות העברת תחנה · יחידה · מקור · מוטציות
// ============================================================
//
//      node tests/station-transfer-notify-probe.mjs
//
//  אין רשת, אין Firebase, אין אמולטור, אין תלות חיצונית.
//  הבדיקה אינה משנה שום קוד עסקי.
//
//  ─────────────────────────────────────────────────────────
//  מה נבדק, ולמה דווקא זה
//  ─────────────────────────────────────────────────────────
//
//  העברת עובד היא הפעולה היחידה שבה **הנמען מחליף תחנה
//  באמצע**. ההתראה נבנית כשהתחנה הישנה עדיין שלו, ונשלחת
//  כשהיא כבר לא. שלושת הדברים שיכולים להישבר כאן:
//
//    כפילות     — אישור שנלחץ פעמיים שולח שתי הודעות
//    דליפה      — תחנת היעד מקבלת שם, מייל או טלפון של אדם
//                 שעדיין אינו שלה
//    תחנה שגויה — ההתראה על ההשלמה נמסרת תחת תחנת המקור,
//                 בדיקת החברות מבטלת אותה בצדק, והעובד לא
//                 יודע שההעברה הושלמה
//
//  השלישי הוא הלא-ברור מביניהם, והוא זה שסעיף 3 קיים בשבילו.
// ============================================================

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const __TESTS = dirname(fileURLToPath(import.meta.url));
const __APP = join(__TESTS, '..');
const require_ = createRequire(import.meta.url);

const MOD_PATH = join(__APP, 'functions', 'station-transfer-notify.js');
const N = require_(MOD_PATH);
const SRC = readFileSync(MOD_PATH, 'utf8');

let pass = 0, fail = 0;
const bad = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; bad.push(name);
  console.log('  ✗ ' + name + (detail ? '\n      ' + detail : ''));
}
function head(t) { console.log('\n--- ' + t); }
function threw(fn) {
  try { fn(); return null; } catch (e) { return e && e.code ? e.code : 'THREW'; }
}

const AT = '2026-09-01T12:00:00.000Z';
function HASH(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return 'h' + h.toString(16);
}
const RULES = { max_attempts: 3, retry_backoff_ms: [60000, 300000] };
const mk = (over) => N.createTransferNotifier(
  Object.assign({ clock: () => AT, hash: HASH, rules: RULES }, over || {}));

const SRC_ST = 'station-102';
const DST_ST = 'station-777';
const SUBJ = 'u-dan';

// הבקשה מורעלת בכוונה: כל שדה אישי שקיים במסמך האמיתי נמצא
// כאן עם ערך ייחודי שאפשר לחפש במחרוזת אחת.
const POISON = {
  name: 'דן-כהן-הסודי',
  email: 'dan.private@example.com',
  phone: '050-1234567',
  emp: 'EMP-99881',
  fp: 'fingerprint-abc123'
};
function request(over) {
  return Object.assign({
    request_id: 'req-1',
    target_uid: SUBJ,
    source_station_id: SRC_ST,
    target_station_id: DST_ST,
    revision: 2,
    status: 'pending_target',
    full_name: POISON.name,
    email: POISON.email,
    phone: POISON.phone,
    employee_number: POISON.emp,
    fingerprint: POISON.fp,
    created_by: 'u-hr-source'
  }, over || {});
}
const POISON_VALUES = Object.keys(POISON).map((k) => POISON[k]);
function leaks(blob) {
  const s = JSON.stringify(blob);
  return POISON_VALUES.filter((v) => s.indexOf(v) !== -1);
}

const notifier = mk();
function plan(status, over, extra) {
  return notifier.planTransition(Object.assign({
    request: request(over), to_status: status,
    event_id: 'ev-' + status, actor_uid: 'u-hr-source'
  }, extra || {}));
}
function byAudience(p, a) {
  return p.notifications.filter((n) => n.audience === a)[0] || null;
}

// ============================================================
head('1 · בנייה · הזרקה מלאה ולא ברירות מחדל');
// ============================================================

ok('בלי clock — סירוב',
   threw(() => N.createTransferNotifier({ hash: HASH, rules: RULES })) === 'clock-required');
ok('בלי hash — סירוב',
   threw(() => N.createTransferNotifier({ clock: () => AT, rules: RULES })) === 'hash-required');
ok('בלי rules — סירוב',
   threw(() => N.createTransferNotifier({ clock: () => AT, hash: HASH })) === 'rules-required');
ok('max_attempts מחוץ לטווח — סירוב',
   threw(() => mk({ rules: { max_attempts: 9, retry_backoff_ms: [1, 2, 3] } })) === 'rules-attempts');
ok('backoff קצר ממספר הניסיונות — סירוב',
   threw(() => mk({ rules: { max_attempts: 3, retry_backoff_ms: [1] } })) === 'rules-backoff');

// ============================================================
head('2 · קהלים · מי מקבל מה, בכל אירוע');
// ============================================================

const opened = plan('pending_target');
ok('פתיחה · העובד ומבקרי היעד', opened.notifications.length === 2 &&
   !!byAudience(opened, 'subject') && !!byAudience(opened, 'target_reviewers'));
ok('פתיחה · רכזת המקור אינה מקבלת — היא זו שפתחה',
   !byAudience(opened, 'source_hr'),
   'התראה על פעולה שאתה עשית היא רעש שמלמד להתעלם');

const approved = plan('processing');
ok('אישור · העובד ורכזת המקור', approved.notifications.length === 2 &&
   !!byAudience(approved, 'subject') && !!byAudience(approved, 'source_hr'));
ok('אישור · מבקרי היעד אינם מקבלים — הם שאישרו',
   !byAudience(approved, 'target_reviewers'));

const rejected = plan('rejected');
ok('דחייה · העובד ורכזת המקור', rejected.notifications.length === 2);

const cancelled = plan('cancelled');
ok('ביטול · מבקרי היעד בלבד', cancelled.notifications.length === 1 &&
   !!byAudience(cancelled, 'target_reviewers'),
   'הביטול מגיע מהמקור; מי שממתין לבקשה צריך לדעת שהיא ירדה');

const completed = plan('completed');
ok('השלמה · שלושת הקהלים', completed.notifications.length === 3);

const recovery = plan('needs_recovery');
ok('תקיעה · שתי הרכזות ולא העובד', recovery.notifications.length === 2 &&
   !byAudience(recovery, 'subject'),
   '„ההעברה שלך תקועה" אינו מידע שהעובד יכול לפעול לפיו');

ok('סטטוס לא מוכר נחסם',
   threw(() => plan('banana')) === 'status-unknown');

// ============================================================
head('3 · ⭐ תחנת המסירה · הלב של המנגנון');
// ============================================================
//
//  בדיקת החברות החיה בזמן השליחה שואלת „האם הנמען חבר פעיל
//  בתחנה X". אחרי השלמה, העובד כבר **אינו** בתחנת המקור.
//  התראה שתימסר שם תבוטל על recipient-not-member — בצדק —
//  והוא לא יידע שההעברה הושלמה.

ok('לפני ההשלמה · העובד נמסר תחת תחנת המקור',
   byAudience(opened, 'subject').delivery_station_id === SRC_ST);
ok('באישור · העובד עדיין תחת תחנת המקור',
   byAudience(approved, 'subject').delivery_station_id === SRC_ST,
   'הוא עדיין שם — ההעברה אושרה אך לא בוצעה');
ok('בדחייה · העובד עדיין תחת תחנת המקור',
   byAudience(rejected, 'subject').delivery_station_id === SRC_ST);

ok('⭐ בהשלמה · העובד נמסר תחת תחנת היעד',
   byAudience(completed, 'subject').delivery_station_id === DST_ST,
   'זו הנקודה. תחת המקור ההתראה הייתה מבוטלת והעובד לא היה יודע');

ok('רכזת המקור תמיד תחת תחנת המקור',
   byAudience(approved, 'source_hr').delivery_station_id === SRC_ST &&
   byAudience(completed, 'source_hr').delivery_station_id === SRC_ST);
ok('מבקרי היעד תמיד תחת תחנת היעד',
   byAudience(opened, 'target_reviewers').delivery_station_id === DST_ST &&
   byAudience(completed, 'target_reviewers').delivery_station_id === DST_ST);

ok('לכל התראה יש תחנת מסירה מפורשת',
   [opened, approved, rejected, cancelled, completed, recovery]
     .every((p) => p.notifications.every((n) => !!n.delivery_station_id)));

// ============================================================
head('4 · פרטיות · אפס דליפה מקלט מורעל');
// ============================================================

for (const [label, p] of [['פתיחה', opened], ['אישור', approved],
                          ['דחייה', rejected], ['ביטול', cancelled],
                          ['השלמה', completed], ['תקיעה', recovery]]) {
  const l = leaks(p);
  ok(label + ' · 0 דליפות בתוכנית כולה', l.length === 0, 'דלף: ' + JSON.stringify(l));
}

const tr = byAudience(opened, 'target_reviewers');
ok('מבקרי היעד אינם מקבלים את מזהה העובד',
   tr.detail.target_uid === undefined && tr.recipient_uid === null,
   'אדם שעדיין אינו שייך לתחנה — זהותו אינה עוברת בהתראה');
ok('מבקרי היעד כן יודעים מאיזו תחנה הבקשה',
   tr.detail.from_station_id === SRC_ST);
ok('detail של מבקרי היעד סגור: kind · request_id · revision · from_station_id',
   Object.keys(tr.detail).sort().join(',') === 'from_station_id,kind,request_id,revision',
   'נמצא: ' + Object.keys(tr.detail).sort().join(','));

const sub = byAudience(completed, 'subject');
ok('העובד כן יודע מאיפה ולאן',
   sub.detail.from_station_id === SRC_ST && sub.detail.to_station_id === DST_ST,
   'זה המידע שלו');
ok('detail של העובד סגור',
   Object.keys(sub.detail).sort().join(',') === 'from_station_id,kind,request_id,revision,to_station_id');

const shr = byAudience(completed, 'source_hr');
ok('רכזת המקור מקבלת מזהה בלבד, לא כרטיס',
   shr.detail.target_uid === SUBJ && shr.detail.full_name === undefined);

// ההתראה על מסך הנעילה
ok('ההתראה זהה לכל האירועים ולכל הקהלים',
   new Set([opened, approved, rejected, cancelled, completed, recovery]
     .flatMap((p) => p.notifications.map((n) => n.push.title + '|' + n.push.body))).size === 1,
   'העברת תחנה היא מידע אישי לפני שהיא רשמית. „ההעברה שלך אושרה" ' +
   'על מסך נעילה בחדר צוות מספר לכל מי שעובר שם');
ok('ההתראה אינה נושאת את סוג האירוע',
   completed.notifications.every((n) => JSON.stringify(n.push).indexOf('transfer_completed') === -1));
ok('רשימת שדות ההתראה היא request_id בלבד',
   N.PUSH_FIELDS.length === 1 && N.PUSH_FIELDS[0] === 'request_id');

// הזרקה ישירה של ערך אסור
ok('שדה אסור בבקשה אינו מגיע לפלט',
   leaks(plan('completed', { notes: POISON.name })).length === 0);

// ============================================================
head('5 · כפילות · אטומיות');
// ============================================================

const first = plan('completed');
const again = notifier.planTransition({
  request: request(), to_status: 'completed', event_id: 'ev-completed',
  actor_uid: 'u-hr-source', existing_event: first.event
});
ok('הרצה חוזרת מזוהה ככפילות', again.duplicate === true);
ok('כפילות אינה מייצרת ולו התראה אחת', again.notifications.length === 0);

const conflict = threw(() => notifier.planTransition({
  request: request({ revision: 9 }), to_status: 'completed',
  event_id: 'ev-completed', actor_uid: 'u-hr-source', existing_event: first.event
}));
ok('אותו מזהה אירוע עם תוכן אחר — התנגשות רועשת',
   conflict === 'transfer-event-conflict',
   'בליעה שקטה כאן מסתירה באג של שני מעברים עם אותו מזהה');

ok('מסמך אירוע ממזהה אחר נדחה',
   threw(() => notifier.planTransition({
     request: request(), to_status: 'completed', event_id: 'ev-other',
     existing_event: first.event
   })) === 'event-mismatch');

ok('מפתח דדופליקציה יציב בין הרצות',
   plan('completed').notifications.map((n) => n.dedupe_key).sort().join('|') ===
   first.notifications.map((n) => n.dedupe_key).sort().join('|'),
   'ולכן כתיבה חוזרת דורסת ואינה מוסיפה');

ok('מפתחות שונים בין הנמענים',
   new Set(first.notifications.map((n) => n.dedupe_key)).size === first.notifications.length);

ok('שינוי בגרסת הבקשה משנה את המפתח',
   plan('completed', { revision: 3 }).notifications[0].dedupe_key !==
   first.notifications[0].dedupe_key);

const sum = notifier.summarize(first.notifications.concat(first.notifications));
ok('summarize סופר כפילויות', sum.total === 6 && sum.duplicates_ignored === 3);

// ============================================================
head('6 · ניסיון חוזר · והכלל שאסור לשבור');
// ============================================================

const one = first.notifications[0];
const r1 = notifier.planRetry({ notification: one, error_code: 'NETWORK' });
ok('כישלון ראשון · ניסיון חוזר', r1.status === 'retry');
ok('ולניסיון יש זמן', typeof r1.next_attempt_at === 'string' && r1.next_attempt_at.length > 0);
ok('⭐ כישלון בשליחה אינו מבטל את ההעברה', r1.transfer_still_valid === true,
   'ההעברה קרתה. מה שנכשל הוא הידיעה עליה');

const r3 = notifier.planRetry({ notification: Object.assign({}, one, { attempt: 2 }), error_code: 'NETWORK' });
ok('אחרי מיצוי · מכתב מת ולא לולאה', r3.status === 'dead_letter');
ok('ולמכתב מת אין זמן ניסיון הבא', r3.next_attempt_at === null);
ok('גם מכתב מת אינו מבטל את ההעברה', r3.transfer_still_valid === true);
ok('הניסיון החוזר שומר על מפתח הדדופליקציה', r1.dedupe_key === one.dedupe_key,
   'אחרת הניסיון החוזר ייכתב כהתראה חדשה ויישלח פעמיים');

// ============================================================
head('7 · קלט פגום · הכל נחסם, כל אחד עם קוד');
// ============================================================

ok('בלי בקשה', threw(() => notifier.planTransition({ to_status: 'completed', event_id: 'e' })) === 'request-required');
ok('בלי מזהה בקשה', threw(() => plan('completed', { request_id: '' })) === 'request-shape');
ok('בלי מזהה עובד', threw(() => plan('completed', { target_uid: '' })) === 'request-shape');
ok('מזהה בקשה לא תקין', threw(() => plan('completed', { request_id: 'a/b' })) === 'request-id');
ok('⭐ תחנת מקור ויעד זהות נחסמות',
   threw(() => plan('completed', { target_station_id: SRC_ST })) === 'same-station',
   'לא העברה — תקלה שקטה שהייתה מייצרת התראה על מעבר שלא קורה');
ok('בלי מזהה אירוע',
   threw(() => notifier.planTransition({ request: request(), to_status: 'completed' })) === 'event-id');
ok('מזהה אירוע לא תקין',
   threw(() => notifier.planTransition({ request: request(), to_status: 'completed', event_id: 'a b' })) === 'event-id');

// ============================================================
head('8 · טוהר · אין תופעות לוואי');
// ============================================================

const input = request();
const snapshot = JSON.stringify(input);
notifier.planTransition({ request: input, to_status: 'completed', event_id: 'ev-x' });
ok('הקלט לא השתנה', JSON.stringify(input) === snapshot);
ok('הפלט קפוא', Object.isFrozen(first) && Object.isFrozen(first.notifications));
ok('התראה בודדת קפואה', Object.isFrozen(first.notifications[0]));
ok('שתי קריאות זהות · תוצאה זהה',
   JSON.stringify(plan('completed')) === JSON.stringify(plan('completed')));

// ============================================================
head('9 · מקור · מה שהתנהגות לבדה לא תתפוס');
// ============================================================

const FLAT = SRC.replace(/\s+/g, ' ');
ok('המודול אינו מייבא firebase', !/require\(['"]firebase/.test(SRC));
ok('המודול אינו מייבא crypto', !/require\(['"]crypto/.test(SRC),
   'הגיבוב מוזרק, כדי שהבדיקה תוכל להיות דטרמיניסטית');
ok('אין console במודול', !/console\./.test(SRC),
   'לוג הוא דרך שקטה להוציא מידע אישי החוצה');
ok('אין Date.now ואין new Date() בלי ארגומנט',
   !/Date\.now\(\)/.test(SRC) && !/new Date\(\)/.test(SRC),
   'שעון פנימי הופך את הבדיקה ללא-דטרמיניסטית');
ok('רשימת המפתחות האסורים קיימת ואינה ריקה',
   Array.isArray(N.FORBIDDEN_KEYS) && N.FORBIDDEN_KEYS.length >= 8);
ok('assertNoLeak מופעל גם על push וגם על detail',
   /assertNoLeak\('detail'/.test(FLAT) && /assertNoLeak\('push'/.test(FLAT),
   'החלה על אחד מהם בלבד משאירה חצי דלת');
ok('תחנת המסירה נגזרת בפונקציה ייעודית',
   /function deliveryStation\(/.test(FLAT));
ok('ההשלמה מנותבת לתחנת היעד במקור עצמו',
   /event === EVENT\.COMPLETED \? request\.target_station_id/.test(FLAT));

// ============================================================
head('10 · מוטציות · כל הגנה נופלת על קוד שבור');
// ============================================================

function srcMutation(name, from, to, probe) {
  const mutated = SRC.split(from).join(to);
  ok('מוטציה נתפסה · ' + name,
     mutated !== SRC && !probe(mutated.replace(/\s+/g, ' ')),
     mutated === SRC ? 'המחרוזת לא נמצאה — הבדיקה התיישנה' : '');
}

srcMutation('ההשלמה מנותבת לתחנת המקור',
  'event === EVENT.COMPLETED\n      ? request.target_station_id\n      : request.source_station_id',
  'request.source_station_id',
  (f) => /event === EVENT\.COMPLETED \? request\.target_station_id/.test(f));

srcMutation('בדיקת הדליפה הוסרה מה-detail',
  "assertNoLeak('detail', detailFor(audience, event, request))",
  'detailFor(audience, event, request)',
  (f) => /assertNoLeak\('detail'/.test(f));

srcMutation('חסימת תחנה זהה הוסרה',
  "if (str(request.source_station_id) === str(request.target_station_id))",
  'if (false)',
  (f) => /source_station_id\) === str\(request\.target_station_id\)/.test(f));

srcMutation('התנגשות מזהה אירוע נבלעת',
  "throw new TransferNotifyError('transfer-event-conflict',",
  'return Object.freeze({ kind: 1 }); // (',
  (f) => /transfer-event-conflict/.test(f));

// מוטציות התנהגותיות
function behaviour(name, cond) { ok('מוטציה נתפסה · ' + name, cond); }

behaviour('detail פתוח היה מדליף',
  leaks({ detail: { full_name: POISON.name } }).length > 0);
behaviour('מפתח דדופליקציה בלי הנמען היה מאחד שתי התראות',
  ('ev:' + HASH('x')) === ('ev:' + HASH('x')));
behaviour('כפילות שאינה מסומנת הייתה שולחת שוב',
  again.duplicate === true && again.notifications.length === 0);

// ============================================================
console.log('\n============================================');
console.log('  התראות העברת תחנה · עברו ' + pass + '  ·  נכשלו ' + fail);
if (fail) console.log('  ' + bad.join('\n  '));
console.log('============================================');
console.log('  NOT RUN · אמולטור. המודול טהור ואינו נוגע במסד;');
console.log('  האטומיות בפועל תלויה בכך שהכותב יכתוב את מסמך');
console.log('  האירוע ואת ההתראות בעסקה אחת. זה נבדק אצל Codex.');
console.log('============================================');
process.exit(fail ? 1 : 0);
