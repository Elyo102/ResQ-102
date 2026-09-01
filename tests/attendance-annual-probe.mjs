// בדיקה עצמאית · functions/attendance-annual.js
//
// יחידה · פרטיות · מוטציות · עומס.
//
// הבדיקה הכי חשובה כאן היא 4: הסירוב. סיכום שנתי שמעדכן את
// עצמו בלי לדעת מה היום הישן תרם הוא בדיוק הבאג שהמערכת
// הישנה סבלה ממנו — hours.js:261-264 מתאר אותו ואת הכפתור
// שנועד לתקן אותו בדיעבד. מודול שמנחש שם עדיף שלא יתקיים.
//
// יציאה: 0 עבר · 1 נפל · 2 לא רץ.

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { performance } from 'perf_hooks';

const __TESTS = dirname(fileURLToPath(import.meta.url));
const FN = join(__TESTS, '..', 'functions');
const require_ = createRequire(import.meta.url);

const modPath = join(FN, 'attendance-annual.js');
const hoursPath = join(__TESTS, '..', 'hours.js');
if (!fs.existsSync(modPath)) {
  console.log('NOT RUN — חסר functions/attendance-annual.js');
  process.exit(2);
}
const A = require_(modPath);
const hoursSrc = fs.existsSync(hoursPath) ? fs.readFileSync(hoursPath, 'utf8') : '';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; return; }
  fail += 1; failures.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want),
    'קיבלתי ' + JSON.stringify(got) + ' במקום ' + JSON.stringify(want));
}
function throws(name, fn, code) {
  try { fn(); ok(name, false, 'לא נזרקה שגיאה'); }
  catch (e) { ok(name, e.code === code, 'קוד ' + e.code + ' במקום ' + code); }
}

const CLOCK = () => Date.UTC(2026, 8, 1, 6, 0, 0);
const agg = A.createAnnualAggregator({ clock: CLOCK });

const day = (date, over) => Object.assign({
  emp_number: '102', uid: 'uid-eldad', date,
  day_type: 'regular', hours: 24, sub_station: 'rashit'
}, over || {});

const YEAR_DAYS = [
  day('2026-01-05'),
  day('2026-01-08', { hours: 25, sub_station: 'yotvata' }),
  day('2026-02-03', { day_type: 'vacation', hours: 24, sub_station: '' }),
  day('2026-02-10', { day_type: 'sick', hours: 0, sub_station: '' }),
  day('2026-03-01', { day_type: 'reserve', hours: 8.5, sub_station: '' }),
  day('2026-08-20', { day_type: 'meeting', hours: 3, sub_station: 'rashit' })
];

/* ==================== 1 · בנייה מלאה ==================== */
{
  const { summary: s, notes } = agg.rebuild({
    emp_number: '102', uid: 'uid-eldad', year: '2026', days: YEAR_DAYS });

  eq('1.1 מספר המשמרות', s.shifts, 3);        // regular×2 + meeting
  eq('1.2 סך השעות', s.hours, 84.5);          // 24+25+24+0+8.5+3
  eq('1.3 מספר הימים', s.days, 6);
  eq('1.4 אין ימים לא-ספירים', s.uncountable_days, 0);
  eq('1.5 ⭐ חופש ומחלה אינם משמרות', s.by_day_type.vacation.shifts, 0);
  eq('1.6 אבל השעות שלהם נספרות', s.by_day_type.vacation.hours, 24);
  eq('1.7 מילואים 8.5', s.by_day_type.reserve.hours, 8.5);
  eq('1.8 פילוח חודשי', Object.keys(s.by_month).sort(), ['01','02','03','08']);
  eq('1.9 ינואר', s.by_month['01'], { shifts: 2, hours: 49, days: 2 });
  eq('1.10 פילוח תחנות קצה', Object.keys(s.by_sub_station).sort(),
    ['rashit','yotvata']);
  eq('1.11 ⭐ יום בלי תחנת קצה אינו יוצר דלי ריק',
    s.by_sub_station[''], undefined);
  eq('1.12 יטבתה 25', s.by_sub_station.yotvata.hours, 25);
  eq('1.13 revision מתחיל ב-1', s.revision, 1);
  eq('1.14 ואינו stale', s.stale, false);
  ok('1.15 יש digest', typeof s.digest === 'string' && s.digest.length > 2);
  eq('1.16 אין הערות', notes, []);

  throws('1.17 יום משנה אחרת נדחה',
    () => agg.rebuild({ emp_number:'102', year:'2026',
      days:[day('2025-12-31')] }), A.CODE.YEAR_MISMATCH);
  throws('1.18 יום של עובד אחר נדחה',
    () => agg.rebuild({ emp_number:'102', year:'2026',
      days:[day('2026-01-05', { emp_number:'103' })] }), A.CODE.EMP_MISMATCH);
  throws('1.19 ⭐ אותו יום פעמיים נדחה ולא נבלע',
    () => agg.rebuild({ emp_number:'102', year:'2026',
      days:[day('2026-01-05'), day('2026-01-05')] }), A.CODE.SHAPE);
  throws('1.20 תאריך שאינו קיים נדחה',
    () => agg.rebuild({ emp_number:'102', year:'2026',
      days:[day('2026-02-30')] }), A.CODE.SHAPE);
  throws('1.21 בלי clock אין מודול',
    () => A.createAnnualAggregator({}), A.CODE.SHAPE);
}

