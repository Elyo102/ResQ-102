'use strict';

/* ייבוא הגיליון — בדיקות יחידה על הדבקה סינתטית בצורת הגיליון הקיים
 * (שמות מומצאים; המבנה: שורת תאריכים, שורת אותיות יום, בלוקים עם תווית
 * בעמודה הראשונה — בהדבקה תא ממוזג מוסר את ערכו בשורה הראשונה — אזור
 * חופשי בלי תווית מתחת לתחנות, ושורות היעדרות). */
const assert = require('node:assert/strict');
const S = require('./schedule-sheet-import');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('✓ ' + name); }

const POLICY = { sub_stations: {
  eilat: { label: 'אילת', minimum: 7 }, shahmon: { label: 'שחמון', minimum: 0 },
  timna: { label: 'תמנע', minimum: 0 }, yotvata: { label: 'יטבתה', minimum: 0 }
} };
const PEOPLE = [
  { id: 'u1', full_name: 'רועי כהן', active: true, sub_station: 'eilat' },
  { id: 'u2', full_name: 'דניאל לוי', active: true, sub_station: 'eilat', aliases: ['דני'] },
  { id: 'u3', full_name: 'יוסי מזרחי', active: true, sub_station: 'shahmon' },
  { id: 'u4', full_name: 'עמית פרץ', active: true, sub_station: 'timna' },
  { id: 'u5', full_name: 'גיא ברק', active: true, sub_station: 'yotvata', schedule_name: 'גיא' },
  { id: 'u6', full_name: 'רועי אברהם', active: true, sub_station: 'eilat' }   // „רועי" לבד — דו-משמעי
];

// עמודה 0 = תוויות; עמודות 1–3 = 1.9, 2.9, 3.9; עמודה 4 = חודש אחר (לא נכלל).
function row(cells) { return cells.join('\t'); }
const SHEET = [
  row(['', '1/9', '2/9', '3/9/26', '1/10']),
  row(['', 'ג', 'ד', 'ה', 'ו']),
  row(['אילת', 'רועי כהן', 'דני', 'דניאל לוי', 'רועי כהן']),   // תא ממוזג — התווית בשורה הראשונה
  row(['', 'דניאל לוי', 'רועי', 'רועי כהן', '']),
  row(['', '', '', 'יוסי מזרחי', '']),
  row(['שחמון', 'יוסי מזרחי', 'יוסי מזרחי', '', '']),
  row(['תמנע', 'עמית פרץ', '', 'עמית פרץ', '']),
  row(['יטבתה', 'גיא', 'גיא', '', '']),
  row(['', 'אבטחה', 'סיור', '', '']),                // אזור חופשי בלי תווית — נבלע ביטבתה עד השעה
  row(['', '17:45-08:00', 'אבטחה 06:00-17:00', '', '']),
  row(['', 'דני + גיא', 'רועי כהן', '', '']),        // אחרי השעה — מדולג ומדווח
  row(['מחלה', 'עמית פרץ', 'עמית פרץ', '', '']),
  row(['', '', 'יוסי מזרחי', '', '']),
  row(['קורסים', '', '', 'גיא', '']),
  row(['באילת', 'דני', '', 'דניאל לוי', '']),
  row(['חופש חול', '', 'רועי כהן', '', '']),
  row(['בצפון', 'יוסי מזרחי, גיא', '', '', ''])
].join('\n');

