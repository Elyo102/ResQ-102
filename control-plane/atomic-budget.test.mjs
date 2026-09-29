import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createAtomicBudget,operationId,TASK_BINDINGS,POLICY_PATH} from './atomic-budget.mjs';
import {budgetFixture,str,num,stamp,FIXTURE_AT} from './budget-fixture.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
function setup(options={}){
 const f=budgetFixture(options);let elapsed=0;
 const api=createAtomicBudget({...f,monotonic:()=>elapsed});
 const request=(provider='Claude',body='{"synthetic":true}')=>({id:operationId(f.authorizationId,provider),provider,model:f.docs.get(POLICY_PATH).fields.models.mapValue.fields[provider].stringValue,task:TASK_BINDINGS[provider],requestBody:body,requestDigest:hash(body),maxOutputTokens:700});
 return {...f,api,request,setElapsed:n=>{elapsed=n;}};
}
test('three reservations retain history and two CAS writes; replay/fourth cannot dispatch',async()=>{
 const f=setup();let prior={};
 for(const p of ['Claude','Grok','Gemini']){
  const permit=await f.api.reserveRequest(f.request(p));assert.equal(f.api.assertDispatch(permit),true);assert.throws(()=>f.api.assertDispatch(permit));
  const ops=f.docs.get(f.grantPath).fields.operations.mapValue.fields;
  for(const [k,v] of Object.entries(prior))assert.deepEqual(ops[k],v);prior=structuredClone(ops);
 }
 assert.equal(f.docs.get(f.monthPath).fields.chargedMicroUsd.integerValue,'750000');
 assert.equal((await f.api.reserveRequest(f.request())).dispatch,false);
 await assert.rejects(f.api.reserveRequest({...f.request(),provider:'Other'}));
 assert.equal(f.docs.get(f.grantPath).fields.reservationCount.integerValue,'3');
});
test('conflicting replay and malformed request fail closed without new charge',async()=>{
 const f=setup();await f.api.reserveRequest(f.request());const before=structuredClone([...f.docs]);
 await assert.rejects(f.api.reserveRequest(f.request('Claude','changed')),/CONFLICT/);
 for(const patch of [{task:'swap_race_review'},{id:'other-grant_Claude'},{requestDigest:'0'.repeat(64)},{maxOutputTokens:2201},{extra:true},{requestBody:'x'.repeat(60001)}])await assert.rejects(f.api.reserveRequest({...f.request(),...patch}));
 assert.deepEqual([...f.docs],before);
});
test('grant principal SHA tasks revocation expiry caps and pricing deny',async()=>{
 for(const mutate of [
  f=>f.docs.get(f.grantPath).fields.principal=str('other'),
  f=>f.docs.get(f.grantPath).fields.approvedSha=str('b'.repeat(40)),
  f=>f.docs.get(f.grantPath).fields.enabled={booleanValue:false},
  f=>f.docs.get(f.grantPath).fields.expiresAt=stamp(FIXTURE_AT-1),
  f=>f.docs.get(f.grantPath).fields.capMicroUsd=num(750001),
  f=>f.docs.get(f.grantPath).fields.maxReservations=num(4),
  f=>f.docs.get(f.grantPath).fields.allowedTasks.mapValue.fields.Claude=str('other'),
  f=>f.docs.get(POLICY_PATH).fields.pricing.mapValue.fields.Claude.mapValue.fields.expiresAt=stamp(FIXTURE_AT-1),
  f=>f.docs.get(POLICY_PATH).fields.pricing.mapValue.fields.Claude.mapValue.fields.fixedMicroUsd=num(250000),
  f=>f.docs.get(POLICY_PATH).fields.enabled={booleanValue:false},
  f=>f.docs.delete(f.monthPath),
  f=>f.docs.delete(f.grantPath)
 ]){const f=setup();mutate(f);const before=structuredClone([...f.docs]);await assert.rejects(f.api.reserveRequest(f.request()));assert.deepEqual([...f.docs],before);}
});
test('monthly twenty-dollar cap stops further writes',async()=>{
 const f=setup(),m=f.docs.get(f.monthPath).fields;m.chargedMicroUsd=num(20000000);m.lastOperationId=str('previous-grant_Claude');m.lastAuthorizationId=str('previous-grant');
 await assert.rejects(f.api.reserveRequest(f.request()),/CAP_REACHED/);assert.equal(m.chargedMicroUsd.integerValue,'20000000');
});
test('concurrent CAS has one winner without retry',async()=>{
 const f=setup();const results=await Promise.allSettled([f.api.reserveRequest(f.request('Claude')),f.api.reserveRequest(f.request('Grok'))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.docs.get(f.monthPath).fields.chargedMicroUsd.integerValue,'250000');
});
test('lost commit reply charged; fresh budget instance cannot redispatch/refund',async()=>{
 const f=setup(),commit=f.transport.commit;f.transport.commit=async w=>{await commit(w);throw Error('synthetic uncertainty');};
 await assert.rejects(f.api.reserveRequest(f.request()),/COMMIT_UNKNOWN/);const before=structuredClone([...f.docs]);
 const fresh=createAtomicBudget({...f});assert.equal((await fresh.reserveRequest(f.request())).dispatch,false);assert.deepEqual([...f.docs],before);
});
test('expired and copied permits cannot dispatch',async()=>{
 const f=setup(),permit=await f.api.reserveRequest(f.request());f.setElapsed(20000);assert.throws(()=>f.api.assertDispatch(permit),/EXPIRED/);assert.throws(()=>f.api.assertDispatch(permit),/INVALID/);assert.throws(()=>f.api.assertDispatch({...permit}),/INVALID/);
});
test('valid omitted empty REST containers accepted, malformed containers denied',async()=>{
 const f=setup();await f.api.reserveRequest(f.request());
 for(const value of [{mapValue:{fields:[]}},{mapValue:{bad:{}}}]){const g=setup();g.docs.get(g.grantPath).fields.operations=value;await assert.rejects(g.api.reserveRequest(g.request()));}
 const g=setup();g.docs.get(g.grantPath).fields.reservedProviders={arrayValue:{values:{}}};await assert.rejects(g.api.reserveRequest(g.request()));
});
test('month blackout and invalid server clock denied before commit',async()=>{
 for(const now of [NaN,-1,Date.parse('2026-09-30T23:58:30Z')]){const f=setup();f.transport.serverNow=async()=>now;const before=structuredClone([...f.docs]);await assert.rejects(f.api.reserveRequest(f.request()));assert.deepEqual([...f.docs],before);}
});

test('monotonic rollback invalidates permit permanently',async()=>{
 const f=setup();f.setElapsed(100);const p=await f.api.reserveRequest(f.request());f.setElapsed(99);
 assert.throws(()=>f.api.assertDispatch(p),/INVALID_CLOCK/);assert.throws(()=>f.api.assertDispatch(p),/PERMIT_INVALID/);
});
test('request captured before awaiting and undefined read rejected',async()=>{
 const f=setup(),r=f.request(),pending=f.api.reserveRequest(r);r.model='mutated';await pending;
 const g=setup();g.transport.get=async()=>undefined;await assert.rejects(g.api.reserveRequest(g.request()),/READ_FAILED/);
});
test('successful commit followed by expiry keeps charge but returns no permit',async()=>{
 const f=setup(),commit=f.transport.commit;f.transport.commit=async w=>{const result=await commit(w);f.setElapsed(20000);return result;};
 await assert.rejects(f.api.reserveRequest(f.request()),/EXPIRED/);assert.equal(f.docs.get(f.monthPath).fields.chargedMicroUsd.integerValue,'250000');
});
test('model migration does not rewrite earlier history or reopen operation identity',async()=>{
 const f=setup();await f.api.reserveRequest(f.request());const prior=structuredClone(f.docs.get(f.grantPath).fields.operations.mapValue.fields.Claude);
 const old=f.request('Grok');f.docs.get(POLICY_PATH).fields.models.mapValue.fields.Grok=str('new-model');f.docs.get(POLICY_PATH).fields.version=str('v2');
 await assert.rejects(f.api.reserveRequest(old),/MODEL_DENIED/);await f.api.reserveRequest(f.request('Grok'));
 assert.deepEqual(f.docs.get(f.grantPath).fields.operations.mapValue.fields.Claude,prior);
 await assert.rejects(f.api.reserveRequest(f.request()),/RESERVATION_CONFLICT/);
 assert.equal(f.docs.get(f.monthPath).fields.chargedMicroUsd.integerValue,'500000');
});
test('commit refusal is sanitized and leaves no write, invalid input cannot mutate ledger',async()=>{
 const f=setup(),before=structuredClone([...f.docs]);f.transport.commit=async()=>{throw Error('secret-provider-token');};
 await assert.rejects(f.api.reserveRequest(f.request()),/^Error: BUDGET_COMMIT_UNKNOWN$/);assert.deepEqual([...f.docs],before);
 const g=setup(),body='א'.repeat(30001);await assert.rejects(g.api.reserveRequest(g.request('Claude',body)),/INVALID_REQUEST/);
});
