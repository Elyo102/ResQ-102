// Active-task listener (LD only, library only). Security review 30/09/2026, see control-plane/ACTIVE-TASKS.md.
// - Runs ONLY under a separate per-agent listener identity (never the CI telemetry or budget identity). This module
//   holds no credential and has no CLI: Firestore operations are injected (ops.*). Nothing here starts on its own.
// - Writes ONLY progress[own key] = {state, step, updatedAt:serverTime}; never status (Rules enforce the same).
// - Delivery defaults to OFF (config.delivery:false): the task is acknowledged as READY/delivery_off and nothing is
//   written locally. With delivery:true the payload is written raw to the hardened inbox (task-inbox.mjs).
// - Pickup is MANUAL: nothing is executed, spawned or evaluated; the inbox file is data for a human-supervised
//   session. A task is never approval for push, deploy, delete or secrets.
// - The payload is never logged, never put in a file name, env, shell, eval or telemetry.
import {hasSecret,NOTE_PATTERN,UUID_V4,NOTE_MAX} from './web/dispatch-model.mjs?v=20260930-grok-dispatch4';

export const AGENT_KEYS=Object.freeze({Codex:'codex',Grok:'grok',Gemini:'gemini'});
export const TARGET_KEYS=Object.freeze(['codex','grok','gemini']);
export const TASK_KEYS=Object.freeze(['taskId','dispatchedBy','payload','targets','status','timestamp','progress']);
export const LISTENER_LIMIT=5;   // Rules: listener list limit 1..5, where targets.<key> == 'EXECUTE'
export const MAX_OPEN=5;         // open = own READY/delivered + IN_PROGRESS on PENDING tasks
export const HEARTBEAT_MS=60000; // UI treats a heartbeat older than 95s as disconnected
export const ALLOWED_MACHINES=Object.freeze(['LD']);
const CONFIG_KEYS=['agent','machine','inboxRoot','delivery'];
// The ONLY listener query (ops.watchTasks must implement exactly this). Equality on targets.<key> plus
// orderBy(timestamp desc) needs a composite index per key in production: deploy/firestore.indexes.active-tasks.json.
export function listenerQuery(key){
  if(!TARGET_KEYS.includes(key))throw Error('LISTENER_KEY');
  return Object.freeze({collection:'active_tasks',where:Object.freeze(['targets.'+key,'==','EXECUTE']),orderBy:Object.freeze(['timestamp','desc']),limit:LISTENER_LIMIT});
}

// {agent, machine, inboxRoot, delivery?} -> frozen config. delivery defaults to false.
export function validateConfig(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('LISTENER_CONFIG_OBJECT');
  for(const k of Object.keys(raw))if(!CONFIG_KEYS.includes(k))throw Error('LISTENER_CONFIG_UNKNOWN_KEY');
  if(!Object.hasOwn(AGENT_KEYS,raw.agent))throw Error('LISTENER_AGENT_REJECTED');   // Claude and anything else rejected
  if(!ALLOWED_MACHINES.includes(raw.machine))throw Error('LISTENER_MACHINE_REJECTED');
  if(typeof raw.inboxRoot!=='string'||!raw.inboxRoot)throw Error('LISTENER_INBOX_ROOT');
  if(raw.delivery!==undefined&&typeof raw.delivery!=='boolean')throw Error('LISTENER_DELIVERY_BOOLEAN');
  return Object.freeze({agent:raw.agent,key:AGENT_KEYS[raw.agent],machine:raw.machine,inboxRoot:raw.inboxRoot,delivery:raw.delivery===true});
}
// Mirrors atCreate() in the Rules. Returns null (valid) | 'invalid' | 'secret'.
export function validateTask(id,data){
  if(!UUID_V4.test(id??'')||!data||typeof data!=='object')return 'invalid';
  const keys=Object.keys(data);
  if(keys.length!==TASK_KEYS.length||!TASK_KEYS.every(k=>keys.includes(k)))return 'invalid';
  if(data.taskId!==id||typeof data.dispatchedBy!=='string'||!['PENDING','CANCELLED'].includes(data.status))return 'invalid';
  const t=data.targets;
  if(!t||typeof t!=='object'||Object.keys(t).length!==3||!TARGET_KEYS.every(k=>['EXECUTE','IGNORE'].includes(t[k]))||!TARGET_KEYS.some(k=>t[k]==='EXECUTE'))return 'invalid';
  if(!data.progress||typeof data.progress!=='object')return 'invalid';
  if(typeof data.payload!=='string'||data.payload.length>NOTE_MAX)return 'invalid';
  if(hasSecret(data.payload))return 'secret';
  if(!NOTE_PATTERN.test(data.payload))return 'invalid';
  return null;
}
const openState=e=>!!e&&((e.state==='READY'&&e.step==='delivered')||e.state==='IN_PROGRESS');