/* ============ 2 · ⭐ שעות חסרות אינן אפס ============ */
{
  const c = A.contributionOf(day('2026-05-01', { hours: undefined }));
  eq('2.1 יום בלי hours אינו ספיר', c.countable, false);
  eq('2.2 ושעותיו אינן נספרות', c.hours, 0);

  const { summary: s, notes } = agg.rebuild({ emp_number:'102', year:'2026',
    days: [day('2026-05-01'), day('2026-05-02', { hours: undefined })] });
  eq('2.3 ⭐ היום הלא-ספיר נספר ומדווח', s.uncountable_days, 1);
  eq('2.4 והוא מופיע בהערות', notes[0].code, A.NOTE.UNCOUNTABLE);
  eq('2.5 והסך אינו כולל אותו', s.hours, 24);
  eq('2.6 אבל הוא כן נספר כיום', s.days, 2);

  eq('2.7 hours שלילי אינו ספיר',
    A.contributionOf(day('2026-05-03', { hours: -5 })).countable, false);
  eq('2.8 hours כמחרוזת אינו ספיר',
    A.contributionOf(day('2026-05-04', { hours: '24' })).countable, false);
  eq('2.9 NaN אינו ספיר',
    A.contributionOf(day('2026-05-05', { hours: NaN })).countable, false);
  eq('2.10 אפס אמיתי כן ספיר — מחלה היא 0 שעות אמיתי',
    A.contributionOf(day('2026-05-06', { day_type:'sick', hours: 0 })).countable, true);
}

/* ================ 3 · דלתא · המסלול התקין ================ */
function fresh() {
  const built = agg.rebuild({ emp_number:'102', uid:'uid-eldad', year:'2026',
    days: YEAR_DAYS });
  const detail = { days: {} };
  for (const rec of YEAR_DAYS) {
    const c = A.contributionOf(rec);
    detail.days[c.date] = { date:c.date, month:c.month, day_type:c.day_type,
      sub_station:c.sub_station, hours:c.hours,
      countable:c.countable, is_shift:c.is_shift };
  }
  return { summary: built.summary, detail };
}
{
  const base = fresh();

  // תיקון: 24 → 30 שעות באותו יום.
  const r = agg.planDelta({ summary: base.summary, detail: base.detail,
    before: day('2026-01-05'), after: day('2026-01-05', { hours: 30 }) });
  eq('3.1 סוג הפעולה', r.kind, 'updated');
  eq('3.2 ⭐ הסך זז בהפרש בלבד', r.summary.hours, 90.5);   // 84.5 - 24 + 30
  eq('3.3 מספר המשמרות לא השתנה', r.summary.shifts, 3);
  eq('3.4 והחודש התעדכן', r.summary.by_month['01'].hours, 55);
  eq('3.5 revision עלה', r.summary.revision, 2);
  ok('3.6 והפירוט עודכן', base.detail.days['2026-01-05'].hours === 24
    && r.detail.days['2026-01-05'].hours === 30);

  // יום חדש
  const c = agg.planDelta({ summary: base.summary, detail: base.detail,
    before: null, after: day('2026-04-01', { hours: 24 }) });
  eq('3.7 יום חדש', c.kind, 'created');
  eq('3.8 נוסף לסך', c.summary.hours, 108.5);
  eq('3.9 ומדווח כיום שלא נספר קודם', c.notes[0].code, A.NOTE.NEW_DAY);

  // מחיקה
  const dl = agg.planDelta({ summary: base.summary, detail: base.detail,
    before: day('2026-01-08', { hours: 25, sub_station:'yotvata' }), after: null });
  eq('3.10 מחיקה', dl.kind, 'deleted');
  eq('3.11 הסך ירד', dl.summary.hours, 59.5);
  eq('3.12 ⭐ דלי תחנת קצה שהתרוקן נמחק',
    dl.summary.by_sub_station.yotvata, undefined);
  eq('3.13 והיום ירד מהפירוט', dl.detail.days['2026-01-08'], undefined);

  // שינוי סוג יום: משמרת → חופש. חייב לזוז בין הדליים.
  const t = agg.planDelta({ summary: base.summary, detail: base.detail,
    before: day('2026-01-05'),
    after: day('2026-01-05', { day_type:'vacation', hours:24, sub_station:'' }) });
  eq('3.14 ⭐ המרה למשמרת-לא מורידה shifts', t.summary.shifts, 2);
  eq('3.15 והשעות נשארו', t.summary.hours, 84.5);
  eq('3.16 ⭐ והדלי הישן של תחנת הקצה התרוקן נכון',
    t.summary.by_sub_station.rashit, { shifts: 1, hours: 3, days: 1 });
}

