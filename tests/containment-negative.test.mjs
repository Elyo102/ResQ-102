import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { localizeWorker } from './lib/localize-worker.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const guard = path.join(here, 'lib/network-guard.cjs');
const browserFixture = path.join(here, 'lib/contained-playwright.cjs');
const { hasGuardPreload } = createRequire(import.meta.url)(guard);
test('preload parser accepts exact Windows quoting and rejects lookalikes', () => {
  assert.equal(hasGuardPreload(`--require ${JSON.stringify(guard)}`), true);
  assert.equal(hasGuardPreload(`--require="${guard}"`), true);
  assert.equal(hasGuardPreload(`-r ${JSON.stringify(guard)}`), true);
  assert.equal(hasGuardPreload('--require ./lib/network-guard.cjs'), false);
  assert.equal(hasGuardPreload(`--require ${JSON.stringify(guard + '.wrong')}`), false);
  assert.equal(hasGuardPreload(`--require ${JSON.stringify(browserFixture)}`), false);
  assert.equal(hasGuardPreload('--require "unterminated'), false);
});
function probe(body, { guarded = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-negative-'));
  const env = { ...process.env, RESQ_CONTAINMENT_DIR: dir };
  delete env.NODE_OPTIONS;
  if (guarded) env.NODE_OPTIONS = `--require ${JSON.stringify(guard)}`;
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_TOKEN', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY']) delete env[key];
  const result = spawnSync(process.execPath, [...(guarded ? ['--require', guard] : []), '-e', body],
    { cwd: here, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  const ledger = path.join(dir, 'violations.log');
  const reasons = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).reason) : [];
  return { ...result, poisoned: reasons.length > 0, reasons };
}
function blocked(body, reason = /socket|dns|child|executable|browser/i) {
  const value = probe(body);
  assert.equal(value.error, undefined, value.error?.code);
  assert.notEqual(value.status, 0, 'Caught denial must still fail the child');
  assert.equal(value.poisoned, true, value.stderr?.slice(-600));
  assert.match(value.stdout || '', /PROBE_ACTION_REACHED/, 'Unrelated startup failure must not count as an escape denial');
  assert.ok(value.reasons.some(value => reason.test(value)), JSON.stringify(value.reasons));
  return value;
}
const browserPrelude = `const http=require('node:http'); const {chromium}=require(${JSON.stringify(browserFixture)});`;

for (const mode of ['client-abort', 'proxy-close']) test('stalled loopback upstream closes before teardown: ' + mode, () => {
  const value = probe(`const assert=require('node:assert/strict'),http=require('node:http');
const {startProxy}=require('./lib/loopback-proxy.cjs');
(async()=>{
 let arrived,closed; const arrival=new Promise(r=>arrived=r),closure=new Promise(r=>closed=r);
 const server=http.createServer((request,response)=>{request.socket.once('close',closed);arrived();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const proxy=await startProxy();let timer;
 const client=http.get(proxy.url,{path:'http://127.0.0.1:'+server.address().port+'/stall'});
 client.on('error',()=>{});
 try{
  await Promise.race([arrival,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('arrival timeout')),2000);})]);clearTimeout(timer);
  console.log('PROBE_ACTION_REACHED');
  if(${JSON.stringify(mode)}==='client-abort')client.destroy();else await proxy.close();
  await Promise.race([closure,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('upstream close timeout')),2000);})]);clearTimeout(timer);
  console.log('UPSTREAM_CLOSED_BEFORE_TEARDOWN');
 }finally{clearTimeout(timer);client.destroy();if(${JSON.stringify(mode)}==='client-abort')await proxy.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error.message);process.exitCode=1;});`);
  assert.equal(value.status, 0, value.stderr);
  assert.equal(value.poisoned, false, JSON.stringify(value.reasons));
  assert.match(value.stdout, /UPSTREAM_CLOSED_BEFORE_TEARDOWN/);
});

test('proxy cleanup cannot hide a denied external destination', () => blocked(`
const http=require('node:http');const {startProxy}=require('./lib/loopback-proxy.cjs');
(async()=>{const proxy=await startProxy();console.log('PROBE_ACTION_REACHED');
await new Promise(resolve=>{const r=http.get(proxy.url,{path:'http://example.invalid/denied'},res=>{res.resume();res.on('end',resolve);});r.on('error',resolve);});
try{await proxy.close();}catch{}process.exit(0);})().catch(()=>process.exit(0));`, /browser-proxy-denied-destination/));

