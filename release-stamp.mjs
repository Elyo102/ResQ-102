// מחולל/מדביק גרסת שחרור — Release identity Scope 12 (closure batch
// item 3): tests/version-release.mjs עד היום היה רק **בודק התאמה** —
// שיטת פרסום עדיין הייתה: אדם מעדכן ידנית את version.js, version.json,
// firebase-messaging-sw.js, ואת מחרוזת ה-?v= ב-289 מקומות, ורק אחר כך
// version-release.mjs מגלה אם שכח מקום אחד. זה לא "מקור אמת יחיד
// שנצרך" — זה מקור אמת יחיד *שאמורים* להעתיק ממנו ידנית לכל מקום.
//
// הכלי הזה עושה את ההעתקה בפועל: קורא את release-manifest.json (מקור
// האמת היחיד) וכותב מחדש את כל הקבצים הנגזרים ממנו — version.js,
// version.json, functions/index.js (heartbeat), functions/maintenance-
// service.js, firebase-messaging-sw.js, וכל מחרוזת ?v= סטטית מקומית
// בכל קובץ html/js. הוא חולק את אותה רשימת קבצים ואת אותו regex בדיוק
// עם tests/version-release.mjs (import, לא כפילות) — כדי שהמחולל
// והבודק לעולם לא יסטו זה מזה בהגדרה של "מה נסרק".
//
// שימוש:
//   node release-stamp.mjs           — כותב את הקבצים בפועל
//   node release-stamp.mjs --check   — dry-run: מדווח מה היה משתנה,
//                                       exit 1 אם יש סטייה, לא כותב כלום
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MANIFEST, loadSnapshot, releaseKey, STATIC_URL, LEGITIMATE_UNVERSIONED, versionVocabulary
} from './tests/version-release.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = here;

// קבצים שיש להם עדכון ייעודי (לא רק שכתוב ?v= גורף).
const DEDICATED = new Set([
  'version.json', 'version.js', 'functions/index.js',
  'functions/maintenance-service.js', 'firebase-messaging-sw.js',
  'functions/ops-telemetry-contract.js', 'incident-client.js'
]);

// 42H.20 · ביקורת Codex, חוסם 4 · אוצר מילים של גרסאות: רשימה סגורה
// שהטלמטריה מנרמלת אליה (גרסה שאינה ברשימה → 'unknown'). שחרור חדש
// **מוסיף** את עצמו לרשימה; גרסאות ישנות נשארות, כי מכשירים ישנים עדיין
// מדווחים אותן. הפורמט המקורי (מירכאות, פסיק-רווח) נשמר.
function appendVersion(source, pattern, version, label) {
  const versions = versionVocabulary(source, pattern);
  if (!versions.length) throw new Error('release-stamp: could not find ' + label);
  if (versions.includes(version)) return source;
  const match = source.match(pattern);
  const inner = match[1];
  const rebuilt = inner.replace(/\s*$/, '') + ", '" + version + "'";
  return source.replace(match[0], match[0].replace(inner, rebuilt));
}

export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') errors.push('manifest is an object');
  if (!manifest.version) errors.push('manifest.version is set');
  if (!manifest.date) errors.push('manifest.date is set');
  if (!manifest.sw_cache_key) errors.push('manifest.sw_cache_key is set');
  if (manifest.version && manifest.asset_query !== releaseKey(manifest.version)) {
    errors.push('manifest.asset_query (' + manifest.asset_query + ') must equal releaseKey(version) (' + releaseKey(manifest.version || '') + ')');
  }
  return errors;
}

function replaceOnce(source, pattern, replacement, label) {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  const matches = [...source.matchAll(global)];
  if (matches.length !== 1) {
    throw new Error('release-stamp: expected exactly one match for ' + label + ', found ' + matches.length);
  }
  return source.replace(global, replacement);
}

