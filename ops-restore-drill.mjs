// ============================================================
//  תרגיל שחזור לגיבוי מקומי — 42H.20 Scope 11 (closure batch item 8)
// ============================================================
//
//  README-ניטור-וגיבוי.md §4 תיאר את נוהל השחזור במילים: "מאמתים
//  מניפסט וחתימות, ואז משכפלים מתוך repository.bundle ומחלצים
//  מסמכים בלי לדרוס סביבת עבודה קיימת." עד לקובץ הזה זו הייתה
//  פרוזה בלבד — לא הייתה לה פקודה מריצה. ops-backup-test.mjs עצמו
//  כלל בדיקה אחת שמשכפלת bundle (git clone) בתוך הבדיקה, אבל בלי
//  אימות מניפסט/חתימות לפני השכפול ובלי לחלץ בכלל את documents.zip.
//
//  התרגיל הזה הוא הפקודה המריצה: הוא מאמת חבילת גיבוי שלמה
//  (אותה בדיקת completedSet ש-ops-backup.mjs עצמו סומך עליה לפני
//  שהוא מפרסם או מוחק סט — לא עותק שני שעלול להיסחף), ואז משחזר
//  בפועל, בתיקייה זמנית טרייה מחוץ לעץ העבודה לגמרי, ומוודא תוכן:
//  ה-commit שהתקבל תואם למניפסט, git fsck עובר, וכל קובץ שחולץ
//  מ-documents.zip תואם בדיוק לגודל ול-SHA-256 שנרשמו בזמן הגיבוי.
//
//  לא production. שום דבר כאן לא נוגע ב-Firestore, ב-Auth או בעץ
//  העבודה האמיתי — רק בסט גיבוי קיים שכבר נכתב לדיסק, וקורא ממנו
//  בלבד. התיקייה הזמנית נמחקת תמיד בסיום, הצלחה או כישלון, כדי
//  שתרגיל שחזור לא ישאיר עותקים פזורים של קוד/מסמכים פרטיים.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { completedSet, SET } from './ops-backup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function parseArgs(argv) {
  const args = { out: '_גיבוי', set: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (argv[i] === '--set' && argv[i + 1]) args.set = argv[++i];
    else throw new Error('Unknown or incomplete argument: ' + argv[i]);
  }
  return args;
}

// בוחר את הסט שיש לשחזר: אם נמסר --set, רק הוא נבדק (ונכשל סגור אם
// אינו שלם/מאומת). אחרת, כל הסטים בתיקיית הגיבוי נבדקים ומוחזר
// המאומת המאוחר ביותר. סט שאינו עובר completedSet (מניפסט חסר,
// חתימה לא תואמת, קובץ חסר) נחשב כלא קיים — לעולם לא משוחזר.
function selectVerifiedSet(root, out, requestedId) {
  if (requestedId) {
    const found = completedSet(root, out, requestedId);
    if (!found) throw new Error('Requested backup set failed manifest/signature verification: ' + requestedId);
    return found;
  }
  if (!fs.existsSync(out)) throw new Error('No backup directory found: ' + out);
  const candidates = fs.readdirSync(out)
    .filter(name => SET.test(name))
    .map(name => completedSet(root, out, name))
    .filter(Boolean)
    .sort((a, b) => b.manifest.created_at.localeCompare(a.manifest.created_at));
  if (!candidates.length) throw new Error('No verified backup set found under ' + out);
  return candidates[0];
}

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      'Expand-Archive -LiteralPath ' + JSON.stringify(zipPath) + ' -DestinationPath ' + JSON.stringify(destDir) + ' -Force'
    ], { windowsHide: true, stdio: 'pipe' });
  } else {
    execFileSync('unzip', ['-q', zipPath, '-d', destDir], { stdio: 'pipe' });
  }
}

// המשחזר עצמו. אף פעם לא נוגע בעץ העבודה האמיתי או בסט הגיבוי
// עצמו (קורא ממנו בלבד) — כל הפעולה קורית בתוך תיקייה זמנית טרייה
// מתחת ל-os.tmpdir(), שנמחקת בסיום תמיד, גם בכישלון.
export function runRestoreDrill(args, options = {}) {
  const root = options.root || process.cwd();
  const out = path.join(root, args.out);
  const verified = selectVerifiedSet(root, out, args.set);
  const manifest = verified.manifest;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-restore-drill-run-'));
  try {
    const repoDir = path.join(tmp, 'repo');
    execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '--quiet',
      path.join(verified.dir, 'repository.bundle'), repoDir], { stdio: 'pipe', windowsHide: true });
    const restoredHead = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (restoredHead !== manifest.head) {
      throw new Error('Restored HEAD (' + restoredHead + ') does not match the backed-up commit (' + manifest.head + ')');
    }
    execFileSync('git', ['-C', repoDir, 'fsck', '--full', '--strict'], { stdio: 'pipe' });

    let filesVerified = 1; // repository.bundle content already re-verified above via HEAD + fsck
    const zipEntry = manifest.files.find(f => f.name === 'documents.zip');
    if (zipEntry) {
      const inventory = JSON.parse(fs.readFileSync(path.join(verified.dir, 'inventory.json'), 'utf8'));
      const docsDir = path.join(tmp, 'documents');
      extractZip(path.join(verified.dir, 'documents.zip'), docsDir);
      for (const entry of inventory) {
        const restoredPath = path.join(docsDir, ...entry.path.split('/'));
        if (!fs.existsSync(restoredPath)) throw new Error('Restored documents are missing an expected file: ' + entry.path);
        const bytes = fs.readFileSync(restoredPath);
        if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) {
          throw new Error('Restored document content does not match the backed-up signature: ' + entry.path);
        }
        filesVerified += 1;
      }
      const restoredNames = new Set();
      (function walk(dir, prefix) {
        for (const name of fs.readdirSync(dir)) {
          const full = path.join(dir, name);
          const rel = prefix ? prefix + '/' + name : name;
          if (fs.lstatSync(full).isDirectory()) walk(full, rel);
          else restoredNames.add(rel);
        }
      })(docsDir, '');
      if (restoredNames.size !== inventory.length) {
        throw new Error('Restored document count (' + restoredNames.size + ') does not match the backed-up inventory (' + inventory.length + ')');
      }
    }

    return {
      ok: true, set: manifest.id, head: manifest.head,
      created_at: manifest.created_at, files_verified: filesVerified,
      documents_restored: !!zipEntry
    };
  } finally {
    // תמיד מנקים — תרגיל שחזור לא production ולא אמור להשאיר עותק
    // חי של קוד/מסמכים פרטיים בדיסק אחרי שסיים.
    if (path.dirname(tmp) !== fs.realpathSync(os.tmpdir()) || !path.basename(tmp).startsWith('resq-restore-drill-run-')) {
      throw new Error('Refusing to clean up an unexpected path: ' + tmp);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runRestoreDrill(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
    console.log('Restore drill PASSED: set ' + result.set + ', head ' + result.head +
      ', ' + result.files_verified + ' file(s) verified byte-for-byte against the backup manifest.');
  } catch (error) {
    console.error('Restore drill FAILED:', error.message);
    process.exitCode = 1;
  }
}
