// בדיקה עצמאית · הצבה זמנית בתחנת קצה אחרת, לפי יום
//
// זו הבדיקה שסוגרת את הלולאה: schedule-placement מתכנן
// posting_map, והמנוע — אחרי השינוי — **מקבל אותה כמות שהיא**.
// עד עכשיו כל יום בהצבה נדחה ל-rejected_manual, שדה שאף מסך
// אינו מציג, והסידור יצא ריק בלי שגיאה.
//
// שלוש התכונות שחייבות להתקיים יחד, ואם אחת מהן נשברת ההצבה
// מזיקה יותר משהיא עוזרת:
//   ההצבה תופסת ביום המוצב
//   האדם אינו זמין בתחנת הבית באותו יום
//   והוא חוזר לתחנת הבית ביום שאחריו — בלי לגעת בשיוך הארגוני
//
// יציאה: 0 עבר · 1 נפל · 2 לא רץ.

import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __TESTS = dirname(fileURLToPath(import.meta.url));
const FN = join(__TESTS, '..', 'functions');
const require_ = createRequire(import.meta.url);

const enginePath = join(FN, 'schedule-calendar-engine.js');
const placementPath = join(FN, 'schedule-placement.js');
const engineSrc = fs.readFileSync(enginePath, 'utf8');

if (!engineSrc.includes('function effectiveSub(')) {
  console.log('NOT RUN — המנוע עדיין אינו מכיר תחנת קצה אפקטיבית ליום.');
  console.log('          schedule-calendar-engine.js קורא person.sub_station ישירות,');
  console.log('          ולכן הצבה זמנית אינה ניתנת לביטוי. הבדיקה נכשלת-סגור.');
  process.exit(2);
}

const { createCalendarEngine } = require_(enginePath);
const P = require_(placementPath);

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
function throwsCode(name, fn, code) {
  try { fn(); ok(name, false, 'לא נזרקה שגיאה'); }
  catch (e) { ok(name, e.code === code, 'קוד ' + e.code + ' במקום ' + code); }
}

/* ------------------------- הסביבה ------------------------- */

const station = 'station-102';
const version = 'v1';
const revision = 'r1';
const sourceDigest = 'digest-posting';
const policyDigest = 'policy-posting';
const snapshot = 'snapshot-posting';

const POLICY = {
  station_id: station,
  version,
  digest: policyDigest,
  sub_stations: {
    rashit: { label: 'ראשית', minimum: 1, requirements: [
      { role: 'driver', label: 'נהג', count: 1, required: true }] },
    timna: { label: 'תמנע', minimum: 1, requirements: [
      { role: 'driver', label: 'נהג', count: 1, required: true }] }
  },
  rest: { min_gap_days: 0 },
  rotation: null,
  max_shifts_per_month: null
};

const engine = createCalendarEngine({
  clock: () => '2026-09-01T00:00:00.000Z',
  policy: POLICY
});

const person = (id, sub) => ({
  id, station_id: station, sub_station: sub, active: true, roles: ['driver'],
  source_snapshot: snapshot, source_version: version,
  contract_station_id: station, source_revision: revision,
  source_digest: sourceDigest, source_complete: true
});

// אלדד בראשית, נועה בתמנע. שני נהגים, שתי תחנות, תקן 1 בכל אחת.
// כל הזזה נראית מיד.
const ROSTER = [person('uid-eldad', 'rashit'), person('uid-noa', 'timna')];
const DAYS = engine.daysBetween('2026-09-01', '2026-09-03');

function plan(extra) {
  return engine.planPeriod(Object.assign({
    station_id: station, source_snapshot: snapshot, source_version: version,
    contract_station_id: station, source_revision: revision,
    source_digest: sourceDigest, policy_digest: policyDigest,
    source_complete: true,
    availability: {}, locked: {}, carry: {},
    days: DAYS, roster: ROSTER
  }, extra || {}));
}

const at = (result, date, sub) => {
  const row = result.rows.filter(r => r.date === date && r.sub_station === sub)[0];
  return row ? row.slots.map(s => s.person).sort() : null;
};
const gapsAt = (result, date, sub) => {
  const row = result.rows.filter(r => r.date === date && r.sub_station === sub)[0];
  return row ? row.gaps.map(g => g.role) : null;
};

