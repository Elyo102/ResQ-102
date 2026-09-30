// Firestore Listen (gRPC) adapter for the listener push mode (LD only). Push-trigger review (quota + gRPC conditions).
// Implements ops.watchTasks of task-listener.mjs with the same snapshot contract as the REST poll
// ({fromCache:false, hasPendingWrites:false, docs:[{id,data}]}), emitted only at a consistent server point
// (after CURRENT, on a global NO_CHANGE with a resume token).
// - Query: ONLY listenerQuery(key,'push'): targets.<key> in [EXECUTE, NOTIFY], orderBy timestamp desc, limit 5.
// - Auth: the listener's own Firebase ID token as a Bearer in the call metadata; a new call per (re)start, so a
//   refreshed token is used. Proactive restart TOKEN_MARGIN_S before the token expires.
// - A REMOVE / error with PERMISSION_DENIED (7) is FATAL (ACL_DENIED): revoked, disabled, rules changed. Never retried.
// - Restarts: exponential backoff 1 s -> 60 s with jitter; the backoff resets only after STABLE_MS (5 min) of stable
//   CURRENT. Every restart counts against RESTART_CAPS (20/h, 150/day); past a cap -> FATAL STREAM_RESTART_CAP.
//   There is NO automatic fallback to poll: the runner exits and the owner decides.
// - Watchdog: a stream not CURRENT within WATCHDOG_MS is restarted (counted).
// Never logs; errors surface as safe codes only (never a token, a document or a gRPC detail string).
import {fail} from './listener-auth.mjs';
import {listenerQuery,TARGET_KEYS} from '../task-listener.mjs';

export const RESTART_CAPS=Object.freeze({perHour:20,perDay:150});
export const BACKOFF=Object.freeze({minMs:1000,maxMs:60000});
export const STABLE_MS=300000;
export const WATCHDOG_MS=120000;
export const TOKEN_MARGIN_S=240;   // listener-auth refreshes inside 300 s of expiry, so a restart here gets a fresh token
export const TARGET_ID=0x5051;
const GRPC_PERMISSION_DENIED=7;

export function structuredPushQuery(key){
  const q=listenerQuery(key,'push');
  return {from:[{collectionId:q.collection}],
    where:{fieldFilter:{field:{fieldPath:q.where[0]},op:'IN',value:{arrayValue:{values:q.where[2].map(v=>({stringValue:v}))}}}},
    orderBy:[{field:{fieldPath:q.orderBy[0]},direction:'DESCENDING'}],limit:{value:q.limit}};
}
const tsIso=t=>{const s=Number(t?.seconds??0),n=Number(t?.nanos??0);const ms=s*1000+Math.floor(n/1e6);return Number.isFinite(ms)?new Date(ms).toISOString():undefined;};
// proto-loader (oneofs:true, longs:String, enums:String) Value -> the same shape as the REST decode.
export function decodeProtoValue(v){
  if(!v||typeof v!=='object')return undefined;
  const k=v.valueType??Object.keys(v).find(x=>x.endsWith('Value'));
  switch(k){
    case 'stringValue':return v.stringValue;
    case 'integerValue':{const n=Number(v.integerValue);return Number.isSafeInteger(n)?n:undefined;}
    case 'booleanValue':return v.booleanValue;
    case 'nullValue':return null;
    case 'doubleValue':return v.doubleValue;
    case 'timestampValue':return {timestamp:tsIso(v.timestampValue)};
    case 'mapValue':return decodeProtoFields(v.mapValue?.fields);
    case 'arrayValue':return (v.arrayValue?.values||[]).map(decodeProtoValue);
    default:return undefined;
  }
}
export function decodeProtoFields(fields){const out={};for(const [k,v] of Object.entries(fields||{}))out[k]=decodeProtoValue(v);return out;}
const docId=name=>typeof name==='string'?name.slice(name.lastIndexOf('/')+1):'';

