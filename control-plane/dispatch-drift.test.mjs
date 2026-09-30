// Drift and static-safety checks for the Agent Dispatch Center. Reads the deploy artifact, agent-matrix.json and
// source files AS DATA ONLY (no matrix parser, no routing). Security review: control-plane/DISPATCH-CENTER.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {join,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DISPATCH_AGENTS,DISPATCH_TASKS,AGENT_NAME_BY_ID,EXCLUDED_TASK_TYPES,NOTE_PATTERN,NOTE_RULES_PATTERN,UUID_V4,NOTE_MAX} from './web/dispatch-model.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const read=rel=>readFileSync(join(root,rel),'utf8');
const artifact=read('control-plane/deploy/firestore.dispatch.rules');
function rulesTaskMap(text){
 const body=/function dispatchTaskMap\(\) \{\s*return \{([\s\S]*?)\};\s*\}/.exec(text)?.[1];assert.ok(body,'dispatchTaskMap body');
 const map={};for(const m of body.matchAll(/'([A-Za-z]+)':\s*\[([^\]]*)\]/g))map[m[1]]=[...m[2].matchAll(/'([a-z-]+)'/g)].map(x=>x[1]);return map;
}
test('Rules task map == browser map == matrix roles under the explicit id mapping, minus exclusions',()=>{
 const matrix=JSON.parse(read('control-plane/agent-matrix.json'));
 const expected={};
 for(const agent of matrix.agents){if(!Object.hasOwn(AGENT_NAME_BY_ID,agent.id))continue;
  expected[AGENT_NAME_BY_ID[agent.id]]=agent.roles.filter(r=>!EXCLUDED_TASK_TYPES.includes(r));}
 assert.deepEqual(AGENT_NAME_BY_ID,{gemini:'Gemini',codex:'Codex',grok:'Grok'});
 assert.ok(matrix.agents.some(a=>a.id==='claude')&&!Object.values(AGENT_NAME_BY_ID).includes('Claude'),'Claude has no dispatchable types');
 assert.deepEqual(rulesTaskMap(artifact),expected);
 assert.deepEqual(JSON.parse(JSON.stringify(DISPATCH_TASKS)),expected);
 assert.deepEqual(rulesTaskMap(read('control-plane/firestore-dispatch.rules.fragment')),expected);
 const rulesAgents=/d\.agent in \[([^\]]*)\]/.exec(artifact)[1].match(/'([A-Za-z]+)'/g).map(s=>s.slice(1,-1));
 assert.deepEqual(rulesAgents,[...DISPATCH_AGENTS]);assert.deepEqual(Object.keys(expected),[...DISPATCH_AGENTS].sort((a,b)=>Object.keys(expected).indexOf(a)-Object.keys(expected).indexOf(b)));
 for(const excluded of ['executor','commit-branch-dispatch']){assert.ok(EXCLUDED_TASK_TYPES.includes(excluded));
  assert.ok(!Object.values(DISPATCH_TASKS).flat().includes(excluded));assert.doesNotMatch(/function dispatchTaskMap[\s\S]*?\n    \}/.exec(artifact)[0],new RegExp(`'${excluded}'`));}
});
test('client note allowlist and UUID pattern are the same as the Rules',()=>{
 assert.ok(artifact.includes(`d.note.matches('${NOTE_RULES_PATTERN}')`));assert.ok(artifact.includes(`d.note.size() <= ${NOTE_MAX}`));
 const fromRules=NOTE_RULES_PATTERN.replace(/\\\\x\{([0-9A-F]{4})\}/g,'\\u{$1}');assert.equal(NOTE_PATTERN.source,fromRules);assert.ok(NOTE_PATTERN.unicode);
 assert.ok(artifact.includes(`matches('${UUID_V4.source}')`));
 // RE2 quantifier cap: no {m,n} above 1000 anywhere; the note uses size() before an unbounded * class.
 for(const m of artifact.matchAll(/\{(\d+)(?:,(\d*))?\}/g))assert.ok(Number(m[2]||m[1])<=1000,m[0]);
 assert.ok(artifact.indexOf('d.note.size() <= 10000')<artifact.indexOf('d.note.matches('));
 assert.doesNotMatch(NOTE_RULES_PATTERN,/000D|0009|\\r|\\t/);
});
const walk=(dir,out=[])=>{for(const name of readdirSync(dir)){const full=join(dir,name);const st=lstatSync(full);if(st.isSymbolicLink())continue;
 if(st.isDirectory()){if(!['node_modules','.git','test-results','playwright-report'].includes(name))walk(full,out);}else if(st.isFile()&&st.size<5e6)out.push(relative(root,full).split(sep).join('/'));}return out;};
