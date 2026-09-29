import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TASK_LABELS,validateEvent} from './core.mjs';
import {createEmitter} from './emitter.mjs';
import {TELEMETRY_TASKS} from './web/private-controller.mjs';
import {TASKS} from './task-contracts.mjs';
test('core, runner tasks, emitter and controller share closed task allowlist',async()=>{
 assert.deepEqual(TELEMETRY_TASKS,TASK_LABELS);
 for(const task of TASK_LABELS){
  let got;
  await createEmitter({agent:'Codex',transport:e=>{got=e;}}).emit('heartbeat','running',task);
  assert.equal(got.task,task);
 }
 for(const {label} of Object.values(TASKS))assert.ok(TASK_LABELS.includes(label));
 assert.throws(()=>validateEvent({agent:'Codex',kind:'heartbeat',step:'running',task:'arbitrary-secret'}));
 let calls=0;await assert.rejects(createEmitter({agent:'Codex',transport:()=>{calls++;}}).emit('heartbeat','running','unknown'));assert.equal(calls,0);
});

test('budget fragment binds only paid tasks and is not a deployable ruleset',()=>{
 const rules=readFileSync(new URL('./firestore-budget.rules.fragment',import.meta.url),'utf8');
 for(const {label} of Object.values(TASKS))assert.ok(rules.includes("'"+label+"'"));
 assert.ok(rules.includes('match /resq_budget_authorizations/{id}'));
 assert.ok(rules.includes('match /resq_budget_state/{id}'));
 assert.doesNotMatch(rules,/rules_version\s*=|service cloud\.firestore|match \/events|match \/private_access/);
});
