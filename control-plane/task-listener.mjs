// Active-task listener (LD only, library only). Security review 30/09/2026, see control-plane/ACTIVE-TASKS.md.
// Push trigger (t175u/t176u, review/push-trigger-verdicts.md): the listener also acknowledges TASKs (EXECUTE) and
// MESSAGEs (NOTIFY) with acks[own key] = LIT -> UNDERSTOOD|UNREADABLE + a sanitized summary (<= 280 chars) produced by
// an injected no-tools summarizer. The ack is the ONLY autonomous action (A1 amended); it is never approval.
// - Runs ONLY under a separate per-agent listener identity (never the CI telemetry or budget identity). This module
//   holds no credential and has no CLI: Firestore operations are injected (ops.*). Nothing here starts on its own.
// - Writes ONLY progress[own key] = READY|REJECTED (EXECUTE targets) and acks[own key]; never status, never
//   IN_PROGRESS/COMPLETED (owner click only; the Rules enforce the same).
// - Delivery defaults to OFF (config.delivery:false); ack defaults to OFF (config.ack:false).
// - Pickup is MANUAL: nothing is executed, spawned or evaluated; the inbox file is data for a human-supervised
//   session. A task is never approval for push, deploy, delete or secrets.
// - The payload is never logged, never put in a file name, env, shell, eval or telemetry. It reaches ONLY the inbox
//   file (delivery on) and the injected summarizer (ack on); the summary reaches ONLY acks[own key].
import {hasSecret,NOTE_PATTERN,UUID_V4,NOTE_MAX} from './web/dispatch-model.mjs?v=20260930-grok-dispatch6';

export const AGENT_KEYS=Object.freeze({Codex:'codex',Grok:'grok',Gemini:'gemini'});
export const TARGET_KEYS=Object.freeze(['codex','grok','gemini']);
export const TASK_KEYS=Object.freeze(['taskId','dispatchedBy','payload','targets','status','timestamp','progress']);
export const OPTIONAL_TASK_KEYS=Object.freeze(['kind','acks']);
export const KINDS=Object.freeze(['TASK','MESSAGE']);
export const MESSAGE_MAX=2000;
export const LISTENER_LIMIT=5;   // Rules: listener list limit 1..5, where targets.<key> == 'EXECUTE' | in [EXECUTE, NOTIFY]
export const MAX_OPEN=5;         // open = own READY/delivered + IN_PROGRESS on PENDING tasks
export const HEARTBEAT_MS=120000; // t176u: 120 s; the UI treats a heartbeat older than HEARTBEAT_FRESH_MS (165 s) as disconnected
export const ACK_MAX_AGE_MS=24*3600000; // Rules: request.time < task.timestamp + 24h
export const ACK_STATES=Object.freeze(['LIT','UNDERSTOOD','UNREADABLE']);
export const SUMMARY_MAX=280;
export const ALLOWED_MACHINES=Object.freeze(['LD']);
const CONFIG_KEYS=['agent','machine','inboxRoot','delivery','ack'];
// The ONLY listener queries (ops.watchTasks must implement exactly one of these). mode 'poll' (REST, rollback,
// b41e775 behaviour): targets.<key> == 'EXECUTE'. mode 'push' (gRPC Listen): targets.<key> in [EXECUTE, NOTIFY].
// Both use orderBy(timestamp desc) + limit 5 and the SAME composite index per key (targets.<key> ASC, timestamp DESC):
// deploy/firestore.indexes.active-tasks.json. 'in' is served by the equality index (verify against the live list).
export function listenerQuery(key,mode='poll'){
  if(!TARGET_KEYS.includes(key))throw Error('LISTENER_KEY');
  if(mode!=='poll'&&mode!=='push')throw Error('LISTENER_MODE');
  const where=mode==='push'?Object.freeze(['targets.'+key,'in',Object.freeze(['EXECUTE','NOTIFY'])]):Object.freeze(['targets.'+key,'==','EXECUTE']);
  return Object.freeze({collection:'active_tasks',where,orderBy:Object.freeze(['timestamp','desc']),limit:LISTENER_LIMIT});
}

