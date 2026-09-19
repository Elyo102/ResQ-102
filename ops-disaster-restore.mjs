#!/usr/bin/env node
/* ======================================================================
 * ops-disaster-restore — צינור התאוששות מאסון למסמכי Firestore של ResQ.
 *
 * הגיבוי המקומי הקיים (ops-backup.mjs) מגבה קוד ומסמכים פרטיים בלבד —
 * אין בו אף מסמך Firestore, ואין בפרויקט מייצר ייצוא Firestore. לכן
 * הצינור הזה מגדיר פורמט תמונת-מצב משלו (resq-firestore-snapshot-v1)
 * ומשחזר ממנו לפרויקט Firebase מבודד בלבד.
 *
 * שלבים:  backup → verify → restore-plan → dry-run → isolated-restore
 *         → integrity-report
 *
 * שימוש:
 *   node ops-disaster-restore.mjs backup --source <project> [--out _גיבוי] [--dry-run]
 *   node ops-disaster-restore.mjs verify  --set <dir>
 *   node ops-disaster-restore.mjs plan    --set <dir> --target <project>
 *   node ops-disaster-restore.mjs restore --set <dir> --target <project> [--dry-run]
 *   node ops-disaster-restore.mjs restore --set <dir> --target <project> --execute --confirm-target <project>
 *   node ops-disaster-restore.mjs report  --set <dir>
 *
 * כללים מחייבים (נאכפים בקוד, לא רק בתיעוד):
 *   - ברירת המחדל היא dry-run. ‎--execute דורש ‎--confirm-target זהה ל-‎--target.
 *   - ‎station-102 (וכל מזהה שמופיע כ-default ב-.firebaserc) לעולם אינו יעד
 *     שחזור — בלי קשר לדגלים.
 *   - מקור התמונה ויעד השחזור חייבים להיות שונים.
 *   - ביצוע אמיתי דורש שהיעד יופיע ב-RESQ_RESTORE_TARGET_ALLOWLIST.
 *   - אין מחיקה ואין דריסה: createDocument בלבד. מסמך קיים → skipped_exists.
 *   - החרגות מגיעות אך ורק מ-functions/backup-policy.js.
 *   - ‎--dry-run אינו טוען SDK, אינו פונה לרשת ואינו כותב אף מסמך.
 *
 * הסקריפט אינו טוען firebase-admin ברמת המודול. ה-SDK נטען בעצלנות רק
 * בריצה אמיתית (backup ללא ‎--dry-run, או restore עם ‎--execute).
 * ====================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ----------------------------------------------------------------------
//  קבועים וחוזים
// ----------------------------------------------------------------------

export const SNAPSHOT_SCHEMA = 'resq-firestore-snapshot-v1';
export const PLAN_SCHEMA = 'resq-restore-plan-v1';
export const REPORT_SCHEMA = 'resq-integrity-report-v1';
export const RESTORE_MANIFEST_SCHEMA = 'resq-restore-manifest-v1';
export const SET = /^resq-fs-\d{8}T\d{9}Z-[a-f0-9]{16}$/;
export const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export const CANARY_COLLECTION = '_resq_restore_canary';
export const RUNS_DIR = 'restore-runs';
export const BACKUP_DIR_NAME = '_גיבוי';

// רשימת סירוב קשיחה. מזהה הייצור מופיע כאן במפורש, ובנוסף נקרא מ-.firebaserc
// בזמן ריצה — כך ששינוי שם הפרויקט בעתיד לא יפתח חור.
export const HARD_DENY_TARGETS = Object.freeze(['station-102']);

// מחלקות מדיניות שלעולם אינן משוחזרות (backup-policy.js הוא המקור היחיד).
export const NEVER_RESTORE_BACKUP = Object.freeze(['exclude']);
export const NEVER_RESTORE_RESTORE = Object.freeze(['do_not_restore', 'rebuild']);
export const MANUAL_BACKUP = Object.freeze(['specialized_media_export']);
export const MANUAL_RESTORE = Object.freeze(['specialized_restore']);

export const ALLOWED_ARGS = Object.freeze({
  backup: ['--source', '--out', '--dry-run'],
  verify: ['--set'],
  plan: ['--set', '--target'],
  restore: ['--set', '--target', '--dry-run', '--execute', '--confirm-target'],
  report: ['--set']
});

const sha256Hex = (input) => createHash('sha256').update(input).digest('hex');
export { sha256Hex };

// ----------------------------------------------------------------------
//  שורש המאגר ומדיניות
// ----------------------------------------------------------------------

// RESQ_REPO_ROOT מאפשר להריץ את הסקריפט ממיקום אחר (למשל מחבילת מסירה)
// מול functions/backup-policy.js של המאגר. ברירת המחדל: תיקיית הסקריפט.
export function repoRoot(options = {}) {
  const candidate = options.root || process.env.RESQ_REPO_ROOT || HERE;
  return path.resolve(candidate);
}

let policyCache = null;
export function loadPolicy(options = {}) {
  const root = repoRoot(options);
  if (policyCache && policyCache.root === root) return policyCache.module;
  const require = createRequire(pathToFileURL(path.join(root, 'ops-disaster-restore.mjs')).href);
  const module = require('./functions/backup-policy.js');
  if (!Array.isArray(module.DATA_POLICIES) || !Array.isArray(module.IDENTITY_POLICY_PATHS)) {
    throw new Error('backup-policy.js אינו מייצא DATA_POLICIES/IDENTITY_POLICY_PATHS');
  }
  policyCache = { root, module };
  return module;
}

// טביעת אצבע של המדיניות שנצרבת במניפסט: שחזור ממדיניות אחרת מתועד.
export function policyDigest(policy) {
  return sha256Hex(canonicalJson(policy.DATA_POLICIES.map((item) => Object.assign({}, item))));
}

// מזהה הייצור מ-.firebaserc (אם קיים) מצטרף לרשימת הסירוב הקשיחה.
export function denyTargets(options = {}) {
  const deny = new Set(HARD_DENY_TARGETS);
  try {
    const rc = JSON.parse(fs.readFileSync(path.join(repoRoot(options), '.firebaserc'), 'utf8'));
    const projects = rc && rc.projects ? rc.projects : {};
    if (typeof projects.default === 'string' && projects.default) deny.add(projects.default);
  } catch { /* אין .firebaserc — הרשימה הקשיחה עדיין תקפה */ }
  return deny;
}

// ----------------------------------------------------------------------
//  JSON קנוני וקידוד ערכי Firestore
// ----------------------------------------------------------------------
//
//  פורמט הערכים בתמונת-המצב (מתועד גם ב-DISASTER-RECOVERY-RUNBOOK.md):
//    Timestamp          → {"__ts":"<ISO-8601 UTC>"}  (וגם "__nanos" אם יש שבריר מעבר ל-ms)
//    GeoPoint           → {"__geo":{"lat":<num>,"lng":<num>}}
//    DocumentReference  → {"__ref":"<document path>"}
//    Bytes / Buffer     → {"__bytes":"<base64>"}
//  כל שאר הערכים: JSON רגיל. מפתחות ממוינים, בלי רווחים, מספרים סופיים בלבד.
//  ‎sha256 של מסמך = SHA-256 של ה-JSON הקנוני של data (אחרי הקידוד).

