'use strict';

/* ======================================================================
 *  hr-pilot-harness-fidelity — הכפיל חייב להיות מסוגל להכשיל
 *
 *  ----------------------------------------------------------------
 *  למה הבדיקה הזאת קיימת
 *  ----------------------------------------------------------------
 *  הכפיל של Firestore בבדיקות ה-HR סינן `==` בלבד. השורה הייתה:
 *
 *      rows.filter(([, v]) => (op === '==' ? v[f] === val : true))
 *
 *  כלומר כל מפעיל אחר — `<=`, `>=`, `array-contains` — **החזיר את כל
 *  השורות**. בדיקה שכותבת שאילתת טווח מול הכפיל הזה עוברת גם על קוד
 *  ששוכח את הסינון לגמרי, גם על קוד שמסנן הפוך, וגם על קוד שאינו
 *  מסנן בכלל. היא מדווחת PASS ואינה בודקת דבר.
 *
 *  ⭐ זו בדיוק הצורה שאסור לסמוך עליה, ולכן היא מקבלת בדיקה משלה:
 *  אחת שמריצה את ההיגיון הישן ומראה שהוא עבר על ריק, ואת הנוכחי
 *  ומראה שהוא מסנן. בלי ההשוואה הזו „תיקנתי את הכפיל" הוא טענה.
 *
 *  ----------------------------------------------------------------
 *  מה זה אינו
 *  ----------------------------------------------------------------
 *  הכפיל עדיין אינו Firestore. הוא אינו אוכף דרישת אינדקס מורכב,
 *  ולכן שאילתה שתעבוד כאן עלולה להיכשל בייצור ב-`FAILED_PRECONDITION`.
 *  זו הסיבה שהשאילתות בדוח החודשי מוגבלות לשוויון בודד או ל-
 *  `array-contains` בודד, ולא כי הכפיל אישר אותן.
 * ====================================================================== */

const assert = require('node:assert/strict');
const { fakeDb } = require('./hr-pilot-test-harness');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log('✓ ' + name); }
  catch (error) { failures.push(name); console.log('✗ ' + name + ' — ' + error.message); }
}

/** ההיגיון שהיה בכפיל לפני התיקון, מילה במילה. */
const legacyFilter = (rows, clauses) => {
  let out = rows;
  for (const [f, op, val] of clauses) out = out.filter((v) => (op === '==' ? v[f] === val : true));
  return out;
};

const ROWS = [
  { id: 'a', kind: 'sick', from_date: '2026-07-01', months: ['2026-07'] },
  { id: 'b', kind: 'sick', from_date: '2026-09-10', months: ['2026-09'] },
  { id: 'c', kind: 'reserve', from_date: '2026-08-28', months: ['2026-08', '2026-09'] },
  { id: 'd', kind: 'vacation', from_date: '2026-12-01', months: ['2026-12'] }
];

function seeded() {
  const db = fakeDb();
  for (const row of ROWS) db._put('probe/' + row.id, row);
  return db;
}

const ids = (result) => result.docs.map((s) => s.id).sort();

async function main() {
  await test('the old one-operator filter passed a range clause on every row', () => {
    const kept = legacyFilter(ROWS, [['from_date', '<=', '2026-01-01']]);
    // ארבע מתוך ארבע, כששום שורה אינה מקיימת את התנאי.
    assert.equal(kept.length, 4);
    assert.deepEqual(kept.map((r) => r.id).sort(), ['a', 'b', 'c', 'd']);
  });

  await test('and it passed array-contains on every row too', () => {
    assert.equal(legacyFilter(ROWS, [['months', 'array-contains', '2099-01']]).length, 4);
  });

  await test('the current harness filters a range clause for real', async () => {
    const db = seeded();
    assert.deepEqual(ids(await db.collection('probe').where('from_date', '<=', '2026-08-31').get()), ['a', 'c']);
    assert.deepEqual(ids(await db.collection('probe').where('from_date', '>', '2026-09-30').get()), ['d']);
  });

  await test('array-contains selects exactly the documents carrying the value', async () => {
    const db = seeded();
    assert.deepEqual(ids(await db.collection('probe').where('months', 'array-contains', '2026-09').get()), ['b', 'c']);
    assert.deepEqual(ids(await db.collection('probe').where('months', 'array-contains', '2099-01').get()), []);
  });

  await test('a missing field never satisfies a range clause', async () => {
    const db = seeded();
    db._put('probe/e', { id: 'e', kind: 'sick' });
    assert.equal(ids(await db.collection('probe').where('from_date', '<=', '2099-01-01').get()).includes('e'), false);
  });

  await test('an operator the harness does not implement throws instead of passing everything', async () => {
    const db = seeded();
    await assert.rejects(() => db.collection('probe').where('kind', 'like', 'sick%').get(),
      (error) => /unsupported query operator/.test(error.message));
  });

  await test('getAll returns one snapshot per reference, in order, absent ones included', async () => {
    const db = seeded();
    const snaps = await db.getAll(db.doc('probe/b'), db.doc('probe/missing'), db.doc('probe/a'));
    assert.deepEqual(snaps.map((s) => s.id), ['b', 'missing', 'a']);
    assert.deepEqual(snaps.map((s) => s.exists), [true, false, true]);
  });

  await test('a transactional getAll is fenced: a write between read and commit retries', async () => {
    const db = seeded();
    let attempts = 0;
    const out = await db.runTransaction(async (tx) => {
      attempts += 1;
      const snaps = await tx.getAll(db.doc('probe/a'), db.doc('probe/b'));
      if (attempts === 1) db._put('probe/a', { ...ROWS[0], kind: 'changed' });
      return snaps.map((s) => s.data().kind);
    });
    assert.equal(attempts, 2);
    assert.deepEqual(out, ['changed', 'sick']);
  });

  console.log('');
  console.log('NOT RUN here — Firestore composite-index enforcement. The harness serves any');
  console.log('query shape; production does not. Index requirements are proven on an emulator');
  console.log('or declared NOT RUN, never inferred from this file passing.');
  console.log('');
  if (failures.length) {
    console.error(failures.length + ' harness fidelity checks failed.');
    process.exit(1);
  }
  console.log(passed + ' harness fidelity checks passed.');
}

main();
