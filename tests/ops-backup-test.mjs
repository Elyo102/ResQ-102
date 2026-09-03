import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runBackup, parseArgs } from '../ops-backup.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-backup-test-'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let passed = 0;
function check(name, fn) { fn(); console.log('PASS ' + name); passed++; }
try {
  git('init'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Backup Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, '.gitignore'), '_גיבוי/\n_ניטור/\n_מסירות/\n_דיונים/\n');
  fs.writeFileSync(path.join(root, 'source.js'), 'export const marker = 42;\n');
  git('add', '.'); git('commit', '-m', 'fixture');
  fs.mkdirSync(path.join(root, '_ניטור')); fs.writeFileSync(path.join(root, '_ניטור', 'feedback.md'), 'Private fixture שלום');
  const args = parseArgs(['--keep', '2']);
  const run = options => runBackup(args, { root, ...options });
  check('dry-run writes nothing', () => { assert.equal(runBackup({ ...args, dryRun: true }, { root }).documents, 1); assert.equal(fs.existsSync(path.join(root, '_גיבוי')), false); });
  let first;
  check('real archive and verified bundle', () => {
    first = run();
    assert.ok(fs.existsSync(path.join(first.destination, 'documents.zip')));
    const manifest = JSON.parse(fs.readFileSync(path.join(first.destination, 'manifest.json')));
    assert.equal(manifest.state, 'complete'); assert.equal(manifest.files.length, 3);
    git('bundle', 'verify', path.join(first.destination, 'repository.bundle'));
  });
  let second;
  check('same-minute unique sets', () => { second = run(); assert.notEqual(first.id, second.id); assert.ok(fs.existsSync(first.destination)); });
  check('each staged failure preserves completed backups', () => {
    for (const stage of ['bundle', 'archive', 'manifest', 'published']) {
      assert.throws(() => run({ checkpoint: point => { if (point === stage) throw new Error('injected-' + stage); } }), new RegExp('injected-' + stage));
      assert.ok(fs.existsSync(first.destination)); assert.ok(fs.existsSync(second.destination));
      assert.equal(fs.existsSync(path.join(root, '_גיבוי', '.resq-backup.lock')), false);
    }
  });
  check('concurrent lock rejects without modifying sets', () => {
    const lock = path.join(root, '_גיבוי', '.resq-backup.lock'); fs.writeFileSync(lock, 'other');
    try { assert.throws(() => run(), /EEXIST/); assert.equal(fs.readFileSync(lock, 'utf8'), 'other'); } finally { fs.unlinkSync(lock); }
  });
  check('corruption after archive creation cannot publish or prune', () => {
    for (const name of ['repository.bundle', 'documents.zip']) {
      assert.throws(() => run({ checkpoint: (point, stage) => { if (point === 'archive') fs.writeFileSync(path.join(stage, name), 'corrupt'); } }));
      assert.ok(fs.existsSync(first.destination)); assert.ok(fs.existsSync(second.destination));
    }
  });
  check('dirty tracked file is blocked', () => {
    fs.writeFileSync(path.join(root, 'source.js'), 'changed');
    assert.throws(() => run(), /clean/);
    fs.writeFileSync(path.join(root, 'source.js'), 'export const marker = 42;\n');
  });
  check('untracked source is blocked', () => {
    fs.writeFileSync(path.join(root, 'new.js'), 'new'); assert.throws(() => run(), /clean/); fs.unlinkSync(path.join(root, 'new.js'));
  });
  check('source changing during backup is rejected before retention', () => {
    const document = path.join(root, '_ניטור', 'feedback.md'); const original = fs.readFileSync(document);
    try { assert.throws(() => run({ checkpoint: point => { if (point === 'archive') fs.writeFileSync(document, 'modified'); } }), /Source changed/); }
    finally { fs.writeFileSync(document, original); }
    assert.ok(fs.existsSync(first.destination));
  });
  check('path escapes and document destinations rejected', () => {
    assert.throws(() => runBackup({ ...args, out: '..' }, { root }), /inside/);
    assert.throws(() => runBackup({ ...args, out: '_ניטור/nested' }, { root }), /Unsafe/);
    assert.throws(() => runBackup({ ...args, out: 'public-backups' }, { root }), /Unsafe/);
  });
  check('junction/symlink inputs rejected', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-backup-outside-'));
    const link = path.join(root, '_מסירות');
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      assert.throws(() => run(), /Links/);
    } finally { if (fs.existsSync(link)) fs.unlinkSync(link); fs.rmdirSync(outside); }
  });
  check('retention leaves unknown, corrupt and legacy artifacts untouched', () => {
    const out = path.join(root, '_גיבוי');
    fs.writeFileSync(path.join(out, 'old.bundle'), 'legacy');
    fs.writeFileSync(path.join(first.destination, 'manifest.json'), '{}');
    const latest = runBackup({ ...args, keep: 1 }, { root });
    assert.ok(fs.existsSync(first.destination)); assert.ok(fs.existsSync(path.join(out, 'old.bundle')));
    assert.equal(fs.existsSync(second.destination), false); assert.ok(fs.existsSync(latest.destination));
    const restored = path.join(root, '_גיבוי', 'restore-fixture');
    execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', path.join(latest.destination, 'repository.bundle'), restored], { stdio: 'pipe', windowsHide: true });
    assert.equal(fs.readFileSync(path.join(restored, 'source.js'), 'utf8'), 'export const marker = 42;\n');
  });
  check('valid stale bundle cannot claim the new commit', () => {
    const oldBundle = path.join(root, '_גיבוי', 'valid-old.bundle');
    git('bundle', 'create', oldBundle, '--all');
    git('commit', '--allow-empty', '-m', 'newer commit');
    assert.throws(() => run({ checkpoint: (point, stage) => { if (point === 'archive') fs.copyFileSync(oldBundle, path.join(stage, 'repository.bundle')); } }), /refs changed|do not match/);
  });
  console.log(`ops-backup: ${passed}/${passed} PASS (real temporary Git bundle and ZIP; no production data)`);
} finally {
  if (path.dirname(root) !== fs.realpathSync(os.tmpdir()) || !path.basename(root).startsWith('resq-backup-test-')) throw new Error('Unsafe fixture cleanup');
  fs.rmSync(root, { recursive: true, force: true });
}