// הפונקציה הטהורה: לוקחת Map של קבצים (בדיוק כמו שloadSnapshot() מחזיר)
// ומניפסט, ומחזירה Map חדש עם התוכן המעודכן. לא נוגעת בדיסק — כך שאפשר
// לבדוק אותה על מניפסט היפותטי בלי לכתוב דבר אמיתי.
export function stampFiles(files, manifest) {
  const problems = validateManifest(manifest);
  if (problems.length) throw new Error('release-stamp: invalid manifest — ' + problems.join('; '));

  const out = new Map(files);
  let restamped = 0;

  // version.json — אותו פורמט קומפקטי בדיוק, בלי רווחים.
  out.set('version.json', JSON.stringify({ v: manifest.version, d: manifest.date }) + '\n');

  // version.js
  out.set('version.js', replaceOnce(
    out.get('version.js') || '',
    /export\s+const\s+APP_VERSION\s*=\s*['"][^'"]+['"]\s*;/,
    "export const APP_VERSION = '" + manifest.version + "';",
    'version.js APP_VERSION'
  ));
  out.set('version.js', replaceOnce(
    out.get('version.js'),
    /export\s+const\s+APP_DATE\s*=\s*['"][^'"]+['"]\s*;/,
    "export const APP_DATE    = '" + manifest.date + "';",
    'version.js APP_DATE'
  ));

  // functions/index.js — heartbeat
  out.set('functions/index.js', replaceOnce(
    out.get('functions/index.js') || '',
    /state: 'ok', version: '[^']*'/,
    "state: 'ok', version: '" + manifest.version + "'",
    'functions/index.js heartbeat version'
  ));

  // functions/maintenance-service.js
  out.set('functions/maintenance-service.js', replaceOnce(
    out.get('functions/maintenance-service.js') || '',
    /version:'[^']*', ai_state:/,
    "version:'" + manifest.version + "', ai_state:",
    'functions/maintenance-service.js version'
  ));

  // functions/index.js — month-authority release id
  out.set('functions/index.js', replaceOnce(
    out.get('functions/index.js'),
    /monthAuthorityReleaseId:\s*'[^']*'/,
    "monthAuthorityReleaseId: '" + manifest.version + "'",
    'functions/index.js monthAuthorityReleaseId'
  ));

  // telemetry version vocabularies — server and client
  out.set('functions/ops-telemetry-contract.js', appendVersion(
    out.get('functions/ops-telemetry-contract.js') || '',
    /const\s+VERSIONS\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/,
    manifest.version, 'functions/ops-telemetry-contract.js VERSIONS'
  ));
  out.set('incident-client.js', appendVersion(
    out.get('incident-client.js') || '',
    /TELEMETRY_VERSIONS\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/,
    manifest.version, 'incident-client.js TELEMETRY_VERSIONS'
  ));

  // firebase-messaging-sw.js — cache key
  out.set('firebase-messaging-sw.js', replaceOnce(
    out.get('firebase-messaging-sw.js') || '',
    /const\s+CACHE\s*=\s*'[^']*';/,
    "const CACHE = '" + manifest.sw_cache_key + "';",
    'firebase-messaging-sw.js CACHE'
  ));

  // כל מחרוזת ?v= סטטית מקומית, בכל קובץ html/js — אותו regex ואותה
  // רשימת חריגים בדיוק כמו version-release.mjs, כדי שהמחולל לעולם לא
  // יסרוק שטח שהבודק לא מכיר, או ההפך.
  for (const [name, source] of files) {
    if (!/\.(?:html|js)$/.test(name) || name === 'firebase-messaging-sw.js') continue;
    let changed = source;
    let didChange = false;
    STATIC_URL.lastIndex = 0;
    changed = changed.replace(STATIC_URL, (whole, quote, url) => {
      if (LEGITIMATE_UNVERSIONED.has(name + '\0' + url)) return whole;
      const parsed = url.match(/^(\.\/[^?]+\.(?:js|css|mp3))\?v=([a-z0-9]+)$/i);
      if (!parsed) return whole; // לא URL עם ?v= בכלל — לא נוגעים
      if (parsed[2] === manifest.asset_query) return whole; // כבר מעודכן
      didChange = true;
      restamped += 1;
      return quote + parsed[1] + '?v=' + manifest.asset_query + quote;
    });
    if (didChange) out.set(name, changed);
  }

  return { files: out, restamped };
}