for (const [kind, destination] of [
  ['GET', 'localhost.evil'], ['GET', '127.0.0.1.nip.io'],
  ['GET', '192.168.1.1'], ['GET', '203.0.113.1'], ['GET', 'example.invalid'],
  ['CONNECT', 'example.invalid:443']
]) test('proxy rejects destination before any upstream activity: ' + kind + ' ' + destination, () => {
  const value = blocked(`
const assert=require('node:assert/strict'),http=require('node:http'),net=require('node:net'),dns=require('node:dns');
const {startProxy}=require('./lib/loopback-proxy.cjs');
(async()=>{
 const proxy=await startProxy(),url=new URL(proxy.url);
 const socket=net.connect(Number(url.port),url.hostname);socket.on('error',()=>{});
 await new Promise(resolve=>socket.once('connect',resolve));
 const counts={request:0,socket:0,dns:0};
 const originalRequest=http.request,originalConnect=net.Socket.prototype.connect,originalLookup=dns.lookup;
 http.request=()=>{counts.request++;throw Error('unexpected upstream request');};
 net.Socket.prototype.connect=()=>{counts.socket++;throw Error('unexpected upstream socket');};
 dns.lookup=()=>{counts.dns++;throw Error('unexpected upstream DNS');};
 let timer;
 try{
  let reply='';socket.on('data',chunk=>reply+=chunk.toString());
  const closed=new Promise(resolve=>socket.once('close',resolve));
  console.log('PROBE_ACTION_REACHED');
  socket.write(${JSON.stringify(kind === 'CONNECT'
    ? 'CONNECT ' + destination + ' HTTP/1.1\r\nHost: ' + destination + '\r\n\r\n'
    : 'GET http://' + destination + '/denied HTTP/1.1\r\nHost: ' + destination + '\r\n\r\n')});
  await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('denial timeout')),2000);})]);
  assert.match(reply,/403/);assert.deepEqual(counts,{request:0,socket:0,dns:0});
  console.log('DESTINATION_DENIED_WITH_ZERO_FORWARDING');
 }finally{clearTimeout(timer);http.request=originalRequest;net.Socket.prototype.connect=originalConnect;dns.lookup=originalLookup;socket.destroy();try{await proxy.close();}catch{}}
 process.exit(0);
})().catch(error=>{console.error(error.message);process.exit(0)});`, /browser-proxy-denied-destination/);
  assert.match(value.stdout, /DESTINATION_DENIED_WITH_ZERO_FORWARDING/);
});

for (const operation of ['send', 'connect']) test('UDP ' + operation + ' remains sticky-fatal', () => blocked(`
const socket=require('node:dgram').createSocket('udp4');
console.log('PROBE_ACTION_REACHED');
try{if(${JSON.stringify(operation)}==='send')socket.send(Buffer.from('probe'),9,'203.0.113.1');else socket.connect(9,'203.0.113.1');}catch{}
try{socket.close();}catch{}process.exit(0);`, new RegExp('^udp-' + operation + '$')));

test('proxy cleanup cannot hide malformed HTTP', () => blocked(`
const net=require('node:net');const {startProxy}=require('./lib/loopback-proxy.cjs');
(async()=>{const proxy=await startProxy(),url=new URL(proxy.url);console.log('PROBE_ACTION_REACHED');
await new Promise(resolve=>{const socket=net.connect(Number(url.port),url.hostname,()=>socket.write('INVALID\\x00HTTP\\r\\n\\r\\n'));socket.on('error',()=>{});socket.on('close',resolve);});
try{await proxy.close();}catch{}process.exit(0);})().catch(()=>process.exit(0));`, /browser-proxy-malformed-request code=HPE_/));

for (const code of ['ECONNRESET', 'ECONNABORTED']) test('downstream cancellation is diagnostic-only: ' + code, () => {
  const value = probe(`
const assert=require('node:assert/strict'),http=require('node:http');const original=http.createServer;let server;
http.createServer=(...args)=>(server=original(...args));
const {startProxy}=require('./lib/loopback-proxy.cjs');
(async()=>{const proxy=await startProxy();http.createServer=original;let destroyed=0;
console.log('PROBE_ACTION_REACHED');
server.emit('clientError',{code:${JSON.stringify(code)}},{destroy(){destroyed++;}});
assert.equal(destroyed,1);
const events=proxy.diagnostics().events.filter(event=>event.event==='downstream-cancel');
assert.equal(events.length,1);assert.equal(events[0].phase,'running');assert.ok(events[0].sid>0);
await proxy.close();console.log('DOWNSTREAM_CANCELLATION_RECORDED');
})().catch(error=>{console.error(error.message);process.exitCode=1;});`);
  assert.equal(value.error, undefined, value.error?.code);
  assert.equal(value.status, 0, value.stderr);
  assert.equal(value.poisoned, false, JSON.stringify(value.reasons));
  assert.match(value.stdout, /PROBE_ACTION_REACHED/);
  assert.match(value.stdout, /DOWNSTREAM_CANCELLATION_RECORDED/);
});

