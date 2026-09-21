'use strict';

/* ======================================================================
 *  hr-monthly-summary — מה הדוח סופר, ומה הוא מסרב להציג
 *
 *  ארבע הטענות שהקובץ הזה מוכיח:
 *
 *  **1 · רק מה שאושר נספר כמאושר.** דיווח ממתין נספר בנפרד, דיווח
 *  שנדחה אינו נספר כלל, והספירה היא ימים **בתוך החודש** ולא ימים
 *  בדיווח.
 *
 *  **2 · דור חלקי אינו מוצג.** לא „לא מוצג בדרך כלל" — אין לו דרך
 *  להיות מוצג: הקריאה הולכת לדור הפעיל, וההפעלה מסרבת לדור שאינו שלם.
 *
 *  **3 · ריצה חוזרת עם אותה כוונה היא אותו דור.** לא דור שני, ולא
 *  שורות כפולות.
 *
 *  **4 · מה שלא נכנס לדוח.** אין בו uid של מכריע, אין נתיב Storage,
 *  והסף מגיע מהתחנה ולא מקובע בקוד.
 *
 *  מה **אינו** נבדק כאן: כללי Firestore (אמולטור — NOT RUN) ודרישות
 *  אינדקס. הכפיל מגיש כל צורת שאילתה; Firestore לא.
 * ====================================================================== */

const assert = require('node:assert/strict');
const { fakeDb, FakeHttpsError } = require('./hr-pilot-test-harness');
const module_ = require('./hr-monthly-summary');
const { createHrMonthlySummary, daysInMonth, monthBounds, DEFAULT_HOUR_LIMIT, USER_PAGE, READ_PAGE } = module_;

const SID = 'station_102';
const OTHER = 'station_7';
const MONTH = '2026-09';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log('✓ ' + name); }
  catch (error) { failures.push(name); console.log('✗ ' + name + ' — ' + error.message); }
}
async function rejects(promise, code) {
  try { await promise; }
  catch (error) {
    assert.equal(error.code, code, 'expected ' + code + ' but got ' + error.code + ': ' + error.message);
    return error;
  }
  assert.fail('expected a ' + code + ' rejection, but the call succeeded');
}

function world(sid = SID) {
  const db = fakeDb();
  let clock = Date.parse('2026-10-01T03:00:00Z');
  const summary = createHrMonthlySummary({ db, HttpsError: FakeHttpsError, clock: () => (clock += 1000) });
  return { db, summary, sid };
}
/** עובד עם רשומת תחנה, ואופציונלית דוח שעות. */
function employee(w, uid, { emp, name, crew, hours, status = 'approved' } = {}) {
  w.db._put('stations/' + w.sid + '/users/' + uid, { stationId: w.sid, role: 'firefighter',
    active: true, employee_number: emp || ('E' + uid), full_name: name || ('עובד ' + uid), crew: crew || 'משמרת א' });
  if (hours !== undefined) {
    w.db._put('stations/' + w.sid + '/monthly_reports/' + (emp || ('E' + uid)) + '_' + MONTH,
      { emp_number: emp || ('E' + uid), month: MONTH, total_hours: hours, status });
  }
  return uid;
}
/** דיווח היעדרות כפי שהשרת כותב אותו, כולל months. */
function absence(w, id, uid, kind, from, to, decision) {
  const months = [];
  let year = Number(from.slice(0, 4)), month = Number(from.slice(5, 7));
  const last = to.slice(0, 7);
  for (let guard = 0; guard < 24; guard += 1) {
    const key = String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0');
    months.push(key);
    if (key === last) break;
    month += 1; if (month > 12) { month = 1; year += 1; }
  }
  w.db._put('stations/' + w.sid + '/hr_requests/' + id, {
    schema: 'hr-request-v1', case_id: id, station_id: w.sid, owner_uid: uid, subject: 'דיווח',
    status: 'open', revision: 1, created_at_ms: 1, updated_at_ms: 1,
    kind, from_date: from, to_date: to, months, decision,
    ...(decision === 'approved' || decision === 'rejected'
      ? { decided_by: 'hr-uid-should-never-reach-a-row', decided_at_ms: 2 } : {}) });
}
function longCase(w, id, uid, start, end) {
  w.db._put('stations/' + w.sid + '/hr_workforce_cases/' + id, {
    schema: 'hr-workforce-case-v1', record_id: id, station_id: w.sid, owner_uid: uid,
    kind: 'long_absence', status: 'active', start_date: start,
    ...(end === undefined ? {} : { end_date: end }) });
}
const rowOf = async (w, uid, month = MONTH) => {
  const page = await w.summary.read({ station_id: w.sid, month });
  return page.rows.find(r => r.uid === uid) || null;
};

