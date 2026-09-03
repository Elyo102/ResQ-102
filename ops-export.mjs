#!/usr/bin/env node
/* ======================================================================
 * ops-export — מייצא את יומן התקלות, חוות הדעת ובריאות המשימות
 * המתוזמנות מ-Firestore לתיקיית `_ניטור\` בתיקיית הפרויקט, כקובצי
 * Markdown שקלוד ו-Codex קוראים ומטפלים לפיהם.
 *
 * כלי מקומי; אינו מתקין משימה מתוזמנת. דורש פרויקט מפורש והרשאות Admin:
 *   GOOGLE_APPLICATION_CREDENTIALS=<service-account.json>   או
 *   gcloud auth application-default login
 *
 * שימוש:
 *   node ops-export.mjs --project station-102 --station eilat_102
 *   node ops-export.mjs ... --resolve <fingerprint> --by codex --note-code fixed
 *   node ops-export.mjs ... --ignore <fingerprint> --by operator
 *   node ops-export.mjs ... --reopen <fingerprint> --by claude
 *   node ops-export.mjs ... --mark-read --by claude        (כל חוות הדעת שיוצאו מסומנות כנקראו)
 *
 * כל תיקיית _ניטור פרטית ומוחרגת מ-Git ומ-Hosting, לא רק feedback.md.
 * --dry-run אינו טוען SDK, אינו קורא רשת ואינו כותב דבר.
 * פעולות --resolve/--ignore/--reopen/--mark-read משנות נתונים ודורשות
 * אישור פעולה מול הפרויקט שנבחר. אין כאן אישור או הרצה אוטומטית.
 * ====================================================================== */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import telemetryContract from './functions/ops-telemetry-contract.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = Object.freeze({
  out: '_ניטור',
  station: 'eilat_102',
  days: 30,
  incidentLimit: 500,
  feedbackLimit: 500
});

export function parseArgs(argv) {
  const out = Object.assign({ by: '', note: 'none', resolve: '', ignore: '', reopen: '', markRead: false, dryRun: false }, DEFAULTS);
  const list = Array.isArray(argv) ? argv.slice() : [];
  while (list.length) {
    const key = list.shift();
    const next = () => { const v = list.shift(); if (v === undefined) throw new Error('חסר ערך אחרי ' + key); return v; };
    switch (key) {
      case '--project': out.project = next(); break;
      case '--station': out.station = next(); break;
      case '--out': out.out = next(); break;
      case '--days': out.days = Number(next()); break;
      case '--by': out.by = next(); break;
      case '--note-code': out.note = next(); break;
      case '--resolve': out.resolve = next(); break;
      case '--ignore': out.ignore = next(); break;
      case '--reopen': out.reopen = next(); break;
      case '--mark-read': out.markRead = true; break;
      case '--dry-run': out.dryRun = true; break;
      default: throw new Error('פרמטר לא מוכר: ' + key);
    }
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(out.project || '')) throw new Error('Explicit valid --project is required');
  if (!/^[a-z0-9_-]{2,80}$/.test(String(out.station))) throw new Error('--station אינו תקין');
  if (!Number.isFinite(out.days) || out.days < 1 || out.days > 365) throw new Error('--days חייב להיות 1..365');
  const actions = [out.resolve, out.ignore, out.reopen].filter(Boolean).length + (out.markRead ? 1 : 0);
  if (actions > 1) throw new Error('Only one status action per invocation');
  if (actions && !['operator', 'codex', 'claude'].includes(out.by)) throw new Error('Action requires --by operator/codex/claude');
  for (const fp of [out.resolve, out.ignore, out.reopen].filter(Boolean)) if (!/^[a-f0-9]{40}$/.test(fp)) throw new Error('Invalid fingerprint');
  if (!telemetryContract.NOTE_CODES.includes(out.note)) throw new Error('Invalid note code');
  privateOutput(out.out);
  return out;
}

function privateOutput(value) {
  const base = path.join(HERE, '_ניטור');
  const full = path.resolve(HERE, value);
  const rel = path.relative(base, full);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Output must remain in private _ניטור directory');
  let cursor = HERE;
  for (const part of path.relative(HERE, full).split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Output links are not accepted');
  }
  return full;
}