for (const code of ['HPE_INVALID_METHOD', 'UNKNOWN', 'ETIMEDOUT']) test('non-cancellation client error remains sticky-fatal: ' + code, () => blocked(`
const http=require('node:http');const original=http.createServer;let server;
http.createServer=(...args)=>(server=original(...args));
const {startProxy}=require('./lib/loopback-proxy.cjs');
(async()=>{const proxy=await startProxy();http.createServer=original;console.log('PROBE_ACTION_REACHED');
server.emit('clientError',{code:${JSON.stringify(code)}},{destroy(){}});
try{await proxy.close();}catch{}process.exit(0);})().catch(()=>process.exit(0));`, new RegExp('browser-proxy-malformed-request code=' + code)));

test('refused registered loopback fails as transport, not HTTP502', () => {
  const value = probe(`const assert=require('node:assert/strict'),http=require('node:http');
const {startProxy}=require('./lib/loopback-proxy.cjs');
(async()=>{const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;await new Promise(r=>server.close(r));const proxy=await startProxy();
console.log('PROBE_ACTION_REACHED');let timer;
try{const result=await Promise.race([new Promise(resolve=>{http.get(proxy.url,{path:'http://127.0.0.1:'+port+'/offline'},res=>{res.resume();resolve({status:res.statusCode});}).on('error',error=>resolve({error:error.code}));}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('transport timeout')),2000);})]);
assert.equal(result.status,undefined);assert.ok(result.error);console.log('TRANSPORT_REJECTED');
}finally{clearTimeout(timer);await proxy.close();}})().catch(error=>{console.error(error.message);process.exitCode=1;});`);
  assert.equal(value.status, 0, value.stderr); assert.equal(value.poisoned, false, JSON.stringify(value.reasons));
  assert.match(value.stdout, /TRANSPORT_REJECTED/);
});

test('missing Node preload is rejected before launching any browser', () => {
  const value = probe(`require(${JSON.stringify(browserFixture)}).chromium.launch().catch(()=>process.exit(7));`, { guarded: false });
  assert.equal(value.status, 7);
});
test('loopback HTTP positive control succeeds through guarded browser proxy', () => {
  const value = probe(`${browserPrelude}(async()=>{const server=http.createServer((q,s)=>s.end('<title>local</title>'));await new Promise(r=>server.listen(0,'127.0.0.1',r));const b=await chromium.launch({args:['--enable-automation']});try{
const assert=require('node:assert/strict'),cdp=await b.newBrowserCDPSession();
try{
 const result=await cdp.send('Browser.getBrowserCommandLine'),args=result.arguments;
 assert.ok(Array.isArray(args),'Browser command-line proof available');
 const proxy=args.filter(value=>value.startsWith('--proxy-server='));
 assert.ok(proxy.length===1,'Exactly one proxy server required');
 const prefix='--proxy-server=http://127.0.0.1:';
 assert.ok(proxy[0].startsWith(prefix),'Proxy server must be exact IPv4 loopback HTTP');
 const portText=proxy[0].slice(prefix.length),port=Number(portText);
 assert.ok(Number.isInteger(port)&&port>0&&port<=65535&&String(port)===portText,'Proxy port must be canonical and valid');
 const bypass=args.filter(value=>value.startsWith('--proxy-bypass-list='));
 assert.ok(bypass.length===1,'Exactly one bypass flag required');
 const tokens=bypass[0].slice('--proxy-bypass-list='.length).split(';');
 assert.ok(tokens.length>0&&tokens.every(value=>value==='<-loopback>'),'No loopback-host bypass allowed');
 assert.ok(args.includes('--disable-quic')&&!args.some(value=>value==='--enable-quic'||value.startsWith('--enable-quic=')),'QUIC must remain disabled');
 const rtc=args.filter(value=>value.startsWith('--force-webrtc-ip-handling-policy='));
 assert.ok(rtc.length===1&&rtc[0]==='--force-webrtc-ip-handling-policy=disable_non_proxied_udp','WebRTC must forbid nonproxied UDP');
}finally{await cdp.detach();}
const p=await b.newPage();await p.goto('http://127.0.0.1:'+server.address().port);if(await p.title()!=='local')throw Error('positive failed');}finally{await b.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e.message);process.exit(2)});`);
  assert.equal(value.error, undefined, value.error?.code);
  assert.equal(value.status, 0, value.stderr?.slice(-1200));
  assert.equal(value.poisoned, false);
});
for (const [name, operation] of [
  ['TCP', "require('node:net').connect(443,'example.invalid').on('error',()=>{})"],
  ['TLS', "require('node:tls').connect(443,'example.invalid').on('error',()=>{})"],
  ['DNS', "require('node:dns').lookup('example.invalid',()=>{})"],
  ['HTTP', "require('node:http').get('http://example.invalid/',()=>{}).on('error',()=>{})"],
  ['HTTPS', "require('node:https').get('https://example.invalid/',()=>{}).on('error',()=>{})"],
  ['fetch', "fetch('https://example.invalid/').catch(()=>{})"]
]) test('Node ' + name + ' is sticky-fatal even when error is caught', () => blocked(`console.log('PROBE_ACTION_REACHED');try{${operation}}catch{}setTimeout(()=>process.exit(0),100);`, /socket|dns/i));

