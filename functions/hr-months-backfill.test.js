'use strict';

/* ======================================================================
 *  hr-months-backfill — כלי מיגרציה שברירת המחדל שלו אינה כותבת
 *
 *  שלוש הטענות:
 *
 *  **1 · dry-run הוא ברירת המחדל.** קריאה בלי `dry_run: false` סופרת
 *  ואינה כותבת. זו אינה נוחות — מיגרציה שרצה בטעות היא נזק בלי „בטל".
 *
 *  **2 · הסיווג אינו פעולה על הפנייה.** `revision`, `updated_at_ms`
 *  ושורות היומן אינם נוגעים. פנייה שגרסתה זזה הייתה מפילה כל CAS
 *  פתוח במסך, ושורת יומן מסוג חדש הייתה פוסלת את כל הפנייה בקריאה.
 *
 *  **3 · „הסתיים" אינו „שלם".** הקבלה מסמנת סיום רק כשלא נשאר דיווח
 *  שאי אפשר לסווג או שמסווג בסתירה, ולכן `coverage` בדוח החודשי אינו
 *  הופך ל-`complete` על סריקה שהשאירה שאריות.
 *
 *  מה אינו נבדק כאן: הרצה מול Firestore אמיתי. הכלי **לא הורץ על
 *  שום פרויקט Firebase**, וההרצה על ייצור היא פעולת ייצור בפני עצמה.
 * ====================================================================== */

const assert = require('node:assert/strict');
const { fakeDb, FakeHttpsError } = require('./hr-pilot-test-harness');
const { createHrMonthsBackfill, DEFAULT_LIMIT, AUDIT_RUNS } = require('./hr-months-backfill');
const { createHrMonthlySummary } = require('./hr-monthly-summary');

const SID = 'station_102';
const OTHER = 'station_7';
const ACTOR = 'super-uid';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log('✓ ' + name); }
  catch (error) { failures.push(name); console.log('✗ ' + name + ' — ' + error.message); }
}
async function rejects(promise, code) {
  try { await promise; }
  catch (error) { assert.equal(error.code, code, 'got ' + error.code); return error; }
  assert.fail('expected a ' + code + ' rejection');
}

function world(sid = SID) {
  const db = fakeDb();
  let clock = Date.parse('2026-10-05T06:00:00Z');
  const tool = createHrMonthsBackfill({ db, HttpsError: FakeHttpsError, clock: () => (clock += 1000) });
  const summary = createHrMonthlySummary({ db, HttpsError: FakeHttpsError, clock: () => (clock += 1000) });
  return { db, tool, summary, sid };
}
/** דיווח כפי שהוא נראה לפני שהשדה קיים: בלי months. */
function legacy(w, id, over = {}) {
  w.db._put('stations/' + w.sid + '/hr_requests/' + id, {
    schema: 'hr-request-v1', case_id: id, station_id: w.sid, owner_uid: 'u1', subject: 'דיווח ישן',
    status: 'open', revision: 4, created_at_ms: 100, updated_at_ms: 200,
    kind: 'sick', from_date: '2026-08-28', to_date: '2026-09-03', decision: 'approved',
    decided_by: 'hr', decided_at_ms: 300, ...over });
  return 'stations/' + w.sid + '/hr_requests/' + id;
}
const doc = (w, id) => w.db._get('stations/' + w.sid + '/hr_requests/' + id);
const receipt = w => w.db._get('stations/' + w.sid + '/hr_request_counters/hr-months-backfill-v1');

