import test from 'node:test';
import assert from 'node:assert/strict';
import {createFirebaseAdapter as createAdapter,PROJECT,APP_ID} from '../status/firebase-adapter.mjs';
const providers=new WeakMap();
const createFirebaseAdapter=options=>createAdapter({...options,googleOauth:providers.get(options.sdk)});
const owner={uid:'synthetic-owner',email:'owner@example.test',emailVerified:true,providerData:[{providerId:'google.com'}]};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const config={projectId:PROJECT,authDomain:PROJECT+'.firebaseapp.com',appId:APP_ID,apiKey:'synthetic',googleOAuthClientId:'synthetic.apps.googleusercontent.com'};
function setup(user=owner){
 const state={user,stops:0,clients:[],exchanges:0,automatic:true,requests:0};const auth={get currentUser(){return state.user;}};
 const sdk={initializeApp(c,n){state.initialized={c,n};return {};},getAuth:()=>auth,
  setPersistence:async(a,p)=>{state.persistence=p;},browserSessionPersistence:'session',inMemoryPersistence:'memory',
  memoryLocalCache:()=> 'memory',initializeFirestore(a,o){state.dbOptions=o;return {};},
  GoogleAuthProvider:class{static credential(id,token){assert.equal(id,null);assert.equal(token,'synthetic-token');return {syntheticCredential:true};}},
  onIdTokenChanged(a,fn){state.identity=fn;return()=>state.stops++;},
  signInWithCredential:async()=>{state.exchanges++;return {user:state.user};},signOut:async()=>{state.user=null;state.identity?.(null);},
  collection:(d,path)=>path,orderBy:(...args)=>args,limit:n=>n,query:(...args)=>args,
  doc:(...args)=>args,getDocFromServer:async()=>{if(state.user.uid!==owner.uid)throw Error('permission-denied');return {exists:()=>false};},
  onSnapshot(q,options,next,error){Object.assign(state,{q,options,next,error});return()=>state.stops++;}};
 const googleOauth={initTokenClient(options){state.clients.push(options);return {requestAccessToken(request){state.requests++;assert.equal(request.prompt,'select_account');if(state.automatic)queueMicrotask(()=>options.callback({access_token:'synthetic-token'}));}};}};
 providers.set(sdk,googleOauth);
 return {state,sdk,googleOauth};
}
test('reject wrong project and domain before SDK initialization',async()=>{
 for(const bad of [{...config,projectId:'station-102'},{...config,authDomain:'example.com'}]){
  const x=setup();await assert.rejects(createFirebaseAdapter({sdk:x.sdk,config:bad}));assert.equal(x.state.initialized,undefined);
 }
});
test('blocked session storage falls back before login, popup remains synchronous to click',async()=>{
 const x=setup(),calls=[];
 x.sdk.setPersistence=async(a,p)=>{calls.push(p);if(p==='session')throw Object.assign(Error('blocked'),{code:'auth/web-storage-unsupported'});};
 const adapter=await createFirebaseAdapter({sdk:x.sdk,config});
 assert.deepEqual(calls,['session','memory']);
 const signIn=adapter.auth.signIn();assert.equal(x.state.requests,1);await signIn;
 assert.equal(x.state.exchanges,1);
});
test('unknown initialization errors and failed memory fallback are not swallowed',async()=>{
 for(const code of ['auth/network-request-failed','auth/invalid-api-key','unknown']){
  const x=setup();let calls=0;
  x.sdk.setPersistence=async()=>{calls++;throw Object.assign(Error('failure'),{code});};
  await assert.rejects(createFirebaseAdapter({sdk:x.sdk,config}));assert.equal(calls,1);
 }
 const x=setup();let calls=0;
 x.sdk.setPersistence=async()=>{calls++;throw Object.assign(Error('blocked'),{code:'auth/web-storage-unsupported'});};
 await assert.rejects(createFirebaseAdapter({sdk:x.sdk,config}));assert.equal(calls,2);
});
test('session auth, memory cache, server authorization and bounded metadata subscription',async()=>{
 const x=setup(),a=await createFirebaseAdapter({sdk:x.sdk,config});let identity;
 a.auth.onIdentity(u=>identity=u);x.state.identity(owner);assert.equal(identity,null);await tick();assert.equal(identity.uid,owner.uid);assert.equal(identity.backendAuthorized,true);
 assert.equal(x.state.persistence,'session');assert.deepEqual(x.state.dbOptions,{localCache:'memory'});
 const stop=a.subscribe({limit:50,next(){},error(){}});assert.deepEqual(x.state.q,['events',['createdAt','desc'],50]);
 assert.deepEqual(x.state.options,{includeMetadataChanges:true});stop();assert.equal(x.state.stops,1);
 assert.throws(()=>a.subscribe({limit:51}));
});
test('cache/pending snapshots clear private data but keep subscription for server',async()=>{
 const x=setup(),a=await createFirebaseAdapter({sdk:x.sdk,config}),seen=[];let errors=0;
 a.auth.onIdentity(()=>{});x.state.identity(owner);await tick();
 a.subscribe({limit:50,next:(...v)=>seen.push(v),error:()=>errors++});
 x.state.next({metadata:{fromCache:true},docs:[{data(){throw Error();}}]});
 x.state.next({metadata:{hasPendingWrites:true},docs:[]});
 x.state.next({metadata:{fromCache:false,hasPendingWrites:false},docs:[{id:'id',data:()=>({agent:'Codex',kind:'heartbeat',task:'local_tests',step:'running',createdAt:{toMillis:()=>1000}})}]});
 assert.equal(seen.length,3);assert.equal(seen[0][1].fromCache,true);assert.equal(seen[2][0][0].at,1000);
 assert.equal(errors,0);assert.equal(x.state.stops,0);
});
test('unverified or unlinked identity cannot subscribe, popup rejects and signs out',async()=>{
 for(const user of [{...owner,emailVerified:false},{...owner,providerData:[]}]){
  const x=setup(user),a=await createFirebaseAdapter({sdk:x.sdk,config});assert.throws(()=>a.subscribe({limit:50}));
  await assert.rejects(a.auth.signIn());assert.equal(x.state.user,null);
 }
});
test('malformed data, pending logout and stream errors fail closed',async()=>{
 const x=setup(),a=await createFirebaseAdapter({sdk:x.sdk,config});let errors=0,rendered=0;
 a.auth.onIdentity(()=>{});x.state.identity(owner);await tick();
 a.subscribe({limit:50,next:()=>rendered++,error:()=>errors++});
 x.state.next({metadata:{fromCache:false,hasPendingWrites:false},docs:[{data:()=>({secret:'must not render'})}]});
 x.state.user=null;x.state.next({metadata:{},docs:[]});x.state.error(Error('sensitive'));
 assert.equal(errors,3);assert.equal(rendered,0);
});
test('nonowner and network denial never authorize even with verified Google identity',async()=>{
 for(const failure of ['permission-denied','unavailable']){
  const x=setup({...owner,uid:'other'});x.sdk.getDocFromServer=async()=>{throw Error(failure);};
  const a=await createFirebaseAdapter({sdk:x.sdk,config});let value;
  a.auth.onIdentity(v=>value=v);x.state.identity(x.state.user);await tick();
  assert.equal(value.backendAuthorized,false);assert.throws(()=>a.subscribe({limit:50}));
 }
});
test('late probes cannot authorize after signout, identity switch, refresh or disposal',async()=>{
 for(const action of ['signout','switch','refresh','dispose']){
  const x=setup(),pending=[];x.sdk.getDocFromServer=()=>new Promise(resolve=>pending.push(resolve));
  const a=await createFirebaseAdapter({sdk:x.sdk,config});let value;
  const stop=a.auth.onIdentity(v=>value=v);x.state.identity(owner);
  if(action==='signout')await a.auth.signOut();
  if(action==='switch'){x.state.user={...owner,uid:'other'};x.state.identity(x.state.user);}
  if(action==='refresh')x.state.identity(owner);
  if(action==='dispose')stop();
  pending[0]({exists:()=>false});await tick();assert.notEqual(value?.backendAuthorized,true);
  assert.throws(()=>a.subscribe({limit:50}));
  stop();for(const resolve of pending.slice(1))resolve({exists:()=>false});await tick();
 }
});