test('child cannot strip the mandatory preload', () => blocked("console.log('PROBE_ACTION_REACHED');try{require('node:child_process').spawnSync(process.execPath,['-e','process.exit(0)'],{env:{PATH:process.env.PATH}})}catch{}process.exit(0)", /child-stripped/));
test('unapproved child binary is denied without execution', () => blocked("console.log('PROBE_ACTION_REACHED');try{require('node:child_process').spawnSync('curl',['https://example.invalid/'])}catch{}process.exit(0)", /unapproved-child/));
test('ordinary Node child inherits the guard and cannot hide its denial', () => blocked("console.log('PROBE_ACTION_REACHED');require('node:child_process').spawnSync(process.execPath,['-e',\"try{require('node:net').connect(443,'example.invalid')}catch{}process.exit(0)\"],{stdio:'pipe'});process.exit(0)", /socket/));

for (const [name, action] of [
  ['page fetch', "await p.evaluate(()=>fetch('https://example.invalid/').catch(()=>null))"],
  ['page module', "await p.evaluate(()=>import('https://example.invalid/module.js').catch(()=>null))"],
  ['plain WebSocket', "await p.evaluate(()=>new Promise(r=>{const w=new WebSocket('ws://example.invalid/');w.onerror=()=>r();setTimeout(r,1000)}))"],
  ['WebSocket', "await p.evaluate(()=>new Promise(r=>{const w=new WebSocket('wss://example.invalid/');w.onerror=()=>r();setTimeout(r,1000)}))"],
  ['service-worker importScripts', "await p.evaluate(()=>navigator.serviceWorker.register('/bad-worker.js').catch(()=>null))"],
  ['service-worker fetch', "await p.evaluate(()=>navigator.serviceWorker.register('/fetch-worker.js').catch(()=>null))"],
  ['redirect', "await p.goto(base+'/redirect').catch(()=>null)"]
]) test('browser ' + name + ' escape fails without external forwarding', () => blocked(`${browserPrelude}(async()=>{
 const server=http.createServer((q,s)=>{if(q.url==='/redirect'){s.writeHead(302,{Location:'https://example.invalid/'});s.end();return;}if(q.url.endsWith('worker.js')){s.setHeader('Content-Type','text/javascript');s.end(q.url==='/bad-worker.js'?"importScripts('https://example.invalid/worker.js')":"self.addEventListener('install',e=>e.waitUntil(fetch('https://example.invalid/').catch(()=>null)))");return;}s.end('<title>local</title>')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;const b=await chromium.launch();const p=await b.newPage();try{await p.goto(base);console.log('PROBE_ACTION_REACHED');${action};await new Promise(r=>setTimeout(r,150));}finally{try{await b.close()}catch{}await new Promise(r=>server.close(r));}process.exit(0)
})().catch(()=>process.exit(0));`, /browser-proxy-denied|Unexpected browser request/));

