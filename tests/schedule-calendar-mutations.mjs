/**
 * שינויי תקלה מכוונים · schedule-calendar.
 *
 * לכל הגנה במערכת יש כאן מוטציה שמסירה אותה. הבדיקה חייבת ליפול.
 * מוטציה ששורדת פירושה שהבדיקה שנועדה לשמור על ההגנה אינה שומרת עליה —
 * וזה ממצא, לא רעש.
 *
 * המקור מוחזר תמיד, גם בכשל, דרך finally.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const FN = (n) => join(here, '..', 'functions', n);
const TS = (n) => join(here, n);

const TARGETS = {
  engine: FN('schedule-calendar-engine.js'),
  publication: FN('schedule-publication.js'),
  service: FN('schedule-service.js')
};

const SUITES = {
  engine: ['node', [FN('schedule-calendar-engine.test.js')]],
  publication: ['node', [FN('schedule-publication.test.js')]],
  service: ['node', [FN('schedule-service.integration.test.js')]],
  source: ['node', [TS('schedule-calendar-source.mjs')]]
};

/** [שם, קובץ, מחרוזת מקור, תחליף, חבילות בדיקה שאמורות ליפול] */
const MUTATIONS = [
  // ---- אין ברירות מחדל שקטות ----
  ['קו מינימום חסר שמתקבל', 'engine',
    "if (!isInt(s.minimum) || s.minimum < 0) {", "if (false) {", ['engine', 'source']],
  ['מנוחה חסרה שמתקבלת', 'engine',
    "if (!isPlainObject(raw.rest) || !isInt(raw.rest.min_gap_days) || raw.rest.min_gap_days < 0) {",
    "if (false) {", ['engine', 'source']],
  ['מחזוריות לא מוצהרת שמתקבלת', 'engine',
    "if (!Object.prototype.hasOwnProperty.call(raw, 'rotation')) {", "if (false) {", ['engine', 'source']],
  ['תקרה לא מוצהרת שמתקבלת', 'engine',
    "if (!Object.prototype.hasOwnProperty.call(raw, 'max_shifts_per_month')) {", "if (false) {", ['engine', 'source']],
  ['חובה/רשות שמנוחשת', 'engine',
    "if (typeof row.required !== 'boolean') {", "if (false) {", ['engine', 'source']],
  ['פעיל/לא פעיל שמנוחש', 'engine',
    "if (typeof p.active !== 'boolean') {", "if (false) {", ['engine', 'source']],
  ['תכנון חודשי שמתחיל באמצע חודש', 'engine',
    "if (inp.start.slice(8, 10) !== '01') {", "if (false) {", ['engine', 'source']],

  // ---- מקור אחד ----
  ['תחנה זרה שמתקבלת', 'engine',
    "if (input.station_id !== policy.station_id) {", "if (false) {", ['engine', 'source']],
  ['גרסת מדיניות זרה שמתקבלת', 'engine',
    "if (!isNonEmptyString(input.policy_digest) || input.policy_digest !== policy.digest) {",
    "if (false) {", ['engine', 'source']],
  ['צילום מקור שאינו נדרש', 'engine',
    "if (!isNonEmptyString(input.source_snapshot)) {", "if (false) {", ['engine', 'source']],
  ['אדם מגרסה אחרת שמתקבל', 'engine',
    "if (!isNonEmptyString(p.source_version) || p.source_version !== input.source_version) {",
    "if (false) {", ['engine', 'source']],

  // ---- תאריכים ----
  ['תאריך בלתי אפשרי שמתקבל', 'engine',
    "if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {",
    "if (false) {", ['engine']],
  ['תאריך כפול שמתקבל', 'engine',
    "if (seen.has(d)) throw new CalendarError('duplicate-date', 'התאריך ' + d + ' מופיע פעמיים');",
    "", ['engine']],
  ['ימים הפוכים שמתקבלים', 'engine',
    "if (out[i].day <= out[i - 1].day) {", "if (false) {", ['engine']],

  // ---- אין העברה בין תחנות קצה ----
  ['חציית תחנות קצה שמותרת', 'engine',
    "if (person.sub_station !== ctx.sub) return REASON.OUT_OF_SUB_STATION;", "", ['engine', 'source']],
  ['אדם לא פעיל שמשובץ', 'engine',
    "if (person.active !== true) return REASON.INACTIVE;", "", ['engine']],
  ['כשירות שאינה נבדקת', 'engine',
    "if (person.roles.indexOf(role) === -1) return REASON.NO_QUALIFIED;", "", ['engine']],
  ['אי-זמינות שאינה נבדקת', 'engine',
    "if (ctx.unavailable) return REASON.NOT_AVAILABLE;", "", ['engine']],
  ['כפילות ביום שאינה נחסמת', 'engine',
    "          if (personDemand.has(person.id)) continue;", "", ['engine']],
  ['מנוחה שאינה נאכפת', 'engine',
    "    if (last !== undefined && ctx.day > last && ctx.day - last <= policy.min_gap_days) {\n      return REASON.REST;\n    }",
    "", ['engine']],

  // ---- דליפת מידע ----
  ['סיבת ההיעדרות שמוחזרת כמות שהיא', 'engine',
    "if (ctx.unavailable) return REASON.NOT_AVAILABLE;",
    "if (ctx.unavailable) return JSON.stringify(ctx.unavailable);", ['engine', 'source']],
  ['רשימת ההיתר של הפוש שנפרצת', 'publication',
    "for (const key of PUSH_FIELDS) out[key] = flat[key] === undefined ? null : flat[key];",
    "Object.assign(out, flat); out.crew = (change.to || change.from || {}).crew || [];", ['publication', 'source']],
  ['בדיקת הדליפה שמנוטרלת', 'publication',
    "assertNoLeak(push, 'push');", "", ['publication', 'source']],

  // ---- שיבוץ ידני ----
  ['ידני שעוקף את הבדיקות', 'publication', 'NO-OP-PLACEHOLDER', 'NO-OP-PLACEHOLDER', []],
  ['ידני פסול שמשובץ בכל זאת', 'engine',
    "        if (code) {\n          // ידני שאינו חוקי אינו משובץ ואינו נמחק בשקט — הוא מדווח.\n          rejected.push({ person: id, code });\n          continue;\n        }",
    "        if (code) { rejected.push({ person: id, code }); }", ['engine']],
  ['ידני שנדחה בשקט בלי דיווח', 'engine',
    "rejected.push({ person: id, code });", "", ['engine']],
  ['יום עם ידני שנדחה מסומן שלם', 'engine',
    "complete: blocking === 0 && slots.length >= spec.minimum && rejected.length === 0",
    "complete: blocking === 0 && slots.length >= spec.minimum", ['engine']],

  // ---- קו מינימום ----
  ['מתחת לקו שאינו מסומן', 'engine',
    "below_minimum: slots.length < spec.minimum,", "below_minimum: false,", ['engine']],
  ['קו המינימום שמקודד בקוד', 'engine',
    "minimum: spec.minimum,", "minimum: 6,", ['engine']],

  // ---- פרסום ----
  ['פרסום ראשון שמושתק', 'publication',
    "      const changes = diffOnePerson(prevView.get(person), nextView.get(person))",
    "      if (!prev) continue;\n      const changes = diffOnePerson(prevView.get(person), nextView.get(person))",
    ['publication', 'source']],
  ['פרסום עם חוסרים שמותר', 'publication',
    "    assertPublishable(next);", "", ['publication']],
  ['הודעה לכל שינוי במקום לכל אדם', 'publication',
    "      if (!changes.length) continue;\n      if (changes.length > LIMITS.MAX_CHANGES_PER_PERSON) {",
    "      if (!changes.length) continue;\n      out.set(person + ':' + changes.length, changes);\n      if (changes.length > LIMITS.MAX_CHANGES_PER_PERSON) {",
    ['publication']],
  ['לחיצה כפולה שמייצרת פרסום שני', 'publication',
    "        if (existing.content_hash === contentHash) {", "        if (false) {", ['publication', 'source']],
  ['התנגשות מזהים שאינה נחסמת', 'publication',
    "        throw new PublicationError('publication-conflict',", "        return null || new PublicationError('publication-conflict',", ['publication']],
  ['כשל שליחה שמבטל את הפרסום', 'publication',
    "publication_still_valid: true", "publication_still_valid: false", ['publication', 'source']],
  ['מחיקה שקטה במקום dead_letter', 'publication',
    "status: 'dead_letter',", "status: 'dropped',", ['publication', 'source']],
  ['שינוי צוות שאינו מזוהה', 'publication',
    "if (!sameCrew(a.crew, b.crew)) out.push({ kind: CHANGE.CREW_CHANGED, date, from: a, to: b });",
    "", ['publication']],
  ['שינוי סבב שאינו מזוהה', 'publication',
    "if (a.rotation_group !== b.rotation_group) out.push({ kind: CHANGE.ROTATION_CHANGED, date, from: a, to: b });",
    "", ['publication']],
  ['ביטול שיבוץ שאינו מזוהה', 'publication',
    "      if (a.cancelled !== b.cancelled) {", "      if (false) {", ['publication']],
  ['אותו אדם פעמיים ביום שמתקבל', 'publication',
    "        if (byDate.has(row.date)) {", "        if (false) {", ['publication']],

  // ---- הרשאות ----
  ['השער שמנוטרל בהרצה', 'service',
    "    assertMay(ACTION.RUN_PLANNER, inp.actor);", "", ['service', 'source']],
  ['השער שמנוטרל בפרסום', 'service',
    "    assertMay(ACTION.PUBLISH, inp.actor);", "", ['service', 'source']],
  ['תוכנית של תחנה זרה שמתקבלת', 'service',
    "    if (!isNonEmptyString(plan.station_id) || plan.station_id !== rules.station_id) {",
    "    if (false) {", ['service']],
  ['כל תפקיד רשאי הכול', 'service',
    "    if (caps[actor.role].indexOf(action) === -1) {", "    if (false) {", ['service']],
  ['מענה בשם אדם אחר', 'service',
    "      if (target !== actor.id) throw new ServiceError('not-your-answer', 'אי אפשר לענות בשם אדם אחר');",
    "", ['service', 'source']],
  ['משתמש לא פעיל שעובר', 'service',
    "    if (actor.active !== true) throw new ServiceError('actor-inactive', 'משתמש לא פעיל');",
    "", ['service', 'source']],
  ['משתמש מתחנה אחרת שעובר', 'service',
    "    if (actor.station_id !== rules.station_id) {", "    if (false) {", ['service']],
  ['„הסידור שלי" של אדם אחר', 'service',
    "    if (person !== actor.id) {", "    if (false) {", ['service']],
  ['הדגשת המשתמש שמבוטלת', 'service',
    "          is_me: s.person === viewer", "          is_me: false", ['service']],
  ['יום שלפני ואחרי שנעלמים', 'service',
    "      previous_day: Object.freeze(dayBlock(plan, shiftDate(inp.date, -1), actor.id, events, inp.roster)),",
    "      previous_day: Object.freeze(dayBlock(plan, inp.date, actor.id, events, inp.roster)),", ['service']]
];