test('OAuth errors and missing tokens fail clearly and permit a new attempt',async()=>{
 for(const [response,code,isError] of [
  [{type:'popup_failed_to_open'},'auth/popup-blocked',true],
  [{type:'popup_closed'},'auth/popup-closed-by-user',true],
  [{error:'access_denied'},'auth/oauth-failed',false],
  [{},'auth/oauth-failed',false]
 ]){
  const x=setup();x.state.automatic=false;const a=await createFirebaseAdapter({sdk:x.sdk,config});
  const attempt=a.auth.signIn(),rejected=assert.rejects(attempt,{code});
  const client=x.state.clients.at(-1);client[isError?'error_callback':'callback'](response);
  await rejected;assert.equal(x.state.exchanges,0);
  x.state.automatic=true;await a.auth.signIn();assert.equal(x.state.exchanges,1);
 }
});

test('cancelled OAuth callback cannot exchange credentials or resolve a newer attempt',async()=>{
 const x=setup();x.state.automatic=false;const a=await createFirebaseAdapter({sdk:x.sdk,config});
 const first=a.auth.signIn(),cancelled=assert.rejects(first,{code:'auth/cancelled-popup-request'});
 const oldClient=x.state.clients.at(-1);await a.auth.signOut();await cancelled;
 const second=a.auth.signIn();let settled=false;second.then(()=>{settled=true;},()=>{settled=true;});
 oldClient.callback({access_token:'synthetic-token'});oldClient.error_callback({type:'popup_closed'});
 await tick();assert.equal(settled,false);assert.equal(x.state.exchanges,0);
 x.state.user=owner;x.state.clients.at(-1).callback({access_token:'synthetic-token'});
 await second;assert.equal(x.state.exchanges,1);
});

