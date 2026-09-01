// בדיקה עצמאית · schedule-placement + schedule-coverage
//
// יחידה · מקור · מוטציות.
//
// „מקור" כאן אינו קישוט. שני המודולים בנויים על התנהגות של
// schedule-calendar-engine.js שאיש לא הבטיח שתישאר: הדחייה
// החוצה-תחנתית, המחזוריות הקשיחה, המנוחה, והשדה `required`
// בכל חוסר. אם קודקס ישנה שם משהו, המודולים כאן ימשיכו לרוץ
// ויחזירו תשובות שגויות בשקט. הטענות על המקור הופכות את זה
// לכשל רועש.
//
// יציאה: 0 עבר · 1 נפל · 2 לא רץ.

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __TESTS = dirname(fileURLToPath(import.meta.url));
const __APP = join(__TESTS, '..');
const FN = join(__APP, 'functions');
const require_ = createRequire(import.meta.url);

const placementPath = join(FN, 'schedule-placement.js');
const coveragePath = join(FN, 'schedule-coverage.js');
const enginePath = join(FN, 'schedule-calendar-engine.js');

for (const p of [placementPath, coveragePath, enginePath]) {
  if (!fs.existsSync(p)) {
    console.log('NOT RUN — חסר ' + path.basename(p));
    process.exit(2);
  }
}

const P = require_(placementPath);
const C = require_(coveragePath);
const engineSrc = fs.readFileSync(enginePath, 'utf8');

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass += 1; return; }
  fail += 1;
  failures.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want),
    'קיבלתי ' + JSON.stringify(got) + ' במקום ' + JSON.stringify(want));
}
function throws(name, fn, code) {
  try { fn(); ok(name, false, 'לא נזרקה שגיאה'); }
  catch (e) { ok(name, e.code === code, 'קוד ' + e.code + ' במקום ' + code); }
}

const CLOCK = () => Date.UTC(2026, 8, 1, 6, 0, 0);   // 1.9.2026

/* ============================ מדיניות ============================ */

// שלוש קבוצות, שלושה ימים לקבוצה — מחזור של תשעה ימים.
// עוגן 1.9.2026 → א' תורנית ב-1,2,3 · 10,11,12 · 19,20,21 · 28,29,30
const POLICY = {
  station_id: 'station-102',
  min_gap_days: 1,
  max_shifts_per_month: 10,
  rotation: { groups: ['a', 'b', 'c'], anchor: '2026-09-01',
              days_per_group: 3, strict: true },
  sub_stations: {
    rashit: { label: 'ראשית', minimum: 4, requirements: [
      { role: 'officer', label: 'קצין', count: 1, required: true },
      { role: 'driver', label: 'נהג', count: 1, required: true },
      { role: 'crew_lead', label: 'מפקד צוות', count: 1, required: true },
      { role: 'hazmat', label: 'חומ״ס', count: 1, required: false }
    ] },
    yotvata: { label: 'יטבתה', minimum: 2, requirements: [
      { role: 'driver', label: 'נהג', count: 1, required: true },
      { role: 'monitor', label: 'ניטור', count: 1, required: true }
    ] },
    timna: { label: 'תמנע', minimum: 2, requirements: [
      { role: 'driver', label: 'נהג', count: 1, required: true },
      { role: 'crew_lead', label: 'מפקד צוות', count: 1, required: true }
    ] }
  }
};

const ROSTER = [
  { id: 'uid-eldad', sub_station: 'rashit', group: 'a', active: true,
    roles: ['driver', 'crew_lead'] },
  { id: 'uid-noa', sub_station: 'yotvata', group: 'b', active: true,
    roles: ['driver', 'monitor'] },
  { id: 'uid-ron', sub_station: 'rashit', group: 'a', active: false,
    roles: ['officer'] },
  { id: 'uid.dotted', sub_station: 'rashit', group: 'c', active: true,
    roles: ['officer'] }
];

const planner = P.createPlacementPlanner({ clock: CLOCK });

function plan(overrides) {
  return planner.planPlacement({
    policy: POLICY,
    roster: ROSTER,
    request: Object.assign({
      subject: { kind: 'member', person: 'uid-eldad' },
      sub_station: 'rashit',
      role: null,
      span: { kind: 'week' },
      anchor_date: '2026-09-01',
      actor_uid: 'uid-manager',
      request_id: 'req-1'
    }, overrides || {})
  });
}

