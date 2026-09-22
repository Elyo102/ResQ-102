import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeEol } from './eol-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => normalizeEol(fs.readFileSync(path.join(root, name), 'utf8'));
let passed = 0;
const check = (name, fn) => { fn(); console.log('PASS ' + name); passed++; };
const persistentApi = /\bindexedDB\b|enableIndexedDbPersistence|persistentLocalCache|persistentMultipleTabManager/;
const sensitiveClients = [
  'attendance.html', 'hr-client.js', 'hr-requests-client.js', 'hr-documents-client.js',
  'hr-attachments-ui.js', 'hr-hours-ui.js', 'hr-requests-ui.js', 'callout.html',
  'callout-console.js', 'push.js'
];

check('sensitive clients do not enable an app-owned persistent database', () => {
  for (const file of sensitiveClients) assert.doesNotMatch(read(file), persistentApi, file);
});

check('attendance persists only the visual theme, never hours or report payloads', () => {
  const source = read('attendance.html');
  const calls = [...source.matchAll(/localStorage\.(?:getItem|setItem|removeItem)\(([^)]*)\)/g)].map(match => match[1]);
  assert.deepEqual(calls, ["'resq_theme'"]);
  assert.doesNotMatch(source, /sessionStorage\.(?:getItem|setItem)\(/);
});

check('HR domain payload stays in bounded memory and explicit files, not browser storage', () => {
  const source = sensitiveClients.filter(file => file.startsWith('hr-')).map(read).join('\n');
  assert.doesNotMatch(source, /localStorage\.(?:getItem|setItem)\(/);
  assert.doesNotMatch(source, /sessionStorage\.(?:getItem|setItem)\([^)]*(?:request|document|attachment|medical|hours|report)/i);
  const client = read('hr-client.js');
  assert.match(client, /const reportCache\s*=\s*new Map\(\)/);
  assert.match(client, /REPORT_TTL_MS\s*=\s*30000/);
  assert.match(client, /window\.addEventListener\('pagehide',\s*clearReportCache\)/);
  const exportUi = read('hr-local-export-ui.js');
  assert.match(exportUi, /מחשב ארגוני מנוהל ומוצפן בלבד/);
  assert.match(exportUi, /המערכת אינה יכולה לבדוק שהכונן מוצפן/);
});

check('callout cache is session-only, bounded, and excludes response or rejection content', () => {
  const source = read('callout-roster-cache.js');
  assert.match(source, /sessionStorage/);
  assert.doesNotMatch(source, /localStorage/);
  assert.doesNotMatch(source, /reason|note|response|rejection/i);
  assert.match(source, /5\s*\*\s*60\s*\*\s*1000/);
});

check('join draft is session-only, expires, and never includes the acknowledgement', () => {
  const source = read('join-ui.js');
  assert.match(source, /sessionStorage/);
  assert.doesNotMatch(source, /localStorage/);
  assert.match(source, /DRAFT_TTL_MS = 30 \* 60 \* 1000/);
  const body = source.slice(source.indexOf('function saveDraft()'), source.indexOf('function restoreDraft()'));
  assert.doesNotMatch(body, /ack|consent|terms_version|privacy_version/i);
});

check('push code creates no app-owned token copy in Web Storage', () => {
  assert.doesNotMatch(read('push.js'), /localStorage|sessionStorage|indexedDB/);
});

check('provider-managed Auth persistence is explicit and separate from domain caching', () => {
  const source = read('login.html');
  assert.match(source, /browserLocalPersistence/);
  assert.match(source, /setPersistence\(auth,\s*browserLocalPersistence\)/);
});

check('service worker excludes remote data providers and version truth from runtime cache', () => {
  const source = read('firebase-messaging-sw.js');
  assert.match(source, /url\.origin !== self\.location\.origin/);
  assert.match(source, /firestore\|googleapis\|identitytoolkit/);
  assert.match(source, /\/version\\\.json/);
});

console.log(`sensitive-persistence-boundary: ${passed}/${passed} PASS`);