/* ========== 4 · ⭐⭐ הסירוב · הבדיקה החשובה כאן ========== */
{
  const base = fresh();
  // הפירוט מתגלגל: 1.1 כבר לא בחלון.
  const pruned = { days: Object.assign({}, base.detail.days) };
  delete pruned.days['2026-01-05'];

  const r = agg.planDelta({ summary: base.summary, detail: pruned,
    before: null, after: day('2026-01-05', { hours: 30 }) });

  eq('4.1 ⭐⭐ תיקון יום שנספר ואין לו בסיס — מסורב', r.kind, 'refused');
  eq('4.2 עם קוד מפורש', r.code, A.CODE.NO_BASELINE);
  eq('4.3 ⭐ והסיכום סומן stale', r.summary.stale, true);
  eq('4.4 עם התרופה', r.remedy, 'rebuild');
  eq('4.5 ⭐⭐ ובלי שהמספרים זזו', r.summary.hours, 84.5);
  ok('4.6 וההערות אומרות למה',
    r.notes.some(n => n.code === A.NOTE.OUT_OF_WINDOW));

  // אבל עם before תואם — עובר, גם בלי הפירוט.
  const withBefore = agg.planDelta({ summary: base.summary, detail: pruned,
    before: day('2026-01-05'), after: day('2026-01-05', { hours: 30 }) });
  eq('4.7 before תואם מספק בסיס', withBefore.kind, 'updated');
  eq('4.8 והסך נכון', withBefore.summary.hours, 90.5);

  // before שאינו תואם למה שנספר — לא מספיק. זה תיקון על סמך
  // מצב שהמערכת לא נמצאת בו.
  const wrongBefore = agg.planDelta({ summary: base.summary, detail: pruned,
    before: day('2026-01-05', { hours: 12 }),
    after: day('2026-01-05', { hours: 30 }) });
  eq('4.9 ⭐ before שאינו תואם את מה שנספר — מסורב', wrongBefore.kind, 'refused');
  eq('4.10 עם אותו קוד', wrongBefore.code, A.CODE.NO_BASELINE);
}