// {agent, machine, inboxRoot, delivery?, ack?} -> frozen config. delivery and ack default to false.
export function validateConfig(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('LISTENER_CONFIG_OBJECT');
  for(const k of Object.keys(raw))if(!CONFIG_KEYS.includes(k))throw Error('LISTENER_CONFIG_UNKNOWN_KEY');
  if(!Object.hasOwn(AGENT_KEYS,raw.agent))throw Error('LISTENER_AGENT_REJECTED');   // Claude and anything else rejected
  if(!ALLOWED_MACHINES.includes(raw.machine))throw Error('LISTENER_MACHINE_REJECTED');
  if(typeof raw.inboxRoot!=='string'||!raw.inboxRoot)throw Error('LISTENER_INBOX_ROOT');
  if(raw.delivery!==undefined&&typeof raw.delivery!=='boolean')throw Error('LISTENER_DELIVERY_BOOLEAN');
  if(raw.ack!==undefined&&typeof raw.ack!=='boolean')throw Error('LISTENER_ACK_BOOLEAN');
  return Object.freeze({agent:raw.agent,key:AGENT_KEYS[raw.agent],machine:raw.machine,inboxRoot:raw.inboxRoot,delivery:raw.delivery===true,ack:raw.ack===true});
}
export const taskKind=data=>data?.kind===undefined?'TASK':data.kind;
// Mirrors atCreate() in the Rules. Returns null (valid) | 'invalid' | 'secret'.
export function validateTask(id,data){
  if(!UUID_V4.test(id??'')||!data||typeof data!=='object')return 'invalid';
  const keys=Object.keys(data);
  if(!TASK_KEYS.every(k=>keys.includes(k))||!keys.every(k=>TASK_KEYS.includes(k)||OPTIONAL_TASK_KEYS.includes(k)))return 'invalid';
  if(data.taskId!==id||typeof data.dispatchedBy!=='string'||!['PENDING','CANCELLED'].includes(data.status))return 'invalid';
  const kind=taskKind(data);if(!KINDS.includes(kind))return 'invalid';
  if(data.acks!==undefined&&(!data.acks||typeof data.acks!=='object'||Array.isArray(data.acks)))return 'invalid';
  const t=data.targets;const allowed=kind==='TASK'?['EXECUTE','IGNORE']:['NOTIFY','IGNORE'];const needed=kind==='TASK'?'EXECUTE':'NOTIFY';
  if(!t||typeof t!=='object'||Object.keys(t).length!==3||!TARGET_KEYS.every(k=>allowed.includes(t[k]))||!TARGET_KEYS.some(k=>t[k]===needed))return 'invalid';
  if(!data.progress||typeof data.progress!=='object')return 'invalid';
  if(typeof data.payload!=='string'||data.payload.length>(kind==='MESSAGE'?MESSAGE_MAX:NOTE_MAX))return 'invalid';
  if(hasSecret(data.payload))return 'secret';
  if(!NOTE_PATTERN.test(data.payload))return 'invalid';
  return null;
}
const openState=e=>!!e&&((e.state==='READY'&&e.step==='delivered')||e.state==='IN_PROGRESS');

