import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* 42H.20 Scope 2.2 · דיאלוג האישור לפני פרסום חייב לומר כמה שיבוצים
 * מתפרסמים, כמה מהם ללא חשבון (לא יקבלו פוש), וכמה אזהרות לא-חוסמות
 * ממתינות — לא רק "לפרסם?" גנרי. בדיקת מקור בלבד (אין דפדפן בסביבה
 * הזאת): מוודאת ש-publishDraft קורא ל-publishConfirmationText, ושזו
 * מרכיבה משפט עם שלושת הפרטים, בלי לנחש מספר שאין לו מקור בזמן ריצה. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = fs.readFileSync(path.join(root, 'schedule-management.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log('✓ ' + name); }

function fnBody(name) {
  const start = ui.indexOf('function ' + name + '(');
  assert.ok(start !== -1, name + ' must exist');
  let depth = 0;
  let i = ui.indexOf('{', start);
  const bodyStart = i;
  for (; i < ui.length; i += 1) {
    if (ui[i] === '{') depth += 1;
    else if (ui[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  return ui.slice(bodyStart, i + 1);
}

check('publishDraft asks publishConfirmationText for the confirm() text, not a bare string', () => {
  const body = fnBody('publishDraft');
  assert.match(body, /const confirmation = publishConfirmationText\(trial\);/);
  assert.match(body, /if \(!confirm\(confirmation\)\) return;/);
});

check('publishConfirmationText reports the assignment count', () => {
  const body = fnBody('publishConfirmationText');
  assert.match(body, /state\.draft\.summary\.filled/);
  assert.match(body, /שיבוצים בטיוטה/);
});

check('publishConfirmationText reports the no-push (unlinked) count when known', () => {
  const body = fnBody('publishConfirmationText');
  assert.match(body, /state\.importReport[\s\S]*counts[\s\S]*unlinked/);
  assert.match(body, /ללא חשבון מקושר/);
  assert.match(body, /לא יקבלו התראת פוש/);
});

check('publishConfirmationText reports the non-blocking warning count and calls it non-blocking', () => {
  const body = fnBody('publishConfirmationText');
  assert.match(body, /gaps\.blocking \|\| \[\]\)\.length \+ \(gaps\.acknowledgeable \|\| \[\]\)\.length/);
  assert.match(body, /אינן חוסמות פרסום/);
});

check('no number is invented: every reported figure is guarded by a Number.isFinite/known check', () => {
  const body = fnBody('publishConfirmationText');
  assert.match(body, /Number\.isFinite\(state\.draft\.summary\.filled\)/);
  assert.match(body, /Number\.isFinite\(state\.importReport\.counts\.unlinked\)/);
});

console.log(passed + '/5 schedule publish confirmation source checks passed');