/* --- עיצוב -------------------------------------------------------- */
function esc(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()!|#]/g, c => '\\' + c).replace(/[\r\n]/g, ' ');
}
function short(fingerprint) {
  return String(fingerprint || '').slice(0, 12);
}
function day(iso) {
  return String(iso || '').slice(0, 10);
}
function ago(iso, nowIso) {
  const a = new Date(iso).getTime();
  const b = new Date(nowIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  const days = Math.floor((b - a) / 86400000);
  return days <= 0 ? 'היום' : days === 1 ? 'אתמול' : 'לפני ' + days + ' ימים';
}

export function renderIncidents(rows, meta) {
  const now = meta.now;
  const open = rows.filter((r) => r.status === 'open');
  const other = rows.filter((r) => r.status !== 'open');
  const lines = [];
  lines.push('# יומן תקלות · ' + meta.station);
  lines.push('');
  lines.push('עודכן: ' + now + ' · פתוחות: **' + open.length + '** · טופלו/הוזנחו: ' + other.length + ' · חלון: ' + meta.days + ' ימים');
  lines.push('');
  lines.push('> פלט פרטי. הספירות מתייחסות לעמוד מוגבל של עד 500 רשומות, לא לכל המאגר. טקסט שגיאה ישן אינו מיוצא.');
  lines.push('> טיפול דורש --project מפורש, --station ו--by. הערות הן קוד סגור בלבד (--note-code).');
  lines.push('');
  lines.push('## פתוחות');
  lines.push('');
  if (!open.length) {
    lines.push('_אין תקלות פתוחות._');
  } else {
    lines.push('| # | מזהה | מונה | לאחרונה | לראשונה | סוג | מסכים | גרסאות | קוד | דוגמה |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    open.forEach((r, i) => {
      lines.push('| ' + (i + 1) + ' | `' + short(r.fingerprint) + '` | ' + Number(r.count || 0)
        + ' | ' + day(r.last_seen_iso) + ' (' + ago(r.last_seen_iso, now) + ')'
        + ' | ' + day(r.first_seen_iso)
        + ' | ' + esc(r.kind) + (r.callable ? ' `' + esc(r.callable) + '`' : '')
        + ' | ' + esc((r.screens || []).join(', '))
        + ' | ' + esc((r.versions || []).join(', '))
        + ' | `' + esc(r.code || '—') + '`'
        + ' | — |');
    });
  }
  lines.push('');
  lines.push('## טופלו / הוזנחו (' + meta.days + ' הימים האחרונים)');
  lines.push('');
  if (!other.length) {
    lines.push('_אין._');
  } else {
    lines.push('| מזהה | מצב | מי | מתי | מונה | קוד | הערה |');
    lines.push('|---|---|---|---|---|---|---|');
    other.forEach((r) => {
      lines.push('| `' + short(r.fingerprint) + '` | ' + esc(r.status) + ' | ' + esc(r.resolved_by || '') + ' | ' + day(r.resolved_at)
        + ' | ' + Number(r.count || 0) + ' | `' + esc(r.code || '—') + '` | ' + esc(r.note_code || '') + ' |');
    });
  }
  lines.push('');
  lines.push('## רשומות מלאות (למכונה)');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(rows.map((r) => ({
    fingerprint: r.fingerprint, status: r.status, count: r.count, kind: r.kind, code: r.code,
    callable: r.callable || '', screens: r.screens || [], versions: r.versions || [], roles: r.roles || [],
    first_seen: r.first_seen_iso, last_seen: r.last_seen_iso, first_version: r.first_version,
    last_version: r.last_version,
    resolved_by: r.resolved_by || null, resolved_at: r.resolved_at || null, note_code: r.note_code || null,
    reopened_from: r.reopened_from || null
  })), null, 1).replace(/[<>&`]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

export function renderFeedback(rows, meta) {
  const lines = [];
  lines.push('# חוות דעת · ' + meta.station);
  lines.push('');
  lines.push('עודכן: ' + esc(meta.now) + ' · בעמוד המוגבל (עד 500): **' + rows.length + '** · חדשות: ' + rows.filter((r) => r.status === 'new').length);
  lines.push('');
  lines.push('> ⚠ קובץ זה מכיל **מידע אישי** (uid, מספר עובד, טקסט חופשי). הוא ב-`.gitignore` ואינו נכנס לקומיט. אין להעתיק ממנו שמות או מזהים לקוד, לבדיקות או לחדר.');
  lines.push('');
  const byCat = {};
  rows.forEach((r) => { byCat[r.category] = (byCat[r.category] || 0) + 1; });
  const rated = rows.filter((r) => typeof r.rating === 'number');
  const avg = rated.length ? (rated.reduce((s, r) => s + r.rating, 0) / rated.length).toFixed(2) : '—';
  lines.push('## סיכום');
  lines.push('');
  lines.push('- לפי סוג: ' + Object.keys(byCat).sort().map((k) => esc(k) + ' ' + byCat[k]).join(' · '));
  lines.push('- דירוג ממוצע: ' + avg + ' (' + rated.length + ' דירוגים)');
  const byScreen = {};
  rows.forEach((r) => { byScreen[r.screen] = (byScreen[r.screen] || 0) + 1; });
  lines.push('- לפי מסך: ' + Object.keys(byScreen).sort((a, b) => byScreen[b] - byScreen[a]).map((k) => esc(k) + ' ' + byScreen[k]).join(' · '));
  lines.push('');
  lines.push('## רשומות');
  lines.push('');
  if (!rows.length) lines.push('_אין חוות דעת עדיין._');
  rows.forEach((r) => {
    lines.push('### ' + day(r.created_at_iso) + ' · ' + esc(r.category) + (typeof r.rating === 'number' ? ' · דירוג ' + r.rating + '/5' : '') + ' · ' + esc(r.screen) + (r.status === 'new' ? ' · **חדש**' : ''));
    lines.push('');
    lines.push('- מזהה: `' + esc(r.id) + '` · תפקיד: ' + esc(r.role || '') + ' · מספר עובד: ' + esc(r.employee_number || '') + ' · uid: `' + esc(r.uid) + '` · גרסה: ' + esc(r.version) + ' · מותר לפנות: ' + (r.allow_contact ? 'כן' : 'לא') + (r.read_by ? ' · נקרא ע"י ' + esc(r.read_by) + ' ' + day(r.read_at) : ''));
    lines.push('');
    lines.push('> ' + esc(r.text || ''));
    lines.push('');
  });
  return lines.join('\n');
}

export function renderHealth(info, meta) {
  const lines = [];
  lines.push('# בריאות המערכת · ' + meta.station);
  lines.push('');
  lines.push('עודכן: ' + meta.now);
  lines.push('');
  lines.push('## משימות מתוזמנות (מה שנכתב ל-Firestore)');
  lines.push('');
  lines.push('| משימה | רשומה אחרונה | תקינות |');
  lines.push('|---|---|---|');
  const snap = info.lastSnapshot;
  lines.push('| nightlySnapshot (`backups/{date}`) | ' + (snap ? esc(snap.date) : '—') + ' | '
    + (snap ? (staleDays(snap.date, meta.now) > 2 ? '⚠ לא רצה ' + staleDays(snap.date, meta.now) + ' ימים' : 'תקין') + (snap.drops && Object.keys(snap.drops).length ? ' · ⚠ ירידות: ' + esc(JSON.stringify(snap.drops)) : '') : '⚠ אין רשומה') + ' |');
  const scan = info.lastScan;
  lines.push('| nightlyScan (`scans/{month}`) | ' + (scan ? esc(scan.month) + ' (' + day(scan.ran_at_iso) + ')' : '—') + ' | '
    + (scan ? (staleDays(scan.ran_at_iso, meta.now) > 2 ? '⚠ לא רצה ' + staleDays(scan.ran_at_iso, meta.now) + ' ימים' : 'תקין') : '⚠ אין רשומה') + ' |');
  lines.push('');
  lines.push('## תקלות וחוות דעת — ספירות בעמוד מוגבל, לא סך המאגר');
  lines.push('');
  lines.push('- תקלות פתוחות: **' + info.openIncidents + '** · חדשות ב-7 ימים: ' + info.incidents7d + ' · מונה מצטבר של תקלות שנראו ב-7 ימים, בעמוד המוגבל: ' + info.incidentEvents7d);
  lines.push('- חוות דעת ב-7 ימים: ' + info.feedback7d + ' · שלא נקראו: ' + info.feedbackUnread);
  lines.push('');
  lines.push('## גיבוי מנוהל של Firestore');
  lines.push('');
  if (info.backupsListing) {
    lines.push('```');
    lines.push(info.backupsListing.trim());
    lines.push('```');
  } else {
    lines.push('_`gcloud` לא נמצא במסלול, או שהפקודה נכשלה. לבדיקה ידנית: `gcloud firestore backups list --format="table(name, database, state)"`._');
  }
  lines.push('');
  lines.push('## לא נבדק כאן');
  lines.push('');
  lines.push('- `systemHealth` אינו כותב ל-Firestore (שולח דוא"ל בלבד) — אין לו רשומה לבדוק.');
  lines.push('- תורי הודעות (`schedule_outbox`, `guard_outbox`) — טרם הוגדר להם חוזה בריאות; יתווסף כשיוסכם.');
  lines.push('');
  return lines.join('\n');
}

function staleDays(iso, nowIso) {
  const a = new Date(String(iso).length === 10 ? iso + 'T00:00:00Z' : iso).getTime();
  const b = new Date(nowIso).getTime();
  return Number.isFinite(a) && Number.isFinite(b) ? Math.floor((b - a) / 86400000) : 999;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function writeIfChanged(file, content) {
  const next = content.replace(/\r?\n/g, '\n');
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').replace(/\r?\n/g, '\n') === next) return false;
  fs.writeFileSync(file, next, 'utf8');
  return true;
}

/* --- ריצה ---------------------------------------------------------- */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.dryRun) {
    console.log(JSON.stringify({ dryRun: true, project: args.project, station: args.station, output: args.out, maximumRowsPerCollection: 500, network: 'not contacted', writes: 'none' }));
    return;
  }
  const require = createRequire(path.join(HERE, 'functions', 'package.json'));
  const admin = require('firebase-admin');
  const { createIncidentLog } = require('./incident-log.js');
  const { createFeedback } = require('./feedback.js');

  if (!admin.apps.length) {
    admin.initializeApp({ projectId: args.project });
  }
  const db = admin.firestore();
  const FV = admin.firestore.FieldValue;
  class ToolError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const hash = (v) => sha256(String(v));
  const nowIso = new Date().toISOString();

  const incidents = createIncidentLog({ db, FieldValue: FV, HttpsError: ToolError, hash, clock: () => new Date().toISOString() });
  const feedback = createFeedback({ db, FieldValue: FV, HttpsError: ToolError, hash, clock: () => new Date().toISOString() });
  const sid = args.station;

  // פעולות טיפול קודם, כדי שהייצוא ישקף אותן.
  for (const [status, fp] of [['resolved', args.resolve], ['ignored', args.ignore], ['open', args.reopen]]) {
    if (!fp) continue;
    if (args.dryRun) { console.log('[dry-run] ' + status + ' ' + fp); continue; }
    const out = await incidents.setStatus({ sid, fingerprint: fp, status, by: args.by, note_code: args.note });
    console.log('incident ' + short(fp) + ' → ' + out.status + ' (' + args.by + ')');
  }

  const since = new Date(Date.now() - args.days * 86400000).toISOString();
  const allIncidents = await incidents.list({ sid, limit: args.incidentLimit });
  const incidentRows = allIncidents.filter((r) => r.status === 'open' || String(r.last_seen_iso || '') >= since);
  const feedbackRows = await feedback.list({ sid, limit: args.feedbackLimit });

  const stationRef = db.collection('stations').doc(sid);
  const lastSnapshot = await latestDoc(stationRef.collection('backups'), 'date');
  const lastScanRaw = await latestDoc(stationRef.collection('scans'), 'month');
  const lastScan = lastScanRaw ? Object.assign({}, lastScanRaw, { ran_at_iso: toIso(lastScanRaw.ran_at) }) : null;

  const week = new Date(Date.now() - 7 * 86400000).toISOString();
  const info = {
    lastSnapshot,
    lastScan,
    openIncidents: allIncidents.filter((r) => r.status === 'open').length,
    incidents7d: allIncidents.filter((r) => String(r.first_seen_iso || '') >= week).length,
    incidentEvents7d: allIncidents.filter((r) => String(r.last_seen_iso || '') >= week).reduce((s, r) => s + Number(r.count || 0), 0),
    feedback7d: feedbackRows.filter((r) => String(r.created_at_iso || '') >= week).length,
    feedbackUnread: feedbackRows.filter((r) => r.status === 'new').length,
    backupsListing: gcloudBackups(args.project)
  };

  const outDir = privateOutput(args.out);
  if (!args.dryRun) fs.mkdirSync(outDir, { recursive: true });
  const meta = { station: sid, now: nowIso, days: args.days };
  const files = [
    ['incidents.md', renderIncidents(incidentRows, meta)],
    ['feedback.md', renderFeedback(feedbackRows, meta)],
    ['health.md', renderHealth(info, meta)]
  ];
  for (const [name, content] of files) {
    if (args.dryRun) { console.log('[dry-run] ' + name + ' (' + content.length + ' תווים)'); continue; }
    const changed = writeIfChanged(privateOutput(path.join(outDir, name)), content);
    console.log((changed ? 'נכתב  ' : 'ללא שינוי ') + path.join(args.out, name));
  }

  if (args.markRead && !args.dryRun) {
    const ids = feedbackRows.filter((r) => r.status === 'new').map((r) => r.id);
    const out = await feedback.markRead({ sid, ids, by: args.by });
    console.log('feedback: ' + out.marked + ' סומנו כנקראו (' + args.by + ')');
  }
  console.log('סיכום: תקלות פתוחות ' + info.openIncidents + ' · חוות דעת שלא נקראו ' + info.feedbackUnread);
}

async function latestDoc(collection, key) {
  const snap = await collection.orderBy(key, 'desc').limit(1).get();
  let best = null;
  snap.docs.forEach((d) => {
    const data = d.data() || {};
    if (!best || String(data[key] || d.id) > String(best[key] || '')) best = Object.assign({ id: d.id }, data);
  });
  return best;
}

function toIso(value) {
  if (!value) return '';
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function gcloudBackups(project) {
  try {
    const bin = process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud';
    return execFileSync(bin, ['firestore', 'backups', 'list', '--project', project, '--format=table(name, database, state)'],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (ignore) {
    return null;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error('ops-export failed; check explicit target, arguments, permissions and private output path. Raw error details suppressed.');
    process.exit(1);
  });
}
