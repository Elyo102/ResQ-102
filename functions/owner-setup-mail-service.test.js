'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {createOwnerSetupMailService}=require('./owner-setup-mail-service');
function fixture(){
  let now=1790000000000, tail=Promise.resolve(), generated=0;
  const store=new Map([
    ['stations/eilat_102',{active:true}],
    ['stations/eilat_102/users/member',{active:true,stationId:'eilat_102',role:'firefighter',employee_number:17,email:'member@example.test',full_name:'Test Member'}],
    ['emp_index/17',{uid:'member',stationId:'eilat_102',email:'member@example.test'}]
  ]);
  const accounts={owner:{uid:'owner',disabled:false,customClaims:{super:true}},member:{uid:'member',disabled:false,email:'member@example.test',customClaims:{emp:17,stationId:'eilat_102',role:'firefighter'}}};
  const snapshot=path=>({exists:store.has(path),data:()=>structuredClone(store.get(path))});
  const db={doc:path=>({path,get:async()=>snapshot(path)}),runTransaction(fn){
    const run=tail.then(async()=>{let written=false;const writes=[];
      const out=await fn({get:async ref=>{assert.equal(written,false,'all reads before writes');return snapshot(ref.path);},
        create(ref,data){written=true;assert.equal(store.has(ref.path),false);writes.push([ref.path,data]);},
        set(ref,data,options){written=true;writes.push([ref.path,options?.merge?{...store.get(ref.path),...data}:data]);}});
      for(const [path,data] of writes)store.set(path,structuredClone(data));return out;
    });tail=run.catch(()=>{});return run;
  }};
  const auth={getUser:async uid=>{if(!accounts[uid])throw Error('not found');return structuredClone(accounts[uid]);},generatePasswordResetLink:async()=>{generated++;return 'https://example.test/reset?oobCode=secret';}};
  const service=createOwnerSetupMailService({db,auth,clock:()=>now,requireSuperAdmin:async req=>{const a=accounts[req.auth?.uid];if(!a||a.disabled||a.customClaims.super!==true)throw Error('denied');return a;},fail:(code,msg)=>{throw Object.assign(Error(msg),{code});}});
  const req=data=>({auth:{uid:'owner'},data});
  async function sendInput(){const p=await service.handle(req({action:'preview',uids:['member']}));return {action:'send',uids:['member'],request_id:'setup_request_00000001',expected:{member:p.rows[0].fingerprint}};}
  return {service,store,accounts,auth,req,sendInput,generated:()=>generated,advance:()=>now+=121000};
}
test('preview has no writes; send queues existing number and reset link, never password',async()=>{
  const f=fixture(), d=await f.sendInput();assert.equal(f.store.size,3);
  const out=await f.service.handle(f.req(d));assert.equal(out.rows[0].state,'PENDING');
  const mails=[...f.store].filter(([p])=>p.startsWith('mail/'));assert.equal(mails.length,1);
  assert.deepEqual(mails[0][1].to,['member@example.test']);assert.match(mails[0][1].message.text,/17/);
  assert.equal(JSON.stringify(out).includes('oobCode'),false);assert.equal(f.generated(),1);
  assert.equal(await f.service.validateDelivery(mails[0][1]),true);
});
test('concurrent same-operation retry queues once',async()=>{
  const f=fixture(),d=await f.sendInput();await Promise.all([f.service.handle(f.req(d)),f.service.handle(f.req(d))]);
  assert.equal([...f.store.keys()].filter(p=>p.startsWith('mail/')).length,1);assert.equal(f.generated(),1);
});
test('separate operation respects recipient cooldown',async()=>{
  const f=fixture(),d=await f.sendInput();await f.service.handle(f.req(d));
  const out=await f.service.handle(f.req({...d,request_id:'setup_request_00000002'}));assert.equal(out.rows[0].state,'COOLDOWN');
});
test('non-owner and malformed input cannot write',async()=>{
  const f=fixture();await assert.rejects(f.service.handle({auth:{uid:'member'},data:{action:'preview',uids:['member']}}));
  await assert.rejects(f.service.handle(f.req({action:'preview',uids:['member','member']})));assert.equal(f.store.size,3);
});
test('changed recipient after preview cannot receive queued mail',async()=>{
  const f=fixture(),d=await f.sendInput();f.accounts.member.email='other@example.test';
  const out=await f.service.handle(f.req(d));assert.equal(out.rows[0].state,'UNKNOWN');assert.equal(f.generated(),0);
  assert.equal([...f.store.keys()].some(p=>p.startsWith('mail/')),false);
});
test('identity changes during link generation are rechecked before enqueue',async()=>{
  const f=fixture(),d=await f.sendInput();f.auth.generatePasswordResetLink=async()=>{f.accounts.member.disabled=true;return 'https://example.test/reset';};
  await f.service.handle(f.req(d));assert.equal([...f.store.keys()].some(p=>p.startsWith('mail/')),false);
});
test('delivery validates owner and recipient again',async()=>{
  const f=fixture(),d=await f.sendInput();await f.service.handle(f.req(d));const job=[...f.store].find(([p])=>p.startsWith('mail/'))[1];
  f.accounts.owner.customClaims.super=false;assert.equal(await f.service.validateDelivery(job),false);
  f.accounts.owner.customClaims.super=true;assert.equal(await f.service.validateDelivery({...job,to:['other@example.test']}),false);
});
test('ambiguous link failure retains operation and supports bounded lease retry',async()=>{
  const f=fixture(),d=await f.sendInput(),generate=f.auth.generatePasswordResetLink;f.auth.generatePasswordResetLink=async()=>{throw Error('network');};
  assert.equal((await f.service.handle(f.req(d))).rows[0].state,'UNKNOWN');
  assert.equal((await f.service.handle(f.req(d))).rows[0].state,'PREPARING');f.advance();f.auth.generatePasswordResetLink=generate;
  assert.equal((await f.service.handle(f.req({...d,action:'status'}))).rows[0].state,'RETRY_READY');
  assert.equal((await f.service.handle(f.req(d))).rows[0].state,'PENDING');
});
test('coherent identity change is reported as preview changed, not queued',async()=>{
  const f=fixture(),d=await f.sendInput();f.accounts.member.customClaims.role='officer';f.store.get('stations/eilat_102/users/member').role='officer';
  assert.equal((await f.service.handle(f.req(d))).rows[0].state,'PREVIEW_CHANGED');assert.equal(f.generated(),0);
});
test('new setup mail guard denies missing validator, rejection, mutation and retries outage',async()=>{
  const {createMailDeliveryGuard}=require('./mail-delivery-guard');
  const job={station_id:'eilat_102',to:['member@example.test'],setup_authority:{schema:1,uid:'member'},message:{text:'fixture'}};
  for(const [validator,allowed,retryable] of [[undefined,false,false],[async()=>false,false,false],[async()=>true,true,false],[async()=>{throw Error('offline');},false,true]]){
    const guard=createMailDeliveryGuard({normalizeRecipients:v=>v||[],runtimeFresh:async()=>({silent:false}),stationFence:{check:async()=>({allowed:true})},validateSetupMail:validator});
    const result=await guard.check({original:guard.capture(job),current:job});assert.equal(result.allowed,allowed);assert.equal(result.retryable,retryable);
    const changed={...job,setup_authority:{schema:1,uid:'other'}};assert.equal((await guard.check({original:guard.capture(job),current:changed})).allowed,false);
  }
});