test('duplicate callbacks and concurrent clicks cannot start duplicate credential exchanges',async()=>{
 const x=setup();x.state.automatic=false;let finish;
 x.sdk.signInWithCredential=()=>{x.state.exchanges++;return new Promise(resolve=>{finish=resolve;});};
 const a=await createFirebaseAdapter({sdk:x.sdk,config}),attempt=a.auth.signIn();
 await assert.rejects(a.auth.signIn(),{code:'auth/cancelled-popup-request'});
 const client=x.state.clients.at(-1);client.callback({access_token:'synthetic-token'});client.callback({access_token:'synthetic-token'});
 assert.equal(x.state.exchanges,1);finish({user:owner});await attempt;
});

test('signout during credential exchange never restores an authorized session',async()=>{
 const x=setup();x.state.automatic=false;let finish;
 x.sdk.signInWithCredential=()=>{x.state.exchanges++;return new Promise(resolve=>{finish=()=>{x.state.user=owner;x.state.identity?.(owner);resolve({user:owner});};});};
 const a=await createFirebaseAdapter({sdk:x.sdk,config}),identities=[];a.auth.onIdentity(value=>identities.push(value));
 const attempt=a.auth.signIn(),cancelled=assert.rejects(attempt,{code:'auth/cancelled-popup-request'});
 x.state.clients.at(-1).callback({access_token:'synthetic-token'});
 const logout=a.auth.signOut();
 finish();await logout;await cancelled;await tick();
 assert.equal(x.state.user,null);assert.equal(identities.some(value=>value?.backendAuthorized===true),false);
 assert.throws(()=>a.subscribe({limit:50}));
});

test('overlapping signouts share one operation and cannot clear a subsequent sign-in',async()=>{
 const x=setup();let finish,signouts=0;
 x.sdk.signOut=()=>{signouts++;return new Promise(resolve=>{finish=()=>{x.state.user=null;resolve();};});};
 const a=await createFirebaseAdapter({sdk:x.sdk,config});
 const first=a.auth.signOut(),second=a.auth.signOut();assert.equal(first,second);
 await tick();assert.equal(signouts,1);
 await assert.rejects(a.auth.signIn(),{code:'auth/cancelled-popup-request'});
 finish();await Promise.all([first,second]);
 x.state.user=owner;await a.auth.signIn();await tick();
 assert.equal(x.state.user,owner);assert.equal(signouts,1);assert.equal(x.state.exchanges,1);
});

test('failed signout stays closed until a successful explicit retry',async()=>{
 const x=setup();let signouts=0;
 x.sdk.signOut=async()=>{signouts++;if(signouts===1)throw Error('signout-failed');x.state.user=null;x.state.identity?.(null);};
 const a=await createFirebaseAdapter({sdk:x.sdk,config});a.auth.onIdentity(()=>{});x.state.identity(owner);await tick();
 await assert.rejects(a.auth.signOut(),/signout-failed/);
 assert.throws(()=>a.subscribe({limit:50}));
 await assert.rejects(a.auth.signIn(),{code:'auth/cancelled-popup-request'});
 await a.auth.signOut();assert.equal(signouts,2);assert.equal(x.state.user,null);
 x.state.user=owner;await a.auth.signIn();assert.equal(x.state.exchanges,1);
});
