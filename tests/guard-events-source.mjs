// =====================================================================
//  בדיקת מקור · guard-events
//
//  אינה מריצה את המודול — היא **קוראת אותו כטקסט** ומוכיחה
//  תכונות שאי אפשר להוכיח בהרצה.
//
//  שתי טענות שרק כאן אפשר לאכוף
//  -----------------------------
//  **א. „המודול בונה ולא מסיר."** בדיקת יחידה שמוודאת ש-`notes`
//  אינו בפלט עוברת גם על מימוש שעושה `delete doc.notes` — ואז
//  שדה חדש שיתווסף למסמך מחר יזלוג. רק קריאת המקור יכולה
//  להוכיח שאין שם `delete`, אין `Object.assign` מהמסמך, ואין
//  פריסה שלו.
//
//  **ב. „המודול טהור."** מוק טוב יעבור גם על מודול שקורא
//  ל-firebase-admin, כי הבדיקה פשוט לא תיגע בענף הזה.
//
//      node tests/guard-events-source.mjs
// =====================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, '..', 'functions', 'guard-events.js');
const testPath = path.join(here, '..', 'functions', 'guard-events.test.js');

const source = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
const tests = fs.readFileSync(testPath, 'utf8').replace(/\r\n/g, '\n');

// הגוף בלבד. בדיקה שסורקת גם הערות נכשלת על מילה שנכתבה בהסבר,
// וזה הופך אותה לרעש במקום לשער.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

let pass = 0;
function check(label, fn) { fn(); pass++; console.log('✓ ' + label); }

// ---------------------------------------------------------------------
console.log('\n--- 1 · טוהר');
// ---------------------------------------------------------------------

check('אין ולו require אחד', () => assert.equal(/\brequire\s*\(/.test(code), false));
check('אין import', () => assert.equal(/^\s*import\s/m.test(code), false));

for (const forbidden of [
  'firebase-admin', 'firebase-functions', 'firestore',
  'fs', 'http', 'https', 'net', 'child_process', 'crypto'
]) {
  check('אין אזכור של ' + forbidden, () => {
    assert.equal(code.includes("'" + forbidden + "'"), false);
    assert.equal(code.includes('"' + forbidden + '"'), false);
  });
}

check('אין שעון — Date, hrtime', () => {
  assert.equal(/\bnew\s+Date\b/.test(code), false);
  assert.equal(/Date\s*\.\s*now/.test(code), false);
  assert.equal(/hrtime/.test(code), false);
});

check('אין אקראיות', () => assert.equal(/Math\s*\.\s*random/.test(code), false));

check('אין גישה למסד', () => {
  for (const token of ['.collection(', '.doc(', '.set(', '.update(', '.delete(', '.get(']) {
    assert.equal(code.includes(token), false, token);
  }
});

check('אין קלט/פלט', () => {
  assert.equal(/\bconsole\s*\./.test(code), false);
  assert.equal(/\bprocess\s*\./.test(code), false);
});

check('אין async, await או Promise — ההיטל סינכרוני', () => {
  assert.equal(/\basync\b/.test(code), false);
  assert.equal(/\bawait\b/.test(code), false);
  assert.equal(/\bPromise\b/.test(code), false);
});

check('אין throw — קלט פגום מוחזר כריק ולא כשגיאה', () => {
  assert.equal(/\bthrow\b/.test(code), false);
});

// ---------------------------------------------------------------------
console.log('\n--- 2 · בונה, לא מסיר · זו כל הנקודה');
// ---------------------------------------------------------------------

check('אין ולו delete אחד', () => {
  assert.equal(/\bdelete\s+[a-zA-Z_$]/.test(code), false);
});

check('אין Object.assign שמעתיק מסמך אבטחה', () => {
  const assigns = code.match(/Object\.assign\([^)]*\)/g) || [];
  for (const a of assigns) assert.equal(/guard/i.test(a), false, a);
});

check('אין פריסה של מסמך האבטחה', () => {
  assert.equal(/\.\.\.\s*guard/.test(code), false);
  assert.equal(/\.\.\.\s*doc/.test(code), false);
});