/* ---------------------- 1 · מחזוריות ---------------------- */
{
  const rot = { groups: ['a','b','c'], anchorDay: P.toDayNumber('2026-09-01','x'),
                daysPerGroup: 3, strict: true };
  eq('1.1 עוגן שייך לקבוצה הראשונה',
    P.groupOfDay(rot, P.toDayNumber('2026-09-01','x')), 'a');
  eq('1.2 יום רביעי עובר לקבוצה השנייה',
    P.groupOfDay(rot, P.toDayNumber('2026-09-04','x')), 'b');
  eq('1.3 המחזור חוזר אחרי תשעה ימים',
    P.groupOfDay(rot, P.toDayNumber('2026-09-10','x')), 'a');
  // לפני העוגן. מודולו שלילי הוא הבאג הקלאסי כאן.
  eq('1.4 יום לפני העוגן אינו נופל לקבוצה שגויה',
    P.groupOfDay(rot, P.toDayNumber('2026-08-31','x')), 'c');
  eq('1.5 ארבעה עשר ימים לפני העוגן — לא תחילת מחזור',
    P.groupOfDay(rot, P.toDayNumber('2026-08-18','x')), 'b');
  eq('1.6 שני מחזורים שלמים אחורה חוזרים לקבוצה הראשונה',
    P.groupOfDay(rot, P.toDayNumber('2026-08-14','x')), 'a');
}

/* ---------------------- 2 · הטווח ---------------------- */
{
  const r = plan({ span: { kind: 'single_shift' } });
  eq('2.1 משמרת אחת = יום אחד', r.span.dates, ['2026-09-01']);
  eq('2.2 והיא נספרת לפי המחזור', r.span.counted_by, 'shift_cycle');

  const w = plan({ span: { kind: 'week' } });
  eq('2.3 שבוע = רק ימי המשמרת שלו בשבעת הימים',
    w.span.dates, ['2026-09-01','2026-09-02','2026-09-03']);
  ok('2.4 שבוע אינו שבעה ימים קלנדריים', w.span.dates.length !== 7);

  const f = plan({ span: { kind: 'fortnight' } });
  eq('2.5 שבועיים תופסים את המחזור הבא',
    f.span.dates, ['2026-09-01','2026-09-02','2026-09-03',
                   '2026-09-10','2026-09-11','2026-09-12']);

  const m = plan({ span: { kind: 'month' } });
  eq('2.6 חודש שלם עד סוף החודש הקלנדרי',
    m.span.dates, ['2026-09-01','2026-09-02','2026-09-03',
                   '2026-09-10','2026-09-11','2026-09-12',
                   '2026-09-19','2026-09-20','2026-09-21',
                   '2026-09-28','2026-09-29','2026-09-30']);
  eq('2.7 החודש נגמר ב-30.9 ולא גולש לאוקטובר', m.span.to, '2026-09-30');

  // עוגן באמצע החודש. הטווח אינו חוזר אחורה.
  const mid = plan({ span: { kind: 'month' }, anchor_date: '2026-09-20' });
  eq('2.8 חודש מתאריך באמצע מתחיל ממנו',
    mid.span.dates, ['2026-09-20','2026-09-21','2026-09-28','2026-09-29','2026-09-30']);

  // אדם מקבוצה c — אין לו ולו יום אחד בטווח „משמרת אחת" מ-1.9?
  // יש: 7.9. הטווח היומי היחיד מ-1.9 הוא 1.9, שאינו שלו.
  throws('2.9 טווח בלי ולו יום אחד של האדם נופל רועש',
    () => planner.planPlacement({
      policy: POLICY, roster: ROSTER,
      request: { subject: { kind: 'member', person: 'uid.dotted' },
                 sub_station: 'rashit', span: { kind: 'single_shift' },
                 anchor_date: '2026-09-01' }
    }), P.CODE.NO_MATCHING_DAYS);

  throws('2.10 טווח לא מוכר נדחה',
    () => plan({ span: { kind: 'quarter' } }), P.CODE.SPAN_UNKNOWN);
}

