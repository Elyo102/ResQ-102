import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {ACORN_FILES,installAcornCapsule,verifyAcornCapsule,verifyAcornImport} from './lib/source-eol-dependency.mjs';
const source=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
function fixture(work){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'resq-eol-capsule-')));try{fs.mkdirSync(path.join(root,'tests'));return work(root);}finally{fs.rmSync(root,{recursive:true,force:true});}}
test('exact locked capsule resolves and parses using copy-local ESM bytes',()=>fixture(root=>{
  const installed=installAcornCapsule(source,root);assert.equal(verifyAcornCapsule(root),installed);verifyAcornImport(root);
  for(const item of ACORN_FILES)assert.deepEqual(fs.readFileSync(path.join(installed,item.name)),fs.readFileSync(path.join(source,'tests/node_modules/acorn',item.name)));
}));
for(const item of ACORN_FILES)for(const mode of ['missing','tampered'])test(mode+' '+item.name+' fails before import',()=>fixture(root=>{
  const installed=installAcornCapsule(source,root),filename=path.join(installed,item.name);
  if(mode==='missing')fs.unlinkSync(filename);else fs.appendFileSync(filename,'tampered');
  assert.throws(()=>verifyAcornImport(root));
}));
test('extra package file rejected',()=>fixture(root=>{const installed=installAcornCapsule(source,root);fs.writeFileSync(path.join(installed,'extra.js'),'');assert.throws(()=>verifyAcornCapsule(root),/EOL_DEPENDENCY_INVENTORY/);}));
test('preexisting dependency directory cannot be adopted',()=>fixture(root=>{fs.mkdirSync(path.join(root,'tests/node_modules'));assert.throws(()=>installAcornCapsule(source,root),/EOL_DEPENDENCY_DESTINATION_EXISTS/);}));
test('noncanonical destination alias rejected',()=>fixture(root=>{assert.throws(()=>installAcornCapsule(source,root+path.sep+'tests'+path.sep+'..'),/EOL_DEPENDENCY_PATH/);}));
test('mismatched lock rejected without creating dependencies',()=>fixture(root=>{
  fs.writeFileSync(path.join(root,'tests/package-lock.json'),JSON.stringify({packages:{'node_modules/acorn':{version:'0.0.0'}}}));
  fixture(destination=>{assert.throws(()=>installAcornCapsule(root,destination),/EOL_DEPENDENCY_LOCK/);assert.equal(fs.existsSync(path.join(destination,'tests/node_modules')),false);});
}));
