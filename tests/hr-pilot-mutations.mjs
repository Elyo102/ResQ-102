/* ======================================================================
 *  hr-pilot-mutations — האם הבדיקות באמת תופסות הסרת שער
 *
 *  ----------------------------------------------------------------
 *  למה הקובץ הזה, ולא עוד בדיקה
 *  ----------------------------------------------------------------
 *  בדיקה שעוברת מוכיחה שהקוד הנוכחי מתנהג כמצופה. היא **אינה**
 *  מוכיחה שהיא תשים לב אם מישהו יסיר את השער שהיא כביכול שומרת
 *  עליו. שתי הטענות שונות לגמרי, והשנייה היא זו שחשובה בעוד חצי
 *  שנה, כשמישהו „מפשט" תנאי.
 *
 *  ⭐ לכן כאן לא מריצים את הבדיקות — **שוברים את הקוד** ומריצים
 *  אותן. כל מוטציה מסירה שער אחד: סמכות, סינון תחנה, הפרדת
 *  „ממתין" מ„מאושר", סירוב לדור חלקי, ברירת המחדל של המיגרציה.
 *  מוטציה שהבדיקות אינן תופסות היא בדיקה שלא שומרת על כלום.
 *
 *  אחת המוטציות מחזירה את הכפיל עצמו למצבו הקודם — זה שסינן `==`
 *  בלבד והחזיר כל שורה על כל מפעיל אחר. גם הוא שער, והוא השער
 *  שהופך את שאר הבדיקות ממשמעותיות לחסרות משמעות.
 *
 *  ----------------------------------------------------------------
 *  מה זה אינו
 *  ----------------------------------------------------------------
 *  זו בדיקת מקור על הקוד של השרת. היא אינה אוכפת כללי Firestore
 *  ואינה אמולטור, ואינה מוכיחה דבר על אינדקסים.
 * ====================================================================== */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const functionsDir = path.join(here, '..', 'functions');

const BOXES = 'hr-request-boxes.test.js';
const MONTHLY = 'hr-monthly-summary.test.js';
const BACKFILL = 'hr-months-backfill.test.js';
const REMOVAL = 'hr-removal-authority.test.js';
const FIDELITY = 'hr-pilot-harness-fidelity.test.js';
const SCALE = 'hr-monthly-scale.test.js';

