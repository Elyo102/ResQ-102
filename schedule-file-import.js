const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 400;
const MAX_CELLS = 40000;
const MAX_CELL_CHARS = 2000;
const MAX_ZIP_ENTRIES = 512;
const MAX_ZIP_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_RATIO = 200;
const MAX_SHARED_STRINGS = 100000;
const MAX_WORKSHEET_CELLS = 200000;
// Keep the browser limit identical to the server parser limit.  A file the
// browser accepts must not fail later only because its merge metadata crossed
// a different ceiling on the trusted side.
const MAX_MERGE_RANGES = 256;
const MAX_MERGED_CELLS = MAX_WORKSHEET_CELLS;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function decode(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le', { fatal:true }).decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be', { fatal:true }).decode(bytes.subarray(2));
  }
  const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder('utf-8', { fatal:true }).decode(bytes.subarray(start));
}

function delimiterFor(name, text) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.csv')) return ',';
  if (lower.endsWith('.tsv')) return '\t';
  const sample = text.split(/\r?\n/, 8).join('\n');
  return (sample.match(/\t/g) || []).length >= (sample.match(/,/g) || []).length ? '\t' : ',';
}

function uint16(view, offset) {
  if (offset < 0 || offset + 2 > view.byteLength) fail('xlsx-zip', 'מבנה קובץ Excel אינו תקין.');
  return view.getUint16(offset, true);
}

function uint32(view, offset) {
  if (offset < 0 || offset + 4 > view.byteLength) fail('xlsx-zip', 'מבנה קובץ Excel אינו תקין.');
  return view.getUint32(offset, true);
}

function decodeUtf8(bytes, code) {
  try { return new TextDecoder('utf-8', { fatal:true }).decode(bytes); }
  catch (_) { fail(code || 'xlsx-encoding', 'קובץ Excel מכיל טקסט בקידוד שאינו נתמך.'); }
}

