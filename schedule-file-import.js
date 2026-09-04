const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 400;
const MAX_CELLS = 40000;
const MAX_CELL_CHARS = 2000;

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

export async function readScheduleFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function') fail('file-required', 'יש לבחור קובץ.');
  const name = String(file.name || '');
  if (!/\.(csv|tsv|txt)$/i.test(name)) {
    fail('file-type', 'בשלב זה יש לבחור CSV או TSV. מ-Excel או Google Sheets יש להוריד כ-CSV.');
  }
  if (!Number.isFinite(file.size) || file.size <= 0) fail('file-empty', 'הקובץ ריק.');
  if (file.size > MAX_FILE_BYTES) fail('file-large', 'הקובץ גדול מ-2MB.');
  let text;
  try { text = decode(new Uint8Array(await file.arrayBuffer())); }
  catch (_) { fail('file-encoding', 'לא ניתן לקרוא את קידוד הקובץ. שמור אותו כ-UTF-8.'); }
  const delimiter = delimiterFor(name, text);
  return Object.freeze({ name, kind: delimiter === ',' ? 'csv' : 'tsv', matrix: parseDelimited(text, delimiter) });
}

export const LIMITS = Object.freeze({ MAX_FILE_BYTES, MAX_ROWS, MAX_CELLS, MAX_CELL_CHARS });
