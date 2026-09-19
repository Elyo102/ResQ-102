import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8').replace(/^\uFEFF/, ''));
const visibleReleaseKey = String(release.v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const loginSource = fs.readFileSync(path.join(root, 'login.html'), 'utf8');
const releaseKey = loginSource.match(/\.\/pwa\.js\?v=([a-z0-9]+)/i)?.[1] || '';
let failed = 0;
let passed = 0;

function check(ok, label) {
  console.log((ok ? '✓ ' : '✗ ') + label);
  if (ok) passed += 1; else failed += 1;
}

check(releaseKey === visibleReleaseKey, 'asset build key belongs exactly to the visible release');

const privateRoster = path.join(root, 'roster-import.js');
const importHtml = fs.readFileSync(path.join(root, 'import.html'), 'utf8');
const firebaseConfig = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8'));
const worker = fs.readFileSync(path.join(root, 'firebase-messaging-sw.js'), 'utf8');
const hostingIgnore = firebaseConfig.hosting.ignore;
check(hostingIgnore.includes('outputs/**'),
      'Firebase Hosting excludes generated output screenshots and diagnostic probes');
function ignoredSensitiveConfig(name) {
  return hostingIgnore.includes(name)
    || (hostingIgnore.includes('firebase.*-test.json') && /^firebase\..*-test\.json$/.test(name))
    || (hostingIgnore.includes('firebase.emulator*.json') && /^firebase\.emulator.*\.json$/.test(name));
}

check(!fs.existsSync(privateRoster), 'the private roster file is absent from the deploy tree');
for (const token of ['roster-import', 'ROSTER', 'pwPaste', 'bulkImport']) {
  check(!importHtml.includes(token), 'import.html no longer contains ' + token);
}
for (const token of ["collection(db, 'stations', STATION_ID, 'users')",
                     'v.employee_number', 'v.is_active === false']) {
  check(importHtml.includes(token), 'history import contains ' + token);
}
for (const id of ['knob', 'master', 'mState', 'ready',
                  'hPaste', 'hDry', 'hRun', 'hMsg', 'hSum']) {
  check(new RegExp('id=["\\\']' + id + '["\\\']').test(importHtml),
        'import.html keeps #' + id);
}
check(firebaseConfig.hosting.ignore.includes('roster-import.js'),
      'Firebase Hosting excludes roster-import.js as defense in depth');
for (const name of ['firebase.attendance-test.json', 'firebase.emulator.42h11.json']) {
  check(ignoredSensitiveConfig(name), 'Firebase Hosting excludes ' + name);
}
for (const name of fs.readdirSync(root).filter((entry) => /^firebase\..+\.json$/.test(entry))) {
  check(ignoredSensitiveConfig(name), 'every Firebase sidecar config is excluded: ' + name);
}
check(worker.includes("const CACHE = 'resq-v" + releaseKey + "-release1'"),
      'the service-worker cache is rotated away from the exposed copy');

/* ============================================================
   כללי ה-ignore של Hosting — מנוע התאמה אמיתי, לא רשימת שמות
   ============================================================
   ארטיפקט ה-Hosting נבנה מ-`hosting.public` פחות `hosting.ignore`.
   עד כאן הבדיקה ידעה לזהות רק שמות קבצים ספציפיים, ולכן קובץ שדלף
   בגלל סיומת שאינה חסומה לא נתפס: `apply-wiring.py` נכלל בארטיפקט
   ונעצר רק בשער `pages:preview`. הפונקציה כאן ממירה כל תבנית ל-regex
   באותה סמנטיקה שבה Firebase משתמש: כוכבית כפולה ולוכסן = כל עומק,
   כוכבית בודדת = בתוך רמה אחת. כל מה שמתחת משתמש בה, כולל שרת
   הבדיקה. */
function ignorePattern(pattern) {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 3; continue; }
        out += '.*'; i += 2; continue;
      }
      out += '[^/]*'; i++; continue;
    }
    if (c === '?') { out += '[^/]'; i++; continue; }
    out += /[.+^$(){}|\[\]\\]/.test(c) ? '\\' + c : c;
    i++;
  }
  return new RegExp('^' + out + '$');
}
const ignoreMatchers = hostingIgnore.map(ignorePattern);
function hostingIgnores(relative) {
  const normalized = String(relative).replace(/\\/g, '/').replace(/^\.?\/+/, '');
  return ignoreMatchers.some((matcher) => matcher.test(normalized));
}

/* הסיומות שמותר להגיש. זו רשימת היתר, לא רשימת איסור: סיומת חדשה
 * שאיש לא חשב עליה נחשבת פרטית עד שמישהו מאשר אותה במפורש. */
const PUBLIC_EXTENSION = /\.(?:html|js|css|json|png|jpe?g|ico|svg|webp|mp3)$/i;

check(hostingIgnore.includes('*.py'), 'Firebase Hosting excludes root Python sources (*.py)');
check(hostingIgnore.includes('**/*.py'), 'Firebase Hosting excludes nested Python sources (**/*.py)');

/* ⭐ הבדיקה חייבת לרוץ על קובץ שקיים באמת. אם apply-wiring.py ייעלם
 * מהעץ, 404 אינו הוכחה לכלום — ולכן קיומו נבדק בנפרד. */
const wiringScript = path.join(root, 'apply-wiring.py');
check(fs.existsSync(wiringScript), 'apply-wiring.py is present in the tree (otherwise the 404 proves nothing)');
check(hostingIgnores('apply-wiring.py'), 'the hosting ignore rules match apply-wiring.py');
check(hostingIgnores('tools/nested/apply-wiring.py'), 'the hosting ignore rules match a nested .py as well');

/* ⭐ והשער הרחב: אף קובץ שאינו מסומן פרטי אינו רשאי לשאת סיומת
 * שאינה ברשימת ההיתר. זה מה שהיה תופס את .py מלכתחילה. */
{
  const leaks = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const relative = path.relative(root, path.join(dir, entry.name)).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (hostingIgnores(relative) || hostingIgnores(relative + '/x')) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile() || hostingIgnores(relative)) continue;
      if (!PUBLIC_EXTENSION.test(relative)) leaks.push(relative);
    }
  };
  walk(root);
  check(leaks.length === 0,
    'no served file carries an extension outside the public allow-list' +
    (leaks.length ? ' — ' + leaks.slice(0, 10).join(', ') : ''));
}

const server = http.createServer((req, res) => {
  const requested = decodeURIComponent(String(req.url || '/').split('?')[0]);
  const file = path.join(root, requested.replace(/^\/+/, ''));
  const relative = path.relative(root, file).replace(/\\/g, '/');
  if (ignoredSensitiveConfig(path.basename(file)) || hostingIgnores(relative)
      || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200);
  res.end(fs.readFileSync(file));
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  for (const name of ['roster-import.js', 'firebase.attendance-test.json', 'firebase.emulator.42h11.json',
                      'apply-wiring.py']) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/' + name);
    check(response.status === 404, 'a local hosting probe returns 404 for ' + name);
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}

if (failed) {
  console.error('\n' + failed + ' hosting privacy checks failed.');
  process.exit(1);
}
console.log('\n' + passed + ' hosting privacy checks passed.');