function zipPath(raw) {
  if (!raw || raw.indexOf('\\') !== -1 || raw.indexOf('\0') !== -1 || raw[0] === '/' || /^[A-Za-z]:/.test(raw)) {
    fail('xlsx-path', 'קובץ Excel מכיל נתיב פנימי לא בטוח.');
  }
  const parts = raw.split('/');
  const content = raw.endsWith('/') ? parts.slice(0, -1) : parts;
  if (!content.length || content.some((part) => part === '' || part === '.' || part === '..')) {
    fail('xlsx-path', 'קובץ Excel מכיל נתיב פנימי לא בטוח.');
  }
  return raw;
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let value = n;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      crcTable[n] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function openZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const first = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= first; offset -= 1) {
    if (uint32(view, offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd === -1) fail('xlsx-zip', 'הקובץ אינו קובץ Excel תקין.');
  const commentLength = uint16(view, eocd + 20);
  if (eocd + 22 + commentLength !== bytes.length) fail('xlsx-zip', 'סיומת קובץ Excel אינה תקינה.');
  const disk = uint16(view, eocd + 4);
  const directoryDisk = uint16(view, eocd + 6);
  const diskEntries = uint16(view, eocd + 8);
  const totalEntries = uint16(view, eocd + 10);
  const directorySize = uint32(view, eocd + 12);
  const directoryOffset = uint32(view, eocd + 16);
  if (disk !== 0 || directoryDisk !== 0 || diskEntries !== totalEntries || totalEntries === 0xffff
      || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    fail('xlsx-zip64', 'מבנה ZIP64 או קובץ Excel מפוצל אינם נתמכים.');
  }
  if (totalEntries < 1 || totalEntries > MAX_ZIP_ENTRIES || directoryOffset + directorySize > eocd) {
    fail('xlsx-zip', 'מבנה קובץ Excel חורג מהמגבלות.');
  }
  const entries = new Map();
  let totalSize = 0;
  let cursor = directoryOffset;
  for (let count = 0; count < totalEntries; count += 1) {
    if (uint32(view, cursor) !== 0x02014b50) fail('xlsx-zip', 'תוכן ענייני קובץ Excel אינו תקין.');
    const flags = uint16(view, cursor + 8);
    const method = uint16(view, cursor + 10);
    const checksum = uint32(view, cursor + 16);
    const compressedSize = uint32(view, cursor + 20);
    const size = uint32(view, cursor + 24);
    const nameLength = uint16(view, cursor + 28);
    const extraLength = uint16(view, cursor + 30);
    const entryCommentLength = uint16(view, cursor + 32);
    const localOffset = uint32(view, cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (end > directoryOffset + directorySize || (flags & 1) !== 0 || ![0, 8].includes(method)) {
      fail('xlsx-zip', 'קובץ Excel מכיל רשומה שאינה נתמכת.');
    }
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    if ((flags & 0x800) === 0 && nameBytes.some((value) => value > 0x7f)) {
      fail('xlsx-encoding', 'שם פנימי בקובץ Excel אינו UTF-8.');
    }
    const name = zipPath(decodeUtf8(nameBytes));
    if (entries.has(name)) fail('xlsx-duplicate-entry', 'קובץ Excel מכיל רשומה כפולה.');
    if (size > MAX_ZIP_ENTRY_BYTES || compressedSize > MAX_FILE_BYTES
        || (compressedSize === 0 ? size !== 0 : size / compressedSize > MAX_ZIP_RATIO)) {
      fail('xlsx-zip-large', 'תוכן קובץ Excel גדול או דחוס מדי.');
    }
    totalSize += size;
    if (totalSize > MAX_ZIP_TOTAL_BYTES) fail('xlsx-zip-large', 'תוכן קובץ Excel גדול מדי לאחר פתיחה.');
    entries.set(name, { name, flags, method, checksum, compressedSize, size, localOffset });
    cursor = end;
  }
  if (cursor !== directoryOffset + directorySize) fail('xlsx-zip', 'תוכן ענייני קובץ Excel אינו תקין.');
  return { bytes, view, entries };
}

async function inflateEntry(zip, name, required = true) {
  const entry = zip.entries.get(name);
  if (!entry) {
    if (!required) return null;
    fail('xlsx-part-missing', 'בקובץ Excel חסר רכיב נדרש.');
  }
  const offset = entry.localOffset;
  if (uint32(zip.view, offset) !== 0x04034b50) fail('xlsx-zip', 'רשומת קובץ Excel אינה תקינה.');
  const method = uint16(zip.view, offset + 8);
  const nameLength = uint16(zip.view, offset + 26);
  const extraLength = uint16(zip.view, offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (method !== entry.method || end > zip.bytes.length) fail('xlsx-zip', 'רשומת קובץ Excel אינה תקינה.');
  const compressed = zip.bytes.subarray(start, end);
  let output;
  if (entry.method === 0) {
    output = compressed.slice();
  } else {
    if (typeof DecompressionStream !== 'function') {
      fail('xlsx-browser', 'הדפדפן הזה אינו תומך בקריאת XLSX. אפשר להשתמש ב-Chrome/Edge מעודכן או לשמור כ-CSV.');
    }
    try {
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      output = new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (_) {
      fail('xlsx-compression', 'לא ניתן לפתוח את דחיסת קובץ Excel.');
    }
  }
  if (output.length !== entry.size || crc32(output) !== entry.checksum) {
    fail('xlsx-checksum', 'בדיקת התקינות של קובץ Excel נכשלה.');
  }
  return output;
}

async function xmlEntry(zip, name, required = true) {
  const bytes = await inflateEntry(zip, name, required);
  if (bytes === null) return null;
  const xml = decodeUtf8(bytes);
  if (/<!(?:doctype|entity)/i.test(xml)) fail('xlsx-xml', 'קובץ Excel מכיל הצהרת XML שאינה מותרת.');
  return xml;
}

function xmlDecode(value) {
  return String(value || '').replace(/&(?:#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity) => {
    if (entity === '&amp;') return '&';
    if (entity === '&lt;') return '<';
    if (entity === '&gt;') return '>';
    if (entity === '&quot;') return '"';
    if (entity === '&apos;') return "'";
    const hex = /^&#x([0-9a-f]+);$/i.exec(entity);
    const decimal = /^&#(\d+);$/.exec(entity);
    const point = parseInt(hex ? hex[1] : decimal ? decimal[1] : '', hex ? 16 : 10);
    if (!Number.isInteger(point) || point < 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
      fail('xlsx-xml', 'קובץ Excel מכיל ישות XML לא תקינה.');
    }
    return String.fromCodePoint(point);
  });
}

function attribute(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp('(?:^|\\s)' + escaped + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')').exec(source || '');
  return match ? xmlDecode(match[1] === undefined ? match[2] : match[1]) : null;
}

function textNodes(source) {
  const out = [];
  const pattern = /<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/g;
  let match;
  while ((match = pattern.exec(source || ''))) out.push(xmlDecode(match[1].replace(/<[^>]+>/g, '')));
  return out.join('');
}

function normalizePart(base, target) {
  const raw = String(target || '');
  if (!raw || raw.indexOf('\\') !== -1 || raw.indexOf('\0') !== -1) fail('xlsx-relationship', 'קישור פנימי בקובץ Excel אינו תקין.');
  const parts = raw[0] === '/' ? [] : base.split('/').filter(Boolean);
  raw.replace(/^\/+/, '').split('/').forEach((part) => {
    if (!part || part === '.') return;
    if (part === '..') {
      if (!parts.length) fail('xlsx-relationship', 'קישור פנימי בקובץ Excel יוצא מגבולות הקובץ.');
      parts.pop();
    } else parts.push(part);
  });
  return zipPath(parts.join('/'));
}

function excelDate(serial, date1904) {
  if (!Number.isFinite(serial) || serial < 0 || serial > 200000 || Math.abs(serial - Math.round(serial)) > 1e-7) return null;
  const epoch = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30);
  const value = new Date(epoch + Math.round(serial) * 86400000);
  const year = value.getUTCFullYear();
  if (year < 1900 || year > 2200) return null;
  return value.toISOString().slice(0, 10);
}

function textualDate(value) {
  const text = String(value || '').trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(text);
  if (match) return match[1] + '-' + match[2] + '-' + match[3];
  match = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/.exec(text);
  if (!match) return null;
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const month = Number(match[2]);
  const day = Number(match[1]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

function columnIndex(ref, code = 'xlsx-cell-ref') {
  const match = /^([A-Z]{1,4})([1-9]\d{0,5})$/.exec(ref || '');
  if (!match) fail(code, code === 'xlsx-merge-ref' ? 'טווח מיזוג בקובץ Excel אינו תקין.' : 'הפניה לתא בקובץ Excel אינה תקינה.');
  let column = 0;
  for (const char of match[1]) column = column * 26 + char.charCodeAt(0) - 64;
  return { column: column - 1, row: Number(match[2]) - 1 };
}

function parseMergeRanges(xml) {
  const ranges = [];
  let mergedCells = 0;
  const pattern = /<(?:[A-Za-z_][\w.-]*:)?mergeCell\b([^>]*?)\/?\s*>/g;
  let match;
  while ((match = pattern.exec(xml || ''))) {
    if (ranges.length >= MAX_MERGE_RANGES) fail('xlsx-merge-large', 'בגיליון Excel יש יותר מדי טווחים ממוזגים.');
    const ref = attribute(match[1], 'ref');
    const parts = ref && /^([A-Z]{1,4}[1-9]\d{0,5}):([A-Z]{1,4}[1-9]\d{0,5})$/.exec(ref);
    if (!parts) fail('xlsx-merge-ref', 'טווח מיזוג בקובץ Excel אינו תקין.');
    const start = columnIndex(parts[1], 'xlsx-merge-ref');
    const end = columnIndex(parts[2], 'xlsx-merge-ref');
    if (start.row > end.row || start.column > end.column) fail('xlsx-merge-ref', 'טווח מיזוג בקובץ Excel כתוב בסדר הפוך.');
    if (end.row >= 10000 || end.column >= 4096) fail('xlsx-merge-large', 'ממדי טווח מיזוג בקובץ Excel גדולים מדי.');
    const area = (end.row - start.row + 1) * (end.column - start.column + 1);
    mergedCells += area;
    if (!Number.isSafeInteger(area) || mergedCells > MAX_MERGED_CELLS) {
      fail('xlsx-merge-large', 'טווחי המיזוג בקובץ Excel גדולים מדי.');
    }
    ranges.push({
      startRow:start.row,
      endRow:end.row,
      startColumn:start.column,
      endColumn:end.column
    });
  }

  const ordered = ranges.slice().sort((a, b) =>
    a.startRow - b.startRow || a.startColumn - b.startColumn || a.endRow - b.endRow || a.endColumn - b.endColumn);
  const active = [];
  for (const range of ordered) {
    let keep = 0;
    for (const candidate of active) {
      if (candidate.endRow < range.startRow) continue;
      active[keep] = candidate;
      keep += 1;
      const columnsOverlap = candidate.startColumn <= range.endColumn && range.startColumn <= candidate.endColumn;
      if (columnsOverlap) fail('xlsx-merge-overlap', 'קובץ Excel מכיל טווחי מיזוג חופפים.');
    }
    active.length = keep;
    active.push(range);
  }
  return ranges;
}

function sharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const pattern = /<(?:[A-Za-z_][\w.-]*:)?si\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?si>/g;
  let match;
  while ((match = pattern.exec(xml))) {
    if (out.length >= MAX_SHARED_STRINGS) fail('xlsx-shared-strings', 'בקובץ Excel יש יותר מדי מחרוזות משותפות.');
    out.push(textNodes(match[1]));
  }
  return out;
}

function parseWorksheet(xml, strings) {
  const cells = new Map();
  const pattern = /<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>)/g;
  let match;
  while ((match = pattern.exec(xml))) {
    if (cells.size >= MAX_WORKSHEET_CELLS) fail('xlsx-worksheet-large', 'בגיליון Excel יש יותר מדי תאים.');
    const ref = attribute(match[1], 'r');
    if (!ref) continue;
    const pos = columnIndex(ref);
    if (pos.row >= 10000 || pos.column >= 4096) fail('xlsx-worksheet-large', 'ממדי גיליון Excel גדולים מדי.');
    const body = match[2] || '';
    const type = attribute(match[1], 't') || 'n';
    const formula = /<(?:[A-Za-z_][\w.-]*:)?f\b/.test(body);
    const valueMatch = /<(?:[A-Za-z_][\w.-]*:)?v\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/.exec(body);
    const raw = valueMatch ? xmlDecode(valueMatch[1]) : '';
    let value = '';
    let numeric = null;
    let error = false;
    if (type === 's') {
      const index = Number(raw);
      if (!Number.isInteger(index) || index < 0 || index >= strings.length) fail('xlsx-shared-string', 'הפניה למחרוזת בקובץ Excel אינה תקינה.');
      value = strings[index];
    } else if (type === 'inlineStr') value = textNodes(body);
    else if (type === 'b') value = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : '';
    else if (type === 'e') { value = raw; error = true; }
    else if (type === 'str') value = raw;
    else {
      numeric = raw === '' ? null : Number(raw);
      if (raw !== '' && !Number.isFinite(numeric)) fail('xlsx-number', 'ערך מספרי בקובץ Excel אינו תקין.');
      value = raw;
    }
    const key = pos.row + ':' + pos.column;
    if (cells.has(key)) fail('xlsx-cell-duplicate', 'אותו תא מופיע פעמיים בקובץ Excel.');
    cells.set(key, { row:pos.row, column:pos.column, value, numeric, formula, error });
  }
  return { cells, mergeRanges:parseMergeRanges(xml) };
}

function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }

async function readXlsx(bytes, name, month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) fail('xlsx-month', 'יש לבחור חודש לפני קריאת קובץ Excel.');
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  if (monthNumber < 1 || monthNumber > 12) fail('xlsx-month', 'החודש שנבחר אינו תקין.');
  const zip = openZip(bytes);
  const workbookXml = await xmlEntry(zip, 'xl/workbook.xml');
  const relationshipsXml = await xmlEntry(zip, 'xl/_rels/workbook.xml.rels');
  const date1904 = /<(?:[A-Za-z_][\w.-]*:)?workbookPr\b[^>]*\bdate1904\s*=\s*["'](?:1|true)["']/i.test(workbookXml);
  const relationships = new Map();
  const relationshipPattern = /<(?:[A-Za-z_][\w.-]*:)?Relationship\b([^>]*?)\/?\s*>/g;
  let match;
  while ((match = relationshipPattern.exec(relationshipsXml))) {
    const id = attribute(match[1], 'Id');
    const target = attribute(match[1], 'Target');
    const mode = attribute(match[1], 'TargetMode');
    if (id && target && mode !== 'External') relationships.set(id, normalizePart('xl', target));
  }
  const sheets = [];
  const sheetPattern = /<(?:[A-Za-z_][\w.-]*:)?sheet\b([^>]*?)\/?\s*>/g;
  while ((match = sheetPattern.exec(workbookXml))) {
    const sheetName = attribute(match[1], 'name');
    const relationId = attribute(match[1], 'r:id');
    if (sheetName && relationId && relationships.has(relationId)) sheets.push({ name:sheetName, path:relationships.get(relationId) });
  }
  const exact = sheets.filter((sheet) => sheet.name.trim() === String(year));
  const containing = sheets.filter((sheet) => new RegExp('(?:^|\\D)' + year + '(?:\\D|$)').test(sheet.name));
  const candidates = exact.length ? exact : containing;
  if (candidates.length !== 1) fail('xlsx-year-sheet', candidates.length ? 'נמצאו כמה גיליונות לשנה שנבחרה.' : 'לא נמצא גיליון לשנה ' + year + '.');
  const selected = candidates[0];
  const strings = sharedStrings(await xmlEntry(zip, 'xl/sharedStrings.xml', false));
  const worksheet = parseWorksheet(await xmlEntry(zip, selected.path), strings);
  const cells = worksheet.cells;

  let dateRow = -1;
  let selectedColumns = [];
  let allDateColumns = [];
  for (let row = 0; row < 12; row += 1) {
    const all = [];
    const wanted = [];
    cells.forEach((cell) => {
      if (cell.row !== row || cell.formula || cell.error) return;
      const iso = cell.numeric === null ? textualDate(cell.value) : excelDate(cell.numeric, date1904);
      if (!iso) return;
      all.push({ column:cell.column, date:iso });
      if (iso.slice(0, 7) === month) wanted.push({ column:cell.column, date:iso });
    });
    if (wanted.length >= 3) { dateRow = row; selectedColumns = wanted; allDateColumns = all; break; }
  }
  if (dateRow === -1) fail('xlsx-dates', 'לא נמצאו תאריכי ' + month + ' בגיליון ' + selected.name + '.');
  selectedColumns.sort((a, b) => a.column - b.column);
  const uniqueDates = new Set(selectedColumns.map((item) => item.date));
  const expectedDays = daysInMonth(year, monthNumber);
  if (selectedColumns.length !== expectedDays || uniqueDates.size !== expectedDays) {
    fail('xlsx-month-incomplete', 'בגיליון לא נמצאו כל ימי החודש שנבחר.');
  }
  for (let day = 1; day <= expectedDays; day += 1) {
    const iso = month + '-' + String(day).padStart(2, '0');
    if (!uniqueDates.has(iso)) fail('xlsx-month-incomplete', 'בגיליון חסר התאריך ' + iso + '.');
  }
  const firstDateColumn = Math.min(...allDateColumns.map((item) => item.column));
  if (!Number.isInteger(firstDateColumn) || firstDateColumn < 1 || firstDateColumn > 16) {
    fail('xlsx-layout', 'לא ניתן לזהות בבטחה את עמודת התוויות של הגיליון.');
  }
  const outputColumns = [];
  for (let column = 0; column < firstDateColumn; column += 1) outputColumns.push(column);
  selectedColumns.forEach((item) => outputColumns.push(item.column));
  const outputIndexByColumn = new Map(outputColumns.map((column, index) => [column, index]));
  const labelSpans = worksheet.mergeRanges.filter((range) => {
    if (range.startColumn !== range.endColumn || range.startColumn >= firstDateColumn || range.startRow <= dateRow) return false;
    const topLeft = cells.get(range.startRow + ':' + range.startColumn);
    return topLeft && topLeft.value !== '';
  }).map((range) => Object.freeze({
    column:outputIndexByColumn.get(range.startColumn),
    start_row:range.startRow,
    end_row:range.endRow
  })).sort((a, b) => a.start_row - b.start_row || a.column - b.column || a.end_row - b.end_row);
  let lastRow = dateRow;
  cells.forEach((cell) => {
    if (outputColumns.includes(cell.column) && cell.value !== '') lastRow = Math.max(lastRow, cell.row);
  });
  labelSpans.forEach((span) => { lastRow = Math.max(lastRow, span.end_row); });
  if (lastRow + 1 > MAX_ROWS || (lastRow + 1) * outputColumns.length > MAX_CELLS) {
    fail('xlsx-matrix-large', 'טבלת החודש בקובץ Excel גדולה מדי.');
  }
  const dateByColumn = new Map(selectedColumns.map((item) => [item.column, item.date]));
  const matrix = [];
  for (let row = 0; row <= lastRow; row += 1) {
    const outputRow = [];
    for (const column of outputColumns) {
      const cell = cells.get(row + ':' + column);
      if (!cell) { outputRow.push(''); continue; }
      if (cell.formula) fail('xlsx-formula', 'הטווח שנבחר מכיל נוסחה. יש להדביק ערכים או לשמור כ-CSV.');
      if (cell.error) fail('xlsx-cell-error', 'הטווח שנבחר מכיל תא שגיאה.');
      const value = row === dateRow && dateByColumn.has(column) ? dateByColumn.get(column) : String(cell.value || '');
      if (value.length > MAX_CELL_CHARS) fail('file-cell', 'בקובץ יש תא ארוך מדי.');
      outputRow.push(value);
    }
    matrix.push(outputRow);
  }
  return Object.freeze({ name, kind:'xlsx', sheet:selected.name, month, matrix, label_spans:Object.freeze(labelSpans) });
}

export function parseDelimited(text, delimiter) {
  if (delimiter !== ',' && delimiter !== '\t') fail('file-delimiter', 'סוג הקובץ אינו נתמך.');
  const source = String(text == null ? '' : text).replace(/^\ufeff/, '');
  if (!source.trim()) fail('file-empty', 'הקובץ ריק.');
  const rows = [[]];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"' && cell === '') { quoted = true; continue; }
    if (char === delimiter) { rows[rows.length - 1].push(cell); cell = ''; continue; }
    if (char === '\r' && source[index + 1] === '\n') continue;
    if (char === '\r' || char === '\n') {
      rows[rows.length - 1].push(cell); cell = ''; rows.push([]); continue;
    }
    cell += char;
  }
  if (quoted) fail('file-quotes', 'בקובץ יש תא מצוטט שלא נסגר.');
  rows[rows.length - 1].push(cell);
  if (rows.length > 1 && rows[rows.length - 1].every((value) => value === '')) rows.pop();
  if (rows.length > MAX_ROWS) fail('file-rows', 'בקובץ יש יותר מדי שורות.');
  let cells = 0;
  rows.forEach((row) => row.forEach((value) => {
    cells += 1;
    if (value.length > MAX_CELL_CHARS) fail('file-cell', 'בקובץ יש תא ארוך מדי.');
  }));
  if (cells > MAX_CELLS) fail('file-cells', 'בקובץ יש יותר מדי תאים.');
  return rows;
}

export async function readScheduleFile(file, options) {
  if (!file || typeof file.arrayBuffer !== 'function') fail('file-required', 'יש לבחור קובץ.');
  const name = String(file.name || '');
  if (!/\.(csv|tsv|txt|xlsx)$/i.test(name)) {
    fail('file-type', 'יש לבחור XLSX, CSV או TSV.');
  }
  if (!Number.isFinite(file.size) || file.size <= 0) fail('file-empty', 'הקובץ ריק.');
  if (file.size > MAX_FILE_BYTES) fail('file-large', 'הקובץ גדול מ-2MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.xlsx$/i.test(name)) return readXlsx(bytes, name, options && options.month);
  let text;
  try { text = decode(bytes); }
  catch (_) { fail('file-encoding', 'לא ניתן לקרוא את קידוד הקובץ. שמור אותו כ-UTF-8.'); }
  const delimiter = delimiterFor(name, text);
  return Object.freeze({ name, kind: delimiter === ',' ? 'csv' : 'tsv', matrix: parseDelimited(text, delimiter) });
}

export const LIMITS = Object.freeze({
  MAX_FILE_BYTES, MAX_ROWS, MAX_CELLS, MAX_CELL_CHARS,
  MAX_ZIP_ENTRIES, MAX_ZIP_TOTAL_BYTES, MAX_ZIP_ENTRY_BYTES, MAX_ZIP_RATIO,
  MAX_MERGE_RANGES, MAX_MERGED_CELLS
});
