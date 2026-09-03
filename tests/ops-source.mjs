/* ניטור, גיבוי וחוות דעת — בדיקות מקור והתנהגות טהורה.
 * כל טענה על קוד נבדקת על קוד בלי הערות. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSource } from './source-text.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readSource(path.join(root, file));
function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log('✓ ' + name); }

const incident = read('functions/incident-log.js');
const feedback = read('functions/feedback.js');
const client = read('incident-client.js');
const page = read('feedback.html');
const pageLogic = read('feedback.js');
const exporter = read('ops-export.mjs');
const backup = read('ops-backup.mjs');
const gitignore = read('.gitignore');
const indexes = JSON.parse(read('firestore.indexes.json'));
const nav = read('nav.js');

// --- שרת: אין לוגים, אין זהות ביומן התקלות ---
check('the two server modules never log and never import Firebase', () => {
  for (const [name, src] of [['incident-log', incident], ['feedback', feedback]]) {
    const code = stripComments(src);
    for (const token of ['console.log', 'console.error', 'console.warn', 'logger.', "require('firebase", 'process.env']) {
      assert.equal(code.includes(token), false, name + ' מכיל ' + token);
    }
  }
});

check('the incident record carries no identity field', () => {
  const code = stripComments(incident);
  const at = code.indexOf('const base = {');
  const record = code.slice(at, code.indexOf('tx.set(ref, base', at));
  for (const field of ['uid', 'actor_uid', 'reporter', 'email', 'full_name', 'employee_number', 'emp:']) {
    assert.equal(record.includes(field), false, 'הרשומה נושאת ' + field);
  }
  assert.ok(code.includes("'kind', 'screen', 'version', 'code', 'message', 'frame', 'callable'"),
    'רשימת הקלט המותר השתנתה');
  assert.ok(code.includes("hasOwnProperty.call(data, 'stationId')"), 'stationId מהלקוח אינו נדחה');
});

check('the scrub rules cover email, phone, uid, hex and query strings', () => {
  const code = stripComments(incident);
  const rules = code.slice(code.indexOf('const SCRUB_RULES'), code.indexOf('function scrub('));
  for (const replacement of ['[email]', '[phone]', '[uid]', '[hex]', '?[query]', '[num]']) {
    assert.ok(rules.includes("'" + replacement + "'"), 'חסר כלל ' + replacement);
  }
});

check('feedback keeps identity by decision, and refuses unknown fields', () => {
  const code = stripComments(feedback);
  const at = code.indexOf('tx.set(ref, {');
  const record = code.slice(at, code.indexOf('});', at));
  for (const field of ['uid,', 'role,', 'employee_number: emp', 'allow_contact: plan.allowContact', 'text: plan.text']) {
    assert.ok(record.includes(field), 'הרשומה חסרה ' + field);
  }
  assert.ok(code.includes("'request_id', 'screen', 'version', 'category', 'rating', 'text', 'allow_contact'"));
  assert.ok(code.includes("hasOwnProperty.call(data, 'stationId')"));
  assert.ok(!/scrub\(/.test(code), 'טקסט של אדם עובר ניקוי — זה מעוות מה שנאמר');
});

// --- לקוח ---
check('the client reporter is capped, deduplicated and swallows its own failures', () => {
  const code = stripComments(client);
  assert.ok(code.includes('maxPerLoad'), 'אין תקרה לטעינה');
  assert.ok(code.includes('seen.has(key)'), 'אין דה-דופליקציה');
  assert.ok(/catch \(ignore\) \{\s*return false;/.test(code), 'כישלון הדיווח אינו נבלע');
  assert.ok(code.includes("SKIP_CODES = ['functions/unauthenticated']"));
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(code), 'הלקוח שומר משהו מקומית');
  const body = code.slice(code.indexOf('export function buildReport('), code.indexOf('export function createIncidentReporter('));
  for (const field of ['kind', 'screen', 'version', 'code', 'message', 'frame', 'callable']) {
    assert.ok(new RegExp('\\b' + field + '\\b').test(body), 'buildReport חסר ' + field);
  }
  assert.ok(!/uid|email|displayName|full_name/.test(body), 'buildReport שולח זהות');
});

check('the feedback page is member-gated, calls only its own callable, and reports its own incidents', () => {
  assert.ok(page.includes('MEMBER_ROLES.indexOf(c.role) !== -1'), 'אין שער חברות');
  assert.ok(page.includes("location.replace('./login.html?next=feedback.html')"));
  assert.ok(page.includes("httpsCallable(fns, 'submitFeedback')"));
  assert.ok(page.includes("installIncidentReporter({ fns, httpsCallable, version: APP_VERSION })"));
  assert.equal((page.match(/httpsCallable\(fns, '/g) || []).length, 1, 'המסך קורא ליותר מפעולה אחת');
  assert.ok(!/stationId:/.test(page), 'המסך שולח תחנה');
  const logic = stripComments(pageLogic);
  assert.ok(logic.includes("subtle.digest('SHA-256'"), 'מזהה הבקשה אינו נגזר מהתוכן');
  assert.ok(logic.includes('TEXT_MAX = 1000') && logic.includes('TEXT_MIN = 3'));
});

check('the feedback screen is in the navigation for members', () => {
  assert.ok(/href: 'feedback\.html',\s*label: 'חוות דעת',\s*who: 'member'/.test(nav));
});

// --- ייצוא וגיבוי ---
check('the export writes only Markdown, and the personal file is git-ignored', () => {
  const code = stripComments(exporter);
  const writes = code.match(/\['[a-z]+\.[a-z]+', render/g) || [];
  assert.equal(writes.length, 3, 'מספר קובצי הפלט השתנה');
  writes.forEach((w) => assert.ok(w.includes('.md'), 'פלט שאינו .md: ' + w));
  assert.ok(!/writeFileSync\([^)]*\.(jsonl|txt|json)/.test(code) && !/\.jsonl|\.txt'/.test(code),
    'הייצוא כותב קובץ שאינו md');
  assert.ok(gitignore.includes('_ניטור/feedback.md'), 'feedback.md אינו ב-.gitignore');
  assert.ok(gitignore.includes('_גיבוי/'), '_גיבוי אינו ב-.gitignore');
  assert.ok(code.includes("/^[a-z]{2,40}$/.test(out.by)"), 'פעולת טיפול מקבלת זהות במקום תווית');
});

check('the backup bundles every branch and verifies it before writing the manifest', () => {
  const code = stripComments(backup);
  assert.ok(code.includes("['bundle', 'create', bundle, '--all']"));
  assert.ok(code.includes("['bundle', 'verify', bundle]"));
  assert.ok(code.indexOf("'verify'") < code.indexOf('renderManifest({'), 'המניפסט נכתב לפני האימות');
  assert.ok(!/require\(|import .*firebase|execFileSync\('gcloud|spawnSync\('gcloud|firestore\./i.test(code), 'הגיבוי המקומי נוגע בענן');
});

check('the three new collections carry a TTL, and feedback deliberately does not', () => {
  const ttl = new Set(indexes.fieldOverrides.filter((f) => f.ttl === true && f.fieldPath === 'expires_at')
    .map((f) => f.collectionGroup));
  for (const cg of ['incidents', 'incident_days', 'feedback_quota']) assert.ok(ttl.has(cg), 'אין TTL ל-' + cg);
  assert.equal(ttl.has('feedback'), false, 'ל-feedback יש TTL — חוות דעת אינה פגה');
});

// --- התנהגות טהורה של הייצוא והגיבוי ---
const exporterModule = await import(pathToFileURL(path.join(root, 'ops-export.mjs')).href);
const backupModule = await import(pathToFileURL(path.join(root, 'ops-backup.mjs')).href);

check('parseArgs refuses identities as labels and unknown flags', () => {
  assert.throws(() => exporterModule.parseArgs(['--resolve', 'a'.repeat(40), '--by', 'u1@x.co']), /תווית/);
  assert.throws(() => exporterModule.parseArgs(['--bogus']), /לא מוכר/);
  assert.throws(() => exporterModule.parseArgs(['--station', '../x']), /station/);
  const ok = exporterModule.parseArgs(['--project', 'demo', '--station', 'eilat_102', '--mark-read', '--by', 'claude']);
  assert.equal(ok.markRead, true);
  assert.equal(ok.out, '_ניטור');
});

check('renderIncidents lists open first, and the machine block round-trips', () => {
  const rows = [
    { fingerprint: 'a'.repeat(40), status: 'open', count: 3, kind: 'client-error', code: 'TypeError',
      screens: ['swaps.html'], versions: ['42G.0'], first_seen_iso: '2026-09-01T00:00:00.000Z',
      last_seen_iso: '2026-09-03T00:00:00.000Z', sample_message: 'x | y', sample_frame: 'swaps.js:1' },
    { fingerprint: 'b'.repeat(40), status: 'resolved', count: 1, kind: 'manual', code: 'X',
      resolved_by: 'codex', resolved_at: '2026-09-02T00:00:00.000Z', note: 'fixed' }
  ];
  const md = exporterModule.renderIncidents(rows, { station: 'eilat_102', now: '2026-09-03T10:00:00.000Z', days: 30 });
  assert.ok(md.indexOf('## פתוחות') < md.indexOf('aaaaaaaaaaaa'));
  assert.ok(md.includes('x \\| y'), 'צינור בטבלה אינו מוגן');
  const json = JSON.parse(md.slice(md.indexOf('```json') + 7, md.lastIndexOf('```')));
  assert.equal(json.length, 2);
  assert.equal(json[1].resolved_by, 'codex');
});

check('renderFeedback warns about personal data and quotes the text as written', () => {
  const md = exporterModule.renderFeedback([{ id: 'f_1', uid: 'u1', role: 'firefighter', employee_number: '9001',
    screen: 'swaps.html', category: 'problem', rating: 2, text: 'שורה\nשנייה', allow_contact: true,
    status: 'new', created_at_iso: '2026-09-03T09:00:00.000Z', version: '42G.0' }],
  { station: 'eilat_102', now: '2026-09-03T10:00:00.000Z' });
  assert.ok(md.includes('מידע אישי'));
  assert.ok(md.includes('> שורה\n> שנייה'));
  assert.ok(md.includes('דירוג ממוצע: 2.00'));
});

check('renderHealth flags a snapshot that did not run and a missing backup listing', () => {
  const md = exporterModule.renderHealth({
    lastSnapshot: { date: '2026-08-20', drops: {} }, lastScan: null,
    openIncidents: 1, incidents7d: 0, incidentEvents7d: 0, feedback7d: 0, feedbackUnread: 0, backupsListing: null
  }, { station: 'eilat_102', now: '2026-09-03T10:00:00.000Z' });
  assert.ok(/⚠ לא רצה \d+ ימים/.test(md));
  assert.ok(md.includes('⚠ אין רשומה'));
  assert.ok(md.includes('gcloud firestore backups list'));
});

check('pruneList keeps the newest N backups with their manifests', () => {
  const names = ['resq-2026-09-01_0700.bundle', 'resq-2026-09-01_0700.zip', 'resq-2026-09-01_0700.md',
    'resq-2026-09-02_0700.bundle', 'resq-2026-09-02_0700.zip', 'resq-2026-09-02_0700.md',
    'resq-2026-09-03_0700.bundle', 'resq-2026-09-03_0700.zip', 'resq-2026-09-03_0700.md', 'unrelated.txt'];
  const drop = backupModule.pruneList(names, 2);
  assert.deepEqual(drop, ['resq-2026-09-01_0700.bundle', 'resq-2026-09-01_0700.md', 'resq-2026-09-01_0700.zip']);
  assert.deepEqual(backupModule.pruneList(names, 10), []);
});

assert.equal(passed, 15);
console.log('\n15 ops source checks passed.');
console.log('  לא נבדק כאן: Firestore אמיתי, הרצת הייצוא מול פרויקט חי, ומסלול Windows של הגיבוי.');