export function canonicalJson(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new Error('ערך מספרי לא סופי אינו ניתן לקנוניזציה');
    return JSON.stringify(value);
  }
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
    throw new Error('ערך מסוג ' + type + ' אינו ניתן לקנוניזציה');
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}

export function documentHash(data) {
  return sha256Hex(canonicalJson(data));
}

function isTimestampLike(value) {
  return value && typeof value === 'object' && typeof value.toDate === 'function' &&
    Number.isInteger(value.seconds) && Number.isInteger(value.nanoseconds);
}
function isGeoPointLike(value) {
  return value && typeof value === 'object' && typeof value.latitude === 'number' &&
    typeof value.longitude === 'number' && Object.keys(value).length <= 3 && !('path' in value);
}
function isReferenceLike(value) {
  return value && typeof value === 'object' && typeof value.path === 'string' &&
    value.firestore && typeof value.firestore === 'object';
}

// ממיר ערך שהגיע מ-SDK (או מ-JSON פשוט) לקידוד תמונת-המצב.
export function encodeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return { __ts: value.toISOString() };
  if (isTimestampLike(value)) {
    const iso = value.toDate().toISOString();
    const out = { __ts: iso };
    const nanos = value.nanoseconds % 1000000;
    if (nanos) out.__nanos = nanos;
    return out;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { __bytes: Buffer.from(value).toString('base64') };
  if (value && typeof value.toUint8Array === 'function') return { __bytes: Buffer.from(value.toUint8Array()).toString('base64') };
  if (isReferenceLike(value)) return { __ref: value.path };
  if (isGeoPointLike(value)) return { __geo: { lat: value.latitude, lng: value.longitude } };
  if (Array.isArray(value)) return value.map(encodeValue);
  const out = {};
  for (const key of Object.keys(value)) out[key] = encodeValue(value[key]);
  return out;
}

// ממיר קידוד תמונת-מצב חזרה לערכי SDK. ‎types = { Timestamp, GeoPoint, doc(path), Bytes }
export function decodeValue(value, types) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => decodeValue(item, types));
  const keys = Object.keys(value);
  if (keys.length >= 1 && keys.length <= 2 && typeof value.__ts === 'string' && keys.every((k) => k === '__ts' || k === '__nanos')) {
    const date = new Date(value.__ts);
    if (!Number.isFinite(date.getTime())) throw new Error('חותמת זמן לא תקינה בתמונת-המצב');
    if (!types || !types.Timestamp) return date;
    const ts = types.Timestamp.fromDate(date);
    if (value.__nanos) return new types.Timestamp(ts.seconds, ts.nanoseconds + value.__nanos);
    return ts;
  }
  if (keys.length === 1 && keys[0] === '__geo' && value.__geo && typeof value.__geo === 'object') {
    if (!types || !types.GeoPoint) return { latitude: value.__geo.lat, longitude: value.__geo.lng };
    return new types.GeoPoint(value.__geo.lat, value.__geo.lng);
  }
  if (keys.length === 1 && keys[0] === '__ref' && typeof value.__ref === 'string') {
    if (!types || !types.doc) return { path: value.__ref };
    return types.doc(value.__ref);
  }
  if (keys.length === 1 && keys[0] === '__bytes' && typeof value.__bytes === 'string') {
    const buffer = Buffer.from(value.__bytes, 'base64');
    if (!types || !types.Bytes) return buffer;
    return types.Bytes.fromUint8Array(new Uint8Array(buffer));
  }
  const out = {};
  for (const key of keys) out[key] = decodeValue(value[key], types);
  return out;
}

// ----------------------------------------------------------------------
//  התאמת נתיב מסמך למדיניות
// ----------------------------------------------------------------------
//
//  נתיב קונקרטי  stations/eilat_102/push_tokens/u1
//  תבנית מדיניות stations/{sid}/push_tokens/{uid}
//  מקטע {x} תופס מקטע אחד; {document=**} תופס מקטע אחד או יותר עד הסוף.
//  מקטע מילולי חייב להיות זהה. בין כמה תבניות מתאימות נבחרת זו עם הכי
//  הרבה מקטעים מילוליים (config/mode לפני config/{docId}).

export function isValidDocumentPath(docPath) {
  if (typeof docPath !== 'string' || !docPath) return false;
  const segments = docPath.split('/');
  if (segments.length < 2 || segments.length % 2 !== 0) return false;
  return segments.every((segment) => segment && !/[\r\n\0]/.test(segment) && segment !== '.' && segment !== '..');
}

function matchTemplate(templateSegments, pathSegments) {
  let literals = 0;
  let i = 0;
  for (; i < templateSegments.length; i++) {
    const t = templateSegments[i];
    if (t === '{document=**}') {
      if (i !== templateSegments.length - 1) return null;
      const rest = pathSegments.length - i;
      if (rest < 1) return null;
      return { literals, wildcard: true };
    }
    if (i >= pathSegments.length) return null;
    if (t.startsWith('{') && t.endsWith('}')) continue;
    if (t !== pathSegments[i]) return null;
    literals++;
  }
  if (i !== pathSegments.length) return null;
  return { literals, wildcard: false };
}

export function matchPolicy(docPath, policy) {
  if (!isValidDocumentPath(docPath)) return null;
  const segments = docPath.split('/');
  let best = null;
  for (const item of policy.DATA_POLICIES) {
    const match = matchTemplate(item.path.split('/'), segments);
    if (!match) continue;
    if (!best || match.literals > best.match.literals || (match.literals === best.match.literals && !match.wildcard && best.match.wildcard)) {
      best = { item, match };
    }
  }
  return best ? best.item : null;
}

// נתיב מסמך האב (שני מקטעים אחורה). לתבנית {document=**} — המסמך שלפני.
export function parentDocumentPath(docPath) {
  const segments = docPath.split('/');
  if (segments.length <= 2) return null;
  return segments.slice(0, segments.length - 2).join('/');
}

