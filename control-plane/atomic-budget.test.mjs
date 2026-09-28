import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createAtomicBudget, BUDGET_ROOT, POLICY_PATH} from './atomic-budget.mjs';
const sha = s => createHash('sha256').update(s).digest('hex');
const s = stringValue => ({stringValue}), i = n => ({integerValue:String(n)});
const at = Date.parse('2026-09-28T12:00:00Z');
function request(n=1) { const requestBody = '{"text":"synthetic"}'; return {id:sha(String(n)),provider:'Claude',model:'haiku',requestBody,requestDigest:sha(requestBody),maxOutputTokens:2200}; }
function fixture(options={}) {
  let elapsed=0, revision=0, commits=0, reads=0;
  const docs=new Map();
  const put=(path,fields)=>docs.set(path,{name:BUDGET_ROOT+path,fields,updateTime:new Date(at+revision++).toISOString()});
  put(POLICY_PATH,{enabled:{booleanValue:true},version:s('v1'),chargeMicroUsd:i(250000),maxBytes:i(60000),maxOutputTokens:i(2200),models:{mapValue:{fields:{Claude:s('haiku'),Grok:s('grok'),Gemini:s('flash')}}}});
  put('resq_budget_state/month_2026-09',{year:i(2026),month:i(9),chargedMicroUsd:i(0),lastOperationId:s('')});
  const transport={
    async get(path){reads++; return structuredClone(docs.get(path)??null);},
    async serverNow(){return options.server??at;},
    async commit(writes){
      commits++;
      if(options.abort) throw Error('secret error');
      assert.equal(writes.length,2);
      const [month,op]=writes, mp=month.update.name.slice(BUDGET_ROOT.length),p=op.update.name.slice(BUDGET_ROOT.length);
      assert.deepEqual(month.updateMask.fieldPaths,['chargedMicroUsd','lastOperationId']);
      assert.deepEqual(op.currentDocument,{exists:false});
      assert.deepEqual(op.updateTransforms,[{fieldPath:'createdAt',setToServerValue:'REQUEST_TIME'}]);
      if(docs.get(mp)?.updateTime!==month.currentDocument.updateTime || docs.has(p)) throw Error('CAS');
      const time=new Date(at+100+revision).toISOString();
      docs.set(mp,{name:month.update.name,fields:{...docs.get(mp).fields,...month.update.fields},updateTime:time});
      docs.set(p,{name:op.update.name,fields:{...op.update.fields,createdAt:{timestampValue:time}},updateTime:time});
      revision++;
      if(options.lost) throw Error('lost response secret');
      if(options.expireCommit) elapsed=20000;
      return {commitTime:time,writeResults:[{updateTime:time},{updateTime:time}]};
    }
  };
  return {docs,transport,api:createAtomicBudget({transport,monotonic:()=>elapsed}),setElapsed:n=>elapsed=n,get commits(){return commits;},get reads(){return reads;}};
}
test('atomic full names, CAS, server transform and one-use permit',async()=>{
  const f=fixture(),r=request(),permit=await f.api.reserveRequest(r);
  assert.equal(permit.dispatch,true); assert.ok(Object.isFrozen(permit));
  assert.equal(f.api.assertDispatch(permit),true);
  assert.throws(()=>f.api.assertDispatch(permit),/PERMIT_INVALID/);
  assert.equal(f.docs.get('resq_budget_state/month_2026-09').fields.chargedMicroUsd.integerValue,'250000');
  assert.equal(f.docs.get(`${POLICY_PATH}/operations/${r.id}`).fields.requestBody,undefined);
});
test('80 reservations exhaust twenty dollars; no eighty-first mutation',async()=>{
  const f=fixture(); for(let n=0;n<80;n++) await f.api.reserveRequest(request(n));
  await assert.rejects(f.api.reserveRequest(request(81)),/CAP_REACHED/); assert.equal(f.commits,80);
});
test('replay cannot dispatch or charge, conflicting body fails',async()=>{
  const f=fixture(),r=request(); await f.api.reserveRequest(r);
  assert.equal((await f.api.reserveRequest(r)).dispatch,false);
  const changed={...r,requestBody:'different',requestDigest:sha('different')};
  await assert.rejects(f.api.reserveRequest(changed),/RESERVATION_CONFLICT/); assert.equal(f.commits,1);
});
test('model policy migration preserves old charges and denies old model',async()=>{
 const f=fixture();await f.api.reserveRequest(request());const prior=structuredClone(f.docs.get(`${POLICY_PATH}/operations/${request().id}`));
 const policy=f.docs.get(POLICY_PATH);policy.fields.version=s('v2');policy.fields.models.mapValue.fields.Gemini=s('gemini-3.5-flash-lite');
 await assert.rejects(f.api.reserveRequest({...request(2),provider:'Gemini',model:'flash'}));assert.equal(f.commits,1);
 const r={...request(3),provider:'Gemini',model:'gemini-3.5-flash-lite'};const permit=await f.api.reserveRequest(r);f.api.assertDispatch(permit);
 assert.equal((await f.api.reserveRequest(r)).dispatch,false);assert.deepEqual(f.docs.get(`${POLICY_PATH}/operations/${request().id}`),prior);
 assert.equal(f.docs.get('resq_budget_state/month_2026-09').fields.chargedMicroUsd.integerValue,'500000');
});
test('concurrent CAS contenders never retry or overcharge',async()=>{
  const f=fixture(); const results=await Promise.allSettled([f.api.reserveRequest(request(1)),f.api.reserveRequest(request(2))]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(f.docs.get('resq_budget_state/month_2026-09').fields.chargedMicroUsd.integerValue,'250000');
  assert.equal(f.commits,2);
});
test('lost commit response remains charged and replay cannot send',async()=>{
  const f=fixture({lost:true}),r=request();
  await assert.rejects(f.api.reserveRequest(r),/^Error: BUDGET_COMMIT_UNKNOWN$/);
  assert.equal((await f.api.reserveRequest(r)).dispatch,false); assert.equal(f.commits,1);
});
test('failed atomic commit makes no writes and leaks no raw error',async()=>{
  const f=fixture({abort:true}); await assert.rejects(f.api.reserveRequest(request()),/^Error: BUDGET_COMMIT_UNKNOWN$/);
  assert.equal(f.docs.size,2);
});
test('missing or disabled policy, missing month and malformed ledger fail closed',async()=>{
  for(const mutate of [f=>f.docs.delete(POLICY_PATH),f=>f.docs.get(POLICY_PATH).fields.enabled.booleanValue=false,f=>f.docs.delete('resq_budget_state/month_2026-09'),f=>f.docs.get('resq_budget_state/month_2026-09').fields.chargedMicroUsd=i(1)]){
    const f=fixture(); mutate(f); await assert.rejects(f.api.reserveRequest(request()),/BUDGET_/); assert.equal(f.commits,0);
  }
});
test('invalid digest, UTF8 size, unknown fields and model/output reject',async()=>{
  for(const patch of [{requestDigest:'0'.repeat(64)},{requestBody:'א'.repeat(30001),requestDigest:sha('א'.repeat(30001))},{extra:true},{model:'other'},{maxOutputTokens:2201},{id:{toString:()=>sha('x')}}]){
    const f=fixture(); await assert.rejects(f.api.reserveRequest({...request(),...patch}),/BUDGET_/); assert.equal(f.commits,0);
  }
});
test('trusted clock invalid and UTC last120seconds reject without commit',async()=>{
  for(const server of [NaN,Infinity,-1,1.5,Date.parse('2026-09-30T23:58:00Z')]) {
    const f=fixture({server}); await assert.rejects(f.api.reserveRequest(request()),/BUDGET_/); assert.equal(f.commits,0);
  }
});
test('expired or rolled-back monotonic permits cannot dispatch',async()=>{
  const f=fixture(); const p=await f.api.reserveRequest(request()); f.setElapsed(20000);
  assert.throws(()=>f.api.assertDispatch(p),/EXPIRED/); assert.throws(()=>f.api.assertDispatch(p),/INVALID/);
  const g=fixture(); g.setElapsed(100); const q=await g.api.reserveRequest(request()); g.setElapsed(99);
  assert.throws(()=>g.api.assertDispatch(q),/INVALID_CLOCK/);
  assert.throws(()=>g.api.assertDispatch({...q}),/PERMIT_INVALID/);
});
test('committed but expired reservation never issues a permit',async()=>{
  const f=fixture({expireCommit:true}); await assert.rejects(f.api.reserveRequest(request()),/EXPIRED/); assert.equal(f.commits,1);
});
test('request is captured before awaiting and undefined absence is refused',async()=>{
  const f=fixture(),r=request(); const pending=f.api.reserveRequest(r); r.model='mutated'; await pending;
  const g=fixture(); g.transport.get=async()=>undefined;
  await assert.rejects(g.api.reserveRequest(request()),/READ_FAILED/); assert.equal(g.commits,0);
});
