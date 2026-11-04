import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const execute = promisify(execFile);
const ownerLabel = 'io.contextvault.relay-startup.owner';
const image = 'node:18-bookworm-slim';

// Control DNS only. Requests, concurrent upstream handling, sockets, and the relay are real Node18 HTTP.
const resolver = String.raw`
'use strict';
const dns = require('node:dns');
const net = require('node:net');
const originalLookup = dns.lookup;
let lookups = 0;
function lookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (hostname !== 'fixture-upstream.invalid') return originalLookup(hostname, options, callback);
  lookups++;
  process.send({ type: 'lookup', hostname, count: lookups });
  if (process.env.DNS_MODE === 'stall' || lookups > 1) return;
  queueMicrotask(() => {
    if (process.env.DNS_MODE === 'failure') callback(Object.assign(new Error('Controlled resolution failure'), { code: 'ENOTFOUND' }));
    else if (options && options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  });
}
dns.lookup = lookup;
require('node:dns/promises').lookup = (hostname, options) => new Promise((resolve, reject) => lookup(hostname, options, (error, address, family) => {
  if (error) reject(error); else resolve(options && options.all ? address : { address, family });
}));
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  this.once('listening', () => process.send({ type: 'listening', address: this.address(), lookups }));
  return originalListen.apply(this, args);
};
`;

