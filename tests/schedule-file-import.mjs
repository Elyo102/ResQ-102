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

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  chunks.forEach((chunk) => { out.set(chunk, offset); offset += chunk.length; });
  return out;
}

function header(size) { return new Uint8Array(size); }
function u16(bytes, offset, value) { new DataView(bytes.buffer).setUint16(offset, value, true); }
function u32(bytes, offset, value) { new DataView(bytes.buffer).setUint32(offset, value >>> 0, true); }

function zip(entries) {
  const encoder = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;
  entries.forEach(([name, source]) => {
    const nameBytes = encoder.encode(name);
    const body = encoder.encode(source);
    const crc = crc32(body);
    const local = header(30);
    u32(local, 0, 0x04034b50); u16(local, 4, 20); u16(local, 6, 0x800); u16(local, 8, 0);
    u32(local, 14, crc); u32(local, 18, body.length); u32(local, 22, body.length); u16(local, 26, nameBytes.length);
    locals.push(local, nameBytes, body);
    const directory = header(46);
    u32(directory, 0, 0x02014b50); u16(directory, 4, 20); u16(directory, 6, 20);
    u16(directory, 8, 0x800); u16(directory, 10, 0); u32(directory, 16, crc);
    u32(directory, 20, body.length); u32(directory, 24, body.length); u16(directory, 28, nameBytes.length); u32(directory, 42, offset);
    central.push(directory, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  });
  const centralBytes = concat(central);
  const end = header(22);
  u32(end, 0, 0x06054b50); u16(end, 8, entries.length); u16(end, 10, entries.length);
  u32(end, 12, centralBytes.length); u32(end, 16, offset);
  return concat([...locals, centralBytes, end]);
}

function excelSerial(year, month, day) {
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86400000);
}
function columnName(index) {
  let n = index;
  let out = '';
  while (n > 0) { n -= 1; out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26); }
  return out;
}
function workbookFixture(options = {}) {
  const year = options.year || 2026;
  const days = options.days || 30;
  const dateCells = [];
  for (let day = 1; day <= days; day += 1) {
    dateCells.push(`<c r="${columnName(day + 1)}1"><v>${excelSerial(year, 9, day)}</v></c>`);
  }
  const formula = options.formula ? '<c r="B4"><f>1+1</f><v>2</v></c>' : '';
  const worksheet = `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t> </t></is></c>${dateCells.join('')}</row>
      <row r="2"><c r="B2" t="inlineStr"><is><t>ג</t></is></c></row>
      <row r="3"><c r="A3" t="s"><v>0</v></c><c r="B3" t="s"><v>1</v></c></row>
      <row r="4">${formula}</row>
      <row r="5"><c r="A5" t="s"><v>2</v></c><c r="B5" t="s"><v>3</v></c></row>
    </sheetData></worksheet>`;
  const parts = [
    ['xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${year}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/sharedStrings.xml', '<?xml version="1.0"?><sst><si><t>אילת</t></si><si><t>כבאי ראשון</t></si><si><t>מחלה</t></si><si><t>כבאי שני</t></si></sst>'],
    ['xl/worksheets/sheet1.xml', worksheet]
  ];
  if (options.extraEntry) parts.push(options.extraEntry);
  return zip(parts);
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
await test('XLSX דורש חודש מפורש לפני פתיחתו', async () => {
  await assert.rejects(() => readScheduleFile(fakeFile('schedule.xlsx', 'binary')), { code:'xlsx-month' });
});
await test('סוג קובץ לא מוכר אינו מתקבל', async () => {
  await assert.rejects(() => readScheduleFile(fakeFile('schedule.pdf', 'binary')), { code:'file-type' });
});
await test('XLSX שנתי מחזיר רק את החודש שנבחר ובאותו חוזה matrix', async () => {
  const result = await readScheduleFile(fakeFile('schedule.xlsx', workbookFixture()), { month:'2026-09' });
  assert.equal(result.kind, 'xlsx');
  assert.equal(result.sheet, '2026');
  assert.equal(result.month, '2026-09');
  assert.equal(result.matrix.length, 5);
  assert.equal(result.matrix[0].length, 31);
  assert.deepEqual(result.matrix[0].slice(0, 4), [' ', '2026-09-01', '2026-09-02', '2026-09-03']);
  assert.deepEqual(result.matrix[2].slice(0, 3), ['אילת', 'כבאי ראשון', '']);
  assert.deepEqual(result.matrix[4].slice(0, 3), ['מחלה', 'כבאי שני', '']);
});
await test('הערות ומטא-דאטה של Excel אינן נקראות ואינן נכנסות למטריצה', async () => {
  const bytes = workbookFixture({ extraEntry:['xl/comments/comment1.xml', '<!DOCTYPE x><not-even-valid>'] });
  const result = await readScheduleFile(fakeFile('schedule.xlsx', bytes), { month:'2026-09' });
  assert.equal(result.matrix[2][1], 'כבאי ראשון');
  assert.equal(JSON.stringify(result.matrix).includes('not-even-valid'), false);
});
await test('XLSX חסר יום בחודש נכשל ולא מייבא חודש חלקי', async () => {
  await assert.rejects(() => readScheduleFile(fakeFile('schedule.xlsx', workbookFixture({ days:29 })), { month:'2026-09' }),
    { code:'xlsx-month-incomplete' });
});
await test('XLSX של שנה אחרת אינו נבחר לפי ניחוש', async () => {
  await assert.rejects(() => readScheduleFile(fakeFile('schedule.xlsx', workbookFixture({ year:2025 })), { month:'2026-09' }),
    { code:'xlsx-year-sheet' });
});
await test('נוסחה בטווח הנבחר נדחית במקום להשתמש בערך שמור ישן', async () => {
  await assert.rejects(() => readScheduleFile(fakeFile('schedule.xlsx', workbookFixture({ formula:true })), { month:'2026-09' }),
    { code:'xlsx-formula' });
});
await test('נתיב ZIP שחורג מהקובץ נדחה גם אם אינו רכיב שנקרא', async () => {
  await assert.rejects(() => readScheduleFile(fakeFile('schedule.xlsx', workbookFixture({ extraEntry:['../comment.xml', 'x'] })), { month:'2026-09' }),
    { code:'xlsx-path' });
});
await test('מגבלת גודל נאכפת לפני קריאה', async () => {
  const file = { name:'large.csv', size:LIMITS.MAX_FILE_BYTES + 1, arrayBuffer:async () => new ArrayBuffer(0) };
  await assert.rejects(() => readScheduleFile(file), { code:'file-large' });
});

assert.equal(passed, 15);
console.log('\n15 schedule file import checks passed.');
