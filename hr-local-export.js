// Explicit, one-way local export. No network, persistent handles or browser database.
// File System Access has no exclusive-create/CAS: an external concurrent writer
// cannot be locked out. A fresh random run directory minimizes that race.
export const LOCAL_EXPORT_LIMITS = Object.freeze({ fileBytes: 2 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, files: 3000 });
const encoder = new TextEncoder();
const fail = message => { throw new Error(message); };
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail('מטא־נתונים לא תקינים.');
  return value.normalize('NFC');
}
function segment(value) {
  const safe = value.replace(/[<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/gu, '_').replace(/[. ]+$/u, '').slice(0, 80);
  if (!safe || safe === '.' || safe === '..') fail('שם קובץ לא תקין.');
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(safe) ? '_' + safe : safe;
}
export async function localExportSha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), v => v.toString(16).padStart(2, '0')).join('');
}
async function absent(dir, name, guard) {
  guard();
  try { await dir.getFileHandle(name); guard(); fail('כבר קיים קובץ ביעד; לא בוצעה דריסה.'); }
  catch (e) { guard(); if (e.name !== 'NotFoundError') throw e; }
}
async function writeNew(dir, name, bytes, guard) {
  await absent(dir, name, guard); guard();
  const file = await dir.getFileHandle(name, { create: true }); guard();
  const stream = await file.createWritable();
  try { guard(); await stream.write(bytes); guard(); await stream.close(); guard(); }
  catch (e) { try { await stream.abort(); } catch {} throw e; }
  const saved = await file.getFile(); guard();
  if (saved.size !== bytes.byteLength) fail('אימות גודל הקובץ נכשל.');
  const actual = await saved.arrayBuffer(); guard();
  const expectedHash = await localExportSha256(bytes); guard();
  const actualHash = await localExportSha256(actual); guard();
  if (actualHash !== expectedHash) fail('אימות תוכן הקובץ נכשל.');
  return expectedHash;
}
async function directory(parent, name, guard) {
  guard(); const dir = await parent.getDirectoryHandle(name, { create: true }); guard(); return dir;
}
function entry(value) {
  if (!value || !['document', 'hours'].includes(value.kind) || !(value.bytes instanceof Uint8Array)) fail('קובץ לייצוא אינו תקין.');
  const uid = text(value.uid, 128), employeeNumber = text(value.employeeNumber, 64), fullName = text(value.fullName, 160), name = text(value.name, 160);
  if (/[\/\\]/u.test(uid + employeeNumber)) fail('מזהה עובד לא תקין.');
  if (value.kind === 'hours' && !/^\d{4}-(0[1-9]|1[0-2])$/u.test(value.month || '')) fail('חודש לא תקין.');
  if (value.bytes.byteLength > LOCAL_EXPORT_LIMITS.fileBytes) fail('הקובץ חורג מ־2MiB.');
  return { uid, employeeNumber, fullName, name, kind: value.kind, month: value.kind === 'hours' ? value.month : null, bytes: value.bytes.slice() };
}

export async function exportLocalFiles(selectedDirectory, files, { stationId, guard, progress = () => {} } = {}) {
  if (typeof stationId!=='string'||!stationId.trim()||stationId.length>128||/[\/\\\u0000-\u001f]/u.test(stationId)
      ||typeof guard !== 'function' || !selectedDirectory || typeof selectedDirectory.getDirectoryHandle !== 'function') fail('נדרשת תחנה וזהות מאומתות ותיקייה נבחרת.');
  guard();
  const result = { schema: 'resq-local-export-v1', run_id: crypto.randomUUID(), complete: false, files: [], total_bytes: 0 };
  const employees = new Map(), folders = new Map();
  let run = null;
  try {
    const rootName=stationId==='eilat_102'?'תחנת אילת משאבי אנוש':'משאבי אנוש - '+segment(stationId);
    const base = await directory(selectedDirectory, rootName, guard);
    const runName = 'run-' + result.run_id;
    try { await base.getDirectoryHandle(runName); guard(); fail('תיקיית הריצה כבר קיימת.'); }
    catch (e) { guard(); if (e.name !== 'NotFoundError') throw e; }
    run = await directory(base, runName, guard);
    await writeNew(run, 'run.json', encoder.encode(JSON.stringify({ schema: result.schema, run_id: result.run_id, complete: false,
      note: 'Only a verified manifest.json marks completion. Local files cannot be revoked remotely.' })), guard);
    for await (const raw of files) {
      guard();
      if (result.files.length >= LOCAL_EXPORT_LIMITS.files) fail('חריגה ממגבלת 3000 קבצים.');
      const item = entry(raw);
      if (result.total_bytes + item.bytes.byteLength > LOCAL_EXPORT_LIMITS.totalBytes) fail('חריגה ממגבלת 128MiB.');
      const binding = JSON.stringify([item.uid, item.fullName]);
      if (employees.has(item.employeeNumber) && employees.get(item.employeeNumber) !== binding) fail('מספר עובד משויך לזהויות שונות.');
      employees.set(item.employeeNumber, binding);
      const folderName = segment(item.fullName) + ' [' + segment(item.employeeNumber) + ']';
      if (folders.has(folderName) && folders.get(folderName) !== item.employeeNumber) fail('שמות תיקיות מתנגשים.');
      folders.set(folderName, item.employeeNumber);
      const person = await directory(run, folderName, guard);
      const kindName = item.kind === 'hours' ? 'דוחות שעות' : 'מסמכים';
      let destination = await directory(person, kindName, guard);
      if (item.month) destination = await directory(destination, item.month, guard);
      const digest = await localExportSha256(item.bytes); guard();
      const outputName = String(result.files.length + 1).padStart(4, '0') + '-' + digest + '-' + segment(item.name);
      await writeNew(destination, outputName, item.bytes, guard); guard();
      result.files.push({ path: [folderName, kindName, ...(item.month ? [item.month] : []), outputName].join('/'),
        uid: item.uid, employee_number: item.employeeNumber, bytes: item.bytes.byteLength, sha256: digest });
      result.total_bytes += item.bytes.byteLength;
      progress({ completed: result.files.length, bytes: result.total_bytes }); guard();
    }
    guard(); result.complete = true;
    await writeNew(run, 'manifest.json', encoder.encode(JSON.stringify(result, null, 2)), guard); guard();
    return result;
  } catch (cause) {
    const error = new Error('הייצוא נעצר. ייתכן שנשמרו קבצים חלקיים בתיקיית הריצה; לא נמחקו קבצים.');
    error.cause = cause; error.completed = result.files.length; error.runId = result.run_id;
    throw error;
  }
}
