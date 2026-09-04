/* ====================================================================
 *  schedule-operations-mutations · 42H.2 — מוטציות על שלוש החבילות
 *
 *  כל מוטציה מסירה שער אחד (CAS, אימות חי, חסימת פער, מניעת מחיקה,
 *  אי-שינוי snapshot) ומצפה שלפחות אחת מהבדיקות תיפול. מוטציה ששורדת =
 *  שער בלי בדיקה. הקבצים משוחזרים תמיד (finally).
 * ==================================================================== */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FN = resolve(HERE, '..', 'functions');
const TARGETS = {
  runtime: resolve(FN, 'schedule-runtime.js'),
  edit: resolve(FN, 'schedule-edit.js'),
  quals: resolve(FN, 'schedule-qualifications.js'),
  gaps: resolve(FN, 'schedule-gaps.js')
};
const SUITES = {
  editUnit: [process.execPath, [resolve(FN, 'schedule-edit.test.js')]],
  editProbe: [process.execPath, [resolve(HERE, 'schedule-edit-runtime-probe.mjs')]],
  qualsUnit: [process.execPath, [resolve(FN, 'schedule-qualifications.test.js')]],
  qualsProbe: [process.execPath, [resolve(HERE, 'schedule-qualifications-runtime-probe.mjs')]],
  gapsUnit: [process.execPath, [resolve(FN, 'schedule-gaps.test.js')]],
  authority: [process.execPath, [resolve(HERE, 'schedule-hidden-authority-probe.mjs')]]
};