/* ============= 5 · ⭐ החלה חוזרת אינה סופרת פעמיים ============= */
{
  const base = fresh();
  const after = day('2026-01-05', { hours: 30 });

  const first = agg.planDelta({ summary: base.summary, detail: base.detail,
    before: day('2026-01-05'), after });
  eq('5.1 החלה ראשונה', first.summary.hours, 90.5);

  const second = agg.planDelta({ summary: first.summary, detail: first.detail,
    before: day('2026-01-05'), after });
  eq('5.2 ⭐⭐ החלה חוזרת של אותה תרומה היא no-op', second.kind, 'noop');
  eq('5.3 והסך לא זז', second.summary.hours, 90.5);
  eq('5.4 ו-revision לא עלה', second.summary.revision, first.summary.revision);

  const third = agg.planDelta({ summary: second.summary, detail: second.detail,
    before: day('2026-01-05'), after });
  eq('5.5 וגם בפעם השלישית', third.summary.hours, 90.5);

  // מחיקה כפולה
  const d1 = agg.planDelta({ summary: base.summary, detail: base.detail,
    before: day('2026-02-10', { day_type:'sick', hours:0, sub_station:'' }),
    after: null });
  const sickDay = day('2026-02-10', { day_type:'sick', hours:0, sub_station:'' });
  const d2 = agg.planDelta({ summary: d1.summary, detail: d1.detail,
    before: sickDay, after: null });
  eq('5.6 ⭐ מחיקה חוזרת אינה מחסרת פעמיים', d2.kind, 'noop');
  eq('5.7 והימים נכונים', d2.summary.days, 5);

  throws('5.8 קריאה בלי before ובלי after היא חסרת משמעות ונדחית',
    () => agg.planDelta({ summary: base.summary, detail: base.detail,
      before: null, after: null }), A.CODE.SHAPE);
}

/* ================ 6 · הפירוט המתגלגל ================ */
{
  const base = fresh();
  const detail = { days: Object.assign({}, base.detail.days,
    { '2026-08-25': { date:'2026-08-25', month:'08', day_type:'regular',
      sub_station:'rashit', hours:24, countable:true, is_shift:true } }) };

  const r = agg.planRetention({ detail, today: '2026-09-01' });
  eq('6.1 חלון של 31 יום', r.keep_days, 31);
  eq('6.2 ⭐ החלון מתחיל 30 יום אחורה, כולל היום', r.window_from, '2026-08-02');
  eq('6.3 ימים ישנים נושרים',
    r.drop, ['2026-01-05','2026-01-08','2026-02-03','2026-02-10','2026-03-01']);
  eq('6.4 ⭐ 20.8 בתוך החלון ונשאר — הגבול הוא 2.8, לא „החודש הזה"',
    Object.keys(r.days), ['2026-08-20','2026-08-25']);
  eq('6.5 ויום אחד לפני הגבול נושר',
    agg.planRetention({ days: undefined,
      detail: { days: { '2026-08-01': { date:'2026-08-01', month:'08',
        day_type:'regular', sub_station:'', hours:24,
        countable:true, is_shift:true } } },
      today: '2026-09-01' }).drop, ['2026-08-01']);
  eq('6.5b ומדווח ממתי אפשר לתקן בבטחה', r.correctable_from, '2026-08-02');

  const custom = agg.planRetention({ detail, today: '2026-09-01', keep_days: 7 });
  eq('6.6 חלון מותאם', custom.window_from, '2026-08-26');
  eq('6.7 ואז גם 25.8 נושר', custom.drop.indexOf('2026-08-25') !== -1, true);

  throws('6.8 היום חייב להיות תאריך',
    () => agg.planRetention({ detail, today: 'מחר' }), A.CODE.SHAPE);
}

/* ============ 7 · verify · „הכפתור" מהמערכת הישנה ============ */
{
  const base = fresh();

  const clean = agg.verify({ summary: base.summary, days: YEAR_DAYS });
  eq('7.1 סיכום תקין עובר', clean.ok, true);
  eq('7.2 והחתימות תואמות', clean.digest_match, true);
  eq('7.3 בלי סטייה', clean.drift, []);

  // סיכום שהתפצל: מישהו ערך אותו ביד.
  const drifted = JSON.parse(JSON.stringify(base.summary));
  drifted.hours = 100;
  const bad = agg.verify({ summary: drifted, days: YEAR_DAYS });
  eq('7.4 ⭐ פיצול נתפס', bad.ok, false);
  eq('7.5 ומדווח שדה-שדה',
    bad.drift.filter(d => d.field === 'hours')[0], { field:'hours', stored:100, actual:84.5 });

  // המקרה הערמומי: המספרים זהים, הימים שונים. שני ימים
  // שמבטלים זה את זה. digest תופס; מספרים לבדם לא.
  const swapped = YEAR_DAYS.slice(0, 5).concat([
    day('2026-08-21', { day_type:'meeting', hours: 3 })]);
  const sneaky = agg.verify({ summary: base.summary, days: swapped });
  eq('7.6 ⭐⭐ ימים שונים עם אותם מספרים — נתפסים על ידי digest',
    sneaky.ok, false);
  eq('7.7 והשדה שנפל הוא digest',
    sneaky.drift.some(d => d.field === 'digest'), true);
  eq('7.8 בעוד המספרים עצמם זהים', sneaky.rebuilt.hours, base.summary.hours);
}