// סיווג יחיד לכל מסמך. זהו לב ההחרגה — אין מקור אחר להחרגות.
//   restore         נכתב ברגיל
//   after_parent    נכתב רק אחרי שמסמך האב נמצא ביעד
//   identity        חלק מקבוצת העקביות identity_and_auth (הכול-או-כלום)
//   manual_required נרשם בתוכנית, לעולם לא נכתב
//   skipped_policy  exclude / do_not_restore / rebuild — לעולם לא נכתב
//   unclassified    אין מדיניות — לעולם לא נכתב
export function classifyPath(docPath, policy) {
  if (docPath.split('/')[0] === CANARY_COLLECTION) return { action: 'skipped_policy', template: CANARY_COLLECTION + '/{runId}', reason: 'restore_canary' };
  const item = matchPolicy(docPath, policy);
  if (!item) return { action: 'unclassified', template: null, reason: 'no_policy' };
  const base = { template: item.path, backupPolicy: item.backupPolicy, restorePolicy: item.restorePolicy };
  if (NEVER_RESTORE_BACKUP.includes(item.backupPolicy) || NEVER_RESTORE_RESTORE.includes(item.restorePolicy)) {
    return Object.assign(base, { action: 'skipped_policy', reason: item.backupPolicy + '/' + item.restorePolicy });
  }
  if (MANUAL_BACKUP.includes(item.backupPolicy) || MANUAL_RESTORE.includes(item.restorePolicy)) {
    return Object.assign(base, { action: 'manual_required', reason: item.backupPolicy + '/' + item.restorePolicy });
  }
  if (item.restorePolicy === 'restore_with_identity_reconciliation' || policy.IDENTITY_POLICY_PATHS.includes(item.path)) {
    return Object.assign(base, { action: 'identity', reason: policy.IDENTITY_CONSISTENCY_GROUP });
  }
  if (item.restorePolicy === 'restore_after_parent') {
    return Object.assign(base, { action: 'after_parent', reason: 'restore_after_parent', parent: parentDocumentPath(docPath) });
  }
  if (item.restorePolicy === 'restore') return Object.assign(base, { action: 'restore', reason: 'restore' });
  return Object.assign(base, { action: 'unclassified', reason: 'restore_policy_not_implemented:' + item.restorePolicy });
}

// ----------------------------------------------------------------------
//  ארגומנטים
// ----------------------------------------------------------------------

export function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv.slice() : [];
  const command = list.shift();
  if (!command || !ALLOWED_ARGS[command]) throw new Error('פקודה לא מוכרת. אפשרויות: ' + Object.keys(ALLOWED_ARGS).join(' | '));
  const out = { command, source: '', out: BACKUP_DIR_NAME, set: '', target: '', dryRun: true, execute: false, confirmTarget: '' };
  const seen = new Set();
  while (list.length) {
    const key = list.shift();
    if (seen.has(key)) throw new Error('ארגומנט כפול: ' + key);
    seen.add(key);
    if (!ALLOWED_ARGS[command].includes(key)) throw new Error('פרמטר לא מוכר לפקודה ' + command + ': ' + key);
    const next = () => { const v = list.shift(); if (v === undefined || v.startsWith('--')) throw new Error('חסר ערך אחרי ' + key); return v; };
    switch (key) {
      case '--source': out.source = next(); break;
      case '--out': out.out = next(); break;
      case '--set': out.set = next(); break;
      case '--target': out.target = next(); break;
      case '--confirm-target': out.confirmTarget = next(); break;
      case '--dry-run': out.dryRun = true; break;
      case '--execute': out.execute = true; break;
      default: throw new Error('פרמטר לא מוכר: ' + key);
    }
  }
  if (command === 'backup') {
    if (!PROJECT_ID.test(out.source)) throw new Error('backup דורש ‎--source עם מזהה פרויקט תקין');
    out.dryRun = seen.has('--dry-run');
  } else {
    if (!out.set) throw new Error(command + ' דורש ‎--set <dir>');
  }
  if (command === 'plan' || command === 'restore') {
    if (!PROJECT_ID.test(out.target)) throw new Error(command + ' דורש ‎--target עם מזהה פרויקט תקין');
  }
  if (command === 'restore') {
    if (seen.has('--dry-run') && seen.has('--execute')) throw new Error('‎--dry-run ו-‎--execute סותרים זה את זה');
    if (seen.has('--confirm-target') && !seen.has('--execute')) throw new Error('‎--confirm-target תקף רק עם ‎--execute');
    if (out.execute) {
      if (!seen.has('--confirm-target')) throw new Error('‎--execute דורש ‎--confirm-target <project> זהה ל-‎--target');
      if (out.confirmTarget !== out.target) throw new Error('‎--confirm-target אינו זהה ל-‎--target — הביצוע נדחה');
      out.dryRun = false;
    } else {
      out.dryRun = true;
    }
  }
  return out;
}

// ----------------------------------------------------------------------
//  סירובי יעד
// ----------------------------------------------------------------------

export function refuseTarget(target, sourceProject, options = {}) {
  if (!PROJECT_ID.test(String(target || ''))) throw new Error('יעד שחזור אינו מזהה פרויקט תקין');
  if (denyTargets(options).has(target)) {
    throw new Error('סירוב קשיח: הפרויקט ' + target + ' הוא סביבת הייצור ולעולם אינו יעד שחזור — בלי קשר לדגלים');
  }
  if (sourceProject && sourceProject === target) {
    throw new Error('מקור התמונה ויעד השחזור חייבים להיות שונים (' + target + ')');
  }
}

/** גבול הקומיט האטומי של Firestore (batch/transaction). קבוצת זהות
 *  גדולה ממנו אינה ניתנת לכתיבה בפעולה אחת, ולכן נדחית סגור. */
export const ATOMIC_COMMIT_LIMIT = 500;

export function refuseUnlessAllowlisted(target, env = process.env) {
  const raw = String(env.RESQ_RESTORE_TARGET_ALLOWLIST || '');
  const allow = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!allow.length) throw new Error('ביצוע אמיתי דורש RESQ_RESTORE_TARGET_ALLOWLIST בסביבה (רשימה מופרדת בפסיקים) — חסר');
  if (!allow.includes(target)) throw new Error('היעד ' + target + ' אינו מופיע ב-RESQ_RESTORE_TARGET_ALLOWLIST — הביצוע נדחה');
}

/** אורך מזערי למפתח חתימה. מפתח קצר אינו חתימה — הוא אשליה שלה. */
export const SIGNING_KEY_MIN_LENGTH = 32;

export function requireSigningKey(env = process.env) {
  const key = String(env.RESQ_RESTORE_SIGNING_KEY || '');
  if (!key) throw new Error('ביצוע אמיתי דורש RESQ_RESTORE_SIGNING_KEY בסביבה — שחזור שבוצע חייב מניפסט חתום. אפס כתיבות בוצעו.');
  if (key.length < SIGNING_KEY_MIN_LENGTH) {
    throw new Error('RESQ_RESTORE_SIGNING_KEY קצר מ-' + SIGNING_KEY_MIN_LENGTH + ' תווים — נדחה. אפס כתיבות בוצעו.');
  }
  return key;
}

// ----------------------------------------------------------------------
//  מערכת קבצים: יעד _גיבוי, כתיבה עמידה, קריאת סט
// ----------------------------------------------------------------------