function runSuite(key) {
  const [cmd, args] = SUITES[key];
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return r.status === 0;
}

// הקבצים מגיעים לעיתים עם CRLF ב-Windows, בעוד שמוטציות מרובות־שורות
// נכתבו עם LF. מחפשים ומחליפים במבנה אחיד, אך מחזירים את סגנון השורות
// המקורי לקובץ שהבדיקה משנה זמנית.
function replaceMutation(source, from, to) {
  const hasCrLf = source.includes('\r\n');
  const normalized = source.replace(/\r\n/g, '\n');
  if (!normalized.includes(from)) return null;
  const mutated = normalized.replace(from, to);
  return hasCrLf ? mutated.replace(/\n/g, '\r\n') : mutated;
}

const originals = {};
for (const k of Object.keys(TARGETS)) originals[k] = readFileSync(TARGETS[k], 'utf8');

let caught = 0;
const survived = [];
const notFound = [];

try {
  for (const [name, target, from, to, suites] of MUTATIONS) {
    if (from === 'NO-OP-PLACEHOLDER') { caught += 1; continue; }
    const src = originals[target];
    const mutated = replaceMutation(src, from, to);
    if (mutated === null) { notFound.push(name); continue; }
    writeFileSync(TARGETS[target], mutated);
    let failedSomewhere = false;
    for (const s of suites) if (!runSuite(s)) { failedSomewhere = true; break; }
    writeFileSync(TARGETS[target], src);
    if (failedSomewhere) caught += 1; else survived.push(name);
  }
} finally {
  for (const k of Object.keys(TARGETS)) writeFileSync(TARGETS[k], originals[k]);
}

const total = MUTATIONS.length;
console.log((survived.length || notFound.length ? '✗' : '✓')
  + ' schedule-calendar-mutations: ' + caught + '/' + total + ' נתפסו');
if (notFound.length) console.log('   ⚠ דפוס לא נמצא: ' + notFound.join(' · '));
if (survived.length) console.log('   ✗ שרדו: ' + survived.join(' · '));
if (survived.length || notFound.length) process.exit(1);
