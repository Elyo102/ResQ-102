// Test-only synthetic REST store. No network, cloud credentials or live defaults.
import assert from 'node:assert/strict';
import {BUDGET_ROOT,POLICY_PATH,PRINCIPAL,TASK_BINDINGS} from './atomic-budget.mjs';
export const str=stringValue=>({stringValue}),num=n=>({integerValue:String(n)}),map=fields=>({mapValue:{fields}}),stamp=n=>({timestampValue:new Date(n).toISOString()});
export const FIXTURE_AT=Date.parse('2026-09-29T12:00:00Z');
export function budgetFixture({approvedSha='a'.repeat(40),authorizationId='synthetic-grant-001',now=FIXTURE_AT,models={Claude:'claude-haiku-4-5-20251001',Grok:'grok-4.7',Gemini:'gemini-3.5-flash-lite'}}={}){
 const docs=new Map();let revision=0,commits=0;
 const put=(path,fields)=>docs.set(path,{name:BUDGET_ROOT+path,fields,updateTime:new Date(now+revision++).toISOString()});
 put(POLICY_PATH,{enabled:{booleanValue:true},version:str('synthetic-v1'),chargeMicroUsd:num(250000),maxBytes:num(60000),maxOutputTokens:num(2200),models:map(Object.fromEntries(Object.entries(models).map(([p,m])=>[p,str(m)]))),pricing:map(Object.fromEntries(Object.keys(models).map(p=>[p,map({inputMicroUsdPerMillionTokens:num(1000000),outputMicroUsdPerMillionTokens:num(1000000),overheadTokens:num(1024),fixedMicroUsd:num(0),expiresAt:stamp(now+3600000)})])))});
 const d=new Date(now),year=d.getUTCFullYear(),month=d.getUTCMonth()+1,monthId=`month_${year}-${String(month).padStart(2,'0')}`,grantPath=`resq_budget_authorizations/${authorizationId}`;
 put('resq_budget_state/'+monthId,{year:num(year),month:num(month),chargedMicroUsd:num(0),lastOperationId:str(''),lastAuthorizationId:str('')});
 put(grantPath,{authorizationId:str(authorizationId),principal:str(PRINCIPAL),approvedSha:str(approvedSha),enabled:{booleanValue:true},expiresAt:stamp(now+3600000),monthId:str(monthId),allowedTasks:map(Object.fromEntries(Object.entries(TASK_BINDINGS).map(([p,t])=>[p,str(t)]))),capMicroUsd:num(750000),maxReservations:num(3),chargedMicroUsd:num(0),reservationCount:num(0),reservedProviders:{arrayValue:{}},lastOperationId:str(''),operations:{mapValue:{}}});
 const transport={
  async get(path){return structuredClone(docs.get(path)??null);},
  async serverNow(){return now;},
  async commit(writes){
   commits++;assert.equal(writes.length,2);const [m,g]=writes;
   const mp=m.update.name.slice(BUDGET_ROOT.length),gp=g.update.name.slice(BUDGET_ROOT.length),oldM=docs.get(mp),oldG=docs.get(gp);
   assert.equal(mp,'resq_budget_state/'+monthId);assert.equal(gp,grantPath);
   if(oldM?.updateTime!==m.currentDocument.updateTime||oldG?.updateTime!==g.currentDocument.updateTime)throw Error('SYNTHETIC_CAS_CONFLICT');
   const provider=g.update.fields.lastOperationId.stringValue.slice(authorizationId.length+1);
   assert.deepEqual(m.updateMask.fieldPaths,['chargedMicroUsd','lastOperationId','lastAuthorizationId']);
   assert.deepEqual(g.updateMask.fieldPaths,['chargedMicroUsd','reservationCount','reservedProviders','lastOperationId',`operations.${provider}`]);
   assert.deepEqual(g.updateTransforms,[{fieldPath:`operations.${provider}.createdAt`,setToServerValue:'REQUEST_TIME'}]);
   const time=new Date(now+100+revision++).toISOString(),operation=structuredClone(g.update.fields.operations.mapValue.fields[provider]);
   operation.mapValue.fields.createdAt={timestampValue:time};
   const gf={...structuredClone(oldG.fields),...structuredClone(g.update.fields),operations:map({...structuredClone(oldG.fields.operations.mapValue.fields||{}),[provider]:operation})};
   docs.set(mp,{name:m.update.name,fields:{...structuredClone(oldM.fields),...structuredClone(m.update.fields)},updateTime:time});
   docs.set(gp,{name:g.update.name,fields:gf,updateTime:time});
   return {commitTime:time,writeResults:[{updateTime:time},{updateTime:time}]};
  }
 };
 return {docs,transport,authorizationId,approvedSha,principal:PRINCIPAL,grantPath,monthPath:'resq_budget_state/'+monthId,get commits(){return commits;}};
}
