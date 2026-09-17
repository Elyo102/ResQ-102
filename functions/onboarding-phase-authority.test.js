'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const sdkRequire = require('node:module').createRequire(path.resolve(__dirname, './package.json'));
const { Firestore, Timestamp } = sdkRequire('firebase-admin/firestore');
const { createInvitations } = require('./invitations');
const contract = require('./invitation-onboarding-contract');
const { createOnboardingApprovalAuthority } = require('./onboarding-approval-authority');
const { createOnboardingPhaseAuthority } = require('./onboarding-phase-authority');
const { createIdentityCoordinator, stableHash, registrationFingerprint } = require('./identity-coordinator');
const sdk = new Firestore({ projectId:'demo-resq-phase-authority' });
const now = 1790000000000, uid='member_1', requestId='request_20260915_001';
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const engine = createInvitations({ clock:()=>now, randomBytes:crypto.randomBytes, createHash:sha, timingSafeEqual:crypto.timingSafeEqual,
  assertMayAssign(){}, withinRoleSetterScope:()=>true });
function setup() {
  const invite={invite_id:'invite_1',secret_hash:sha('secret'),station_id:'station_1',district_id:'south',role:'firefighter',shift:'A',full_name:'Test Member',phone:'0500000000',email:'member@example.test',issued_by:'super_1',issued_at:Timestamp.fromMillis(now-1000),expires_at:Timestamp.fromMillis(now+60000),max_uses:1,person_id:'sp_person_0001'};
  const target={uid,email:invite.email,emailVerified:true,disabled:false,customClaims:{}};
  const actor={uid:'super_1'}, superUser={uid:actor.uid,disabled:false,customClaims:{super:true}};
  const redeemed=engine.redeem(invite,'secret',{uid,email:target.email,email_verified:true});
  const split=contract.splitRedemption({source:'server_document',invite,redeemed,recomputed_fingerprint:redeemed.invite_fingerprint,auth:{uid,email:target.email,email_verified:true},request_id:requestId});
  Object.assign(invite,{redeemed_by:uid,redeemed_request_id:requestId,redeemed_at:Timestamp.fromMillis(now)});
  const registry={schema_version:1,uid,station_id:'station_1',request_id:requestId,invite_id:'invite_1',operation_fingerprint:split.operation_fingerprint};
  const opPath='stations/station_1/onboarding_operations/'+requestId;
  const onboarding={...registry,assignment_ref:split.assignment_ref,stage:'request_created'};
  const request={...split.registration_request,created_at:Timestamp.fromMillis(now)};
  const store=new Map([['invitations/invite_1',invite],['onboarding_assignment_links/'+uid,registry],[opPath,onboarding],['registration_requests/'+uid,request]]);
  const control={gateCalls:0,authWrites:0};
  let ids=0;
  const db={doc(p){sdk.doc(p);return{path:p,async get(){return{exists:store.has(p),data:()=>store.get(p)};}};},collection(p){return{doc:n=>db.doc(p+'/'+(n||'generated_'+ ++ids))};},async runTransaction(fn){const writes=[];const tx={async get(ref){assert.equal(writes.length,0,'no reads after writes');return{exists:store.has(ref.path),data:()=>store.get(ref.path)};},set(ref,data,opts){writes.push([ref.path,data,opts]);},delete(ref){writes.push([ref.path,null]);}};const out=await fn(tx);if(control.abort)throw Error('abort');for(const[p,d,o]of writes){if(d===null)store.delete(p);else{const next=o?.merge?{...store.get(p),...d}:{...d};for(const k of Object.keys(next))if(next[k]?.__delete)delete next[k];store.set(p,next);}}return out;}};
  const auth={async getUser(id){return id===uid?target:{...superUser,uid:id};},async setCustomUserClaims(id,claims){assert.equal(id,uid);target.customClaims=claims;control.authWrites++;},async revokeRefreshTokens(){}};
  const initialReader=createOnboardingApprovalAuthority({db,invitations:engine,contract});
  const adapter=createOnboardingPhaseAuthority({db,auth,initialReader,contract,invitations:engine,serverTimestamp:()=>Timestamp.fromMillis(now),async requireStationPerson(){control.gateCalls++;if(control.denyGate)throw Error('gate');}});
  let operation,authority;
  const initial=()=>db.runTransaction(tx=>adapter.readInitial(tx,{uid,request,existingOp:null,actor}));
  const prepare=async()=>{authority=await initial();operation={op_id:'approve_1',target_uid:uid,actor_uid:actor.uid,kind:'approve',status:'processing',phase:'prepared',request_id:requestId,onboarding_authority:authority,desired_claims:{...authority.assignment,emp:'601'},desired_profile:{...authority.assignment,full_name:request.full_name,email:request.email,phone:request.phone}};await db.runTransaction(async tx=>{await adapter.commitApproval(tx,{operation,authority,actor});tx.set(db.doc('identity_operations/'+uid),operation);});return operation;};
  const validate=()=>db.runTransaction(tx=>adapter.validatePhase(tx,{operation,request:store.get('registration_requests/'+uid)||null,phase:'test',actor}));
  const complete=()=>db.runTransaction(async tx=>{await adapter.validatePhase(tx,{operation,request,phase:'finalize',actor});await adapter.finalize(tx,{operation,authority,actor});operation={...operation,status:'completed'};tx.set(db.doc('identity_operations/'+uid),operation);tx.delete(db.doc('registration_requests/'+uid));});
  return{adapter,db,auth,store,invite,registry,onboarding,request,actor,superUser,target,control,initial,prepare,validate,complete,opPath,get operation(){return operation;}};
}
let passed=0;async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
(async()=>{
 await test('real engine initial authority prepared and completed lifecycle with SDK Timestamp',async()=>{const f=setup();await f.prepare();await f.validate();await f.complete();await f.validate();assert.equal(f.store.get(f.opPath).stage,'assignment_completed');assert.equal(f.store.get(f.opPath).identity_operation_id,'approve_1');assert.equal(f.store.has('registration_requests/'+uid),false);assert(!JSON.stringify(f.operation.onboarding_authority).includes('secret'));});
 for(const [name,mutate]of Object.entries({actor:f=>f.superUser.customClaims.super=false,target:f=>f.target.disabled=true,gate:f=>f.control.denyGate=true,registry:f=>f.registry.extra=true,invite:f=>f.invite.role='commander',profile:f=>f.invite.full_name='Changed',request:f=>f.request.phone='changed'}))await test('initial rejects '+name,async()=>{const f=setup();mutate(f);await assert.rejects(f.initial);assert(!f.invite.approved_at);});
 for(const[name,mutate]of Object.entries({actor:f=>f.superUser.disabled=true,target:f=>f.target.email='other@example.test',gate:f=>f.control.denyGate=true,registry:f=>f.store.delete('onboarding_assignment_links/'+uid),stamp:f=>f.store.get('invitations/invite_1').approved_identity_operation_id='other',source:f=>f.operation.onboarding_authority={...f.operation.onboarding_authority,fingerprint:'0'.repeat(64)},request:f=>f.request.stationId='other',profile:f=>f.store.get('invitations/invite_1').phone='different'}))await test('phase rejects '+name,async()=>{const f=setup();await f.prepare();mutate(f);await assert.rejects(f.validate);});
 await test('aborted prepared transaction leaves no approval',async()=>{const f=setup();f.control.abort=true;await assert.rejects(f.prepare);assert(!f.store.get('invitations/invite_1').approved_at);assert(!f.store.has('identity_operations/'+uid));});
 await test('different fresh super can resume without replacing original receipt actor',async()=>{const f=setup();await f.prepare();f.actor.uid='super_2';await f.validate();assert.equal(f.store.get('invitations/invite_1').approved_by,'super_1');});
 await test('removed original completed source cannot downgrade to legacy',async()=>{const f=setup();await f.prepare();await f.complete();const stripped={...f.operation};delete stripped.onboarding_authority;await assert.rejects(()=>f.db.runTransaction(tx=>f.adapter.classify(tx,{uid,existingOp:stripped})));});
 await test('independent later role operation uses legacy only after completed linked receipt',async()=>{const f=setup();await f.prepare();await f.complete();assert.equal(await f.db.runTransaction(tx=>f.adapter.classify(tx,{uid,existingOp:{op_id:'role_later',kind:'set_role'}})),'legacy');});
 await test('finalize never claims person linked',async()=>{const f=setup();await f.prepare();await f.complete();assert.equal(f.store.get(f.opPath).stage,'assignment_completed');assert.equal(f.store.get(f.opPath).person_linked,undefined);});
 for(const [name,mutate]of Object.entries({claimScope:f=>f.operation.desired_claims.stationId='other',profileRole:f=>f.operation.desired_profile.role='commander',profileName:f=>f.operation.desired_profile.full_name='Other',profileEmail:f=>f.operation.desired_profile.email='other@example.test',profilePhone:f=>f.operation.desired_profile.phone='other',superGrant:f=>f.operation.desired_claims.super=true,revoked:f=>f.store.get('invitations/invite_1').revoked_at=Timestamp.fromMillis(now),extraSource:f=>f.operation.onboarding_authority={...f.operation.onboarding_authority,source:{...f.operation.onboarding_authority.source,extra:'untrusted'}}}))await test('prepared authority rejects '+name,async()=>{const f=setup();await f.prepare();mutate(f);await assert.rejects(f.validate);assert.equal(f.store.get(f.opPath).stage,'request_created');});
 await test('actual coordinator plus actual phase adapter runs complete identity lifecycle',async()=>{
   const f=setup();f.request.server_generation='generation_1';f.request.request_fingerprint=registrationFingerprint(uid,f.request);
   class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
   const coordinator=createIdentityCoordinator({db:f.db,auth:f.auth,FieldValue:{serverTimestamp:()=>Timestamp.fromMillis(now),delete:()=>({__delete:true})},Timestamp,HttpsError,randomId:()=> 'test_random',onboardingAuthority:f.adapter});
   const params={uid,opId:'approve_integrated',kind:'approve',actorUid:'super_1',actorEmail:'super@example.test',previousClaims:{},requireRequest:true,requestId,requestGeneration:'generation_1',blockIfAssigned:true,intentFingerprint:stableHash('intent'),employeeMode:'fixed',wantedEmp:'601',employeeStart:1,auditAction:'approve_registration',auditDetails:{},makePlan(emp,r,a){return{desiredClaims:{role:a.assignment.role,stationId:a.assignment.stationId,districtId:a.assignment.districtId,shift:a.assignment.shift,emp},desiredProfile:{...a.assignment,full_name:r.full_name,email:r.email,phone:r.phone,name_prefixes:[]}};}};
   assert.equal((await coordinator.acquireAssignment(params)).type,'acquired');
   assert.deepEqual(await coordinator.runAssignment(uid,params.opId,{ok:true},false,f.actor),{ok:true});
   assert.equal(f.control.authWrites,1);assert.equal(f.store.get(f.opPath).stage,'assignment_completed');
   assert.deepEqual(await coordinator.runAssignment(uid,params.opId,{ok:true},false,f.actor),{ok:true});assert.equal(f.control.authWrites,1);
 });
 console.log('Phase authority: '+passed+' PASS (real engine + SDK references, fake transactions; emulator NOT RUN)');
})().catch(e=>{console.error(e);process.exitCode=1;});
