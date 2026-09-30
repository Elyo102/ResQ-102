// Active-task listener runner (LD only). MANUAL foreground start by the owner, one window per agent:
//   node control-plane\task-listener-run.mjs --agent Grok            (push mode, gRPC Listen; default)
//   node control-plane\task-listener-run.mjs --agent Grok --mode poll (rollback: REST poll every 120 s, ack forced off)
// A1 (amended, push-trigger design section 4): the ONLY autonomous action is auto-read + an ack with a summary of at
// most 280 characters, by a listener the owner started in the foreground. Everything else needs a session the owner
// opened plus an explicit go. "הבנתי" is not a go. A2 unchanged: never approval for push, deploy, delete or secrets.
// This process acknowledges tasks (READY/delivered | READY/delivery_off | REJECTED for EXECUTE targets), optionally
// writes the raw payload to the hardened inbox (delivery:true), and with ack:true (default false) writes
// acks[own key] = LIT -> UNDERSTOOD|UNREADABLE with a sanitized summary from the no-tools summarizer (S1), or
// UNREADABLE without any model call (S0: no LLM key). It never executes, spawns, evaluates or forwards a task.
// Fail-closed startup: FIRST an unsafe TLS/proxy/GRPC_* environment is refused (UNSAFE_ENV, names only), then the
// secret env is scrubbed; fixed agent (Grok|Codex); config + credential (+ LLM key) from
// %USERPROFILE%\.resq-listeners (DPAPI and ACL checks); the ID token verified BEFORE anything is read or written.
// Stops on Ctrl+C, a dead credential, PERMISSION_DENIED on the stream (ACL_DENIED) or on 2 heartbeats in a row,
// the stream restart cap (no automatic fallback to poll), or MAX_POLL_FAILURES failed polls (poll mode).
// Stdout: counters only. Never a payload, a summary, a token, a key or a response body. No autostart/service/task.
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createListener,validateConfig,HEARTBEAT_MS} from './task-listener.mjs';
import {createInbox} from './task-inbox.mjs';
import {LISTENER_AGENTS,PROJECT,createTokenSource,fail,safeCode} from './listener/listener-auth.mjs';
import {createFirestoreClient,createListenerOps,firestoreBase,POLL_MS} from './listener/firestore-rest.mjs';
import {createListenWatch} from './listener/firestore-listen.mjs';
import {createSummarizer} from './listener/summarizer.mjs';
import {createCredentialStore} from './listener/credential-store.mjs';
import {createWindowsProtector} from './listener/win-protect.mjs';
import {scrubSecretEnv,unsafeEnvNames} from './listener/env-scrub.mjs';
// grpc-transport (and with it @grpc/grpc-js, whose tls-helpers read GRPC_* env at import time) is loaded ONLY by the
// dynamic import below, i.e. after main() has refused an unsafe environment (condition 1, 25572dc code review).
const loadGrpcTransport=()=>import('./listener/grpc-transport.mjs');

export const MAX_POLL_FAILURES=5;
export const MAX_HEARTBEAT_DENIALS=2;
export const STATUS_MS=60000;
export const EXIT=Object.freeze({OK:0,STARTUP:1,CREDENTIAL_DEAD:2,POLL_FAILURES:3,STREAM_RESTARTS:4,ACL_DENIED:5});
const MODES=['push','poll'];

