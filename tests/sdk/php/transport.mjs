import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startWorkspaceServer } from '../../helpers/workspace-server.mjs';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Real accepted/lost/rejected HTTP lifecycle, shared by host and installed PHP acceptance. */
export async function transportChecks({ fixture, runPhp, docker = false }) {
  const c = fixture.client;
  const policies = new Map(); const acceptedRuns = new Set(); const trace = []; const proxyErrors = [];
  const legacyKeys = new Set(); let binaryRequests = 0; let readRequests = 0;
  const json = (response, status, body) => {
    const bytes = JSON.stringify(body);
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes) }); response.end(bytes);
  };
  const denial = response => json(response, 403, { error: { code: 'FORBIDDEN', message: 'Owned transport policy rejection' } });
  const proxy = createServer(async (request, response) => {
    try {
      if (request.headers['x-api-key'] !== c.keyA) { request.resume(); denial(response); return; }
      const url = new URL(request.url, 'http://owned-fixture');
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks); const key = request.headers['idempotency-key'];
      if (url.pathname === '/transport-control') {
        const mode = url.searchParams.get('mode'); const workspace = url.searchParams.get('workspace');
        if (['drop-reopen', 'deny-reopen', 'allow-reopen'].includes(mode) && workspace) policies.set(workspace, mode);
        const runs = mode === 'trace' ? await Promise.all([...acceptedRuns].map(async id => {
          const run = await (await fetch(c.baseUrl + '/v1/runs/' + id, { headers: { 'X-API-Key': c.keyA } })).json();
          return { id, state: run.state };
        })) : [];
        json(response, 200, mode === 'trace' ? { events: trace, runs, binaryRequests, readRequests } : { configured: true }); return;
      }
      if (url.pathname === '/transport-read') {
        if (++readRequests < 3) response.destroy(); else json(response, 200, { read: true }); return;
      }
      if (url.pathname === '/transport-legacy') {
        trace.push({ kind: 'legacy', method: request.method, key });
        if (legacyKeys.has(key)) denial(response); else { legacyKeys.add(key); response.destroy(); } return;
      }
      if (url.pathname === '/transport-binary') {
        binaryRequests++;
        assert.equal(body.toString('hex'), Buffer.from('binary-upload\0\xff', 'latin1').toString('hex'));
        trace.push({ kind: 'binary', key, bytes: body.length }); response.destroy(); return;
      }
      const opening = request.method === 'POST' && /^\/v1\/workspaces\/([^/?]+)\/runs$/.exec(url.pathname);
      const policy = opening ? policies.get(decodeURIComponent(opening[1])) : undefined;
      if (opening && policy === 'deny-reopen') {
        trace.push({ kind: 'denied-reopen', key, body: body.toString(), status: 403 }); denial(response); return;
      }
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !['host', 'connection', 'content-length', 'transfer-encoding', 'expect'].includes(name)));
      const upstream = await fetch(c.baseUrl + request.url, { method: request.method, headers,
        ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body }), redirect: 'manual' });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (opening) {
        const run = JSON.parse(bytes); if (upstream.ok) acceptedRuns.add(run.id);
        trace.push({ kind: policy === 'drop-reopen' ? 'accepted-reopen-dropped' : 'accepted-open', key, body: body.toString(), status: upstream.status, runId: run.id });
        if (policy === 'drop-reopen') { policies.set(decodeURIComponent(opening[1]), 'deny-reopen'); response.destroy(); return; }
      }
      if (request.method === 'POST' && url.pathname.endsWith('/finalize')) trace.push({ kind: 'finalize', key, status: upstream.status });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'content-length': bytes.length,
        ...(upstream.headers.has('x-content-sha256') ? { 'x-content-sha256': upstream.headers.get('x-content-sha256') } : {}) }); response.end(bytes);
    } catch (error) { proxyErrors.push(error); response.destroy(error); }
  });
  await new Promise(resolve => proxy.listen(0, '0.0.0.0', resolve));
  try {
    const origin = `http://${docker ? 'host.docker.internal' : '127.0.0.1'}:${proxy.address().port}`;
    const { stdout } = await runPhp({ CV_TRANSPORT_URL: origin, CV_KEY_A: c.keyA, CV_CUSTOMER_A: c.customerA });
    assert.deepEqual(proxyErrors, [], 'The relay must not hide assertion or forwarding failures');
    const result = JSON.parse(stdout.trim());
    const dropped = trace.find(event => event.kind === 'accepted-reopen-dropped');
    const accepted = await (await fetch(c.baseUrl + '/v1/runs/' + dropped.runId, { headers: { 'X-API-Key': c.keyA } })).json();
    // Print the original RED evidence before assertions; cleanup below aborts any exact owned orphan.
    if (result.checkpointError !== 'PUBLICATION_OUTCOME_UNKNOWN' || !result.pathRetained) process.stderr.write(JSON.stringify({ transportFailure: result, acceptedRunState: accepted.state }) + '\n');
    assert.equal(result.checkpointError, 'PUBLICATION_OUTCOME_UNKNOWN', 'An accepted lost response must remain uncertain');
    assert.equal(result.before.pending.kind, 'run:open'); assert.equal(result.before.acceptancePossible, true); assert.equal(result.before.proof, null);
    assert.equal(result.before.receiptRetained, true); assert.equal(result.pathRetained, true); assert.equal(result.captureRetained, true);
    assert.equal(result.abandonError, 'RECONCILIATION_REQUIRED'); assert.equal(result.cleanupError, 'RECONCILIATION_REQUIRED');
    assert.equal(result.firstTrace.events.filter(event => event.key === dropped.key).length, 1, 'One physical reopen before explicit retry');
    assert.deepEqual(result.firstTrace.runs.find(run => run.id === dropped.runId), { id: dropped.runId, state: 'active' });
    assert.equal(result.laterRejection, 'FORBIDDEN'); assert.equal(result.laterProtected, true);
    assert.equal(result.reconciledRun, dropped.runId); assert.equal(result.reconciledReceipt, true); assert.equal(result.samePath, true);
    const attempts = trace.filter(event => event.key === dropped.key);
    assert.equal(attempts.length, 3); assert.ok(attempts.every(event => event.body === dropped.body));
    assert.equal(attempts[1].kind, 'denied-reopen'); assert.equal(attempts[2].kind, 'accepted-open');
    assert.equal(trace.filter(event => event.kind === 'finalize').length, 2, 'Neither recovery retry republishes the accepted checkpoint');
    assert.equal(result.firstRejection, 'FORBIDDEN'); assert.equal(result.firstRejectionAbandoned, true);
    assert.equal(result.firstRejectionProof.status, 403); assert.equal(result.firstRejectionProof.requests, 1);
    assert.equal(trace.filter(event => event.key === result.firstRejectionProof.idempotencyKey).length, 1);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.deepEqual(result.legacy[method], { error: 'NETWORK_ERROR', proof: null });
      assert.equal(trace.filter(event => event.kind === 'legacy' && event.method === method).length, 1);
    }
    assert.equal(result.binaryError, 'NETWORK_ERROR'); assert.equal(binaryRequests, 1);
    assert.deepEqual(result.readResult, { read: true }); assert.equal(readRequests, 3);
    return { runtime: result.runtime, curl: result.curl, acceptedLostReopenProtected: true, sameKeyReconciliation: true,
      genuineFirstRejectionAbandoned: true, legacyMutations: 4, binaryRequests, readRequests, reopenRequests: attempts.length };
  } finally {
    try {
      for (const id of acceptedRuns) {
        const run = await (await fetch(c.baseUrl + '/v1/runs/' + id, { headers: { 'X-API-Key': c.keyA } })).json();
        if (run.state === 'active') {
          const response = await fetch(c.baseUrl + '/v1/runs/' + id + '/abort', { method: 'POST', headers: { 'X-API-Key': c.keyA, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
            body: JSON.stringify({ expectedRunVersion: run.version, reason: 'owned transport acceptance cleanup' }) });
          assert.equal(response.status, 200); await response.body?.cancel();
        }
      }
    } finally { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(value => !['--host', '--git-only'].includes(value))) throw new Error('Use --host [--git-only]');
  const results = {};
  for (const backend of process.argv.includes('--git-only') ? ['git'] : ['git', 's3']) {
    const fixture = await startWorkspaceServer({ backend });
    try {
      results[backend] = await transportChecks({ fixture, runPhp: variables => execute('php', [path.join(root, 'tests/sdk/php/transport.php')], {
        timeout: 30_000, maxBuffer: 200_000, env: { ...process.env, ...variables, CV_PHP_AUTOLOAD: path.join(root, 'sdk/php/vendor/autoload.php') },
      }) });
    } finally { await fixture.dispose(); }
  }
  process.stdout.write(JSON.stringify(results) + '\n');
}
