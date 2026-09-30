// Real Firestore adapter for the LD listener: Firestore REST v1 authenticated with the listener's OWN ID token.
// Security review 30/09/2026. Implements the ops contract of task-listener.mjs exactly:
// - watchTasks: ONLY listenerQuery(key) (targets.<key> == 'EXECUTE', orderBy timestamp desc, limit 5), re-run every
//   POLL_MS as a server query (runQuery always reads the server: fromCache false, no pending writes). REST polling
//   is used because the web SDK has no supported way to authenticate from a stored refresh token.
// - writeProgress: ONE commit updating ONLY progress.<key> = {state, step, updatedAt: REQUEST_TIME}, doc must exist.
// - writeHeartbeat: task_listeners/<key> = {agent: key, seenAt: REQUEST_TIME} (the Rules allow 1 write per 30 s).
// - readTask: a server GET of active_tasks/<taskId>.
// Never logs; never surfaces a token or a response body. Endpoint: firestore.googleapis.com, or the local emulator
// (127.0.0.1:8191/8199, demo-* project) for the e2e only.
import {requestJson,fail,PROJECT} from './listener-auth.mjs';
import {listenerQuery,TARGET_KEYS} from '../task-listener.mjs';

export const FIRESTORE_URL='https://firestore.googleapis.com';
export const EMULATOR_HOSTS=Object.freeze(['127.0.0.1:8191','127.0.0.1:8199']);
export const POLL_MS=60000;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STATES=Object.freeze({READY:['delivered','delivery_off'],REJECTED:['invalid','secret','limit','declined'],IN_PROGRESS:['started'],COMPLETED:['completed'],FAILED:['failed']});

export function firestoreBase({mode,projectId,emulatorHost}){
  if(mode==='production'){if(projectId!==PROJECT)fail('PROJECT_REJECTED');return FIRESTORE_URL;}
  if(mode==='emulator'){
    if(!/^demo-[a-z0-9-]{1,60}$/.test(projectId??''))fail('EMULATOR_PROJECT_REJECTED');
    if(!EMULATOR_HOSTS.includes(emulatorHost))fail('EMULATOR_HOST_REJECTED');
    return 'http://'+emulatorHost;
  }
  fail('MODE_REJECTED');
}
export function encodeValue(v){
  if(v===null)return {nullValue:null};
  if(typeof v==='string')return {stringValue:v};
  if(typeof v==='boolean')return {booleanValue:v};
  if(Number.isSafeInteger(v))return {integerValue:String(v)};
  if(v&&typeof v==='object'&&!Array.isArray(v))return {mapValue:{fields:Object.fromEntries(Object.entries(v).map(([k,x])=>[k,encodeValue(x)]))}};
  fail('ENCODE_TYPE');
}
export function decodeValue(v){
  if(!v||typeof v!=='object')return undefined;
  if('stringValue' in v)return v.stringValue;
  if('integerValue' in v){const n=Number(v.integerValue);return Number.isSafeInteger(n)?n:undefined;}
  if('booleanValue' in v)return v.booleanValue;
  if('nullValue' in v)return null;
  if('timestampValue' in v)return {timestamp:v.timestampValue};
  if('doubleValue' in v)return v.doubleValue;
  if('mapValue' in v)return decodeFields(v.mapValue?.fields||{});
  if('arrayValue' in v)return (v.arrayValue?.values||[]).map(decodeValue);
  return undefined;
}
export function decodeFields(fields){
  const out={};for(const [k,v] of Object.entries(fields||{}))out[k]=decodeValue(v);return out;
}
const docId=name=>typeof name==='string'?name.slice(name.lastIndexOf('/')+1):'';

