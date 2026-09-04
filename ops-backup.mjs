import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SET = /^resq-\d{8}T\d{9}Z-[a-f0-9]{16}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const relative = (root, target) => {
  const rel = path.relative(root, target);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Path must remain inside root');
  return rel;
};
function noLinks(root, target) {
  let current = root;
  for (const part of relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Links are not accepted');
  }
}
export function parseArgs(argv) {
  const args = { out: '_גיבוי', keep: 14, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (argv[i] === '--keep' && argv[i + 1]) args.keep = Number(argv[++i]);
    else throw new Error('Unknown or incomplete argument: ' + argv[i]);
  }
  if (!Number.isInteger(args.keep) || args.keep < 1 || args.keep > 365) throw new Error('keep must be 1..365');
  return args;
}
function inventory(root) {
  const result = [];
  function visit(full) {
    noLinks(root, full);
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) for (const name of fs.readdirSync(full).sort()) visit(path.join(full, name));
    else if (stat.isFile()) {
      const name = relative(root, full).split(path.sep).join('/');
      if (/[\r\n\0]/.test(name)) throw new Error('Unsupported filename');
      const bytes = fs.readFileSync(full);
      result.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
    } else throw new Error('Special files are not accepted');
  }
  for (const name of fs.readdirSync(root).sort()) {
    if (['_דיונים', '_מסירות', '_ניטור'].includes(name) || name.startsWith('_מסירה-')) visit(path.join(root, name));
  }
  return result;
}
const durable = (file, text) => {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
export function renderManifest(manifest) {
  return `# Private local backup\n\nID: ${manifest.id}\nCommit: ${manifest.head}\nCreated: ${manifest.created_at}\n\nContains private documents and Git history, potentially including secrets. Do not publish.\n`;
}
function completedSet(root, out, name) {
  try {
    if (!SET.test(name)) return null;
    const dir = path.join(out, name);
    noLinks(root, dir);
    if (!fs.lstatSync(dir).isDirectory()) return null;
    for (const entry of fs.readdirSync(dir)) {
      const stat = fs.lstatSync(path.join(dir, entry));
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
    }
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (m.schema !== 'resq-local-backup-v2' || m.state !== 'complete' || m.id !== name || !Array.isArray(m.files)) return null;
    const names = m.files.map(f => f.name);
    if (new Set(names).size !== names.length || !names.includes('repository.bundle') || !names.includes('inventory.json')) return null;
    if (names.some(n => !['repository.bundle', 'inventory.json', 'documents.zip'].includes(n))) return null;
    if (JSON.stringify(fs.readdirSync(dir).sort()) !== JSON.stringify([...names, 'manifest.json', 'manifest.md'].sort())) return null;
    if (!Number.isFinite(Date.parse(m.created_at))) return null;
    for (const f of m.files) {
      const bytes = fs.readFileSync(path.join(dir, f.name));
      if (f.bytes !== bytes.length || f.sha256 !== hash(bytes)) return null;
    }
    return { dir, manifest: m };
  } catch { return null; }
}
function archive(root, stage, entries, verifyOnly = false) {
  if (!entries.length) return;
  const zip = path.join(stage, 'documents.zip');
  const opts = { cwd: root, timeout: 120000, maxBuffer: 128 * 1024 * 1024, windowsHide: true };
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(HERE, 'ops-backup-archive.ps1'), '-RootPath', root, '-InventoryPath', path.join(stage, 'inventory.json'), '-ZipPath', zip, ...(verifyOnly ? ['-VerifyOnly'] : [])], opts);
  } else {
    if (!verifyOnly) execFileSync('zip', ['-q', zip, '-@'], { ...opts, input: entries.map(e => e.path).join('\n') + '\n' });
    execFileSync('unzip', ['-t', zip], opts);
    const names = execFileSync('unzip', ['-Z1', zip], opts).toString().trim().split('\n').sort();
    if (JSON.stringify(names) !== JSON.stringify(entries.map(e => e.path).sort())) throw new Error('ZIP inventory mismatch');
    for (const e of entries) {
      const bytes = execFileSync('unzip', ['-p', zip, e.path], opts);
      if (bytes.length !== e.bytes || hash(bytes) !== e.sha256) throw new Error('ZIP content mismatch');
    }
  }
}
export function runBackup(args, options = {}) {
  if (!Number.isInteger(args.keep) || args.keep < 1 || args.keep > 365) throw new Error('keep must be 1..365');
  const root = fs.realpathSync(options.root || HERE);
  const out = path.resolve(root, args.out);
  noLinks(root, out);
  const first = relative(root, out).split(path.sep)[0];
  if (first !== '_גיבוי') throw new Error('Unsafe backup destination: use private _גיבוי subtree');
  const git = (...command) => execFileSync('git', command, { cwd: root, encoding: 'utf8', timeout: 120000, windowsHide: true });
  const normalizedRefs = text => text.trim().split(/\r?\n/).sort().join('\n');
  const clean = () => { if (git('status', '--porcelain', '--untracked-files=all').trim()) throw new Error('Working tree must be clean'); };
  // קישורים נבדקים לפני ניקיון העץ: ב-Linux קישור סימבולי נראה לגיט
  // כקובץ לא-מעוקב, והסירוב היה יוצא בהודעה הלא נכונה.
  const entries = inventory(root);
  clean();
  const head = git('rev-parse', 'HEAD').trim();
  const refs = normalizedRefs(git('show-ref', '--head'));
  if (args.dryRun) return { dryRun: true, destination: out, documents: entries.length, head };
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  noLinks(root, out);
  const lock = path.join(out, '.resq-backup.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  try {
    const created = new Date().toISOString();
    const id = `resq-${created.replace(/[-:.]/g, '')}-${randomBytes(8).toString('hex')}`;
    const stage = path.join(out, '.stage-' + id);
    const destination = path.join(out, id);
    fs.mkdirSync(stage, { mode: 0o700 });
    git('bundle', 'create', path.join(stage, 'repository.bundle'), '--all');
    git('bundle', 'verify', path.join(stage, 'repository.bundle'));
    options.checkpoint?.('bundle', stage);
    durable(path.join(stage, 'inventory.json'), JSON.stringify(entries, null, 2));
    archive(root, stage, entries);
    options.checkpoint?.('archive', stage);
    clean();
    if (git('rev-parse', 'HEAD').trim() !== head || JSON.stringify(inventory(root)) !== JSON.stringify(entries)) throw new Error('Source changed during backup');
    git('bundle', 'verify', path.join(stage, 'repository.bundle'));
    archive(root, stage, entries, true);
    if (normalizedRefs(git('bundle', 'list-heads', path.join(stage, 'repository.bundle'))) !== refs || normalizedRefs(git('show-ref', '--head')) !== refs) throw new Error('Backup refs changed or do not match captured source');
    const verification = path.join(stage, '.verify');
    git('clone', '--bare', path.join(stage, 'repository.bundle'), verification);
    git('--git-dir=' + verification, 'fsck', '--full', '--strict');
    relative(stage, verification);
    noLinks(root, verification);
    fs.rmSync(verification, { recursive: true });
    const names = ['repository.bundle', 'inventory.json', ...(entries.length ? ['documents.zip'] : [])];
    const manifest = { schema: 'resq-local-backup-v2', state: 'complete', id, head, created_at: created, files: names.map(name => {
      const dataFd = fs.openSync(path.join(stage, name), 'r+');
      try { fs.fsyncSync(dataFd); } finally { fs.closeSync(dataFd); }
      const bytes = fs.readFileSync(path.join(stage, name));
      return { name, bytes: bytes.length, sha256: hash(bytes) };
    }) };
    durable(path.join(stage, 'manifest.md'), renderManifest(manifest));
    durable(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
    options.checkpoint?.('manifest', stage);
    fs.renameSync(stage, destination);
    if (!completedSet(root, out, id)) throw new Error('Completed backup failed verification');
    options.checkpoint?.('published', destination);
    const older = fs.readdirSync(out).filter(n => n !== id).map(n => completedSet(root, out, n)).filter(Boolean).sort((a, b) => b.manifest.created_at.localeCompare(a.manifest.created_at));
    const pruned = [];
    for (const candidate of older.slice(args.keep - 1)) {
      const verified = completedSet(root, out, candidate.manifest.id);
      if (!verified) continue;
      for (const name of [...verified.manifest.files.map(f => f.name), 'manifest.md', 'manifest.json']) {
        noLinks(root, path.join(verified.dir, name));
        fs.unlinkSync(path.join(verified.dir, name));
      }
      fs.rmdirSync(verified.dir);
      pruned.push(candidate.manifest.id);
    }
    return { id, destination, pruned };
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(runBackup(parseArgs(process.argv.slice(2))))); }
  catch (error) { console.error('Backup failed:', error.message); process.exitCode = 1; }
}