const MUTATIONS = [
  // --- חבילה א׳ · עריכה ---
  ['עריכה: אדם מופיע פעמיים ביום (ההעברה לא מסירה מהתחנה הקודמת)', 'edit',
    "        removeFromDay(edit.uid, date);          // העברה: פעם אחת ביום", "", ['editUnit']],
  ['עריכה: תאריך מחוץ לפרסום מתקבל', 'edit',
    "    if (date < from || date > to) {", "    if (false) {", ['editUnit']],
  ['עריכה: אדם שאינו במקור מתקבל להוספה', 'edit',
    "    if (!people.has(edit.uid) && !(removal && inPlan)) {", "    if (false) {", ['editUnit']],
  ['עריכה: התוכנית המקורית משתנה במקום עותק', 'edit',
    "  const rows = clone(plan.rows);", "  const rows = plan.rows;", ['editUnit']],
  ['עריכה: הבסיס לא נבדק בדוח (CAS)', 'runtime',
    "    if (!editBaseMatches(active.pointer, base)) {", "    if (false) {", ['editProbe']],
  ['עריכה: הבסיס לא נבדק בעסקת הטיוטה', 'runtime',
    "      if (!editBaseMatches(snaps[3].exists ? (snaps[3].data() || {}) : null, base)) {", "      if (false) {", ['editProbe']],
  ['עריכה: הבסיס לא נבדק בעסקת הפרסום', 'runtime',
    "      if (liveDraft.edited === true && !editBaseMatches(liveActive, liveDraft.edit_base)) {", "      if (false) {", ['editProbe']],
  ['עריכה: חתימת הדוח לא נבדקת בביצוע', 'runtime',
    "    if (!expectedDigest || expectedDigest !== basis.editDigest) {", "    if (false) {", ['editProbe']],
  ['עריכה: ניסיון חוזר בלי השוואת כוונה', 'runtime',
    "      if (before.request_fingerprint !== fingerprintOf(edits)) {", "      if (false) {", ['editProbe']],
  ['עריכה: אין יומן edit-draft', 'runtime',
    "        action: 'edit-draft', draft_id: draftId, request_id: requestId,", "        action: 'edit-draft-mutated', draft_id: draftId, request_id: requestId,", ['editProbe']],
  ['עריכה: previewScheduleEdit בלי שער אחראי סידור', 'runtime',
    "  async function previewScheduleEdit(req) {\n    const ctx = await context(req);\n    requireManager(ctx);",
    "  async function previewScheduleEdit(req) {\n    const ctx = await context(req);", ['authority', 'editProbe']],
  // --- חבילה ב׳ · כשירויות ---
  ['כשירויות: מחיקת מובנית מותרת', 'quals',
    "  if (entry.builtin) return { code: 'qualification-builtin', message: 'כשירות מובנית אינה נמחקת — אפשר להשבית אותה.' };", "", ['qualsUnit', 'qualsProbe']],
  ['כשירויות: מחיקה בשימוש מותרת', 'quals',
    "  if (count > 0) {", "  if (false) {", ['qualsUnit', 'qualsProbe']],
  ['כשירויות: הקריטיות של המובנות אינה קבועה', 'quals',
    "      critical: base.critical,               // קריטיות המובנות קבועה", "      critical: doc.critical === true,", ['qualsUnit']],
  ['כשירויות: כשירות מושבתת ניתנת להקצאה', 'quals',
    "    if (entry.active === false) fail('holdings-inactive', 'הכשירות „' + entry.label + '\" מושבתת ואינה ניתנת להקצאה.');", "", ['qualsUnit', 'qualsProbe']],
  ['כשירויות: מונה המחזיקים לא נבדק במחיקה (הוספה מקבילה שורדת)', 'runtime',
    "      if (liveMeta !== holdingsRevision) {", "      if (false) {", ['qualsProbe']],
  ['כשירויות: CAS על revision מבוטל בשמירה', 'runtime',
    "      if (liveRevision !== expectedRevision) {\n        throw new ScheduleRuntimeError('qualification-revision-stale', 'הכשירות השתנתה בינתיים. יש לרענן.', 'aborted');",
    "      if (false) {\n        throw new ScheduleRuntimeError('qualification-revision-stale', 'הכשירות השתנתה בינתיים. יש לרענן.', 'aborted');", ['qualsProbe']],
  ['כשירויות: אדם שאינו חבר תחנה מקבל כשירות', 'runtime',
    "      if (!scheduleAccess.activeMember(person, ctx.sid)) {\n        throw new ScheduleRuntimeError('person-not-member'", "      if (false) {\n        throw new ScheduleRuntimeError('person-not-member'", ['qualsProbe']],
  // --- חבילה ג׳ · פערים ---
  ['פערים: פער קריטי אינו חוסם', 'runtime',
    "    if (report.blocking.length) {\n      const error = new ScheduleRuntimeError('gaps-critical',", "    if (false) {\n      const error = new ScheduleRuntimeError('gaps-critical',", ['editProbe']],
  ['פערים: אישור לא נבדק', 'runtime',
    "    if (!scheduleGaps.acknowledgementValid(report, acknowledgement)) {", "    if (false) {", ['editProbe']],
  ['פערים: כל אישור מתקבל (לא בדיוק הרשימה)', 'gaps',
    "  return nonEmpty(acknowledgement) && acknowledgement === report.digest;", "  return nonEmpty(acknowledgement);", ['gapsUnit', 'editProbe']],
  ['פערים: מועמד שאינו פנוי (משובץ באותו יום) מוצע', 'gaps',
    "    const free = Array.from(people.keys()).filter((uid) => !assigned.has(uid) && !absent.has(uid))", "    const free = Array.from(people.keys()).filter((uid) => !absent.has(uid))", ['gapsUnit']],
  ['פערים: כשירות קריטית נספרת כפער אחר', 'gaps',
    "      (q.critical ? blocking : acknowledgeable).push(entry);", "      acknowledgeable.push(entry);", ['gapsUnit', 'editProbe']]
];

function runSuite(key) {
  const [cmd, args] = SUITES[key];
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return r.status === 0;
}

const originals = {};
for (const k of Object.keys(TARGETS)) originals[k] = readFileSync(TARGETS[k], 'utf8');
const sources = {};
for (const k of Object.keys(TARGETS)) sources[k] = originals[k].replace(/\r\n/g, '\n');

let caught = 0;
const survived = [];
const notFound = [];
try {
  for (const [name, target, from, to, suites] of MUTATIONS) {
    const src = sources[target];
    if (!src.includes(from)) { notFound.push(name); continue; }
    writeFileSync(TARGETS[target], src.replace(from, to));
    let failedSomewhere = false;
    for (const s of suites) if (!runSuite(s)) { failedSomewhere = true; break; }
    writeFileSync(TARGETS[target], src);
    if (failedSomewhere) caught += 1; else survived.push(name);
  }
} finally {
  for (const k of Object.keys(TARGETS)) writeFileSync(TARGETS[k], originals[k]);
}

const total = MUTATIONS.length;
console.log((survived.length || notFound.length ? '✗' : '✓') + ' schedule-operations-mutations: ' + caught + '/' + total + ' נתפסו');
if (notFound.length) console.log('   ⚠ דפוס לא נמצא: ' + notFound.join(' · '));
if (survived.length) console.log('   ✗ שרדו: ' + survived.join(' · '));
if (survived.length || notFound.length) process.exit(1);