/* ------------------- 3 · הצבה בתחנה אחרת ⭐ ------------------- */
{
  // אלדד משויך לראשית. „שבץ אותו ביטבתה לשבוע" — אותה משמרת,
  // תחנה פיזית אחרת. זו הפעולה שאלדד ביקש.
  const p = plan({ sub_station: 'yotvata', role: 'driver' });

  eq('3.1 ההצבה מתוכננת במלואה', p.span.dates,
    ['2026-09-01','2026-09-02','2026-09-03']);
  eq('3.2 והשורות מכוונות לתחנת היעד',
    p.overrides.map(o => o.sub_station), ['yotvata','yotvata','yotvata']);
  ok('3.3 ההצבה מסומנת ככזו', p.posting !== null);
  eq('3.4 מתחנת הבית לתחנת היעד',
    [p.posting.from, p.posting.to], ['rashit','yotvata']);

  eq('3.5 ⭐ המנוע אינו יכול לקבל אותה היום',
    p.posting.engine_accepts_today, false);
  eq('3.6 ⭐ והתכנון מסומן חסום', p.blocked, true);
  ok('3.7 עם אזהרה חוסמת שמסבירה למה',
    p.warnings.some(w => w.code === P.WARN.POSTING_NEEDS_ENGINE && w.blocking === true));

  eq('3.8 ⭐ המפה שהמנוע צריך, uid → תאריך → תחנה',
    p.posting_map, { 'uid-eldad': { '2026-09-01':'yotvata',
      '2026-09-02':'yotvata', '2026-09-03':'yotvata' } });

  eq('3.9 ⭐ והימים שתחנת הבית מאבדת',
    p.vacates.map(v => v.date + '/' + v.sub_station),
    ['2026-09-01/rashit','2026-09-02/rashit','2026-09-03/rashit']);
  ok('3.10 עם אזהרה שאינה חוסמת על תקן תחנת הבית',
    p.warnings.some(w => w.code === P.WARN.POSTING_VACATES_HOME && w.blocking === false));

  // אימות התפקיד הוא מול תקן תחנת **היעד**, לא תחנת הבית.
  throws('3.11 ⭐ תפקיד שאינו בתקן היעד נדחה, גם אם הוא בתקן הבית',
    () => plan({ sub_station: 'yotvata', role: 'crew_lead' }),
    P.CODE.ROLE_NOT_IN_STANDARD);
  ok('3.12 ו-crew_lead אכן בתקן הבית',
    POLICY.sub_stations.rashit.requirements.some(r => r.role === 'crew_lead'));

  // שיבוץ בתחנת הבית עצמה אינו הצבה, ואינו חסום.
  const home = plan({ sub_station: 'rashit', role: 'driver' });
  eq('3.13 שיבוץ בתחנת הבית אינו הצבה', home.posting, null);
  eq('3.14 ואינו חסום', home.blocked, false);
  eq('3.15 ואינו מפנה דבר', home.vacates, []);

  throws('3.16 תחנת יעד שאינה בתקן נדחית',
    () => plan({ sub_station: 'nowhere' }), P.CODE.SUB_STATION_UNKNOWN);

  // אותו אדם, אותה משמרת, תמנע במקום יטבתה — כדי שברור שההצבה
  // אינה תלויה בתחנה מסוימת.
  const t = plan({ sub_station: 'timna', role: 'crew_lead' });
  eq('3.17 הצבה בתמנע מתנהגת זהה', t.posting.to, 'timna');
  eq('3.18 והתפקיד שבתקן תמנע עובר', t.overrides[0].role, 'crew_lead');
}

/* ---------------------- 4 · תפקידים ---------------------- */
{
  const r = plan({ role: 'driver' });
  eq('4.1 תפקיד שנבחר נשמר בכל שורה',
    r.overrides.map(o => o.role), ['driver','driver','driver']);

  throws('4.2 תפקיד שאינו בתקן של תחנת היעד נדחה',
    () => plan({ role: 'monitor' }), P.CODE.ROLE_NOT_IN_STANDARD);

  throws('4.3 „ידני" אינו „פטור מכשירות"',
    () => plan({ role: 'officer' }), P.CODE.ROLE_NOT_HELD);

  const none = plan({ role: null });
  ok('4.4 בלי תפקיד נרשמת אזהרה ולא הכרעה שקטה',
    none.warnings.some(w => w.code === P.WARN.ROLE_UNSPECIFIED));
  eq('4.5 ובשורות התפקיד null', none.overrides[0].role, null);
}

/* ------------------- 5 · אדם, פעיל, זהות ------------------- */
{
  throws('5.1 אדם שאינו בסגל נדחה',
    () => plan({ subject: { kind: 'member', person: 'uid-ghost' } }),
    P.CODE.PERSON_UNKNOWN);

  throws('5.2 אדם לא פעיל נדחה',
    () => plan({ subject: { kind: 'member', person: 'uid-ron' } }),
    P.CODE.PERSON_INACTIVE);

  // uid עם נקודה. הבאג הזה כבר תפס אותנו פעמיים במקום אחר.
  const dotted = planner.planPlacement({
    policy: POLICY, roster: ROSTER,
    request: { subject: { kind: 'member', person: 'uid.dotted' },
               sub_station: 'rashit', role: 'officer',
               span: { kind: 'single_shift' }, anchor_date: '2026-09-07' }
  });
  eq('5.3 uid עם נקודה נשמר כמו שהוא',
    dotted.overrides[0].person, 'uid.dotted');
  eq('5.4 ובתאריך הנכון', dotted.span.dates, ['2026-09-07']);
}

