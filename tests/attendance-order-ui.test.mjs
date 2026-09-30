import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { webcrypto, createHash } from 'node:crypto';

// Exercise the shipped host/transport code. Only the independently tested
// attachment component is substituted, to inspect host lifecycle deterministically.
const source=fs.readFileSync(new URL('../attendance-order-ui.js',import.meta.url),'utf8');
const anchor="import { createHrAttachmentsUI } from './hr-attachments-ui.js?v=42h30';";
assert.equal(source.split(anchor).length,2);
const module=await import('data:text/javascript;base64,'+Buffer.from(source.replace(anchor,
  'const createHrAttachmentsUI=(...args)=>globalThis.__orderComponent(...args);')).toString('base64'));
const epoch={uid:'self',station_id:'s1',auth_time:1,claims_digest:'a'.repeat(64)};
const context={parent_kind:'attendance',parent_id:'b'.repeat(64),parent_revision:1,can_upload:true,can_remove:false};
test('closed attendance context retains read-only permissions',()=>{
  assert.deepEqual(module.orderContext({...context,can_upload:false}),{
    parent_kind:'attendance',parent_id:context.parent_id,parent_revision:1,canUpload:false,canRemove:false});
  for(const patch of [{parent_kind:'request'},{parent_id:'bad'},{parent_revision:0},{can_remove:true},{can_upload:1}])
    assert.throws(()=>module.orderContext({...context,...patch}));
});
test('call forwards exact intent and requires matching complete actor epoch',async()=>{
  const session={attachmentEpoch:epoch},body={target_uid:'owner',date:'2026-09-30'};
  const call=module.orderCall(async data=>{assert.equal(data,body);return {data:{epoch,result:1}};},()=>session,()=>true);
  assert.equal((await call(body)).result,1);
  for(const key of Object.keys(epoch))await assert.rejects(module.orderCall(async()=>({data:{epoch:{...epoch,[key]:'different'}}}),()=>session,()=>true)({}));
});
test('late responses cannot cross session or viewed-row boundaries',async()=>{
  for(const change of ['session','row']){
    let session={attachmentEpoch:epoch},current=true,release;
    const call=module.orderCall(()=>new Promise(r=>release=r),()=>session,()=>current);
    const pending=call({});
    if(change==='session')session={attachmentEpoch:epoch};else current=false;
    release({data:{epoch}});await assert.rejects(pending);
  }
});

test('modal retains chosen/uncertain work, preserves same epoch, clears on sign-out',async()=>{
  class Element extends EventTarget{
    constructor(tag){super();this.tag=tag;this.children=[];this.style={};}
    setAttribute(){} append(...children){this.children.push(...children);}
    showModal(){this.open=true;} close(){this.open=false;this.dispatchEvent(new Event('close'));}
    remove(){this.removed=true;}
  }
  const originals=Object.fromEntries(['document','window','crypto','__orderComponent'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  const body=new Element('body'),win=new EventTarget();let callback,adapter,ui,pending=false,unsubscribed=false;
  Object.defineProperty(globalThis,'document',{configurable:true,value:{body,createElement:t=>new Element(t)}});
  Object.defineProperty(globalThis,'window',{configurable:true,value:win});
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:webcrypto});
  globalThis.__orderComponent=(_host,a)=>{adapter=a;ui={contexts:[],destroyed:false,hasPendingWork:()=>pending,
    setContext(c){this.contexts.push(c);},destroy(){this.destroyed=true;}};a.subscribeIdentity(()=>{if(!a.currentSession())pending=false;});return ui;};
  const user={uid:'self',getIdTokenResult:async()=>({claims:{stationId:'s1',role:'firefighter',auth_time:1}})};
  const auth={currentUser:user};const calls=[];
  const wireEpoch={...epoch,claims_digest:createHash('sha256').update(JSON.stringify(['self','s1','firefighter',false])).digest('hex')};
  try{
    const done=module.openAttendanceOrder({auth,fns:{},target_uid:'owner',date:'2026-09-30',isCurrent:()=>true,
      httpsCallable:(_f,name)=>async data=>{calls.push({name,data});return {data:{...context,epoch:wireEpoch}};},
      onIdTokenChanged:(_a,fn)=>{callback=fn;return()=>{unsubscribed=true;};}});
    const tick=async()=>{for(let i=0;i<30&&!ui?.contexts.length;i++)await new Promise(r=>setTimeout(r,2));assert.equal(ui?.contexts.length,1);};
    callback(user);await tick();
    assert.deepEqual(calls,[{name:'getAttendanceOrderContext',data:{target_uid:'owner',date:'2026-09-30'}}]);
    const dialog=body.children[0],close=dialog.children.at(-1),originalSession=adapter.currentSession();
    pending=true;close.onclick();assert.equal(dialog.open,true);
    dialog.dispatchEvent(new Event('cancel',{cancelable:true}));assert.equal(dialog.open,true);
    callback(user);await new Promise(r=>setTimeout(r,20));assert.equal(adapter.currentSession(),originalSession);assert.equal(pending,true);
    auth.currentUser=null;callback(null);assert.equal(adapter.currentSession(),null);assert.equal(pending,false);
    close.onclick();await done;assert.equal(ui.destroyed,true);assert.equal(unsubscribed,true);assert.equal(dialog.removed,true);
  }finally{for(const [key,descriptor]of Object.entries(originals)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
});
