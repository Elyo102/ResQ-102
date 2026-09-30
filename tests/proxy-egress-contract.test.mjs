import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const guard = path.join(here, 'lib/network-guard.cjs');
function probe(body, expectedReason) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-egress-contract-'));
  const env = { ...process.env, RESQ_CONTAINMENT_DIR: dir, NODE_OPTIONS:`--require ${JSON.stringify(guard)}` };
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_TOKEN', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY']) delete env[key];
  const result = spawnSync(process.execPath, ['--require', guard, '-e', prelude + body],
    { cwd:here, env, encoding:'utf8', timeout:15000, windowsHide:true });
  assert.equal(result.error, undefined, result.error?.message);
  const ledger = path.join(dir, 'violations.log');
  const reasons = fs.existsSync(ledger) ? fs.readFileSync(ledger,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line).reason) : [];
  assert.match(result.stdout, /EGRESS_PROOF_COMPLETE/, result.stderr);
  if (expectedReason) {
    assert.notEqual(result.status,0);
    assert.ok(reasons.some(reason=>expectedReason.test(reason)), JSON.stringify(reasons));
  } else { assert.equal(result.status,0,result.stderr); assert.deepEqual(reasons,[]); }
}
const prelude = `const assert=require('node:assert/strict'),http=require('node:http'),net=require('node:net'),dns=require('node:dns');
const {startProxy}=require('./lib/loopback-proxy.cjs');
function bounded(p,label='unspecified phase'){let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('proof timeout: '+label)),2500);})]).finally(()=>clearTimeout(timer));}
async function openProxy(){let server;const original=http.createServer;http.createServer=(...args)=>(server=original(...args));let proxy;try{proxy=await startProxy();}finally{http.createServer=original;}return{proxy,server};}
async function rawClient(proxy,server){let accepted;const incoming=new Promise(r=>accepted=r);server.once('connection',accepted);const u=new URL(proxy.url),client=net.connect(Number(u.port),u.hostname);client.on('error',()=>{});await bounded(new Promise(r=>client.once('connect',r)));const socket=await bounded(incoming);socket.on('error',()=>{});const closed=new Promise(r=>socket.once('close',r));return{client,socket,closed};}
async function cleanup(proxy,server){try{await proxy.close();}catch{}if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}}
`;

for (const destroyed of [false, true]) test('upstream timeout stays fatal with downstream destroyed=' + destroyed, () => probe(`
(async()=>{
 const {EventEmitter}=require('node:events');const originalCreate=http.createServer,originalRequest=http.request;let handler,upstream;
 http.createServer=function(callback){handler=callback;return originalCreate.call(this,callback);};
 let proxy;try{proxy=await startProxy();}finally{http.createServer=originalCreate;}
 http.request=function(){upstream=new EventEmitter();upstream.destroy=()=>{};return upstream;};
 const socket={},request=new EventEmitter(),response=new EventEmitter();
 Object.assign(request,{url:proxy.url+'/timeout',headers:{},method:'GET',socket,pipe(){}});
 Object.assign(response,{socket,destroyed:${destroyed},headersSent:false,writableFinished:false,writeHead(){this.headersSent=true;},end(){},destroy(){this.destroyed=true;}});
 try{
  handler(request,response);assert.equal(proxy.diagnostics().activeRequests,1);
  // Exercise the early-return case, not merely a timeout on a live response.
  assert.equal(response.destroyed,${destroyed});
  upstream.emit('error',Object.assign(new Error('synthetic timeout'),{code:'ETIMEDOUT'}));
  response.emit('close');upstream.emit('close');
  assert.equal(proxy.diagnostics().activeRequests,0);console.log('EGRESS_PROOF_COMPLETE');
 }finally{http.request=originalRequest;await cleanup(proxy);}
 process.exit(0);
})().catch(e=>{console.error(e.stack);process.exitCode=1;});`, /browser-proxy-upstream-timeout/));

test('raw partial request reset creates zero upstream requests, sockets or DNS lookups', () => probe(`
(async()=>{const{proxy,server}=await openProxy();const{client,socket,closed}=await rawClient(proxy,server);
 const counts={requests:0,sockets:0,dns:0},originalRequest=http.request,originalConnect=net.Socket.prototype.connect,originalLookup=dns.lookup;
 http.request=function(...args){counts.requests++;return originalRequest.apply(this,args);};
 net.Socket.prototype.connect=function(...args){counts.sockets++;return originalConnect.apply(this,args);};
 dns.lookup=function(...args){counts.dns++;return originalLookup.apply(this,args);};
 try{const received=new Promise(r=>socket.once('data',r));client.write('GET http://example.invalid/incomplete HTTP/1.1\\r\\nHost: example.invalid\\r\\n');await bounded(received);client.resetAndDestroy();await bounded(closed);
 assert.deepEqual(counts,{requests:0,sockets:0,dns:0});console.log('EGRESS_PROOF_COMPLETE');
 }finally{http.request=originalRequest;net.Socket.prototype.connect=originalConnect;dns.lookup=originalLookup;client.destroy();await cleanup(proxy);}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});`));

