import test from 'node:test';
import assert from 'node:assert/strict';
import {validateInventory,describeGates,parseCandidateIndex} from './reproducibility.mjs';
function fixture(){
  const manifest={schema:1,specs:['tests/e2e/example.spec.mjs'],inputs:['control-plane/web/index.html']};
  return {manifest,specs:[...manifest.specs],tracked:new Set([...manifest.specs,...manifest.inputs]),read:()=>Buffer.from('synthetic public input')};
}
test('exact declared tracked inventory succeeds, unrelated private files are not read',()=>{
  const f=fixture();f.tracked.add('outputs/private.json');
  assert.deepEqual(validateInventory(f),{specFiles:1,requiredInputs:2});
});
test('missing, untracked and non-buffer inputs fail closed',()=>{
  const f=fixture();f.tracked.delete(f.manifest.inputs[0]);assert.throws(()=>validateInventory(f),/UNTRACKED/);
  for(const value of [Buffer.alloc(0),undefined])assert.throws(()=>validateInventory({...fixture(),read:()=>value}),/MISSING/);
});
test('new or omitted discovered specs cannot silently change denominator',()=>{
  for(const specs of [[],['tests/e2e/example.spec.mjs','tests/e2e/new.spec.mjs']])assert.throws(()=>validateInventory({...fixture(),specs}),/SPEC_INVENTORY/);
});
test('private paths, traversal and undeclared control-plane code are refused',()=>{
  for(const name of ['outputs/log.json','control-plane/provision-project.mjs','../file','/absolute','tests/../secret','tests\\file']){
    const f=fixture();f.manifest.inputs=[name];f.tracked.add(name);assert.throws(()=>validateInventory(f),/PRIVATE_INPUT|INVALID_PATH/);
  }
});
test('duplicates and secret-like public literals reject without echoing contents',()=>{
  const f=fixture();f.manifest.inputs.push(f.manifest.inputs[0]);assert.throws(()=>validateInventory(f),/DUPLICATE/);
  for(const text of ['-----BEGIN PRIVATE KEY-----','refreshToken: "synthetic-secret-value"']){
    assert.throws(()=>validateInventory({...fixture(),read:()=>Buffer.from(text)}),{message:'SENSITIVE_PUBLIC_INPUT'});
  }
});
test('gate names retain distinct meanings and dynamic Rules entry denominator',()=>{
  const scripts={'test:all':'npm run test:reproducibility && npm run test:rules && npm run test:e2e',all:'npm run test:reproducibility && npm run test:inventory && npm run static'};
  assert.equal(describeGates(scripts,{test:'node a.mjs && node ../functions/b.test.js'}).rulesEntries,2);
  assert.throws(()=>describeGates({...scripts,'test:all':'npm run all'},{test:'node a.mjs'}),/FOCUSED/);
  assert.throws(()=>describeGates(scripts,{test:'curl example.invalid'}),/RULES/);
});
test('candidate index bytes are authoritative and filtered working bytes must match',()=>{
  const f=fixture(),oid='a'.repeat(40);
  const entries=parseCandidateIndex([...f.tracked].map(name=>`100644 ${oid} 0\t${name}\0`).join(''));
  const candidate={...f,tracked:undefined,entries,workingOid:()=>oid};
  assert.deepEqual(validateInventory(candidate),{specFiles:1,requiredInputs:2});
  assert.throws(()=>validateInventory({...candidate,workingOid:name=>name===f.manifest.inputs[0]?'b'.repeat(40):oid}),/DIRTY_INPUT/);
});
test('intent-to-add and conflicted candidate-index entries fail closed',()=>{
  const f=fixture(),input=f.manifest.inputs[0],spec=f.manifest.specs[0],oid='a'.repeat(40),zero='0'.repeat(40);
  const base=`100644 ${oid} 0\t${spec}\0`;
  for(const index of [
    base+`100644 ${zero} 0\t${input}\0`,
    base+`100644 ${oid} 1\t${input}\0`+`100644 ${oid} 2\t${input}\0`
  ]){
    assert.throws(()=>validateInventory({...f,tracked:undefined,entries:parseCandidateIndex(index),workingOid:()=>oid}),
      /INTENT_TO_ADD|CONFLICT_INPUT/);
  }
});