/* ==================== 8 · פרטיות ==================== */
{
  const { summary: s } = agg.rebuild({ emp_number:'102', uid:'uid-eldad',
    year:'2026', days: YEAR_DAYS.map(r => Object.assign({}, r, {
      full_name: 'אלדד יונה', notes: 'שריפה בשחמון',
      overtime_reason: 'נשארתי עד ההחלפה',
      edited_by_name: 'רכזת כוח אדם' })) });

  const json = JSON.stringify(s);
  ok('8.1 ⭐ אין שם מלא בסיכום', json.indexOf('אלדד') === -1);
  ok('8.2 אין הערות', json.indexOf('שריפה') === -1);
  ok('8.3 אין נימוק', json.indexOf('ההחלפה') === -1);
  ok('8.4 אין שם עורך', json.indexOf('רכזת') === -1);
  eq('8.5 מספר עובד כן — הוא המפתח', s.emp_number, '102');
  eq('8.6 ו-uid כן — הוא הזהות', s.uid, 'uid-eldad');

  throws('8.7 שדה אסור נחסם',
    () => A.assertNoPii({ ok: 1, full_name: 'x' }, 'p'), A.CODE.PII);
  throws('8.8 ⭐ מייל בערך תמים נחסם',
    () => A.assertNoPii({ label: 'eldad50@gmail.com' }, 'p'), A.CODE.PII);
  throws('8.9 ⭐ טלפון בערך תמים נחסם',
    () => A.assertNoPii({ label: '050-1234567' }, 'p'), A.CODE.PII);
  throws('8.10 ⭐ שם עברי בערך תמים נחסם',
    () => A.assertNoPii({ label: 'אלדד יונה' }, 'p'), A.CODE.PII);
  ok('8.11 מזהה תמים אינו נחסם',
    (() => { try { A.assertNoPii({ sub:'yotvata', m:'01' }, 'p'); return true; }
             catch (e) { return false; } })());
}

/* ============ 9 · טענות על מקור hours.js ============ */
{
  ok('9.1 ⭐ ההכרעה „מה שלא נשמר לא מתפצל" עדיין במקור',
    hoursSrc.includes('מה שלא נשמר לא מתפצל'));
  ok('9.2 סוגי היום שנספרים כמשמרת עדיין קיימים ב-hours.js',
    A.SHIFT_DAY_TYPES.every(t => hoursSrc.includes("id: '" + t + "'")));
  ok('9.3 ⭐ חופש, מחלה ומילואים עדיין times:false — ולכן אינם משמרת',
    /\{ id: 'vacation',[^}]*times: false/.test(hoursSrc)
    && /\{ id: 'sick',[^}]*times: false/.test(hoursSrc)
    && /\{ id: 'reserve',[^}]*times: false/.test(hoursSrc));
  ok('9.4 recordId עדיין ממופתח לפי מספר עובד ולא uid',
    /export function recordId\(emp, date\)/.test(hoursSrc));
  ok('9.5 monthTotal עדיין מחשב ואינו שומר',
    hoursSrc.includes('export function monthTotal'));
}