/* ---------------------- 6 · אורח ---------------------- */
{
  const g = planner.planPlacement({
    policy: POLICY, roster: ROSTER,
    request: { subject: { kind: 'guest', display_name: 'מתנדב מתחנת ערד' },
               sub_station: 'rashit', span: { kind: 'week' },
               anchor_date: '2026-09-01' }
  });
  eq('6.1 אורח אינו מייצר ולו שורת שיבוץ אחת', g.overrides, []);
  ok('6.2 אורח מקבל שורת תצוגה נפרדת', g.guest !== null);
  eq('6.3 ⭐ אורח אינו נספר בתקן', g.guest.counts_toward_minimum, false);
  eq('6.4 ואינו מקבל התראות', g.guest.notifiable, false);
  ok('6.5 והעובדה הזו נאמרת ולא נבלעת',
    g.warnings.some(w => w.code === P.WARN.GUEST_NOT_COUNTED));
  eq('6.6 אורח נספר קלנדרית כי אין לו מחזור', g.span.counted_by, 'calendar');
  eq('6.7 ואין לו uid באודיט', g.audit.subject, null);

  throws('6.8 אורח בלי שם נדחה',
    () => planner.planPlacement({ policy: POLICY, roster: ROSTER,
      request: { subject: { kind: 'guest', display_name: '   ' },
                 sub_station: 'rashit', span: { kind: 'week' },
                 anchor_date: '2026-09-01' } }), P.CODE.GUEST_NAME);

  throws('6.9 אורח שנושא uid הוא בקשה מבולבלת ולא מוכרעת בשקט',
    () => planner.planPlacement({ policy: POLICY, roster: ROSTER,
      request: { subject: { kind: 'guest', display_name: 'דני', person: 'uid-eldad' },
                 sub_station: 'rashit', span: { kind: 'week' },
                 anchor_date: '2026-09-01' } }), P.CODE.SHAPE);
}

/* ---------------------- 7 · אזהרות ---------------------- */
{
  // ימים 1,2,3 צמודים. min_gap_days=1 → 2 ו-3 יידחו במנוע.
  const w = plan({ span: { kind: 'week' } });
  const rest = w.warnings.filter(x => x.code === P.WARN.REST_GAP);
  eq('7.1 ⭐ ימים צמודים מתחת למנוחה מייצרים אזהרה לכל אחד', rest.length, 2);

  const cap = planner.planPlacement({
    policy: POLICY, roster: ROSTER, existing_load: { 'uid-eldad': 9 },
    request: { subject: { kind: 'member', person: 'uid-eldad' },
               sub_station: 'rashit', span: { kind: 'week' },
               anchor_date: '2026-09-01' }
  });
  ok('7.2 ⭐ חריגה מתקרת המשמרות מוזהרת כאן, כי המנוע לא מסמן אותה על ידני',
    cap.warnings.some(x => x.code === P.WARN.OVER_MONTHLY_CAP));

  const under = planner.planPlacement({
    policy: POLICY, roster: ROSTER, existing_load: { 'uid-eldad': 2 },
    request: { subject: { kind: 'member', person: 'uid-eldad' },
               sub_station: 'rashit', span: { kind: 'week' },
               anchor_date: '2026-09-01' }
  });
  ok('7.3 ובלי חריגה אין אזהרה',
    !under.warnings.some(x => x.code === P.WARN.OVER_MONTHLY_CAP));
}

/* ------------------ 8 · יציבות ומדיניות ------------------ */
{
  const a = plan({});
  const b = plan({});
  eq('8.1 אותה בקשה נותנת אותן שורות', a.overrides, b.overrides);

  const sorted = a.overrides.map(o => o.date);
  eq('8.2 השורות ממוינות', sorted, sorted.slice().sort());

  throws('8.3 מדיניות בלי min_gap_days נדחית',
    () => planner.planPlacement({
      policy: Object.assign({}, POLICY, { min_gap_days: undefined }),
      roster: ROSTER, request: { subject:{kind:'member',person:'uid-eldad'},
        sub_station:'rashit', span:{kind:'week'}, anchor_date:'2026-09-01' } }),
    P.CODE.SHAPE);

  throws('8.4 מדיניות בלי הצהרה על תקרה נדחית',
    () => { const p = Object.assign({}, POLICY); delete p.max_shifts_per_month;
      planner.planPlacement({ policy: p, roster: ROSTER,
        request: { subject:{kind:'member',person:'uid-eldad'},
          sub_station:'rashit', span:{kind:'week'}, anchor_date:'2026-09-01' } }); },
    P.CODE.SHAPE);

  throws('8.5 תאריך שאינו קיים נדחה', () => P.toDayNumber('2026-09-31', 'x'), P.CODE.SHAPE);
  throws('8.6 תאריך לא תקין נדחה', () => P.toDayNumber('01/09/2026', 'x'), P.CODE.SHAPE);
  eq('8.7 סוף פברואר בשנה מעוברת', P.fromDayNumber(P.lastDayOfMonth('2028-02-05')), '2028-02-29');
  eq('8.8 וסוף דצמבר גולש לשנה הבאה נכון',
    P.fromDayNumber(P.lastDayOfMonth('2026-12-05')), '2026-12-31');

  throws('8.9 בלי clock אין מתכנן',
    () => P.createPlacementPlanner({}), P.CODE.SHAPE);
}