/* ============ 1 · נסיגה · בלי הצבות דבר לא השתנה ============ */
{
  const base = plan();
  eq('1.1 ראשית מאוישת על ידי אלדד', at(base, '2026-09-01', 'rashit'), ['uid-eldad']);
  eq('1.2 תמנע על ידי נועה', at(base, '2026-09-01', 'timna'), ['uid-noa']);
  eq('1.3 אין חוסרים', base.summary.blocking_gaps, 0);
  eq('1.4 ואין דחיות ידניות', base.summary.rejected_manual, 0);

  const explicitNull = plan({ postings: null });
  eq('1.5 postings: null זהה לחלוטין',
    JSON.stringify(explicitNull.rows), JSON.stringify(base.rows));
  const empty = plan({ postings: {} });
  eq('1.6 מפה ריקה זהה לחלוטין',
    JSON.stringify(empty.rows), JSON.stringify(base.rows));
}

/* ========== 2 · ⭐⭐ ההצבה · שלוש התכונות יחד ========== */
{
  const r = plan({ postings: { 'uid-eldad': { '2026-09-02': 'timna' } } });

  eq('2.1 ⭐ ביום המוצב אלדד בתמנע',
    at(r, '2026-09-02', 'timna').indexOf('uid-eldad') !== -1, true);
  eq('2.2 ⭐ ובאותו יום הוא אינו בראשית',
    at(r, '2026-09-02', 'rashit').indexOf('uid-eldad'), -1);
  eq('2.3 ⭐ ויום לפני הוא בראשית', at(r, '2026-09-01', 'rashit'), ['uid-eldad']);
  eq('2.4 ⭐ ויום אחרי הוא חזר לראשית', at(r, '2026-09-03', 'rashit'), ['uid-eldad']);

  // הצד השני של המטבע, וזה מה שהופך את זה למידע ולא לקסם:
  // ראשית נשארת בלי נהג ביום ההצבה. זה בדיוק מה ש-vacates
  // ב-schedule-placement מזהיר עליו.
  eq('2.5 ⭐ וראשית נשארה בלי נהג באותו יום',
    gapsAt(r, '2026-09-02', 'rashit'), ['driver']);
  eq('2.6 והיא מסומנת מתחת לתקן',
    r.rows.filter(x => x.date === '2026-09-02' && x.sub_station === 'rashit')[0]
      .below_minimum, true);
  eq('2.7 בעוד בשאר הימים אין חוסר',
    gapsAt(r, '2026-09-01', 'rashit'), []);
}

/* ====== 3 · ⭐ שיבוץ ידני בתחנה מוצבת — התרחיש שנשבר ====== */
{
  // בלי הצבה: המנוע דוחה את השיבוץ הידני, בשקט, ל-rejected_manual.
  const without = plan({ locked: { timna: { '2026-09-02': ['uid-eldad'] } } });
  const rowW = without.rows.filter(
    x => x.date === '2026-09-02' && x.sub_station === 'timna')[0];
  eq('3.1 ⭐ בלי הצבה — השיבוץ הידני נדחה', rowW.rejected_manual.length, 1);
  eq('3.2 עם הקוד שאיש אינו רואה',
    rowW.rejected_manual[0].code, 'out_of_sub_station');
  eq('3.3 ואלדד אינו שם', rowW.slots.map(s => s.person).indexOf('uid-eldad'), -1);

  // עם הצבה: אותו שיבוץ ידני בדיוק — עובר.
  const with_ = plan({
    locked: { timna: { '2026-09-02': ['uid-eldad'] } },
    postings: { 'uid-eldad': { '2026-09-02': 'timna' } }
  });
  const rowP = with_.rows.filter(
    x => x.date === '2026-09-02' && x.sub_station === 'timna')[0];
  eq('3.4 ⭐⭐ עם הצבה — אותו שיבוץ ידני עובר', rowP.rejected_manual.length, 0);
  eq('3.5 ואלדד משובץ שם', rowP.slots.map(s => s.person).indexOf('uid-eldad') !== -1, true);
  eq('3.6 והמקור מסומן ידני',
    rowP.slots.filter(s => s.person === 'uid-eldad')[0].source, 'manual');
  eq('3.7 ⭐ „ידני" עדיין אינו „פטור מכשירות" — התפקיד נבדק',
    rowP.slots.filter(s => s.person === 'uid-eldad')[0].role, 'driver');
}