const relativeInside = (root, target) => {
  const rel = path.relative(root, target);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('הנתיב חייב להישאר בתוך שורש העבודה');
  return rel;
};
function noLinks(root, target) {
  let current = root;
  for (const part of relativeInside(root, target).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('קישורים סמליים אינם מתקבלים');
  }
}
function privateBackupDir(root, out) {
  const full = path.resolve(root, out);
  noLinks(root, full);
  if (relativeInside(root, full).split(path.sep)[0] !== BACKUP_DIR_NAME) throw new Error('יעד גיבוי לא בטוח: יש להשתמש בתת-עץ הפרטי ' + BACKUP_DIR_NAME);
  return full;
}
const durable = (file, text) => {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
function gitHead(root) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

export function renderSnapshotManifest(m) {
  return [
    '# תמונת-מצב Firestore · ' + m.id,
    '',
    'סכימה: ' + m.schema,
    'פרויקט מקור: ' + m.source_project,
    'נוצר: ' + m.created_at,
    'Commit: ' + (m.head || 'לא זמין'),
    'טביעת מדיניות: ' + m.policy_digest,
    'מסמכים: ' + m.documents.count + ' · בייטים: ' + m.documents.bytes + ' · SHA-256: ' + m.documents.sha256,
    'קבוצת זהות: ' + m.identity_group.count + ' מסמכים · SHA-256: ' + m.identity_group.sha256,
    '',
    '## נכלל (' + m.paths_included.length + ' תבניות)',
    ...m.paths_included.map((p) => '- `' + p.template + '` · ' + p.count),
    '',
    '## הוחרג לפי backup-policy.js (' + m.paths_excluded.length + ' תבניות)',
    ...m.paths_excluded.map((p) => '- `' + p.template + '` · ' + p.count + ' · ' + p.reason),
    '',
    '## ללא סיווג (' + m.paths_unclassified.length + ')',
    ...m.paths_unclassified.map((p) => '- `' + p.collection + '/*` · ' + p.count),
    '',
    'תמונה פרטית. מכילה מידע אישי ומזהי זהות. אינה ארטיפקט להפצה ואינה נכנסת ל-Git.',
    ''
  ].join('\n');
}

// ----------------------------------------------------------------------
//  שלב 1 · backup — תמונת-מצב דרך firestoreApi מוזרק
// ----------------------------------------------------------------------
//
//  חוזה firestoreApi:
//    listCollectionPaths(parentDocPath?)           → [collectionPath]   (בלי ארגומנט: אוספי שורש)
//    listDocuments(collectionPath, pageToken?)     → { documents:[{path, data}], nextPageToken }
//        חייב להחזיר גם "מסמכי אב חסרים" (path עם data: null) — ב-Firestore
//        תת-אוסף יכול להתקיים מתחת למסמך שאינו קיים, והצילום חייב לרדת אליו.
//    getDocument(path)                             → data | null
//    createDocument(path, data)                    → נכשל אם המסמך קיים
//    commitAtomic([{path, data}])                  → הכול-או-כלום; חובה לקבוצת הזהות בלבד.
//                                                     מתאם בלי הפונקציה הזו אינו משחזר זהויות כלל.
//  data תמיד בקידוד תמונת-המצב (encodeValue). המתאם האמיתי מקודד/מפענח.

async function walkCollections(api, parent, visit) {
  const collections = await api.listCollectionPaths(parent);
  for (const collection of [...collections].sort()) {
    let pageToken;
    do {
      const page = await api.listDocuments(collection, pageToken);
      for (const doc of page.documents) {
        // data === null: מסמך אב חסר. אינו נצלם, אבל יורדים לתת-האוספים שלו.
        if (doc.data !== null) await visit(doc);
        await walkCollections(api, doc.path, visit);
      }
      pageToken = page.nextPageToken || null;
    } while (pageToken);
  }
}

export async function runBackup(args, options = {}) {
  if (!PROJECT_ID.test(args.source)) throw new Error('backup דורש ‎--source תקין');
  const root = repoRoot(options);
  const out = privateBackupDir(root, args.out);
  const policy = loadPolicy(options);
  if (args.dryRun) {
    return { dryRun: true, source: args.source, destination: out, network: 'not contacted', writes: 'none', sdk: 'not loaded' };
  }
  const api = options.firestoreApi;
  if (!api) throw new Error('backup אמיתי דורש firestoreApi (נטען בעצלנות ב-CLI בלבד)');
  const now = options.now ? options.now : () => new Date();
  const created = now().toISOString();
  const id = 'resq-fs-' + created.replace(/[-:.]/g, '') + '-' + randomBytes(8).toString('hex');
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  noLinks(root, out);
  const lock = path.join(out, '.resq-fs-backup.lock');
  const lockFd = fs.openSync(lock, 'wx', 0o600);
  try {
    const stage = path.join(out, '.stage-' + id);
    const destination = path.join(out, id);
    fs.mkdirSync(stage, { mode: 0o700 });
    const lines = [];
    const included = new Map();
    const excluded = new Map();
    const unclassified = new Map();
    const identityHashes = [];
    const seenPaths = new Set();
    await walkCollections(api, undefined, async (doc) => {
      if (!isValidDocumentPath(doc.path)) throw new Error('נתיב מסמך לא תקין מהמקור');
      if (seenPaths.has(doc.path)) throw new Error('נתיב כפול מהמקור: ' + doc.path);
      seenPaths.add(doc.path);
      const cls = classifyPath(doc.path, policy);
      if (cls.action === 'skipped_policy') {
        const entry = excluded.get(cls.template) || { template: cls.template, count: 0, reason: cls.reason };
        entry.count++; excluded.set(cls.template, entry);
        return;
      }
      if (cls.action === 'unclassified') {
        const collection = doc.path.split('/')[0];
        const entry = unclassified.get(collection) || { collection, count: 0 };
        entry.count++; unclassified.set(collection, entry);
        return;
      }
      const data = encodeValue(doc.data === undefined ? {} : doc.data);
      const sha256 = documentHash(data);
      const line = JSON.stringify({ path: doc.path, data, sha256 });
      lines.push(line);
      const entry = included.get(cls.template) || { template: cls.template, count: 0, action: cls.action };
      entry.count++; included.set(cls.template, entry);
      if (cls.action === 'identity') identityHashes.push(sha256);
    });
    const jsonl = lines.length ? lines.join('\n') + '\n' : '';
    durable(path.join(stage, 'documents.jsonl'), jsonl);
    const bytes = Buffer.byteLength(jsonl, 'utf8');
    const manifest = {
      schema: SNAPSHOT_SCHEMA,
      state: 'complete',
      id,
      source_project: args.source,
      created_at: created,
      head: gitHead(root),
      policy_digest: policyDigest(policy),
      documents: { count: lines.length, bytes, sha256: sha256Hex(jsonl) },
      identity_group: { count: identityHashes.length, sha256: sha256Hex(identityHashes.sort().join('\n')) },
      paths_included: [...included.values()].sort((a, b) => a.template.localeCompare(b.template)),
      paths_excluded: [...excluded.values()].sort((a, b) => a.template.localeCompare(b.template)),
      paths_unclassified: [...unclassified.values()].sort((a, b) => a.collection.localeCompare(b.collection))
    };
    durable(path.join(stage, 'snapshot-manifest.md'), renderSnapshotManifest(manifest));
    durable(path.join(stage, 'snapshot-manifest.json'), JSON.stringify(manifest, null, 2));
    fs.renameSync(stage, destination);
    const verified = verifySet(destination, options);
    if (!verified.ok) throw new Error('תמונת-המצב שנכתבה נכשלה באימות: ' + verified.errors.join('; '));
    return { id, destination, documents: lines.length, excluded: manifest.paths_excluded.reduce((s, p) => s + p.count, 0), unclassified: manifest.paths_unclassified.reduce((s, p) => s + p.count, 0) };
  } finally {
    fs.closeSync(lockFd);
    fs.unlinkSync(lock);
  }
}

// ----------------------------------------------------------------------
//  שלב 2 · verify — כל מסמך, כל ספירה, כל טביעה
// ----------------------------------------------------------------------

export function readSet(setDir) {
  const dir = path.resolve(setDir);
  const manifestPath = path.join(dir, 'snapshot-manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('snapshot-manifest.json חסר ב-' + dir);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const jsonl = fs.readFileSync(path.join(dir, 'documents.jsonl'), 'utf8');
  const documents = jsonl ? jsonl.split('\n').filter((line) => line.length).map((line) => JSON.parse(line)) : [];
  return { dir, manifest, jsonl, documents };
}

export function verifySet(setDir, options = {}) {
  const errors = [];
  let set;
  try { set = readSet(setDir); }
  catch (error) { return { ok: false, errors: ['לא ניתן לקרוא את הסט: ' + error.message] }; }
  const { manifest, jsonl, documents, dir } = set;
  if (manifest.schema !== SNAPSHOT_SCHEMA) errors.push('סכימה לא נתמכת: ' + manifest.schema);
  if (manifest.state !== 'complete') errors.push('state אינו complete');
  if (!SET.test(String(manifest.id)) || path.basename(dir) !== manifest.id) errors.push('מזהה הסט אינו תואם לשם התיקייה');
  if (!PROJECT_ID.test(String(manifest.source_project))) errors.push('source_project לא תקין');
  if (!Number.isFinite(Date.parse(manifest.created_at))) errors.push('created_at לא תקין');
  if (!manifest.documents || manifest.documents.count !== documents.length) errors.push('ספירת המסמכים אינה תואמת למניפסט');
  if (!manifest.documents || manifest.documents.bytes !== Buffer.byteLength(jsonl, 'utf8')) errors.push('גודל documents.jsonl אינו תואם למניפסט');
  if (!manifest.documents || manifest.documents.sha256 !== sha256Hex(jsonl)) errors.push('SHA-256 של documents.jsonl אינו תואם למניפסט');
  const seen = new Set();
  const identityHashes = [];
  let policy = null;
  try { policy = loadPolicy(options); } catch (error) { errors.push('מדיניות לא נטענה: ' + error.message); }
  for (const doc of documents) {
    if (!isValidDocumentPath(doc.path)) { errors.push('נתיב לא תקין: ' + String(doc.path)); continue; }
    if (seen.has(doc.path)) errors.push('נתיב כפול: ' + doc.path);
    seen.add(doc.path);
    if (!doc.data || typeof doc.data !== 'object' || Array.isArray(doc.data)) errors.push('data אינו אובייקט: ' + doc.path);
    let recomputed = null;
    try { recomputed = documentHash(doc.data); } catch (error) { errors.push('קנוניזציה נכשלה: ' + doc.path); }
    if (recomputed !== doc.sha256) errors.push('SHA-256 של המסמך אינו תואם: ' + doc.path);
    if (policy && classifyPath(doc.path, policy).action === 'identity') identityHashes.push(doc.sha256);
  }
  if (policy) {
    if (manifest.policy_digest !== policyDigest(policy)) errors.push('policy_digest שונה מ-backup-policy.js הנוכחי (מדיניות השתנתה מאז הצילום)');
  }
  const identityDigest = sha256Hex(identityHashes.sort().join('\n'));
  if (!manifest.identity_group || manifest.identity_group.count !== identityHashes.length || manifest.identity_group.sha256 !== identityDigest) {
    errors.push('קבוצת הזהות אינה שלמה או אינה תואמת למניפסט');
  }
  return { ok: !errors.length, errors, set: manifest.id, documents: documents.length, source_project: manifest.source_project, created_at: manifest.created_at };
}

// ----------------------------------------------------------------------
//  שלב 3 · plan — תוכנית שחזור ממדיניות בלבד
// ----------------------------------------------------------------------

export function buildPlan(set, target, options = {}) {
  const policy = loadPolicy(options);
  const now = options.now ? options.now() : new Date();
  const buckets = { restore: [], after_parent: [], identity: [], manual_required: [], skipped_policy: [], unclassified: [] };
  for (const doc of set.documents) {
    const cls = classifyPath(doc.path, policy);
    buckets[cls.action].push(Object.assign({ path: doc.path, sha256: doc.sha256 }, cls));
  }
  // סדר כתיבה: לפי עומק ואז לפי נתיב — אב תמיד לפני צאצא. מסמכי after_parent
  // נבדקים בזמן ריצה מול מצב האב ביעד (נכתב / כבר קיים).
  const depthThenPath = (a, b) => (a.path.split('/').length - b.path.split('/').length) || a.path.localeCompare(b.path);
  const ordered = [...buckets.restore, ...buckets.after_parent].sort(depthThenPath);
  const identity = [...buckets.identity].sort(depthThenPath);
  const rpoSeconds = Math.max(0, Math.round((now.getTime() - Date.parse(set.manifest.created_at)) / 1000));
  return {
    schema: PLAN_SCHEMA,
    set: set.manifest.id,
    source_project: set.manifest.source_project,
    target_project: target,
    snapshot_created_at: set.manifest.created_at,
    planned_at: now.toISOString(),
    policy_digest: set.manifest.policy_digest,
    rpo: { seconds: rpoSeconds, measured: true, basis: 'planned_at - snapshot_created_at' },
    counts: {
      restore: buckets.restore.length,
      after_parent: buckets.after_parent.length,
      identity: identity.length,
      manual_required: buckets.manual_required.length,
      skipped_policy: buckets.skipped_policy.length,
      unclassified: buckets.unclassified.length
    },
    write_order: ordered.map((d) => ({ path: d.path, action: d.action, template: d.template, parent: d.parent || null, sha256: d.sha256 })),
    identity_group: { name: policy.IDENTITY_CONSISTENCY_GROUP, documents: identity.map((d) => ({ path: d.path, template: d.template, sha256: d.sha256 })) },
    manual_required: buckets.manual_required.map((d) => ({ path: d.path, template: d.template, reason: d.reason })),
    skipped_policy: buckets.skipped_policy.map((d) => ({ path: d.path, template: d.template, reason: d.reason })),
    unclassified: buckets.unclassified.map((d) => ({ path: d.path, reason: d.reason }))
  };
}

export function renderPlan(plan) {
  const c = plan.counts;
  return [
    '# תוכנית שחזור · ' + plan.set + ' → ' + plan.target_project,
    '',
    'מקור: ' + plan.source_project + ' · תמונה מ-' + plan.snapshot_created_at + ' · תוכנן: ' + plan.planned_at,
    'RPO (שניות מהצילום ועד התכנון): ' + plan.rpo.seconds,
    '',
    '| קטגוריה | מסמכים |', '|---|---|',
    '| restore | ' + c.restore + ' |',
    '| restore_after_parent | ' + c.after_parent + ' |',
    '| identity (' + plan.identity_group.name + ', הכול-או-כלום) | ' + c.identity + ' |',
    '| manual_required (לעולם לא נכתב אוטומטית) | ' + c.manual_required + ' |',
    '| skipped_policy | ' + c.skipped_policy + ' |',
    '| unclassified (לעולם לא נכתב) | ' + c.unclassified + ' |',
    '',
    '## manual_required',
    ...(plan.manual_required.length ? plan.manual_required.map((d) => '- `' + d.path + '` · ' + d.reason) : ['_אין_']),
    ''
  ].join('\n');
}

// ----------------------------------------------------------------------
//  שלב 4-6 · restore — dry-run (ברירת מחדל) או ביצוע מבודד + דוח שלמות
// ----------------------------------------------------------------------

function ensureRunDir(setDir, runId) {
  const dir = path.join(setDir, RUNS_DIR, runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function signReport(report, env = process.env) {
  const canonical = canonicalJson(report);
  const key = env.RESQ_RESTORE_SIGNING_KEY;
  const reportSha = sha256Hex(canonical);
  if (!key) return { report_sha256: reportSha, signature: null, unsigned: true };
  return { report_sha256: reportSha, signature: { alg: 'HMAC-SHA256', value: createHmac('sha256', key).update(canonical).digest('hex') }, unsigned: false };
}

export function verifySignature(report, manifest, env = process.env) {
  if (!manifest.signature) return { verified: false, reason: 'unsigned' };
  const key = env.RESQ_RESTORE_SIGNING_KEY;
  if (!key) return { verified: false, reason: 'key_missing' };
  const expected = createHmac('sha256', key).update(canonicalJson(report)).digest('hex');
  return { verified: expected === manifest.signature.value, reason: expected === manifest.signature.value ? 'ok' : 'mismatch' };
}

export function renderReport(report) {
  const s = report.summary;
  const lines = [
    '# דוח שלמות שחזור · ' + report.run_id,
    '',
    'מצב: **' + report.mode + '** · סט: ' + report.set + ' · מקור: ' + report.source_project + ' · יעד: ' + report.target_project,
    'התחלה: ' + report.started_at + ' · סיום: ' + report.finished_at,
    'RPO: ' + (report.rpo_seconds === null ? 'לא נמדד' : report.rpo_seconds + ' שניות') +
      ' · RTO: ' + (report.rto_seconds === null ? 'לא נמדד' : report.rto_seconds + ' שניות') + ' · measured: ' + report.measured,
    'קנרית: ' + report.canary.status + (report.canary.path ? ' (`' + report.canary.path + '`)' : ''),
    '',
    '| קטגוריה | מסמכים |', '|---|---|',
    '| written | ' + s.written + ' |',
    '| skipped_exists | ' + s.skipped_exists + ' |',
    '| skipped_policy | ' + s.skipped_policy + ' |',
    '| skipped_parent_not_restored | ' + s.skipped_parent_not_restored + ' |',
    '| manual_required | ' + s.manual_required + ' |',
    '| unclassified | ' + s.unclassified + ' |',
    '| mismatch_after_readback | ' + report.mismatch_after_readback.length + ' |',
    '',
    'קבוצת זהות: **' + report.identity_group.status + '** · ' + report.identity_group.reason + ' · ' + report.identity_group.count + ' מסמכים',
    ''
  ];
  if (report.mismatch_after_readback.length) {
    lines.push('## אי-התאמות אחרי קריאה חוזרת');
    for (const m of report.mismatch_after_readback) lines.push('- `' + m.path + '` · צפוי ' + m.expected + ' · נקרא ' + m.actual);
    lines.push('');
  }
  if (report.manual_required.length) {
    lines.push('## דורש טיפול ידני (לא נכתב)');
    for (const m of report.manual_required) lines.push('- `' + m.path + '` · ' + m.reason);
    lines.push('');
  }
  if (report.errors.length) {
    lines.push('## שגיאות');
    for (const e of report.errors) lines.push('- ' + e);
    lines.push('');
  }
  lines.push('אין מחיקה ואין דריסה: כל מסמך שכבר היה ביעד נשאר כפי שהיה.');
  lines.push('');
  return lines.join('\n');
}

export async function runRestore(args, options = {}) {
  const env = options.env || process.env;
  const now = options.now ? options.now : () => new Date();
  const startedAt = now();
  const set = readSet(args.set);
  // סירובים לפני כל דבר אחר — גם לפני אימות הסט.
  refuseTarget(args.target, set.manifest.source_project, options);
  const mode = args.dryRun ? 'dry-run' : 'execute';
  if (mode === 'execute') {
    if (args.confirmTarget !== args.target) throw new Error('‎--execute דורש ‎--confirm-target זהה ל-‎--target');
    refuseUnlessAllowlisted(args.target, env);
    /* שחזור שבוצע בפועל חייב להיות חתים. דוח בלי חתימה אינו ראיה:
     * אי אפשר להוכיח מאוחר יותר מה נכתב, על ידי מי ומאיזה סט. הסירוב
     * כאן — לפני הקנרית ולפני כל כתיבה — הוא היחיד שמבטיח אפס כתיבות.
     * dry-run מותר ללא מפתח, ואז הוא מסומן unsigned במפורש. */
    requireSigningKey(env);
    if (!options.firestoreApi) throw new Error('ביצוע אמיתי דורש firestoreApi (נטען בעצלנות ב-CLI בלבד)');
  }
  const verification = verifySet(set.dir, options);
  if (!verification.ok) throw new Error('הסט נכשל באימות לפני שחזור: ' + verification.errors.join('; '));
  const plan = buildPlan(set, args.target, Object.assign({}, options, { now: () => startedAt }));
  const runId = 'run-' + startedAt.toISOString().replace(/[-:.]/g, '') + '-' + randomBytes(4).toString('hex');
  const runDir = ensureRunDir(set.dir, runId);
  durable(path.join(runDir, 'restore-plan.json'), JSON.stringify(plan, null, 2));
  durable(path.join(runDir, 'restore-plan.md'), renderPlan(plan));

  const report = {
    schema: REPORT_SCHEMA,
    run_id: runId,
    mode,
    set: set.manifest.id,
    source_project: set.manifest.source_project,
    target_project: args.target,
    started_at: startedAt.toISOString(),
    finished_at: null,
    rpo_seconds: null,
    rto_seconds: null,
    measured: false,
    canary: { status: mode === 'dry-run' ? 'not_attempted' : 'pending', path: null },
    summary: { written: 0, skipped_exists: 0, skipped_policy: plan.counts.skipped_policy, skipped_parent_not_restored: 0, manual_required: plan.counts.manual_required, unclassified: plan.counts.unclassified, planned_writes: plan.write_order.length + plan.identity_group.documents.length },
    written: [],
    skipped_exists: [],
    skipped_policy: plan.skipped_policy,
    skipped_parent_not_restored: [],
    manual_required: plan.manual_required,
    unclassified: plan.unclassified,
    identity_group: { status: mode === 'dry-run' ? 'planned' : 'pending', reason: mode === 'dry-run' ? 'dry_run_no_writes' : '', count: plan.identity_group.documents.length },
    mismatch_after_readback: [],
    errors: []
  };

  if (mode === 'execute') {
    const api = options.firestoreApi;
    const targetStatus = new Map(); // path → 'written' | 'exists'
    const readbackOf = async (docPath, expected) => {
      const readBack = await api.getDocument(docPath);
      const actual = readBack === null || readBack === undefined ? null : documentHash(encodeValue(readBack));
      if (actual !== expected) report.mismatch_after_readback.push({ path: docPath, expected, actual });
      return actual === expected;
    };
    // קנרית: הכתיבה הראשונה, ורק אחרי שנקראה חזרה מותר לכתוב מסמך אמיתי.
    const canaryPath = CANARY_COLLECTION + '/' + runId;
    const canaryData = { run_id: runId, set: set.manifest.id, target_project: args.target, written_at: startedAt.toISOString() };
    try {
      await api.createDocument(canaryPath, canaryData);
      const back = await api.getDocument(canaryPath);
      if (!back || documentHash(encodeValue(back)) !== documentHash(canaryData)) throw new Error('הקנרית לא נקראה חזרה כפי שנכתבה');
      report.canary = { status: 'ok', path: canaryPath };
    } catch (error) {
      report.canary = { status: 'failed', path: canaryPath };
      report.errors.push('הקנרית נכשלה — הריצה בוטלה בלי אף כתיבת נתונים: ' + error.message);
      return finishRun(report, plan, runDir, startedAt, now, env, true);
    }
    const isExists = (error) => error && (error.code === 6 || error.code === 'ALREADY_EXISTS' || error.code === 'already-exists' || /exists/i.test(String(error.message)));
    const writeOne = async (doc) => {
      const existing = await api.getDocument(doc.path);
      if (existing !== null && existing !== undefined) {
        report.skipped_exists.push({ path: doc.path });
        targetStatus.set(doc.path, 'exists');
        return 'exists';
      }
      const data = set.documents.find((d) => d.path === doc.path).data;
      try { await api.createDocument(doc.path, data); }
      catch (error) {
        if (isExists(error)) { report.skipped_exists.push({ path: doc.path }); targetStatus.set(doc.path, 'exists'); return 'exists'; }
        throw error;
      }
      report.written.push({ path: doc.path, sha256: doc.sha256 });
      targetStatus.set(doc.path, 'written');
      await readbackOf(doc.path, doc.sha256);
      return 'written';
    };
    try {
      for (const doc of plan.write_order) {
        if (doc.action === 'after_parent') {
          const parentState = targetStatus.get(doc.parent) || ((await api.getDocument(doc.parent)) ? 'exists' : null);
          if (!parentState) { report.skipped_parent_not_restored.push({ path: doc.path, parent: doc.parent }); continue; }
          targetStatus.set(doc.parent, parentState);
        }
        await writeOne(doc);
      }
      // קבוצת הזהות: הכול-או-כלום. שלושה שערים לפני הכתיבה הראשונה:
      //   1. sha256 של כל מסמך זהות בסט מחושב מחדש ותואם.
      //   2. הטביעה של הקבוצה במניפסט תואמת.
      //   3. ביעד אין מצב זהות חלקי (אף מסמך זהות מהסט אינו קיים כבר).
      const identityDocs = plan.identity_group.documents;
      if (!identityDocs.length) {
        report.identity_group = { status: 'skipped', reason: 'no_identity_documents_in_set', count: 0 };
      } else {
        const gate = [];
        const digest = sha256Hex(identityDocs.map((d) => d.sha256).sort().join('\n'));
        for (const doc of identityDocs) {
          const source = set.documents.find((d) => d.path === doc.path);
          if (!source || documentHash(source.data) !== doc.sha256) gate.push('checksum:' + doc.path);
        }
        if (set.manifest.identity_group.sha256 !== digest || set.manifest.identity_group.count !== identityDocs.length) gate.push('group_digest');
        for (const doc of identityDocs) {
          if ((await api.getDocument(doc.path)) !== null) gate.push('target_has_partial_identity_state:' + doc.path);
        }
        /* גבול הקומיט האטומי של Firestore. מעבר לו אי אפשר לכתוב את
         * הקבוצה בפעולה אחת, ולכן הסירוב סגור: עדיף לא לשחזר זהות בכלל
         * מאשר לשחזר חצי ממנה. */
        if (identityDocs.length > ATOMIC_COMMIT_LIMIT) {
          gate.push('group_exceeds_atomic_commit_limit:' + identityDocs.length + '>' + ATOMIC_COMMIT_LIMIT);
        }
        /* בלי קומיט אטומי אין קבוצת זהות. מתאם שאינו תומך בכך אינו
         * "נופל אחורה" ללולאה — הוא פשוט לא משחזר זהויות. */
        if (typeof api.commitAtomic !== 'function') gate.push('adapter_has_no_atomic_commit');
        if (gate.length) {
          report.identity_group = { status: 'skipped', reason: 'gate_failed: ' + gate.join(', '), count: identityDocs.length };
        } else {
          const writes = identityDocs.map((doc) => ({
            path: doc.path, data: set.documents.find((d) => d.path === doc.path).data
          }));
          try {
            await api.commitAtomic(writes);
          } catch (error) {
            /* קומיט אטומי שנכשל לא כתב דבר — כך מוגדר batch.commit.
             * הדוח אומר זאת במפורש, ואף מסמך זהות אינו נספר ככתוב. */
            report.identity_group = { status: 'skipped', reason: 'atomic_commit_failed: ' + error.message, count: identityDocs.length };
            report.errors.push('קבוצת הזהות לא נכתבה: הקומיט האטומי נכשל. אף מסמך זהות לא נכתב.');
            throw Object.assign(new Error('identity_atomic_commit_failed'), { __identityHandled: true });
          }
          for (const doc of identityDocs) {
            report.written.push({ path: doc.path, sha256: doc.sha256 });
            targetStatus.set(doc.path, 'written');
            await readbackOf(doc.path, doc.sha256);
          }
          report.identity_group = { status: 'restored', reason: 'atomic_commit_after_all_checksums_verified', count: identityDocs.length };
        }
      }
    } catch (error) {
      if (!error.__identityHandled) report.errors.push('השחזור נעצר: ' + error.message);
      if (report.identity_group.status === 'pending') report.identity_group = { status: 'skipped', reason: 'run_aborted_before_identity_group', count: plan.identity_group.documents.length };
    }
  }
  return finishRun(report, plan, runDir, startedAt, now, env, false);
}

function finishRun(report, plan, runDir, startedAt, now, env, aborted) {
  const finishedAt = now();
  report.finished_at = finishedAt.toISOString();
  report.summary.written = report.written.length;
  report.summary.skipped_exists = report.skipped_exists.length;
  report.summary.skipped_parent_not_restored = report.skipped_parent_not_restored.length;
  if (report.mode === 'execute') {
    report.rpo_seconds = plan.rpo.seconds;
    report.rto_seconds = Math.max(0, Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000));
    report.measured = true;
  }
  report.aborted = aborted;
  report.ok = !report.errors.length && !report.mismatch_after_readback.length && !aborted;
  const signature = signReport(report, env);
  const manifest = Object.assign({
    schema: RESTORE_MANIFEST_SCHEMA,
    run_id: report.run_id,
    mode: report.mode,
    set: report.set,
    source_project: report.source_project,
    target_project: report.target_project,
    started_at: report.started_at,
    finished_at: report.finished_at,
    rpo_seconds: report.rpo_seconds,
    rto_seconds: report.rto_seconds,
    measured: report.measured,
    ok: report.ok,
    written: report.summary.written
  }, signature);
  durable(path.join(runDir, 'integrity-report.json'), JSON.stringify(report, null, 2));
  durable(path.join(runDir, 'integrity-report.md'), renderReport(report));
  durable(path.join(runDir, 'restore-manifest.json'), JSON.stringify(manifest, null, 2));
  return { ok: report.ok, mode: report.mode, run_id: report.run_id, run_dir: runDir, summary: report.summary, identity_group: report.identity_group, canary: report.canary, mismatch_after_readback: report.mismatch_after_readback.length, rpo_seconds: report.rpo_seconds, rto_seconds: report.rto_seconds, measured: report.measured, signed: !manifest.unsigned, errors: report.errors };
}

// ----------------------------------------------------------------------
//  report — קריאת הריצה האחרונה בסט ואימות חתימתה
// ----------------------------------------------------------------------

export function runReport(args, options = {}) {
  const env = options.env || process.env;
  const set = readSet(args.set);
  const runsDir = path.join(set.dir, RUNS_DIR);
  if (!fs.existsSync(runsDir)) return { set: set.manifest.id, runs: [] };
  const runs = fs.readdirSync(runsDir).filter((name) => /^run-\d{8}T\d{9}Z-[a-f0-9]{8}$/.test(name)).sort();
  return {
    set: set.manifest.id,
    runs: runs.map((runId) => {
      const dir = path.join(runsDir, runId);
      const report = JSON.parse(fs.readFileSync(path.join(dir, 'integrity-report.json'), 'utf8'));
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'restore-manifest.json'), 'utf8'));
      const reportShaOk = sha256Hex(canonicalJson(report)) === manifest.report_sha256;
      return { run_id: runId, mode: report.mode, ok: report.ok, target_project: report.target_project, summary: report.summary, identity_group: report.identity_group, rpo_seconds: report.rpo_seconds, rto_seconds: report.rto_seconds, measured: report.measured, report_sha256_ok: reportShaOk, unsigned: manifest.unsigned === true, signature: verifySignature(report, manifest, env) };
    })
  };
}