/* ================= 9 · גשר הכשירויות ================= */
{
  const m = C.mapQualifications({
    quals: [ { id: 'q_driver', name: 'נהג', active: true },
             { id: 'q_officer', name: 'קצין', active: true },
             { id: 'q_hazmat', name: 'חומ״ס', active: true },
             { id: 'q_old', name: 'כשירות שבוטלה', active: false } ],
    member_quals: {
      'uid-eldad': { quals: ['q_driver', 'q_old'] },
      'uid.dotted': { quals: ['q_officer', 'q_hazmat'] },
      'uid-noa': { quals: ['q_unknown'] }
    },
    role_map: { q_driver: 'driver', q_officer: 'officer', q_hazmat: 'hazmat' },
    policy_roles: ['officer', 'driver', 'crew_lead', 'hazmat']
  });

  eq('9.1 כשירות נקשרת לתפקיד מנוע', m.people['uid-eldad'], ['driver']);
  eq('9.2 כשירות מבוטלת אינה נספרת', m.people['uid-eldad'].indexOf('q_old'), -1);
  eq('9.3 uid עם נקודה נשמר', m.people['uid.dotted'], ['hazmat','officer']);
  eq('9.4 כשירות שאינה בקטלוג אינה יוצרת תפקיד', m.people['uid-noa'], []);
  eq('9.5 ⭐ תפקיד בתקן שאין אליו כשירות מדווח',
    m.roles_without_qual, ['crew_lead']);
  eq('9.6 כשירות שלא מופתה מדווחת', m.unmapped_quals, ['q_old']);

  const bad = C.mapQualifications({
    quals: [{ id: 'q_x', name: 'X', active: true }],
    member_quals: {},
    role_map: { q_x: 'not_a_role', q_gone: 'driver' },
    policy_roles: ['driver']
  });
  eq('9.7 מיפוי לתפקיד שאינו בתקן מדווח',
    bad.invalid_map_entries.some(e => e.qual === 'q_x'), true);
  eq('9.8 מיפוי לכשירות שנמחקה מדווח',
    bad.invalid_map_entries.some(e => e.qual === 'q_gone' && e.reason === 'qual-unknown'),
    true);

  try { C.mapQualifications({ quals: [], member_quals: {}, role_map: {}, policy_roles: [] });
    ok('9.9 בלי תפקידי תקן אין מיפוי', false, 'לא נזרקה שגיאה'); }
  catch (e) { ok('9.9 בלי תפקידי תקן אין מיפוי', e.code === 'policy-roles-required'); }
}

