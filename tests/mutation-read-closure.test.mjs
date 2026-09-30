import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyReadClosure } from './lib/mutation-read-closure.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const records = source => [
  { name:'tests/main.js', role:'suite', bytes:Buffer.from(source) },
  { name:'tests/data.js', role:'read-only-source', bytes:Buffer.from('support') },
  { name:'tests/module.js', role:'target', bytes:Buffer.from('module.exports=1;') },
];
for (const [name, source] of [
  ['direct', "const fs=require('fs');fs.readFileSync(__dirname+'/data.js');"],
  ['module alias', "const load=require;const disk=load('node:fs');disk.readFileSync(__dirname+'/data.js');"],
  ['read alias', "const disk=require('fs');const read=disk.readFileSync;read(__dirname+'/data.js');"],
  ['destructured alias', "const {readFileSync:read}=require('fs');read(__dirname+'/data.js');"],
  ['computed member', "const disk=require('fs');disk['read'+'FileSync'](__dirname+'/data.js');"],
  ['computed destructure', "const {['readFileSync']:read}=require('fs');read(__dirname+'/data.js');"],
  ['assignment propagation', "const disk=require('fs');let read;read=disk.readFileSync;read(__dirname+'/data.js');"],
  ['path helper', "const {join}=require('path');const F=name=>join(__dirname,name);require('fs').readFileSync(F('data.js'));"],
  ['named imports', "import {readFileSync as read} from 'node:fs';import {join} from 'node:path';read(join(__dirname,'data.js'));"],
  ['lexical shadow', "const fs=require('fs');{const fs={readFileSync(){}};}fs.readFileSync(__dirname+'/data.js');"],
]) test('closure supports '+name,()=>assert.deepEqual(verifyReadClosure(records(source)),[{from:'tests/main.js',path:'tests/data.js',kind:'read'}]));

for (const [name, source] of [
  ['missing read', "const r=require('fs').readFileSync;r(__dirname+'/absent.js');"],
  ['unknown path', "require('fs').readFileSync(process.argv[2]);"],
  ['dynamic filesystem property', "require('fs')[process.argv[2]]('tests/data.js');"],
  ['escaped filesystem', "unknown(require('fs'));"],
  ['external module', "require('unexpected-package');"],
  ['executed text support', "require('./data.js');"],
  ['unresolved callback read', "unknown(()=>require('fs').readFileSync(process.argv[2]));"],
  ['eval', "eval('readSomething()');"],
  ['object-carried read alias', "const bag={reader:require('fs').readFileSync};bag.reader(process.argv[2]);"],
  ['read bind indirection', "const read=require('fs').readFileSync.bind(null);read(process.argv[2]);"],
  ['exported unresolved reader', "export function read(){const r=require('fs').readFileSync;r(process.argv[2]);}"],
]) test('closure rejects '+name,()=>assert.throws(()=>verifyReadClosure(records(source)),/MUTATION_READ_UNRESOLVED/));
test('closure records executable dependency separately',()=>assert.deepEqual(verifyReadClosure(records("require('./module.js');")),[{from:'tests/main.js',path:'tests/module.js',kind:'module'}]));
test('pure unresolved path computation does not authorize a file read',()=>{
  assert.deepEqual(verifyReadClosure(records("const path=require('path');function report(suite){const filename=path.resolve(__dirname,'../..',suite);return filename;}module.exports={report};")),[]);
});
for(const [name,source] of [
  ['direct',"const fs=require('fs'),path=require('path');function report(suite){return fs.readFileSync(path.resolve(__dirname,suite));}"],
  ['alias',"const fs=require('fs'),path=require('path');const read=fs.readFileSync;function report(suite){return read(path.resolve(__dirname,suite));}"],
  ['computed',"const fs=require('fs'),path=require('path');function report(suite){return fs['readFileSync'](path.resolve(__dirname,suite));}"],
])test('unknown path remains rejected at '+name+' filesystem read',()=>{
  assert.throws(()=>verifyReadClosure(records(source)),error=>error.code==='UNRESOLVED_FILE_READ');
});
test('parent-only metadata is not parsed and has no child read or module edges',()=>{
  const metadata={name:'tests/private.json',role:'parent-data',bytes:Buffer.from('{not JavaScript')};
  assert.deepEqual(verifyReadClosure([...records(''),metadata]),[]);
  for(const source of ["require('fs').readFileSync(__dirname+'/private.json')","require('./private.json')"])
    assert.throws(()=>verifyReadClosure([...records(source),metadata]),error=>error.code==='UNRESOLVED_FILE_READ');
});
test('actual zero-filesystem reporter has no file dependencies; injected read aliases fail closed',()=>{
  const reporter=fs.readFileSync(new URL('./lib/mutation-reporter.cjs',import.meta.url),'utf8');
  const row={name:'tests/lib/mutation-reporter.cjs',role:'support',bytes:Buffer.from(reporter)};
  assert.deepEqual(verifyReadClosure([row]),[]);
  for(const body of [
    "return require('fs').readFileSync(suite);",
    "const read=require('fs').readFileSync;return read(suite);",
    "const disk=require('fs');return disk['readFileSync'](suite);",
  ])assert.throws(()=>verifyReadClosure([{...row,bytes:Buffer.from(reporter+'\nfunction injectedRead(suite){'+body+'}\n')}]),error=>error.code==='UNRESOLVED_FILE_READ');
});

