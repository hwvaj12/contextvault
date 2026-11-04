'use strict';
const http = require('node:http');
const dns = require('node:dns');
const upstream = new URL(process.env.UPSTREAM);
if (upstream.pathname !== '/' || !['http:', 'https:'].includes(upstream.protocol)) throw new Error('Invalid fixed fixture origin');
let upstreamResolution;
let drop = false; let pause = null; let held = false; const commandKeys = []; const responses = []; const events = [];
let sequence = 0; const sockets = new WeakMap(); let socketSequence = 0;
function record(event, fields) { if (events.length < 10000) events.push({ at: Date.now(), event, ...fields }); }
function socketIdentity(socket, kind) {
  if (sockets.has(socket)) return sockets.get(socket);
  const id = ++socketSequence; sockets.set(socket, id);
  record('socket', { socketId: id, kind, connecting: socket.connecting });
  socket.once('lookup', (error, address, family, hostname) => record('socket-lookup', { socketId: id, hostname, address, family, code: error?.code ?? null }));
  socket.once('connect', () => record('socket-connect', { socketId: id, address: socket.remoteAddress, port: socket.remotePort }));
  socket.once('close', hadError => record('socket-close', { socketId: id, hadError, bytesRead: socket.bytesRead, bytesWritten: socket.bytesWritten }));
  socket.once('error', error => record('socket-error', { socketId: id, code: error.code }));
  return id;
}
const secret = process.env.CONTROL_TOKEN;
const server = http.createServer((request, response) => {
  if (request.url === '/__control') {
    if (request.headers['x-control-token'] !== secret) { response.writeHead(403); response.end(); return; }
    if (request.method === 'GET') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ held, commandKeys, responses, events, upstreamResolution })); return; }
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
    let data = ''; request.on('data', chunk => { data += chunk; if (data.length > 4096) request.destroy(); });
    request.on('end', () => { try { const command = JSON.parse(data); drop = command.drop === true; pause = command.pause ?? null; held = false; commandKeys.length = 0; responses.length = 0; events.length = 0; response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true })); } catch { response.writeHead(400); response.end(); } }); return;
  }
  // This is an API relay, never an open proxy. The destination origin is not caller-controlled.
  if (!request.url.startsWith('/v1/') && request.url !== '/health') { response.writeHead(400); response.end(); return; }
  const target = new URL(request.url, upstream);
  if (target.origin !== upstream.origin || request.url.startsWith('//')) { response.writeHead(400); response.end(); return; }
  const requestId = ++sequence; const clientSocketId = socketIdentity(request.socket, 'client');
  record('request', { requestId, socketId: clientSocketId, method: request.method, path: target.pathname, key: request.headers['idempotency-key'] ?? null, contentLength: request.headers['content-length'] ?? null });
  request.once('end', () => record('request-end', { requestId, complete: request.complete }));
  request.once('close', () => record('request-close', { requestId, complete: request.complete, aborted: request.aborted }));
  response.once('finish', () => record('client-response-finish', { requestId, status: response.statusCode }));
  const headers = { ...request.headers, host: upstream.host };
  if (request.method === 'POST') commandKeys.push({ path: target.pathname, key: request.headers['idempotency-key'] ?? null });
  for (const name of ['connection', 'proxy-connection', 'proxy-authorization', 'upgrade', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'x-control-token']) delete headers[name];
  const outgoing = http.request({ hostname: upstreamResolution.address, family: upstreamResolution.family, port: upstream.port, method: request.method, path: target.pathname + target.search, headers }, incoming => {
    record('upstream-response', { requestId, status: incoming.statusCode, contentLength: incoming.headers['content-length'] ?? null });
    incoming.once('end', () => record('upstream-response-end', { requestId, complete: incoming.complete }));
    incoming.once('aborted', () => record('upstream-response-aborted', { requestId }));
    incoming.once('error', error => record('upstream-response-error', { requestId, code: error.code }));
    responses.push({ path: target.pathname, status: incoming.statusCode, dropped: Boolean(drop && target.pathname.endsWith('/finalize') && incoming.statusCode === 202) });
    if (drop && request.method === 'POST' && target.pathname.endsWith('/finalize') && incoming.statusCode === 202) {
      drop = false; incoming.resume(); incoming.on('end', () => {
        // A zero-byte close can be transparently retried by cURL with the same key.
        // Truncate a real accepted response after headers, so every client sees uncertainty.
        response.writeHead(202, { 'content-type': 'application/json', 'content-length': '10000', connection: 'close' });
        response.end('{"id":');
      }); return;
    }
    const replyHeaders = { ...incoming.headers };
    for (const name of ['connection', 'keep-alive', 'transfer-encoding']) delete replyHeaders[name];
    response.writeHead(incoming.statusCode, replyHeaders); incoming.pipe(response); response.once('close', () => incoming.destroy());
  });
  outgoing.once('socket', socket => record('upstream-request-socket', { requestId, socketId: socketIdentity(socket, 'upstream'), reused: outgoing.reusedSocket }));
  outgoing.once('finish', () => record('upstream-request-finish', { requestId }));
  outgoing.once('close', () => record('upstream-request-close', { requestId, destroyed: outgoing.destroyed }));
  outgoing.once('error', error => { record('upstream-request-error', { requestId, code: error.code }); if (!response.headersSent) response.writeHead(502); response.end(); });
  request.once('aborted', () => { record('request-aborted', { requestId }); outgoing.destroy(); });
  response.once('close', () => { record('client-response-close', { requestId, finished: response.writableFinished, upstreamDestroyed: outgoing.destroyed }); outgoing.destroy(); });
  if (pause && target.pathname.endsWith(pause)) {
    // A test-only held request permits a real controller SIGKILL before any response.
    held = true; pause = null;
    setTimeout(() => { if (!outgoing.destroyed) request.pipe(outgoing); }, 3000).unref();
  } else request.pipe(outgoing);
});
server.on('connect', (_request, socket) => socket.destroy());
server.on('upgrade', (_request, socket) => socket.destroy());
async function start() {
  // The endpoint is fixed for this fixture. Bound only startup resolution; HTTP deadlines and retries stay unchanged.
  const timeoutMs = 5000; const startedAt = Date.now();
  const hostname = upstream.hostname.replace(/^\[(.*)\]$/, '$1');
  record('upstream-resolution-start', { hostname, timeoutMs });
  let timer;
  try {
    const selected = await Promise.race([
      new Promise((resolve, reject) => dns.lookup(hostname, { verbatim: true }, (error, address, family) => error ? reject(error) : resolve({ address, family }))),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Fixed upstream resolution exceeded 5000ms'), { code: 'UPSTREAM_RESOLUTION_TIMEOUT' })), timeoutMs); }),
    ]);
    upstreamResolution = Object.freeze({ hostname, ...selected, startedAt, resolvedAt: Date.now() });
    record('upstream-resolution-complete', upstreamResolution);
    server.listen(8080, '0.0.0.0');
  } finally { clearTimeout(timer); }
}
start().catch(error => {
  record('upstream-resolution-failed', { code: error.code ?? null });
  console.error('API relay startup failed: ' + (error.code ?? error.message));
  process.exit(1);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
