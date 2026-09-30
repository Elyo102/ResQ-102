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
// %USERPROFILE%\AppData\Local\resq-listeners (DPAPI and ACL checks); the ID token verified BEFORE anything is read or written.
// ACL hardening (acl-hardening-verdicts.md): os.homedir() must equal os.userInfo().homedir (HOME_MISMATCH); ONE aclMany
// check of the store folder + files runs FIRST (before any config/credential read and before the first heartbeat) and
// again on every status tick; with delivery on, the inbox write integrity too (INBOX_ACL_WRITABLE). A finding, or two
// failed checks in a row, stops the runner at once with EXIT.LOCAL_ACL (6): no further heartbeat (the card goes to
// "מנותק"), a stdout stopped line with the code only (no SID, no path), ONE Hebrew line on stderr for the owner (path,
// SID, right, fix, exit 6; never a secret or file content). No automatic repair and no automatic restart, ever.
// Stops on Ctrl+C, a dead credential, PERMISSION_DENIED on the stream (ACL_DENIED) or on 2 heartbeats in a row,
// the stream restart cap (no automatic fallback to poll), or MAX_POLL_FAILURES failed polls (poll mode).
// Stdout: counters only. Never a payload, a summary, a token, a key or a response body. No autostart/service/task.
import {homedir,userInfo} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createListener,validateConfig,HEARTBEAT_MS} from './task-listener.mjs';
import {createInbox} from './task-inbox.mjs';
import {LISTENER_AGENTS,PROJECT,createTokenSource,fail,safeCode} from './listener/listener-auth.mjs';
import {createFirestoreClient,createListenerOps,firestoreBase,POLL_MS} from './listener/firestore-rest.mjs';
import {createListenWatch} from './listener/firestore-listen.mjs';
import {createSummarizer} from './listener/summarizer.mjs';
import {createCredentialStore} from './listener/credential-store.mjs';
import {createWindowsProtector,rightsName} from './listener/win-protect.mjs';
import {scrubSecretEnv,unsafeEnvNames} from './listener/env-scrub.mjs';
// grpc-transport (and with it @grpc/grpc-js, whose tls-helpers read GRPC_* env at import time) is loaded ONLY by the
// dynamic import below, i.e. after main() has refused an unsafe environment (condition 1, 25572dc code review).
const loadGrpcTransport=()=>import('./listener/grpc-transport.mjs');

