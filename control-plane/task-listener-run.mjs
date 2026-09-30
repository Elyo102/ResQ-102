// Active-task listener runner (LD only). MANUAL foreground start by the owner, one window per agent:
//   node control-plane\task-listener-run.mjs --agent Grok
// Security review 30/09/2026 (A1/A2 unchanged): this process only acknowledges tasks (READY/delivered or
// READY/delivery_off, or REJECTED) and, with delivery:true, writes the raw payload to the hardened inbox. It never
// executes, spawns, evaluates or forwards a task, holds no AI key and never calls a model. An agent session the
// owner opens picks the task up and asks the owner for an explicit go before markStarted.
// Fail-closed startup: fixed agent (Grok|Codex), config + credential from %USERPROFILE%\.resq-listeners (DPAPI and
// ACL checks), the ID token verified (signature + listener claims) BEFORE anything is read or written.
// Stops on Ctrl+C, on a dead credential (revoked/disabled/expired), or after MAX_POLL_FAILURES failed polls in a row.
// Stdout: counters only. Never a payload, a token or a response body. No autostart, no service, no scheduled task.
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createListener,validateConfig,HEARTBEAT_MS} from './task-listener.mjs';
import {createInbox} from './task-inbox.mjs';
import {LISTENER_AGENTS,PROJECT,createTokenSource,fail,safeCode} from './listener/listener-auth.mjs';
import {createFirestoreClient,createListenerOps,firestoreBase,POLL_MS} from './listener/firestore-rest.mjs';
import {createCredentialStore} from './listener/credential-store.mjs';
import {createWindowsProtector} from './listener/win-protect.mjs';

export const MAX_POLL_FAILURES=5;
export const STATUS_MS=60000;
export const EXIT=Object.freeze({OK:0,STARTUP:1,CREDENTIAL_DEAD:2,POLL_FAILURES:3});

// deps: {mode, projectId, emulatorHost?, store, fetcher, getCerts?, now?, pollMs?, statusMs?, setTimer?, clearTimer?,
//        heartbeatTimer?: {setTimer, clearTimer}, out(line)}
export async function startRunner({agent,deps}){
  if(!Object.hasOwn(LISTENER_AGENTS,agent))fail('RUNNER_AGENT_REJECTED');
  const {mode,projectId,store,fetcher,out}=deps;
  const setT=deps.setTimer??setInterval,clearT=deps.clearTimer??clearInterval;
  const raw=store.readConfig(agent);
  const rawConfig={agent,machine:'LD',inboxRoot:raw.inboxRoot,delivery:raw.delivery};
  const config=validateConfig(rawConfig);
  const cred=store.readCredential(agent);
  if(cred.agent!==agent||cred.projectId!==projectId)fail('CREDENTIAL_MISMATCH');
  const tokens=createTokenSource({mode,projectId,uid:cred.uid,agent,refreshToken:cred.refreshToken,fetcher,now:deps.now,getCerts:deps.getCerts});
  await tokens.getIdToken();                                     // verified before any Firestore access
  if(tokens.authTime<cred.revokedAfter)fail('CREDENTIAL_OLDER_THAN_REVOCATION');
  const inbox=config.delivery?createInbox({root:config.inboxRoot,agentKey:config.key}):null;
  const client=createFirestoreClient({base:firestoreBase({mode,projectId,emulatorHost:deps.emulatorHost}),projectId,token:()=>tokens.getIdToken(),fetcher});
  let failures=0,lastCode=null;
  const ops=createListenerOps({client,key:config.key,pollMs:deps.pollMs??POLL_MS,setTimer:setT,clearTimer:clearT,
    onPoll:(ok,e)=>{if(ok){failures=0;lastCode=null;}else{failures++;lastCode=safeCode(e);}}});
  const hb=deps.heartbeatTimer??{setTimer:setT,clearTimer:clearT};
  const listener=createListener({config:rawConfig,ops,inbox,setTimer:hb.setTimer,clearTimer:hb.clearTimer});
  let resolveDone;const done=new Promise(r=>{resolveDone=r;});let finished=false,statusTimer=null;
  const line=extra=>out(JSON.stringify({...listener.status(),pollFailures:failures,lastError:lastCode,...extra}));
  async function stop(code,reason){
    if(finished)return;finished=true;clearT(statusTimer);await listener.stop();line({stopped:reason});resolveDone(code);
  }
  const check=()=>{
    if(finished)return;
    if(tokens.fatal)void stop(EXIT.CREDENTIAL_DEAD,'credential_'+tokens.fatal.toLowerCase());
    else if(failures>=MAX_POLL_FAILURES)void stop(EXIT.POLL_FAILURES,'poll_failures');
    else line({});
  };
  listener.start();
  line({started:true,heartbeatMs:HEARTBEAT_MS,pollMs:deps.pollMs??POLL_MS});
  statusTimer=setT(check,deps.statusMs??STATUS_MS);
  return Object.freeze({listener,tokens,done,check,stop:()=>stop(EXIT.OK,'requested')});
}

export function parseRunnerArgs(argv){
  if(argv.length!==2||argv[0]!=='--agent'||!Object.hasOwn(LISTENER_AGENTS,argv[1]))fail('ARGS_USAGE_--agent_Grok|Codex');
  return {agent:argv[1]};
}
async function main(){
  if(process.platform!=='win32')fail('RUNNER_WINDOWS_ONLY');
  const {agent}=parseRunnerArgs(process.argv.slice(2));
  const store=createCredentialStore({home:homedir(),protector:createWindowsProtector()});
  const runner=await startRunner({agent,deps:{mode:'production',projectId:PROJECT,store,fetcher:fetch,out:l=>process.stdout.write(l+'\n')}});
  for(const sig of ['SIGINT','SIGTERM','SIGBREAK'])process.on(sig,()=>{void runner.stop();});
  process.exitCode=await runner.done;
  process.exit();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(e=>{process.stderr.write(JSON.stringify({status:'FAILED',code:safeCode(e)})+'\n');process.exitCode=EXIT.STARTUP;});
}
