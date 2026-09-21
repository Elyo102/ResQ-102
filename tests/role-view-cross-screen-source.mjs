import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const login = read('login.html');
const nav = read('nav.js');
const schedule = read('schedule-management.js');
const html = read('schedule-management.html');
const worker = read('firebase-messaging-sw.js');
const hr = read('hr.html');
const hrClient = read('hr-client.js');
const hrRequests = read('hr-requests-client.js');
const hrDocuments = read('hr-documents-client.js');
const failures = [];
const need = (condition, message) => { if (!condition) failures.push(message); };

need(/role-view-page\.js/.test(login),
  'login.html must use the shared page resolver instead of private storage helpers');
need(/role-view-page\.js/.test(nav),
  'nav.js must use the closed previewSafe page allowlist');
need(/const\s+previewBlocked\s*=\s*assertPresentationOnly\(presentation\)\s*&&\s*!isPreviewSafePage\(it\.href\)/.test(nav),
  'preview navigation must fail closed for every page outside the allowlist');
need(/if\s*\(!previewBlocked\)\s*a\.href\s*=/.test(nav),
  'blocked preview destinations must not retain a navigable href');
need(/role-view-page\.js/.test(schedule),
  'schedule-management.js must resolve the stored preview from the current token');
need(/onIdTokenChanged\s*\(/.test(schedule),
  'schedule preview must be invalidated on same-UID token refresh');
need(/renderNav\([^;]*presentation/s.test(schedule),
  'schedule nav must receive presentation separately from real claims');
need(/role[_-]view|תצוגת תפקיד/.test(html),
  'schedule HTML must contain a persistent read-only preview banner');
const notificationExit = /searchParams\.set\(\s*['"]resq_actual['"]\s*,\s*['"]notification['"]\s*\)/;
need(notificationExit.test(worker),
  'notification navigation must carry only an exit-preview marker');
need(!/[?&#](?:role|persona|claims)=/.test(worker),
  'the service worker must never put a presentation role or claims in a URL');

function requireEarlyConsumer(name, source, nextModule) {
  const importAt = source.indexOf("import { consumeActualRoleViewNavigation } from './role-view-page.js?v=42h29'");
  const callAt = source.indexOf('consumeActualRoleViewNavigation(location.href, sessionStorage)');
  const replaceAt = source.indexOf("history.replaceState(history.state, '', roleViewCleanUrl)");
  const nextAt = source.indexOf(nextModule);
  need(importAt >= 0, name + ' must import the shared notification-preview exit consumer');
  need(callAt > importAt, name + ' must consume the marker after importing the shared consumer');
  need(replaceAt > callAt, name + ' must remove the marker from browser history');
  need(nextAt > replaceAt, name + ' must clear preview before Firebase or the page client initializes');
}
need(/import\s+['"]\.\/hr-client\.js\?v=42h29['"]/.test(hr),
  'hr.html must load the HR client that owns early preview cleanup');
requireEarlyConsumer('hr-client.js', hrClient, 'const app = initializeApp(firebaseConfig)');
requireEarlyConsumer('hr-requests-client.js', hrRequests, 'const app = initializeApp(firebaseConfig)');
requireEarlyConsumer('hr-documents-client.js', hrDocuments, 'const app = initializeApp(firebaseConfig)');

// Source self-check: every clause is load-bearing and a one-token removal is
// detected by this contract rather than counted as a killed setup failure.
const clauses = [
  ['login shared resolver', login, /role-view-page\.js/],
  ['nav closed allowlist', nav, /role-view-page\.js/],
  ['schedule shared resolver', schedule, /role-view-page\.js/],
  ['token lifecycle', schedule, /onIdTokenChanged\s*\(/],
  ['notification exit', worker, notificationExit],
  ['HR dashboard early exit', hrClient, /consumeActualRoleViewNavigation\(location\.href, sessionStorage\)/],
  ['HR requests early exit', hrRequests, /consumeActualRoleViewNavigation\(location\.href, sessionStorage\)/],
  ['HR documents early exit', hrDocuments, /consumeActualRoleViewNavigation\(location\.href, sessionStorage\)/]
];
for (const [name, source, pattern] of clauses) {
  const match = source.match(pattern);
  if (!match) continue;
  const mutated = source.slice(0, match.index) + source.slice(match.index + match[0].length);
  assert.equal(pattern.test(mutated), false, `${name} mutation must be detected`);
}

if (failures.length) {
  console.error('role-view cross-screen source: BLOCK');
  failures.forEach(item => console.error(' - ' + item));
  assert.fail(failures.length + ' cross-screen wiring requirements are missing');
}
console.log('role-view cross-screen source: PASS');