async function main() {

  /* ---------- 1 · חיתוך הימים ---------- */

  await test('a range that starts in the previous month contributes only its days in this month', () => {
    assert.deepEqual(daysInMonth('2026-08-28', '2026-09-03', '2026-09'), ['2026-09-01', '2026-09-02', '2026-09-03']);
    assert.equal(daysInMonth('2026-08-28', '2026-09-03', '2026-08').length, 4);
  });

  await test('a range entirely outside the month contributes nothing', () => {
    assert.deepEqual(daysInMonth('2026-07-01', '2026-07-05', '2026-09'), []);
  });

  await test('a range that swallows the whole month contributes every one of its days', () => {
    assert.equal(daysInMonth('2026-01-01', '2026-12-31', '2026-02').length, monthBounds('2026-02').days);
    assert.equal(monthBounds('2026-02').days, 28);
  });

  await test('a malformed or inverted range is skipped, not thrown', () => {
    assert.deepEqual(daysInMonth('not-a-date', '2026-09-03', '2026-09'), []);
    assert.deepEqual(daysInMonth('2026-09-05', '2026-09-01', '2026-09'), []);
  });

  /* ---------- 2 · מה נספר ---------- */

  await test('approved sickness days land in the approved column', async () => {
    const w = world(); employee(w, 'u1', { hours: 180 });
    absence(w, 'a1', 'u1', 'sick', '2026-09-10', '2026-09-12', 'approved');
    await w.summary.build({ station_id: SID, month: MONTH });
    const row = await rowOf(w, 'u1');
    assert.equal(row.approved_sick_days, 3);
    assert.equal(row.pending_sick_days, 0);
  });

  /* ⭐ זו הדרישה המרכזית: ממתין אינו מאושר, בשום עמודה. */
  await test('a pending report is counted separately and never as approved', async () => {
    const w = world(); employee(w, 'u1', { hours: 180 });
    absence(w, 'a1', 'u1', 'sick', '2026-09-10', '2026-09-12', 'pending');
    await w.summary.build({ station_id: SID, month: MONTH });
    const row = await rowOf(w, 'u1');
    assert.equal(row.approved_sick_days, 0);
    assert.equal(row.pending_sick_days, 3);
  });

  await test('a rejected report is counted nowhere at all', async () => {
    const w = world(); employee(w, 'u1', { hours: 180 });
    absence(w, 'a1', 'u1', 'vacation', '2026-09-10', '2026-09-12', 'rejected');
    await w.summary.build({ station_id: SID, month: MONTH });
    const row = await rowOf(w, 'u1');
    assert.equal(row.approved_vacation_days, 0);
    assert.equal(row.pending_vacation_days, 0);
  });

  await test('each kind lands in its own column and never in another', async () => {
    const w = world(); employee(w, 'u1', { hours: 180 });
    absence(w, 'a1', 'u1', 'sick', '2026-09-01', '2026-09-02', 'approved');
    absence(w, 'a2', 'u1', 'reserve', '2026-09-05', '2026-09-09', 'approved');
    absence(w, 'a3', 'u1', 'vacation', '2026-09-20', '2026-09-20', 'approved');
    absence(w, 'a4', 'u1', 'extended_absence', '2026-09-25', '2026-09-27', 'approved');
    await w.summary.build({ station_id: SID, month: MONTH });
    const row = await rowOf(w, 'u1');
    assert.deepEqual([row.approved_sick_days, row.approved_reserve_days,
      row.approved_vacation_days, row.approved_extended_absence_days], [2, 5, 1, 3]);
  });

  await test('two overlapping approved reports of the same kind are not counted twice', async () => {
    const w = world(); employee(w, 'u1', { hours: 180 });
    absence(w, 'a1', 'u1', 'sick', '2026-09-10', '2026-09-12', 'approved');
    absence(w, 'a2', 'u1', 'sick', '2026-09-11', '2026-09-14', 'approved');
    await w.summary.build({ station_id: SID, month: MONTH });
    assert.equal((await rowOf(w, 'u1')).approved_sick_days, 5);
  });

  await test('a report that spans a month boundary contributes only the days inside the month', async () => {
    const w = world(); employee(w, 'u1', { hours: 180 });
    absence(w, 'a1', 'u1', 'reserve', '2026-08-28', '2026-09-03', 'approved');
    await w.summary.build({ station_id: SID, month: MONTH });
    assert.equal((await rowOf(w, 'u1')).approved_reserve_days, 3);
  });

  /* ---------- 3 · היעדרות ממושכת, מהמסלול שלה ---------- */

  await test('an open-ended workforce case appears even though its end date is absent', async () => {
    const w = world(); employee(w, 'u1', { hours: 40 });
    longCase(w, 'c1', 'u1', '2026-05-01', undefined);
    await w.summary.build({ station_id: SID, month: MONTH });
    const row = await rowOf(w, 'u1');
    assert.equal(row.long_absence.open_ended, true);
    assert.equal(row.long_absence.start_date, '2026-05-01');
  });

  await test('an explicitly null end date is open-ended too, and a range filter would have dropped it', async () => {
    const w = world(); employee(w, 'u1', { hours: 40 });
    longCase(w, 'c1', 'u1', '2026-05-01', null);
    await w.summary.build({ station_id: SID, month: MONTH });
    assert.equal((await rowOf(w, 'u1')).long_absence.open_ended, true);
  });

  await test('a closed workforce case that ended before the month does not appear', async () => {
    const w = world(); employee(w, 'u1', { hours: 180 });
    longCase(w, 'c1', 'u1', '2026-03-01', '2026-04-01');
    await w.summary.build({ station_id: SID, month: MONTH });
    assert.equal((await rowOf(w, 'u1')).long_absence, null);
  });

  await test('a case that starts after the month does not appear either', async () => {
    const w = world(); employee(w, 'u1', { hours: 180 });
    longCase(w, 'c1', 'u1', '2026-11-01', undefined);
    await w.summary.build({ station_id: SID, month: MONTH });
    assert.equal((await rowOf(w, 'u1')).long_absence, null);
  });

  /* ---------- 4 · שעות והסף ---------- */

  await test('hours come from the stored monthly report, and a missing report is null not zero', async () => {
    const w = world(); employee(w, 'u1', { hours: 212.5 }); employee(w, 'u2');
    await w.summary.build({ station_id: SID, month: MONTH });
    assert.equal((await rowOf(w, 'u1')).total_hours, 212.5);
    assert.equal((await rowOf(w, 'u1')).hours_state, 'approved');
    const missing = await rowOf(w, 'u2');
    assert.equal(missing.total_hours, null);
    assert.equal(missing.hours_state, 'missing');
    assert.equal(missing.over_hour_limit, false);
  });

  /* ⭐ הסף הוא של התחנה. סף אחד קשיח בקוד היה מפר את „hrConfig לכל
   * תחנה" בשקט, ובדיוק זה מה שהבדיקה הזו מונעת. */
  await test('the over-limit flag uses the station threshold, not a constant in the code', async () => {
    const w = world(); employee(w, 'u1', { hours: 200 });
    w.db._put('stations/' + SID + '/config/hr', { hour_limit: 180 });
    await w.summary.build({ station_id: SID, month: MONTH });
    const row = await rowOf(w, 'u1');
    assert.equal(row.hour_limit, 180);
    assert.equal(row.over_hour_limit, true);
    assert.notEqual(row.hour_limit, DEFAULT_HOUR_LIMIT);
  });

  await test('without a station threshold the platform default applies and is stated in the row', async () => {
    const w = world(); employee(w, 'u1', { hours: 200 });
    await w.summary.build({ station_id: SID, month: MONTH });
    const row = await rowOf(w, 'u1');
    assert.equal(row.hour_limit, DEFAULT_HOUR_LIMIT);
    assert.equal(row.over_hour_limit, false);
  });

  await test('the over-limit flag is a note and carries no decision or block of any kind', async () => {
    const w = world(); employee(w, 'u1', { hours: 300 });
    await w.summary.build({ station_id: SID, month: MONTH });
    const row = await rowOf(w, 'u1');
    assert.equal(row.over_hour_limit, true);
    for (const key of ['decision', 'blocked', 'approved', 'schedule_blocked', 'publication_blocked']) {
      assert.equal(Object.hasOwn(row, key), false, key + ' has no business in a monitoring row');
    }
  });

  /* ---------- 5 · מה אינו בשורה ---------- */

  await test('a row never carries the uid of whoever decided, nor a storage path', async () => {
    const w = world(); employee(w, 'u1', { hours: 180 });
    absence(w, 'a1', 'u1', 'sick', '2026-09-10', '2026-09-12', 'approved');
    await w.summary.build({ station_id: SID, month: MONTH });
    const row = await rowOf(w, 'u1');
    const text = JSON.stringify(row);
    assert.equal(text.includes('hr-uid-should-never-reach-a-row'), false, text);
    assert.equal(/stations\/[a-z0-9_-]+\/attachments/.test(text), false, text);
    assert.equal(Object.hasOwn(row, 'decided_by'), false);
  });

  /* ---------- 6 · דור חלקי אינו מוצג ---------- */

  await test('before any build the report is not_built, with no rows and no invented zeros', async () => {
    const w = world(); employee(w, 'u1', { hours: 180 });
    const out = await w.summary.read({ station_id: SID, month: MONTH });
    assert.equal(out.state, 'not_built');
    assert.deepEqual(out.rows, []);
    assert.equal(out.next_cursor, null);
  });

  await test('a generation that exists but is not complete is never published', async () => {
    const w = world(); employee(w, 'u1', { hours: 180 });
    const begun = await w.summary.beginGeneration({ station_id: SID, month: MONTH, intent_id: 'partial' });
    await rejects(w.summary.activate({ station_id: SID, month: MONTH, generation_id: begun.generation_id }, {}),
      'failed-precondition');
    assert.equal((await w.summary.read({ station_id: SID, month: MONTH })).state, 'not_built');
  });

  /* ⭐ והצד השני של אותה עובדה: תקציב שנגמר משאיר דור פתוח, ולא
   * חודש חצי-מוצג. */
  await test('an exhausted budget leaves the month unpublished rather than half published', async () => {
    const db = fakeDb();
    let clock = Date.parse('2026-10-01T03:00:00Z');
    const summary = createHrMonthlySummary({ db, HttpsError: FakeHttpsError, clock: () => (clock += 60000) });
    const w = { db, summary, sid: SID };
    employee(w, 'u1', { hours: 180 });
    const out = await summary.build({ station_id: SID, month: MONTH, budget_ms: 1000 });
    assert.equal(out.complete, false);
    assert.equal(out.activated, false);
    assert.equal(out.reason, 'budget_exhausted');
    assert.equal((await summary.read({ station_id: SID, month: MONTH })).state, 'not_built');
  });

  /* ---------- 7 · idempotency ---------- */

  await test('the same intent is the same generation, and a re-run adds no second one', async () => {
    const w = world(); employee(w, 'u1', { hours: 180 });
    const first = await w.summary.build({ station_id: SID, month: MONTH, intent_id: MONTH });
    const second = await w.summary.build({ station_id: SID, month: MONTH, intent_id: MONTH });
    assert.equal(second.generation_id, first.generation_id);
    assert.equal(second.reason, 'already_active');
    assert.equal(second.activated, false);
    const generations = [...w.db._store.keys()]
      .filter(p => p.includes('/hr_monthly_generations/') && !p.includes('/hr_monthly_rows/'));
    assert.equal(generations.length, 1, generations.join('\n'));
  });

  await test('a re-run does not duplicate rows either', async () => {
    const w = world(); employee(w, 'u1', { hours: 180 }); employee(w, 'u2', { hours: 190 });
    await w.summary.build({ station_id: SID, month: MONTH, intent_id: MONTH });
    await w.summary.build({ station_id: SID, month: MONTH, intent_id: MONTH });
    const rows = [...w.db._store.keys()].filter(p => p.includes('/hr_monthly_rows/'));
    assert.equal(rows.length, 2);
    assert.equal((await w.summary.read({ station_id: SID, month: MONTH })).rows.length, 2);
  });

  /* ⭐ כוונה אחרת — הרצה ידנית, או הפקה מחדש אחרי שינוי הכרעה —
   * מייצרת דור חדש, והוא מוחלף רק כשהוא שלם. */
  await test('a decision change re-published under a new intent replaces the active generation', async () => {
    const w = world(); employee(w, 'u1', { hours: 180 });
    absence(w, 'a1', 'u1', 'sick', '2026-09-10', '2026-09-12', 'pending');
    const first = await w.summary.build({ station_id: SID, month: MONTH, intent_id: MONTH });
    assert.equal((await rowOf(w, 'u1')).approved_sick_days, 0);
    const path = 'stations/' + SID + '/hr_requests/a1';
    w.db._put(path, { ...w.db._get(path), decision: 'approved',
      decided_by: 'hr-uid-should-never-reach-a-row', decided_at_ms: 3 });
    const second = await w.summary.build({ station_id: SID, month: MONTH, intent_id: 'rerun-after-decision' });
    assert.notEqual(second.generation_id, first.generation_id);
    assert.equal(second.activated, true);
    assert.equal((await rowOf(w, 'u1')).approved_sick_days, 3);
    assert.notEqual(second.source_digest, first.source_digest);
  });

  await test('the source digest records what the report was built from, and moves when that moves', async () => {
    const w = world(); employee(w, 'u1', { hours: 180 });
    const first = await w.summary.build({ station_id: SID, month: MONTH, intent_id: 'one' });
    absence(w, 'a1', 'u1', 'sick', '2026-09-10', '2026-09-12', 'approved');
    const second = await w.summary.build({ station_id: SID, month: MONTH, intent_id: 'two' });
    assert.notEqual(second.source_digest, first.source_digest);
    const head = await w.summary.read({ station_id: SID, month: MONTH });
    assert.equal(head.source_digest, second.source_digest);
    assert.equal(head.sources.hr_requests, 1);
    assert.equal(head.delivery, 'in_app_only');
  });

  /* ---------- 8 · כיסוי ---------- */

  await test('coverage is legacy_pending until the backfill records that it finished', async () => {
    const w = world(); employee(w, 'u1', { hours: 180 });
    await w.summary.build({ station_id: SID, month: MONTH, intent_id: 'a' });
    assert.equal((await w.summary.read({ station_id: SID, month: MONTH })).coverage, 'legacy_pending');
    w.db._put('stations/' + SID + '/hr_request_counters/hr-months-backfill-v1',
      { schema: 'hr-months-backfill-v1', completed_at_ms: 1789000000000, scanned: 12, classified: 3 });
    await w.summary.build({ station_id: SID, month: MONTH, intent_id: 'b' });
    assert.equal((await w.summary.read({ station_id: SID, month: MONTH })).coverage, 'complete');
  });

  /* ⭐ „הסתיים" אינו „שלם". סריקה שנגמרה והשאירה דיווחים
   * שאי אפשר לסווג אינה כיסוי שלם, והדוח אינו אומר שהוא שלם.
   * הבדיקה הזו נוספה אחרי שבדיקת המוטציה גילתה שהתנאי השני
   * ב-`coverageOf` לא נבדק בכלל: הסרתו לא הפילה שום דבר. */
  await test('a finished scan that left leftovers is not complete coverage', async () => {
    const w = world(); employee(w, 'u1', { hours: 180 });
    w.db._put('stations/' + SID + '/hr_request_counters/hr-months-backfill-v1',
      { schema: 'hr-months-backfill-v1', completed_at_ms: 1789000000000,
        totals: { scanned: 40, classified: 38, unclassifiable: 2, conflicting: 0 } });
    await w.summary.build({ station_id: SID, month: MONTH, intent_id: 'leftovers' });
    assert.equal((await w.summary.read({ station_id: SID, month: MONTH })).coverage, 'legacy_pending');
    // וגם סתירה אחת מספיקה.
    w.db._put('stations/' + SID + '/hr_request_counters/hr-months-backfill-v1',
      { schema: 'hr-months-backfill-v1', completed_at_ms: 1789000000000,
        totals: { scanned: 40, classified: 39, unclassifiable: 0, conflicting: 1 } });
    await w.summary.build({ station_id: SID, month: MONTH, intent_id: 'conflicting' });
    assert.equal((await w.summary.read({ station_id: SID, month: MONTH })).coverage, 'legacy_pending');
  });

  /* ⭐ דיווח בלי `months` אינו נמצא בשאילתה, וזו בדיוק הסיבה שהדוח
   * חייב לומר שהכיסוי אינו שלם ולא להציג את עצמו כשלם. */
  await test('a legacy report with no months field is invisible to the query, and the report says so', async () => {
    const w = world(); employee(w, 'u1', { hours: 180 });
    w.db._put('stations/' + SID + '/hr_requests/legacy', { schema: 'hr-request-v1', case_id: 'legacy',
      station_id: SID, owner_uid: 'u1', subject: 'דיווח ישן', status: 'open', revision: 1,
      created_at_ms: 1, updated_at_ms: 1, kind: 'sick', from_date: '2026-09-01', to_date: '2026-09-05',
      decision: 'approved', decided_by: 'hr-uid-should-never-reach-a-row', decided_at_ms: 2 });
    await w.summary.build({ station_id: SID, month: MONTH, intent_id: 'a' });
    const head = await w.summary.read({ station_id: SID, month: MONTH });
    assert.equal((await rowOf(w, 'u1')).approved_sick_days, 0);
    assert.equal(head.coverage, 'legacy_pending');
  });

  /* ---------- 9 · עמודים, ולא מסמך אחד ---------- */

  await test('more employees than one page produce more than one slice and one row document each', async () => {
    const w = world();
    const total = USER_PAGE + 7;
    for (let index = 0; index < total; index += 1) {
      employee(w, 'u' + String(index).padStart(4, '0'), { hours: 100 + index });
    }
    const out = await w.summary.build({ station_id: SID, month: MONTH, intent_id: 'paged' });
    assert.equal(out.complete, true);
    assert.ok(out.slices >= 2, 'slices ' + out.slices);
    assert.equal(out.written, total);
    const rows = [...w.db._store.keys()].filter(p => p.includes('/hr_monthly_rows/'));
    assert.equal(rows.length, total);
    const page = await w.summary.read({ station_id: SID, month: MONTH });
    assert.equal(page.rows.length, READ_PAGE);
    assert.equal(typeof page.next_cursor, 'string');
    assert.equal(page.total_rows, total);
    let seen = page.rows.length, cursor = page.next_cursor, guard = 0;
    while (cursor && guard < 30) {
      const next = await w.summary.read({ station_id: SID, month: MONTH, cursor });
      seen += next.rows.length; cursor = next.next_cursor; guard += 1;
    }
    assert.equal(seen, total);
  });

  /* ---------- 10 · בידוד תחנות ---------- */

  await test('two stations do not mix: neither rows nor absences cross', async () => {
    const a = world(SID), b = world(OTHER);
    employee(a, 'u1', { hours: 180 });
    employee(b, 'u9', { hours: 190 });
    absence(a, 'a1', 'u1', 'sick', '2026-09-10', '2026-09-12', 'approved');
    absence(b, 'b1', 'u9', 'sick', '2026-09-01', '2026-09-20', 'approved');
    await a.summary.build({ station_id: SID, month: MONTH });
    await b.summary.build({ station_id: OTHER, month: MONTH });
    const rowsA = (await a.summary.read({ station_id: SID, month: MONTH })).rows;
    const rowsB = (await b.summary.read({ station_id: OTHER, month: MONTH })).rows;
    assert.deepEqual(rowsA.map(r => r.uid), ['u1']);
    assert.deepEqual(rowsB.map(r => r.uid), ['u9']);
    assert.equal(rowsA[0].approved_sick_days, 3);
    assert.equal(rowsB[0].approved_sick_days, 20);
  });

  /* ⭐ שאילתת ההיעדרויות היא לפי תחנה. דיווח שנשמר תחת התחנה הזו אך
   * נושא מזהה תחנה אחר נפסל ואינו נספר. */
  await test('an absence document carrying another station id is refused, not counted', async () => {
    const w = world(); employee(w, 'u1', { hours: 180 });
    w.db._put('stations/' + SID + '/hr_requests/foreign', { schema: 'hr-request-v1', case_id: 'foreign',
      station_id: OTHER, owner_uid: 'u1', subject: 'זר', status: 'open', revision: 1,
      created_at_ms: 1, updated_at_ms: 1, kind: 'sick', from_date: '2026-09-01', to_date: '2026-09-09',
      months: [MONTH], decision: 'approved', decided_by: 'x', decided_at_ms: 2 });
    await w.summary.build({ station_id: SID, month: MONTH });
    assert.equal((await rowOf(w, 'u1')).approved_sick_days, 0);
    assert.equal((await w.summary.read({ station_id: SID, month: MONTH })).sources.hr_requests_malformed, 1);
  });

  /* ---------- 11 · שלושת המצבים של חריגת השעות ---------- */

  await test('with no report at all the answer is not_built, and it is not clear', async () => {
    const w = world(); employee(w, 'u1', { hours: 300 });
    const out = await w.summary.overHours({ station_id: SID, month: MONTH });
    assert.equal(out.state, 'not_built');
    assert.deepEqual(out.over_employees, []);
    assert.notEqual(out.state, 'clear');
  });

  await test('with a report and nobody over the threshold the answer is clear, said explicitly', async () => {
    const w = world(); employee(w, 'u1', { hours: 100 });
    await w.summary.build({ station_id: SID, month: MONTH });
    const out = await w.summary.overHours({ station_id: SID, month: MONTH });
    assert.equal(out.state, 'clear');
    assert.deepEqual(out.over_employees, []);
    assert.equal(out.hour_limit, DEFAULT_HOUR_LIMIT);
  });

  await test('with a report and somebody over the threshold the list names them without a uid', async () => {
    const w = world();
    employee(w, 'u1', { hours: 300, name: 'דנה לוי', emp: '4410', crew: 'משמרת ב' });
    employee(w, 'u2', { hours: 100 });
    await w.summary.build({ station_id: SID, month: MONTH });
    const out = await w.summary.overHours({ station_id: SID, month: MONTH });
    assert.equal(out.state, 'over');
    assert.equal(out.over_employees.length, 1);
    assert.deepEqual(out.over_employees[0], { employee_number: '4410', full_name: 'דנה לוי',
      crew: 'משמרת ב', total_hours: 300 });
    assert.equal(Object.hasOwn(out.over_employees[0], 'uid'), false);
  });

  /* ---------- 12 · גבולות הקלט והתקרות ---------- */

  await test('the absence bound is a declared number and the reader counts what it read', async () => {
    const w = world(); employee(w, 'u1', { hours: 180 });
    assert.equal(module_.ABSENCE_CAP, 5000);
    for (let index = 0; index <= 12; index += 1) {
      absence(w, 'a' + String(index).padStart(3, '0'), 'u1', 'sick', '2026-09-01', '2026-09-02', 'approved');
    }
    const out = await w.summary.absenceIndex(SID, MONTH);
    assert.equal(out.seen, 13);
  });

  await test('a station or month that is not one is refused, never guessed', async () => {
    const w = world();
    for (const bad of ['', 'A', '../other', 'x'.repeat(200), null, 7]) {
      await rejects(w.summary.read({ station_id: bad, month: MONTH }), 'invalid-argument');
    }
    for (const bad of ['2026-13', '2026-9', 'september', '', null]) {
      await rejects(w.summary.read({ station_id: SID, month: bad }), 'invalid-argument');
    }
  });

  console.log('');
  console.log('NOT RUN here — Firestore rules enforcement (emulator) and composite-index');
  console.log('requirements. Every query in this module is a single equality or a single');
  console.log('array-contains, which the automatic single-field index serves; that is a');
  console.log('property of the code, not something this file proved.');
  console.log('');
  if (failures.length) {
    console.error(failures.length + ' monthly summary checks failed.');
    process.exit(1);
  }
  console.log(passed + ' monthly summary checks passed.');
}

main();
