'use strict';

/* ======================================================================
 *  hr-monthly-scale — 3,000 עובדים, כי זה המספר שהוכרע
 *
 *  ----------------------------------------------------------------
 *  למה קובץ נפרד
 *  ----------------------------------------------------------------
 *  בדיקות היחידה של הדוח רצות על עשרות עובדים ובודקות **משמעות**:
 *  מה נספר, מה לא, מה מוצג. הקובץ הזה בודק דבר אחר לגמרי — **צורה
 *  בקנה מידה**: שהדוח מתחלק לפרוסות, ששורה היא מסמך, שהקריאה
 *  מעומדת, ושהסמן יציב. הוא איטי יותר ולכן הוא לא בשרשרת המהירה.
 *
 *  ----------------------------------------------------------------
 *  ⭐ מה באמת נבדק כאן
 *  ----------------------------------------------------------------
 *  ההכרעה הייתה „3,000 עובדים לא ייכנסו למסמך אחד ולא ייטענו בעמוד
 *  אחד". שתי הטענות האלה אינן נבדקות על 107 עובדים: 107 שורות עוד
 *  נכנסות למסמך של 1 MiB, ולכן בדיקה על 107 אינה מבחינה בין „מדורג"
 *  ל„סתם עבד".
 *
 *  לכן כאן: 3,000 שורות, **3,000 מסמכים נפרדים**, 30 פרוסות בנייה,
 *  120 עמודי קריאה של 25, וסמן שממשיך מהמקום הנכון בכל אחד מהם —
 *  בלי לדלג על שורה ובלי להחזיר אותה פעמיים.
 *
 *  ובנוסף: **מספר הקריאות המקובצות גדל עם הפרוסות ולא עם העובדים.**
 *  קריאה אחת לכל עמוד בנייה, לא אחת לעובד. זו הטענה שהופכת „אין
 *  N+1" ממשפט למספר.
 *
 *  ----------------------------------------------------------------
 *  מה זה אינו
 *  ----------------------------------------------------------------
 *  זה כפיל בזיכרון. הוא אינו מודד זמן ריצה אמיתי של Firestore, אינו
 *  אוכף תקרת מסמך של 1 MiB בפועל, ואינו אומר דבר על עלות. הוא מוכיח
 *  את **הצורה**: מסמך לעובד, פרוסות לבנייה, עמודים לקריאה.
 * ====================================================================== */

const assert = require('node:assert/strict');
const { fakeDb, FakeHttpsError } = require('./hr-pilot-test-harness');
const { createHrMonthlySummary, USER_PAGE, READ_PAGE } = require('./hr-monthly-summary');

const SID = 'station_102';
const MONTH = '2026-09';
const TOTAL = 3000;

let passed = 0;
const failures = [];
async function test(name, fn) {
  const at = Date.now();
  try { await fn(); passed += 1; console.log('✓ ' + name + ' (' + (Date.now() - at) + 'ms)'); }
  catch (error) { failures.push(name); console.log('✗ ' + name + ' — ' + error.message); }
}

function station() {
  const db = fakeDb();
  let clock = Date.parse('2026-10-01T03:00:00Z');
  const summary = createHrMonthlySummary({ db, HttpsError: FakeHttpsError, clock: () => (clock += 1000) });
  for (let index = 0; index < TOTAL; index += 1) {
    const uid = 'u' + String(index).padStart(5, '0');
    const emp = 'E' + String(index).padStart(5, '0');
    db._put('stations/' + SID + '/users/' + uid, { stationId: SID, role: 'firefighter', active: true,
      employee_number: emp, full_name: 'עובד ' + index, crew: 'משמרת ' + 'אבג'[index % 3] });
    // שליש מהעובדים בלי דוח שעות, כדי שהשורות לא תהיינה אחידות.
    if (index % 3 !== 0) {
      db._put('stations/' + SID + '/monthly_reports/' + emp + '_' + MONTH,
        { emp_number: emp, month: MONTH, total_hours: 100 + (index % 200), status: 'approved' });
    }
    // היעדרות מאושרת לכל עשירי, כדי שהשאילתה לא תחזור ריקה.
    if (index % 10 === 0) {
      db._put('stations/' + SID + '/hr_requests/a' + String(index).padStart(5, '0'), {
        schema: 'hr-request-v1', case_id: 'a' + index, station_id: SID, owner_uid: uid,
        subject: 'דיווח', status: 'open', revision: 1, created_at_ms: 1, updated_at_ms: 1,
        kind: 'sick', from_date: '2026-09-10', to_date: '2026-09-12', months: [MONTH],
        decision: 'approved', decided_by: 'hr', decided_at_ms: 2 });
    }
  }
  return { db, summary };
}