async function main() {

  /* ---------- 1 · ברירת המחדל אינה כותבת ---------- */

  await test('a call with no dry_run flag at all writes nothing', async () => {
    const w = world(); legacy(w, 'a1');
    const out = await w.tool.run({ station_id: SID, actor_uid: ACTOR });
    assert.equal(out.dry_run, true);
    assert.equal(out.classified, 0);
    assert.equal(out.would_classify, 1);
    assert.equal(Object.hasOwn(doc(w, 'a1'), 'months'), false);
  });

  await test('dry_run true is the same, and it is explicit about what it would do', async () => {
    const w = world(); legacy(w, 'a1'); legacy(w, 'a2');
    const out = await w.tool.run({ station_id: SID, actor_uid: ACTOR, dry_run: true });
    assert.equal(out.would_classify, 2);
    assert.equal(Object.hasOwn(doc(w, 'a2'), 'months'), false);
  });

  /* ⭐ רק `false` מפורש כותב. כל ערך אחר נשאר יובש. */
  await test('only an explicit false writes; anything else stays dry', async () => {
    for (const value of [undefined, true, null, 0, 'false']) {
      const w = world(); legacy(w, 'a1');
      const out = await w.tool.run({ station_id: SID, actor_uid: ACTOR,
        ...(value === undefined ? {} : { dry_run: value }) });
      assert.equal(out.dry_run, true, JSON.stringify(value));
      assert.equal(Object.hasOwn(doc(w, 'a1'), 'months'), false, JSON.stringify(value));
    }
  });

  /* ---------- 2 · מה שכן נכתב ---------- */

  await test('a real run writes exactly the months the range derives', async () => {
    const w = world(); legacy(w, 'a1');
    const out = await w.tool.run({ station_id: SID, actor_uid: ACTOR, dry_run: false });
    assert.equal(out.classified, 1);
    assert.deepEqual(doc(w, 'a1').months, ['2026-08', '2026-09']);
  });

  /* ⭐ והשדה שנכתב עובר את הבדיקה של השרת עצמו — כלומר הוא לא
   * „דומה" לגזירה, הוא הגזירה. */
  await test('the field it writes is the one the report can find and the service accepts', async () => {
    const w = world(); legacy(w, 'a1');
    await w.tool.run({ station_id: SID, actor_uid: ACTOR, dry_run: false });
    w.db._put('stations/' + SID + '/users/u1', { stationId: SID, role: 'firefighter', active: true,
      employee_number: 'E1', full_name: 'עובד', crew: 'א' });
    await w.summary.build({ station_id: SID, month: '2026-09' });
    const page = await w.summary.read({ station_id: SID, month: '2026-09' });
    assert.equal(page.rows[0].approved_sick_days, 3);
  });

  await test('the request revision, timestamps and history are untouched', async () => {
    const w = world(); legacy(w, 'a1');
    const before = { ...doc(w, 'a1') };
    await w.tool.run({ station_id: SID, actor_uid: ACTOR, dry_run: false });
    const after = doc(w, 'a1');
    assert.equal(after.revision, before.revision);
    assert.equal(after.updated_at_ms, before.updated_at_ms);
    assert.equal(after.created_at_ms, before.created_at_ms);
    assert.equal(after.status, before.status);
    assert.equal(after.decision, before.decision);
    const events = [...w.db._store.keys()].filter(p => p.includes('/hr_requests/a1/events/'));
    assert.deepEqual(events, [], 'a derived key is not a logged action on the request');
  });

  await test('a second real run classifies nothing and changes nothing', async () => {
    const w = world(); legacy(w, 'a1');
    await w.tool.run({ station_id: SID, actor_uid: ACTOR, dry_run: false });
    const snapshot = JSON.stringify(doc(w, 'a1'));
    const out = await w.tool.run({ station_id: SID, actor_uid: ACTOR, dry_run: false });
    assert.equal(out.classified, 0);
    assert.equal(out.already, 1);
    assert.equal(JSON.stringify(doc(w, 'a1')), snapshot);
  });

  /* ---------- 3 · מה שאינו נוגע ---------- */

  await test('a general request is left alone and counted as untouched', async () => {
    const w = world();
    w.db._put('stations/' + SID + '/hr_requests/g1', { schema: 'hr-request-v1', case_id: 'g1',
      station_id: SID, owner_uid: 'u1', subject: 'שאלה', status: 'open', revision: 1,
      created_at_ms: 1, updated_at_ms: 1, kind: 'general' });
    const out = await w.tool.run({ station_id: SID, actor_uid: ACTOR, dry_run: false });
    assert.equal(out.untouched, 1);
    assert.equal(out.classified, 0);
    assert.equal(Object.hasOwn(doc(w, 'g1'), 'months'), false);
  });

  /* ⭐ היעדרות שחורגת מהתקרה אינה מסווגת, ואינה מוסתרת: היא נספרת,
   * והספירה היא מה שמונע מהדוח להכריז על כיסוי שלם. */
  await test('an absence longer than the declared bound is counted, not classified', async () => {
    const w = world();
    legacy(w, 'long', { from_date: '2024-01-01', to_date: '2026-12-31' });
    const out = await w.tool.run({ station_id: SID, actor_uid: ACTOR, dry_run: false });
    assert.equal(out.unclassifiable, 1);
    assert.equal(out.classified, 0);
    assert.equal(Object.hasOwn(doc(w, 'long'), 'months'), false);
  });

  await test('a months value that contradicts the range is reported and never overwritten', async () => {
    const w = world();
    legacy(w, 'bad', { months: ['2026-01'] });
    const out = await w.tool.run({ station_id: SID, actor_uid: ACTOR, dry_run: false });
    assert.equal(out.conflicting, 1);
    assert.equal(out.classified, 0);
    assert.deepEqual(doc(w, 'bad').months, ['2026-01']);
  });

  await test('a document of another station stored under this one is refused, not rewritten', async () => {
    const w = world();
    legacy(w, 'foreign', { station_id: OTHER });
    const out = await w.tool.run({ station_id: SID, actor_uid: ACTOR, dry_run: false });
    assert.equal(out.malformed, 1);
    assert.equal(Object.hasOwn(doc(w, 'foreign'), 'months'), false);
  });

  /* ---------- 4 · עמודים ---------- */

  await test('the scan is paged and only the last page reports done', async () => {
    const w = world();
    for (let index = 0; index < 5; index += 1) legacy(w, 'a' + index);
    const first = await w.tool.run({ station_id: SID, actor_uid: ACTOR, dry_run: false, limit: 2 });
    assert.equal(first.done, false);
    assert.equal(first.scanned, 2);
    assert.equal(typeof first.next_cursor, 'string');
    const second = await w.tool.run({ station_id: SID, actor_uid: ACTOR, dry_run: false, limit: 2, cursor: first.next_cursor });
    assert.equal(second.done, false);
    const third = await w.tool.run({ station_id: SID, actor_uid: ACTOR, dry_run: false, limit: 2, cursor: second.next_cursor });
    assert.equal(third.done, true);
    assert.equal(third.scanned, 1);
    for (let index = 0; index < 5; index += 1) {
      assert.deepEqual(doc(w, 'a' + index).months, ['2026-08', '2026-09'], 'a' + index);
    }
  });

  await test('the default page size is the declared one', async () => {
    assert.equal(DEFAULT_LIMIT, 100);
    const w = world(); legacy(w, 'a1');
    const out = await w.tool.run({ station_id: SID, actor_uid: ACTOR });
    assert.equal(out.done, true);
  });

  /* ---------- 5 · הקבלה, והכיסוי שהיא שולטת בו ---------- */

  await test('a finished clean run marks completion, and the report then says complete', async () => {
    const w = world(); legacy(w, 'a1');
    w.db._put('stations/' + SID + '/users/u1', { stationId: SID, role: 'firefighter', active: true,
      employee_number: 'E1', full_name: 'עובד', crew: 'א' });
    await w.tool.run({ station_id: SID, actor_uid: ACTOR, dry_run: false });
    assert.ok(Number.isSafeInteger(receipt(w).completed_at_ms));
    await w.summary.build({ station_id: SID, month: '2026-09', intent_id: 'after-backfill' });
    assert.equal((await w.summary.read({ station_id: SID, month: '2026-09' })).coverage, 'complete');
  });

  /* ⭐ זו הטענה שמפרידה בין „הסתיים" ל„שלם". */
  await test('a finished run that left something unclassifiable does not claim completion', async () => {
    const w = world();
    legacy(w, 'a1');
    legacy(w, 'long', { from_date: '2024-01-01', to_date: '2026-12-31' });
    w.db._put('stations/' + SID + '/users/u1', { stationId: SID, role: 'firefighter', active: true,
      employee_number: 'E1', full_name: 'עובד', crew: 'א' });
    const out = await w.tool.run({ station_id: SID, actor_uid: ACTOR, dry_run: false });
    assert.equal(out.done, true);
    assert.equal(out.unclassifiable, 1);
    assert.equal(Object.hasOwn(receipt(w), 'completed_at_ms'), false);
    await w.summary.build({ station_id: SID, month: '2026-09', intent_id: 'after-partial-backfill' });
    assert.equal((await w.summary.read({ station_id: SID, month: '2026-09' })).coverage, 'legacy_pending');
  });

  await test('a dry run never marks completion and never moves the totals', async () => {
    const w = world(); legacy(w, 'a1');
    await w.tool.run({ station_id: SID, actor_uid: ACTOR, dry_run: true });
    const value = receipt(w);
    assert.equal(Object.hasOwn(value, 'completed_at_ms'), false);
    assert.deepEqual(value.totals, {});
    assert.equal(value.runs.length, 1);
    assert.equal(value.runs[0].dry_run, true);
  });

  await test('the audit records who ran it, when, whether it was dry, and what it counted', async () => {
    const w = world(); legacy(w, 'a1');
    await w.tool.run({ station_id: SID, actor_uid: ACTOR, dry_run: false });
    const row = receipt(w).runs.at(-1);
    assert.equal(row.actor_uid, ACTOR);
    assert.equal(row.dry_run, false);
    assert.equal(row.classified, 1);
    assert.ok(Number.isSafeInteger(row.at_ms));
    const status = await w.tool.status({ station_id: SID });
    assert.equal(status.state, 'complete');
    assert.equal(status.totals.classified, 1);
  });

  await test('the audit list is bounded and keeps the most recent runs', async () => {
    const w = world(); legacy(w, 'a1');
    for (let index = 0; index < AUDIT_RUNS + 5; index += 1) {
      await w.tool.run({ station_id: SID, actor_uid: ACTOR + '-' + index, dry_run: true });
    }
    const runs = receipt(w).runs;
    assert.equal(runs.length, AUDIT_RUNS);
    assert.equal(runs.at(-1).actor_uid, ACTOR + '-' + (AUDIT_RUNS + 4));
  });

  await test('status before any run says so plainly instead of implying a clean result', async () => {
    const w = world();
    const status = await w.tool.status({ station_id: SID });
    assert.equal(status.state, 'never_run');
    assert.equal(status.totals, null);
    assert.equal(status.completed_at_ms, null);
  });

  /* ---------- 6 · שערי קלט ---------- */

  await test('an actor is required, because an audit row without one is not an audit row', async () => {
    const w = world(); legacy(w, 'a1');
    await rejects(w.tool.run({ station_id: SID, dry_run: false }), 'invalid-argument');
    assert.equal(Object.hasOwn(doc(w, 'a1'), 'months'), false);
  });

  await test('a station that is not a station id is refused', async () => {
    const w = world();
    for (const bad of ['', 'A', '../x', null, 7]) {
      await rejects(w.tool.run({ station_id: bad, actor_uid: ACTOR }), 'invalid-argument');
      await rejects(w.tool.status({ station_id: bad }), 'invalid-argument');
    }
  });

  await test('two stations keep separate receipts and separate scans', async () => {
    const a = world(SID), b = world(OTHER);
    legacy(a, 'a1'); legacy(b, 'b1');
    await a.tool.run({ station_id: SID, actor_uid: ACTOR, dry_run: false });
    assert.deepEqual(doc(a, 'a1').months, ['2026-08', '2026-09']);
    assert.equal(b.db._get('stations/' + SID + '/hr_request_counters/hr-months-backfill-v1'), undefined);
    assert.equal(Object.hasOwn(doc(b, 'b1'), 'months'), false);
    assert.equal((await b.tool.status({ station_id: OTHER })).state, 'never_run');
  });

  console.log('');
  console.log('NOT RUN — this tool against a real Firestore, and against production. It has');
  console.log('never been executed on any Firebase project. Running it on station-102 is a');
  console.log('production action that needs its own explicit approval.');
  console.log('');
  if (failures.length) {
    console.error(failures.length + ' backfill checks failed.');
    process.exit(1);
  }
  console.log(passed + ' backfill checks passed.');
}

main();