// deps: {mode:'production'|'emulator', projectId, emulatorHost?, store, fetcher, getCerts?, now?, pollMs?, statusMs?,
//        setTimer?, clearTimer?, heartbeatTimer?: {setTimer, clearTimer}, grpc? (push), listenTimers?, llmFetcher?, out(line)}
export async function startRunner({agent,listen='push',deps}){
  if(!Object.hasOwn(LISTENER_AGENTS,agent))fail('RUNNER_AGENT_REJECTED');
  if(!MODES.includes(listen))fail('RUNNER_MODE_REJECTED');
  const {mode,projectId,store,fetcher,out}=deps;
  const setT=deps.setTimer??setInterval,clearT=deps.clearTimer??clearInterval;
  const raw=store.readConfig(agent);
  const ackWanted=raw.ack===true&&listen==='push';          // poll (rollback) forces ack off
  const rawConfig={agent,machine:'LD',inboxRoot:raw.inboxRoot,delivery:raw.delivery,ack:ackWanted};
  const config=validateConfig(rawConfig);
  const cred=store.readCredential(agent);
  if(cred.agent!==agent||cred.projectId!==projectId)fail('CREDENTIAL_MISMATCH');
  // S1 only with a stored key; otherwise S0 (UNREADABLE without a model call). The key object never leaves here.
  let summarizer=null;
  if(ackWanted&&store.hasLlmKey(agent))summarizer=createSummarizer({llm:store.readLlmKey(agent),fetcher:deps.llmFetcher??fetcher,now:deps.now});
  const tokens=createTokenSource({mode,projectId,uid:cred.uid,agent,refreshToken:cred.refreshToken,fetcher,now:deps.now,getCerts:deps.getCerts});
  await tokens.getIdToken();                                     // verified before any Firestore access
  if(tokens.authTime<cred.revokedAfter)fail('CREDENTIAL_OLDER_THAN_REVOCATION');
  const inbox=config.delivery?createInbox({root:config.inboxRoot,agentKey:config.key}):null;
  const client=createFirestoreClient({base:firestoreBase({mode,projectId,emulatorHost:deps.emulatorHost}),projectId,token:()=>tokens.getIdToken(),fetcher});
  let failures=0,lastCode=null,hbDenied=0,fatalCode=null;
  let stopFn=null;const pending=[];
  const onFatal=code=>{fatalCode=code;if(stopFn)void stopFn(code==='ACL_DENIED'?EXIT.ACL_DENIED:EXIT.STREAM_RESTARTS,code.toLowerCase());else pending.push(code);};
  const restOps=createListenerOps({client,key:config.key,pollMs:deps.pollMs??POLL_MS,setTimer:setT,clearTimer:clearT,
    onPoll:(ok,e)=>{if(ok){failures=0;lastCode=null;}else{failures++;lastCode=safeCode(e);}}});
  let watch=null,ops=restOps,grpc=null;
  if(listen==='push'){
    grpc=deps.grpc??(await loadGrpcTransport()).createFirestoreGrpc({mode,projectId,emulatorHost:deps.emulatorHost});
    const lt=deps.listenTimers??{};
    watch=createListenWatch({grpc,projectId,key:config.key,token:()=>tokens.getIdToken(),tokenExpiresAt:()=>tokens.expiresAt,now:deps.now,
      setTimer:lt.setTimer,clearTimer:lt.clearTimer,random:lt.random,onFatal});
    ops=Object.freeze({...restOps,watchTasks:watch.watchTasks});
  }
  let ids=ackWanted?store.readLedger(agent):[];const known=new Set(ids);
  const ledger=Object.freeze({has:id=>known.has(id),add(id){if(known.has(id))return;known.add(id);ids=[...ids,id].slice(-500);store.writeLedger(agent,ids);}});
  const hb=deps.heartbeatTimer??{setTimer:setT,clearTimer:clearT};
  const onHeartbeat=(ok,e)=>{
    if(ok){hbDenied=0;return;}
    lastCode=safeCode(e);
    if(safeCode(e)==='PERMISSION_DENIED'){hbDenied++;if(hbDenied>=MAX_HEARTBEAT_DENIALS&&stopFn)void stopFn(EXIT.ACL_DENIED,'heartbeat_denied');}
  };
  // Condition 2 (no retroactive ack): cut-off = max(local clock, iat of the ID token just verified at startup = server
  // time). A local clock that runs behind cannot pull older tasks in; one that runs ahead only skips (fail safe).
  const ackSince=Math.max((deps.now??Date.now)(),(tokens.issuedAt||0)*1000);
  const listener=createListener({config:rawConfig,ops,inbox,summarizer,ledger:ackWanted?ledger:null,mode:listen,now:deps.now,
    setTimer:hb.setTimer,clearTimer:hb.clearTimer,onHeartbeat,ackSince});
  let resolveDone;const done=new Promise(r=>{resolveDone=r;});let finished=false,statusTimer=null;
  const summ=summarizer?'S1':'S0';
  const line=extra=>{
    const w=watch?watch.stats():null;
    out(JSON.stringify({...listener.status(),summarizer:ackWanted?summ:'none',pollFailures:failures,heartbeatDenied:hbDenied,lastError:lastCode,
      ...(w?{streams:w.streams,streamRestarts:w.restarts,restartsLastHour:w.restartsLastHour,restartsLastDay:w.restartsLastDay,streamCurrent:w.current,streamError:w.lastErrorCode}:{}),...extra}));
  };
  // Condition 3: restart counts (TOKEN_ROTATE included) persisted for provision-listener --status. Numbers only.
  const saveStreamStats=()=>{
    if(!watch||typeof store.writeStreamStats!=='function')return;
    const w=watch.stats();try{store.writeStreamStats(agent,{restartsLastHour:w.restartsLastHour,restartsLastDay:w.restartsLastDay,at:(deps.now??Date.now)()});}catch{}
  };
  async function stop(code,reason){
    if(finished)return;finished=true;clearT(statusTimer);await listener.stop();saveStreamStats();try{grpc?.close?.();}catch{}line({stopped:reason});resolveDone(code);
  }
  stopFn=stop;
  const check=()=>{
    if(finished)return;
    if(tokens.fatal)void stop(EXIT.CREDENTIAL_DEAD,'credential_'+tokens.fatal.toLowerCase());
    else if(fatalCode)void stop(fatalCode==='ACL_DENIED'?EXIT.ACL_DENIED:EXIT.STREAM_RESTARTS,fatalCode.toLowerCase());
    else if(listen==='poll'&&failures>=MAX_POLL_FAILURES)void stop(EXIT.POLL_FAILURES,'poll_failures');
    else if(hbDenied>=MAX_HEARTBEAT_DENIALS)void stop(EXIT.ACL_DENIED,'heartbeat_denied');
    else{line({});saveStreamStats();}
  };
  listener.start();
  line({started:true,heartbeatMs:HEARTBEAT_MS,...(listener.ackOn?{ackSince:listener.ackSince}:{}),...(listen==='poll'?{pollMs:deps.pollMs??POLL_MS}:{})});
  for(const c of pending.splice(0))onFatal(c);
  statusTimer=setT(check,deps.statusMs??STATUS_MS);
  return Object.freeze({listener,tokens,done,check,stop:()=>stop(EXIT.OK,'requested'),watch});
}