/* ====== 4 · ⭐ אדם בלי הכשירות אינו עובר גם כשהוא מוצב ====== */
{
  const roster2 = [person('uid-eldad', 'rashit'), person('uid-noa', 'timna')];
  roster2[0].roles = [];   // אלדד בלי תפקיד סידור
  const r = engine.planPeriod({
    station_id: station, source_snapshot: snapshot, source_version: version,
    contract_station_id: station, source_revision: revision,
    source_digest: sourceDigest, policy_digest: policyDigest,
    source_complete: true, availability: {}, locked: {}, carry: {},
    days: DAYS, roster: roster2,
    postings: { 'uid-eldad': { '2026-09-02': 'timna' } }
  });
  eq('4.1 ⭐ הצבה אינה מעניקה כשירות',
    at(r, '2026-09-02', 'timna'), ['uid-noa']);
  eq('4.2 וראשית חסרה נהג בכל הימים',
    r.rows.filter(x => x.sub_station === 'rashit'
      && x.gaps.length > 0).length, 3);
}

/* ====== 5 · אדם לא פעיל אינו מוצב ====== */
{
  const roster3 = [person('uid-eldad', 'rashit'), person('uid-noa', 'timna')];
  roster3[0].active = false;
  const r = engine.planPeriod({
    station_id: station, source_snapshot: snapshot, source_version: version,
    contract_station_id: station, source_revision: revision,
    source_digest: sourceDigest, policy_digest: policyDigest,
    source_complete: true, availability: {}, locked: {}, carry: {},
    days: DAYS, roster: roster3,
    postings: { 'uid-eldad': { '2026-09-02': 'timna' } }
  });
  eq('5.1 ⭐ אדם לא פעיל אינו מוצב', at(r, '2026-09-02', 'timna'), ['uid-noa']);
}

/* ====== 6 · אי-זמינות גוברת על הצבה ====== */
{
  const r = plan({
    availability: { 'uid-eldad': { '2026-09-02': 'leave' } },
    postings: { 'uid-eldad': { '2026-09-02': 'timna' } }
  });
  eq('6.1 ⭐ מי שאינו זמין אינו מוצב', at(r, '2026-09-02', 'timna'), ['uid-noa']);
  eq('6.2 והוא זמין ביום שאחריו בבית', at(r, '2026-09-03', 'rashit'), ['uid-eldad']);
}

/* ============== 7 · אימות קלט · שגיאות רועשות ============== */
{
  throwsCode('7.1 הצבה לאדם שאינו בסגל',
    () => plan({ postings: { 'uid-ghost': { '2026-09-02': 'timna' } } }),
    'posting-person-unknown');
  throwsCode('7.2 ⭐ הצבה בתאריך שאינו בהרצה נדחית ולא נבלעת',
    () => plan({ postings: { 'uid-eldad': { '2026-10-02': 'timna' } } }),
    'posting-date-outside-period');
  throwsCode('7.3 הצבה לתחנת קצה שאינה בתקן',
    () => plan({ postings: { 'uid-eldad': { '2026-09-02': 'yotvata' } } }),
    'posting-sub-station-unknown');
  throwsCode('7.4 תאריך לא תקין',
    () => plan({ postings: { 'uid-eldad': { '2.9.2026': 'timna' } } }),
    'posting-date');
  throwsCode('7.5 מפה שאינה אובייקט',
    () => plan({ postings: [] }), 'postings-shape');
  throwsCode('7.6 הצבות של אדם שאינן אובייקט',
    () => plan({ postings: { 'uid-eldad': 'timna' } }), 'posting-shape');
  throwsCode('7.7 תחנה ריקה',
    () => plan({ postings: { 'uid-eldad': { '2026-09-02': '' } } }),
    'posting-sub-station-unknown');

  // הצבה לתחנת הבית עצמה — חוקית וחסרת השפעה.
  const same = plan({ postings: { 'uid-eldad': { '2026-09-02': 'rashit' } } });
  eq('7.8 הצבה לתחנת הבית אינה משנה דבר',
    at(same, '2026-09-02', 'rashit'), ['uid-eldad']);
}

