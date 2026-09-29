import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {boundedJson} from './ci-cloud.mjs';
import {operationId} from './atomic-budget.mjs';
import {isProvenancedTask} from './git-provenance.mjs';
import {ACTIVATION_STATE,CYCLE_LIMITS,isBuiltTask,parseTaskResult} from './task-contracts.mjs';
export const MODELS=Object.freeze({Claude:'claude-haiku-4-5-20251001',Grok:'grok-4.7',Gemini:'gemini-3.5-flash-lite'});
const fail=code=>{throw Error(code);};
const hash=value=>createHash('sha256').update(value).digest('hex');
// Provider bodies stay in memory. Only finite diagnostic categories leave this boundary.
export async function requestProvider(fetcher,r){
 let response;
 try{response=await fetcher(r.url,{method:'POST',headers:r.headers,body:r.body,redirect:'error',signal:AbortSignal.timeout(45000)});}
 catch{throw Object.assign(Error('PROVIDER_FAILURE'),{category:'unknown'});}
 if(response.ok)return boundedJson(async()=>response,r.url,{},45000);
 const http=Number.isInteger(response.status)&&response.status>=400&&response.status<=599?response.status:null;
 let category='unknown',reader;
 try{
  reader=response.body.getReader();let size=0;const chunks=[];
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>32768)throw Error('LIMIT');chunks.push(Buffer.from(value));}
  const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!data||typeof data.error!=='object'||!data.error)throw Error('SHAPE');
  const message=typeof data.error.message==='string'?data.error.message.toLowerCase():'';
  category=http===401?'auth':http===403?'permission':http===404?'model':http===429?'rate_limit':http>=500?'provider_failure':http===400?'invalid_request':'unknown';
  if([400,402,429].includes(http)&&/credit balance|insufficient credits|billing|quota/.test(message))category='credit_or_quota_hint';
 }catch{/* Unknown body is not evidence of a specific provider cause. */}
 finally{try{await reader?.cancel();}catch{}}
 throw Object.assign(Error('PROVIDER_FAILURE'),{category,http});
}
export function providerRequest(agent,env,task){
 if(!isBuiltTask(task)||task.agent!==agent)fail('INVALID_TASK_CONTRACT');
 const prompt=task.prompt,maxTokens=task.maxOutputTokens;
 const model=MODELS[agent],headers={'Content-Type':'application/json'};let url,body,extract;
 if(agent==='Claude'){
  if(!env.ANTHROPIC_API_KEY)fail('PROVIDER_NOT_CONFIGURED');
  headers['x-api-key']=env.ANTHROPIC_API_KEY;headers['anthropic-version']='2023-06-01';
  url='https://api.anthropic.com/v1/messages';
  body={model,max_tokens:maxTokens,messages:[{role:'user',content:prompt}]};
  extract=r=>r.content?.filter(p=>p.type==='text').map(p=>p.text).join('');
 }else if(agent==='Grok'){
  if(!env.XAI_API_KEY)fail('PROVIDER_NOT_CONFIGURED');
  headers.Authorization='Bearer '+env.XAI_API_KEY;url='https://api.x.ai/v1/responses';
  // Responses max_output_tokens includes reasoning. Chat Completions does not.
  body={model,input:prompt,max_output_tokens:maxTokens,reasoning:{effort:'low'},store:false};
  extract=r=>r.output?.filter(p=>p.type==='message').flatMap(p=>p.content||[]).filter(p=>p.type==='output_text').map(p=>p.text).join('');
 }else if(agent==='Gemini'){
  if(!env.GEMINI_API_KEY)fail('PROVIDER_NOT_CONFIGURED');
  headers['x-goog-api-key']=env.GEMINI_API_KEY;
  url=`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  body={contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{maxOutputTokens:maxTokens,thinkingConfig:{thinkingLevel:'minimal'}}};
  extract=r=>r.candidates?.[0]?.content?.parts?.filter(p=>!p.thought).map(p=>p.text||'').join('');
 }else fail('UNKNOWN_PROVIDER');
 const serialized=JSON.stringify(body);
 if(Buffer.byteLength(serialized)>12000)fail('TASK_REQUEST_LIMIT');
 return {model,url,headers,body:serialized,extract};
}
// Do not enable this entry point by environment flags or mock capability objects.
// Tracked durable grant bounds + Rules/client task allowlists must be reviewed
// and integrated first. No cloud credential exchange, telemetry or paid fetch.
export async function runCycle(){fail(ACTIVATION_STATE);}

// Validated local integration entry; remains dependency-injected, never CLI-bound.
export async function runVerifiedLocalCycle(args){
 if(!args?.tasks||Object.keys(args.tasks).length!==3||['Claude','Grok','Gemini'].some(a=>!isProvenancedTask(args.tasks[a])))fail('SOURCE_PROVENANCE_REJECTED');
 return runLocalCycle(args);
}

// Dependency-injected local contract harness. No live defaults, no CLI binding.
// Its capabilities are simulated evidence, never an activation authorization.
export async function runLocalCycle({env,tasks,connect,budgetFactory,fetcher,capabilities}){
 if(capabilities?.atomicGrant!==true||capabilities?.maxCycleMicroUsd!==750000
  ||capabilities?.maxReservations!==3||capabilities?.providerMicroUsd!==250000
  ||capabilities?.taskAllowlist!==true||[connect,budgetFactory,fetcher].some(f=>typeof f!=='function'))fail(ACTIVATION_STATE);
 env=Object.freeze({...env});
 if(env.GITHUB_REPOSITORY!=='Elyo102/ResQ-102'||env.GITHUB_REF!=='refs/heads/dev'
  ||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||'')||env.TELEMETRY_APPROVED_SHA!==env.GITHUB_SHA
  ||!['push','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)||env.TEST_RESULT!=='success')fail('UNAPPROVED_AGENT_CYCLE');
 // Check all required configuration before connecting or reserving any money.
 if(env.AGENT_SCOPE!==undefined)fail('INVALID_AGENT_SCOPE');
 const authorizationId=env.TELEMETRY_AUTHORIZATION_ID,approvedSha=env.TELEMETRY_APPROVED_SHA,principal=env.TELEMETRY_BUDGET_PRINCIPAL;
 if(!/^[A-Za-z0-9-]{8,64}$/.test(authorizationId||'')||principal!=='resq-ci-budget-20260928')fail('INVALID_BUDGET_AUTHORIZATION');
 const selected=['Claude','Grok','Gemini'];
 if(!tasks||Object.keys(tasks).length!==3||selected.some(a=>!isBuiltTask(tasks[a])||tasks[a].sha!==env.GITHUB_SHA))fail('INVALID_TASK_CONTRACT');
 const requests=Object.fromEntries(selected.map(agent=>[agent,providerRequest(agent,env,tasks[agent])]));
 const budgetTransport=await connect({refreshToken:env.FIREBASE_BUDGET_REFRESH_TOKEN,uid:principal,principal,authorizationId,approvedSha,budget:true,fetcher});
 const budget=budgetFactory({transport:budgetTransport,authorizationId,approvedSha,principal});
 const agents={};
 for(const agent of ['Codex',...selected]){
  const refreshToken=agent==='Codex'?env.FIREBASE_TELEMETRY_REFRESH_TOKEN:env[`FIREBASE_${agent.toUpperCase()}_REFRESH_TOKEN`];
  agents[agent]=await connect({refreshToken,uid:`resq-ci-${agent.toLowerCase()}-20260928`,agent,fetcher});
 }
 await agents.Codex.emit('heartbeat','running','agent_review_cycle');await agents.Codex.emit('task_started','started','agent_review_cycle');
 const results=[];
 let reservedMicroUsd=0,reservations=0;
 for(const agent of selected){
  let stage='telemetry';
  try{
   const task=tasks[agent],r=requests[agent],id=operationId(authorizationId,agent),requestDigest=hash(r.body);
   stage='budget';
   if(reservations>=CYCLE_LIMITS.reservations||reservedMicroUsd+CYCLE_LIMITS.providerMicroUsd>CYCLE_LIMITS.totalMicroUsd)fail('CYCLE_CAP');
   reservations++;reservedMicroUsd+=CYCLE_LIMITS.providerMicroUsd; // Unknown reservation is never refunded/retried.
   const permit=await budget.reserveRequest({id,provider:agent,task:task.label,model:r.model,requestDigest,requestBody:r.body,maxOutputTokens:task.maxOutputTokens});
   if(permit?.dispatch!==true||permit.id!==id||permit.requestDigest!==requestDigest)fail('BUDGET_DENIED');
   const consumed=budget.assertDispatch(permit);
   if(consumed!==true){
    if(consumed&&typeof consumed.then==='function')void Promise.resolve(consumed).catch(()=>{});
    fail('BUDGET_DENIED');
   }
   // No await between permit consumption and provider fetch. Immediately handle
   // both telemetry promises; their failure cannot become unhandled or completed.
   const signal=(kind,step)=>{try{return Promise.resolve(agents[agent].emit(kind,step,task.label)).then(()=>true,()=>false);}catch{return Promise.resolve(false);}};
   const started=[signal('heartbeat','running'),signal('task_started','started')];
   stage='provider';
   const response=await requestProvider(fetcher,r);
   const review=parseTaskResult(r.extract(response),task);
   if((await Promise.all(started)).some(ok=>!ok))fail('TELEMETRY_DELIVERY_UNKNOWN');
   stage='telemetry';await agents[agent].emit('task_completed','completed',task.label);
   results.push({agent,task:task.label,status:'completed',review,inputDigest:task.inputDigest,responseDigest:hash(JSON.stringify(review))});
  }catch(error){
   try{await agents[agent].emit('task_failed','failed',tasks[agent].label);}catch{/* failure remains failure even if telemetry is unavailable */}
   const category=['auth','permission','model','rate_limit','provider_failure','invalid_request','credit_or_quota_hint'].includes(error.category)?error.category:'unknown';
   results.push({agent,task:tasks[agent].label,status:'failed',stage,category,http:Number.isInteger(error.http)&&error.http>=400&&error.http<=599?error.http:null});
  }
 }
 const success=results.every(r=>r.status==='completed');
 await agents.Codex.emit(success?'task_completed':'task_failed',success?'completed':'failed','agent_review_cycle');
 return {status:success?'completed':'partial',results};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 runCycle({env:process.env}).then(result=>{console.log(JSON.stringify(result));if(result.status!=='completed')process.exitCode=1;})
  .catch(()=>{console.error('AGENT_CYCLE_INCOMPLETE');process.exitCode=1;});
}
