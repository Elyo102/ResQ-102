// ============================================================
//  בדיקה אמיתית לתרגיל השחזור — 42H.20 Scope 11 (closure batch item 8)
// ============================================================
//  בניגוד לרוב הבדיקות שנוספו לחבילת הסגירה הזו, הבדיקה הזו רצה
//  בפועל בכל סביבה (Windows וגם Linux): git ו-unzip/PowerShell הם
//  התלות היחידה, ואין כאן שום אמולטור Firestore.
//
//  יוצרת גיבוי אמיתי (runBackup, אותו קוד ש-ops-backup-test.mjs
//  כבר משתמש בו) בתוך מאגר Git זמני, ואז מריצה את tarRestoreDrill
//  האמיתי נגדו — לא הדמיה של שחזור, שחזור אמיתי לתיקייה זמנית
//  נפרדת עם git clone אמיתי ו-unzip אמיתי.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runBackup, parseArgs as parseBackupArgs } from '../ops-backup.mjs';
import { runRestoreDrill, parseArgs as parseDrillArgs } from '../ops-restore-drill.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-restore-drill-test-'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let passed = 0;
function check(name, fn) { fn(); console.log('PASS ' + name); passed++; }

try {
  git('init'); git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Restore Drill Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, '.gitignore'), '_גיבוי/\n_ניטור/\n_מסירות\n_דיונים/\n');
  fs.writeFileSync(path.join(root, 'source.js'), 'export const marker = "restore-drill-fixture";\n');
  git('add', '.'); git('commit', '-m', 'fixture');
  fs.mkdirSync(path.join(root, '_ניטור'));
  fs.writeFileSync(path.join(root, '_ניטור', 'feedback.md'), 'Private restore-drill fixture תוכן');
  fs.writeFileSync(path.join(root, '_ניטור', 'second.md'), 'שני קבצים, לא רק אחד, כדי שספירת המסמכים תיבדק גם היא');

  const backupArgs = parseBackupArgs(['--keep', '5']);
  const backup = runBackup(backupArgs, { root });

  let result;
  check('a verified backup restores cleanly into a fresh, separate directory', () => {
    result = runRestoreDrill(parseDrillArgs([]), { root });
    assert.equal(result.ok, true);
    assert.equal(result.set, backup.id);
    assert.equal(result.documents_restored, true);
    // repository.bundle (1) + two documents = 3
    assert.equal(result.files_verified, 3, 'both fixture documents plus the bundle must be individually verified');
  });

  check('the drill leaves no restored copy behind afterward', () => {
    const leftover = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('resq-restore-drill-run-'));
    assert.equal(leftover.length, 0, 'a non-production drill must never leave a live clone on disk: ' + JSON.stringify(leftover));
  });

  check('an explicit --set that matches the real backup still restores', () => {
    const again = runRestoreDrill(parseDrillArgs(['--set', backup.id]), { root });
    assert.equal(again.ok, true);
    assert.equal(again.set, backup.id);
  });

  check('a nonexistent --set fails closed, not silently', () => {
    assert.throws(() => runRestoreDrill(parseDrillArgs(['--set', 'resq-20990101T000000000Z-0000000000000000']), { root }),
      /failed manifest\/signature verification/);
  });

  check('a tampered manifest signature is refused, not restored anyway', () => {
    const manifestPath = path.join(root, '_גיבוי', backup.id, 'manifest.json');
    const original = fs.readFileSync(manifestPath, 'utf8');
    const tampered = JSON.parse(original);
    // Flip one byte-count so the SHA-256/byte check inside completedSet fails -
    // this must be caught before any git clone or unzip is attempted.
    tampered.files = tampered.files.map(f => f.name === 'repository.bundle' ? { ...f, bytes: f.bytes + 1 } : f);
    fs.writeFileSync(manifestPath, JSON.stringify(tampered, null, 2));
    try {
      assert.throws(() => runRestoreDrill(parseDrillArgs([]), { root }), /No verified backup set found/);
    } finally {
      fs.writeFileSync(manifestPath, original);
    }
  });

  check('a corrupted repository.bundle on disk is refused before any clone is attempted', () => {
    const bundlePath = path.join(root, '_גיבוי', backup.id, 'repository.bundle');
    const original = fs.readFileSync(bundlePath);
    fs.writeFileSync(bundlePath, Buffer.from('not actually a git bundle'));
    try {
      assert.throws(() => runRestoreDrill(parseDrillArgs([]), { root }), /No verified backup set found/);
    } finally {
      fs.writeFileSync(bundlePath, original);
    }
  });

  check('an empty backup directory fails closed with a clear message, not a crash', () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-restore-drill-empty-'));
    try {
      assert.throws(() => runRestoreDrill(parseDrillArgs([]), { root: emptyRoot }), /No backup directory found/);
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  check('after a real restore, the original backup set and live fixture tree are untouched', () => {
    assert.ok(fs.existsSync(path.join(root, '_גיבוי', backup.id, 'manifest.json')));
    assert.equal(fs.readFileSync(path.join(root, 'source.js'), 'utf8'), 'export const marker = "restore-drill-fixture";\n');
    assert.equal(git('status', '--porcelain').trim(), '', 'the drill must never modify the live working tree it read the backup from');
  });

  console.log(`ops-restore-drill: ${passed}/${passed} PASS (real git clone + real unzip extraction, no production data)`);
} finally {
  if (path.dirname(root) !== fs.realpathSync(os.tmpdir()) || !path.basename(root).startsWith('resq-restore-drill-test-')) {
    throw new Error('Unsafe fixture cleanup');
  }
  fs.rmSync(root, { recursive: true, force: true });
}