export function parseRunnerArgs(argv){
  const usage='ARGS_USAGE_--agent_Grok|Codex_[--mode_push|poll]';
  if(argv.length!==2&&argv.length!==4)fail(usage);
  if(argv[0]!=='--agent'||!Object.hasOwn(LISTENER_AGENTS,argv[1]))fail(usage);
  if(argv.length===4&&(argv[2]!=='--mode'||!MODES.includes(argv[3])))fail(usage);
  return {agent:argv[1],listen:argv.length===4?argv[3]:'push'};
}
async function main(){
  const unsafe=unsafeEnvNames();                                 // FIRST (condition 1): TLS/proxy/GRPC_* env -> refuse, names only
  if(unsafe.length){process.stderr.write(JSON.stringify({status:'FAILED',code:'UNSAFE_ENV',names:unsafe})+'\n');process.exitCode=EXIT.STARTUP;return;}
  const {childEnv}=scrubSecretEnv();                             // then: before any config, credential or key read
  if(process.platform!=='win32')fail('RUNNER_WINDOWS_ONLY');
  const {agent,listen}=parseRunnerArgs(process.argv.slice(2));
  const store=createCredentialStore({home:homedir(),protector:createWindowsProtector({baseEnv:childEnv})});
  const runner=await startRunner({agent,listen,deps:{mode:'production',projectId:PROJECT,store,fetcher:fetch,out:l=>process.stdout.write(l+'\n')}});
  for(const sig of ['SIGINT','SIGTERM','SIGBREAK'])process.on(sig,()=>{void runner.stop();});
  process.exitCode=await runner.done;
  process.exit();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(e=>{process.stderr.write(JSON.stringify({status:'FAILED',code:safeCode(e)})+'\n');process.exitCode=EXIT.STARTUP;});
}