const mutations = [
  {
    name: 'the HR authority gate on the box counts is removed',
    file: 'hr-requests.js', test: BOXES,
    find: "    const r = request(req, []);\n    if (!manager(r.ctx)) throw error('permission-denied', 'HR authority required.');",
    replace: "    const r = request(req, []);"
  },
  {
    name: 'an employee list stops being filtered to its owner',
    file: 'hr-requests.js', test: BOXES,
    find: "      if (!inbox) q = q.where('owner_uid', '==', r.ctx.uid);",
    replace: "      if (false) q = q.where('owner_uid', '==', r.ctx.uid);"
  },
  {
    name: 'the employee path starts receiving names too',
    file: 'hr-requests.js', test: BOXES,
    find: "      if (inbox && items.length && typeof tx.getAll === 'function') {",
    replace: "      if (items.length && typeof tx.getAll === 'function') {"
  },
  {
    name: 'a stored months value stops being re-derived from the range',
    file: 'hr-requests.js', test: BOXES,
    find: "      if (own(value, 'months') && !sameMonths(value.months, value.from_date, value.to_date)) {",
    replace: "      if (false) {"
  },
  {
    name: 'the declared absence bound is quietly raised',
    file: 'hr-monthly-summary.js', test: MONTHLY,
    find: 'const ABSENCE_CAP = 5000;',
    replace: 'const ABSENCE_CAP = 50000;'
  },
  {
    name: 'the uploader check on file removal is removed',
    file: 'hr-requests.js', test: REMOVAL,
    find: "        if (a.actor_uid !== ctx.uid) throw error('permission-denied', 'Only the person who uploaded this file may remove it.');",
    replace: "        if (false) throw error('permission-denied', 'Only the person who uploaded this file may remove it.');"
  },
  {
    name: 'a pending absence starts counting as approved',
    file: 'hr-monthly-summary.js', test: MONTHLY,
    find: "        const side = value.decision === 'approved' ? bucket.approved : bucket.pending;",
    replace: '        const side = bucket.approved;'
  },
  {
    name: 'a partial generation becomes publishable',
    file: 'hr-monthly-summary.js', test: MONTHLY,
    find: "      if (generation.state !== 'complete' && generation.state !== 'ready') {",
    replace: '      if (false) {'
  },
  {
    name: 'the station hour threshold is replaced by one constant',
    file: 'hr-monthly-summary.js', test: MONTHLY,
    find: '    return Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_HOUR_LIMIT;',
    replace: '    return DEFAULT_HOUR_LIMIT;'
  },
  {
    name: 'the station identity on an absence document stops being checked',
    file: 'hr-monthly-summary.js', test: MONTHLY,
    find: "        if (!plain(value) || value.schema !== 'hr-request-v1' || value.station_id !== sid",
    replace: "        if (!plain(value) || value.schema !== 'hr-request-v1' || false"
  },
  {
    name: 'coverage is declared complete regardless of what the backfill left',
    file: 'hr-monthly-summary.js', test: MONTHLY,
    find: "    return left === 0 ? 'complete' : 'legacy_pending';",
    replace: "    return 'complete';"
  },
  {
    name: 'absence days stop being clipped to the month',
    file: 'hr-monthly-summary.js', test: MONTHLY,
    find: '  const lower = Math.max(start, bounds.first), upper = Math.min(end, bounds.last);',
    replace: '  const lower = start, upper = end;'
  },
  {
    name: 'an open-ended workforce case stops being recognised as open',
    file: 'hr-monthly-summary.js', test: MONTHLY,
    find: "        const openEnded = !own(value, 'end_date') || value.end_date === null || value.end_date === '';",
    replace: '        const openEnded = false;'
  },
  {
    name: 'the migration starts writing unless told not to',
    file: 'hr-months-backfill.js', test: BACKFILL,
    find: '    const dryRun = !(input && input.dry_run === false);',
    replace: '    const dryRun = !!(input && input.dry_run === true);'
  },
  {
    name: 'the migration starts overwriting a contradicting months value',
    file: 'hr-months-backfill.js', test: BACKFILL,
    find: "      if (own(value, 'months')) {\n        if (sameMonths(value.months, value.from_date, value.to_date)) counts.already += 1;\n        else counts.conflicting += 1;\n        continue;\n      }",
    replace: "      if (own(value, 'months') && sameMonths(value.months, value.from_date, value.to_date)) {\n        counts.already += 1;\n        continue;\n      }"
  },
  {
    name: 'the inbox goes back to one read per row instead of one batched read',
    file: 'hr-requests.js', test: BOXES,
    find: '        const snaps = await tx.getAll(...uids.map(uid => root(r.ctx.sid).collection(\'users\').doc(uid)));',
    replace: '        const snaps = await Promise.all(uids.map(uid => tx.get(root(r.ctx.sid).collection(\'users\').doc(uid))));'
  },
  {
    name: 'the push job starts carrying the kind of the report',
    file: 'hr-requests.js', test: BOXES,
    find: "            type: op === 'nudge' ? 'hr_nudge' : ownerNotification ? 'hr_reply' : 'hr_request',",
    replace: "            type: op === 'nudge' ? 'hr_nudge' : ownerNotification ? 'hr_reply' : 'hr_request',\n            ...(own(p, 'kind') ? { request_kind: p.kind } : {}),"
  },
  {
    name: 'the monthly build goes back to one hours read per employee',
    file: 'hr-monthly-summary.js', test: SCALE,
    find: "    const reports = reportRefs.length && typeof db.getAll === 'function'\n      ? await db.getAll(...reportRefs) : [];",
    replace: '    const reports = await Promise.all(reportRefs.map((ref) => ref.get()));'
  },
  {
    name: 'the test double goes back to passing every row for every operator but ==',
    file: 'hr-pilot-test-harness.js', test: FIDELITY,
    find: '      for (const [f, op, val] of q._w) rows = rows.filter(([, v]) => matches(v[f], op, val));',
    replace: "      for (const [f, op, val] of q._w) rows = rows.filter(([, v]) => (op === '==' ? v[f] === val : true));"
  }
];

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-hr-pilot-mutations-'));
let caught = 0;

try {
  /* בדיקת שפיות אחת לפני הכול: הקוד כמו שהוא — ולא מוטנטי — חייב
   * לעבור. אחרת „נתפס" אינו אומר דבר, כי הכול נתפס. */
  const clean = path.join(tempRoot, 'clean');
  fs.cpSync(functionsDir, clean, { recursive: true });
  for (const file of new Set(mutations.map(m => m.test))) {
    const result = spawnSync(process.execPath, [file], { cwd: clean, encoding: 'utf8', timeout: 120_000, windowsHide: true });
    assert.equal(result.status, 0,
      'the unmutated tree must pass ' + file + '\nstdout:\n' + result.stdout + '\nstderr:\n' + result.stderr);
  }
  console.log('✓ baseline: the unmutated tree passes every test used below');

  mutations.forEach((mutation, index) => {
    const dir = path.join(tempRoot, String(index + 1));
    fs.cpSync(functionsDir, dir, { recursive: true });
    const target = path.join(dir, mutation.file);
    const source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
    const occurrences = source.split(mutation.find).length - 1;
    assert.equal(occurrences, 1, 'mutation target must appear exactly once: ' + mutation.name);
    fs.writeFileSync(target, source.replace(mutation.find, mutation.replace));
    const result = spawnSync(process.execPath, [mutation.test],
      { cwd: dir, encoding: 'utf8', timeout: 120_000, windowsHide: true });
    assert.notEqual(result.status, 0,
      'MUTATION SURVIVED — ' + mutation.name + ' in ' + mutation.file
      + ' was not caught by ' + mutation.test
      + '\nstdout:\n' + result.stdout + '\nstderr:\n' + result.stderr);
    caught += 1;
    console.log('✓ caught by ' + mutation.test + ': ' + mutation.name);
  });
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

assert.equal(caught, mutations.length);
console.log('');
console.log('NOT RUN — Firestore rules and index behaviour. Every mutation here is a source');
console.log('mutation caught by a server test against an in-memory double.');
console.log('');
console.log(caught + ' HR pilot authority and filter mutations caught; 0 survived.');
