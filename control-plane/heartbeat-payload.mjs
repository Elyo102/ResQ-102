// Pure heartbeat payload builder + rate limiter. No network, no provider API, no credentials.
// Wired ONLY into the existing gated receipt job (.github/scripts/telemetry-ci.mjs), which performs
// the write. Must not be imported by agent-cycle.mjs or referenced by any workflow.
// The produced write matches the deployed validEvent schema exactly:
//   agent, kind, task, step (client strings) + createdAt (server REQUEST_TIME transform).
import {AGENTS,TASK_LABELS} from './core.mjs';

export const HEARTBEAT_MIN_INTERVAL_MS=60000;
export const HEARTBEAT_MAX_PER_RUN=10;
export const EVENT_SCHEMA_KEYS=Object.freeze(['agent','kind','task','step','createdAt']);
const fail=code=>{throw Error(code);};

const EVENT_DOC=/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/databases\/\(default\)\/documents\/events\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// `name` is the full Firestore document name of a FRESH events/{uuid} document (never reused/retried).
export function buildHeartbeatPayload({agent,task='local_tests',kind='heartbeat',name}={}){
 if(typeof agent!=='string'||!AGENTS.includes(agent))fail('HEARTBEAT_AGENT_INVALID');
 if(kind!=='heartbeat')fail('HEARTBEAT_KIND_INVALID');
 if(typeof task!=='string'||!TASK_LABELS.includes(task))fail('HEARTBEAT_TASK_INVALID');
 if(typeof name!=='string'||!EVENT_DOC.test(name))fail('HEARTBEAT_NAME_INVALID');
 const event=Object.freeze({agent,kind:'heartbeat',task,step:'running'});
 // Exact Firestore commit write, same shape as the receipt writes in .github/scripts/telemetry-ci.mjs:
 // { update:{name,fields}, currentDocument:{exists:false}, updateTransforms:[createdAt=REQUEST_TIME] }.
 const write=Object.freeze({
  update:Object.freeze({name,fields:Object.freeze(Object.fromEntries(Object.entries(event).map(([k,v])=>[k,Object.freeze({stringValue:v})])))}),
  currentDocument:Object.freeze({exists:false}),
  updateTransforms:Object.freeze([Object.freeze({fieldPath:'createdAt',setToServerValue:'REQUEST_TIME'})])
 });
 return Object.freeze({event,write});
}

// At most one heartbeat per 60s and at most 10 per run. Options may only make it stricter.
export function createHeartbeatLimiter({now=Date.now,minIntervalMs=HEARTBEAT_MIN_INTERVAL_MS,maxPerRun=HEARTBEAT_MAX_PER_RUN}={}){
 if(typeof now!=='function')fail('HEARTBEAT_LIMITER_INVALID');
 if(!Number.isSafeInteger(minIntervalMs)||minIntervalMs<HEARTBEAT_MIN_INTERVAL_MS)fail('HEARTBEAT_LIMITER_INVALID');
 if(!Number.isSafeInteger(maxPerRun)||maxPerRun<1||maxPerRun>HEARTBEAT_MAX_PER_RUN)fail('HEARTBEAT_LIMITER_INVALID');
 let sent=0,last=null;
 return Object.freeze({
  tryAcquire(){
   const t=now();
   if(!Number.isSafeInteger(t)||t<0||t>8e15)return Object.freeze({allowed:false,reason:'CLOCK_INVALID'});
   if(sent>=maxPerRun)return Object.freeze({allowed:false,reason:'RUN_CAP_REACHED'});
   if(last!==null&&t<last)return Object.freeze({allowed:false,reason:'CLOCK_REGRESSION'});
   if(last!==null&&t-last<minIntervalMs)return Object.freeze({allowed:false,reason:'RATE_LIMITED',retryInMs:minIntervalMs-(t-last)});
   sent++;last=t;
   return Object.freeze({allowed:true,remaining:maxPerRun-sent});
  },
  get sent(){return sent;}
 });
}
