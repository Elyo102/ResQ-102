import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=fs.readFileSync(path.join(root,'functions/index.js'),'utf8');
function handler(name){const start=source.indexOf('exports.'+name+' =');assert(start>=0,name);const end=source.indexOf('\nexports.',start+1);return source.slice(start,end<0?source.length:end);}
const fresh=source.match(/async function requireFreshOnboardingSuper\(req\) \{[\s\S]*?\n\}/)?.[0];
assert(fresh,'actual fresh super helper exists');
let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
function fixture({protectedRequest=true,actorChange={},assignmentChange={}}={}){
 const actor={uid:'actor_1',email:'current@example.test',disabled:false,customClaims:{super:true},...actorChange};
 const target={uid:'member_1',email:'member@example.test',customClaims:{}};
 const request={full_name:'Member Name',email:'member@example.test',phone:'0500000000',stationId:'station_1',districtId:'south',shift:'A'};
 const authority=protectedRequest?{assignment:{stationId:'station_1',districtId:'south',role:'firefighter',shift:'A',...assignmentChange}}:null;
 const state={acquisitions:0,authReads:[],plan:null,runArgs:null};
 const context={exports:{},onCall:(_options,fn)=>fn,HttpsError,crypto,console,
  requireSuperAdmin:req=>{if(req.auth?.token?.super!==true)throw new HttpsError('permission-denied','signed');return req.auth;},
  admin:{auth:()=>({getUser:async uid=>{state.authReads.push(uid);return uid===actor.uid?actor:target;}})},
  VALID_ROLES:['firefighter','commander'],VALID_SHIFTS:['A','B','C',''],KNOWN_DISTRICTS:['south','north'],EMP_START:1,
  validEmp:v=>/^[1-9][0-9]{0,5}$/.test(v),namePrefixes:v=>[v],identityCoordinatorModule:{stableHash:v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex')},
  identityCoordinator:{async acquireAssignment(params){state.acquisitions++;state.plan=params.makePlan('601',request,authority);return{type:'acquired',operation:{op_id:'op_1',desired_claims:state.plan.desiredClaims,desired_emp:'601'}};},async runAssignment(...args){state.runArgs=args;return args[2];}}};
 vm.createContext(context);vm.runInContext(fresh+'\nthis.requireFreshRegistrationReviewer=async function(req){return {auth:await requireFreshOnboardingSuper(req),hr:false,authority:null};};\n'+handler('approveRegistration'),context);
 const input={auth:{uid:'actor_1',token:{super:true,email:'stale@example.test'}},data:{uid:'member_1',request_id:'request_20260915_001',request_generation:'generation_1',role:'commander',shift:'C',stationId:'station_evil',districtId:'north',full_name:'Client Override',phone:'clientphone',super:true}};
 return{state,input,request,context,run:()=>context.exports.approveRegistration(input)};
}
await check('protected plan ignores client scope role name phone and super',async()=>{const f=fixture();await f.run();const p=f.state.plan;assert.equal(p.desiredClaims.stationId,'station_1');assert.equal(p.desiredClaims.districtId,'south');assert.equal(p.desiredClaims.role,'firefighter');assert.equal(p.desiredClaims.shift,'A');assert.equal(p.desiredClaims.super,undefined);assert.equal(p.desiredProfile.full_name,'Member Name');assert.equal(p.desiredProfile.phone,'0500000000');assert.equal(p.desiredProfile.email,'member@example.test');});
await check('protected server authority never falls back for invalid role',async()=>{const f=fixture({assignmentChange:{role:'owner'}});await assert.rejects(f.run,e=>e.code==='failed-precondition');assert.equal(f.state.runArgs,null);});
await check('legacy makePlan preserves existing client selection',async()=>{const f=fixture({protectedRequest:false});await f.run();assert.equal(f.state.plan.desiredClaims.stationId,'station_evil');assert.equal(f.state.plan.desiredClaims.role,'commander');assert.equal(f.state.plan.desiredProfile.full_name,'Client Override');});
await check('actual fresh super rejects disabled actor before acquire',async()=>{const f=fixture({actorChange:{disabled:true}});await assert.rejects(f.run,e=>e.code==='permission-denied');assert.equal(f.state.acquisitions,0);});
await check('actual fresh super rejects demoted actor before acquire',async()=>{const f=fixture({actorChange:{customClaims:{super:false}}});await assert.rejects(f.run,e=>e.code==='permission-denied');assert.equal(f.state.acquisitions,0);});
await check('actual fresh super rejects string super',async()=>{const f=fixture({actorChange:{customClaims:{super:'true'}}});await assert.rejects(f.run,e=>e.code==='permission-denied');assert.equal(f.state.acquisitions,0);});
await check('signed super remains required before fresh read',async()=>{const f=fixture();f.input.auth.token.super=false;await assert.rejects(f.run,e=>e.code==='permission-denied');assert.equal(f.state.authReads.length,0);});
await check('approval forwards current actor as fifth coordinator argument',async()=>{const f=fixture();await f.run();assert.equal(f.state.runArgs.length,5);assert.equal(f.state.runArgs[4].uid,'actor_1');assert.equal(f.state.runArgs[4].email,'current@example.test');});
await check('all three assignment callers forward current actor',()=>{const calls=[...source.matchAll(/identityCoordinator\.runAssignment\(/g)];assert.equal(calls.length,3);for(const call of calls){const segment=source.slice(call.index,source.indexOf('\n});',call.index));assert.match(segment,/,\s*\{\s*uid:\s*auth\.uid,\s*email:\s*auth\.token\.email\s*\}\s*\)/);}});
await check('coordinator receives actual protected authority adapter',()=>{assert.match(source,/createIdentityCoordinator\(\{\s*onboardingAuthority,/);assert(source.indexOf('const KNOWN_DISTRICTS')<source.indexOf('const onboardingStationGates'));assert(source.indexOf('const BUILTIN_TRANSFER_STATIONS')<source.indexOf('const onboardingStationGates'));});
function readinessFixture(){
 const state={project:'station-102',backup:{ready:false},backupReads:0,receipt:{valid:false},health:{mode:'OFF'},inventory:{complete:true,stations:[{station_id:'station_1'}]},runtime:{silent:true,silent_allow:[]},reads:[],inventoryCalls:[]};
 const tx={async get(ref){state.reads.push(ref);const value=ref==='config/system_health_v2'?state.health:state.runtime;return{exists:value!==null,data:()=>value};}};
 const ctx={process:{env:{}},Date,db:{doc:x=>x},admin:{auth:()=>({}),app:()=>({options:{projectId:state.project}})},schedulePersonContract:{},invitationEngine:{},KNOWN_DISTRICTS:['south'],BUILTIN_TRANSFER_STATIONS:{},RUNTIME_DOC:'config/runtime',
  systemHealthV2Ports:{async listStations(input){state.inventoryCalls.push(input);return state.inventory;}},onboardingStationModule:{createOnboardingStationGates:x=>x},
  require(name){if(name==='./provider-wiring-attestation')return{verifyProviderWiringAttestation:()=>state.receipt};if(name==='googleapis')return{google:{auth:{GoogleAuth:class{constructor(options){assert.deepEqual(Array.from(options.scopes),['https://www.googleapis.com/auth/datastore']);}}},firestore:()=>({})}};if(name==='./station-backup-capability')return{createStationBackupCapability:()=>({async readBackupCapability(){state.backupReads++;return state.backup;}})};throw new Error('Unexpected readiness dependency '+name);}};
 vm.createContext(ctx);const start=source.indexOf('let stationBackupCapabilityReader;'),end=source.indexOf('const onboardingInitialReader',start);assert(start>=0&&end>start);vm.runInContext(source.slice(start,end)+'\nglobalThis.gates=onboardingStationGates;',ctx);
 return{state,ctx,tx,input:{tx,station_id:'station_1',station:{silent:true}}};
}
await check('actual backup callback rejects missing capability and accepts verified ready only',async()=>{const f=readinessFixture();assert.equal(await f.ctx.gates.readBackupCapability(),false);f.state.backup={ready:'true'};assert.equal(await f.ctx.gates.readBackupCapability(),false);f.state.backup={ready:true};assert.equal(await f.ctx.gates.readBackupCapability(),true);assert.equal(f.state.backupReads,3);});
await check('actual backup callback never reads control plane for emulator or other project',async()=>{const f=readinessFixture();f.state.backup={ready:true};f.ctx.process.env.FIRESTORE_EMULATOR_HOST='127.0.0.1:8080';assert.equal(await f.ctx.gates.readBackupCapability(),false);delete f.ctx.process.env.FIRESTORE_EMULATOR_HOST;f.state.project='other-project';assert.equal(await f.ctx.gates.readBackupCapability(),false);assert.equal(f.state.backupReads,0);});
await check('actual health callback requires OBSERVE and complete station enrollment in same transaction',async()=>{const f=readinessFixture();assert.equal(await f.ctx.gates.readHealthCapability(f.input),false);f.state.health={mode:'OBSERVE'};f.state.inventory.complete=false;assert.equal(await f.ctx.gates.readHealthCapability(f.input),false);f.state.inventory={complete:true,stations:[]};assert.equal(await f.ctx.gates.readHealthCapability(f.input),false);f.state.inventory.stations=[{station_id:'station_1'}];assert.equal(await f.ctx.gates.readHealthCapability(f.input),true);assert(f.state.inventoryCalls.every(x=>x.tx===f.tx&&Number.isFinite(x.deadline_ms)));f.state.health=null;assert.equal(await f.ctx.gates.readHealthCapability(f.input),false);});
await check('actual silence callback requires frozen receipt and typed fresh runtime and station evidence',async()=>{const f=readinessFixture();assert.equal(await f.ctx.gates.readSilenceCapability(f.input),false);f.state.receipt.valid=true;assert.equal(await f.ctx.gates.readSilenceCapability(f.input),true);f.state.runtime={silent:true};assert.equal(await f.ctx.gates.readSilenceCapability(f.input),false);f.state.runtime=null;assert.equal(await f.ctx.gates.readSilenceCapability(f.input),false);f.state.runtime={silent:'true',silent_allow:[]};assert.equal(await f.ctx.gates.readSilenceCapability(f.input),false);f.state.runtime={silent:false};assert.equal(await f.ctx.gates.readSilenceCapability(f.input),true);f.input.station.silent='true';assert.equal(await f.ctx.gates.readSilenceCapability(f.input),false);assert(f.state.reads.includes('config/runtime'));});
const require=createRequire(path.join(root,'functions/package.json'));
const personContract=require('./schedule-person-contract');
const storeContract=require('./schedule-identity-store-contract');
const freshIdentity=source.match(/async function freshOnboardingIdentity\(req, superRequired\) \{[\s\S]*?\n\}/)?.[0];
const serviceFactory=source.match(/function createOnboardingRequestService\(req\) \{[\s\S]*?\n\}/)?.[0];
assert(freshIdentity&&serviceFactory,'actual request adapters exist');
function adapterFixture({completed=false,linked=false}={}){
 const uid='member_1',sid='station_1',requestId='request_20260915_001',personId='sp_person_0001';
 const assignment={stationId:sid,districtId:'south',role:'firefighter',shift:'A'};
 const actor={uid:'actor_1',disabled:false,email:'admin@example.test',emailVerified:true,customClaims:{super:true}};
 const target={uid,disabled:false,email:'member@example.test',emailVerified:true,customClaims:{...assignment,emp:'601'}};
 const registry={schema_version:1,uid,station_id:sid,request_id:requestId,invite_id:'invite_1',operation_fingerprint:'a'.repeat(64)};
 const sourceOp={...registry,stage:completed?'assignment_completed':'request_created'};
 const authority={assignment,source:{request_id:requestId,operation_path:`stations/${sid}/onboarding_operations/${requestId}`}};
 const operation={status:'completed',target_uid:uid,request_id:requestId,onboarding_authority:authority};
 const person={schema_version:1,person_id:personId,station_id:sid,kind:linked?'registered':'external',linked_uid:linked?uid:null,display_name:'Mock Member',active:true,revision:1,source_ref:{station_id:sid,source_namespace:'station-workbook-v1',source_key:{kind:'employee',value:'601'}}};
 const profile={stationId:sid,districtId:'south',role:'firefighter',crew:'A',active:true,is_active:true,employee_number:'601'};
 const store=new Map([[`onboarding_assignment_links/${uid}`,registry],[authority.source.operation_path,sourceOp],
  [`stations/${sid}/users/${uid}`,profile],[`directory/${uid}`,{station:sid,district:'south',role:'firefighter',crew:'A',active:true,is_active:true}],
  ['emp_index/601',{uid,stationId:sid,active:true}],[`stations/${sid}/schedule_people/${personId}`,person]]);
 if(completed)store.set(`identity_operations/${uid}`,operation);else store.set(`registration_requests/${uid}`,{status:'pending'});
 const linkId=storeContract.linkIndexDocumentId(uid),localPath=`stations/${sid}/schedule_person_link_index/${linkId}`,globalPath=`schedule_person_link_reservations/${linkId}`;
 if(linked){const reservation={schema_version:1,station_id:sid,person_id:personId,revision:1,status:'bound'};store.set(localPath,{...reservation});store.set(globalPath,{...reservation});}
 const state={initial:0,phase:0,gate:0,writes:0,phaseHook:null};
 const req={auth:{uid:actor.uid,token:{super:true,email:actor.email,email_verified:true}}};
 const ctx={Object,exports:{},onCall:(_opts,fn)=>fn,HttpsError,db:{doc:p=>({path:p}),runTransaction:async fn=>fn({get:async ref=>({exists:store.has(ref.path),data:()=>store.get(ref.path)}),set:()=>{state.writes++;throw Error('read-only adapter wrote');}})},
  requireAuth:r=>{if(!r.auth)throw new HttpsError('unauthenticated','missing');return r.auth;},requireSuperAdmin:r=>{if(r.auth?.token?.super!==true)throw new HttpsError('permission-denied','signed');return r.auth;},
  admin:{auth:()=>({getUser:async id=>id===actor.uid?actor:target})},validEmp:v=>/^[1-9][0-9]{0,5}$/.test(v),
  schedulePersonContract:personContract,scheduleIdentityStoreContract:storeContract,invitationEngine:{},onboardingContract:{},FV:{serverTimestamp:()=>0},
  onboardingInitialReader:{readForApproval:async()=>{state.initial++;return authority;}},onboardingAuthority:{validatePhase:async(_tx,args)=>{state.phase++;assert.equal(args.actor.uid,actor.uid);if(state.phaseHook)state.phaseHook();}},
  onboardingStationGates:{requireStationPerson:async()=>{state.gate++;}},
  onboardingServiceModule:{createInvitationOnboardingService:deps=>({...deps,redeemInvitation:r=>deps.requireAuth(r),resumeOnboarding:r=>deps.requireSuperAdmin(r)})}};
 vm.createContext(ctx);vm.runInContext(freshIdentity+'\n'+serviceFactory+'\nthis.make=createOnboardingRequestService;',ctx);
 for(const name of ['redeemInvitation','resumeOnboarding']){const line=source.split('\n').find(v=>v.startsWith('exports.'+name+' ='));assert.match(line,/enforceAppCheck: true/);vm.runInContext(line,ctx);}
 const deps=ctx.make(req),args={uid,station_id:sid,request_id:requestId},linkArgs={uid,station_id:sid,person_id:personId};
 return{deps,args,linkArgs,ctx,req,state,store,actor,target,profile,sourceOp,operation,person,localPath,globalPath,uid};
}
await check('pending assignment requires real adapter source and gate, reports false',async()=>{const f=adapterFixture();assert.equal((await f.deps.registration.assignmentState(f.args)).completed,false);assert.equal(f.state.initial,1);assert.equal(f.state.gate,1);assert.equal(f.state.writes,0);});
await check('completed assignment requires phase proof and live binding',async()=>{const f=adapterFixture({completed:true});assert.equal((await f.deps.registration.assignmentState(f.args)).completed,true);assert.equal(f.state.phase,1);assert.equal(f.state.writes,0);});
await check('malformed onboarding source cannot report completion',async()=>{const f=adapterFixture({completed:true});f.sourceOp.invite_id='other';await assert.rejects(()=>f.deps.registration.assignmentState(f.args));assert.equal(f.state.phase,0);});
await check('missing completed identity receipt cannot fall back',async()=>{const f=adapterFixture({completed:true});f.store.delete('identity_operations/'+f.uid);await assert.rejects(()=>f.deps.registration.assignmentState(f.args));assert.equal(f.state.initial,0);});
await check('completed receipt alone cannot bypass inactive live profile',async()=>{const f=adapterFixture({completed:true});f.profile.active=false;await assert.rejects(()=>f.deps.registration.assignmentState(f.args));});
await check('fresh actor revocation after phase reader blocks result',async()=>{const f=adapterFixture({completed:true});f.state.phaseHook=()=>{f.actor.customClaims.super=false;};await assert.rejects(()=>f.deps.registration.assignmentState(f.args));});
await check('external person without reservations is unlinked, never mutated',async()=>{const f=adapterFixture();assert.equal((await f.deps.identityStore.linkState(f.linkArgs)).linked,false);assert.equal(f.state.writes,0);});
await check('external disabled target cannot get link evidence',async()=>{const f=adapterFixture();f.target.disabled=true;await assert.rejects(()=>f.deps.identityStore.linkState(f.linkArgs));});
await check('same registered UID requires both exact real-key reservations',async()=>{const f=adapterFixture({linked:true});assert.equal((await f.deps.identityStore.linkState(f.linkArgs)).linked,true);assert.equal(f.state.writes,0);});
for(const side of ['localPath','globalPath'])await check('missing '+side+' fails closed',async()=>{const f=adapterFixture({linked:true});f.store.delete(f[side]);await assert.rejects(()=>f.deps.identityStore.linkState(f.linkArgs));});
await check('ordinary verified redemption projects only fresh identity',async()=>{const f=adapterFixture();const r={auth:{uid:f.target.uid,token:{email:f.target.email,email_verified:true}}};const projected=await f.ctx.exports.redeemInvitation(r);assert.equal(projected.uid,f.target.uid);assert.equal(projected.email_verified,true);assert.deepEqual(Object.keys(projected).sort(),['email','email_verified','uid']);});
await check('ordinary redemption rejects stale signed email',async()=>{const f=adapterFixture();await assert.rejects(()=>f.ctx.exports.redeemInvitation({auth:{uid:f.target.uid,token:{email:'old@example.test',email_verified:true}}}));});
await check('resume callable requires fresh super rather than ordinary verified user',async()=>{const f=adapterFixture();await assert.rejects(()=>f.ctx.exports.resumeOnboarding({auth:{uid:f.target.uid,token:{email:f.target.email,email_verified:true}}}));});
await check('actual module registers with demo config and network disabled, no TDZ',()=>{
 const env={...process.env,GCLOUD_PROJECT:'demo-onboarding-index',GOOGLE_CLOUD_PROJECT:'demo-onboarding-index',FIREBASE_CONFIG:JSON.stringify({projectId:'demo-onboarding-index'})};delete env.GOOGLE_APPLICATION_CREDENTIALS;
 const code=`const deny=()=>{throw Error('Network forbidden during index registration')};require('node:http').request=deny;require('node:https').request=deny;require('node:net').Socket.prototype.connect=deny;global.fetch=deny;const api=require('./index');if(typeof api.approveRegistration!=='function'||typeof api.provisionStation!=='function')throw Error('Missing exports');console.log('registered');`;
 const child=spawnSync(process.execPath,['-e',code],{cwd:path.join(root,'functions'),env,encoding:'utf8',timeout:20000});assert.equal(child.status,0,child.stderr||String(child.error));assert.match(child.stdout,/registered/);
});
console.log(`Onboarding index: ${passed} PASS (actual handler with coordinator mocks; offline module registration; no provider calls)`);