test('registered loopback WebSocket handshake and close succeed', () => {
  const value = probe(`${browserPrelude}
const {createHash}=require('node:crypto');
(async()=>{
 let upgraded=0;
 const server=http.createServer((request,response)=>response.end('<title>local WS</title>'));
 server.on('upgrade',(request,socket)=>{
  upgraded++;
  const accept=createHash('sha1').update(request.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n');
  socket.once('data',()=>socket.end(Buffer.from([0x88,0])));
  socket.on('error',()=>{});
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
  await page.evaluate(url=>new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('local WS timeout')),2000),socket=new WebSocket(url);
   socket.onopen=()=>socket.close();socket.onerror=()=>{clearTimeout(timer);reject(Error('local WS failed'));};
   socket.onclose=()=>{clearTimeout(timer);resolve();};
  }),'ws://127.0.0.1:'+server.address().port+'/socket');
  if(upgraded!==1)throw Error('expected one actual loopback upgrade');
  console.log('LOCAL_WS_CLOSED');
 }finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error.message);process.exitCode=1;});`);
  assert.equal(value.error, undefined, value.error?.code);
  assert.equal(value.status, 0, value.stderr);
  assert.equal(value.poisoned, false, JSON.stringify(value.reasons));
  assert.match(value.stdout, /LOCAL_WS_CLOSED/);
});

for (const kind of ['worker-import', 'worker-fetch', 'websocket']) {
  test('unregistered loopback port is denied before forwarding: ' + kind, async () => {
    // Reserve a real local port outside the guarded child. It must never become
    // registered merely because its hostname is loopback.
    let forwarded = 0, connections = 0;
    const sentinel = http.createServer((request, response) => { forwarded++; response.end('unregistered'); });
    sentinel.on('connection', () => { connections++; });
    sentinel.on('upgrade', (request, socket) => { forwarded++; socket.destroy(); });
    await new Promise(resolve => sentinel.listen(0, '127.0.0.1', resolve));
    const targetPort = sentinel.address().port;
    try {
      blocked(`${browserPrelude}
const assert=require('node:assert/strict'),guard=require(${JSON.stringify(guard)});
(async()=>{
 const target='http://127.0.0.1:${targetPort}/unregistered';
 assert.equal(guard.isAllowedEndpoint('127.0.0.1',${targetPort}),false);
 const server=http.createServer((request,response)=>{
  if(request.url==='/probe-worker.js'){
   response.setHeader('Content-Type','text/javascript');
   response.end(${JSON.stringify(kind)}==='worker-import'
    ? 'importScripts('+JSON.stringify(target)+')'
    : "self.addEventListener('install',e=>e.waitUntil(fetch("+JSON.stringify(target)+").catch(()=>null)))");
  }else response.end('<title>registered fixture</title>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch();const page=await browser.newPage();
 // Isolate the mandatory proxy layer for SW requests: only this exact reserved
 // sentinel URL may pass the context fallback. It must still fail at the proxy.
 if(${JSON.stringify(kind)}!=='websocket')await page.context().route(url=>url.href===target,route=>route.continue());
 try{
  await page.goto('http://127.0.0.1:'+server.address().port);
  console.log('PROBE_ACTION_REACHED');
  if(${JSON.stringify(kind)}==='websocket')await page.evaluate(url=>new Promise(resolve=>{
   const socket=new WebSocket(url.replace('http:','ws:'));socket.onerror=resolve;
   setTimeout(resolve,1500);
  }),target);
  else await page.evaluate(()=>navigator.serviceWorker.register('/probe-worker.js').catch(()=>null));
  await new Promise(resolve=>setTimeout(resolve,150));
 }finally{try{await browser.close()}catch{}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 process.exit(0);
})().catch(error=>{console.error(error.message);process.exit(0)});`, /browser-proxy-denied-destination/);
      // Give any accidentally forwarded local connection a chance to reach the
      // sentinel. The proxy-denied category above is independently mandatory.
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(connections, 0, 'unregistered local service must receive no TCP connection');
      assert.equal(forwarded, 0, 'unregistered local service must receive no request');
    } finally {
      sentinel.closeAllConnections();
      await new Promise(resolve => sentinel.close(resolve));
    }
  });
}

test('both worker imports are required and unknown external imports reject', () => {
  const source = fs.readFileSync(new URL('../firebase-messaging-sw.js', import.meta.url), 'utf8');
  const localized = localizeWorker(source);
  assert.doesNotMatch(localized, /importScripts\s*\([^)]*https?:/s);
  assert.throws(() => localizeWorker(source.replace('firebase-app-compat.js', 'missing.js')), /exactly one/);
  assert.throws(() => localizeWorker(source + "\nimportScripts('https://example.invalid/extra.js');"), /external worker import/);
});
