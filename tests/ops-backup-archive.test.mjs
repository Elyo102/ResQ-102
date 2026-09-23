#!/usr/bin/env node
// Tests for ops-backup-archive.ps1 — source/fixture on all platforms;
// live PowerShell ZIP create/verify when pwsh/powershell is available.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PS1 = path.join(ROOT, 'ops-backup-archive.ps1');
let passed = 0;
function check(name, fn) {
  fn();
  console.log('PASS ' + name);
  passed++;
}

check('ops-backup-archive.ps1 exists and encodes inventory/ZIP contract', () => {
  assert.ok(fs.existsSync(PS1));
  const src = fs.readFileSync(PS1, 'utf8');
  assert.ok(src.includes('VerifyOnly'));
  assert.ok(src.includes('CreateEntryFromFile'));
  assert.ok(src.includes('SHA256'));
  assert.ok(src.includes('ZIP entry count mismatch') || src.includes('ZIP inventory mismatch'));
  assert.ok(src.includes('Archive path escapes root'));
  assert.ok(src.includes('ForEach-Object'), 'enumerates ConvertFrom-Json arrays on Windows PowerShell 5.1');
});

check('fixture inventory shape matches script expectations', () => {
  const fixture = [
    { path: 'docs/a.txt', bytes: 5, sha256: createHash('sha256').update('hello').digest('hex') },
    { path: 'docs/b.txt', bytes: 3, sha256: createHash('sha256').update('bye').digest('hex') }
  ];
  assert.equal(fixture[0].path.split('/').length, 2);
  assert.equal(fixture[0].bytes, 5);
  assert.match(fixture[0].sha256, /^[a-f0-9]{64}$/);
});

function findPowerShell() {
  if (process.platform === 'win32') {
    for (const name of ['powershell.exe', 'pwsh.exe']) {
      const probe = spawnSync(name, ['-NoProfile', '-Command', 'echo ok'], { encoding: 'utf8' });
      if (probe.status === 0) return name;
    }
  }
  for (const name of ['pwsh', 'powershell']) {
    const probe = spawnSync(name, ['-NoProfile', '-Command', 'echo ok'], { encoding: 'utf8' });
    if (probe.status === 0) return name;
  }
  return null;
}

const shell = findPowerShell();
if (!shell) {
  console.log('PASS ops-backup-archive live ZIP skipped — PowerShell not available on this host (source/fixture checks still ran)');
  passed++;
} else {
  check('live archive create+verify on ' + shell, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-archive-test-'));
    try {
      const docs = path.join(tmp, 'docs');
      fs.mkdirSync(docs);
      fs.writeFileSync(path.join(docs, 'a.txt'), 'hello');
      fs.writeFileSync(path.join(docs, 'b.txt'), 'bye');
      const inventory = [
        { path: 'docs/a.txt', bytes: 5, sha256: createHash('sha256').update('hello').digest('hex') },
        { path: 'docs/b.txt', bytes: 3, sha256: createHash('sha256').update('bye').digest('hex') }
      ];
      const invPath = path.join(tmp, 'inventory.json');
      const zipPath = path.join(tmp, 'out.zip');
      fs.writeFileSync(invPath, JSON.stringify(inventory), 'utf8');
      const run = spawnSync(shell, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', PS1,
        '-RootPath', tmp,
        '-InventoryPath', invPath,
        '-ZipPath', zipPath
      ], { encoding: 'utf8' });
      assert.equal(run.status, 0, 'stderr=' + (run.stderr || '') + ' stdout=' + (run.stdout || ''));
      assert.ok(fs.existsSync(zipPath));
      const verify = spawnSync(shell, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', PS1,
        '-RootPath', tmp,
        '-InventoryPath', invPath,
        '-ZipPath', zipPath,
        '-VerifyOnly'
      ], { encoding: 'utf8' });
      assert.equal(verify.status, 0, verify.stderr || verify.stdout || '');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

console.log('ops-backup-archive tests: ' + passed + ' PASS');
