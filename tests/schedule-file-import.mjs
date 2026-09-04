import assert from 'node:assert/strict';
import { parseDelimited, readScheduleFile, LIMITS } from '../schedule-file-import.js';

let passed = 0;
async function test(name, fn) {
  await awaitMaybe(fn());
  passed += 1;
  console.log('✓ ' + name);
}
function awaitMaybe(value) { return Promise.resolve(value); }
function fakeFile(name, bytes) {
  const body = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return { name, size:body.byteLength, arrayBuffer:async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
}

await test('CSV מצוטט שומר פסיק ושורה חדשה בתוך תא', () => {
  assert.deepEqual(parseDelimited('כותרת,"שם, נוסף"\r\nאילת,"אחד\nשניים"', ','), [
    ['כותרת', 'שם, נוסף'], ['אילת', 'אחד\nשניים']
  ]);
});
await test('גרשיים כפולים מפוענחים', () => {
  assert.deepEqual(parseDelimited('א,"ב""ג"', ','), [['א', 'ב"ג']]);
});
await test('TSV שומר פסיקים כתוכן', () => {
  assert.deepEqual(parseDelimited('א\tב,ג\nד\tה', '\t'), [['א', 'ב,ג'], ['ד', 'ה']]);
});
await test('BOM ו-CRLF נקראים מקובץ CSV', async () => {
  const result = await readScheduleFile(fakeFile('schedule.csv', '\ufeff,1/9,2/9,3/9\r\nאילת,א,ב,ג\r\n'));
  assert.equal(result.kind, 'csv');
  assert.deepEqual(result.matrix[1], ['אילת', 'א', 'ב', 'ג']);
});
await test('קובץ Google Sheets שהורד כ-TSV נקרא מקומית', async () => {
  const result = await readScheduleFile(fakeFile('google-sheet.tsv', '\t1/9\t2/9\t3/9\nאילת\tא\tב\tג'));
  assert.equal(result.kind, 'tsv');
  assert.equal(result.matrix.length, 2);
});
await test('CSV שבור נכשל ולא מנחש', () => {
  assert.throws(() => parseDelimited('א,"ב', ','), { code:'file-quotes' });
});
await test('קובץ בינארי אינו מתקבל', async () => {
  await assert.rejects(() => readScheduleFile(fakeFile('schedule.xlsx', 'binary')), { code:'file-type' });
});
await test('מגבלת גודל נאכפת לפני קריאה', async () => {
  const file = { name:'large.csv', size:LIMITS.MAX_FILE_BYTES + 1, arrayBuffer:async () => new ArrayBuffer(0) };
  await assert.rejects(() => readScheduleFile(file), { code:'file-large' });
});

assert.equal(passed, 8);
console.log('\n8 schedule file import checks passed.');