// token: async () => bearer. Listener: its verified ID token. Provisioning: the owner's OAuth token.
export function createFirestoreClient({base,projectId,token,fetcher=fetch,userProject=null}){
  if(typeof token!=='function')fail('TOKEN_SOURCE');
  const db=`projects/${projectId}/databases/(default)`;const root=`${base}/v1/${db}/documents`;
  const headers=async()=>({Authorization:'Bearer '+await token(),'Content-Type':'application/json',...(userProject?{'x-goog-user-project':userProject}:{})});
  const path=p=>{if(typeof p!=='string'||!/^[A-Za-z_]+\/[A-Za-z0-9_-]{1,128}$/.test(p))fail('DOC_PATH');return p;};
  return Object.freeze({
    name:p=>`${db}/documents/${path(p)}`,
    async get(p){const r=await requestJson(fetcher,`${root}/${path(p)}`,{method:'GET',headers:await headers()},{allow404:true});return r?{id:docId(r.name),data:decodeFields(r.fields)}:null;},
    async runQuery(structuredQuery){
      const r=await requestJson(fetcher,`${root}:runQuery`,{method:'POST',headers:await headers(),body:JSON.stringify({structuredQuery})},{maxBytes:4<<20});
      if(!Array.isArray(r))fail('BAD_QUERY_RESPONSE');
      return r.filter(x=>x&&x.document).map(x=>({id:docId(x.document.name),data:decodeFields(x.document.fields)}));
    },
    async commit(writes){
      const r=await requestJson(fetcher,`${root}:commit`,{method:'POST',headers:await headers(),body:JSON.stringify({writes})});
      if(!Array.isArray(r.writeResults)||r.writeResults.length!==writes.length)fail('COMMIT_UNKNOWN');
      return r;
    }
  });
}
export function structuredListenerQuery(key){
  const q=listenerQuery(key);
  return {from:[{collectionId:q.collection}],
    where:{fieldFilter:{field:{fieldPath:q.where[0]},op:'EQUAL',value:{stringValue:q.where[2]}}},
    orderBy:[{field:{fieldPath:q.orderBy[0]},direction:'DESCENDING'}],limit:q.limit};
}
// ops for createListener()/createAgentSession(), bound to ONE agent key.
export function createListenerOps({client,key,pollMs=POLL_MS,setTimer=setInterval,clearTimer=clearInterval,onPoll=()=>{}}){
  if(!TARGET_KEYS.includes(key))fail('LISTENER_KEY');
  const own=k=>{if(k!==key)fail('LISTENER_KEY');};
  return Object.freeze({
    watchTasks({key:k,limit,next,error}){
      own(k);if(limit!==listenerQuery(key).limit)fail('LISTENER_LIMIT');
      let stopped=false,busy=false;const q=structuredListenerQuery(key);
      const poll=async()=>{
        if(stopped||busy)return;busy=true;
        try{const docs=await client.runQuery(q);if(!stopped){onPoll(true);next({fromCache:false,hasPendingWrites:false,docs});}}
        catch(e){if(!stopped){onPoll(false,e);try{error(e);}catch{}}}
        finally{busy=false;}
      };
      void poll();const t=setTimer(()=>{void poll();},pollMs);
      return()=>{stopped=true;clearTimer(t);};
    },
    async writeProgress(taskId,k,entry){
      own(k);if(!UUID.test(taskId??''))fail('TASK_ID');
      if(!entry||!Object.hasOwn(STATES,entry.state)||!STATES[entry.state].includes(entry.step))fail('PROGRESS_ENTRY');
      await client.commit([{update:{name:client.name('active_tasks/'+taskId),fields:{progress:encodeValue({[key]:{state:entry.state,step:entry.step}})}},
        updateMask:{fieldPaths:['progress.'+key]},
        updateTransforms:[{fieldPath:`progress.${key}.updatedAt`,setToServerValue:'REQUEST_TIME'}],
        currentDocument:{exists:true}}]);
    },
    async writeHeartbeat(k){
      own(k);
      await client.commit([{update:{name:client.name('task_listeners/'+key),fields:{agent:encodeValue(key)}},
        updateTransforms:[{fieldPath:'seenAt',setToServerValue:'REQUEST_TIME'}]}]);
    },
    async readTask(taskId){
      if(!UUID.test(taskId??''))fail('TASK_ID');
      const d=await client.get('active_tasks/'+taskId);return d?d.data:null;
    }
  });
}