/* ================= 10 · דוח החוסרים ================= */
const ROWS = [
  { date: '2026-09-01', sub_station: 'rashit', label: 'ראשית', minimum: 4,
    slots: [{person:'a'},{person:'b'},{person:'c'},{person:'d'}],
    gaps: [], rejected_manual: [], below_minimum: false, complete: true },
  { date: '2026-09-02', sub_station: 'rashit', label: 'ראשית', minimum: 4,
    slots: [{person:'a'},{person:'b'},{person:'c'}],
    gaps: [{ role:'driver', label:'נהג', required:true,
             reasons:[{code:'no-qualified',count:2}] }],
    rejected_manual: [], below_minimum: true, complete: false },
  { date: '2026-09-03', sub_station: 'rashit', label: 'ראשית', minimum: 4,
    slots: [{person:'a'},{person:'b'},{person:'c'},{person:'d'}],
    gaps: [{ role:'hazmat', label:'חומ״ס', required:false, reasons:[] }],
    rejected_manual: [], below_minimum: false, complete: false },
  { date: '2026-09-02', sub_station: 'yotvata', label: 'יטבתה', minimum: 2,
    slots: [{person:'e'},{person:'f'}],
    gaps: [],
    rejected_manual: [{ person:'uid-eldad', code:'out-of-sub-station' }],
    below_minimum: false, complete: false },
  { date: '2026-09-04', sub_station: 'rashit', label: 'ראשית', minimum: 4,
    slots: [{person:'a'},{person:'b'}],
    gaps: [{ role:'driver', label:'נהג', required:true, reasons:[] },
           { role:'officer', label:'קצין', required:true, reasons:[] }],
    rejected_manual: [], below_minimum: true, complete: false }
];
{
  const r = C.reviewCoverage({ rows: ROWS }, CLOCK);

  eq('10.1 יום תקין מסומן ok',
    r.days.filter(d => d.date === '2026-09-01')[0].severity, 'ok');
  eq('10.2 חוסר כשירות חובה חוסם',
    r.days.filter(d => d.date === '2026-09-02' && d.sub_station === 'rashit')[0].severity,
    'blocking');
  eq('10.3 חוסר כשירות רצויה אינו חוסם',
    r.days.filter(d => d.date === '2026-09-03')[0].severity, 'soft');
  eq('10.4 ⭐ שיבוץ ידני שנדחה מקבל חומרה משלו',
    r.days.filter(d => d.sub_station === 'yotvata')[0].severity, 'rejected');
  eq('10.5 ⭐ והדחייה נחשפת עם הקוד שלה',
    r.days.filter(d => d.sub_station === 'yotvata')[0].rejected_manual,
    [{ person:'uid-eldad', code:'out-of-sub-station' }]);

  const driver = r.by_role.filter(x => x.role === 'driver')[0];
  eq('10.6 ⭐ הגלגול סופר את הימים ולא את השורות', driver.required_days, 2);
  eq('10.7 והדוח ממוין לפי חומרה', r.by_role[0].role, 'driver');
  eq('10.8 חוסר רצוי נספר בנפרד',
    r.by_role.filter(x => x.role === 'hazmat')[0].optional_days, 1);

  eq('10.9 סיכום הימים נכון',
    r.totals, { rows: 5, blocking_days: 2, below_minimum_days: 0,
                rejected_only_days: 1, clean_days: 2 });

  const onlyReq = C.reviewCoverage({ rows: ROWS, only_required: true }, CLOCK);
  eq('10.10 סינון לחובה בלבד מוציא את חומ״ס',
    onlyReq.by_role.filter(x => x.role === 'hazmat').length, 0);

  ok('10.11 הסיכום האנושי מזכיר את החוסר הגדול',
    C.summarize(r).indexOf('נהג') !== -1);
  eq('10.12 וכשהכול תקין הוא אומר זאת',
    C.summarize(C.reviewCoverage({ rows: [ROWS[0]] }, CLOCK)),
    'כל הימים עומדים בתקן.');

  try {
    C.reviewCoverage({ rows: [Object.assign({}, ROWS[1], {
      gaps: [{ role: 'driver', label: 'נהג', reasons: [] }] })] }, CLOCK);
    ok('10.13 ⭐ חוסר בלי סימון חובה/רשות מפורש נדחה', false, 'לא נזרקה שגיאה');
  } catch (e) { ok('10.13 ⭐ חוסר בלי סימון חובה/רשות מפורש נדחה',
    e.code === 'gap-required'); }

  try {
    C.reviewCoverage({ rows: [Object.assign({}, ROWS[0], { label: 'דוד כהן dk@x.co.il' })] }, CLOCK);
    ok('10.14 מייל בערך תמים נחסם', false, 'לא נזרקה שגיאה');
  } catch (e) { ok('10.14 מייל בערך תמים נחסם', e.code === 'leak'); }

  try {
    C.reviewCoverage({ rows: [Object.assign({}, ROWS[0], { label: '050-1234567' })] }, CLOCK);
    ok('10.15 טלפון בערך תמים נחסם', false, 'לא נזרקה שגיאה');
  } catch (e) { ok('10.15 טלפון בערך תמים נחסם', e.code === 'leak'); }

  ok('10.16 אין שם, מייל, טלפון או מספר עובד בכל הדוח',
    JSON.stringify(r).indexOf('"name"') === -1
    && JSON.stringify(r).indexOf('"emp"') === -1);
}

