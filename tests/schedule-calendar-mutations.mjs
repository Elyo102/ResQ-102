/**
 * שינויי תקלה מכוונים · schedule-calendar.
 *
 * לכל הגנה במערכת יש כאן מוטציה שמסירה אותה. הבדיקה חייבת ליפול.
 * מוטציה ששורדת פירושה שהבדיקה שנועדה לשמור על ההגנה אינה שומרת עליה —
 * וזה ממצא, לא רעש.
 *
 * המקור מוחזר תמיד, גם בכשל, דרך finally.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));

// Deliberate mutations must never touch the active checkout.  A previous hard
// interruption proved that `finally` is not a sufficient recovery boundary.
// The controller mirrors only the pure calendar modules and their suites into
// a random temp root, then this same file runs there as the guarded worker.
const sandboxFlag = process.env.RESQ_SCHEDULE_MUTATION_SANDBOX === '1';
if (!sandboxFlag) {
  const activeRoot = resolve(here, '..');
  const activeTargets = [
    'functions/schedule-calendar-engine.js',
    'functions/schedule-publication.js',
    'functions/schedule-service.js'
  ];
  const copied = [
    ...activeTargets,
    'functions/schedule-calendar-engine.test.js',
    'functions/schedule-publication.test.js',
    'functions/schedule-service.integration.test.js',
    'tests/schedule-calendar-source.mjs',
    'tests/schedule-calendar-mutations.mjs'
  ];
  const before = new Map(activeTargets.map(name => [name, readFileSync(join(activeRoot, name))]));
  const tempRoot = mkdtempSync(join(tmpdir(), 'resq-schedule-mutations-'));
  const marker = randomUUID();
  let status = 1;
  try {
    mkdirSync(join(tempRoot, 'functions'), { recursive:true });
    mkdirSync(join(tempRoot, 'tests'), { recursive:true });
    for (const name of copied) copyFileSync(join(activeRoot, name), join(tempRoot, name));
    writeFileSync(join(tempRoot, '.resq-mutation-sandbox'), marker, { encoding:'utf8', flag:'wx' });
    const child = spawnSync(process.execPath, [join(tempRoot, 'tests', 'schedule-calendar-mutations.mjs')], {
      cwd:tempRoot,
      stdio:'inherit',
      timeout:10 * 60 * 1000,
      env:{
        ...process.env,
        RESQ_SCHEDULE_MUTATION_SANDBOX:'1',
        RESQ_SCHEDULE_MUTATION_ROOT:tempRoot,
        RESQ_SCHEDULE_MUTATION_MARKER:marker
      }
    });
    if (child.error) throw child.error;
    if (!Number.isInteger(child.status)) throw new Error('mutation worker ended without an exit status');
    status = child.status;
  } finally {
    for (const [name, bytes] of before) {
      const after = readFileSync(join(activeRoot, name));
      if (!after.equals(bytes)) throw new Error('active source changed during isolated mutation run: ' + name);
    }
    rmSync(tempRoot, { recursive:true, force:true, maxRetries:3 });
  }
  process.exit(status);
}

const declaredRoot = resolve(String(process.env.RESQ_SCHEDULE_MUTATION_ROOT || ''));
const realTemp = realpathSync(tmpdir());
const realRoot = realpathSync(declaredRoot);
const relativeToTemp = relative(realTemp, realRoot);
const markerPath = join(realRoot, '.resq-mutation-sandbox');
if (!relativeToTemp || relativeToTemp.startsWith('..' + sep) || relativeToTemp === '..'
    || !existsSync(markerPath)
    || readFileSync(markerPath, 'utf8') !== process.env.RESQ_SCHEDULE_MUTATION_MARKER
    || resolve(here, '..') !== realRoot) {
  throw new Error('mutation worker refused a non-temporary or unmarked root');
}

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
  ['תכנון שנתי שמצטמצם שוב לשלושה חודשים', 'engine',
    'MAX_MONTHS: 12,', 'MAX_MONTHS: 3,', ['engine']],
  ['טווח ביניים לא נתמך שמתקבל', 'engine',
    "if (!isInt(months) || [1, 2, 3, LIMITS.MAX_MONTHS].indexOf(months) === -1) {",
    "if (!isInt(months) || months < 1 || months > LIMITS.MAX_MONTHS) {", ['engine']],

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
    "        if (person.active !== true) {\n          throw new CalendarError('locked-person-inactive', 'האדם ' + manual.person + ' אינו פעיל');\n        }",
    "        if (false) {\n          throw new CalendarError('locked-person-inactive', 'האדם ' + manual.person + ' אינו פעיל');\n        }", ['engine']],
  ['כשירות שאינה נבדקת', 'engine',
    "        if (wantedRole !== null && person.roles.indexOf(wantedRole) === -1) warningSet.add(REASON.NO_QUALIFIED);",
    "", ['engine']],
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
    "    for (const key of PUSH_FIELDS) {\n      if (flat[key] !== undefined && flat[key] !== null) out[key] = flat[key];\n    }",
    "    Object.assign(out, flat); out.crew = (change.to || change.from || {}).crew || [];",
    ['publication', 'source']],
  ['בדיקת הדליפה שמנוטרלת', 'publication',
    "assertNoLeak(push, 'push');", "", ['publication', 'source']],

  // ---- שיבוץ ידני ----
  ['ידני שעוקף את הבדיקות', 'publication', 'NO-OP-PLACEHOLDER', 'NO-OP-PLACEHOLDER', []],
  ['אדם ידני לא מוכר שאינו נחסם', 'engine',
    "        if (!person) {\n          throw new CalendarError('locked-person-unknown', 'האדם ' + manual.person + ' אינו במקור כוח האדם');\n        }",
    "        if (false) {\n          throw new CalendarError('locked-person-unknown', 'האדם ' + manual.person + ' אינו במקור כוח האדם');\n        }", ['engine']],
  ['כפילות ידנית באותו יום שאינה נחסמת', 'engine',
    "        if (reservedManual.has(manual.person)) {",
    "        if (false) {", ['engine']],
  ['אזהרת מעבר תחנת קצה שאובדת', 'engine',
    "        if (person.sub_station !== sub) warningSet.add(REASON.OUT_OF_SUB_STATION);",
    "", ['engine']],

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
  ['פערי כוח אדם חוזרים להיות חסם', 'publication',
    'if (summary.rejected_manual > 0) {',
    'if (summary.rejected_manual > 0 || summary.blocking_gaps > 0 || summary.days_below_minimum > 0) {',
    ['publication']],
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

for (const suite of ['engine', 'publication', 'service', 'source']) {
  if (!runSuite(suite)) {
    console.error('✗ isolated baseline suite failed before mutations: ' + suite);
    process.exit(1);
  }
}

const originals = {};
for (const k of Object.keys(TARGETS)) originals[k] = readFileSync(TARGETS[k], 'utf8');
// Worktrees on Windows may preserve CRLF in the targets while the deliberately
// multi-line mutation needles below use LF.  Keep the exact raw bytes for the
// finally restoration; normalize only the transient source used for matching
// and mutation so every guard is tested regardless of checkout line endings.
const mutationSources = {};
for (const k of Object.keys(TARGETS)) mutationSources[k] = originals[k].replace(/\r\n/g, '\n');

let caught = 0;
const survived = [];
const notFound = [];

try {
  for (const [name, target, from, to, suites] of MUTATIONS) {
    if (from === 'NO-OP-PLACEHOLDER') { caught += 1; continue; }
    const src = mutationSources[target];
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
console.log((survived.length || notFound.length ? '✗' : '✓')
  + ' schedule-calendar-mutations: ' + caught + '/' + total + ' נתפסו');
if (notFound.length) console.log('   ⚠ דפוס לא נמצא: ' + notFound.join(' · '));
if (survived.length) console.log('   ✗ שרדו: ' + survived.join(' · '));
if (survived.length || notFound.length) process.exit(1);