/* ===== 8 · ⭐⭐ הלולאה נסגרת · posting_map מ-schedule-placement ===== */
{
  const planner = P.createPlacementPlanner({ clock: () => Date.UTC(2026, 8, 1) });
  const req = planner.planPlacement({
    policy: {
      station_id: station,
      min_gap_days: 0,
      max_shifts_per_month: null,
      rotation: null,
      sub_stations: POLICY.sub_stations
    },
    roster: [
      { id: 'uid-eldad', sub_station: 'rashit', group: null, active: true, roles: ['driver'] },
      { id: 'uid-noa', sub_station: 'timna', group: null, active: true, roles: ['driver'] }
    ],
    request: {
      subject: { kind: 'member', person: 'uid-eldad' },
      sub_station: 'timna', role: 'driver',
      span: { kind: 'single_shift' }, anchor_date: '2026-09-02',
      actor_uid: 'uid-manager', request_id: 'req-posting-1'
    }
  });

  eq('8.1 המתכנן זיהה הצבה', req.posting !== null, true);
  eq('8.2 והוא עדיין מסמן שהמנוע אינו מקבל אותה מעצמו',
    req.posting.engine_accepts_today, false);
  eq('8.3 המפה שהוא הפיק',
    req.posting_map, { 'uid-eldad': { '2026-09-02': 'timna' } });

  // ⭐ המפה נמסרת למנוע **כמות שהיא**, בלי תרגום.
  const r = plan({ postings: req.posting_map,
    locked: { timna: { '2026-09-02': [req.overrides[0].person] } } });

  const row = r.rows.filter(
    x => x.date === '2026-09-02' && x.sub_station === 'timna')[0];
  eq('8.4 ⭐⭐ המנוע קיבל את המפה של המתכנן ללא תרגום',
    row.rejected_manual.length, 0);
  eq('8.5 והאדם משובץ', row.slots.map(s => s.person).indexOf('uid-eldad') !== -1, true);

  // vacates מהמתכנן חוזה בדיוק את החוסר שהמנוע ייצר.
  eq('8.6 ⭐ vacates חזה את תחנת הבית שתתרוקן',
    req.vacates.map(v => v.date + '/' + v.sub_station), ['2026-09-02/rashit']);
  eq('8.7 ⭐ והמנוע אכן מדווח שם חוסר',
    gapsAt(r, '2026-09-02', 'rashit'), ['driver']);
}

/* ================ 9 · טענות על מקור המנוע ================ */
{
  ok('9.1 ⭐ blockCode מודד מול תחנה אפקטיבית ליום',
    engineSrc.includes('effectiveSub(ctx.postings, person, ctx.date) !== ctx.sub'));
  ok('9.2 ⭐ ומאגרי ההיצע — המקום השני — מכירים הצבות',
    /function buildIndexes\(byId, postings\)/.test(engineSrc)
    && !/^\s*const sub = person\.sub_station;$/m.test(engineSrc));
  ok('9.3 postings עדיין שדה רשות — קלט ישן ממשיך לרוץ',
    /if \(raw === undefined \|\| raw === null\) return null;/.test(engineSrc));
  ok('9.4 ⭐ אבל כל מה שנמסר נאכף',
    engineSrc.includes("'posting-person-unknown'")
    && engineSrc.includes("'posting-date-outside-period'")
    && engineSrc.includes("'posting-sub-station-unknown'"));
  ok('9.5 השיוך הארגוני עצמו לא נגוע — אין כתיבה ל-sub_station',
    !/person\.sub_station\s*=/.test(engineSrc));
}

