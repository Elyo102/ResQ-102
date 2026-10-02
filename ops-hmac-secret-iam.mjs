// Pure additive, etag-preserving secret-level IAM mutation plan.
export function assertIamEnvironment(env) {
  if(Object.entries(env).some(([k,v])=>v && (/EMULATOR|FIRESTORE_HOST|FIREBASE_HOST/i.test(k) || /^FIREBASE_.*(?:URL|ORIGIN|HOST)$/i.test(k) || /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|FIREBASE_TOKEN|AUTHPROXY_URL)$/i.test(k))))throw Error('IAM_ENV_OVERRIDE');
  if(env.NODE_TLS_REJECT_UNAUTHORIZED==='0' || (env.GOOGLE_CLOUD_UNIVERSE_DOMAIN && env.GOOGLE_CLOUD_UNIVERSE_DOMAIN!=='googleapis.com'))throw Error('IAM_ENV_TRANSPORT');
}
export async function boundedIamRequest(url,body,{getCredential,fetchImpl=globalThis.fetch,timeoutMs=30000}) {
  const controller=new AbortController();let timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('IAM_TIMEOUT'));},timeoutMs);});
  try{return await Promise.race([deadline,(async()=>{
    const token=await getCredential();
    if(controller.signal.aborted)throw Error('IAM_TIMEOUT');
    const response=await fetchImpl(url,{method:body?'POST':'GET',redirect:'error',signal:controller.signal,headers:{Authorization:'Bearer '+token.access_token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    if(!response.ok){await response.body?.cancel();throw Error('IAM_HTTP');}
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>1024*1024){await reader.cancel();throw Error('IAM_METADATA_LIMIT');}chunks.push(value);}}finally{reader.releaseLock();}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  })()]);}finally{clearTimeout(timer);}
}
export function planSecretAccessor(policy,member) {
  if(!policy || typeof policy.etag!=='string' || !policy.etag || !/^serviceAccount:\d+-compute@developer\.gserviceaccount\.com$/.test(member)) throw Error('IAM_INPUT');
  if(policy.bindings!==undefined && !Array.isArray(policy.bindings)) throw Error('IAM_BINDINGS');
  const next=structuredClone(policy);next.bindings ||= [];
  for(const b of next.bindings) if(typeof b.role!=='string' || !Array.isArray(b.members) || b.members.some(m=>typeof m!=='string')) throw Error('IAM_BINDING');
  if(next.bindings.some(b=>b.condition) && next.version!==3) throw Error('IAM_VERSION');
  let binding=next.bindings.find(b=>b.role==='roles/secretmanager.secretAccessor' && !b.condition);
  if(binding?.members.includes(member)) return {changed:false,policy:next};
  if(!binding) {binding={role:'roles/secretmanager.secretAccessor',members:[]};next.bindings.push(binding);}
  binding.members.push(member);
  return {changed:true,policy:next};
}
function canonical(v) {
  if(Array.isArray(v)) return v.map(canonical).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if(v && typeof v==='object') return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));
  return v;
}
export function samePolicySemantics(expected,actual) {
  const clean=p=>{const q=structuredClone(p);delete q.etag;delete q.version;return canonical(q);};
  if(!actual?.etag || (actual.bindings?.some(b=>b.condition) && actual.version!==3))return false;
  return JSON.stringify(clean(expected))===JSON.stringify(clean(actual));
}
