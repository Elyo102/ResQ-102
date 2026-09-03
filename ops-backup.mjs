#!/usr/bin/env node
/* ======================================================================
 * ops-backup — גיבוי מקומי של מה ש**אינו** ב-Firestore:
 *   1. הריפו כולו, כל הענפים והתגיות — `git bundle` (קובץ אחד, ניתן
 *      לשחזור ב-`git clone <bundle>`), מאומת ב-`git bundle verify`.
 *   2. תיקיות העבודה שאינן בקומיט — `_דיונים`, `_מסירה-*`, `_מסירות`,
 *      `_ניטור` — כ-zip.
 *   3. מניפסט `.md` עם SHA-256 של כל קובץ, ומחיקת גיבויים ישנים מעבר
 *      ל-`--keep` (ברירת מחדל 14).
 *
 * ⭐ מה שכן ב-Firestore (אנשים, סידורים, נוכחות) **אינו** כאן. לזה יש
 * גיבוי מנוהל של Firebase — ראה README-ניטור-וגיבוי.md. הסקריפט הזה
 * אינו נוגע בענן ואינו צריך הרשאות.
 *
 * ⭐ `_ניטור/feedback.md` מכיל מידע אישי. ה-zip נשאר על הדיסק של
 * אלדד בלבד (`_גיבוי/` ב-.gitignore); הוא לא נכנס לגיט ולא לאירוח
 * (`*.zip`, `*.bundle` ב-hosting.ignore).
 *
 * שימוש:  node ops-backup.mjs [--out _גיבוי] [--keep 14] [--dry-run]
 * ====================================================================== */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DOC_DIRS = Object.freeze(['_דיונים', '_מסירות', '_ניטור']);
export const DOC_DIR_PREFIXES = Object.freeze(['_מסירה-']);

export function parseArgs(argv) {
  const out = { out: '_גיבוי', keep: 14, dryRun: false };
  const list = Array.isArray(argv) ? argv.slice() : [];
  while (list.length) {
    const key = list.shift();
    const next = () => { const v = list.shift(); if (v === undefined) throw new Error('חסר ערך אחרי ' + key); return v; };
    switch (key) {
      case '--out': out.out = next(); break;
      case '--keep': out.keep = Number(next()); break;
      case '--dry-run': out.dryRun = true; break;
      default: throw new Error('פרמטר לא מוכר: ' + key);
    }
  }
  if (!Number.isInteger(out.keep) || out.keep < 1 || out.keep > 365) throw new Error('--keep חייב להיות 1..365');
  return out;
}

export function stamp(date) {
  const d = date instanceof Date ? date : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + '_' + p(d.getHours()) + p(d.getMinutes());
}

export function docDirsIn(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()
    && (DOC_DIRS.indexOf(e.name) !== -1 || DOC_DIR_PREFIXES.some((p) => e.name.startsWith(p))))
    .map((e) => e.name).sort();
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

/* מה מוחקים: קבצי גיבוי מעבר ל-`keep` הצעירים ביותר, לפי שם (החותמת
 * בשם היא כרונולוגית). מניפסטים נמחקים יחד עם הקובץ שלהם. */
export function pruneList(names, keep) {
  const groups = {};
  names.forEach((name) => {
    const m = name.match(/^resq-(\d{4}-\d{2}-\d{2}_\d{4})\./);
    if (!m) return;
    (groups[m[1]] = groups[m[1]] || []).push(name);
  });
  const stamps = Object.keys(groups).sort();
  const drop = stamps.slice(0, Math.max(0, stamps.length - keep));
  return drop.flatMap((s) => groups[s]).sort();
}

export function renderManifest(info) {
  const lines = [];
  lines.push('# גיבוי מקומי · ' + info.stamp);
  lines.push('');
  lines.push('נוצר: ' + info.now + ' · ריפו: `' + info.head + '` (' + info.branch + ')');
  lines.push('');
  lines.push('| קובץ | בייטים | SHA-256 |');
  lines.push('|---|---|---|');
  info.files.forEach((f) => lines.push('| `' + f.name + '` | ' + f.bytes + ' | `' + f.sha256 + '` |'));
  lines.push('');
  lines.push('## מה בפנים');
  lines.push('');
  lines.push('- `.bundle` — כל הענפים והתגיות. שחזור: `git clone resq-' + info.stamp + '.bundle ResQ-102-restored`');
  lines.push('- `.zip` — תיקיות: ' + info.docDirs.map((d) => '`' + d + '`').join(', ') + ' (⚠ `_ניטור/feedback.md` מכיל מידע אישי)');
  lines.push('');
  lines.push('## מה **לא** בפנים');
  lines.push('');
  lines.push('- נתוני Firestore (אנשים, סידורים, נוכחות). לזה: גיבוי מנוהל של Firebase — `gcloud firestore backups list`.');
  lines.push('- סודות. אין כאן ואסור שיהיו.');
  lines.push('');
  lines.push('נמחקו (מעבר ל-' + info.keep + '): ' + (info.pruned.length ? info.pruned.map((n) => '`' + n + '`').join(', ') : '—'));
  lines.push('');
  return lines.join('\n');
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function zipDirs(root, dirs, target) {
  if (process.platform === 'win32') {
    const paths = dirs.map((d) => path.join(root, d));
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Compress-Archive -LiteralPath ' + paths.map((p) => "'" + p.replace(/'/g, "''") + "'").join(',')
      + " -DestinationPath '" + target.replace(/'/g, "''") + "' -CompressionLevel Optimal -Force"],
    { encoding: 'utf8' });
    if (ps.status !== 0) throw new Error('Compress-Archive נכשל: ' + (ps.stderr || ps.stdout));
    return;
  }
  const r = spawnSync('zip', ['-r', '-q', target].concat(dirs), { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('zip נכשל: ' + (r.stderr || r.stdout));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = HERE;
  const outDir = path.isAbsolute(args.out) ? args.out : path.join(root, args.out);
  const now = new Date();
  const s = stamp(now);
  const head = git(['rev-parse', '--short', 'HEAD'], root);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const dirs = docDirsIn(root);
  const bundle = path.join(outDir, 'resq-' + s + '.bundle');
  const zip = path.join(outDir, 'resq-' + s + '.zip');
  const manifest = path.join(outDir, 'resq-' + s + '.md');

  if (args.dryRun) {
    console.log('[dry-run] bundle → ' + bundle);
    console.log('[dry-run] zip    → ' + zip + ' (' + dirs.join(', ') + ')');
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  git(['bundle', 'create', bundle, '--all'], root);
  git(['bundle', 'verify', bundle], root);
  zipDirs(root, dirs, zip);

  const files = [bundle, zip].map((file) => ({
    name: path.basename(file), bytes: fs.statSync(file).size, sha256: sha256File(file)
  }));
  const existing = fs.readdirSync(outDir).filter((n) => n.startsWith('resq-'));
  const pruned = pruneList(existing.filter((n) => !n.startsWith('resq-' + s + '.')), args.keep - 1);
  pruned.forEach((n) => fs.unlinkSync(path.join(outDir, n)));
  fs.writeFileSync(manifest, renderManifest({
    stamp: s, now: now.toISOString(), head, branch, files, docDirs: dirs, keep: args.keep, pruned
  }), 'utf8');
  files.forEach((f) => console.log(f.sha256 + '  ' + f.name + '  ' + f.bytes));
  console.log('מניפסט: ' + path.relative(root, manifest) + (pruned.length ? ' · נמחקו ' + pruned.length : ''));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error('ops-backup נכשל: ' + (error && error.message ? error.message : error));
    process.exit(1);
  });
}