/* ==================== 10 · מוטציות ==================== */
{
  const tmp = join(__TESTS, '_mut_posting.cjs');
  function mutate(from, to, label, exercise) {
    if (engineSrc.indexOf(from) === -1) { ok(label, false, 'טקסט לא נמצא'); return; }
    fs.writeFileSync(tmp, engineSrc.split(from).join(to));
    let caught = false;
    try {
      delete require_.cache[require_.resolve(tmp)];
      exercise(require_(tmp));
    } catch (e) { caught = true; }
    fs.unlinkSync(tmp);
    ok(label, caught, 'המוטציה עברה בלי שאיש שם לב');
  }
  const build = (M) => M.createCalendarEngine({
    clock: () => '2026-09-01T00:00:00.000Z', policy: POLICY });
  const run = (eng, extra) => eng.planPeriod(Object.assign({
    station_id: station, source_snapshot: snapshot, source_version: version,
    contract_station_id: station, source_revision: revision,
    source_digest: sourceDigest, policy_digest: policyDigest,
    source_complete: true, availability: {}, locked: {}, carry: {},
    days: DAYS, roster: ROSTER }, extra || {}));

  mutate('const posted = forPerson[date];\n    return isNonEmptyString(posted) ? posted : person.sub_station;',
    'return person.sub_station;',
    '10.1 ⭐⭐ effectiveSub שמתעלם מההצבה — נתפס',
    (M) => {
      const r = run(build(M), { postings: { 'uid-eldad': { '2026-09-02': 'timna' } } });
      const row = r.rows.filter(x => x.date === '2026-09-02' && x.sub_station === 'timna')[0];
      if (row.slots.map(s => s.person).indexOf('uid-eldad') === -1) throw new Error('caught');
    });

  mutate('        if (subs.indexOf(posted) === -1) subs.push(posted);',
    '        if (false) subs.push(posted);',
    '10.2 ⭐⭐ מאגרי ההיצע שמפסיקים להכיר הצבה — נתפס',
    (M) => {
      const r = run(build(M), { postings: { 'uid-eldad': { '2026-09-02': 'timna' } } });
      const row = r.rows.filter(x => x.date === '2026-09-02' && x.sub_station === 'timna')[0];
      if (row.slots.map(s => s.person).indexOf('uid-eldad') === -1) throw new Error('caught');
    });

  mutate("        if (!plannedDates.has(date)) {", "        if (false) {",
    '10.3 ⭐ הצבה מחוץ להרצה שנבלעת בשקט — נתפס',
    (M) => {
      run(build(M), { postings: { 'uid-eldad': { '2026-10-02': 'timna' } } });
      throw new Error('caught');
    });

  mutate("      if (!person) {\n        throw new CalendarError('posting-person-unknown'",
    "      if (false) {\n        throw new CalendarError('posting-person-unknown'",
    '10.4 הצבה לאדם שאינו בסגל שנבלעת — נתפס',
    (M) => {
      run(build(M), { postings: { 'uid-ghost': { '2026-09-02': 'timna' } } });
      throw new Error('caught');
    });

  // הסינון של active ב-buildIndexes הוא הגנה בעומק ולא האכיפה:
  // blockCode בודק אותו שוב בכל מועמד. לכן המוטציה המשמעותית
  // היא על blockCode, ולא על המאגר — הסרת הסינון מהמאגר אינה
  // משנה תוצאה, ומוטציה שם הייתה „נתפסת" מהסיבה הלא נכונה.
  mutate("    if (person.active !== true) return REASON.INACTIVE;",
    "    if (false) return REASON.INACTIVE;",
    '10.5 ⭐ אדם לא פעיל שמתחיל להיות משובץ — נתפס',
    (M) => {
      const roster3 = [person('uid-eldad', 'rashit'), person('uid-noa', 'timna')];
      roster3[0].active = false;
      const r = build(M).planPeriod({
        station_id: station, source_snapshot: snapshot, source_version: version,
        contract_station_id: station, source_revision: revision,
        source_digest: sourceDigest, policy_digest: policyDigest,
        source_complete: true, availability: {}, locked: {}, carry: {},
        days: DAYS, roster: roster3,
        postings: { 'uid-eldad': { '2026-09-02': 'timna' } } });
      const row = r.rows.filter(x => x.date === '2026-09-02'
        && x.sub_station === 'timna')[0];
      if (row.slots.map(s => s.person).indexOf('uid-eldad') === -1) {
        throw new Error('caught');
      }
    });

  mutate("      if (subs.indexOf(posted) === -1) subs.push(posted);\n        }\n      }\n      for (const sub of subs) {",
    "      if (subs.indexOf(posted) === -1) subs.push(posted);\n        }\n      }\n      for (const sub of [subs[0]]) {",
    '10.6 ⭐ מאגר שחוזר לתחנת הבית בלבד — נתפס',
    (M) => {
      const r = run(build(M), { postings: { 'uid-eldad': { '2026-09-02': 'timna' } } });
      const row = r.rows.filter(x => x.date === '2026-09-02'
        && x.sub_station === 'timna')[0];
      if (row.slots.map(s => s.person).indexOf('uid-eldad') === -1) {
        throw new Error('caught');
      }
    });
}

/* ---------------------------- סיכום ---------------------------- */
console.log('');
console.log('schedule-posting · הצבה זמנית בתחנת קצה אחרת');
console.log('עברו ' + pass + ' · נפלו ' + fail);
if (fail) {
  console.log('');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
process.exit(0);
