// Data-only agent capability matrix: strict parser + dry-run router. Executes nothing.
// Deliberately NOT referenced by workflows, rules, CI, agent-cycle, task-contracts or budget.
import {readFileSync} from 'node:fs';

export const MATRIX_MAX_BYTES=8192;
export const AGENT_IDS=Object.freeze(['codex','claude','grok','gemini']);
export const ROLES=Object.freeze(['executor','integration','commit-branch-dispatch','integration-tests',
 'deep-logic','qa-review','architecture','shift-swap-races',
 'realtime','service-workers','offline-outbox','telemetry-relays',
 'docs','long-analysis','test-coverage','cross-browser']);
const fail=code=>{throw Error(code);};
const SLUG=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
// Anything resembling a URL, email, UID, model id or token/secret is refused even if slug-shaped.
const FORBIDDEN=/(?:https?|www|mailto|ftp|@|:\/\/|\buid\b|(?:^|-)uid(?:-|$)|model|token|secret|passw|api-?key|bearer|gpt|sonnet|opus|haiku|flash|(?:^|-)pro(?:-|$)|turbo|sk-|xai-|aiza|(?:^|-)v?\d+(?:-\d+)+(?:-|$))/i;
const OPAQUE=/[a-z0-9]{24,}|(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{12,}/i;
const DANGEROUS_KEYS=Object.freeze(['__proto__','constructor','prototype']);
function isPlainObject(value){
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
}
// Own keys only (Reflect.ownKeys), never `in`; prototype-pollution names are refused at every level.
function ownKeys(value){
 const own=Reflect.ownKeys(value);
 if(own.some(k=>typeof k!=='string'||DANGEROUS_KEYS.includes(k)))fail('MATRIX_DANGEROUS_KEY');
 return own;
}
function plain(value,keys,optional=[]){
 if(!isPlainObject(value))fail('MATRIX_SHAPE');
 const own=ownKeys(value);
 if(own.some(k=>!keys.includes(k)&&!optional.includes(k))||keys.some(k=>!Object.hasOwn(value,k)))fail('MATRIX_UNKNOWN_KEY');
}
function slug(value,max=40){
 if(typeof value!=='string'||value.length<2||value.length>max||!SLUG.test(value))fail('MATRIX_VALUE');
 if(FORBIDDEN.test(value)||OPAQUE.test(value))fail('MATRIX_FORBIDDEN_VALUE');
 return value;
}
export function parseAgentMatrix(raw){
 if(typeof raw!=='string')fail('MATRIX_TYPE');
 if(Buffer.byteLength(raw,'utf8')>MATRIX_MAX_BYTES)fail('MATRIX_TOO_LARGE');
 if(/https?:|www\.|@|:\/\//i.test(raw))fail('MATRIX_FORBIDDEN_VALUE');
 let data;try{data=JSON.parse(raw);}catch{fail('MATRIX_JSON');}
 plain(data,['schema','agents'],['dispatchers']);
 if(data.schema!==1)fail('MATRIX_SCHEMA');
 if(!Array.isArray(data.agents)||data.agents.length!==AGENT_IDS.length)fail('MATRIX_AGENT_COUNT');
 const seen=new Set();
 const agents=data.agents.map(a=>{
  plain(a,['id','roles']);
  const id=slug(a.id,16);
  if(!AGENT_IDS.includes(id))fail('MATRIX_UNKNOWN_AGENT');
  if(seen.has(id))fail('MATRIX_DUPLICATE_AGENT');seen.add(id);
  if(!Array.isArray(a.roles)||a.roles.length<1||a.roles.length>ROLES.length)fail('MATRIX_ROLES');
  const roles=a.roles.map(r=>slug(r));
  if(roles.some(r=>!ROLES.includes(r)))fail('MATRIX_UNKNOWN_ROLE');
  if(new Set(roles).size!==roles.length)fail('MATRIX_DUPLICATE_ROLE');
  return Object.freeze({id,roles:Object.freeze(roles)});
 });
 const owners=new Map();
 for(const a of agents)for(const r of a.roles){if(owners.has(r))fail('MATRIX_ROLE_CONFLICT');owners.set(r,a.id);}
 const dispatchers=Object.hasOwn(data,'dispatchers')?parseDispatchers(data.dispatchers,agents.map(a=>a.id)):Object.freeze({});
 // Dispatchers stay under their own key; they are never merged into `agents` and never affect routeTask.
 return Object.freeze({schema:1,agents:Object.freeze(agents),dispatchers});
}

/**
 * Optional, DESCRIPTIVE-ONLY dispatcher layer.
 * `accepts_user_input` is descriptive metadata. It grants NO authority, NO routing and NO input
 * acceptance: nothing in the control plane reads it to accept, forward or act on user input.
 * A real user-input dispatcher requires a separate security review (see AGENT-MATRIX.md).
 */
export const DISPATCHER_AGENTS=Object.freeze({gemini_dispatcher:'gemini',grok_dispatcher:'grok'}); // hard mapping
export const DISPATCHER_ROLE_MAX=120;
const ROLE_ALLOWED=/^[A-Za-z0-9 &,\-\/]+$/; // ASCII letters, digits, space and & , - / only
const ROLE_DENY=/(?:https?|ftp|www|mailto|ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)|disregard|system\s+prompt|you\s+are\s+now|act\s+as|jailbreak|override|instruction|token|secret|password|api\s*key|bearer)/i;
const ROLE_PHONE=/(?:\d[\s\-\/]*){7,}/;
const ROLE_OPAQUE=/[A-Za-z0-9]{24,}|(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{12,}/;
function dispatcherRole(value){
 if(typeof value!=='string'||!value.trim()||value.length>DISPATCHER_ROLE_MAX)fail('MATRIX_DISPATCHER_ROLE');
 if(!ROLE_ALLOWED.test(value))fail('MATRIX_DISPATCHER_ROLE'); // rejects control, bidi, RLM/LRM, @ : . etc.
 if(ROLE_DENY.test(value)||ROLE_PHONE.test(value)||ROLE_OPAQUE.test(value))fail('MATRIX_FORBIDDEN_VALUE');
 return value;
}
export function parseDispatchers(value,agentIds){
 if(!isPlainObject(value))fail('MATRIX_DISPATCHERS_SHAPE'); // not array, not null, plain object only
 const keys=ownKeys(value);
 if(keys.length>2)fail('MATRIX_DISPATCHERS_COUNT');
 const out={};
 for(const key of keys){
  if(!Object.hasOwn(DISPATCHER_AGENTS,key))fail('MATRIX_UNKNOWN_DISPATCHER');
  if(!Array.isArray(agentIds)||!agentIds.includes(DISPATCHER_AGENTS[key]))fail('MATRIX_DISPATCHER_AGENT_MISSING');
  const d=value[key];
  plain(d,['role','accepts_user_input']);
  if(typeof d.accepts_user_input!=='boolean')fail('MATRIX_DISPATCHER_FLAG');
  out[key]=Object.freeze({role:dispatcherRole(d.role),accepts_user_input:d.accepts_user_input});
 }
 return Object.freeze(out);
}
export function loadAgentMatrix(url=new URL('./agent-matrix.json',import.meta.url)){
 return parseAgentMatrix(readFileSync(url,'utf8'));
}
// Free-form tags mapped onto role slugs. Order matters: first keyword hit wins.
const KEYWORDS=Object.freeze([
 ['swap','shift-swap-races'],['race','shift-swap-races'],
 ['service-worker','service-workers'],['sw','service-workers'],['pwa','service-workers'],
 ['outbox','offline-outbox'],['offline','offline-outbox'],
 ['telemetry','telemetry-relays'],['relay','telemetry-relays'],
 ['realtime','realtime'],['live','realtime'],['listener','realtime'],['snapshot','realtime'],
 ['cross-browser','cross-browser'],['safari','cross-browser'],['firefox','cross-browser'],['browser','cross-browser'],
 ['coverage','test-coverage'],
 ['docs','docs'],['doc','docs'],['documentation','docs'],['readme','docs'],['analysis','long-analysis'],['audit','long-analysis'],
 ['qa','qa-review'],['review','qa-review'],['architecture','architecture'],['design','architecture'],['logic','deep-logic'],
 ['commit','commit-branch-dispatch'],['branch','commit-branch-dispatch'],['dispatch','commit-branch-dispatch'],
 ['integration-test','integration-tests'],['e2e','integration-tests'],['integrat','integration'],['merge','integration'],
 ['execut','executor'],['implement','executor']
]);
export function routeTask(taskTag,matrix=loadAgentMatrix()){
 const none=Object.freeze({dryRun:true,executed:false,agent:null,role:null,match:'none'});
 if(typeof taskTag!=='string'||taskTag.length>80)return none;
 const tag=taskTag.trim().toLowerCase().replace(/[\s_/.]+/g,'-');
 if(!tag||!/^[a-z0-9-]+$/.test(tag))return none;
 const owner=role=>matrix.agents.find(a=>a.roles.includes(role))?.id??null;
 let role=ROLES.includes(tag)?tag:null,match=role?'exact':'none';
 if(!role){const parts=tag.split('-');
  for(const [kw,r] of KEYWORDS){if(kw.includes('-')?tag.includes(kw):parts.some(p=>p===kw||(kw.length>=4&&p.startsWith(kw)))){role=r;match='keyword';break;}}}
 const agent=role?owner(role):null;
 return agent?Object.freeze({dryRun:true,executed:false,agent,role,match}):none;
}