// ----------------------------------------------------------------------
//  מתאם SDK אמיתי — נטען בעצלנות בלבד, לעולם לא ברמת המודול
// ----------------------------------------------------------------------

async function loadAdminApi(projectId, options = {}) {
  const root = repoRoot(options);
  const require = createRequire(pathToFileURL(path.join(root, 'functions', 'package.json')).href);
  const resolved = require.resolve('firebase-admin');
  const imported = await import(pathToFileURL(resolved).href);
  const admin = imported.default || imported;
  if (!admin.apps.length) admin.initializeApp({ projectId });
  const db = admin.firestore();
  const types = { Timestamp: admin.firestore.Timestamp, GeoPoint: admin.firestore.GeoPoint, Bytes: admin.firestore.Bytes, doc: (p) => db.doc(p) };
  const PAGE = 300;
  return {
    async listCollectionPaths(parent) {
      const collections = parent ? await db.doc(parent).listCollections() : await db.listCollections();
      return collections.map((c) => c.path);
    },
    async listDocuments(collectionPath, pageToken) {
      // listDocuments (ולא שאילתה) כדי לכלול גם מסמכי אב חסרים שיש להם תת-אוספים.
      const refs = (await db.collection(collectionPath).listDocuments()).sort((a, b) => a.path.localeCompare(b.path));
      const start = pageToken ? refs.findIndex((r) => r.path === pageToken) + 1 : 0;
      const page = refs.slice(start, start + PAGE);
      const snaps = page.length ? await db.getAll(...page) : [];
      const documents = snaps.map((d) => ({ path: d.ref.path, data: d.exists ? encodeValue(d.data()) : null }));
      return { documents, nextPageToken: start + PAGE < refs.length ? page[page.length - 1].path : null };
    },
    async getDocument(docPath) {
      const snap = await db.doc(docPath).get();
      return snap.exists ? encodeValue(snap.data()) : null;
    },
    async createDocument(docPath, data) {
      await db.doc(docPath).create(decodeValue(data, types));
    },
    /* קומיט אטומי אמיתי לקבוצת הזהות. `batch.create` נכשל אם מסמך קיים,
     * ו-`commit` הוא הכול-או-כלום: אם מסמך אחד נכשל, אף אחד מהם אינו
     * נכתב. זו הסיבה שהקבוצה אינה נכתבת בלולאה — לולאה שנכשלת באמצע
     * משאירה זהות חלקית, וזה בדיוק מה שאסור. */
    async commitAtomic(writes) {
      if (writes.length > ATOMIC_COMMIT_LIMIT) throw new Error('atomic commit limit exceeded: ' + writes.length);
      const batch = db.batch();
      for (const w of writes) batch.create(db.doc(w.path), decodeValue(w.data, types));
      await batch.commit();
    }
  };
}