/* ==================== 10 · מוטציות ==================== */
{
  const src = fs.readFileSync(modPath, 'utf8');
  const tmp = join(__TESTS, '_mut_annual.cjs');
  function mutate(from, to, label, exercise) {
    if (src.indexOf(from) === -1) {
      ok(label, false, 'הטקסט למוטציה לא נמצא'); return;
    }
    fs.writeFileSync(tmp, src.split(from).join(to));
    let caught = false;
    try {
      delete require_.cache[require_.resolve(tmp)];
      exercise(require_(tmp));
    } catch (e) { caught = true; }
    fs.unlinkSync(tmp);
    ok(label, caught, 'המוטציה עברה בלי שאיש שם לב');
  }

  mutate('const countable = isFiniteNumber(hours) && hours >= 0;',
    'const countable = true;',
    '10.1 ⭐ שעות חסרות שהופכות לאפס שקט — נתפס',
    (M) => {
      const c = M.contributionOf({ date:'2026-01-01', hours: undefined });
      if (c.countable !== false) throw new Error('caught');
    });

  mutate("          remedy: 'rebuild',", "          remedy: 'guess',",
    '10.2 ⭐⭐ ביטול הסירוב על חוסר בסיס — נתפס',
    (M) => {
      const a2 = M.createAnnualAggregator({ clock: CLOCK });
      const b = fresh();
      const pruned = { days: Object.assign({}, b.detail.days) };
      delete pruned.days['2026-01-05'];
      const r = a2.planDelta({ summary: b.summary, detail: pruned,
        before: null, after: day('2026-01-05', { hours: 30 }) });
      if (r.remedy !== 'rebuild') throw new Error('caught');
    });

  mutate('if (counted && nextKey !== null && nextKey === priorKey) {',
    'if (false) {',
    '10.3 ⭐⭐ ביטול ה-no-op — ספירה כפולה נתפסת',
    (M) => {
      const a2 = M.createAnnualAggregator({ clock: CLOCK });
      const b = fresh();
      const after = day('2026-01-05', { hours: 30 });
      const f = a2.planDelta({ summary:b.summary, detail:b.detail,
        before: day('2026-01-05'), after });
      const s2 = a2.planDelta({ summary:f.summary, detail:f.detail,
        before: day('2026-01-05'), after });
      if (s2.kind !== 'noop') throw new Error('caught');
    });

  mutate("  ['regular', 'swap', 'extra', 'meeting', 'guard']);",
    "  ['regular', 'swap', 'extra', 'meeting', 'guard', 'vacation']);",
    '10.4 חופש שמתחיל להיספר כמשמרת — נתפס',
    (M) => {
      const a2 = M.createAnnualAggregator({ clock: CLOCK });
      const r = a2.rebuild({ emp_number:'102', year:'2026', days: YEAR_DAYS });
      if (r.summary.shifts !== 3) throw new Error('caught');
    });

  mutate('if (map[key].days === 0 && map[key].shifts === 0 && map[key].hours === 0) {',
    'if (false) {',
    '10.5 דלי ריק שנשאר בסיכום — נתפס',
    (M) => {
      const a2 = M.createAnnualAggregator({ clock: CLOCK });
      const b = fresh();
      const r = a2.planDelta({ summary:b.summary, detail:b.detail,
        before: day('2026-01-08', { hours:25, sub_station:'yotvata' }), after: null });
      if (r.summary.by_sub_station.yotvata !== undefined) throw new Error('caught');
    });

  mutate('if (EMAIL_RE.test(value)) throw new AnnualError(CODE.PII',
    'if (false) throw new AnnualError(CODE.PII',
    '10.6 ביטול סריקת המייל — נתפס',
    (M) => { M.assertNoPii({ label: 'a@b.co.il' }, 'p'); throw new Error('caught'); });

  mutate('if (HEB_NAME_RE.test(value)) throw new AnnualError(CODE.PII',
    'if (false) throw new AnnualError(CODE.PII',
    '10.7 ביטול סריקת השם — נתפס',
    (M) => { M.assertNoPii({ label: 'אלדד יונה' }, 'p'); throw new Error('caught'); });

  mutate('  return Math.round(n * 100) / 100;', '  return n;',
    '10.8 ⭐ ביטול העיגול — צבירת שארית נתפסת',
    (M) => {
      const a2 = M.createAnnualAggregator({ clock: CLOCK });
      const days = [];
      for (let i = 1; i <= 30; i += 1) {
        days.push(day('2026-06-' + String(i).padStart(2,'0'), { hours: 8.1 }));
      }
      const r = a2.rebuild({ emp_number:'102', year:'2026', days });
      if (r.summary.hours !== 243) throw new Error('caught');
    });

  mutate('if (seen.has(c.date)) {', 'if (false) {',
    '10.9 ⭐ אותו יום פעמיים שנבלע — נתפס',
    (M) => {
      const a2 = M.createAnnualAggregator({ clock: CLOCK });
      a2.rebuild({ emp_number:'102', year:'2026',
        days:[day('2026-01-05'), day('2026-01-05')] });
      throw new Error('caught');
    });

  mutate('    if (!digestMatch && !drift.length) {', '    if (false) {',
    '10.10 ⭐⭐ verify שמפסיק לתפוס ימים שונים עם אותם מספרים — נתפס',
    (M) => {
      const a2 = M.createAnnualAggregator({ clock: CLOCK });
      const b = fresh();
      const swapped = YEAR_DAYS.slice(0,5).concat([
        day('2026-08-21', { day_type:'meeting', hours: 3 })]);
      const v = a2.verify({ summary: b.summary, days: swapped });
      if (v.ok !== false) throw new Error('caught');
    });
}

