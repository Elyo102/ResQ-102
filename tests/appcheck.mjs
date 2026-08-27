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
const imports = html.flatMap(file => {
  const body = fs.readFileSync(path.join(root, file), 'utf8');
  return body.includes('initAppCheck') ? [{ file, body }] : [];
});
check(imports.length === 20, 'all 20 Firebase screens initialize App Check');
for (const item of imports) {
  check(item.body.includes("./appcheck.js?v=41a1"),
    item.file + ' uses the current App Check cache version');
  check((item.body.match(/await initAppCheck\(app\);/g) || []).length === 1,
    item.file + ' waits for App Check before accessing Firebase services');
}

const worker = fs.readFileSync(path.join(root, 'firebase-messaging-sw.js'), 'utf8');
check(worker.includes("const CACHE = 'resq-v41b-privacy1'"),
  'the PWA cache is rotated for the privacy fix');

if (failed) {
  console.error('\n' + failed + ' App Check safety checks failed.');
  process.exit(1);
}
console.log('\nApp Check client safety checks passed.');