// ops: {watchTasks({key,limit,next,error})->stop, writeProgress(taskId,key,{state,step})->Promise, writeHeartbeat(key)->Promise}
// next(snapshot) receives {fromCache, hasPendingWrites, docs:[{id,data}]}; only server-confirmed snapshots are used.
export function createListener({config,ops,inbox=null,setTimer=setInterval,clearTimer=clearInterval}){
  const cfg=validateConfig(config);const key=cfg.key;
  if(!ops||typeof ops.watchTasks!=='function'||typeof ops.writeProgress!=='function'||typeof ops.writeHeartbeat!=='function')throw Error('LISTENER_OPS');
  if(cfg.delivery&&(!inbox||typeof inbox.deliver!=='function'||typeof inbox.markCancelled!=='function'))throw Error('LISTENER_INBOX_REQUIRED');
  const handled=new Set(),markerWritten=new Set();const counts={ready:0,delivered:0,rejected:0,cancelledMarkers:0,errors:0};
  let stopWatch=null,timer=null,chain=Promise.resolve(),running=false;
  async function processDocs(docs){
    let open=docs.filter(d=>d?.data?.status==='PENDING'&&openState(d.data.progress?.[key])).length;
    for(const d of docs){
      const data=d?.data;const mine=data?.progress?.[key];
      if(data?.status==='CANCELLED'){
        if(cfg.delivery&&openState(mine)&&UUID_V4.test(d.id??'')&&!markerWritten.has(d.id)){try{inbox.markCancelled(d.id);markerWritten.add(d.id);counts.cancelledMarkers++;}catch{counts.errors++;}}
        continue;
      }
      if(data?.status!=='PENDING'||mine!==undefined||data?.targets?.[key]!=='EXECUTE'||handled.has(d.id))continue;
      const problem=validateTask(d.id,data);let entry;
      if(problem)entry={state:'REJECTED',step:problem};
      else if(open>=MAX_OPEN)entry={state:'REJECTED',step:'limit'};
      else if(!cfg.delivery)entry={state:'READY',step:'delivery_off'};
      else{
        try{inbox.deliver(d.id,data.payload);}catch(e){if(e?.code!=='EEXIST'){counts.errors++;continue;}}
        entry={state:'READY',step:'delivered'};open++;
      }
      handled.add(d.id);
      try{await ops.writeProgress(d.id,key,entry);counts[entry.state==='REJECTED'?'rejected':entry.step==='delivered'?'delivered':'ready']++;}
      catch{handled.delete(d.id);counts.errors++;}
    }
  }
  return Object.freeze({
    config:cfg,
    start(){
      if(running)return;running=true;
      const beat=()=>Promise.resolve().then(()=>ops.writeHeartbeat(key)).catch(()=>{counts.errors++;});
      void beat();timer=setTimer(beat,HEARTBEAT_MS);
      stopWatch=ops.watchTasks({key,limit:LISTENER_LIMIT,
        next(snapshot){
          if(!running||snapshot?.fromCache!==false||snapshot?.hasPendingWrites!==false)return;
          const docs=Array.isArray(snapshot.docs)?snapshot.docs.slice(0,LISTENER_LIMIT):[];
          chain=chain.then(()=>processDocs(docs)).catch(()=>{counts.errors++;});
        },
        error(){counts.errors++;}});
    },
    async stop(){running=false;clearTimer(timer);timer=null;try{stopWatch?.();}catch{}stopWatch=null;await chain;},
    idle(){return chain;},
    // Counters only; never task content.
    status(){return Object.freeze({agent:cfg.agent,delivery:cfg.delivery,running,...counts});}
  });
}

// Manual steps for the human-supervised agent session (same listener identity). ops.readTask(taskId) must be a
// SERVER read (getDocFromServer). markStarted refuses when `<taskId>.cancelled` exists or the task is not PENDING.
export function createAgentSession({agent,ops,inbox}){
  if(!Object.hasOwn(AGENT_KEYS,agent))throw Error('SESSION_AGENT_REJECTED');
  if(!ops||typeof ops.readTask!=='function'||typeof ops.writeProgress!=='function'||!inbox||typeof inbox.isCancelled!=='function')throw Error('SESSION_OPS');
  const key=AGENT_KEYS[agent];
  async function current(taskId){
    if(!UUID_V4.test(taskId??''))throw Error('SESSION_TASK_ID');
    const data=await ops.readTask(taskId);
    if(!data||data.status!=='PENDING')throw Error('TASK_NOT_PENDING');
    if(data.targets?.[key]!=='EXECUTE')throw Error('TASK_NOT_TARGETED');
    return data.progress?.[key]??null;
  }
  const step=async(taskId,from,entry)=>{
    if(!UUID_V4.test(taskId??''))throw Error('SESSION_TASK_ID');
    if(inbox.isCancelled(taskId))throw Error('TASK_CANCELLED');
    const mine=await current(taskId);
    if(!mine||!from(mine))throw Error('TRANSITION_REJECTED');
    await ops.writeProgress(taskId,key,entry);
  };
  return Object.freeze({
    markStarted:taskId=>step(taskId,m=>m.state==='READY'&&m.step==='delivered',{state:'IN_PROGRESS',step:'started'}),
    markDeclined:taskId=>step(taskId,m=>m.state==='READY',{state:'REJECTED',step:'declined'}),
    markCompleted:async taskId=>{const mine=await current(taskId);if(mine?.state!=='IN_PROGRESS')throw Error('TRANSITION_REJECTED');await ops.writeProgress(taskId,key,{state:'COMPLETED',step:'completed'});},
    markFailed:async taskId=>{const mine=await current(taskId);if(mine?.state!=='IN_PROGRESS')throw Error('TRANSITION_REJECTED');await ops.writeProgress(taskId,key,{state:'FAILED',step:'failed'});}
  });
}
