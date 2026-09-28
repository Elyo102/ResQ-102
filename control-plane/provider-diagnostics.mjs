import {pathToFileURL} from 'node:url';
import {MODELS} from './agent-cycle.mjs';
import {boundedJson} from './ci-cloud.mjs';
export async function diagnoseProviders(env,fetcher=fetch){
 const results=[];
 const specs=[{provider:'Claude',key:env.ANTHROPIC_API_KEY,url:`https://api.anthropic.com/v1/models/${MODELS.Claude}`,headers:{'x-api-key':env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},field:'id',expected:MODELS.Claude},
  {provider:'Gemini',key:env.GEMINI_API_KEY,url:`https://generativelanguage.googleapis.com/v1beta/models/${MODELS.Gemini}`,headers:{'x-goog-api-key':env.GEMINI_API_KEY},field:'name',expected:'models/'+MODELS.Gemini}];
 for(const s of specs){
  if(!s.key){results.push({provider:s.provider,status:'not_configured',modelAvailable:null});continue;}
  try{
   const r=await boundedJson(fetcher,s.url,{method:'GET',headers:s.headers});
   results.push({provider:s.provider,status:200,modelAvailable:typeof r?.[s.field]==='string'?r[s.field]===s.expected:null});
  }catch(e){results.push({provider:s.provider,status:Number.isInteger(e.status)&&e.status>=400&&e.status<=599?e.status:'transport_or_response_unknown',modelAvailable:null});}
 }
 return results;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.env.GITHUB_REPOSITORY!=='Elyo102/ResQ-102'||process.env.GITHUB_REF!=='refs/heads/dev'
  ||process.env.TELEMETRY_APPROVED_SHA!==process.env.GITHUB_SHA||!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA||'')||process.env.TEST_RESULT!=='success'){
  console.error('DIAGNOSTIC_GATE_DENIED');process.exitCode=1;
 }else diagnoseProviders(process.env).then(results=>console.log(JSON.stringify({mode:'diagnostics_only',results}))).catch(()=>{console.error('DIAGNOSTIC_FAILED');process.exitCode=1;});
}