async function main() {

  const w = station();

  await test('three thousand employees build into three thousand row documents, in slices', async () => {
    w.db._resetCounts();
    const out = await w.summary.build({ station_id: SID, month: MONTH, intent_id: MONTH, budget_ms: 600000 });
    assert.equal(out.complete, true);
    assert.equal(out.activated, true);
    assert.equal(out.written, TOTAL);
    /* 3,000 / 100 = 30 פרוסות שכותבות, ועוד אחת שמגלה שנגמר.
     *
     * הפרוסה ה-31 אינה בזבוז שנשכח: 3,000 הוא כפולה מדויקת של 100,
     * ולכן העמוד ה-30 חוזר מלא — ועמוד מלא אינו אומר „זה הסוף".
     * סמן בלי ספירה מוקדמת חייב שאילתה אחת נוספת כדי לדעת. הבדיקה
     * נועצת 31 בדיוק ולא „לכל היותר", כדי שחזרה לחיתוך לפי עובד
     * (3,000 פרוסות) או למסמך אחד (פרוסה אחת) תיפול כאן. */
    assert.equal(out.slices, Math.ceil(TOTAL / USER_PAGE) + 1, 'slices ' + out.slices);
    const rows = [...w.db._store.keys()].filter(p => p.includes('/hr_monthly_rows/'));
    assert.equal(rows.length, TOTAL, 'row documents ' + rows.length);
    // ⭐ ואף אחד מהם אינו המסמך של החודש: הכותרת נשארת קטנה.
    const head = w.db._get('stations/' + SID + '/hr_monthly_summaries/' + MONTH);
    assert.equal(Object.hasOwn(head, 'rows_data'), false);
    assert.ok(JSON.stringify(head).length < 2000, 'month header size ' + JSON.stringify(head).length);
  });

  /* ⭐ קריאה מקובצת אחת לכל פרוסה — 30 — ולא אחת לעובד. אם מישהו
   * יחליף את `getAll` בלולאה של `get`, המספר יעלה ל-3,000 והבדיקה
   * תיפול. זה ההבדל בין „אין N+1" כטענה לבין „אין N+1" כמספר. */
  await test('batched reads grow with the slices, not with the employees', async () => {
    assert.equal(w.db._counts.getAll, Math.ceil(TOTAL / USER_PAGE), JSON.stringify(w.db._counts));
    assert.equal(w.db._counts.getAllRefs, TOTAL, JSON.stringify(w.db._counts));
    assert.ok(w.db._counts.get < 100,
      'single-document reads must not scale with employees: ' + JSON.stringify(w.db._counts));
  });

  await test('the read pages at twenty-five and the cursor walks every row exactly once', async () => {
    const seen = new Set();
    let cursor = null, pages = 0, last = null;
    for (;;) {
      const page = await w.summary.read({ station_id: SID, month: MONTH, ...(cursor ? { cursor } : {}) });
      assert.equal(page.state, 'ready');
      assert.ok(page.rows.length <= READ_PAGE, 'page of ' + page.rows.length);
      for (const row of page.rows) {
        assert.equal(seen.has(row.uid), false, 'row returned twice: ' + row.uid);
        seen.add(row.uid);
        // הסמן עולה מונוטונית — אחרת עמוד יכול לדלג או לחזור.
        if (last !== null) assert.ok(row.uid > last, 'cursor went backwards at ' + row.uid);
        last = row.uid;
      }
      pages += 1;
      cursor = page.next_cursor;
      if (!cursor) break;
      assert.ok(pages <= Math.ceil(TOTAL / READ_PAGE) + 1, 'too many pages: ' + pages);
    }
    assert.equal(seen.size, TOTAL, 'rows seen ' + seen.size);
    assert.equal(pages, Math.ceil(TOTAL / READ_PAGE), 'pages ' + pages);
  });

  await test('the same cursor twice returns the same page, so a retry is not a skip', async () => {
    const first = await w.summary.read({ station_id: SID, month: MONTH });
    const again = await w.summary.read({ station_id: SID, month: MONTH });
    assert.deepEqual(first.rows.map(r => r.uid), again.rows.map(r => r.uid));
    const second = await w.summary.read({ station_id: SID, month: MONTH, cursor: first.next_cursor });
    const secondAgain = await w.summary.read({ station_id: SID, month: MONTH, cursor: first.next_cursor });
    assert.deepEqual(second.rows.map(r => r.uid), secondAgain.rows.map(r => r.uid));
    assert.equal(second.rows[0].uid > first.rows.at(-1).uid, true);
  });

  await test('the counted absences landed on the right people and nowhere else', async () => {
    const page = await w.summary.read({ station_id: SID, month: MONTH });
    for (const row of page.rows) {
      const index = Number(row.uid.slice(1));
      assert.equal(row.approved_sick_days, index % 10 === 0 ? 3 : 0, row.uid);
      assert.equal(row.total_hours === null, index % 3 === 0, row.uid);
    }
  });

  await test('the over-hours answer is bounded at two hundred and never a full dump', async () => {
    const out = await w.summary.overHours({ station_id: SID, month: MONTH });
    assert.ok(['over', 'clear'].includes(out.state));
    assert.ok(out.over_employees.length <= 200, 'over rows ' + out.over_employees.length);
    for (const person of out.over_employees) {
      assert.equal(Object.hasOwn(person, 'uid'), false);
      assert.deepEqual(Object.keys(person).sort(),
        ['crew', 'employee_number', 'full_name', 'total_hours']);
    }
  });

  await test('a re-run over three thousand employees adds no second generation and no duplicate row', async () => {
    const before = [...w.db._store.keys()].filter(p => p.includes('/hr_monthly_rows/')).length;
    const out = await w.summary.build({ station_id: SID, month: MONTH, intent_id: MONTH, budget_ms: 600000 });
    assert.equal(out.reason, 'already_active');
    assert.equal(out.activated, false);
    const after = [...w.db._store.keys()].filter(p => p.includes('/hr_monthly_rows/')).length;
    assert.equal(after, before);
    const generations = [...w.db._store.keys()]
      .filter(p => p.includes('/hr_monthly_generations/') && !p.includes('/hr_monthly_rows/'));
    assert.equal(generations.length, 1, generations.join('\n'));
  });

  console.log('');
  console.log('NOT RUN — Firestore itself. This is an in-memory double: it proves the shape');
  console.log('(one document per employee, slices per build, pages per read, a stable cursor)');
  console.log('and says nothing about real latency, real cost, or the real 1 MiB ceiling.');
  console.log('');
  if (failures.length) {
    console.error(failures.length + ' scale checks failed.');
    process.exit(1);
  }
  console.log(passed + ' scale checks passed at ' + TOTAL + ' employees.');
}

main();
