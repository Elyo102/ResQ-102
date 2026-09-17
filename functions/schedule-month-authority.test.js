'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const C = require('./schedule-month-authority');
const p = {station_id:'s1',publication_id:'p1',revision:1,content_digest:'a'.repeat(64),from:'2026-09-01',to:'2026-10-03'};
test('month owners retain exact coverage without merging policy or people',()=>{
  const v=C.publicationOwners({...p,policy:'different',people:['external']},'s1');
  assert.deepEqual(Object.keys(v),['2026-09','2026-10']);
  assert.equal(v['2026-09'].coverage_to,'2026-09-30');
  assert.equal(v['2026-10'].coverage_to,'2026-10-03');
  assert.equal(v['2026-09'].publication_id,'p1');
});
test('leap dates and history beyond397days remain supported',()=>{
  const v=C.publicationOwners({...p,from:'2024-02-01',to:'2026-10-03'},'s1');
  assert.equal(v['2024-02'].coverage_to,'2024-02-29');
  assert.equal(Object.keys(v).length,33);
});
test('mutations of owner station coverage revision signature and shape fail',()=>{
  const v=C.publicationOwners(p,'s1')['2026-09'];
  for(const mutation of [{station_id:'s2'},{coverage_from:'2026-09-31'},{coverage_to:'2026-10-01'},
    {coverage_to:'2026-08-31'},{revision:0},{content_digest:'bad'},{extra:true},{publication_id:'../bad'}]) {
    assert.throws(()=>C.owner({...v,...mutation},'s1','2026-09'));
  }
  assert.throws(()=>C.publicationOwners({...p,to:'2026-08-01'},'s1'));
  assert.throws(()=>C.publicationOwners(p,'s2'));
  assert.throws(()=>C.publicationOwners({...p,from:'0001-01-01',to:'9999-12-31'},'s1'),/transaction-capacity/);
});
test('receipt digest detects corruption and size is bounded without truncation',()=>{
  const after=C.publicationOwners(p,'s1'),before=Object.fromEntries(Object.keys(after).map(m=>[m,null]));
  const raw={schema_version:1,station_id:'s1',operation_id:'op1',kind:'publish',fingerprint:'b'.repeat(64),
    generation_before:0,generation_after:1,before,after,result:{ok:true}};
  const receipt=C.makeReceipt(raw);
  assert.deepEqual(C.receipt(receipt),receipt);
  assert.throws(()=>C.receipt({...receipt,generation_after:2}));
  assert.throws(()=>C.receipt({...receipt,result:{ok:false}}));
  assert.throws(()=>C.makeReceipt({...raw,result:{text:'x'.repeat(C.MAX_RECEIPT_BYTES)}}),/receipt-too-large/);
});
test('tombstone exact union forbids coverage public tuple personal data and expiry',()=>{
  const tomb={schema_version:2,state:'unowned',station_id:'s1',month:'2026-09',activation_id:C.activationId('s1','rollback','undo','2026-09'),operation_id:'undo',operation_publication_id:'envelope'};
  assert.deepEqual(C.patch({'2026-09':tomb},'s1')['2026-09'],tomb);
  for(const mutation of [{coverage_from:'2026-09-01'},{publication_id:'p'},{person:'uid'},{ttl:100},{schema_version:1},{activation_id:'bad'},{station_id:'s2'}])assert.throws(()=>C.entry({...tomb,...mutation},'s1','2026-09'));
});