test('note is display-only: no consumer of dispatchRequests outside the browser adapter, docs, Rules and tests',()=>{
 const allowed=new Set(['control-plane/web/firebase-adapter.mjs','control-plane/assemble-rules.mjs','control-plane/firestore-dispatch.rules.fragment','control-plane/deploy/firestore.dispatch.rules',
  'control-plane/DISPATCH-CENTER.md','control-plane/dispatch-drift.test.mjs','rules-test/control-plane-dispatch.test.mjs','control-plane/deploy/firestore-dispatch-provenance.json',
  // Active-tasks deploy artifact = the live rules (incl. the unchanged dispatchRequests block) + the active-tasks block.
  'control-plane/deploy/firestore.control-plane.rules','control-plane/deploy/firestore-active-tasks-provenance.json','rules-test/control-plane-active-tasks.test.mjs']);
 const offenders=[];
 for(const dir of ['.github','functions','control-plane','rules-test','tests'])for(const rel of walk(join(root,dir))){
  if(allowed.has(rel))continue;const text=readFileSync(join(root,rel));if(text.subarray(0,8000).includes(0))continue;
  if(/dispatchRequests/.test(text.toString('utf8')))offenders.push(rel);}
 assert.deepEqual(offenders,[]);
 // The adapter only maps the note into a display row; it is never used in a query, path, id or any other call.
 const adapter=read('control-plane/web/firebase-adapter.mjs');
 assert.match(adapter,/note:x\.note,/);assert.match(adapter,/'taskType','note','status'/);
 assert.doesNotMatch(adapter.replace('note:x.note,','').replace("'taskType','note','status'",''),/\bnote\b/);
 for(const f of ['control-plane/firestore-dispatch.rules.fragment','control-plane/DISPATCH-CENTER.md'])assert.match(read(f),/display-only/);
 assert.match(read('control-plane/firestore-dispatch.rules.fragment'),/REQUEST, never an authorization/);
 assert.match(read('control-plane/DISPATCH-CENTER.md'),/request, not an authorization/);assert.match(read('control-plane/DISPATCH-CENTER.md'),/Admin SDK bypasses/);
});
test('dispatch web code: textContent only, no statuses invented, no GitHub/CI trigger, uniform cache token',()=>{
 const web=['bootstrap.mjs','dispatch-model.mjs','dispatch-view.mjs','firebase-adapter.mjs','private-view.mjs','private-controller.mjs','index.html','active-tasks-model.mjs','active-tasks-view.mjs'].map(f=>[f,read('control-plane/web/'+f)]);
 for(const [f,t] of web){assert.doesNotMatch(t,/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/,f);
  // Token-shaped strings only: the secret BLOCK list in dispatch-model.mjs names the prefixes on purpose.
  assert.doesNotMatch(t,/api\.github\.com|workflow_dispatch|repository_dispatch|ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}/i,f);}
 for(const f of ['dispatch-model.mjs','dispatch-view.mjs'])assert.doesNotMatch(read('control-plane/web/'+f),/RUNNING|CONNECTED|IN_PROGRESS|COMPLETED/,f);
 const tokens=new Set(web.flatMap(([,t])=>[...t.matchAll(/\?v=([A-Za-z0-9-]+)/g)].map(m=>m[1])));assert.deepEqual([...tokens],['20260930-grok-dispatch6']);
});
test('C11: HEARTBEAT_FRESH_MS in 150-180 s with the 120 s heartbeat; token dispatch6 in every importer outside web/ too (no drift)',async()=>{
 const model=await import('./web/active-tasks-model.mjs');const listener=await import('./task-listener.mjs');
 assert.equal(listener.HEARTBEAT_MS,120000);assert.ok(model.HEARTBEAT_FRESH_MS>=150000&&model.HEARTBEAT_FRESH_MS<=180000,String(model.HEARTBEAT_FRESH_MS));
 assert.ok(model.HEARTBEAT_FRESH_MS>listener.HEARTBEAT_MS);
 const files=['control-plane/task-listener.mjs','control-plane/listener/summarizer.mjs','tests/e2e/private-active-tasks.spec.mjs'];
 for(const f of files){const t=new Set([...read(f).matchAll(/\?v=([A-Za-z0-9-]+)/g)].map(m=>m[1]));assert.deepEqual([...t],['20260930-grok-dispatch6'],f);}
 for(const rel of walk(join(root,'control-plane')).concat(walk(join(root,'tests/e2e'))))if(rel!=='control-plane/dispatch-drift.test.mjs')assert.ok(!read(rel).includes('grok-'+'dispatch4'),rel);
});
