import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const guard = path.join(here, 'lib/network-guard.cjs');
function probe(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-lifecycle-'));
  const env = { ...process.env, RESQ_CONTAINMENT_DIR: dir,
    NODE_OPTIONS: `--require ${JSON.stringify(guard)}` };
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_TOKEN', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY']) delete env[key];
  const result = spawnSync(process.execPath, ['--require', guard, '-e', body],
    { cwd: here, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  const ledger = path.join(dir, 'violations.log');
  const reasons = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).reason) : [];
  assert.equal(result.error, undefined, result.error?.message);
  return { ...result, reasons };
}
function clean(body) {
  const result = probe(body);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.reasons, []);
  assert.match(result.stdout, /LIFECYCLE_PROOF_COMPLETE/);
}
const prelude = `const assert=require('node:assert/strict'),http=require('node:http');
const {startProxy}=require('./lib/loopback-proxy.cjs');`;

test('real HTTP disables upstream reuse, closes both legs and bounds anonymous diagnostics', () => clean(prelude + `
(async()=>{
 const original=http.request;let observed=0;
 http.request=function(options,...rest){if(options && options.hostname){assert.equal(options.agent,false);observed++;}return original.call(this,options,...rest);};
 const sockets=new Set();let served=0;
 const server=http.createServer((req,res)=>{assert.equal(req.headers.connection,'close');assert.equal(req.headers['x-private-hop'],undefined);sockets.add(req.socket);served++;res.setHeader('Connection','x-response-hop');res.setHeader('x-response-hop','must-not-pass');res.end('local');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const proxy=await startProxy();
 try{
  for(let i=0;i<70;i++)await new Promise((resolve,reject)=>{const request=http.get(proxy.url,{path:'http://127.0.0.1:'+server.address().port+'/PRIVATE_PATH?PRIVATE_QUERY',headers:{Connection:'keep-alive, x-private-hop','x-private-hop':'must-not-pass'}},response=>{assert.equal(response.headers.connection,'close');assert.equal(response.headers['x-response-hop'],undefined);response.resume();response.on('end',resolve);});request.on('error',reject);});
  await proxy.drain(2000);assert.equal(observed,70);assert.equal(served,70);assert.equal(sockets.size,70);
  const report=proxy.diagnostics();assert.equal(report.activeRequests,0);assert.equal(report.events.length,128);
  for(const event of report.events){assert.deepEqual(Object.keys(event).sort(),['event','phase','rid','sid']);assert.equal(typeof event.event,'string');assert.equal(typeof event.phase,'string');assert.ok(Number.isSafeInteger(event.rid)&&event.rid>=0);assert.ok(Number.isSafeInteger(event.sid)&&event.sid>=0);}
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_PATH|PRIVATE_QUERY|must-not-pass|http:/);
  console.log('LIFECYCLE_PROOF_COMPLETE');
 }finally{await proxy.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});`));

for (const order of ['upstream-first', 'response-first']) test('drain requires both close signals: ' + order, () => clean(prelude + `
(async()=>{
 const {EventEmitter}=require('node:events');const originalCreate=http.createServer,originalRequest=http.request;let handler,upstream;
 http.createServer=function(callback){handler=callback;return originalCreate.call(this,callback);};
 const proxy=await startProxy();http.createServer=originalCreate;
 http.request=function(){upstream=new EventEmitter();upstream.destroy=()=>{};return upstream;};
 const socket={};const request=new EventEmitter();Object.assign(request,{url:proxy.url+'/local',headers:{},method:'GET',socket,pipe(){}});
 const response=new EventEmitter();Object.assign(response,{socket,writableFinished:true,destroyed:false});
 try{
  handler(request,response);assert.equal(proxy.diagnostics().activeRequests,1);
  let drained=false;const pending=proxy.drain(2000).then(()=>{drained=true;});
  const first=${JSON.stringify(order)}==='upstream-first'?upstream:response;
  const second=first===upstream?response:upstream;
  first.emit('close');await new Promise(setImmediate);assert.equal(drained,false);assert.equal(proxy.diagnostics().activeRequests,1);
  second.emit('close');await pending;assert.equal(drained,true);assert.equal(proxy.diagnostics().activeRequests,0);
  console.log('LIFECYCLE_PROOF_COMPLETE');
 }finally{http.request=originalRequest;await proxy.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});`));

test('stalled real HTTP drain timeout remains sticky after caught error and cleanup', () => {
  const result = probe(prelude + `
(async()=>{
 let arrived;const arrival=new Promise(r=>arrived=r);
 const server=http.createServer(()=>arrived());await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const proxy=await startProxy();const client=http.get(proxy.url,{path:'http://127.0.0.1:'+server.address().port+'/stall'});client.on('error',()=>{});
 let timer;
 try{
  await Promise.race([arrival,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('arrival timeout')),2000);})]);clearTimeout(timer);
  assert.equal(proxy.diagnostics().activeRequests,1);console.log('DRAIN_TIMEOUT_ACTION_REACHED');
  await assert.rejects(()=>proxy.drain(30));console.log('DRAIN_TIMEOUT_REJECTED');
 }finally{clearTimeout(timer);client.destroy();try{await proxy.close();}catch{}server.closeAllConnections();await new Promise(r=>server.close(r));}
 process.exit(0);
})().catch(error=>{console.error(error.stack);process.exitCode=1;});`);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /DRAIN_TIMEOUT_ACTION_REACHED/);
  assert.match(result.stdout, /DRAIN_TIMEOUT_REJECTED/);
  assert.ok(result.reasons.some(reason => /drain.*timeout/i.test(reason)), JSON.stringify(result.reasons));
});
