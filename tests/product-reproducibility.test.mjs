import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {ENTRYPOINTS,INPUTS,validateManifest,validateName,validateInventory,parseCandidateIndex,assertInputPath} from './product-reproducibility.mjs';
const manifest=()=>({schema:1,scope:'product-partial-e00',entrypoints:[...ENTRYPOINTS],inputs:[...INPUTS]});
const oid='a'.repeat(40);
function fixture(){const m=manifest();return {manifest:m,entries:new Map([...m.entrypoints,...m.inputs].map(n=>[n,[{mode:'100644',stage:0,oid}]])),workingOid:()=>oid,read:()=>Buffer.from('synthetic')};}
test('explicit product inventory succeeds without executing its entrypoints',()=>assert.equal(validateInventory(fixture()).entrypoints,ENTRYPOINTS.length));
for(const field of ['entrypoints','inputs']){
  test(field+' omission is refused',()=>{const m=manifest();m[field].pop();assert.throws(()=>validateManifest(m),/PRODUCT_INVENTORY_CHANGED/);});
  test(field+' extra is refused',()=>{const m=manifest();m[field].push('tests/unreviewed.mjs');assert.throws(()=>validateManifest(m),/PRODUCT_INVENTORY_CHANGED/);});
}
test('duplicates are refused',()=>{const m=manifest();m.inputs.push(m.entrypoints[0]);assert.throws(()=>validateManifest(m),/DUPLICATE_INPUT/);});
test('private and cross-scope paths are refused',()=>{for(const n of ['control-plane/web/index.html','public/status/status.js','secrets/token','outputs/run.log','tests/vault.mjs','tests/provision.mjs'])assert.throws(()=>validateName(n),/PRIVATE_INPUT_DENIED/);});
test('traversal colon NUL and backslash are refused',()=>{for(const n of ['../x','tests/../x','tests//x','C:/x','tests/x\0y','tests\\\\x'])assert.throws(()=>validateName(n),/INVALID_PATH/);});
test('untracked conflicted and nonregular index entries are refused',()=>{
  for(const mode of ['untracked','conflict','symlink','intent']){const f=fixture(),name=ENTRYPOINTS[0];
    if(mode==='untracked')f.entries.delete(name);
    else f.entries.set(name,[{mode:mode==='symlink'?'120000':'100644',stage:mode==='conflict'?2:0,oid:mode==='intent'?'0'.repeat(40):oid}]);
    assert.throws(()=>validateInventory(f),/UNTRACKED_INPUT|CONFLICT_INPUT|NON_REGULAR_INPUT|INTENT_TO_ADD_INPUT/);
  }
});
test('dirty filtered bytes and empty staged bytes fail closed',()=>{const f=fixture();assert.throws(()=>validateInventory({...f,workingOid:()=> 'b'.repeat(40)}),/DIRTY_INPUT/);assert.throws(()=>validateInventory({...f,read:()=>Buffer.alloc(0)}),/MISSING_INPUT/);});
test('index parser retains merge stages and rejects malformed records',()=>{assert.equal(parseCandidateIndex('100644 '+oid+' 2\tfile\0').get('file')[0].stage,2);assert.throws(()=>parseCandidateIndex('invalid'),/INVALID_INDEX_ENTRY/);});
const node=(kind)=>({isSymbolicLink:()=>kind==='link',isDirectory:()=>kind==='dir',isFile:()=>kind==='file'});
test('ancestors precede leaf access; links stop traversal',()=>{
  const root=path.resolve('trusted-root');
  for(const linked of [0,1]){const seen=[];assert.throws(()=>assertInputPath(root,'tests/input.mjs',p=>{seen.push(p);return node(seen.length-1===linked?'link':'dir');}),/SYMLINK_INPUT/);assert.equal(seen.length,linked+1);}
  const seen=[];assert.equal(assertInputPath(root,'tests/input.mjs',p=>{seen.push(p);return node(seen.length===1?'dir':'file');}),path.join(root,'tests/input.mjs'));assert.equal(seen.length,2);
});
test('wrong ancestor types and missing files are refused; other errors survive',()=>{
  assert.throws(()=>assertInputPath('.', 'tests/a',()=>node('file')),/NON_REGULAR_INPUT/);
  assert.throws(()=>assertInputPath('.', 'tests/a',()=>{throw Object.assign(Error(),{code:'ENOENT'});}),/MISSING_INPUT/);
  const denied=Object.assign(Error('denied'),{code:'EACCES'});assert.throws(()=>assertInputPath('.', 'tests/a',()=>{throw denied;}),e=>e===denied);
});
