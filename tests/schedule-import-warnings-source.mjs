import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* 42H.20 Scope 2.5 · unlinked-people/ignored-content הם קודים גולמיים
 * שהגיעו מ-functions/schedule-import-pipeline.js אל תוך report.warnings
 * בלי שדה detail. בדיקה זו בודקת קוד מקור בלבד (בלי דפדפן, שאינו זמין
 * בסביבת הבדיקה הזאת) שהלולאה בשדה הכללי בקובץ schedule-management.js:
 * (1) לא מציגה עוד את המחרוזת הגולמית unlinked-people,
 * (2) מתרגמת אותה לעברית ברורה שמזכירה "ללא חשבון" ו"פוש",
 * (3) לא מכפילה תצוגה של אזהרות שכבר מוצגות במפורש במקום אחר. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const ui = read('schedule-management.js');

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log('✓ ' + name); }

function warningsBlock(text) {
  const start = text.indexOf('WARNING_HE');
  assert.ok(start !== -1, 'WARNING_HE map must exist');
  const end = text.indexOf('function importBlockedText', start);
  assert.ok(end !== -1 && end > start, 'expected importBlockedText after the warnings loop');
  return text.slice(start, end);
}

check('unlinked-people is translated, not shown as a raw code', () => {
  const block = warningsBlock(ui);
  assert.match(block, /'unlinked-people':/);
  assert.match(block, /ללא חשבון/);
  assert.match(block, /פוש/);
});

check('warnings already shown elsewhere are not duplicated as raw codes', () => {
  const block = warningsBlock(ui);
  ['duplicate-assignment', 'ignored-content', 'below-minimum', 'block-ignored', 'assignment-absence-conflict']
    .forEach((code) => {
      assert.match(block, new RegExp("warning\\.code === '" + code + "'\\) return"),
        code + ' must be filtered out of the generic raw-code render path');
    });
});

check('fallback to warning.code only fires through the Hebrew map, never bare', () => {
  const block = warningsBlock(ui);
  assert.match(block, /WARNING_HE\[warning\.code\] \? WARNING_HE\[warning\.code\]\(warning\) : warning\.code/);
});

console.log(passed + '/3 schedule import warnings source checks passed');
