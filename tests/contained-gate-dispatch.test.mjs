import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Exercise the real supervisor, but replace npm's entry point with inert local
// code. No package scripts, browser, emulator operation or provider is invoked.
const here = fileURLToPath(new URL('.', import.meta.url));
const runner = path.join(here, 'run-contained.mjs');
const fakeNpmSource = `
'use strict';
const fs=require('node:fs'),path=require('node:path');
require(process.env.RESQ_DISPATCH_GUARD).assertActive();
fs.writeFileSync(process.env.RESQ_DISPATCH_CAPTURE,JSON.stringify({
 argv:process.argv.slice(2),project:process.env.GCLOUD_PROJECT,
 googleProject:process.env.GOOGLE_CLOUD_PROJECT,emulator:process.env.FIRESTORE_EMULATOR_HOST,
 evidence:process.env.RESQ_CONTAINMENT_DIR
}));
if(process.env.RESQ_DISPATCH_POISON==='yes'){
 fs.appendFileSync(path.join(process.env.RESQ_CONTAINMENT_DIR,'violations.log'),JSON.stringify({pid:process.pid,reason:'synthetic-dispatch-proof'})+'\\n');
 fs.appendFileSync(path.join(process.env.RESQ_CONTAINMENT_DIR,'violations.log'),JSON.stringify({pid:process.pid,reason:'child-stripped-containment executable=PRIVATE_VALUE'})+'\\n');
 fs.appendFileSync(path.join(process.env.RESQ_CONTAINMENT_DIR,'violations.log'),'x'.repeat(20000)+'PRIVATE_TAIL');
 // Bypass the child guard's own exit wrapper so only the real parent ledger
 // check can turn this otherwise successful process into a failed gate.
 process.reallyExit(0);
}
process.exit(Number(process.env.RESQ_DISPATCH_EXIT || 0));
`;

function invoke(gate, { exit = 0, poison = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-dispatch-proof-'));
  const fakeNpm = path.join(directory, 'npm-entry.cjs');
  const capture = path.join(directory, 'argv.json');
  fs.writeFileSync(fakeNpm, fakeNpmSource);
  const env = { ...process.env };
  for (const key of ['NODE_OPTIONS', 'RESQ_CONTAINMENT_DIR', 'GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_TOKEN',
    'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY']) delete env[key];
  Object.assign(env, {
    GCLOUD_PROJECT:'demo-resq', GOOGLE_CLOUD_PROJECT:'demo-resq', FIREBASE_CONFIG:'{"projectId":"demo-resq"}',
    FIRESTORE_EMULATOR_HOST:'127.0.0.1:8191', METADATA_SERVER_DETECTION:'none', npm_execpath:fakeNpm,
    RESQ_DISPATCH_CAPTURE:capture, RESQ_DISPATCH_GUARD:path.join(here,'lib/network-guard.cjs'),
    RESQ_DISPATCH_EXIT:String(exit), RESQ_DISPATCH_POISON:poison?'yes':'no'
  });
  const result = spawnSync(process.execPath, [runner, ...(gate === undefined ? [] : [gate])],
    { cwd:here, env, encoding:'utf8', timeout:20000, windowsHide:true });
  assert.equal(result.error, undefined, result.error?.message);
  return { result, capture:fs.existsSync(capture)?JSON.parse(fs.readFileSync(capture,'utf8')):null };
}

for (const [gate, inner] of [['all','all:inner'],['test:all','test:all:inner'],['reserve:contained','reserve:contained:inner']]) {
  test('real supervisor dispatches only the matching inner gate: '+gate, () => {
    const { result, capture } = invoke(gate);
    assert.equal(result.status,0,result.stderr);
    assert.ok(capture,'fake npm actually ran');
    assert.deepEqual(capture.argv,['run',inner]);
    assert.equal(capture.project,'demo-resq');
    assert.equal(capture.googleProject,'demo-resq');
    assert.equal(capture.emulator,'127.0.0.1:8191');
    assert.ok(path.isAbsolute(capture.evidence));
    assert.match(result.stdout,/"violations":false/);
  });
}

for (const gate of [undefined,'all:inner','test:all:inner','reserve:contained:inner','constructor','__proto__','all && echo bypass']) {
  test('real supervisor refuses unknown gate without spawning: '+String(gate), () => {
    const { result, capture } = invoke(gate);
    assert.notEqual(result.status,0);
    assert.equal(capture,null,'fake npm must not run');
    assert.doesNotMatch(result.stdout,/Local containment evidence:/,'unknown gate fails before allocating child evidence');
  });
}

test('real supervisor preserves nonzero child exit code', () => {
  const { result, capture } = invoke('all',{exit:17});
  assert.ok(capture,'fake npm actually ran');
  assert.equal(result.status,17,result.stderr);
  assert.match(result.stdout,/"code":17/);
});

test('real supervisor rejects sticky poison even when child truly exits zero', () => {
  const { result, capture } = invoke('all',{poison:true});
  assert.ok(capture,'fake npm actually ran');
  assert.equal(result.status,1,result.stderr);
  assert.match(result.stdout,/"code":0/);
  assert.match(result.stdout,/"violations":true/);
  assert.match(result.stdout,/Containment violation categories: \["unknown","child-stripped-containment"\]/);
  assert.match(result.stdout,/Containment diagnostics truncated/);
  assert.doesNotMatch(result.stdout,/PRIVATE_VALUE|PRIVATE_TAIL|synthetic-dispatch-proof/);
  const ledger = fs.readFileSync(path.join(capture.evidence,'violations.log'),'utf8');
  assert.match(ledger,/synthetic-dispatch-proof/);
});
