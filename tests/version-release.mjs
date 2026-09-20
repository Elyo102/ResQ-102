import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// 42H.20 §12.1 · these three used to be hardcoded here, independently of
// version.js/version.json/the service-worker CACHE key - four places a real
// release had to touch by hand, this file being a fifth if anyone forgot to
// bump it too. `release-manifest.json` is now the one file a release
// actually edits first; every other file (including these expectations) is
// checked against it, not against a value re-typed in each place.
export const MANIFEST = JSON.parse(fs.readFileSync(path.join(root, 'release-manifest.json'), 'utf8'));

export const EXPECTED_VERSIONED_REFERENCES = 332; // 42H.25 fleet identity feedback: faults.html now imports the shared error-text module so identity changes no longer leak a raw code (+1). // 42H.25 Pilot Trust error copy extends the shared error-text import to attendance.html, board.html, alerts.html and device-readiness.html (+4). Pilot Trust UX: swaps.html/forms.html/sign.html now import the shared error-text module (+3). callout.js מייבא error-text ו-mode-bar (+2), callout-console.js מייבא error-text (+1), schedule-management.js מייבא את שניהם (+2). hr-requests-ui.js ו-hr-documents-ui.js מייבאים את error-text (+2). שני המודולים החדשים עצמם אינם מייבאים דבר ואינם מוסיפים הפניות. // חיווי מצב אימון קומפקטי: nav.js מייבא את mode-bar עבור החזרת התגית אחרי בנייה מחדש של הכותרת (+1), ו-callout-console.js מייבא ממנו את אזהרת השידור המלאה (+1). // פריט 6 — דיווח היעדרות: hr-requests-ui.js מייבא את `hours.js?v=…` עבור גזירת „דיווח רטרואקטיבי" (+1). אותה פונקציה בדיוק שמשמשת את דיווח הנוכחות, כדי שלא תהיינה שתי גזירות שונות לאותו מושג. // חבילת SaaS/אבטחה/מדדים: saas-admin.html +7 (theme, firebase-config, nav, roles, appcheck, monitored-functions, saas-admin-ui) ו-metrics.html +7 (theme, firebase-config, nav, roles, appcheck, monitored-functions, metrics-ui). שני הדפים הם מסכי מנהל-על ואינם ב-SHELL של ה-Service Worker, כמו שאר דפי ה-super. // 42H.21 קליטה בקישור קבוצתי: login.html +1 (join-ui.js), admin.html +1 (join-admin-ui.js), device-readiness.html +8 (theme, firebase-config, nav, pwa, push, join-ui, monitored-functions, appcheck). // 42H.20 Codex blocker 4: +1 for callout.js's './callout-siren.mp3?v=…' now that mp3 is inside the contract. // 42H.20 §5.4 adds alerts-feed.js/messageTimeMs imports in alerts.html (2); §5.5's home-bell fix adds one new import of alerts-feed.js in login.html (1) — it reuses bulletin.js's existing ?v= import for messageTimeMs, so no second reference there.
// 42H.20 · ביקורת Codex, חוסם 4 · גם מדיה מקומית שמצוינת עם ?v= (callout-siren.mp3)
// היא צרכן של זהות השחרור — לא רק js/css.
export const STATIC_URL = /(['"`])(\.\/[^'"`\s<>?]+\.(?:js|css|mp3)(?:\?[^'"`\s<>]*)?)\1/g;
export const LEGITIMATE_UNVERSIONED = new Set([
  'pwa.js\0./firebase-messaging-sw.js',
  'push.js\0./firebase-messaging-sw.js',
  'signature.js\0./signflow.js'
]);

function clean(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function loadSnapshot() {
  const files = new Map();
  for (const name of fs.readdirSync(root)) {
    if (!/\.(?:html|js|json)$/.test(name)) continue;
    files.set(name, clean(fs.readFileSync(path.join(root, name), 'utf8')));
  }
  for (const relative of ['functions/index.js', 'functions/maintenance-service.js', 'functions/ops-telemetry-contract.js']) {
    files.set(relative, clean(fs.readFileSync(path.join(root, relative), 'utf8')));
  }
  return files;
}

// רשימת גרסאות בתוך מקור (Object.freeze([...]) או מחרוזת יחידה) → מערך.
export function versionVocabulary(source, pattern) {
  const match = String(source || '').match(pattern);
  if (!match) return [];
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1]);
}

export function releaseKey(version) {
  return String(version || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function shellEntries(worker) {
  const match = worker.match(/const\s+SHELL\s*=\s*\[([\s\S]*?)\]\s*;/);
  if (!match) return null;
  return new Set([...match[1].matchAll(/['"]\.\/([^'"?]+)['"]/g)].map((item) => item[1]));
}

function localModuleImports(source) {
  const found = [];
  const pattern = /(?:\bimport\s+(?:[^'"();]*?\s+from\s*)?|\bexport\s+[^'";]*?\s+from\s+)(['"])(\.\/[^'"]+)\1/g;
  for (const match of String(source).matchAll(pattern)) {
    const target = match[2].split(/[?#]/, 1)[0].slice(2);
    if (/\.(?:js|css)$/.test(target)) found.push(target);
  }
  // HTML entry points also load local modules through script src. Dynamic
  // imports (e.g. the optional vehicle photo bundle) are not startup dependencies.
  for (const match of String(source).matchAll(/<script\b[^>]*\bsrc\s*=\s*(['"])(\.\/[^'"]+)\1[^>]*>/gi)) {
    const target = match[2].split(/[?#]/, 1)[0].slice(2);
    if (target.endsWith('.js')) found.push(target);
  }
  return found;
}

export function audit(files, manifest = MANIFEST) {
  const EXPECTED_VERSION = manifest.version;
  const EXPECTED_DATE = manifest.date;
  const EXPECTED_ASSET_KEY = manifest.asset_query;
  const errors = [];
  let release;
  try {
    release = JSON.parse(files.get('version.json') || '');
  } catch (error) {
    return { errors: ['version.json is valid JSON: ' + error.message], count: 0 };
  }
  const keys = Object.keys(release).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['d', 'v'])) errors.push('version.json contains only v and d');
  if (release.v !== EXPECTED_VERSION) errors.push('version.json version is ' + EXPECTED_VERSION);
  if (release.d !== EXPECTED_DATE) errors.push('version.json date is ' + EXPECTED_DATE);

  const key = EXPECTED_ASSET_KEY;
  if (key !== releaseKey(release.v)) errors.push('asset key belongs exactly to the visible release');
  const versionSource = files.get('version.js') || '';
  const versionMatches = [...versionSource.matchAll(/export\s+const\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]\s*;/g)];
  const dateMatches = [...versionSource.matchAll(/export\s+const\s+APP_DATE\s*=\s*['"]([^'"]+)['"]\s*;/g)];
  if (versionMatches.length !== 1 || versionMatches[0]?.[1] !== release.v) errors.push('version.js matches version.json exactly');
  if (dateMatches.length !== 1 || dateMatches[0]?.[1] !== release.d) errors.push('version.js date matches version.json exactly');
  const functionsIndex = files.get('functions/index.js') || '';
  if (!functionsIndex.includes("state: 'ok', version: '" + EXPECTED_VERSION + "'")) {
    errors.push('system heartbeat reports the visible release');
  }
  const maintenanceService = files.get('functions/maintenance-service.js') || '';
  if (!maintenanceService.includes("version:'" + EXPECTED_VERSION + "', ai_state:")) {
    errors.push('maintenance health row reports the visible release');
  }
  // 42H.20 · ביקורת Codex, חוסם 4 · עוד שלושה צרכני זהות שחרור שנשארו
  // ידניים: אוצר המילים של הטלמטריה (שרת + לקוח — גרסה שאינה ברשימה
  // מנורמלת ל-'unknown' ונעלמת מהדיווח), ומזהה השחרור של סמכות החודש.
  if ((functionsIndex.match(/monthAuthorityReleaseId:\s*'([^']*)'/) || [])[1] !== EXPECTED_VERSION) {
    errors.push('month-authority release id is the visible release');
  }
  const telemetryContract = files.get('functions/ops-telemetry-contract.js') || '';
  if (!versionVocabulary(telemetryContract, /const\s+VERSIONS\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/).includes(EXPECTED_VERSION)) {
    errors.push('server telemetry vocabulary (ops-telemetry-contract.js VERSIONS) accepts the visible release');
  }
  const incidentClient = files.get('incident-client.js') || '';
  if (!versionVocabulary(incidentClient, /TELEMETRY_VERSIONS\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/).includes(EXPECTED_VERSION)) {
    errors.push('client telemetry vocabulary (incident-client.js TELEMETRY_VERSIONS) accepts the visible release');
  }

  const worker = files.get('firebase-messaging-sw.js') || '';
  // 42H.20 §12.1 · consumed directly from the manifest, not re-derived by
  // formula here - the manifest is what a release actually edits.
  const expectedCache = manifest.sw_cache_key;
  const cacheMatches = [...worker.matchAll(/const\s+CACHE\s*=\s*['"]([^'"]+)['"]\s*;/g)];
  if (cacheMatches.length !== 1 || cacheMatches[0]?.[1] !== expectedCache) {
    errors.push('service-worker cache is exactly ' + expectedCache);
  }
  const shell = shellEntries(worker);
  if (!shell) {
    errors.push('service-worker SHELL is statically auditable');
  } else {
    for (const entry of shell) {
      if (!/\.(?:js|html)$/.test(entry)) continue;
      const source = files.get(entry);
      if (typeof source !== 'string') {
        errors.push('service-worker SHELL target exists: ./' + entry);
        continue;
      }
      for (const dependency of localModuleImports(source)) {
        if (!shell.has(dependency)) errors.push('./' + entry + ': offline dependency missing from SHELL: ./' + dependency);
      }
    }
  }

  let count = 0;
  for (const [name, source] of files) {
    if (!/\.(?:html|js)$/.test(name) || name === 'firebase-messaging-sw.js') continue;
    STATIC_URL.lastIndex = 0;
    let match;
    while ((match = STATIC_URL.exec(source))) {
      const url = match[2];
      if (LEGITIMATE_UNVERSIONED.has(name + '\0' + url)) continue;
      const parsed = url.match(/^(\.\/[^?]+\.(?:js|css|mp3))\?v=([a-z0-9]+)$/i);
      if (!parsed) {
        errors.push(name + ': local static URL lacks the exact release query: ' + url);
        continue;
      }
      count += 1;
      if (parsed[2] !== key) errors.push(name + ': stale cache key in ' + url);
      const target = path.resolve(root, parsed[1].slice(2));
      if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        errors.push(name + ': static target does not exist: ' + parsed[1]);
      }
    }
  }
  if (count !== EXPECTED_VERSIONED_REFERENCES) {
    errors.push('versioned static reference count is ' + EXPECTED_VERSIONED_REFERENCES + ', got ' + count);
  }

  const faults = files.get('faults.html') || '';
  const vehicleBusinessUrl = "location.href = './vehicle.html?v=' + encodeURIComponent(v.id);";
  if (!faults.includes(vehicleBusinessUrl)) errors.push('vehicle business query remains an encoded vehicle id');
  return { errors, count };
}

function replaceExactlyOne(files, name, before, after) {
  const source = files.get(name);
  assert.equal(typeof source, 'string', 'mutation source exists: ' + name);
  assert.equal(source.split(before).length - 1, 1, 'mutation changes exactly one occurrence: ' + before);
  const clone = new Map(files);
  clone.set(name, source.replace(before, after));
  return clone;
}

function mustFail(label, files) {
  assert.ok(audit(files).errors.length > 0, label + ' is rejected');
}

// מיובא מ-release-stamp.mjs כדי לחלוק את אותו מקור אמת (אילו קבצים
// נסרקים, אילו החרגות לגיטימיות, המבנה של audit()) — בלי ייבוא
// שמריץ את כל בדיקות ה-mutation האלה כתופעת לוואי. רק כשהקובץ רץ
// ישירות (node version-release.mjs) מתבצעת הריצה המלאה למטה.
// 42H.20 · Codex final blocker · ב-Windows process.argv[1] הוא נתיב
// (C:\…\release-stamp.mjs), לא URL — ההשוואה הישנה ל-`file://${argv[1]}`
// נכשלה בשקט ו-main() מעולם לא רץ: `--check` החזיר exit 0 בלי פלט.
// pathToFileURL מייצר את אותו URL קנוני שב-import.meta.url בכל פלטפורמה.
const isMain = !!process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const files = loadSnapshot();
  const baseline = audit(files);
  if (baseline.errors.length) {
    for (const error of baseline.errors) console.error('✗ ' + error);
    process.exit(1);
  }

  const EXPECTED_VERSION = MANIFEST.version;
  const EXPECTED_DATE = MANIFEST.date;
  const key = MANIFEST.asset_query;
  mustFail('version.json mutation', replaceExactlyOne(files, 'version.json', EXPECTED_VERSION, '42G.invalid'));
  mustFail('release date mutation', replaceExactlyOne(files, 'version.json', EXPECTED_DATE, '1.1.2000'));
  mustFail('version.js mutation', replaceExactlyOne(files, 'version.js',
    "APP_VERSION = '" + EXPECTED_VERSION + "'", "APP_VERSION = '42G.invalid'"));
  mustFail('heartbeat version mutation', replaceExactlyOne(files, 'functions/index.js',
    "state: 'ok', version: '" + EXPECTED_VERSION + "'", "state: 'ok', version: '42G.invalid'"));
  mustFail('maintenance version mutation', replaceExactlyOne(files, 'functions/maintenance-service.js',
    "version:'" + EXPECTED_VERSION + "', ai_state:", "version:'42G.invalid', ai_state:"));
  mustFail('service-worker cache mutation', replaceExactlyOne(files, 'firebase-messaging-sw.js',
    'resq-v' + key + '-release1', 'resq-vstale-release1'));
  mustFail('stale JavaScript query', replaceExactlyOne(files, 'schedule-management.js',
    './firebase-config.js?v=' + key, './firebase-config.js?v=stale'));
  mustFail('stale CSS query', replaceExactlyOne(files, 'schedule-management.html',
    './theme.css?v=' + key, './theme.css?v=stale'));
  mustFail('missing query', replaceExactlyOne(files, 'schedule-management.html',
    './schedule-management.js?v=' + key, './schedule-management.js'));
  mustFail('missing target', replaceExactlyOne(files, 'schedule-management.html',
    './schedule-management.js?v=' + key, './__missing-version-release__.js?v=' + key));
  mustFail('vehicle business query mutation', replaceExactlyOne(files, 'faults.html',
    "location.href = './vehicle.html?v=' + encodeURIComponent(v.id);",
    "location.href = './vehicle.html?v=" + key + "';"));
  mustFail('offline module closure mutation', replaceExactlyOne(files, 'firebase-messaging-sw.js',
    "'./schedule-management.js', './schedule-update-guard.js', './schedule-file-import.js', './board.html'",
    "'./schedule-management.js', './schedule-update-guard.js', './board.html'"));
  const missingFleet = replaceExactlyOne(files, 'firebase-messaging-sw.js',
    "'./faults.js', './fleet.js',", "'./faults.js',");
  for (const entry of ['board.html', 'faults.html']) {
    assert.ok(audit(missingFleet).errors.includes('./' + entry + ': offline dependency missing from SHELL: ./fleet.js'),
      entry + ' catches the missing fleet module through its real HTML import');
  }
  const missingScriptSource = replaceExactlyOne(files, 'firebase-messaging-sw.js',
    "'./schedule-management.js',", '');
  assert.ok(audit(missingScriptSource).errors.includes('./schedule-management.html: offline dependency missing from SHELL: ./schedule-management.js'),
    'HTML script src participates in the offline closure');

  for (const target of ['hr-client.js', 'hr-hours-ui.js']) {
    const missing = replaceExactlyOne(files, 'firebase-messaging-sw.js', "'./" + target + "',", '');
    assert.ok(audit(missing).errors.some(error => error.includes('offline dependency missing from SHELL: ./' + target)),
      'HR HTML/module startup requires ' + target + ' offline');
  }
  // 42H.20 · ביקורת Codex, חוסם 4 · שלושת הצרכנים שנוספו לחוזה.
  mustFail('month-authority release id mutation', replaceExactlyOne(files, 'functions/index.js',
    "monthAuthorityReleaseId: '" + EXPECTED_VERSION + "'", "monthAuthorityReleaseId: '42G.invalid'"));
  mustFail('server telemetry vocabulary mutation', replaceExactlyOne(files, 'functions/ops-telemetry-contract.js',
    "'" + EXPECTED_VERSION + "'", "'42G.invalid'"));
  mustFail('client telemetry vocabulary mutation', replaceExactlyOne(files, 'incident-client.js',
    "'" + EXPECTED_VERSION + "'", "'42G.invalid'"));
  console.log('Release version contract: ' + baseline.count + ' references; 19/19 mutations caught.');
}