// grpc: {listen(headers)->call} (grpc-transport.mjs or a fake). token(): Promise<ID token>. tokenExpiresAt(): seconds|0.
// onFatal(code): called once with 'ACL_DENIED' | 'STREAM_RESTART_CAP'. onState(event): counters for the status line.
export function createListenWatch({grpc,projectId,key,token,tokenExpiresAt=()=>0,now=Date.now,random=Math.random,
  setTimer=setTimeout,clearTimer=clearTimeout,onFatal=()=>{},onState=()=>{}}){
  if(!TARGET_KEYS.includes(key))fail('LISTENER_KEY');
  if(!grpc||typeof grpc.listen!=='function'||typeof token!=='function')fail('LISTEN_DEPS');
  const db=`projects/${projectId}/databases/(default)`;
  const query=structuredPushQuery(key);
  const restarts=[];   // timestamps (ms) of every restart, pruned to 24 h
  const stats={streams:0,restarts:0,current:false,lastErrorCode:null,fatal:null};
  let call=null,stopped=false,attempt=0,stableSince=null,resumeToken=null,docs=new Map(),current=false;
  let retryTimer=null,watchdogTimer=null,tokenTimer=null,nextFn=null,errorFn=null,gen=0;
  const clearAll=()=>{for(const t of [retryTimer,watchdogTimer,tokenTimer])if(t!==null)clearTimer(t);retryTimer=watchdogTimer=tokenTimer=null;};
  const closeCall=()=>{const c=call;call=null;if(c){try{c.removeAllListeners?.('data');}catch{}try{c.cancel?.();}catch{}try{c.end?.();}catch{}}};
  function fatal(code){
    if(stats.fatal)return;stats.fatal=code;stopped=true;clearAll();closeCall();onState({...stats});
    try{onFatal(code);}catch{}
  }
  function scheduleRestart(reason,{immediate=false,dropResume=false}={}){
    if(stopped||stats.fatal)return;
    gen++;closeCall();clearAll();current=false;stats.current=false;
    if(dropResume){resumeToken=null;docs=new Map();}
    const t=now();
    if(stableSince!==null&&t-stableSince>=STABLE_MS)attempt=0;   // reset only after 5 min of stable CURRENT
    stableSince=null;
    restarts.push(t);while(restarts.length&&t-restarts[0]>86400000)restarts.shift();
    const lastHour=restarts.filter(x=>t-x<3600000).length;
    stats.restarts++;stats.lastErrorCode=reason;onState({...stats});
    try{errorFn?.();}catch{}
    if(lastHour>RESTART_CAPS.perHour||restarts.length>RESTART_CAPS.perDay){fatal('STREAM_RESTART_CAP');return;}
    const base=Math.min(BACKOFF.maxMs,BACKOFF.minMs*2**attempt);attempt++;
    const delay=immediate?0:Math.round(base*(0.5+random()/2));
    retryTimer=setTimer(()=>{retryTimer=null;void open();},delay);
  }
  function emit(){
    if(!nextFn)return;
    const list=[...docs.values()].sort((a,b)=>String(b.data?.timestamp?.timestamp??'').localeCompare(String(a.data?.timestamp?.timestamp??''))).slice(0,5);
    try{nextFn({fromCache:false,hasPendingWrites:false,docs:list});}catch{}
  }
  function onData(my,m){
    if(my!==gen||stopped)return;
    const k=m?.responseType;const x=k?m[k]:null;if(!x)return;
    if(k==='targetChange'){
      const type=x.targetChangeType||'NO_CHANGE';const ids=Array.isArray(x.targetIds)?x.targetIds:[];
      const code=Number(x.cause?.code??0);
      if(code===GRPC_PERMISSION_DENIED){fatal('ACL_DENIED');return;}
      if(code!==0){scheduleRestart('LISTEN_CAUSE_'+code);return;}
      if(type==='REMOVE'){scheduleRestart('LISTEN_REMOVED');return;}
      if(type==='RESET'){docs=new Map();current=false;return;}
      if(type==='CURRENT'){current=true;return;}
      if(type==='NO_CHANGE'&&ids.length===0&&current){
        const tok=x.resumeToken;if(tok&&tok.length)resumeToken=tok;
        if(!stats.current){stats.current=true;stableSince=now();if(watchdogTimer!==null){clearTimer(watchdogTimer);watchdogTimer=null;}onState({...stats});}
        emit();
      }
      return;
    }
    if(k==='documentChange'){
      const d=x.document;if(!d?.name)return;
      const inT=(x.targetIds||[]).includes(TARGET_ID),out=(x.removedTargetIds||[]).includes(TARGET_ID);
      if(inT)docs.set(d.name,{id:docId(d.name),data:decodeProtoFields(d.fields)});else if(out)docs.delete(d.name);
      return;
    }
    if(k==='documentDelete'||k==='documentRemove'){const n=x.document;if(typeof n==='string')docs.delete(n);return;}
    if(k==='filter'){
      if(Number(x.count)!==docs.size)scheduleRestart('EXISTENCE_FILTER',{immediate:false,dropResume:true});
    }
  }
  async function open(){
    if(stopped||stats.fatal)return;
    const my=++gen;let tok;
    try{tok=await token();}catch(e){if(my===gen)scheduleRestart('TOKEN');return;}
    if(my!==gen||stopped)return;
    const headers={authorization:'Bearer '+tok,'google-cloud-resource-prefix':db,'x-goog-request-params':'database='+encodeURIComponent(db)};
    let c;try{c=grpc.listen(headers);}catch{scheduleRestart('OPEN');return;}
    call=c;stats.streams++;current=false;
    c.on('data',m=>onData(my,m));
    c.on('error',e=>{if(my!==gen||stopped)return;const code=Number(e?.code);if(code===GRPC_PERMISSION_DENIED)fatal('ACL_DENIED');else scheduleRestart('GRPC_'+(Number.isFinite(code)?code:'X'));});
    c.on('end',()=>{if(my!==gen||stopped)return;scheduleRestart('END');});
    const target={targetId:TARGET_ID,query:{parent:db+'/documents',structuredQuery:query}};
    if(resumeToken)target.resumeToken=resumeToken;
    try{c.write({database:db,addTarget:target});}catch{scheduleRestart('WRITE');return;}
    watchdogTimer=setTimer(()=>{watchdogTimer=null;if(my===gen&&!stats.current)scheduleRestart('WATCHDOG');},WATCHDOG_MS);
    const exp=Number(tokenExpiresAt())||0;
    if(exp>0){const ms=Math.max(60000,exp*1000-TOKEN_MARGIN_S*1000-now());tokenTimer=setTimer(()=>{tokenTimer=null;if(my===gen)scheduleRestart('TOKEN_ROTATE',{immediate:true});},ms);}
  }
  return Object.freeze({
    watchTasks({key:k,limit,next,error}){
      if(k!==key)fail('LISTENER_KEY');if(limit!==listenerQuery(key,'push').limit)fail('LISTENER_LIMIT');
      if(nextFn)fail('LISTEN_ALREADY_WATCHING');
      nextFn=next;errorFn=error;stopped=false;void open();
      return()=>{stopped=true;gen++;clearAll();closeCall();nextFn=null;errorFn=null;};
    },
    stats:()=>Object.freeze({...stats,restartsLastHour:restarts.filter(x=>now()-x<3600000).length,restartsLastDay:restarts.length})
  });
}
