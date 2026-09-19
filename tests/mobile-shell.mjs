// בדיקה סטטית למעטפת החנות (apps/mobile). Node built-ins בלבד; אין playwright,
// אין Capacitor, אין SDK. הריצה אינה בונה דבר.
//
//   apps/mobile  — נפתר יחסית לקובץ הזה (../apps/mobile)
//   PWA          — manifest.json + firebase-messaging-sw.js מ-RESQ_REPO_ROOT
//                  (ברירת מחדל: ../ מהקובץ הזה)
//
// הרצה: RESQ_REPO_ROOT=/path/to/repo node tests/mobile-shell.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isCleanText, eolProblems, normalizeEol } from './eol-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '..');
const MOBILE = path.join(SRC_ROOT, 'apps', 'mobile');
const REPO_ROOT = path.resolve(process.env.RESQ_REPO_ROOT || SRC_ROOT);

let passed = 0;
let failed = 0;
function check(ok, label) {
  console.log((ok ? 'PASS ' : 'FAIL ') + label);
  if (ok) passed += 1; else failed += 1;
}
/* rawRead — בתים כפי שהם, לבדיקת סוף-שורה בלבד.
   read — מנורמל, כי כל התאמות התוכן כאן כתובות עם `\n`. */
function rawRead(p) { return fs.readFileSync(p, 'utf8'); }
function read(p) { return normalizeEol(rawRead(p)); }
function walk(dir, out) {
  out = out || [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

console.log('apps/mobile: ' + MOBILE);
console.log('RESQ_REPO_ROOT: ' + REPO_ROOT);
console.log('');

// ---------- 1. capacitor.config.json ----------
let cap = null;
try { cap = JSON.parse(read(path.join(MOBILE, 'capacitor.config.json'))); } catch (ignore) { cap = null; }
check(cap !== null, 'capacitor.config.json parses');
let approvedOrigin = '';
let approvedHost = '';
if (cap) {
  const url = String(cap.server && cap.server.url || '');
  let parsed = null;
  try { parsed = new URL(url); } catch (ignore) { parsed = null; }
  check(parsed !== null && parsed.protocol === 'https:', 'server.url is https: ' + url);
  if (parsed) { approvedOrigin = parsed.origin; approvedHost = parsed.hostname; }
  check(parsed !== null && parsed.pathname === '/' && !parsed.search && !parsed.hash && !parsed.username,
        'server.url is a bare origin (no path/query/userinfo)');
  const nav = cap.server && cap.server.allowNavigation;
  check(Array.isArray(nav) && nav.length === 1 && nav[0] === approvedHost,
        'allowNavigation contains only the server host');
  check(cap.server && cap.server.cleartext === false, 'server.cleartext is false');
  check(cap.android && cap.android.allowMixedContent === false, 'android.allowMixedContent is false');
  check(cap.android && cap.android.webContentsDebuggingEnabled === false, 'android.webContentsDebuggingEnabled is false');
  check(cap.ios && cap.ios.limitsNavigationsToAppBoundDomains === true, 'ios.limitsNavigationsToAppBoundDomains is true');
  check(!(cap.plugins && cap.plugins.PushNotifications), 'plugins.PushNotifications is not configured');
}

// ---------- 2. deep-links.json agrees with the config ----------
let deep = null;
try { deep = JSON.parse(read(path.join(MOBILE, 'deep-links.json'))); } catch (ignore) { deep = null; }
check(deep !== null, 'deep-links.json parses');
if (deep) {
  check(deep.approved_origin === approvedOrigin, 'deep-links.approved_origin matches capacitor server.url');
  check(deep.approved_host === approvedHost, 'deep-links.approved_host matches capacitor host');
  check(Array.isArray(deep.routes) && deep.routes.length === 3, 'deep-links has exactly 3 routes');
}

// ---------- 3. secrets / generated projects absent ----------
const allFiles = walk(MOBILE);
const secretPattern = /(^google-services\.json$|^GoogleService-Info\.plist$|\.keystore$|\.jks$|\.p12$|\.mobileprovision$|\.cer$|\.p8$)/i;
const secretHits = allFiles.filter((f) => secretPattern.test(path.basename(f)));
check(secretHits.length === 0, 'no google-services.json / GoogleService-Info.plist / keystore / jks / p12 / mobileprovision under apps/mobile' + (secretHits.length ? ' — ' + secretHits.join(', ') : ''));
const projectPattern = /(^build\.gradle(\.kts)?$|^settings\.gradle(\.kts)?$|^gradlew|\.xcodeproj$|\.xcworkspace$|^Podfile(\.lock)?$|^package-lock\.json$)/i;
const projectHits = allFiles.filter((f) => projectPattern.test(path.basename(f)) || /\.xcodeproj|\.xcworkspace|node_modules/.test(f));
check(projectHits.length === 0, 'no build.gradle / .xcodeproj / Podfile / node_modules under apps/mobile' + (projectHits.length ? ' — ' + projectHits.join(', ') : ''));
const imageHits = allFiles.filter((f) => /\.(png|jpg|jpeg|webp|svg|ico)$/i.test(f));
check(imageHits.length === 0, 'no image assets duplicated under apps/mobile (root PWA icons are the source)');
/* CRLF מותר (core.autocrlf=true ב-Windows); CR בודד ותווי בקרה — לא. */
const crlfHits = allFiles.filter((f) => !isCleanText(rawRead(f)));
check(crlfHits.length === 0, 'no CRLF or control characters in apps/mobile' + (crlfHits.length ? ' — ' + crlfHits.join(', ') : ''));

// ---------- 4. every template dir README carries the NOT RUN statement ----------
const NOT_RUN = 'build NOT RUN';
for (const rel of ['README.md', 'android/README.md', 'android/icons/README.md', 'ios/README.md', 'ios/icons/README.md']) {
  const p = path.join(MOBILE, rel);
  check(fs.existsSync(p) && read(p).includes(NOT_RUN), rel + ' contains "' + NOT_RUN + '"');
}
check(read(path.join(MOBILE, 'ios/README.md')).includes('iOS BUILD NOT RUN — requires macOS/Xcode'),
      'ios/README.md carries the exact iOS NOT RUN line');
check(read(path.join(MOBILE, 'android/README.md')).includes('ANDROID BUILD NOT RUN — SDK not available; not installed without approval'),
      'android/README.md carries the exact Android NOT RUN line');

// ---------- 5. Android templates ----------
const assetlinks = JSON.parse(read(path.join(MOBILE, 'android/assetlinks.template.json')));
const fps = assetlinks[0].target.sha256_cert_fingerprints;
check(Array.isArray(fps) && fps.length === 1 && !/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(fps[0]) && /REPLACE_ME/.test(fps[0]),
      'assetlinks fingerprint is the invalid REPLACE_ME placeholder');
check(assetlinks[0].target.package_name === cap.appId, 'assetlinks package_name equals capacitor appId');

const manifest = read(path.join(MOBILE, 'android/app-manifest.template.xml'));
const perms = Array.from(manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"/g)).map((m) => m[1]).sort();
check(perms.join(',') === 'android.permission.INTERNET,android.permission.POST_NOTIFICATIONS',
      'Android manifest requests only INTERNET + POST_NOTIFICATIONS (' + perms.join(',') + ')');
check(/android:usesCleartextTraffic="false"/.test(manifest), 'Android manifest usesCleartextTraffic="false"');
check(/android:allowBackup="false"/.test(manifest), 'Android manifest allowBackup="false"');
check(!/uses-feature|LOCATION|CAMERA|READ_CONTACTS|RECORD_AUDIO|EXTERNAL_STORAGE/.test(manifest),
      'Android manifest has no location/camera/contacts/audio/storage');
const manifestHosts = Array.from(manifest.matchAll(/android:host="([^"]+)"/g)).map((m) => m[1]);
check(manifestHosts.length > 0 && manifestHosts.every((h) => h === approvedHost), 'Android App Links host is only the approved host');
const manifestPaths = Array.from(manifest.matchAll(/android:path="([^"]+)"/g)).map((m) => m[1]).sort();
check(deep && manifestPaths.join(',') === deep.routes.map((r) => r.path).sort().join(','), 'Android App Links paths equal deep-links.json routes');

// ---------- 6. iOS templates ----------
// הערות ה-XML מציינות במפורש אילו מפתחות אינם מוצהרים; בדיקת היעדר חייבת
// לרוץ על ההצהרות עצמן, אחרי הסרת ההערות, אחרת המשפט המסביר מפיל אותה.
const stripXmlComments = (xml) => xml.replace(/<!--[\s\S]*?-->/g, '');
const priv = stripXmlComments(read(path.join(MOBILE, 'ios/PrivacyInfo.template.xcprivacy')));
check(/<key>NSPrivacyTracking<\/key>\s*<false\/>/.test(priv), 'privacy manifest NSPrivacyTracking is false');
check(/<key>NSPrivacyTrackingDomains<\/key>\s*<array\/>/.test(priv), 'privacy manifest has no tracking domains');
check(!/CrashData/.test(priv), 'privacy manifest does not claim CrashData (telemetry is closed-vocab diagnostics)');
const aasa = JSON.parse(read(path.join(MOBILE, 'ios/apple-app-site-association.template.json')));
const appIds = aasa.applinks.details[0].appIDs;
check(appIds.length === 1 && appIds[0].startsWith('REPLACE_ME.') && appIds[0].endsWith('.' + cap.appId), 'AASA appID has REPLACE_ME team id');
const aasaPaths = aasa.applinks.details[0].components.map((c) => c['/']).sort();
check(deep && aasaPaths.join(',') === deep.routes.map((r) => r.path).sort().join(','), 'AASA components equal deep-links.json routes');
const info = stripXmlComments(read(path.join(MOBILE, 'ios/Info.template.plist')));
check(/<key>NSAllowsArbitraryLoads<\/key>\s*<false\/>/.test(info), 'Info.plist NSAllowsArbitraryLoads is false');
check(!/NSLocation|NSCamera|NSContacts|NSMicrophone|NSPhotoLibrary/.test(info), 'Info.plist has no location/camera/contacts/mic/photos usage keys');
check(info.includes('<string>' + approvedHost + '</string>'), 'Info.plist WKAppBoundDomains lists the approved host');
const ent = read(path.join(MOBILE, 'ios/App.template.entitlements'));
check(ent.includes('applinks:' + approvedHost), 'entitlements applinks is the approved host');

// ---------- 7. navigation-policy unit tests ----------
const nav = await import(pathToFileURL(path.join(MOBILE, 'src/navigation-policy.js')).href);
const O = approvedOrigin || 'https://station-102.web.app';
const c = (u) => nav.classifyNavigation(u, O);
const t = (u) => nav.deepLinkTarget(u, O);
const TOKEN = 'abcdefghijklmnop.' + 'A'.repeat(43);
const NONCE = 'a'.repeat(32);

check(c(O + '/login.html') === 'internal', 'classify: approved origin path is internal');
check(c('https://example.org/') === 'external', 'classify: other https origin is external');
check(c('javascript:alert(1)') === 'blocked', 'classify: javascript: is blocked');
check(c('data:text/html,hi') === 'blocked', 'classify: data: is blocked');
check(c('intent://x#Intent;scheme=https;end') === 'blocked', 'classify: intent: is blocked');
check(c('file:///etc/passwd') === 'blocked', 'classify: file: is blocked');
check(c('blob:' + O + '/x') === 'blocked', 'classify: blob: is blocked');
check(c('https://' + approvedHost + '.evil.com/') === 'external', 'classify: host-prefix lookalike (origin.evil.com) is not internal');
check(c('https://' + approvedHost + '@evil.com/') === 'blocked', 'classify: userinfo disguise (origin@evil.com) is blocked');
check(c('https://evil.com\\@' + approvedHost + '/') === 'blocked', 'classify: backslash in URL is blocked');
check(c('HTTPS://' + approvedHost.toUpperCase() + '/alerts.html') === 'internal', 'classify: uppercase scheme/host normalises to internal');
check(c('https://' + approvedHost + ':8443/') === 'blocked', 'classify: same host, other port is blocked');
check(c('https://' + approvedHost + ':443/') === 'internal', 'classify: explicit default port normalises to internal');
check(c('http://' + approvedHost + '/') === 'blocked', 'classify: http downgrade of approved host is blocked');
check(c('') === 'blocked' && c(null) === 'blocked' && c(12) === 'blocked', 'classify: empty/null/non-string are blocked');
check(nav.classifyNavigation(O + '/x', 'http://insecure.example') === 'blocked' &&
      nav.classifyNavigation(O + '/x', '') === 'blocked' &&
      nav.classifyNavigation(O + '/x', 'https://a@' + approvedHost) === 'blocked',
      'classify: non-https / empty / userinfo approved origin blocks everything');

check(t(O + '/login.html?join=' + TOKEN) === './login.html?join=' + TOKEN, 'deepLink: valid join token passes');
check(t(O + '/login.html?join=' + TOKEN + '&evil=1') === './login.html?join=' + TOKEN, 'deepLink: extra query params are stripped');
check(t(O + '/login.html?join=short') === './login.html', 'deepLink: token failing regex falls back to start_url');
check(t(O + '/login.html?join=' + TOKEN.replace('.', '%2E')) === './login.html?join=' + TOKEN, 'deepLink: percent-encoded dot decodes to the same token');
check(t(O + '/login.html?join=' + TOKEN + '<') === './login.html', 'deepLink: token with trailing junk is rejected');
check(t(O + '/device-readiness.html?readiness_nonce=' + NONCE) === './device-readiness.html?readiness_nonce=' + NONCE, 'deepLink: valid 32-hex nonce passes');
check(t(O + '/device-readiness.html?readiness_nonce=' + NONCE.toUpperCase()) === './login.html', 'deepLink: uppercase hex nonce fails regex');
check(t(O + '/device-readiness.html?readiness_nonce=' + 'a'.repeat(31)) === './login.html', 'deepLink: 31-char nonce fails regex');
check(t(O + '/alerts.html?anything=1#frag') === './alerts.html', 'deepLink: alerts drops query and fragment');
check(t(O + '/admin.html') === './login.html', 'deepLink: unlisted path falls back to start_url');
check(t('https://evil.com/login.html?join=' + TOKEN) === './login.html', 'deepLink: foreign origin never yields a token target');
check(t('https://' + approvedHost + '@evil.com/login.html?join=' + TOKEN) === './login.html', 'deepLink: userinfo disguise never yields a token target');
check(t('resq://join?join=' + TOKEN) === './login.html?join=' + TOKEN, 'deepLink: custom scheme join works');
check(t('resq://readiness?readiness_nonce=' + NONCE) === './device-readiness.html?readiness_nonce=' + NONCE, 'deepLink: custom scheme readiness works');
check(t('resq://alerts') === './alerts.html', 'deepLink: custom scheme alerts works');
check(t('resq://evil?join=' + TOKEN) === './login.html', 'deepLink: custom scheme unknown host falls back');
check(t('javascript:alert(1)') === './login.html', 'deepLink: javascript: falls back to start_url');
check(nav.START_URL === (deep && deep.start_url), 'START_URL equals deep-links.json start_url');
check(nav.JOIN_TOKEN_PATTERN.source === deep.routes.find((r) => r.id === 'join').value_pattern, 'JOIN_TOKEN_PATTERN equals deep-links.json pattern');
check(nav.READINESS_NONCE_PATTERN.source === deep.routes.find((r) => r.id === 'readiness').value_pattern, 'READINESS_NONCE_PATTERN equals deep-links.json pattern');
const rt = nav.routeTable();
check(rt.map((r) => r.id + ':' + r.path).join(',') === deep.routes.map((r) => r.id + ':' + r.path).join(','), 'routeTable() matches deep-links.json order and paths');

// join token pattern must equal the PWA's own (join-ui.js) when the repo is available
const joinUi = path.join(REPO_ROOT, 'join-ui.js');
if (fs.existsSync(joinUi)) {
  check(read(joinUi).includes(nav.JOIN_TOKEN_PATTERN.source), 'join-ui.js contains the same token regex');
} else {
  console.log('SKIP join-ui.js not found under RESQ_REPO_ROOT');
}

// ---------- 8. push-bridge ----------
const push = await import(pathToFileURL(path.join(MOBILE, 'src/push-bridge.js')).href);
let nativeErr = null;
try { push.createNativePushBridge(); } catch (e) { nativeErr = e; }
check(nativeErr && nativeErr.code === 'not-implemented-requires-store-account' && nativeErr.message === 'not-implemented-requires-store-account',
      'native bridge throws not-implemented-requires-store-account');
const fake = push.createFakePushBridge({ seed: 'test' });
check(fake.kind === 'fake', 'fake bridge kind');
let tokenBefore = null;
try { await fake.getToken(); } catch (e) { tokenBefore = e.message; }
check(tokenBefore === 'permission-not-granted', 'fake bridge refuses token before permission');
check(await fake.requestPermission() === 'granted', 'fake bridge grants permission');
const tok1 = await fake.getToken();
check(tok1 === 'fake-native-token-test-0001', 'fake bridge token is deterministic: ' + tok1);
const got = [];
const off = fake.onMessage((p) => got.push(p));
const delivered = fake.emit('message', { title: 'x', body: 'y', url: './alerts.html', secret: 'no', nonce: NONCE });
check(delivered === 1 && got.length === 1 && got[0].title === 'x' && !('secret' in got[0]) && got[0].nonce === NONCE,
      'fake bridge delivers sanitised payload (unknown fields dropped)');
check(Object.isFrozen(got[0]), 'delivered payload is frozen');
off();
check(fake.emit('message', { title: 'z' }) === 0, 'unsubscribe stops delivery');
let badKind = null;
try { fake.emit('nope', {}); } catch (e) { badKind = e.message; }
check(badKind === 'unknown-emit-kind', 'emit rejects unknown kind');
const denied = push.createFakePushBridge({ permission: 'denied' });
check(await denied.requestPermission() === 'denied', 'fake bridge can simulate denial');
check(fake.state().log.length >= 4, 'fake bridge keeps a log');

// ---------- 9. PWA unchanged ----------
const pwaManifestPath = path.join(REPO_ROOT, 'manifest.json');
const swPath = path.join(REPO_ROOT, 'firebase-messaging-sw.js');
check(fs.existsSync(pwaManifestPath), 'manifest.json exists under RESQ_REPO_ROOT');
check(fs.existsSync(swPath), 'firebase-messaging-sw.js exists under RESQ_REPO_ROOT');
if (fs.existsSync(pwaManifestPath) && fs.existsSync(swPath)) {
  const pwa = JSON.parse(read(pwaManifestPath).replace(/^﻿/, ''));
  check(pwa.scope === './', 'PWA manifest scope is ./');
  check(pwa.start_url === './login.html', 'PWA manifest start_url is ./login.html');
  check(nav.START_URL === pwa.start_url, 'navigation-policy START_URL equals PWA start_url');
  const sw = read(swPath);
  const shellMatch = sw.match(/const SHELL\s*=\s*\[([\s\S]*?)\];/);
  check(shellMatch !== null, 'service worker declares SHELL');
  check(shellMatch !== null && !/apps\//.test(shellMatch[1]), 'service worker SHELL has no apps/ reference');
  check(!/apps\/mobile/.test(sw), 'service worker never mentions apps/mobile');
}

// ---------- 10. wiring status (informational, never fails) ----------
const fbJson = path.join(REPO_ROOT, 'firebase.json');
if (fs.existsSync(fbJson)) {
  const fb = JSON.parse(read(fbJson));
  const ign = (fb.hosting && fb.hosting.ignore) || [];
  console.log((ign.includes('apps/**') ? 'WIRED   ' : 'NOT WIRED ') + 'firebase.json hosting.ignore contains apps/**');
}
const gi = path.join(REPO_ROOT, '.gitignore');
if (fs.existsSync(gi)) {
  const g = read(gi);
  console.log((g.includes('apps/mobile/**/google-services.json') ? 'WIRED   ' : 'NOT WIRED ') + '.gitignore blocks apps/mobile google-services.json');
}
const tp = path.join(REPO_ROOT, 'tests', 'package.json');
if (fs.existsSync(tp)) {
  const scripts = JSON.parse(read(tp)).scripts || {};
  console.log((scripts['mobile:test'] ? 'WIRED   ' : 'NOT WIRED ') + 'tests/package.json has mobile:test');
}

/* סיווג מחייב: הסעיף אינו מוכן לפרסום, והמסמכים חייבים לומר זאת
   במילים ולא ברמז. בדיקה שמוודאת רק "יש README" מאפשרת למסמך לטעון
   מוכנות; זו בודקת את הסיווג עצמו. */
const CLASSIFICATION = 'STORE_SCAFFOLD_ONLY';
for (const doc of ['STORE-RELEASE-CHECKLIST.md', 'PRIVACY-DATA-MAP.md', 'apps/mobile/README.md']) {
  const full = path.join(SRC_ROOT, doc);
  const body = fs.existsSync(full) ? read(full) : '';
  check(body.includes(CLASSIFICATION), doc + ' is classified ' + CLASSIFICATION);
}
const checklist = read(path.join(SRC_ROOT, "STORE-RELEASE-CHECKLIST.md"));
check(/אסור לסמן את הסעיף כמוכן\s*\n?\s*לפרסום/.test(checklist) || /אסור לסמן את הסעיף כמוכן/.test(checklist),
  'the checklist states the section must not be marked ready for release');
check(checklist.includes('iOS BUILD NOT RUN — requires macOS/Xcode') &&
      checklist.includes('ANDROID BUILD NOT RUN — SDK not available; not installed without approval'),
  'the checklist carries both NOT RUN lines verbatim');
check(!/מוכן לפרסום\s*[:：]?\s*(כן|yes)/i.test(checklist), 'the checklist never claims release readiness');

console.log('');
console.log('iOS BUILD NOT RUN — requires macOS/Xcode');
console.log('ANDROID BUILD NOT RUN — SDK not available; not installed without approval');
console.log('');
console.log('mobile-shell: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