for (const mode of ['allowed-reset','local-cancel']) test('registered active request cancellation stays clean: '+mode, () => probe(`
(async()=>{let arrived,upstreamClosed;const arrival=new Promise(r=>arrived=r),closure=new Promise(r=>upstreamClosed=r);
 const target=http.createServer((req,res)=>{req.socket.once('close',upstreamClosed);arrived();});await new Promise(r=>target.listen(0,'127.0.0.1',r));
 const{proxy,server}=await openProxy();const{client,closed}=await rawClient(proxy,server);
 try{client.write('GET http://127.0.0.1:'+target.address().port+'/stall HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\n');await bounded(arrival);
 if(${JSON.stringify(mode)}==='allowed-reset')client.resetAndDestroy();else client.end();
 await bounded(closed);await bounded(closure);await proxy.drain(2000);console.log('EGRESS_PROOF_COMPLETE');
 }finally{client.destroy();await cleanup(proxy,target);}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});`));

test('denied absolute authority remains sticky even followed by reset', () => probe(`
(async()=>{const{proxy,server}=await openProxy();const{client,closed}=await rawClient(proxy,server);
 try{const response=new Promise(r=>client.once('data',r));client.write('GET http://example.invalid/denied HTTP/1.1\\r\\nHost: example.invalid\\r\\n\\r\\n');assert.match(String(await bounded(response)),/403/);if(!client.destroyed)client.resetAndDestroy();await bounded(closed);console.log('EGRESS_PROOF_COMPLETE');}
 finally{client.destroy();await cleanup(proxy);}process.exit(0);
})().catch(e=>{console.error(e.stack);process.exitCode=1;});`, /browser-proxy-denied-destination/));

test('complete malformed HTTP remains sticky parser failure', () => probe(`
(async()=>{const{proxy,server}=await openProxy();const{client,closed}=await rawClient(proxy,server);
 try{client.write('INVALID\\x00HTTP\\r\\n\\r\\n');await bounded(closed);console.log('EGRESS_PROOF_COMPLETE');}
 finally{client.destroy();await cleanup(proxy);}process.exit(0);
})().catch(e=>{console.error(e.stack);process.exitCode=1;});`, /browser-proxy-malformed-request code=HPE_/));

for (const mode of ['http-before-headers','http-after-headers','connect']) test('spontaneous upstream reset is fatal: '+mode, () => probe(`
(async()=>{let reached,targetSocket;const arrival=new Promise(r=>reached=r);
 const target=${JSON.stringify(mode)}==='connect'?net.createServer(socket=>{reached();socket.resetAndDestroy();}):http.createServer((req,res)=>{targetSocket=req.socket;reached();if(${JSON.stringify(mode)}==='http-after-headers'){res.writeHead(200,{'Content-Length':'1000'});res.write('partial');}else req.socket.resetAndDestroy();});
 await new Promise(r=>target.listen(0,'127.0.0.1',r));const{proxy,server}=await openProxy();const{client,closed}=await rawClient(proxy,server);client.resume();
 let received='',observed;const partial=new Promise(r=>observed=r);client.on('data',chunk=>{received+=chunk.toString();if(received.includes('200')&&received.includes('partial'))observed();});
 try{const authority='127.0.0.1:'+target.address().port;client.write(${JSON.stringify(mode)}==='connect'?'CONNECT '+authority+' HTTP/1.1\\r\\nHost: '+authority+'\\r\\n\\r\\n':'GET http://'+authority+'/reset HTTP/1.1\\r\\nHost: '+authority+'\\r\\n\\r\\n');await bounded(arrival,'upstream arrival');
 if(${JSON.stringify(mode)}==='http-after-headers'){await bounded(partial,'client observed partial200');assert.ok(received.startsWith('HTTP/1.1 200'));console.log('PARTIAL_RESPONSE_OBSERVED');targetSocket.resetAndDestroy();}
 await bounded(closed,'downstream socket close');console.log('EGRESS_PROOF_COMPLETE');}
 catch(error){console.error(JSON.stringify({proxyLifecycle:proxy.diagnostics()}));throw error;}
 finally{client.destroy();try{await proxy.close();}catch{}if(target.closeAllConnections)target.closeAllConnections();await new Promise(r=>target.close(r));}process.exit(0);
})().catch(e=>{console.error(e.stack);process.exitCode=1;});`, /upstream.*(?:reset|ECONNRESET|abort)/i));
