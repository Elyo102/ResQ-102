import http from 'node:http';
import fs from 'node:fs';

const rootWorker = new URL('../../firebase-messaging-sw.js', import.meta.url);
const sdk = [
  ['https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js', '/__contained_firebase_app.js'],
  ['https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js', '/__contained_firebase_messaging.js']
];
const stub = 'self.firebase = { initializeApp: function(){}, messaging: function(){ return { onBackgroundMessage: function(){} }; } };';
export function localizeWorker(source) {
  let result = String(source);
  for (const [remote, local] of sdk) {
    if (result.split(remote).length !== 2) throw new Error('Expected exactly one worker SDK import: ' + remote);
    result = result.replace(remote, local);
  }
  if (/importScripts\s*\([^)]*https?:/s.test(result)) throw new Error('Unexpected external worker import');
  return result;
}
// Explicit fixture-server adoption; no product writes or global response hooks.
export function createContainedServer(...args) {
  const handler = args.pop();
  if (typeof handler !== 'function') throw new Error('Fixture HTTP server needs an explicit handler');
  return http.createServer(...args, function (request, response) {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (sdk.some(([, local]) => local === pathname)) {
      response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(stub); return;
    }
    if (pathname === '/firebase-messaging-sw.js') {
      const source = localizeWorker(fs.readFileSync(rootWorker, 'utf8'));
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      response.end(source); return;
    }
    return handler.call(this, request, response);
  });
}