// 42H.20 · ביקורת Codex, חוסם 4 · גם קבצי הבדיקה נושאים מחרוזות ?v=
// מילוליות (ייבוא מודולים דרך שרת הבדיקה, ציפיות regex). הם אינם חלק
// מחוזה ה-290 של version-release.mjs (אינם נפרסים), אבל בדיקה שמקבעת
// מזהה שחרור ישן היא בדיוק מה ש-Codex אסר — לכן המחולל מדביק גם אותם,
// ו---check מדווח עליהם.
// רק מפתח בצורת מזהה שחרור (42h191, 42h20) מוחלף — לא ערכי בדיקה מכוונים כמו ?v=stale.
// כולל גם צורת regex בבדיקות (\?v=…) ותבניות `${module}?v=…`.
const TEST_ASSET_QUERY = /(\\?\?v=)(\d{2}[a-z]\d+)(?![a-z0-9])/g;
export function loadTestSnapshot() {
  const files = new Map();
  const dir = path.join(root, 'tests');
  for (const name of fs.readdirSync(dir)) {
    // הבודק והבדיקה של המחולל מחזיקים פיקסצ'ות מכוונות עם מפתחות ישנים.
    if (!/\.mjs$/.test(name) || name === 'version-release.mjs' || name === 'release-stamp-test.mjs') continue;
    files.set('tests/' + name, fs.readFileSync(path.join(dir, name), 'utf8'));
  }
  return files;
}
export function stampTestFiles(files, manifest) {
  const out = new Map(files);
  let restamped = 0;
  for (const [name, source] of files) {
    const changed = source.replace(TEST_ASSET_QUERY, (whole, prefix, key) => {
      if (key === manifest.asset_query) return whole;
      restamped += 1;
      return prefix + manifest.asset_query;
    });
    if (changed !== source) out.set(name, changed);
  }
  return { files: out, restamped };
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const files = loadSnapshot();
  const { files: stamped, restamped: restampedApp } = stampFiles(files, MANIFEST);
  const testFiles = loadTestSnapshot();
  const { files: stampedTests, restamped: restampedTests } = stampTestFiles(testFiles, MANIFEST);
  const restamped = restampedApp + restampedTests;

  const changedNames = [];
  for (const [name, content] of stamped) {
    if (files.get(name) !== content) changedNames.push(name);
  }
  for (const [name, content] of stampedTests) {
    if (testFiles.get(name) !== content) { changedNames.push(name); stamped.set(name, content); }
  }

  if (checkOnly) {
    if (changedNames.length) {
      console.log('✗ ' + changedNames.length + ' קבצים אינם תואמים את release-manifest.json:');
      for (const name of changedNames) console.log('    ' + name);
      process.exitCode = 1;
    } else {
      console.log('✓ כל הקבצים הנגזרים כבר תואמים ל-release-manifest.json (' + manifestSummary() + ') — אין מה לחולל מחדש');
    }
    return;
  }

  for (const name of changedNames) {
    fs.writeFileSync(path.join(root, name), stamped.get(name));
  }
  console.log(changedNames.length
    ? 'עודכנו ' + changedNames.length + ' קבצים, ' + restamped + ' מחרוזות ?v= הודבקו מחדש → ' + manifestSummary()
    : 'שום קובץ לא השתנה — הכול כבר תואם ל-' + manifestSummary());
}

function manifestSummary() {
  return MANIFEST.version + ' (' + MANIFEST.date + ', asset_query=' + MANIFEST.asset_query + ', sw=' + MANIFEST.sw_cache_key + ')';
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