check('הפלט נבנה משבעה שדות מפורשים', () => {
  const block = code.slice(code.indexOf('  return {\n    id: guard.id'));
  const body = block.slice(0, block.indexOf('  };') + 4);
  for (const field of ['id:', 'date:', 'title:', 'start:', 'end:', 'status:', 'people:']) {
    assert.ok(body.includes(field), field);
  }
  // אף שדה אחר לא נבנה שם
  const built = (body.match(/^\s{4}([a-z_]+):/gm) || []).map((s) => s.trim().replace(':', ''));
  assert.deepEqual(built.sort(), ['date', 'end', 'id', 'people', 'start', 'status', 'title']);
});

check('רשימת השדות המותרים קפואה ובת שבעה', () => {
  assert.ok(/const\s+EVENT_FIELDS\s*=\s*Object\.freeze\(\[/.test(code));
  for (const field of ['id', 'date', 'title', 'start', 'end', 'status', 'people']) {
    assert.ok(code.includes("'" + field + "'"), field);
  }
});

// ---------------------------------------------------------------------
console.log('\n--- 3 · שדות רגישים · אינם נקראים כלל');
// ---------------------------------------------------------------------
//
//  לא „אינם נכתבים לפלט" — **אינם מוזכרים בגוף המודול בכלל.**
//  שדה שהמודול אינו יודע עליו אינו יכול לדלוף ממנו.

for (const field of [
  'notes', 'place', 'signups', 'need_quals', 'by_uid', 'by_name',
  'kind', 'slots', 'created_at', 'updated_at', 'email', 'phone'
]) {
  check('השדה ' + field + ' אינו מופיע במודול', () => {
    assert.equal(new RegExp('\\b' + field + '\\b').test(code), false, field);
  });
}

// ---------------------------------------------------------------------
console.log('\n--- 4 · המיפוי assigned → people');
// ---------------------------------------------------------------------

check('שני השמות קיימים, וזה מכוון', () => {
  assert.ok(code.includes('guard.assigned'));
  assert.ok(code.includes('people'));
});

check('הקריאה מ-assigned מתבצעת פעם אחת בלבד', () => {
  const hits = code.split('guard.assigned').length - 1;
  assert.equal(hits, 1);
});

check('מזהי Firebase מקבלים חוזה נפרד ממזהי guard ותחנה', () => {
  assert.ok(code.includes('const AUTH_UID_PATTERN'));
  assert.equal(/(?:^|[^A-Za-z0-9_])ID_PATTERN\.test\(uid\)/m.test(code), false);
  assert.ok((code.match(/AUTH_UID_PATTERN\.test\(uid\)/g) || []).length >= 2);
  assert.ok(code.includes('AUTH_UID_PATTERN.test(entry)'));
});

check('assigned אינו יוצא בשם הזה לפלט', () => {
  const block = code.slice(code.indexOf('  return {\n    id: guard.id'));
  const body = block.slice(0, block.indexOf('  };') + 4);
  assert.equal(body.includes('assigned'), false);
});

// ---------------------------------------------------------------------
console.log('\n--- 5 · החלטות שאסור שייעלמו בשקט');
// ---------------------------------------------------------------------

check('רשימת המצבים סגורה וקפואה, ו-cancelled בתוכה', () => {
  assert.ok(/const\s+GUARD_STATUSES\s*=\s*Object\.freeze\(\[/.test(code));
  for (const s of ['open', 'staffed', 'done', 'cancelled']) {
    assert.ok(code.includes("'" + s + "'"), s);
  }
  assert.ok(code.includes('CANCELLED'));
});

check('מבוטלת נחסמת במפורש', () => {
  assert.ok(/status\s*===\s*CANCELLED/.test(code));
});

// אם מישהו „יסדר" את זה לכלל end > start, אבטחות הלילה ייעלמו
// מהסידור. הבדיקה הזאת קיימת כדי שהשינוי הזה לא יעבור בשקט.
check('אין השוואה בין שעת התחלה לשעת סיום', () => {
  assert.equal(/end\s*[<>]=?\s*start/.test(code), false);
  assert.equal(/start\s*[<>]=?\s*end/.test(code), false);
});

check('אימות התאריך אינו נשען על אובייקט תאריך', () => {
  assert.ok(code.includes('MONTH_DAYS'));
  assert.ok(/%\s*4\s*===\s*0/.test(code), 'חישוב שנה מעוברת');
});

check('פעילות נקבעת מסימון מפורש בלבד', () => {
  assert.ok(/is_active\s*===\s*false/.test(code));
  assert.ok(/entry\.active\s*===\s*false/.test(code));
});

check('אין trim ואין נרמול על ערכים שכבר קיימים', () => {
  assert.equal(/\.trim\s*\(/.test(code), false);
  assert.equal(/toLowerCase|toUpperCase|normalize/.test(code), false);
});

check('יש שער לתווים בלתי נראים', () => {
  assert.ok(code.includes('INVISIBLE'));
  assert.ok(/INVISIBLE\.test\(/.test(code));
});

check('שלושת שמות שדה התחנה נבדקים', () => {
  for (const f of ['stationId', 'station_id', 'station']) {
    assert.ok(code.includes(f), f);
  }
});

check('הסדר קבוע ואינו תלוי בסדר הקלט', () => {
  assert.ok(code.includes('byDateThenStartThenId'));
  assert.ok(/events\.sort\(byDateThenStartThenId\)/.test(code));
});

check('הפלט קפוא בכל הרמות', () => {
  assert.ok(/Object\.freeze\(events\)/.test(code));
  assert.ok(/Object\.freeze\(people\.slice\(\)\.sort\(\)\)/.test(code));
  assert.ok(/Object\.freeze\(\[viewer\]\)/.test(code));
});

// ---------------------------------------------------------------------
console.log('\n--- 6 · סיבות · קודים סגורים בלי ערכים');
// ---------------------------------------------------------------------

check('DROP ו-DROP_CODES קפואים', () => {
  assert.ok(/const\s+DROP\s*=\s*Object\.freeze\(\{/.test(code));
  assert.ok(/const\s+DROP_CODES\s*=\s*Object\.freeze\(/.test(code));
});

check('כל drops.add מקבל קבוע מתוך DROP', () => {
  const adds = code.match(/drops\.add\(([^)]*)\)/g) || [];
  assert.ok(adds.length >= 10, 'מספר הסיבות: ' + adds.length);
  for (const a of adds) assert.ok(/DROP\s*\.\s*[A-Z_]+/.test(a), a);
});

check('גם כל empty() מקבל קבוע מתוך DROP', () => {
  const calls = code.match(/\bempty\(([^)]*)\)/g) || [];
  const withArgs = calls.filter((c) => !/empty\(\s*code\s*\)/.test(c) && c !== 'empty()');
  assert.ok(withArgs.length >= 3, 'מספר הקריאות: ' + withArgs.length);
  for (const c of withArgs) assert.ok(/DROP\s*\.\s*[A-Z_]+|ready\.code/.test(c), c);
});

check('אין שרשור מחרוזות לתוך סיבה', () => {
  assert.equal(/drops\.add\([^)]*\+/.test(code), false);
  assert.equal(/drops\.add\(\s*`/.test(code), false);
  assert.equal(/empty\([^)]*\+/.test(code), false);
});

// ---------------------------------------------------------------------
console.log('\n--- 7 · שני המשטחים, ומה שהבדיקות מכסות');
// ---------------------------------------------------------------------

check('המודול מייצא את שני המשטחים ואת הקבועים', () => {
  for (const token of [
    'stationGuardEvents', 'personalGuardEvents',
    'EVENT_FIELDS', 'GUARD_STATUSES', 'DROP', 'DROP_CODES'
  ]) assert.ok(code.includes(token), token);
});

check('התצוגה האישית מחזירה את הצופה בלבד', () => {
  const block = code.slice(code.indexOf('function personalGuardEvents'));
  assert.ok(block.includes('Object.freeze([viewer])'));
  assert.ok(/indexOf\(viewer\)\s*===\s*-1/.test(block));
});

check('בדיקות היחידה מכסות את מסלולי הנפילה', () => {
  for (const needle of [
    'guard_cancelled', 'assignee_not_active', 'guard_date_out_of_range',
    'guard_time_invalid', 'guard_status_invalid', 'guard_station_mismatch',
    'not_mine', 'viewer_not_active', 'guard_assigned_invalid'
  ]) assert.ok(tests.includes(needle), needle);
});

check('קיימת בדיקה לאבטחת לילה', () => assert.ok(tests.includes('22:00')));
check('קיימת בדיקת דליפה לכל שדה רגיש', () => {
  for (const f of ['notes', 'place', 'signups', 'need_quals', 'by_uid', 'kind']) {
    assert.ok(tests.includes(f), f);
  }
});

console.log('\n============================================');
console.log('  עברו ' + pass);
console.log('============================================');