/* ============ 11 · טענות על המקור של המנוע ============ */
//
// כל אחת מהן היא הנחה שהמודולים בנויים עליה. אם קודקס משנה
// את המנוע — כאן זה נשבר, ולא בהרצה חודשית.
{
  ok('11.1 ⭐ הכשירות עדיין נמדדת מול תחנת השיוך ולא מול תחנה אפקטיבית ליום',
    engineSrc.includes('person.sub_station !== ctx.sub')
    && engineSrc.includes('REASON.OUT_OF_SUB_STATION'));

  ok('11.1b ⭐ גם מאגרי ההיצע עדיין קוראים person.sub_station — '
     + 'זה המקום השני שהצבה חייבת לגעת בו',
    engineSrc.includes('const sub = person.sub_station;'));

  ok('11.1c ⭐ הסגל עדיין שטוח: תחנה אחת לאדם לכל ההרצה',
    engineSrc.includes('byId.set(p.id, p)')
    && !/sub_station_by_date|effectiveSub|posting_map/.test(engineSrc));

  ok('11.2 ⭐ blockCode עדיין רץ גם על שיבוץ ידני',
    /source: 'manual'/.test(engineSrc) && /rejected\.push/.test(engineSrc));

  ok('11.3 המחזוריות הקשיחה עדיין דוחה יום שאינו של הקבוצה',
    engineSrc.includes('REASON.OUT_OF_ROTATION'));

  ok('11.4 המנוחה עדיין נמדדת ב-min_gap_days',
    engineSrc.includes('policy.min_gap_days') && engineSrc.includes('REASON.REST'));

  ok('11.5 חישוב הקבוצה במנוע לא השתנה',
    engineSrc.includes('Math.floor((((delta % cycle) + cycle) % cycle) / r.daysPerGroup)'));

  ok('11.6 ⭐ over_limit עדיין מסומן רק בענף האוטומטי',
    (engineSrc.split('over_limit').length - 1) <= 2
    && !/source: 'manual'[\s\S]{0,400}over_limit/.test(engineSrc));

  ok('11.7 השורה עדיין נושאת gaps, rejected_manual ו-below_minimum',
    engineSrc.includes('rejected_manual: rejected')
    && engineSrc.includes('below_minimum:') && engineSrc.includes('gaps,'));

  ok('11.8 ⭐ בכל חוסר עדיין יש required',
    /gaps\.push\(\{[\s\S]{0,200}required: row\.required/.test(engineSrc));

  ok('11.9 התקן עדיין דורש required בוליאני מפורש',
    engineSrc.includes("typeof row.required !== 'boolean'"));

  ok('11.10 ⭐ ההתאמה עדיין לפי person.roles ולא לפי כשירויות',
    engineSrc.includes('person.roles.indexOf(role) === -1')
    && !/person\.qualifications/.test(engineSrc));
}

/* ==================== 12 · מוטציות ==================== */
//
// בדיקה שעוברת על קוד שבור אינה בדיקה. כל מוטציה כאן היא
// שינוי אמיתי בקוד המודול, והיא **חייבת** להפיל משהו.
{
  const srcP = fs.readFileSync(placementPath, 'utf8');
  const srcC = fs.readFileSync(coveragePath, 'utf8');
  const tmp = join(__TESTS, '_mut.cjs');

  function mutate(src, from, to, label, exercise) {
    // split/join ולא replace: replace מחליף רק את המופע הראשון,
    // ומוטציה חלקית „נתפסת" מסיבה שגויה. זה כבר קרה לנו.
    if (src.indexOf(from) === -1) {
      ok('12.x ' + label, false, 'הטקסט למוטציה לא נמצא: ' + from);
      return;
    }
    const broken = src.split(from).join(to);
    fs.writeFileSync(tmp, broken);
    let caught = false;
    try {
      delete require_.cache[require_.resolve(tmp)];
      const M = require_(tmp);
      exercise(M);
    } catch (e) { caught = true; }
    fs.unlinkSync(tmp);
    ok(label, caught, 'המוטציה עברה בלי שאיש שם לב');
  }

  mutate(srcP,
    "subject.home_sub_station !== target.key",
    "false",
    '12.1 ⭐ הצבה שמפסיקה להיות מסומנת ככזו נתפסת',
    (M) => {
      const pl = M.createPlacementPlanner({ clock: CLOCK });
      const r = pl.planPlacement({ policy: POLICY, roster: ROSTER,
        request: { subject:{kind:'member',person:'uid-eldad'},
          sub_station:'yotvata', role:'driver',
          span:{kind:'week'}, anchor_date:'2026-09-01' } });
      // הכשל המסוכן: שורות שנראות תקינות, בלי מפה ובלי אזהרה,
      // וכל היום שלהן נדחה בשקט במנוע.
      if (r.posting === null || r.blocked !== true) throw new Error('caught');
    });

  mutate(srcP,
    "engine_accepts_today: false",
    "engine_accepts_today: true",
    '12.1b ⭐ טענה שהמנוע כן מקבל הצבה נתפסת',
    (M) => {
      const pl = M.createPlacementPlanner({ clock: CLOCK });
      const r = pl.planPlacement({ policy: POLICY, roster: ROSTER,
        request: { subject:{kind:'member',person:'uid-eldad'},
          sub_station:'yotvata', role:'driver',
          span:{kind:'week'}, anchor_date:'2026-09-01' } });
      if (r.posting.engine_accepts_today !== false) throw new Error('caught');
    });

  mutate(srcP,
    "counts_toward_minimum: false",
    "counts_toward_minimum: true",
    '12.2 ⭐ אורח שמתחיל להיספר בתקן נתפס',
    (M) => {
      const pl = M.createPlacementPlanner({ clock: CLOCK });
      const r = pl.planPlacement({ policy: POLICY, roster: ROSTER,
        request: { subject:{kind:'guest',display_name:'דני'},
          sub_station:'rashit', span:{kind:'week'}, anchor_date:'2026-09-01' } });
      if (r.guest.counts_toward_minimum !== false) throw new Error('caught');
    });

  mutate(srcP,
    "subject.roles.indexOf(req.role) === -1",
    "false",
    '12.3 שיבוץ ידני שהופך לפטור מכשירות נתפס',
    (M) => {
      const pl = M.createPlacementPlanner({ clock: CLOCK });
      pl.planPlacement({ policy: POLICY, roster: ROSTER,
        request: { subject:{kind:'member',person:'uid-eldad'},
          sub_station:'rashit', role:'officer',
          span:{kind:'week'}, anchor_date:'2026-09-01' } });
      throw new Error('caught');
    });

  mutate(srcP,
    "if (groupOfDay(rotation, d) === subject.group) dates.push(d);",
    "dates.push(d);",
    '12.4 ⭐ טווח שמפסיק להיספר לפי המחזור נתפס',
    (M) => {
      const pl = M.createPlacementPlanner({ clock: CLOCK });
      const r = pl.planPlacement({ policy: POLICY, roster: ROSTER,
        request: { subject:{kind:'member',person:'uid-eldad'},
          sub_station:'rashit', span:{kind:'week'}, anchor_date:'2026-09-01' } });
      if (r.span.dates.length !== 3) throw new Error('caught');
    });

  mutate(srcP,
    "person.active !== true",
    "false",
    '12.5 אדם לא פעיל שמתחיל לעבור נתפס',
    (M) => {
      const pl = M.createPlacementPlanner({ clock: CLOCK });
      pl.planPlacement({ policy: POLICY, roster: ROSTER,
        request: { subject:{kind:'member',person:'uid-ron'},
          sub_station:'rashit', span:{kind:'week'}, anchor_date:'2026-09-01' } });
      throw new Error('caught');
    });

  mutate(srcC,
    "typeof g.required !== 'boolean'",
    "false",
    '12.6 ⭐ חוסר בלי סימון חובה שמתחיל לעבור בשקט נתפס',
    (M) => {
      const r = M.reviewCoverage({ rows: [Object.assign({}, ROWS[1], {
        gaps: [{ role:'driver', label:'נהג', reasons: [] }] })] }, CLOCK);
      if (r.days[0].severity !== 'blocking') throw new Error('caught');
    });

  mutate(srcC,
    "if (g.required) t.required_days += 1; else t.optional_days += 1;",
    "t.required_days += 1;",
    '12.7 גלגול שסופר חוסר רצוי כחובה נתפס',
    (M) => {
      const r = M.reviewCoverage({ rows: ROWS }, CLOCK);
      const h = r.by_role.filter(x => x.role === 'hazmat')[0];
      if (h.optional_days !== 1) throw new Error('caught');
    });

  mutate(srcC,
    "if (EMAIL_RE.test(value))",
    "if (false)",
    '12.8 ביטול סריקת הדליפה נתפס',
    (M) => {
      M.reviewCoverage({ rows: [Object.assign({}, ROWS[0],
        { label: 'דוד dk@x.co.il' })] }, CLOCK);
      throw new Error('caught');
    });

  mutate(srcC,
    "if (!q || !q.active) continue;",
    "if (!q) continue;",
    '12.9 כשירות מבוטלת שמתחילה להיספר נתפסת',
    (M) => {
      const m = M.mapQualifications({
        quals: [{ id:'q_old', name:'ישן', active:false }],
        member_quals: { u: { quals:['q_old'] } },
        role_map: { q_old: 'driver' }, policy_roles: ['driver'] });
      if (m.people.u.length !== 0) throw new Error('caught');
    });

  mutate(srcC,
    "const rolesWithoutQual = policyRoles.filter((r) => !mappedRoles.has(r)).sort();",
    "const rolesWithoutQual = [];",
    '12.10 ⭐ השתקת „תפקיד בתקן בלי כשירות" נתפסת',
    (M) => {
      const m = M.mapQualifications({
        quals: [], member_quals: {}, role_map: {}, policy_roles: ['driver'] });
      if (m.roles_without_qual.length !== 1) throw new Error('caught');
    });
}

/* ---------------------------- סיכום ---------------------------- */
console.log('');
console.log('schedule-placement + schedule-coverage');
console.log('עברו ' + pass + ' · נפלו ' + fail);
if (fail) {
  console.log('');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
process.exit(0);
