import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {connectCloud,boundedJson} from './ci-cloud.mjs';
import {createAtomicBudget} from './atomic-budget.mjs';
export const MODELS=Object.freeze({Claude:'claude-haiku-4-5-20251001',Grok:'grok-4.7',Gemini:'gemini-2.5-flash'});
const fail=code=>{throw Error(code);};
const hash=value=>createHash('sha256').update(value).digest('hex');
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
 const requests=Object.fromEntries(['Claude','Grok','Gemini'].map(agent=>[agent,providerRequest(agent,env)]));
 const budgetTransport=await connect({refreshToken:env.FIREBASE_BUDGET_REFRESH_TOKEN,uid:'resq-ci-budget-20260928',budget:true,fetcher});
 const budget=budgetFactory({transport:budgetTransport});
 const agents={};
 for(const agent of ['Codex','Claude','Grok','Gemini']){
  const refreshToken=agent==='Codex'?env.FIREBASE_TELEMETRY_REFRESH_TOKEN:env[`FIREBASE_${agent.toUpperCase()}_REFRESH_TOKEN`];
  agents[agent]=await connect({refreshToken,uid:`resq-ci-${agent.toLowerCase()}-20260928`,agent,fetcher});
 }
 await agents.Codex.emit('heartbeat','running');await agents.Codex.emit('task_started','started');
 const results=[];
 for(const agent of ['Claude','Grok','Gemini']){
  try{
   const r=requests[agent],id=hash(`activation-v1:${env.GITHUB_SHA}:${agent}`),requestDigest=hash(r.body);
   // Worker is genuinely running; no assertion that its provider has replied yet.
   await agents[agent].emit('heartbeat','running');await agents[agent].emit('task_started','started');
   const permit=await budget.reserveRequest({id,provider:agent,model:r.model,requestDigest,requestBody:r.body,maxOutputTokens:2200});
   budget.assertDispatch(permit); // Single use, immediately before network dispatch.
   const response=await boundedJson(fetcher,r.url,{method:'POST',headers:r.headers,body:r.body},45000);
   const answer=r.extract(response);
   if(typeof answer!=='string'||!answer.trim()||Buffer.byteLength(answer)>24000)fail('INVALID_PROVIDER_RESULT');
   await agents[agent].emit('task_completed','completed');results.push({agent,status:'completed'});
  }catch{
   try{await agents[agent].emit('task_failed','failed');}catch{/* failure remains failure even if telemetry is unavailable */}
   results.push({agent,status:'failed'});
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
