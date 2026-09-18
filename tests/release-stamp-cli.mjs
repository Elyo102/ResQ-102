// 42H.20 · Codex final blocker · release-stamp.mjs כ-CLI, בתהליך Node אמיתי.
//
// הבאג: `import.meta.url === \`file://${process.argv[1]}\`` — ב-Windows
// argv[1] הוא נתיב (C:\…), לא URL, ולכן main() לא רץ ו-`--check` יצא 0
// בשקט. בדיקת יחידה שמייבאת את stampFiles() לא הייתה תופסת את זה, כי
// הפונקציות עצמן תקינות; רק הפעלה כתהליך נפרד מוכיחה שהשער עובד.
//
// הבדיקה מריצה את process.execPath (אותו node) על:
//   1. העץ האמיתי:               --check → exit 0 + הודעת הצלחה מפורשת.
//   2. עותק זמני עם drift:        --check → exit 1 ומזהה את הקובץ.
//   3. עותק זמני עם manifest חדש: stamp → מעדכן את כל הצרכנים; --check
//      אחריו נקי; stamp שני idempotent; version-release.mjs עובר בעותק
//      ומדפיס את שורת החוזה (אותו תיקון כניסה גם שם).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('✓ ' + name); }

function run(cwd, script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { code: result.status, out: (result.stdout || '') + (result.stderr || '') };
}

// עותק מינימלי אך שלם של מה שהמחולל והבודק קוראים: כל html/js/json בשורש,
// שלושת קבצי functions שנסרקים, וכל tests/*.mjs (המחולל מדביק גם אותם).
function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-stamp-cli-'));
  fs.mkdirSync(path.join(dir, 'functions'));
  fs.mkdirSync(path.join(dir, 'tests'));
  for (const name of fs.readdirSync(root)) {
    if (/\.(?:html|js|json|mjs|mp3|css)$/.test(name)) fs.copyFileSync(path.join(root, name), path.join(dir, name));
  }
  for (const rel of ['functions/index.js', 'functions/maintenance-service.js', 'functions/ops-telemetry-contract.js']) {
    fs.copyFileSync(path.join(root, rel), path.join(dir, rel));
  }
  for (const name of fs.readdirSync(path.join(root, 'tests'))) {
    if (/\.mjs$/.test(name)) fs.copyFileSync(path.join(root, 'tests', name), path.join(dir, 'tests', name));
  }
  return dir;
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release-manifest.json'), 'utf8'));

test('real tree: `node release-stamp.mjs --check` exits 0 WITH an explicit success line (not a silent no-op)', () => {
  const r = run(root, path.join(root, 'release-stamp.mjs'), ['--check']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✓/, 'must print the success marker');
  assert.ok(r.out.includes(manifest.version) && r.out.includes(manifest.asset_query), 'success line names the manifest identity');
  // גם דרך נתיב יחסי, כמו ב-tests/package.json ("node ../release-stamp.mjs --check")
  const rel = run(path.join(root, 'tests'), path.join('..', 'release-stamp.mjs'), ['--check']);
  assert.equal(rel.code, 0, rel.out);
  assert.match(rel.out, /✓/);
});

test('real tree: `node tests/version-release.mjs` runs its contract and prints the count (same entry-guard fix)', () => {
  const r = run(path.join(root, 'tests'), path.join(root, 'tests', 'version-release.mjs'));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Release version contract: \d+ references; \d+\/\d+ mutations caught\./);
});

test('temp copy with drift in one consumer: --check exits nonzero and names the file', () => {
  const dir = makeCopy();
  try {
    const p = path.join(dir, 'version.js');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/APP_VERSION = '[^']+'/, "APP_VERSION = '42G.drift'"));
    const r = run(dir, path.join(dir, 'release-stamp.mjs'), ['--check']);
    assert.notEqual(r.code, 0, 'drift must fail the gate');
    assert.match(r.out, /version\.js/);
    assert.match(r.out, /✗/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('temp copy with a changed manifest: stamp rewrites every consumer, --check is clean after, second stamp is idempotent', () => {
  const dir = makeCopy();
  try {
    const fake = { version: '99Z.99.9', date: '1.1.2099', asset_query: '99z999', sw_cache_key: 'resq-v99z999-release1' };
    fs.writeFileSync(path.join(dir, 'release-manifest.json'), JSON.stringify(fake, null, 2) + '\n');
    const before = run(dir, path.join(dir, 'release-stamp.mjs'), ['--check']);
    assert.notEqual(before.code, 0, 'a changed manifest must show drift before stamping');
    const stamp = run(dir, path.join(dir, 'release-stamp.mjs'));
    assert.equal(stamp.code, 0, stamp.out);
    assert.match(stamp.out, /עודכנו \d+ קבצים/);
    const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
    assert.equal(read('version.json').trim(), JSON.stringify({ v: fake.version, d: fake.date }));
    assert.ok(read('version.js').includes("APP_VERSION = '99Z.99.9'"));
    assert.ok(read('firebase-messaging-sw.js').includes("const CACHE = 'resq-v99z999-release1';"));
    assert.ok(read('functions/index.js').includes("state: 'ok', version: '99Z.99.9'"));
    assert.ok(read('functions/index.js').includes("monthAuthorityReleaseId: '99Z.99.9'"));
    assert.ok(read('functions/maintenance-service.js').includes("version:'99Z.99.9', ai_state:"));
    assert.ok(read('functions/ops-telemetry-contract.js').includes("'99Z.99.9'"));
    assert.ok(read('incident-client.js').includes("'99Z.99.9'"));
    assert.ok(read('callout.js').includes('callout-siren.mp3?v=99z999'));
    assert.ok(!read('login.html').includes('?v=' + manifest.asset_query), 'no old ?v= key survives in a page');
    assert.ok(read('login.html').includes('?v=99z999'));
    const after = run(dir, path.join(dir, 'release-stamp.mjs'), ['--check']);
    assert.equal(after.code, 0, after.out);
    assert.match(after.out, /✓/);
    const again = run(dir, path.join(dir, 'release-stamp.mjs'));
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /שום קובץ לא השתנה/);
    const contract = run(path.join(dir, 'tests'), path.join(dir, 'tests', 'version-release.mjs'));
    assert.equal(contract.code, 0, contract.out);
    assert.match(contract.out, /Release version contract: \d+ references/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log('');
console.log(passed + ' release-stamp CLI checks passed (real node processes).');