const preload=fileURLToPath(new URL('./lib/mutation-read-preload.cjs',import.meta.url));
function probe(source,{ extra={}, allowed=[], badDigest=false }={}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'resq-read-proof-')));
  try {
    const entry=path.join(root,'entry.cjs');
    fs.writeFileSync(entry,source);
    for(const [name,bytes] of Object.entries(extra))fs.writeFileSync(path.join(root,name),bytes);
    const names=['entry.cjs',...allowed];
    const cap={version:1,root,entry,files:names.map(name=>({path:path.join(root,name),sha256:sha(fs.readFileSync(path.join(root,name)))}))};
    const capability=path.join(root,'capability.json'),bytes=JSON.stringify(cap);
    fs.writeFileSync(capability,bytes);
    const env={...process.env,RESQ_MUTATION_READ_CAPABILITY:capability,RESQ_MUTATION_READ_CAPABILITY_SHA:badDigest?'0'.repeat(64):sha(bytes)};
    // Preserve the supervisor's network preload. Our read guard is installed
    // afterwards; no network operations are performed by any probe.
    const result=spawnSync(process.execPath,['--require',preload,entry],{env,encoding:'utf8',timeout:10000,maxBuffer:65536});
    return result;
  } finally {fs.rmSync(root,{recursive:true,force:true});}
}
test('runtime accepts pinned content and CJS module reads',()=>{
  const result=probe("const fs=require('fs');if(fs.readFileSync(__dirname+'/data.txt','utf8')!=='expected'||require('./module.cjs')!==42)throw Error('bad');console.log('READ_PROOF_OK');",{extra:{'data.txt':'expected','module.cjs':'module.exports=42;'},allowed:['data.txt','module.cjs']});
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/READ_PROOF_OK/);
  const audits=result.stdout.split(/\r?\n/).filter(line=>line.startsWith('RESQ_MUTATION_READ ')).map(line=>JSON.parse(line.slice('RESQ_MUTATION_READ '.length)));
  assert.ok(audits.some(item=>item.kind==='read'&&item.path==='data.txt'));
  assert.ok(audits.some(item=>item.kind==='module'&&item.path==='module.cjs'));
  for(const item of audits){assert.deepEqual(Object.keys(item).sort(),['kind','path']);assert.ok(!path.isAbsolute(item.path));assert.ok(!item.path.includes('..'));}
});
for(const [name,body,extra] of [
  ['outside content',"require('fs').readFileSync(__dirname+'/outside.txt')",{'outside.txt':'not allowed'}],
  ['outside CJS import',"require('./outside.cjs')",{'outside.cjs':"console.log('FORBIDDEN_MODULE_EXECUTED');"}],
  ['outside ESM import',"await import('./outside.mjs')",{'outside.mjs':"console.log('FORBIDDEN_MODULE_EXECUTED');"}],
])test('runtime sticky denial: '+name,()=>{
  const result=probe("(async()=>{try{"+body+"}catch{}console.log('DENIAL_CAUGHT');process.exit(0);})();",{extra});
  assert.equal(result.error,undefined);assert.equal(result.status,1);assert.match(result.stdout,/RESQ_MUTATION_READ_DENIED/);assert.match(result.stdout,/DENIAL_CAUGHT/);assert.doesNotMatch(result.stdout,/FORBIDDEN_MODULE_EXECUTED/);
});
test('runtime rejects capability digest mismatch before entry',()=>{
  const result=probe("console.log('FORBIDDEN_ENTRY');",{badDigest:true});
  assert.equal(result.status,1);assert.match(result.stdout,/RESQ_MUTATION_READ_DENIED/);assert.doesNotMatch(result.stdout,/FORBIDDEN_ENTRY/);
});
test('runtime rechecks changed pinned content',()=>{
  const result=probe("const fs=require('fs');fs.writeFileSync(__dirname+'/data.txt','changed');try{fs.readFileSync(__dirname+'/data.txt')}catch{}process.exit(0);",{extra:{'data.txt':'original'},allowed:['data.txt']});
  assert.equal(result.status,1);assert.match(result.stdout,/RESQ_MUTATION_READ_DENIED/);
});