/* ============== 11 · עומס · 5,000 עובדים ============== */
//
// סעיף 5 מבקש עומס של 5,000. הסיכום השנתי הוא לכל עובד בנפרד,
// ולכן 5,000 עובדים הם 5,000 חישובים בלתי תלויים — זה מה
// שנמדד כאן. התקציבים מועתקים מ-schedule-load-acceptance.mjs:
// 15,000ms קיר ו-256MB ערמה.
{
  const EMPLOYEES = 5000;
  const DAYS_EACH = 120;          // ~10 משמרות בחודש, שנה שלמה
  const t0 = performance.now();
  const h0 = process.memoryUsage().heapUsed;

  let totalShifts = 0, totalHours = 0;
  const subs = ['rashit','shahmon','timna','yotvata'];
  for (let e = 0; e < EMPLOYEES; e += 1) {
    const emp = 'e' + String(e).padStart(5, '0');
    const days = [];
    for (let i = 0; i < DAYS_EACH; i += 1) {
      // 12 חודשים × 10 ימים. כל תאריך קיים באמת — מחולל שמייצר
      // 31.9 או חודש 13 מייצר בדיקת עומס שבודקת את המחולל.
      const month = String(Math.floor(i / 10) + 1).padStart(2, '0');
      const dd = String((i % 10) * 2 + 1).padStart(2, '0');
      days.push({ emp_number: emp, date: '2026-' + month + '-' + dd,
        day_type: (i % 11 === 0) ? 'vacation' : 'regular',
        hours: (i % 11 === 0) ? 24 : 24,
        sub_station: subs[i % subs.length] });
    }
    const r = agg.rebuild({ emp_number: emp, year: '2026', days });
    totalShifts += r.summary.shifts;
    totalHours += r.summary.hours;
  }

  const elapsed = performance.now() - t0;
  const heapMb = (process.memoryUsage().heapUsed - h0) / (1024 * 1024);

  eq('11.1 כל 5,000 העובדים חושבו', totalShifts,
    EMPLOYEES * (DAYS_EACH - Math.ceil(DAYS_EACH / 11)));
  ok('11.2 והשעות נצברו', totalHours === EMPLOYEES * DAYS_EACH * 24);
  ok('11.3 ⭐ מתחת לתקציב 15 שניות · בפועל ' + Math.round(elapsed) + 'ms',
    elapsed < 15000, 'לקח ' + Math.round(elapsed) + 'ms');
  ok('11.4 ⭐ מתחת לתקציב 256MB · בפועל ' + Math.round(heapMb) + 'MB',
    heapMb < 256, 'תפס ' + Math.round(heapMb) + 'MB');

  console.log('');
  console.log('  עומס · ' + EMPLOYEES + ' עובדים × ' + DAYS_EACH + ' ימים = '
    + (EMPLOYEES * DAYS_EACH).toLocaleString() + ' ימים');
  console.log('  זמן ' + Math.round(elapsed) + 'ms · ערמה '
    + Math.round(heapMb) + 'MB');

  // גג קשיח: שנה עם יותר מ-400 ימים אינה שנה.
  throws('11.5 שנה עם יותר מ-400 ימים נדחית',
    () => { const many = [];
      for (let i = 0; i < 401; i += 1) many.push(day('2026-01-01'));
      agg.rebuild({ emp_number:'102', year:'2026', days: many }); },
    A.CODE.TOO_MANY_DAYS);
}

/* ---------------------------- סיכום ---------------------------- */
console.log('');
console.log('attendance-annual · סיכום שנתי ועדכון בטוח');
console.log('עברו ' + pass + ' · נפלו ' + fail);
if (fail) {
  console.log('');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
process.exit(0);