// ----------------------------------------------------------------------
//  CLI
// ----------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'backup': {
      if (args.dryRun) { console.log(JSON.stringify(await runBackup(args))); return; }
      const firestoreApi = await loadAdminApi(args.source);
      console.log(JSON.stringify(await runBackup(args, { firestoreApi })));
      return;
    }
    case 'verify': {
      const result = verifySet(args.set);
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case 'plan': {
      const set = readSet(args.set);
      refuseTarget(args.target, set.manifest.source_project);
      const verification = verifySet(set.dir);
      if (!verification.ok) throw new Error('הסט נכשל באימות: ' + verification.errors.join('; '));
      const plan = buildPlan(set, args.target);
      console.log(JSON.stringify(Object.assign({ counts: plan.counts, rpo: plan.rpo }, { manual_required: plan.manual_required.length, unclassified: plan.unclassified.length })));
      console.log(renderPlan(plan));
      return;
    }
    case 'restore': {
      const options = {};
      if (!args.dryRun) {
        const set = readSet(args.set);
        refuseTarget(args.target, set.manifest.source_project);
        refuseUnlessAllowlisted(args.target);
        options.firestoreApi = await loadAdminApi(args.target);
      }
      const result = await runRestore(args, options);
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case 'report': {
      console.log(JSON.stringify(runReport(args), null, 2));
      return;
    }
    default: throw new Error('פקודה לא מוכרת');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('ops-disaster-restore נכשל: ' + error.message);
    process.exitCode = 1;
  });
}
