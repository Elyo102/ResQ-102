import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {connectCloud,boundedJson} from './ci-cloud.mjs';
import {createAtomicBudget} from './atomic-budget.mjs';
export const MODELS=Object.freeze({Claude:'claude-haiku-4-5-20251001',Grok:'grok-4.7',Gemini:'gemini-2.5-flash'});
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
// Fixed, public technical material only. No repository secrets, user records,
// untrusted PR code or arbitrary prompts enter this activation check.
const prompt='Review this ResQ agent budget contract. Atomic reservations charge a shared monthly USD20 ledger before each paid API call. Reservations are immutable, scoped by request digest, never refunded after uncertain delivery, and have a short single-use dispatch deadline. Separate Firebase identities publish structured status events. Identify one important remaining reliability risk and one mitigation, in at most 100 words. This is a connectivity/design review, not evidence that you ran tests or approved deployment.';
export function providerRequest(agent,env){
 const model=MODELS[agent],headers={'Content-Type':'application/json'};let url,body,extract;
 if(agent==='Claude'){
  if(!env.ANTHROPIC_API_KEY)fail('PROVIDER_NOT_CONFIGURED');
  headers['x-api-key']=env.ANTHROPIC_API_KEY;headers['anthropic-version']='2023-06-01';
  url='https://api.anthropic.com/v1/messages';
  body={model,max_tokens:2200,messages:[{role:'user',content:prompt}]};
  extract=r=>r.content?.filter(p=>p.type==='text').map(p=>p.text).join('');
 }else if(agent==='Grok'){
  if(!env.XAI_API_KEY)fail('PROVIDER_NOT_CONFIGURED');
  headers.Authorization='Bearer '+env.XAI_API_KEY;url='https://api.x.ai/v1/responses';
  // Responses max_output_tokens includes reasoning. Chat Completions does not.
  body={model,input:prompt,max_output_tokens:2200,reasoning:{effort:'low'},store:false};
  extract=r=>r.output?.filter(p=>p.type==='message').flatMap(p=>p.content||[]).filter(p=>p.type==='output_text').map(p=>p.text).join('');
 }else if(agent==='Gemini'){
  if(!env.GEMINI_API_KEY)fail('PROVIDER_NOT_CONFIGURED');
  headers['x-goog-api-key']=env.GEMINI_API_KEY;
  url=`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  body={contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{maxOutputTokens:2200,thinkingConfig:{thinkingBudget:0}}};
  extract=r=>r.candidates?.[0]?.content?.parts?.filter(p=>!p.thought).map(p=>p.text||'').join('');
 }else fail('UNKNOWN_PROVIDER');
 return {model,url,headers,body:JSON.stringify(body),extract};
}
export async function runCycle({env,connect=connectCloud,budgetFactory=createAtomicBudget,fetcher=fetch}){
 env=Object.freeze({...env});
 if(env.GITHUB_REPOSITORY!=='Elyo102/ResQ-102'||env.GITHUB_REF!=='refs/heads/dev'
  ||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||'')||env.TELEMETRY_APPROVED_SHA!==env.GITHUB_SHA
  ||!['push','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)||env.TEST_RESULT!=='success')fail('UNAPPROVED_AGENT_CYCLE');
 // Check all required configuration before connecting or reserving any money.
 if(env.AGENT_SCOPE!==undefined&&env.AGENT_SCOPE!=='failed-provider-diagnostic')fail('INVALID_AGENT_SCOPE');
 const selected=env.AGENT_SCOPE==='failed-provider-diagnostic'?['Claude','Gemini']:['Claude','Grok','Gemini'];
 const requests=Object.fromEntries(selected.map(agent=>[agent,providerRequest(agent,env)]));
 const budgetTransport=await connect({refreshToken:env.FIREBASE_BUDGET_REFRESH_TOKEN,uid:'resq-ci-budget-20260928',budget:true,fetcher});
 const budget=budgetFactory({transport:budgetTransport});
 const agents={};
 for(const agent of ['Codex',...selected]){
  const refreshToken=agent==='Codex'?env.FIREBASE_TELEMETRY_REFRESH_TOKEN:env[`FIREBASE_${agent.toUpperCase()}_REFRESH_TOKEN`];
  agents[agent]=await connect({refreshToken,uid:`resq-ci-${agent.toLowerCase()}-20260928`,agent,fetcher});
 }
 await agents.Codex.emit('heartbeat','running');await agents.Codex.emit('task_started','started');
 const results=[];
 for(const agent of selected){
  let stage='telemetry';
  try{
   const r=requests[agent],id=hash(`${env.AGENT_SCOPE?'failed-provider-diagnostic-v1':'activation-v1'}:${env.GITHUB_SHA}:${agent}`),requestDigest=hash(r.body);
   // Worker is genuinely running; no assertion that its provider has replied yet.
   await agents[agent].emit('heartbeat','running');await agents[agent].emit('task_started','started');
   stage='budget';const permit=await budget.reserveRequest({id,provider:agent,model:r.model,requestDigest,requestBody:r.body,maxOutputTokens:2200});
   budget.assertDispatch(permit); // Single use, immediately before network dispatch.
   stage='provider';const response=await requestProvider(fetcher,r);
   const answer=r.extract(response);
   if(typeof answer!=='string'||!answer.trim()||Buffer.byteLength(answer)>24000)fail('INVALID_PROVIDER_RESULT');
   stage='telemetry';await agents[agent].emit('task_completed','completed');results.push({agent,status:'completed'});
  }catch(error){
   try{await agents[agent].emit('task_failed','failed');}catch{/* failure remains failure even if telemetry is unavailable */}
   const category=['auth','permission','model','rate_limit','provider_failure','invalid_request','credit_or_quota_hint'].includes(error.category)?error.category:'unknown';
   results.push({agent,status:'failed',stage,category,http:Number.isInteger(error.http)&&error.http>=400&&error.http<=599?error.http:null});
  }
 }
 const success=results.every(r=>r.status==='completed');
 await agents.Codex.emit(success?'task_completed':'task_failed',success?'completed':'failed');
 return {status:success?'completed':'partial',results};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 runCycle({env:process.env}).then(result=>{console.log(JSON.stringify(result));if(result.status!=='completed')process.exitCode=1;})
  .catch(()=>{console.error('AGENT_CYCLE_INCOMPLETE');process.exitCode=1;});
}