export const MAX_POLL_FAILURES=5;
export const MAX_HEARTBEAT_DENIALS=2;
export const STATUS_MS=60000;
export const EXIT=Object.freeze({OK:0,STARTUP:1,CREDENTIAL_DEAD:2,POLL_FAILURES:3,STREAM_RESTARTS:4,ACL_DENIED:5,LOCAL_ACL:6});
export const MAX_ACL_CHECK_FAILURES=2;   // security: one transient failure of the check itself is tolerated, two in a row stop
// UI condition 2 (+ UI code review of 8a54571, A and recommendation 1): ONE local line on stderr / the runner log.
// ASCII facts first (code=... path="..." sid=... right=...), then the copyable fix, then the Hebrew text. No middle dot and
// no bidi control characters, so the command can be copied as is. A command is printed only for a real SID (^S-1-) on a
// known Allow/Deny rule: /remove:g for Allow, /remove:d for Deny. Path, SID and right are local facts for the owner; they
// never reach stdout counters or Firestore. Never a secret or file content.
const STOP_SID=/^S-1-[0-9]+(-[0-9]+)+$/;
const STOP_PATH=/^(?:[A-Za-z]:\\|\/)[^"\r\n]*$/;   // absolute (Windows drive or POSIX for tests), no quote or line break
const NO_COMMAND_CODES=Object.freeze(['ACL_OWNER','ACL_EMPTY','ACL_NO_ALLOW','ACL_UNKNOWN_USER','ACL_SCHEMA','ACL_INHERITANCE']);
export function aclStopLine(f){
  const code=typeof f?.code==='string'&&/^[A-Z_]{1,40}$/.test(f.code)?f.code:'ACL_CHECK_FAILED';
  const path=typeof f?.path==='string'&&STOP_PATH.test(f.path)?f.path:null;
  const sid=typeof f?.sid==='string'&&STOP_SID.test(f.sid)?f.sid:null;
  const type=f?.type==='Allow'||f?.type==='Deny'?f.type:null;
  const facts=`code=${code}${path?` path="${path}"`:''} sid=${sid??'-'} right=${rightsName(f?.mask)}`;
  const watch=`acl-watch.ps1 -Path "${path??'<folder>'}"`;
  let fix,he;
  if(code==='ACL_CHECK_FAILED'){
    fix=`fix: run ${watch}, then --status, and send the output`;
    he='בדיקת ההרשאות של תיקיית המאזין נכשלה פעמיים ברציפות. מריצים את acl-watch.ps1 ואת --status ושולחים את הפלט.';
  }else if(sid&&type&&path&&!NO_COMMAND_CODES.includes(code)){
    const cmd=`icacls "${path}" ${type==='Deny'?'/remove:d':'/remove:g'} *${sid}`;
    if(code==='INBOX_ACL_WRITABLE'){fix=`fix (after a manual check): ${cmd} then restart by hand`;
      he='הרשאת כתיבה זרה על תיבת הדואר. לא מתקנים אוטומטית: בודקים ידנית, מסירים אותה בפקודה שבשורה ומפעילים מחדש ידנית.';}
    else{fix=`fix (after a manual check): ${cmd} then --rotate`;
      he='הרשאה זרה על תיקיית המאזין. לא מתקנים אוטומטית: בודקים עם acl-watch.ps1, מסירים אותה בפקודה שבשורה ואז --rotate.';}
  }else if(code==='INBOX_ACL_WRITABLE'){
    fix=`fix: check with ${watch}, fix by hand, then restart by hand`;
    he='הבעלות או ההרשאות של תיבת הדואר לא תקינות. בודקים עם acl-watch.ps1, מתקנים ידנית ומפעילים מחדש ידנית.';
  }else{
    fix='fix: check with acl-watch.ps1, then --rotate';
    he='הרשאות תיקיית המאזין לא תקינות. בודקים עם acl-watch.ps1 ואז --rotate.';
  }
  return `ResQ listener stopped (exit 6) ${facts} ${fix} | המאזין נעצר (exit 6). ${he} אין הפעלה מחדש אוטומטית.`;
}
const MODES=['push','poll'];

// deps: {mode:'production'|'emulator', projectId, emulatorHost?, store, fetcher, getCerts?, now?, pollMs?, statusMs?,
//        setTimer?, clearTimer?, heartbeatTimer?: {setTimer, clearTimer}, grpc? (push), listenTimers?, llmFetcher?, out(line)}
export async function startRunner({agent,listen='push',deps}){
  if(!Object.hasOwn(LISTENER_AGENTS,agent))fail('RUNNER_AGENT_REJECTED');
  if(!MODES.includes(listen))fail('RUNNER_MODE_REJECTED');
  const {mode,projectId,store,fetcher,out}=deps;
  const err=typeof deps.err==='function'?deps.err:()=>{};
  const setT=deps.setTimer??setInterval,clearT=deps.clearTimer??clearInterval;
  // FIRST: the store ACL check (UI condition 1: a violating folder never shows "מאזין"; security: no secret read before
  // a passing check). A check that cannot run at startup is a startup failure (no tolerance before the first pass).
  const aclStop=f=>{err(aclStopLine(f));out(JSON.stringify({agent,stopped:f.code==='INBOX_ACL_WRITABLE'?'inbox_acl_writable':'local_acl_violation',code:f.code}));
    return Object.freeze({listener:null,tokens:null,done:Promise.resolve(EXIT.LOCAL_ACL),check:()=>{},stop:async()=>{},watch:null});};
  const f0=store.verify();
  if(f0)return aclStop(f0);
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
  const inbox=config.delivery?createInbox({root:config.inboxRoot,agentKey:config.key,aclCheck:paths=>store.inboxFinding(paths)}):null;
  if(inbox){const fi=store.inboxFinding(inbox.aclPaths());if(fi)return aclStop(fi);}
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
  async function stop(code,reason,extra={}){
    if(finished)return;finished=true;clearT(statusTimer);await listener.stop();saveStreamStats();try{grpc?.close?.();}catch{}line({stopped:reason,...extra});resolveDone(code);
  }
  stopFn=stop;
  // Per status tick (60 s): store folder + files, and the inbox when delivery is on, in ONE capped aclMany call.
  // A failed check (store OR inbox part) counts in aclFailures. true = the runner is stopping.
  let aclFailures=0;
  const aclTick=()=>{
    let f;
    try{f=store.verify({inboxPaths:inbox?inbox.aclPaths():[]});aclFailures=0;}   // ONE aclMany call (<= 20 s) per tick
    catch(e){aclFailures++;lastCode=safeCode(e);
      if(aclFailures>=MAX_ACL_CHECK_FAILURES){err(aclStopLine({code:'ACL_CHECK_FAILED',path:store.dir}));void stop(EXIT.LOCAL_ACL,'local_acl_check_failed',{code:'ACL_CHECK_FAILED'});return true;}
      return false;}
    if(!f)return false;
    err(aclStopLine(f));
    void stop(EXIT.LOCAL_ACL,f.code==='INBOX_ACL_WRITABLE'?'inbox_acl_writable':'local_acl_violation',{code:f.code});
    return true;
  };
  const check=()=>{
    if(finished)return;
    if(aclTick())return;
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
  let accountHome;try{accountHome=userInfo().homedir;}catch{fail('HOME_MISMATCH');}
  const store=createCredentialStore({home:homedir(),accountHome,protector:createWindowsProtector({baseEnv:childEnv})});
  const runner=await startRunner({agent,listen,deps:{mode:'production',projectId:PROJECT,store,fetcher:fetch,
    out:l=>process.stdout.write(l+'\n'),err:l=>process.stderr.write(l+'\n')}});
  for(const sig of ['SIGINT','SIGTERM','SIGBREAK'])process.on(sig,()=>{void runner.stop();});
  process.exitCode=await runner.done;
  process.exit();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(e=>{process.stderr.write(JSON.stringify({status:'FAILED',code:safeCode(e)})+'\n');process.exitCode=EXIT.STARTUP;});
}