// Server timestamp of the task in ms (REST: {timestamp:'RFC3339'}; gRPC adapter: the same shape), else null.
export function taskTimeMs(data){const t=data?.timestamp?.timestamp;const ms=typeof t==='string'?Date.parse(t):NaN;return Number.isFinite(ms)?ms:null;}
// ops: {watchTasks({key,limit,next,error})->stop, writeProgress(taskId,key,{state,step})->Promise,
//       writeHeartbeat(key,{ack,mode})->Promise, writeAck(taskId,key,{state,summary})->Promise (ack on only)}
// next(snapshot) receives {fromCache, hasPendingWrites, docs:[{id,data}]}; only server-confirmed snapshots are used.
// summarizer (ack on): {summarize(payload)->Promise<{state:'UNDERSTOOD',summary}|{state:'UNREADABLE',reason}>, take()->bool}
//   or null (no key: S0, every ack is UNREADABLE and no model is called).
// ledger (ack on): {has(taskId)->bool, add(taskId)->void} persisted by the runner (UUIDs only).
// ackSince (ms, condition 2 of the 25572dc code review): NO retroactive ack. Only tasks whose server timestamp is
// >= the moment this listener started with ack on are acknowledged (default: now() at creation). The Rules add the
// second cut-off: task.timestamp >= control/ack_switch.updatedAt while the switch is ON.
export function createListener({config,ops,inbox=null,summarizer=null,ledger=null,mode='poll',now=Date.now,setTimer=setInterval,clearTimer=clearInterval,onHeartbeat=()=>{},ackSince=null}){
  const cfg=validateConfig(config);const key=cfg.key;
  if(mode!=='poll'&&mode!=='push')throw Error('LISTENER_MODE');
  const ackOn=cfg.ack&&mode==='push';                 // poll mode (rollback) never acknowledges
  if(!ops||typeof ops.watchTasks!=='function'||typeof ops.writeProgress!=='function'||typeof ops.writeHeartbeat!=='function')throw Error('LISTENER_OPS');
  if(ackOn&&(typeof ops.writeAck!=='function'||!ledger||typeof ledger.has!=='function'||typeof ledger.add!=='function'))throw Error('LISTENER_ACK_OPS');
  if(ackOn&&summarizer!==null&&(typeof summarizer.summarize!=='function'||typeof summarizer.take!=='function'))throw Error('LISTENER_SUMMARIZER');
  const since=ackSince===null?now():ackSince;
  if(ackOn&&!Number.isSafeInteger(since))throw Error('LISTENER_ACK_SINCE');
  if(cfg.delivery&&(!inbox||typeof inbox.deliver!=='function'||typeof inbox.markCancelled!=='function'))throw Error('LISTENER_INBOX_REQUIRED');
  const handled=new Set(),markerWritten=new Set(),acked=new Set();
  const counts={ready:0,delivered:0,rejected:0,cancelledMarkers:0,errors:0,received:0,lit:0,understood:0,unreadable:0,ackDenied:0,rateLimited:0,llmFail:0};
  let stopWatch=null,timer=null,chain=Promise.resolve(),running=false;
  const denied=e=>e?.code==='PERMISSION_DENIED'||e?.status===403;
  async function progressFor(d,open){
    const data=d.data;
    const problem=validateTask(d.id,data);let entry;
    if(problem)entry={state:'REJECTED',step:problem};
    else if(open.n>=MAX_OPEN)entry={state:'REJECTED',step:'limit'};
    else if(!cfg.delivery)entry={state:'READY',step:'delivery_off'};
    else{
      try{inbox.deliver(d.id,data.payload);}catch(e){if(e?.code!=='EEXIST'){counts.errors++;return;}}
      entry={state:'READY',step:'delivered'};open.n++;
    }
    handled.add(d.id);
    try{await ops.writeProgress(d.id,key,entry);counts[entry.state==='REJECTED'?'rejected':entry.step==='delivered'?'delivered':'ready']++;}
    catch{handled.delete(d.id);counts.errors++;}
  }
  // One ack cycle for one task: LIT (the card lights up) -> summary -> UNDERSTOOD | UNREADABLE. Each taskId is
  // processed at most once per process (acked) and once across restarts (ledger). A denied write (ack_switch off,
  // revoked, >24h, cancelled) is never retried and never reaches the model.
  async function ackFor(d){
    const data=d.data;const mine=data.acks?.[key];
    acked.add(d.id);
    const valid=validateTask(d.id,data);
    const final=async(entry,label)=>{
      try{await ops.writeAck(d.id,key,entry);counts[label]++;ledger.add(d.id);}
      catch(e){if(denied(e))counts.ackDenied++;else{counts.errors++;acked.delete(d.id);}}
    };
    if(mine===undefined){
      try{await ops.writeAck(d.id,key,{state:'LIT',summary:''});counts.lit++;}
      catch(e){if(denied(e)){counts.ackDenied++;return;}counts.errors++;acked.delete(d.id);return;}
    }
    if(valid!==null||summarizer===null){await final({state:'UNREADABLE',summary:''},'unreadable');return;}   // secret/invalid/S0: no model call
    if(!summarizer.take()){counts.rateLimited++;await final({state:'UNREADABLE',summary:''},'unreadable');return;}
    let r;try{r=await summarizer.summarize(data.payload);}catch{r=null;}
    if(r?.state==='UNDERSTOOD'&&typeof r.summary==='string'&&r.summary.length>=1&&[...r.summary].length<=SUMMARY_MAX)await final({state:'UNDERSTOOD',summary:r.summary},'understood');
    else{if(r?.reason!=='secret'&&r?.reason!=='rejected')counts.llmFail++;await final({state:'UNREADABLE',summary:''},'unreadable');}
  }
  const ackWanted=d=>{
    const data=d?.data;if(!ackOn||!data||data.status!=='PENDING'||!UUID_V4.test(d.id??''))return false;
    if(!['EXECUTE','NOTIFY'].includes(data.targets?.[key])||acked.has(d.id)||ledger.has(d.id))return false;
    const mine=data.acks?.[key];if(mine!==undefined&&mine?.state!=='LIT')return false;
    const at=taskTimeMs(data);return at!==null&&at>=since&&now()-at<ACK_MAX_AGE_MS;   // never retroactive
  };
  async function processDocs(docs){
    const open={n:docs.filter(d=>d?.data?.status==='PENDING'&&openState(d.data.progress?.[key])).length};
    for(const d of docs){
      const data=d?.data;const mine=data?.progress?.[key];
      if(data?.status==='CANCELLED'){
        if(cfg.delivery&&openState(mine)&&UUID_V4.test(d.id??'')&&!markerWritten.has(d.id)){try{inbox.markCancelled(d.id);markerWritten.add(d.id);counts.cancelledMarkers++;}catch{counts.errors++;}}
        continue;
      }
      const wantAck=ackWanted(d);
      if(wantAck||(data?.status==='PENDING'&&mine===undefined&&data?.targets?.[key]==='EXECUTE'&&!handled.has(d.id)))counts.received++;
      if(data?.status==='PENDING'&&mine===undefined&&data?.targets?.[key]==='EXECUTE'&&!handled.has(d.id))await progressFor(d,open);
      if(wantAck)await ackFor(d);
    }
  }
  const heartbeatInfo=Object.freeze({ack:ackOn?'on':'off',mode});
  return Object.freeze({
    config:cfg,ackOn,ackSince:ackOn?since:null,
    start(){
      if(running)return;running=true;
      const beat=()=>running?Promise.resolve().then(()=>ops.writeHeartbeat(key,heartbeatInfo)).then(()=>{try{onHeartbeat(true);}catch{}},e=>{counts.errors++;try{onHeartbeat(false,e);}catch{}}):Promise.resolve(); // exit 6 etc.: no heartbeat after stop
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
    // Counters only; never task content or a summary.
    status(){return Object.freeze({agent:cfg.agent,delivery:cfg.delivery,ack:heartbeatInfo.ack,mode,running,...counts});}
  });
}

// Manual step for the human-supervised agent session (same listener identity): decline only. Push trigger (t176u):
// IN_PROGRESS / COMPLETED are set ONLY by the owner's manual dashboard click; the listener identity lost those
// transitions in the Rules, so markStarted / markCompleted / markFailed no longer exist here.
// ops.readTask(taskId) must be a SERVER read. markDeclined refuses when `<taskId>.cancelled` exists or the task is not PENDING.
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
  return Object.freeze({
    async markDeclined(taskId){
      if(!UUID_V4.test(taskId??''))throw Error('SESSION_TASK_ID');
      if(inbox.isCancelled(taskId))throw Error('TASK_CANCELLED');
      const mine=await current(taskId);
      if(!mine||mine.state!=='READY')throw Error('TRANSITION_REJECTED');
      await ops.writeProgress(taskId,key,{state:'REJECTED',step:'declined'});
    }
  });
}