test('שורת התאריכים והעמודות: רק החודש המבוקש, עם או בלי שנה', () => {
  const p = S.parseSheet(SHEET, { month: '2026-09', policy: POLICY });
  assert.deepEqual(p.dates, ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.equal(p.date_row, 1);
  assert.equal(p.label_column, 1);
  assert.equal(p.labels_on_top, true);
  assert.equal(S.parseDateCell('7/9/26', '2026-09'), '2026-09-07');
  assert.equal(S.parseDateCell('07.09.2026', '2026-09'), '2026-09-07');
  assert.equal(S.parseDateCell('2026-09-07', '2026-09'), '2026-09-07');
  assert.equal(S.parseDateCell('31/9', '2026-09'), null);
  assert.equal(S.parseDateCell('7/9/25', '2026-09'), null, 'שנה אחרת אינה החודש');
  assert.throws(() => S.parseSheet(SHEET, { month: '2026-11', policy: POLICY }), { code: 'dates-not-found' });
  assert.throws(() => S.parseSheet('', { month: '2026-09' }), { code: 'paste-empty' });
  assert.throws(() => S.parseSheet(SHEET, { month: '9/2026' }), { code: 'month-invalid' });
});

test('תוויות: תחנות מהמדיניות, היעדרויות לפי מילה ומיקום, „אילת" לבד אינה חופש', () => {
  assert.equal(S.stationForLabel('אילת', POLICY), 'eilat');
  assert.equal(S.stationForLabel('תחנת שחמון', POLICY), 'shahmon');
  assert.equal(S.stationForLabel('yotvata', POLICY), 'yotvata');
  assert.equal(S.stationForLabel('אבטחה', POLICY), null);
  assert.deepEqual(S.absenceLabel('מחלה'), { kind: 'sick', location: null });
  assert.deepEqual(S.absenceLabel('מילואים'), { kind: 'reserve', location: null });
  assert.deepEqual(S.absenceLabel('קורסים'), { kind: 'course', location: null });
  assert.deepEqual(S.absenceLabel('באילת'), { kind: 'leave', location: 'eilat' });
  assert.deepEqual(S.absenceLabel('חופש אילת'), { kind: 'leave', location: 'eilat' });
  assert.deepEqual(S.absenceLabel('בצפון'), { kind: 'leave', location: 'north' });
  assert.deepEqual(S.absenceLabel('חו"ל'), { kind: 'leave', location: 'abroad' });
  assert.deepEqual(S.absenceLabel('חופש חול'), { kind: 'leave', location: 'abroad' });
  assert.deepEqual(S.absenceLabel('חופש'), { kind: 'leave', location: null });
  assert.equal(S.absenceLabel('אילת'), null);
  assert.equal(S.absenceLabel(''), null);
});

test('בלוקים: תחנה נגמרת בשורת השעה הראשונה; מה שאחריה מדווח ולא מיובא', () => {
  const p = S.parseSheet(SHEET, { month: '2026-09', policy: POLICY });
  const yotvata = p.blocks.find((b) => b.sub_station === 'yotvata');
  assert.deepEqual(yotvata.rows, [8, 9], 'יטבתה כוללת גם את שורת „אבטחה/סיור" (בלי שעה) — והיא תדווח כשם לא מזוהה');
  const ignored = p.blocks.filter((b) => b.kind === 'ignored' && b.names > 0);
  assert.equal(ignored.length, 1);
  assert.deepEqual(ignored[0].rows, [10, 11]);
  assert.equal(ignored[0].after, 'יטבתה');
  assert.ok(p.warnings.some((w) => w.code === 'block-ignored' && w.rows[0] === 10));
  assert.deepEqual(S.namesInCell('דני + גיא'), ['דני', 'גיא']);
  assert.deepEqual(S.namesInCell('יוסי מזרחי, גיא'), ['יוסי מזרחי', 'גיא']);
  assert.deepEqual(S.namesInCell('17:45-08:00'), []);
  assert.deepEqual(S.namesInCell('אבטחה 06:00-17:00'), ['אבטחה 06:00-17:00']);
});

test('פענוח: שיבוצים לכל תחנה ותאריך (גם ריקים), כינויים, unresolved, כפילויות, קו', () => {
  const p = S.parseSheet(SHEET, { month: '2026-09', policy: POLICY });
  const r = S.resolveSheet(p, { people: PEOPLE, policy: POLICY, station_id: 'eilat_102' });
  assert.equal(r.rows.length, 3 * 4, 'שורה לכל תאריך × תחנה');
  const at = (sub, date) => r.rows.find((x) => x.sub_station === sub && x.date === date);
  assert.deepEqual(at('eilat', '2026-09-01').slots.map((s) => s.person), ['u1', 'u2']);
  assert.deepEqual(at('eilat', '2026-09-02').slots.map((s) => s.person), ['u2'], '„רועי" לבד דו-משמעי — לא נכנס');
  assert.deepEqual(at('eilat', '2026-09-03').slots.map((s) => s.person), ['u2', 'u1', 'u3'], 'סדר הגיליון נשמר (דניאל לפני רועי); יוסי בשורה 5 שייך לבלוק אילת (תא ממוזג)');
  assert.deepEqual(at('shahmon', '2026-09-03').slots, []);
  assert.deepEqual(at('yotvata', '2026-09-01').slots.map((s) => s.person), ['u5'], 'schedule_name');
  assert.equal(at('eilat', '2026-09-01').below_minimum, true, '2 < קו 7');
  assert.equal(at('eilat', '2026-09-01').minimum, 7);
  assert.equal(at('eilat', '2026-09-01').complete, true, 'הקו אינו חוסם ייבוא');
  assert.equal(at('shahmon', '2026-09-03').below_minimum, false, 'קו 0 = אין קו');
  assert.equal(at('eilat', '2026-09-01').slots[0].source, 'imported');
  assert.equal(at('eilat', '2026-09-01').label, 'אילת');
  assert.equal(at('eilat', '2026-09-01').station_id, 'eilat_102');
  assert.equal(at('eilat', '2026-09-01').rotation_group, null);
  const names = r.unresolved.map((u) => u.name);
  assert.ok(names.includes('רועי') && names.includes('אבטחה') && names.includes('סיור'));
  assert.deepEqual(r.unresolved.find((u) => u.name === 'רועי').candidates, ['u1', 'u6']);
  assert.ok(!names.includes('דני'), 'כינוי מהמקור מזוהה');
  assert.deepEqual(r.duplicates, [{ uid: 'u3', date: '2026-09-01', blocks: ['shahmon'] }].filter(() => false), 'אין כפילות: יוסי ב-1.9 רק בשחמון');
  assert.equal(r.counts.assignments, 2 + 1 + 3 + 1 + 1 + 1 + 1 + 1 + 1);
  assert.equal(r.counts.below_minimum, 3, 'אילת מתחת לקו בכל שלושת הימים');
});

test('היעדרויות: סוג ומיקום, כינויים, ומה שלא זוהה מדווח', () => {
  const p = S.parseSheet(SHEET, { month: '2026-09', policy: POLICY });
  const r = S.resolveSheet(p, { people: PEOPLE, policy: POLICY, station_id: 'eilat_102' });
  assert.deepEqual(r.absences, [
    { date: '2026-09-01', uid: 'u2', kind: 'leave', location: 'eilat' },
    { date: '2026-09-01', uid: 'u3', kind: 'leave', location: 'north' },
    { date: '2026-09-01', uid: 'u4', kind: 'sick' },
    { date: '2026-09-01', uid: 'u5', kind: 'leave', location: 'north' },
    { date: '2026-09-02', uid: 'u1', kind: 'leave', location: 'abroad' },
    { date: '2026-09-02', uid: 'u3', kind: 'sick' },
    { date: '2026-09-02', uid: 'u4', kind: 'sick' },
    { date: '2026-09-03', uid: 'u2', kind: 'leave', location: 'eilat' },
    { date: '2026-09-03', uid: 'u5', kind: 'course' }
  ]);
  assert.equal(r.counts.absences, 9);
});

test('סדר הגיליון נשמר בשיבוצים — לא מיון לפי מזהה (419-review §3)', () => {
  const sheet = [row(['', '1/9', '2/9', '3/9']), row(['', 'ג', 'ד', 'ה']),
    row(['אילת', 'יוסי מזרחי', '', '']), row(['', 'רועי כהן', '', '']), row(['', 'דניאל לוי', '', ''])].join('\n');
  const r = S.resolveSheet(S.parseSheet(sheet, { month: '2026-09', policy: POLICY }), { people: PEOPLE, policy: POLICY, station_id: 's' });
  assert.deepEqual(r.rows.find((x) => x.sub_station === 'eilat' && x.date === '2026-09-01').slots.map((s) => s.person), ['u3', 'u1', 'u2']);
});

test('תחנה בלי בלוק בהדבקה — חסרה ומדווחת, לא „ריקה"; תא ענק — מדווח ולא נחתך', () => {
  const sheet = [row(['', '1/9', '2/9', '3/9']), row(['', 'ג', 'ד', 'ה']),
    row(['אילת', 'רועי כהן', '', 'רועי כהן'])].join('\n');
  const r = S.resolveSheet(S.parseSheet(sheet, { month: '2026-09', policy: POLICY }), { people: PEOPLE, policy: POLICY, station_id: 's' });
  assert.deepEqual(r.missing_stations.map((m) => m.sub_station), ['shahmon', 'timna', 'yotvata']);
  assert.equal(r.counts.missing_stations, 3);
  assert.deepEqual(r.rows.map((x) => x.sub_station), ['eilat', 'eilat', 'eilat'], 'אין שורות לתחנות חסרות');
  assert.deepEqual(r.rows.find((x) => x.date === '2026-09-02').slots, [], 'אילת ב-2.9 — תא ריק בבלוק קיים = „אף אחד" מאומת');
  const many = Array.from({ length: 41 }, (_, i) => 'שם' + i).join(', ');
  const big = [row(['', '1/9', '2/9', '3/9']), row(['', 'ג', 'ד', 'ה']), row(['אילת', many, 'רועי כהן', ''])].join('\n');
  const p = S.parseSheet(big, { month: '2026-09', policy: POLICY });
  assert.ok(p.warnings.some((w) => w.code === 'cell-too-many-names' && w.row === 3 && w.date === '2026-09-01'));
  const rb = S.resolveSheet(p, { people: PEOPLE, policy: POLICY, station_id: 's' });
  assert.equal(rb.counts.oversized_cells, 1);
  assert.deepEqual(rb.rows.find((x) => x.date === '2026-09-01').slots, [], 'התא הגדול לא יובא בכלל — לא 40 מתוך 41');
  assert.equal(S.namesInCell(many), null);
  assert.equal(S.namesInCell(Array.from({ length: 40 }, (_, i) => 'ש' + i).join(',')).length, 40);
});

test('כפילות: אותו אדם בשתי תחנות באותו יום — מדווח, לא נבחר בשקט', () => {
  const sheet = [
    row(['', '1/9', '2/9', '3/9']), row(['', 'ג', 'ד', 'ה']),
    row(['אילת', 'רועי כהן', '', '']), row(['שחמון', 'רועי כהן', 'רועי כהן', ''])
  ].join('\n');
  const r = S.resolveSheet(S.parseSheet(sheet, { month: '2026-09', policy: POLICY }), { people: PEOPLE, policy: POLICY, station_id: 's' });
  assert.deepEqual(r.duplicates, [{ uid: 'u1', date: '2026-09-01', blocks: ['eilat', 'shahmon'] }]);
  assert.equal(r.counts.duplicates, 1);
});

test('כינויים שנמסרו מצמצמים דו-משמעות; כינוי למזהה שאינו במקור — מתעלמים', () => {
  const p = S.parseSheet(SHEET, { month: '2026-09', policy: POLICY });
  const r = S.resolveSheet(p, { people: PEOPLE, policy: POLICY, station_id: 's', aliases: { 'רועי': 'u6', 'אבטחה': 'ghost' } });
  const eilat2 = r.rows.find((x) => x.sub_station === 'eilat' && x.date === '2026-09-02');
  assert.deepEqual(eilat2.slots.map((s) => s.person), ['u2', 'u6']);
  assert.ok(!r.unresolved.some((u) => u.name === 'רועי'));
  assert.ok(r.unresolved.some((u) => u.name === 'אבטחה'), 'כינוי למזהה לא קיים אינו נספר');
});

test('תוויות בתחתית הבלוק (הדבקה שבה הערך בשורה האחרונה) — אותו פענוח', () => {
  const sheet = [
    row(['', '1/9', '2/9', '3/9']), row(['', 'ג', 'ד', 'ה']),
    row(['', 'רועי כהן', 'דני', '']),
    row(['אילת', 'דניאל לוי', '', '']),
    row(['', 'יוסי מזרחי', '', '']),
    row(['שחמון', '', 'יוסי מזרחי', '']),
    row(['מחלה', 'עמית פרץ', '', ''])
  ].join('\n');
  const p = S.parseSheet(sheet, { month: '2026-09', policy: POLICY });
  assert.equal(p.labels_on_top, false);
  const r = S.resolveSheet(p, { people: PEOPLE, policy: POLICY, station_id: 's' });
  const at = (sub, date) => r.rows.find((x) => x.sub_station === sub && x.date === date).slots.map((s) => s.person);
  assert.deepEqual(at('eilat', '2026-09-01'), ['u1', 'u2']);
  assert.deepEqual(at('shahmon', '2026-09-01'), ['u3']);
  assert.deepEqual(r.absences, [{ date: '2026-09-01', uid: 'u4', kind: 'sick' }]);
});

test('גבולות: הדבקה ענקית ותאריך כפול נדחים; בלי מדיניות אין פענוח', () => {
  assert.throws(() => S.parseSheet(new Array(401).fill('a\tb').join('\n'), { month: '2026-09' }), { code: 'paste-too-many-rows' });
  assert.throws(() => S.parseSheet(row(['', '1/9', '1/9', '2/9', '3/9']), { month: '2026-09' }), { code: 'date-duplicate' });
  const p = S.parseSheet(SHEET, { month: '2026-09', policy: POLICY });
  assert.throws(() => S.resolveSheet(p, { people: PEOPLE, station_id: 's' }), { code: 'policy-required' });
  assert.throws(() => S.resolveSheet(p, { people: PEOPLE, policy: POLICY }), { code: 'station-required' });
  // מפתחות שמורים כשמות — לא ירושה.
  const weird = S.resolveSheet(S.parseSheet(row(['', '1/9', '2/9', '3/9']) + '\n' + row(['אילת', '__proto__', 'constructor', '']), { month: '2026-09', policy: POLICY }),
    { people: PEOPLE, policy: POLICY, station_id: 's' });
  assert.deepEqual(weird.unresolved.map((u) => u.name).sort(), ['__proto__', 'constructor']);
  assert.equal(({}).polluted, undefined);
});

console.log('\n' + passed + ' sheet-import checks passed.');
