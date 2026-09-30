'use strict';
// Loaded after the network guard. This is a closed fixture read boundary, not
// an OS sandbox for hostile code. All support modules are loaded before hooks.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { registerHooks, builtinModules, syncBuiltinESMExports } = require('node:module');
const originalRead = fs.readFileSync.bind(fs);
const originalRealpath = fs.realpathSync.bind(fs);
const originalLstat = fs.lstatSync.bind(fs);
const originalOpen = fs.openSync.bind(fs);
const originalClose = fs.closeSync.bind(fs);
const originalFdRead = fs.readSync.bind(fs);
const originalFdWrite = fs.writeSync.bind(fs);
// Hash reads never call the subsequently wrapped public fs methods.
function rawRead(name) {
  const fd = originalOpen(name, 'r'), chunks = [];
  try { for (;;) { const chunk = Buffer.alloc(65536), count = originalFdRead(fd, chunk, 0, chunk.length, null); if (!count) break; chunks.push(chunk.subarray(0,count)); } }
  finally { originalClose(fd); }
  return Buffer.concat(chunks);
}
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let violated = false;
function deny() {
  violated = true; process.exitCode = 1;
  process.stdout.write('RESQ_MUTATION_READ_DENIED\n');
  throw Object.assign(new Error('MUTATION_READ_BOUNDARY'), { code: 'MUTATION_READ_BOUNDARY' });
}
function exactFile(value) {
  const name = value instanceof URL ? fileURLToPath(value) : value;
  if (typeof name !== 'string') return deny();
  const absolute = path.resolve(name);
  let real;
  try { real = originalRealpath(absolute); } catch { return deny(); }
  const normalized = process.platform === 'win32' ? text => text.toLowerCase() : text => text;
  if (normalized(real) !== normalized(absolute) || originalLstat(absolute).isSymbolicLink()) return deny();
  return real;
}
const capabilityPath = exactFile(process.env.RESQ_MUTATION_READ_CAPABILITY);
const capabilityBytes = originalRead(capabilityPath);
if (!/^[a-f0-9]{64}$/.test(process.env.RESQ_MUTATION_READ_CAPABILITY_SHA || '')
    || digest(capabilityBytes) !== process.env.RESQ_MUTATION_READ_CAPABILITY_SHA) deny();
const capability = JSON.parse(capabilityBytes);
if (Object.keys(capability).sort().join(',') !== 'entry,files,root,version' || capability.version !== 1
    || !Array.isArray(capability.files) || !capability.files.length) deny();
const root = originalRealpath(capability.root);
if (!path.isAbsolute(capability.root) || root !== path.resolve(capability.root)) deny();
const files = new Map();
const audited = new Set();
function audit(name, kind) {
  if (!files.has(name)) return; // The network ledger is never disclosed.
  const relative=path.relative(root,name).split(path.sep).join('/');
  const key=kind+'\0'+relative;
  if (audited.has(key)) return;
  audited.add(key);
  process.stdout.write('RESQ_MUTATION_READ ' + JSON.stringify({kind,path:relative}) + '\n');
}
for (const item of capability.files) {
  if (!item || Object.keys(item).sort().join(',') !== 'path,sha256' || !path.isAbsolute(item.path)
      || !/^[a-f0-9]{64}$/.test(item.sha256)) deny();
  const name = exactFile(item.path), relative = path.relative(root, name);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || files.has(name)) deny();
  const bytes = originalRead(name);
  if (digest(bytes) !== item.sha256) deny();
  files.set(name, { digest:item.sha256, bytes });
}
if (!files.has(exactFile(capability.entry)) || exactFile(process.argv[1]) !== exactFile(capability.entry)) deny();
// The existing network guard reads only its own sticky ledger at exit. This
// exception is not usable for fixture imports or any other filesystem path.
const ledger = process.env.RESQ_CONTAINMENT_DIR
  ? path.join(originalRealpath(process.env.RESQ_CONTAINMENT_DIR), 'violations.log') : null;
fs.appendFileSync = function(value, data) {
  if (!ledger || typeof value!=='string' || path.resolve(value)!==ledger || typeof data!=='string') deny();
  if (originalRealpath(path.dirname(ledger))!==path.dirname(ledger)) deny();
  try { if(originalLstat(ledger).isSymbolicLink()||exactFile(ledger)!==ledger)deny(); }
  catch(error){if(error.code!=='ENOENT')throw error;}
  const fd=originalOpen(ledger,'a',0o600);
  try {if(exactFile(ledger)!==ledger)deny();originalFdWrite(fd,data,null,'utf8');}
  finally{originalClose(fd);}
};
function approved(value, allowLedger = false) {
  const name = exactFile(value);
  if (allowLedger && name === ledger) return name;
  const record = files.get(name);
  if (!record || digest(rawRead(name)) !== record.digest) deny();
  return name;
}
fs.readFileSync = function(value, options) {
  const name=approved(value,true), bytes=rawRead(name);
  audit(name,'read');
  const encoding=typeof options==='string'?options:options?.encoding;
  return encoding ? bytes.toString(encoding) : bytes;
};
// File descriptors and streams are intentionally unsupported in these fixtures.
// They otherwise permit handles to escape the closed path capability.
for (const method of ['readFile','createReadStream','openSync','open']) fs[method] = deny;
for (const method of ['read','readSync','readv','readvSync']) fs[method] = deny;
fs.promises.readFile = async (value, options) => fs.readFileSync(value,options);
fs.promises.open = async () => deny();
const builtins = new Set(builtinModules.flatMap(name => [name, 'node:' + name.replace(/^node:/,'')]));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (builtins.has(specifier)) return nextResolve(specifier, context);
    if (typeof specifier !== 'string' || !(specifier.startsWith('.') || specifier.startsWith('file:') || path.isAbsolute(specifier))) deny();
    const base=context.parentURL?.startsWith('file:') ? path.dirname(fileURLToPath(context.parentURL)) : root;
    const candidate=specifier.startsWith('file:')?fileURLToPath(specifier):path.resolve(base,specifier);
    // Reject outside module authority before Node's resolver can inspect it.
    if (![candidate,candidate+'.js',candidate+'.cjs',candidate+'.mjs',candidate+'.json'].some(name=>files.has(name))) deny();
    const result = nextResolve(specifier, context);
    if (!result.url.startsWith('file:')) deny();
    approved(new URL(result.url));
    return result;
  },
  load(url, context, nextLoad) {
    if (url.startsWith('node:')) return nextLoad(url, context);
    if (!url.startsWith('file:')) deny();
    const name = approved(new URL(url));
    audit(name,'module');
    const result = nextLoad(url, context);
    return { ...result, source:files.get(name).bytes };
  }
});
syncBuiltinESMExports();
const exit = process.exit.bind(process);
process.exit = code => exit(violated ? 1 : code);
process.on('exit', () => { if (violated) process.exitCode = 1; });
