import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
let failed = 0;

function check(ok, label) {
  console.log((ok ? '✓ ' : '✗ ') + label);
  if (!ok) failed += 1;
}

const source = fs.readFileSync(path.join(root, 'appcheck.js'), 'utf8');
const key = source.match(/RECAPTCHA_SITE_KEY\s*=\s*'([^']+)'/)?.[1] || '';

check(key.length >= 30, 'App Check has a configured public site key');
check(source.includes('new m.ReCaptchaEnterpriseProvider(RECAPTCHA_SITE_KEY)'),
  'the web client uses reCAPTCHA Enterprise');
check(!source.includes('new m.ReCaptchaV3Provider('),
  'the legacy reCAPTCHA v3 provider is not used');
check(source.includes('const USE_DEBUG_TOKEN = false'),
  'production never enables the debug token');
check(source.includes('isTokenAutoRefreshEnabled: true'),
  'App Check tokens refresh automatically');

const html = fs.readdirSync(root).filter(file => file.endsWith('.html'));
// schedule.html is deliberately a signed-in transition shell.  It makes no
// callable or Firestore request, so it must not be counted as an App Check
// consumer (nor quietly regain a legacy data path later).
const transitionShell = fs.readFileSync(path.join(root, 'schedule.html'), 'utf8');
check(!transitionShell.includes('initAppCheck'),
  'legacy schedule transition shell does not initialize an unused App Check client');
check(!/firebase-firestore|firebase-functions|getFirestore|getDocs|collection\(|httpsCallable|initAppCheck|rotations|shift_overrides/.test(transitionShell),
  'legacy schedule transition shell has no Firestore, callable, or legacy schedule data path');
check(transitionShell.includes("location.replace('./schedule-management.html?tab=station')"),
  'legacy schedule transition shell redirects to the new station schedule');
check(transitionShell.includes("location.replace('./login.html?next=schedule-management.html')"),
  'unauthenticated legacy schedule requests go only to the login next target');

// index.html is the static login landing. schedule-management.html delegates
// its Firebase bootstrap to its adjacent module, so include that module in
// the screen source rather than losing the App Check assertion during the
// split. The remaining 20 are the actual Firebase consumers.
const firebaseScreens = html.filter(file => !['index.html', 'schedule.html'].includes(file));
const imports = firebaseScreens.flatMap(file => {
  let body = fs.readFileSync(path.join(root, file), 'utf8');
  if (file === 'schedule-management.html') {
    body += '\n' + fs.readFileSync(path.join(root, 'schedule-management.js'), 'utf8');
  }
  return body.includes('initAppCheck') ? [{ file, body }] : [];
});
check(imports.length === firebaseScreens.length,
  'all ' + firebaseScreens.length + ' Firebase screens initialize App Check');
for (const item of imports) {
  check(item.body.includes("./appcheck.js?v=41a1"),
    item.file + ' uses the current App Check cache version');
  check((item.body.match(/await initAppCheck\(app\);/g) || []).length === 1,
    item.file + ' waits for App Check before accessing Firebase services');
}

const worker = fs.readFileSync(path.join(root, 'firebase-messaging-sw.js'), 'utf8');
check(worker.includes("const CACHE = 'resq-v42f1-release1'"),
  'the PWA cache is rotated for the privacy fix');

if (failed) {
  console.error('\n' + failed + ' App Check safety checks failed.');
  process.exit(1);
}
console.log('\nApp Check client safety checks passed.');