const runner = String.raw`
'use strict';
const http = require('node:http');
const { fork } = require('node:child_process');
const { join } = require('node:path');
const mode = process.argv[2];
const received = []; const concurrent = []; let maximumConcurrent = 0;
const upstream = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const item = { path: request.url, method: request.method, key: request.headers['idempotency-key'], host: request.headers.host, body: Buffer.concat(chunks).toString(), controlToken: request.headers['x-control-token'] ?? null };
  received.push(item);
  const reply = () => { const bytes = JSON.stringify({ received: item }); response.writeHead(request.url.endsWith('/finalize') ? 202 : 200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes) }); response.end(bytes); };
  if (request.url.startsWith('/v1/concurrent/')) {
    concurrent.push(reply); maximumConcurrent = Math.max(maximumConcurrent, concurrent.length);
    if (concurrent.length === 2) concurrent.splice(0).forEach(finish => finish());
  } else reply();
});
function bounded(promise, milliseconds) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned probe deadline')), milliseconds); })]).finally(() => clearTimeout(timer));
}
function request(path, method = 'GET', body, headers = {}) {
  return new Promise(resolve => {
    const value = body === undefined ? undefined : Buffer.from(body);
    const outgoing = http.request({ hostname: '127.0.0.1', port: 8080, path, method, agent: false, signal: AbortSignal.timeout(1800), headers: { ...headers, ...(value ? { 'content-length': value.length } : {}) } });
    outgoing.once('error', error => resolve({ error: error.code ?? error.name }));
    outgoing.once('connect', (_response, socket) => { socket.destroy(); resolve({ connected: true }); });
    outgoing.once('upgrade', (_response, socket) => { socket.destroy(); resolve({ upgraded: true }); });
    outgoing.once('response', incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.once('end', () => resolve({ status: incoming.statusCode, complete: incoming.complete, body: Buffer.concat(chunks).toString() }));
      incoming.once('aborted', () => resolve({ status: incoming.statusCode, complete: false, body: Buffer.concat(chunks).toString() }));
      incoming.once('error', error => resolve({ error: error.code ?? error.name }));
    });
    outgoing.end(value);
  });
}
(async () => {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const host = 'fixture-upstream.invalid:' + upstream.address().port;
  const messages = []; let stderr = ''; const began = performance.now();
  const child = fork(join(__dirname, 'relay.cjs'), [], { execArgv: ['-r', join(__dirname, 'resolver.cjs')], env: { ...process.env, UPSTREAM: 'http://' + host, CONTROL_TOKEN: 'owned-control-token', DNS_MODE: mode }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-8192); });
  let exited = null;
  const closed = new Promise(resolve => child.once('close', (code, signal) => { exited = { code, signal }; resolve(exited); }));
  const listening = new Promise(resolve => child.on('message', value => { messages.push(value); if (value.type === 'listening') resolve({ type: 'ready', value }); }));
  let result;
  try {
    const startup = await bounded(Promise.race([listening, closed.then(value => ({ type: 'exit', value }))]), 7000);
    result = { node: process.versions.node, mode, startup, startupMs: performance.now() - began, stderr, received, messages };
    if (mode === 'success' && startup.type === 'ready') {
      result.concurrentResponses = await Promise.all([
        request('/v1/concurrent/first', 'POST', 'first-body', { 'idempotency-key': 'first-command', 'x-control-token': 'not-for-upstream' }),
        request('/v1/concurrent/second', 'POST', 'second-body', { 'idempotency-key': 'second-command' }),
      ]);
      result.maximumConcurrent = maximumConcurrent;
      if (result.concurrentResponses.every(response => response.status === 200)) {
        const controlHeaders = { 'x-control-token': 'owned-control-token', 'content-type': 'application/json' };
        result.absolute = await request('http://elsewhere.invalid/v1/escape');
        result.authority = await request('//elsewhere.invalid/v1/escape');
        result.connect = await request('elsewhere.invalid:443', 'CONNECT');
        result.upgrade = await request('/v1/escape', 'GET', undefined, { connection: 'Upgrade', upgrade: 'websocket' });
        result.deniedControl = await request('/__control');
        result.arm = await request('/__control', 'POST', JSON.stringify({ drop: true }), controlHeaders);
        result.dropped = await request('/v1/publication/finalize', 'POST', '{}', { 'idempotency-key': 'dropped-command' });
        result.afterDrop = await request('/v1/publication/finalize', 'POST', '{}', { 'idempotency-key': 'following-command' });
        result.evidence = JSON.parse((await request('/__control', 'GET', undefined, controlHeaders)).body);
      }
      result.host = host;
      result.lookups = messages.filter(value => value.type === 'lookup').length;
    }
  } finally {
    if (!exited) child.kill('SIGTERM');
    try { await bounded(closed, 1000); } catch { child.kill('SIGKILL'); await closed; }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
  console.log(JSON.stringify(result));
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

async function probe(mode: 'success' | 'failure' | 'stall') {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'cv-relay-startup-'));
  const id = randomUUID();
  const name = 'cv-relay-startup-' + id;
  let created = false;
  const docker = async (args: string[]) => execute('docker', args, { timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 });
  try {
    await cp(join(import.meta.dirname, 'relay.cjs'), join(directory, 'relay.cjs'));
    await writeFile(join(directory, 'resolver.cjs'), resolver);
    await writeFile(join(directory, 'runner.cjs'), runner);
    await docker(['create', '--name', name, '--label', ownerLabel + '=' + id, '--network=none', '--read-only', '--mount', 'type=bind,src=' + directory + ',dst=/probe,readonly', image, 'node', '/probe/runner.cjs', mode]); created = true;
    const result = await docker(['start', '--attach', name]);
    return JSON.parse(result.stdout.trim());
  } finally {
    if (created) {
      const owner = (await docker(['inspect', '--format', '{{index .Config.Labels "' + ownerLabel + '"}}', name])).stdout.trim();
      if (owner !== id) throw new Error('Refusing another relay-startup container owner');
      await docker(['rm', '--force', name]);
    }
    await rm(directory, { recursive: true, force: true });
  }
}

it('resolves the fixed upstream once before readiness and forwards concurrent mutations exactly once on Node18', async () => {
  const result = await probe('success');
  expect(result.node).toMatch(/^18\./);
  expect(result.concurrentResponses).toEqual(expect.arrayContaining([expect.objectContaining({ status: 200, complete: true }), expect.objectContaining({ status: 200, complete: true })]));
  expect(result.startup.value.lookups).toBe(1);
  expect(result.lookups).toBe(1);
  expect(result.maximumConcurrent).toBe(2);
  expect(result.received.filter((item: any) => item.path.startsWith('/v1/concurrent/')).map((item: any) => ({ key: item.key, body: item.body, host: item.host, controlToken: item.controlToken })).sort((a: any, b: any) => a.key.localeCompare(b.key))).toEqual([
    { key: 'first-command', body: 'first-body', host: result.host, controlToken: null },
    { key: 'second-command', body: 'second-body', host: result.host, controlToken: null },
  ]);
  expect(result.absolute.status).toBe(400);
  expect(result.authority.status).toBe(400);
  expect(result.connect.connected).not.toBe(true);
  expect(result.upgrade.upgraded).not.toBe(true);
  expect(result.deniedControl.status).toBe(403);
  expect(result.arm.status).toBe(200);
  expect(result.dropped).toMatchObject({ status: 202, complete: false, body: '{"id":' });
  expect(result.afterDrop).toMatchObject({ status: 202, complete: true });
  expect(result.received.filter((item: any) => item.path.endsWith('/finalize')).map((item: any) => item.key)).toEqual(['dropped-command', 'following-command']);
  expect(result.received).toHaveLength(4);
  expect(result.evidence.commandKeys.map((item: any) => item.key)).toEqual(['dropped-command', 'following-command']);
});

it('fails startup without opening a listener when fixed upstream resolution fails', async () => {
  const result = await probe('failure');
  expect(result.startup).toMatchObject({ type: 'exit', value: { code: 1 } });
  expect(result.messages.filter((message: any) => message.type === 'lookup')).toHaveLength(1);
  expect(result.messages.some((message: any) => message.type === 'listening')).toBe(false);
  expect(result.stderr).toContain('ENOTFOUND');
  expect(result.received).toEqual([]);
});

it('fails bounded startup without readiness when fixed upstream resolution stalls', async () => {
  const result = await probe('stall');
  expect(result.startup).toMatchObject({ type: 'exit', value: { code: 1 } });
  expect(result.messages.filter((message: any) => message.type === 'lookup')).toHaveLength(1);
  expect(result.messages.some((message: any) => message.type === 'listening')).toBe(false);
  expect(result.stderr).toContain('UPSTREAM_RESOLUTION_TIMEOUT');
  expect(result.startupMs).toBeLessThan(6500);
  expect(result.received).toEqual([]);
});
