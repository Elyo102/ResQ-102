'use strict';
const http = require('node:http');
const net = require('node:net');
const guard = require('./network-guard.cjs');

function closeHeaders(input) {
  const nominated = Object.entries(input).filter(([key]) => key.toLowerCase() === 'connection')
    .flatMap(([, value]) => String(value).toLowerCase().split(',').map(value => value.trim()));
  const excluded = new Set([...nominated, 'connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
  return { ...Object.fromEntries(Object.entries(input).filter(([key]) => !excluded.has(key.toLowerCase()))), connection: 'close' };
}

function endpoint(authority, protocol = 'http:') {
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::[1-9]\d{0,4})?$/.test(authority)) return null;
  let url;
  try { url = new URL(protocol + '//' + authority); } catch (_) { return null; }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  const port = url.port || (protocol === 'https:' ? '443' : '80');
  return guard.isAllowedEndpoint(url.hostname, port) ? { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(port) } : null;
}
async function startProxy() {
  guard.assertActive();
  let browserClosing = false;
  const sockets = new Set();
  const requests = new Set();
  const active = new Set();
  const waiters = new Set();
  const ids = new WeakMap();
  const events = [];
  let nextSocket = 0, nextRequest = 0;
  function socketId(socket) {
    if (!ids.has(socket)) ids.set(socket, ++nextSocket);
    return ids.get(socket);
  }
  function record(event, rid = 0, sid = 0) {
    events.push({ event, rid, sid, phase: browserClosing ? 'closing' : 'running' });
    if (events.length > 128) events.shift();
  }
  function notify() { for (const waiter of [...waiters]) waiter(); }
  function drain(timeoutMs = 2000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) {
      guard.poison('browser-proxy-invalid-drain-timeout');
      throw new Error('Invalid bounded drain timeout');
    }
    guard.assertClean();
    // Global active HTTP only: not a claim of SW/WS/browser quiescence.
    if (!active.size) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer;
      const finish = error => { clearTimeout(timer); waiters.delete(check); error ? reject(error) : resolve(); };
      const check = () => { if (!active.size) { try { guard.assertClean(); finish(); } catch (error) { finish(error); } } };
      waiters.add(check);
      timer = setTimeout(() => {
        record('drain-timeout'); guard.poison('browser-proxy-http-drain-timeout');
        finish(new Error('Active HTTP requests did not drain before teardown'));
      }, timeoutMs);
      check();
    });
  }
  const proxyDestroyedSockets = new WeakSet();
  const ownedCancellation = new WeakSet();
  function cancelOwned(stream) { ownedCancellation.add(stream); stream.destroy(); }
  function upstreamFailure(error, stream) {
    if (error?.code === 'ETIMEDOUT') {
      record('upstream-timeout'); guard.poison('browser-proxy-upstream-timeout');
    }
    if (['ECONNRESET', 'ECONNABORTED'].includes(error?.code) && !ownedCancellation.has(stream)) {
      record('upstream-reset'); guard.poison('browser-proxy-unexpected-upstream-reset');
    }
  }
  function refuse(socket) {
    guard.poison('browser-proxy-denied-destination');
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  }
  const server = http.createServer((request, response) => {
    let url;
    try { url = new URL(request.url); } catch (_) { refuse(response.socket); return; }
    const rawAuthority = request.url.match(/^http:\/\/([^/\?#]+)/)?.[1];
    const destination = url.protocol === 'http:' && !url.username && !url.password && !url.hash
      ? endpoint(rawAuthority || '') : null;
    if (!destination) { refuse(response.socket); return; }
    const headers = { ...closeHeaders(request.headers), host: url.host };
    const rid = ++nextRequest, sid = socketId(request.socket);
    const entry = { upstreamClosed: false, responseClosed: false };
    active.add(entry); record('request-start', rid, sid);
    const settled = () => {
      if (entry.upstreamClosed && entry.responseClosed) { active.delete(entry); record('request-settled', rid, sid); notify(); }
    };
    response.once('close', () => { entry.responseClosed = true; record('response-close', rid, sid); settled(); });
    const upstream = http.request({ hostname: destination.host, port: destination.port,
      method: request.method, path: url.pathname + url.search, headers, agent: false }, incoming => {
      record('response-start', rid, sid);
      incoming.on('error', error => { upstreamFailure(error, upstream); response.destroy(); });
      incoming.on('aborted', () => { upstreamFailure({ code: 'ECONNRESET' }, upstream); response.destroy(); });
      response.writeHead(incoming.statusCode, closeHeaders(incoming.headers)); incoming.pipe(response);
    });
    requests.add(upstream);
    const cancel = () => cancelOwned(upstream);
    const closed = () => { if (!response.writableFinished) cancel(); };
    request.on('aborted', cancel); request.on('error', cancel);
    response.on('close', closed); response.on('error', cancel);
    upstream.once('close', () => {
      requests.delete(upstream);
      entry.upstreamClosed = true; record('upstream-close', rid, sid); settled();
      request.removeListener('aborted', cancel); request.removeListener('error', cancel);
      response.removeListener('close', closed); response.removeListener('error', cancel);
    });
    upstream.on('error', error => {
      upstreamFailure(error, upstream);
      if (response.destroyed) return;
      if (['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT'].includes(error.code)) {
        response.destroy(); return;
      }
      if (!response.headersSent && ['ECONNREFUSED', 'ENETUNREACH'].includes(error.code)) {
        // A synthetic HTTP502 would make fetch resolve and hide true offline
        // behavior from the worker. Preserve transport rejection for loopback.
        if (response.socket) proxyDestroyedSockets.add(response.socket);
        response.destroy(); return;
      }
      if (!response.headersSent) response.writeHead(502, closeHeaders({})); response.end();
    });
    request.pipe(upstream);
  });
  function tunnel(request, client, head, websocket) {
    let destination;
    if (websocket) {
      let url;
      try { url = new URL(request.url); } catch (_) { refuse(client); return; }
      if (!['http:', 'ws:'].includes(url.protocol) || url.username || url.password || url.hash) { refuse(client); return; }
      destination = endpoint(request.url.match(/^(?:http|ws):\/\/([^/\?#]+)/)?.[1] || '');
      request.url = url.pathname + url.search;
    } else destination = endpoint(request.url, 'https:');
    if (!destination) { refuse(client); return; }
    const upstream = net.connect(destination.port, destination.host, () => {
      if (websocket) {
        const headers = { ...request.headers }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
        upstream.write(request.method + ' ' + request.url + ' HTTP/' + request.httpVersion + '\r\n'
          + Object.entries(headers).map(([key, value]) => key + ': ' + value).join('\r\n') + '\r\n\r\n');
      } else client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', error => { upstreamFailure(error, upstream); client.destroy(); });
    client.on('error', () => cancelOwned(upstream));
    client.on('close', () => cancelOwned(upstream));
  }
  server.on('connect', (request, socket, head) => tunnel(request, socket, head, false));
  server.on('upgrade', (request, socket, head) => tunnel(request, socket, head, true));
  server.on('connection', socket => {
    const sid = socketId(socket); sockets.add(socket); record('socket-open', 0, sid);
    socket.on('close', () => { sockets.delete(socket); record('socket-close', 0, sid); });
  });
  server.on('clientError', (error, socket) => {
    const code = /^[A-Z0-9_]{1,40}$/.test(error?.code) ? error.code : 'UNKNOWN';
    record('client-error', 0, socketId(socket));
    // Contract: no unauthorized egress. Downstream transport cancellation does
    // not authorize any destination; malformed HTTP and all other errors fail.
    if (code === 'ECONNRESET' || code === 'ECONNABORTED') {
      record('downstream-cancel', 0, socketId(socket)); socket.destroy(); return;
    }
    guard.poison('browser-proxy-malformed-request code=' + code + ' phase=' + (browserClosing ? 'closing' : 'running')
      + ' proxyDestroyed=' + proxyDestroyedSockets.has(socket)); socket.destroy();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return Object.freeze({ url: 'http://127.0.0.1:' + server.address().port, assertClean: guard.assertClean,
    drain,
    diagnostics() { return { activeRequests: active.size, activeSockets: sockets.size, events: events.map(event => ({ ...event })) }; },
    beginBrowserClose() { browserClosing = true; },
    async close() {
      for (const request of requests) cancelOwned(request);
      for (const socket of sockets) cancelOwned(socket);
      await new Promise(resolve => server.close(resolve));
      guard.assertClean();
    } });
}
module.exports = Object.freeze({ startProxy });
