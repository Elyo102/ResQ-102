// Pure advisory planner. It cannot execute providers, bypass budget admission,
// change claims, or turn unknown provider quota into an available balance.
const PROVIDERS=['Claude','Grok','Gemini'];
const int=n=>Number.isSafeInteger(n)&&n>=0;
export function quotaStatus(snapshot,now){
 if(!int(now)||!snapshot||!PROVIDERS.includes(snapshot.provider)||!['tokens','requests'].includes(snapshot.unit)
  ||!int(snapshot.limit)||snapshot.limit===0||!int(snapshot.remaining)||snapshot.remaining>snapshot.limit
  ||!int(snapshot.observedAt)||snapshot.observedAt>now||now-snapshot.observedAt>60000
  ||!int(snapshot.resetAt)||snapshot.resetAt<=now)return {state:'UNKNOWN'};
 const used=snapshot.limit-snapshot.remaining;
 return {state:used/snapshot.limit>=0.8?'NEAR_LIMIT':'AVAILABLE',provider:snapshot.provider,unit:snapshot.unit,used,limit:snapshot.limit};
}
export function planHandoff({preferred,providers,chargedMicroUsd,nightBaselineMicroUsd=1500000,nightLimitMicroUsd=2000000,now}){
 if(!PROVIDERS.includes(preferred)||!int(now)||!int(chargedMicroUsd)||chargedMicroUsd>20000000
  ||!int(nightBaselineMicroUsd)||chargedMicroUsd<nightBaselineMicroUsd||!int(nightLimitMicroUsd)||nightLimitMicroUsd>2000000
  ||!Array.isArray(providers)||providers.length>3||new Set(providers.map(p=>p?.provider)).size!==providers.length
  ||providers.some(p=>!p||!PROVIDERS.includes(p.provider)))throw Error('INVALID_HANDOFF_INPUT');
 const warnings=[];
 if(chargedMicroUsd>=16000000)warnings.push('SHARED_RESERVATION_80_PERCENT');
 const nightUsed=chargedMicroUsd-nightBaselineMicroUsd;
 const blocked=chargedMicroUsd+250000>20000000||nightUsed+250000>nightLimitMicroUsd;
 const states=providers.map(p=>{
  const current=int(p.verifiedAt)&&p.verifiedAt<=now&&now-p.verifiedAt<=3600000;
  const quota=quotaStatus(p.quota,now);
  if(quota.provider&&quota.provider!==p.provider)return {provider:p.provider,state:'UNKNOWN'};
  if(p.creditBlocked===true)return {provider:p.provider,state:'UNAVAILABLE'};
  if(!current||p.connected!==true)return {provider:p.provider,state:'UNKNOWN'};
  return {provider:p.provider,state:quota.state};
 });
 for(const s of states)if(s.state==='NEAR_LIMIT')warnings.push(s.provider+'_RATE_LIMIT_80_PERCENT');
 const eligible=states.filter(s=>s.state==='AVAILABLE').map(s=>s.provider);
 const selected=blocked?null:eligible.includes(preferred)?preferred:eligible[0]??null;
 return {mode:'ADVISORY_ONLY',selected,preferred,handoff:selected!==null&&selected!==preferred,
  reason:blocked?'BUDGET_ADMISSION_REQUIRED_OR_EXHAUSTED':selected?'KNOWN_CAPACITY':'NO_KNOWN_CAPACITY',
  warnings,states,requiresAtomicReservation:true,automaticallyDispatched:false};
}
