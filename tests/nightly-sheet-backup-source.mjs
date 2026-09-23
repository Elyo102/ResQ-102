#!/usr/bin/env node
// Source contract: nightlySheetBackup / backupToSheetNow stay fail-closed when
// BACKUP_SHEET_ID is empty — must not report success / skipped-as-ok.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');

const start = src.indexOf('const BACKUP_SHEET_ID');
assert.ok(start > 0, 'BACKUP_SHEET_ID declaration present');
const snip = src.slice(start, start + 8000);

assert.match(snip, /const BACKUP_SHEET_ID = '';/);
assert.ok(snip.includes('runSheetBackup_'), 'runSheetBackup_ present');
assert.ok(snip.includes('nightlySheetBackup'), 'nightlySheetBackup export present');
assert.ok(snip.includes('backupToSheetNow'), 'backupToSheetNow export present');

// Fail-closed: empty id must not return ok:true / success path.
assert.ok(
  /BACKUP_SHEET_ID\)[\s\S]{0,400}ok:\s*false/.test(snip)
    || /if \(!BACKUP_SHEET_ID\)[\s\S]{0,500}retired/.test(snip),
  'empty BACKUP_SHEET_ID must fail-closed (ok:false and/or retired)'
);
assert.equal(/if \(!BACKUP_SHEET_ID\)[\s\S]{0,200}skipped:\s*true/.test(snip), false,
  'must not treat empty BACKUP_SHEET_ID as skipped success');

// Do not recommend Compute Engine default account as access recipient.
assert.equal(snip.includes('compute@developer.gserviceaccount.com'), false,
  'must not document Compute Engine default SA as sheet access recipient');

// Do not claim PITR/scheduled backups are already active inside this helper.
assert.equal(/PITR[\s\S]{0,80}(מופעל|active|already)/i.test(snip), false);

console.log('PASS nightly-sheet-backup-source fail-closed contracts');
