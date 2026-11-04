const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const http = require('node:http');
const sdk = require('@contextvault/sdk');
const fixture = require('./canonical.json');
const stopped = { writersStopped: true };
const request = { mode: 'read-write', agentLabel: 'installed-node18', task: 'sdk acceptance', reason: 'test' };
const config = { apiKey: process.env.CV_KEY_A, baseUrl: process.env.CV_URL, maxRetries: 0 };
const client = new sdk.ContextVaultClient(config);
const make = (name, extra = {}) => client.openWorkspace({ create: { customerId: process.env.CV_CUSTOMER_A, name }, ...request, ...extra });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const seed = async h => {
  for (const entry of fixture.input.entries) {
    if (entry.kind === 'directory') await fs.mkdir(path.join(h.path, entry.path));
    else await fs.writeFile(path.join(h.path, entry.path), Buffer.from(fixture.files[entry.path].hex, 'hex'));
  }
};
const readState = async h => JSON.parse(await fs.readFile(h.privateStatePath, 'utf8'));
const assertError = async (work, type, code) => assert.rejects(work, e => { assert(e instanceof type, e.stack); if (code) assert.equal(e.code, code); return true; });
const reader = workspaceId => client.openWorkspace({ workspaceId, ...request, mode: 'read-only' });

async function lifecycle() {
  assert.equal(process.versions.node.split('.')[0], '18');
  const h = await make('binary'); await seed(h);
  assert.equal(h.sandboxPath, h.path); assert.equal(h.baseCommit, h.run.baseRevisionId);
  assert.equal((await fs.stat(path.dirname(h.privateStatePath))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(h.privateStatePath)).mode & 0o777, 0o600);
  assert(!h.privateStatePath.startsWith(h.path + '/'));
  const before = h.run.version;
  const lease = h.run.leaseVersion; await h.heartbeat();
  assert.equal(h.run.version, before); assert.equal(h.run.leaseVersion, lease + 1);
  const published = await h.finalize(stopped); assert.equal(published.result.runState, 'finalized');
  const r = await reader(h.workspaceId);
  assert.equal((await fs.readFile(path.join(r.path, 'binary.bin'))).toString('hex'), fixture.files['binary.bin'].hex);
  assert((await fs.stat(path.join(r.path, 'empty'))).isDirectory()); await r.finalize(stopped);
  const edit = await client.openWorkspace({ workspaceId: h.workspaceId, ...request });
  await fs.unlink(path.join(edit.path, 'notes.txt')); await edit.finalize(stopped);
  const deleted = await reader(h.workspaceId); await assert.rejects(fs.stat(path.join(deleted.path, 'notes.txt')), { code: 'ENOENT' });
  await deleted.finalize(stopped);
  const other = new sdk.ContextVaultClient({ ...config, apiKey: process.env.CV_KEY_B });
  await assertError(() => other.openWorkspace({ workspaceId: h.workspaceId, ...request }), sdk.NotFoundError);
  const abort = await client.openWorkspace({ workspaceId: h.workspaceId, ...request });
  await fs.writeFile(path.join(abort.path, 'unpublished'), 'private');
  await abort.abort({ ...stopped, reason: 'discard' }); await abort.cleanup(stopped);
  await assert.rejects(fs.stat(abort.path), { code: 'ENOENT' });
  const after = await reader(h.workspaceId); await assert.rejects(fs.stat(path.join(after.path, 'unpublished')), { code: 'ENOENT' });
  await after.finalize(stopped);
  const empty = await client.openWorkspace({ workspaceId: h.workspaceId, ...request });
  await fs.unlink(path.join(empty.path, 'binary.bin')); await fs.rmdir(path.join(empty.path, 'empty')); await empty.finalize(stopped);
  const emptyRead = await reader(h.workspaceId); assert.deepEqual(await fs.readdir(emptyRead.path), []); await emptyRead.finalize(stopped);
  await empty.cleanup(stopped); await emptyRead.cleanup(stopped);
  await h.cleanup(stopped); await r.cleanup(stopped); await edit.cleanup(stopped); await deleted.cleanup(stopped); await after.cleanup(stopped);
  // Legacy wrappers materialize beside this process and preserve sequential commits.
  const old = await client.workspaces.checkout(h.workspaceId);
  await assertError(() => client.workspaces.checkout(h.workspaceId), sdk.ConflictError);
  await fs.writeFile(path.join(old.sandboxPath, 'legacy'), 'ok');
  const committed = await client.workspaces.commit(h.workspaceId); assert(committed.commitId);
  await fs.writeFile(path.join(old.sandboxPath, 'legacy'), 'again'); await client.workspaces.commit(h.workspaceId);
  await client.workspaces.destroy(h.workspaceId);
  const oldCreated = await client.workspaces.create({ customerId: process.env.CV_CUSTOMER_A, name: 'legacy-create' });
  assert.equal((await client.workspaces.get(oldCreated.id)).latestCommitId, oldCreated.latestCommitId);
  const oldCheckout = await client.workspaces.checkout(oldCreated.id); assert(oldCheckout.sandboxPath);
  await client.workspaces.destroy(oldCreated.id);
}
async function secure() {
  assert.equal(Buffer.from(sdk.canonicalManifestBytes(fixture.input)).toString(), fixture.canonical);
  assert.equal(sdk.manifestDigest(fixture.input), fixture.sha256);
  assert.deepEqual(sdk.canonicalizeManifest({ schemaVersion: 1, entries: [
    { path: '\u{10000}', kind: 'directory' }, { path: '\ue000', kind: 'directory' },
  ] }).entries.map(e => e.path), ['\ue000', '\u{10000}']);
  for (const p of ['../bad', '/abs', 'a\\b', 'NUL.txt', '.GIT/x', '.ｃｏｎｔｅｘｔｖａｕｌｔ/x', 'e\u0301'])
    assert.throws(() => sdk.canonicalizeManifest({ schemaVersion: 1, entries: [{ path: p, kind: 'directory' }] }));
  for (const entries of [[{ path: 'A', kind: 'directory' }, { path: 'a/x', kind: 'directory' }],
    [{ path: 'a', kind: 'file', sha256: '0'.repeat(64), byteLength: 0 }, { path: 'a/x', kind: 'directory' }]])
    assert.throws(() => sdk.canonicalizeManifest({ schemaVersion: 1, entries }));
  const h = await make('secure'); await seed(h);
  await assertError(() => h.finalize(), sdk.ValidationError);
  await fs.symlink('/etc/passwd', path.join(h.path, 'unsafe'));
  await assertError(() => h.capture(stopped), sdk.ValidationError, 'INVALID_MANIFEST'); await fs.unlink(path.join(h.path, 'unsafe'));
  await fs.link(path.join(h.path, 'notes.txt'), path.join(h.path, 'hard'));
  await assertError(() => h.capture(stopped), sdk.ValidationError); await fs.unlink(path.join(h.path, 'hard'));
  assert.equal(spawnSync('mkfifo', [path.join(h.path, 'fifo')]).status, 0);
  await assertError(() => h.capture(stopped), sdk.ValidationError); await fs.unlink(path.join(h.path, 'fifo'));
  await fs.mkdir(path.join(h.path, 'A')); await fs.mkdir(path.join(h.path, 'a'));
  await assertError(() => h.capture(stopped), sdk.ValidationError); await fs.rmdir(path.join(h.path, 'A')); await fs.rmdir(path.join(h.path, 'a'));
  await fs.mkdir(path.join(h.path, '.GIT')); await fs.writeFile(path.join(h.path, '.GIT/config'), 'excluded');
  const capture = await h.capture(stopped); assert.equal(sdk.manifestDigest(capture.manifest), fixture.sha256);
  assert(!JSON.stringify(await readState(h)).includes(config.apiKey));
  const limited = new sdk.ContextVaultClient({ ...config, limits: { maxFileBytes: 2 } });
  const small = await limited.openWorkspace({ workspaceId: h.workspaceId, ...request }); await fs.writeFile(path.join(small.path, 'large'), 'abc');
  await assertError(() => small.capture(stopped), sdk.ValidationError, 'QUOTA_EXCEEDED'); await small.abort({ reason: 'quota', ...stopped }); await small.cleanup(stopped);
  const sub = await client.submissions.create(h.run.id, {} , 'stable-create');
  assert.equal((await client.submissions.create(h.run.id, {}, 'stable-create')).id, sub.id);
  const bytes = Buffer.alloc(180000, 0xa5); let largest = 0;
  async function* chunks() { for (let i = 0; i < bytes.length; i += 4096) { const chunk = bytes.subarray(i, i + 4096); largest = Math.max(largest, chunk.length); yield chunk; } }
  const entry = { path: 'large.bin', kind: 'file', byteLength: bytes.length, sha256: sha(bytes) };
  const receipt = await client.submissions.upload(h.run.id, sub.id, entry, chunks(), 'stable-file');
  assert.equal(receipt.sha256, entry.sha256); assert(largest <= 4096);
  await client.submissions.seal(h.run.id, sub.id, { manifest: { schemaVersion: 1, entries: [entry] }, receipts: [{ path: entry.path, receiptId: receipt.id }] }, 'stable-seal');
  const op = await client.runs.finalize(h.run.id, { expectedRunVersion: h.run.version, submissionId: sub.id }, 'stable-finalize');
  assert.equal((await client.operations.wait(op.id)).result.runState, 'finalized');
  await assertError(() => client.submissions.upload(h.run.id, sub.id, entry, chunks()), sdk.ValidationError);
  const r = await reader(h.workspaceId); assert.deepEqual(await fs.readFile(path.join(r.path, entry.path)), bytes);
  await r.finalize(stopped); await r.cleanup(stopped);
  const corrupt = new sdk.ContextVaultClient({ ...config, fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).includes('/workspace/files?')) { await response.body.cancel(); return new Response('corrupt bytes', { status: 200, headers: response.headers }); }
    return response;
  }});
  let incompletePath;
  await assert.rejects(corrupt.openWorkspace({ workspaceId: h.workspaceId, ...request, mode: 'read-only' }), error => {
    assert(error instanceof sdk.ValidationError, error.stack); assert.equal(error.code, 'RECEIPT_MISMATCH');
    assert(error.privateStatePath, 'failed materialization must expose its durable recovery record'); incompletePath = error.privateStatePath; return true;
  });
  const incomplete = JSON.parse(await fs.readFile(incompletePath, 'utf8')); assert.equal(incomplete.state, 'failed');
  const repaired = await client.resumeWorkspace(incompletePath); await repaired.reconcile(stopped);
  assert.equal(repaired.run.id, incomplete.run.id); assert.deepEqual(await fs.readFile(path.join(repaired.path, entry.path)), bytes);
  await repaired.finalize(stopped); await repaired.cleanup(stopped);
  // A dishonest digest/length must fail independently of server transport.
  async function* bad() { yield Buffer.from('x'); }
  await assertError(async () => { for await (const _ of sdk.verifyFileStream({ ...entry, byteLength: 1 }, bad())) {} }, sdk.ValidationError, 'RECEIPT_MISMATCH');
  const changing = await make('changing'); const changingFile = path.join(changing.path, 'changing.bin');
  const output = await fs.open(changingFile, 'wx');
  try { for (let n = 0; n < 256; n++) await output.write(Buffer.alloc(65536)); } finally { await output.close(); }
  const writer = spawn(process.execPath, ['-e', `const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'r+');let n=0;setInterval(()=>fs.writeSync(fd,Buffer.from([++n%256]),0,1,0),1);process.stdout.write('ready');`, changingFile], { stdio: ['ignore', 'pipe', 'inherit'] });
  try { await new Promise((resolve, reject) => { writer.stdout.once('data', resolve); writer.once('error', reject); });
    await assertError(() => changing.capture(stopped), sdk.ValidationError, 'CAPTURE_CHANGED');
  } finally { writer.kill('SIGTERM'); await new Promise(resolve => writer.once('exit', resolve)); }
  await changing.abort({ ...stopped, reason: 'mutation test finished' }); await changing.cleanup(stopped);
}
async function checkpoint() {
  let failOpen = false; const openKeys = []; let finalizeCount = 0; let competitor;
  const fetcher = async (url, init) => {
    if (String(url).endsWith('/finalize')) finalizeCount++;
    if (String(url).endsWith('/runs') && failOpen) {
      openKeys.push(init.headers['Idempotency-Key']);
      if (openKeys.length === 1) {
        competitor = await client.openWorkspace({ workspaceId: session.workspaceId, ...request });
        await fs.writeFile(path.join(competitor.path, 'external'), 'accepted after checkpoint'); await competitor.finalize(stopped);
        throw new TypeError('reopen transport unavailable');
      }
    }
    return fetch(url, init);
  };
  const c = new sdk.ContextVaultClient({ ...config, fetch: fetcher });
  const session = await c.openWorkspace({ create: { customerId: process.env.CV_CUSTOMER_A, name: 'checkpoint' }, ...request });
  const local = session.path; await fs.writeFile(path.join(local, 'step'), 'one'); failOpen = true;
  await assert.rejects(session.checkpoint(stopped));
  const state = await readState(session); assert.equal(state.sessionStatus, 'published-needs-reopen');
  assert.equal(state.pendingCommand.kind, 'run:open'); assert.equal(finalizeCount, 1);
  const resumed = await c.resumeWorkspace(session.privateStatePath); await resumed.reconcile(stopped);
  assert.equal(finalizeCount, 1); assert.equal(openKeys[0], openKeys[1]); assert.equal(resumed.path, local);
  assert.equal(await fs.readFile(path.join(local, 'external'), 'utf8'), 'accepted after checkpoint');
  assert.equal(await fs.readFile(path.join(local, 'step'), 'utf8'), 'one');
  await fs.writeFile(path.join(local, 'step'), 'two'); failOpen = false; await resumed.checkpoint(stopped);
  await resumed.abort({ ...stopped, reason: 'done' }); await resumed.cleanup(stopped);
  assert.deepEqual(await fs.readdir(path.join(path.dirname(resumed.privateStatePath), 'captures')), []);
  const publishedFirst = await make('finalize-then-checkpoint');
  await fs.writeFile(path.join(publishedFirst.path, 'done'), 'published'); await publishedFirst.finalize(stopped);
  const oldRun = publishedFirst.run.id; await publishedFirst.checkpoint(stopped);
  assert.notEqual(publishedFirst.run.id, oldRun); assert.equal(publishedFirst.run.state, 'active');
  await publishedFirst.abort({ ...stopped, reason: 'done' }); await publishedFirst.cleanup(stopped);
}
function child(phase, statePath) {
  const result = spawnSync(process.execPath, [__filename, phase, statePath || ''], { encoding: 'utf8', env: process.env });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim().split('\n').pop();
}
async function recovery() {
  const statePath = child('lose-create');
  let state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.workspaceId, null); assert.equal(state.pendingCommand.kind, 'workspace:create');
  const originalCreate = state.pendingCommand;
  const recovered = await client.resumeWorkspace(statePath); await recovered.reconcile(stopped);
  assert(recovered.run.id);
  const replay = await fetch(config.baseUrl + originalCreate.request.path, { method: 'POST', headers: { 'X-API-Key': config.apiKey,
    'Content-Type': 'application/json', 'Idempotency-Key': originalCreate.idempotencyKey }, body: JSON.stringify(originalCreate.request.body) });
  assert.equal(replay.status, 201); assert.equal((await replay.json()).id, recovered.workspaceId);
  const openState = child('lose-open');
  state = JSON.parse(await fs.readFile(openState, 'utf8')); assert.equal(state.run, null); assert.equal(state.pendingCommand.kind, 'run:open');
  const originalOpen = state.pendingCommand;
  const opened = await client.resumeWorkspace(openState); await opened.reconcile(stopped); assert(opened.run.id);
  const replayOpen = await fetch(config.baseUrl + originalOpen.request.path, { method: 'POST', headers: { 'X-API-Key': config.apiKey,
    'Content-Type': 'application/json', 'Idempotency-Key': originalOpen.idempotencyKey }, body: JSON.stringify(originalOpen.request.body) });
  assert.equal(replayOpen.status, 201); assert.equal((await replayOpen.json()).id, opened.run.id);
  const publicationState = child('lose-finalize');
  state = JSON.parse(await fs.readFile(publicationState, 'utf8')); assert.equal(state.pendingCommand.kind, 'finalize');
  const original = JSON.stringify(state.pendingCommand); const captureId = state.capture.captureId;
  await fs.writeFile(path.join(state.path, 'immutable'), 'changed after unknown');
  const denied = new sdk.ContextVaultClient({ ...config, apiKey: process.env.CV_KEY_B });
  const deniedHandle = await denied.resumeWorkspace(publicationState); await assert.rejects(deniedHandle.reconcile(stopped));
  await assertError(() => deniedHandle.cleanup(stopped), sdk.ValidationError);
  const retained = JSON.parse(await fs.readFile(publicationState, 'utf8'));
  assert.equal(retained.pendingCommand.idempotencyKey, state.pendingCommand.idempotencyKey);
  assert.deepEqual(retained.pendingCommand.request, state.pendingCommand.request);
  assert.equal(retained.capture.captureId, captureId); await fs.stat(retained.capture.path);
  const final = await client.resumeWorkspace(publicationState); await final.reconcile(stopped);
  const remote = await reader(final.workspaceId); assert.equal(await fs.readFile(path.join(remote.path, 'immutable'), 'utf8'), 'captured original');
  assert.equal((await client.workspaces.get(final.workspaceId)).id, final.workspaceId);
  await remote.finalize(stopped); await remote.cleanup(stopped);
  await recovered.abort({ ...stopped, reason: 'done' }); await recovered.cleanup(stopped);
  await opened.abort({ ...stopped, reason: 'done' }); await opened.cleanup(stopped); await final.cleanup(stopped);
  const abortState = child('lose-abort'); const aborted = await client.resumeWorkspace(abortState); await aborted.reconcile(stopped);
  assert.equal(aborted.run.state, 'aborted'); await aborted.cleanup(stopped);
  for (const stage of ['upload', 'seal']) {
    const saved = child('lose-' + stage); const pending = JSON.parse(await fs.readFile(saved, 'utf8'));
    assert.equal(pending.pendingCommand.kind, stage === 'upload' ? 'submission:file' : 'submission:seal');
    await fs.writeFile(path.join(pending.path, 'immutable'), 'new mutable bytes');
    const continued = await client.resumeWorkspace(saved); await continued.reconcile(stopped);
    const verified = await reader(continued.workspaceId); assert.equal(await fs.readFile(path.join(verified.path, 'immutable'), 'utf8'), 'captured original');
    await verified.finalize(stopped); await verified.cleanup(stopped); await continued.cleanup(stopped);
  }
  const knownPath = child('lose-known-finalize'); const known = JSON.parse(await fs.readFile(knownPath, 'utf8'));
  assert(known.pendingCommand.operationId, 'known operation identity must reach durable storage');
  let republished = 0;
  const lookupOnly = new sdk.ContextVaultClient({ ...config, fetch: (url, init) => { if (String(url).endsWith('/finalize')) republished++; return fetch(url, init); } });
  const knownSession = await lookupOnly.resumeWorkspace(knownPath); await knownSession.reconcile(stopped);
  assert.equal(republished, 0); await knownSession.cleanup(stopped);
  const heartbeatPath = child('lose-heartbeat'); const heartbeatState = JSON.parse(await fs.readFile(heartbeatPath, 'utf8'));
  const expectedLease = heartbeatState.pendingCommand.request.body.expectedLeaseVersion;
  const heartbeated = await client.resumeWorkspace(heartbeatPath); await heartbeated.reconcile(stopped);
  assert.equal(heartbeated.run.leaseVersion, expectedLease + 1); assert.equal(heartbeated.run.version, heartbeatState.run.version);
  await heartbeated.abort({ ...stopped, reason: 'done' }); await heartbeated.cleanup(stopped);
}
async function lose(kind) {
  const savedPath = '/consumer/recovery-' + kind + '/state.json';
  const lost = new sdk.ContextVaultClient({ ...config, fetch: async (url, init) => {
    if (init.method !== 'GET') {
      const saved = JSON.parse(await fs.readFile(savedPath, 'utf8')); const command = saved.pendingCommand;
      assert(command, 'command must be durable before transport dispatch');
      assert.equal(command.phase, 'dispatched'); assert.equal(command.idempotencyKey, init.headers['Idempotency-Key']);
      assert.equal(command.request.path, new URL(url).pathname + new URL(url).search);
      if (command.request.method === 'POST') assert.equal(JSON.stringify(command.request.body), init.body);
      else { assert.equal((await fs.stat(command.request.capture.privateFilePath)).size, command.request.capture.byteLength); }
      assert(!JSON.stringify(saved).includes(config.apiKey));
    }
    const response = await fetch(url, init);
    if (kind === 'known-finalize' && String(url).endsWith('/finalize')) {
      const operation = await response.json();
      return new Response(JSON.stringify({ error: { code: 'PUBLICATION_OUTCOME_UNKNOWN', message: 'owned response-loss boundary', operationId: operation.id, retryable: true } }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    if ((kind === 'create' && String(url).endsWith('/v1/workspaces')) || (kind === 'open' && String(url).endsWith('/runs')) || (kind === 'finalize' && String(url).endsWith('/finalize')) || (kind === 'abort' && String(url).endsWith('/abort')) ||
      (kind === 'upload' && String(url).includes('/files?')) || (kind === 'seal' && String(url).endsWith('/seal')) || (kind === 'heartbeat' && String(url).endsWith('/heartbeat'))) {
      await response.arrayBuffer(); throw new TypeError('response lost after server acceptance');
    }
    return response;
  }});
  try {
    const options = { create: { customerId: process.env.CV_CUSTOMER_A, name: 'lost-' + kind }, ...request, stateDirectory: '/consumer/recovery-' + kind };
    const h = await lost.openWorkspace(options);
    await fs.writeFile(path.join(h.path, 'immutable'), 'captured original');
    if (kind === 'abort') await h.abort({ ...stopped, reason: 'lost abort response' });
    else if (kind === 'heartbeat') await h.heartbeat();
    else await h.finalize(stopped);
    assert.fail('response loss must surface');
  } catch (e) {
    assert(e instanceof sdk.OutcomeUnknownError, e.stack); assert(e.privateStatePath); console.log(e.privateStatePath);
  }
}
async function terminal() {
  const first = await make('conflict'); const stale = await client.openWorkspace({ workspaceId: first.workspaceId, ...request });
  await fs.writeFile(path.join(first.path, 'a'), 'winner'); await first.finalize(stopped);
  await fs.writeFile(path.join(stale.path, 'b'), 'stale');
  await assertError(() => stale.finalize(stopped), sdk.ConflictError, 'REVISION_CONFLICT');
  const expired = await client.openWorkspace({ workspaceId: first.workspaceId, ...request }); await new Promise(r => setTimeout(r, 5500));
  await assertError(() => expired.finalize(stopped), sdk.RunExpiredError, 'RUN_EXPIRED');
  await fs.symlink('/etc/passwd', path.join(first.path, 'cleanup-link'));
  await assertError(() => first.cleanup(stopped), sdk.ValidationError); assert.equal(first.cleanupState, 'failed');
  assert.equal((await first.status()).state, 'finalized'); await fs.unlink(path.join(first.path, 'cleanup-link'));
  await first.cleanup(stopped); assert.equal(first.cleanupState, 'complete');
}
async function competingWorkflow() {
  let loseOpen = false; const sent = [];
  const c = new sdk.ContextVaultClient({ ...config, fetch: async (url, init) => {
    sent.push({ url: String(url), key: init.headers['Idempotency-Key'], body: init.body });
    const response = await fetch(url, init);
    if (loseOpen && String(url).endsWith('/runs')) { loseOpen = false; await response.arrayBuffer(); throw new TypeError('lost accepted reopen response'); }
    return response;
  }});
  const h = await c.openWorkspace({ create: { customerId: process.env.CV_CUSTOMER_A, name: 'workflow-regression' }, ...request });
  await fs.writeFile(path.join(h.path, 'file'), 'checkpoint'); loseOpen = true;
  await assertError(() => h.checkpoint(stopped), sdk.OutcomeUnknownError);
  const before = await fs.readFile(h.privateStatePath, 'utf8'); const sentBefore = sent.length;
  await assertError(() => h.submit(stopped), sdk.ValidationError, 'INVALID_TRANSITION');
  await assertError(() => h.abort({ ...stopped, reason: 'must reconcile unknown reopen' }), sdk.ValidationError, 'INVALID_TRANSITION');
  assert.equal(await fs.readFile(h.privateStatePath, 'utf8'), before, 'competing submit must preserve the complete durable workflow');
  assert.equal(sent.length, sentBefore, 'competing submit must not dispatch any command');
  const original = JSON.parse(before).pendingCommand;
  await h.reconcile(stopped); assert.equal(h.materializationState, 'ready'); assert.equal(h.run.state, 'active');
  const replay = sent.find((item, index) => index >= sentBefore && item.url.endsWith('/runs'));
  assert.equal(replay.key, original.idempotencyKey); assert.equal(replay.body, JSON.stringify(original.request.body));
  await h.abort({ ...stopped, reason: 'done' }); await h.cleanup(stopped);
}
async function pollDeadline() {
  for (const mode of ['headers', 'body']) {
    const listener = http.createServer((_request, response) => {
      if (mode === 'body') { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"id":'); }
    });
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    let h;
    try {
      const c = new sdk.ContextVaultClient({ ...config, operationTimeoutMs: 80, fetch: (url, init) => {
        if (String(url).includes('/v1/operations/')) return fetch(`http://127.0.0.1:${listener.address().port}/stalled`, init);
        return fetch(url, init);
      }});
      h = await c.openWorkspace({ create: { customerId: process.env.CV_CUSTOMER_A, name: 'deadline-' + mode }, ...request });
      await fs.writeFile(path.join(h.path, 'file'), 'durable pending publication');
      let timedOut = false; const began = Date.now();
      const finalize = h.finalize(stopped).then(() => { throw new Error('stalled operation unexpectedly completed'); }, error => error);
      const result = await Promise.race([finalize, new Promise(resolve => setTimeout(() => { timedOut = true; resolve(null); }, 800))]);
      assert.equal(timedOut, false, `${mode} stalled beyond the overall operation deadline`);
      assert(result instanceof sdk.OutcomeUnknownError, result?.stack); assert(result.operationId); assert(Date.now() - began < 700);
      const saved = await readState(h); assert.equal(saved.pendingCommand.operationId, result.operationId); assert.equal(saved.pendingCommand.phase, 'outcome-unknown');
      const resumed = await client.resumeWorkspace(h.privateStatePath); await resumed.reconcile(stopped);
      assert.equal(resumed.run.state, 'finalized'); await resumed.cleanup(stopped);
    } finally { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
  }
}
async function refreshAbort() {
  let corrupt = false; let finalizes = 0; let aborts = 0;
  const c = new sdk.ContextVaultClient({ ...config, fetch: async (url, init) => {
    if (String(url).endsWith('/finalize')) finalizes++;
    if (String(url).endsWith('/abort')) aborts++;
    const response = await fetch(url, init);
    if (corrupt && String(url).includes('/workspace/files?')) { await response.body.cancel(); return new Response('corrupt', { status: 200, headers: response.headers }); }
    return response;
  }});
  const h = await c.openWorkspace({ create: { customerId: process.env.CV_CUSTOMER_A, name: 'refresh-abort' }, ...request });
  await fs.writeFile(path.join(h.path, 'file'), 'accepted checkpoint'); corrupt = true;
  await assertError(() => h.checkpoint(stopped), sdk.ValidationError, 'RECEIPT_MISMATCH');
  assert.equal(h.run.state, 'active'); assert.equal((await readState(h)).pendingCommand, null);
  const aborted = await h.abort({ ...stopped, reason: 'stop failed refresh' }); assert.equal(aborted.state, 'aborted');
  assert.equal(aborts, 1); assert.equal(finalizes, 1); await h.cleanup(stopped);
}
async function earlyAbort(workflow) {
  let aborts = 0; let publicationCommands = 0;
  const c = new sdk.ContextVaultClient({ ...config, fetch: (url, init) => {
    if (String(url).endsWith('/abort')) aborts++;
    if (String(url).endsWith('/finalize') || String(url).includes('/submissions')) publicationCommands++;
    return fetch(url, init);
  }});
  const h = await c.openWorkspace({ create: { customerId: process.env.CV_CUSTOMER_A, name: 'early-abort-' + workflow }, ...request });
  const foreign = await fs.mkdtemp('/consumer/foreign-'); const sentinel = path.join(foreign, 'sentinel');
  await fs.writeFile(sentinel, 'foreign private bytes');
  await fs.writeFile(path.join(h.path, 'private.txt'), 'unpublished local bytes');
  await fs.symlink(sentinel, path.join(h.path, 'unsafe'));
  await assertError(() => h[workflow](stopped), sdk.ValidationError, 'INVALID_MANIFEST');
  const saved = await readState(h); assert.equal(saved.workflow, workflow); assert.equal(saved.pendingCommand, null);
  assert.equal((await client.runs.get(h.run.id)).state, 'active'); assert.equal(publicationCommands, 0);
  const resumed = await c.resumeWorkspace(h.privateStatePath);
  const aborted = await resumed.abort({ ...stopped, reason: 'abandon local validation failure' });
  assert.equal(aborted.state, 'aborted'); assert.equal(aborts, 1); assert.equal(publicationCommands, 0);
  assert.equal(await fs.readFile(path.join(resumed.path, 'private.txt'), 'utf8'), 'unpublished local bytes');
  assert((await fs.lstat(path.join(resumed.path, 'unsafe'))).isSymbolicLink());
  await assertError(() => resumed.cleanup(stopped), sdk.ValidationError, 'INVALID_MANIFEST');
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'foreign private bytes');
  assert.equal(await fs.readFile(path.join(resumed.path, 'private.txt'), 'utf8'), 'unpublished local bytes');
  await fs.unlink(path.join(resumed.path, 'unsafe')); await resumed.cleanup(stopped);
  await assert.rejects(fs.stat(resumed.path), { code: 'ENOENT' }); assert.equal(await fs.readFile(sentinel, 'utf8'), 'foreign private bytes');
  await fs.rm(foreign, { recursive: true });
}
async function earlyAbortUnknownPublication() {
  const savedPath = child('lose-finalize'); const before = await fs.readFile(savedPath, 'utf8');
  const saved = JSON.parse(before); assert.equal(saved.pendingCommand.kind, 'finalize');
  let aborts = 0;
  const c = new sdk.ContextVaultClient({ ...config, fetch: (url, init) => {
    if (String(url).endsWith('/abort')) aborts++;
    return fetch(url, init);
  }});
  const resumed = await c.resumeWorkspace(savedPath);
  await assertError(() => resumed.abort({ ...stopped, reason: 'unknown publication must reconcile' }), sdk.ValidationError, 'INVALID_TRANSITION');
  assert.equal(aborts, 0); assert.equal(await fs.readFile(savedPath, 'utf8'), before);
  assert.equal(await fs.readFile(path.join(resumed.path, 'immutable'), 'utf8'), 'captured original'); await fs.stat(saved.capture.path);
  await resumed.reconcile(stopped); assert.equal(resumed.run.state, 'finalized'); await resumed.cleanup(stopped);
}
async function crashCapture() {
  const h = await make('capture-crash', { stateDirectory: '/consumer/capture-crash' });
  await fs.writeFile(path.join(h.path, 'private.txt'), 'owned private captured bytes');
  const rename = fs.rename;
  fs.rename = async (source, destination) => {
    if (destination === h.privateStatePath) {
      const saved = JSON.parse(await fs.readFile(source, 'utf8'));
      if (saved.capture) { console.log(JSON.stringify({ state: h.privateStatePath, capture: saved.capture.path })); process.exit(77); }
    }
    return rename(source, destination);
  };
  await h.capture(stopped); assert.fail('capture persistence boundary was not reached');
}
async function orphanCapture() {
  const childResult = spawnSync(process.execPath, [__filename, 'crash-capture'], { encoding: 'utf8', env: process.env, timeout: 20000, killSignal: 'SIGKILL' });
  assert.equal(childResult.status, 77, childResult.stderr);
  const saved = JSON.parse(childResult.stdout.trim().split('\n').pop()); const h = await client.resumeWorkspace(saved.state);
  assert.equal((await readState(h)).capture, null);
  assert.equal(await fs.readFile(path.join(saved.capture, 'private.txt'), 'utf8'), 'owned private captured bytes');
  const foreign = path.join(path.dirname(saved.capture), 'capture-foreign'); const owners = path.join(path.dirname(path.dirname(saved.capture)), 'capture-owners');
  await fs.mkdir(foreign, { mode: 0o700 }); await fs.mkdir(owners, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(foreign, 'sentinel'), 'different owner');
  await fs.writeFile(path.join(owners, 'capture-foreign.json'), JSON.stringify({ sessionId: 'different-session', captureId: 'foreign' }), { mode: 0o600 });
  await h.abort({ ...stopped, reason: 'abandon interrupted capture' });
  await assertError(() => h.cleanup(stopped), sdk.ValidationError, 'INVALID_MANIFEST');
  assert.equal(await fs.readFile(path.join(foreign, 'sentinel'), 'utf8'), 'different owner'); assert.equal(h.cleanupState, 'failed');
  await fs.rm(foreign, { recursive: true }); await fs.unlink(path.join(owners, 'capture-foreign.json'));
  await h.cleanup(stopped);
  assert.equal(h.cleanupState, 'complete'); await assert.rejects(fs.stat(saved.capture), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.dirname(saved.capture)), []);
  await assert.rejects(fs.stat(path.join(path.dirname(path.dirname(saved.capture)), 'capture-manifests')), { code: 'ENOENT' });
}
async function commitReceipt() {
  for (const loseResponse of [false, true]) {
    const initial = await make('wrapper-receipt'); const workspaceId = initial.workspaceId;
    await initial.abort({ ...stopped, reason: 'setup' }); await initial.cleanup(stopped);
    let opens = 0; let ownOperation; let competitorRevision; let competitor; let finalizes = 0;
    const c = new sdk.ContextVaultClient({ ...config, fetch: async (url, init) => {
      const reopening = String(url).endsWith('/runs') && ++opens === 2;
      if (reopening) {
        competitor = await client.openWorkspace({ workspaceId, ...request });
        await fs.writeFile(path.join(competitor.path, 'competitor'), 'accepted between runs');
        competitorRevision = (await competitor.finalize(stopped)).result.revisionId;
      }
      const response = await fetch(url, init);
      if (String(url).endsWith('/finalize')) { finalizes++; ownOperation = (await response.clone().json()).id; }
      if (reopening && loseResponse) { await response.arrayBuffer(); throw new TypeError('lost accepted reopen'); }
      return response;
    }});
    const checkout = await c.workspaces.checkout(workspaceId); await fs.writeFile(path.join(checkout.path, 'own'), 'own accepted checkpoint');
    let committed;
    if (loseResponse) { await assertError(() => c.workspaces.commit(workspaceId), sdk.OutcomeUnknownError); committed = await c.workspaces.commit(workspaceId); }
    else committed = await c.workspaces.commit(workspaceId);
    const own = await client.operations.wait(ownOperation);
    assert.equal(committed.commitId, own.result.revisionId, 'commit receipt must identify its own accepted publication');
    assert.notEqual(committed.commitId, competitorRevision); assert.equal(committed.parentId, checkout.baseCommit); assert.equal(committed.sandboxId, checkout.runId);
    assert.equal(finalizes, 1); assert.equal(await fs.readFile(path.join(checkout.path, 'competitor'), 'utf8'), 'accepted between runs');
    await c.workspaces.destroy(workspaceId); await competitor.cleanup(stopped);
  }
}
// These are control-metadata fixtures. They do not claim that 9994 filesystem objects were materialized.
function nearLimitManifest(kind) {
  const entries = Array.from({ length: 9994 }, (_, index) => {
    const name = String(index).padStart(6, '0') + 'a'.repeat(234);
    const filePath = [name, 'b'.repeat(240), 'c'.repeat(240), 'd'.repeat(251)].join('/');
    assert.equal(Buffer.byteLength(filePath), 974);
    return kind === 'directory' ? { path: filePath, kind } : { path: filePath, kind, byteLength: 0, sha256: sha(Buffer.alloc(0)) };
  });
  return sdk.canonicalizeManifest({ schemaVersion: 1, entries });
}
async function metadataCapture(h, manifest) {
  const parent = path.join(path.dirname(h.privateStatePath), 'captures'); const owners = path.join(path.dirname(h.privateStatePath), 'capture-owners');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 }); await fs.mkdir(owners, { recursive: true, mode: 0o700 });
  const capturedPath = await fs.mkdtemp(path.join(parent, 'capture-')); const captureId = require('node:crypto').randomUUID();
  await fs.writeFile(path.join(owners, path.basename(capturedPath) + '.json'), JSON.stringify({ sessionId: h.sessionId, captureId }), { mode: 0o600 });
  await fs.writeFile(path.join(capturedPath, 'owned-sentinel'), 'private retained capture');
  return { captureId, path: capturedPath, manifest };
}
async function metadataRetention() {
  let h = await make('metadata-retention'); const manifest = nearLimitManifest('directory');
  assert(Buffer.byteLength(JSON.stringify(manifest)) < 16 * 1024 * 1024);
  const captures = []; const digest = sdk.manifestDigest(manifest); const journalBytes = [];
  for (let index = 0; index < 4; index++) {
    // Exercise the installed journal writer and real heartbeat without creating a near-limit physical workspace.
    const captured = await metadataCapture(h, manifest);
    h.data.retainedCaptures = captures.slice(); h.data.capture = captured;
    await h.heartbeat();
    h = await client.resumeWorkspace(h.privateStatePath);
    assert.equal(sdk.manifestDigest(h.data.capture.manifest), digest);
    captures.push(captured);
    journalBytes.push((await fs.stat(h.privateStatePath)).size);
    if (index === 3) assert((await fs.stat(h.privateStatePath)).size < 1024 * 1024, 'retained manifests must not grow the journal');
  }
  const saved = await readState(h); const immutable = saved.capture.manifestRef.path; const original = await fs.readFile(immutable);
  await fs.appendFile(immutable, '\n');
  await assertError(() => client.resumeWorkspace(h.privateStatePath), sdk.ValidationError, 'RECEIPT_MISMATCH');
  await fs.writeFile(immutable, original);
  h = await client.resumeWorkspace(h.privateStatePath);
  await h.abort({ ...stopped, reason: 'metadata fixture complete' }); await h.cleanup(stopped);
  for (const captured of captures) await assert.rejects(fs.stat(captured.path), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(path.dirname(h.privateStatePath), 'capture-manifests')), { code: 'ENOENT' });
  console.log('OBS metadata-retention ' + JSON.stringify({ entries: manifest.entries.length, manifestBytes: Buffer.byteLength(JSON.stringify(manifest)), journalBytes }));
}
async function metadataPending() {
  const h = await make('metadata-pending'); const manifest = nearLimitManifest('file');
  const captured = await metadataCapture(h, manifest); h.data.capture = captured;
  const now = new Date().toISOString(); const submissionId = 'metadata-submission';
  h.data.submission = { id: submissionId, runId: h.run.id, state: 'uploading', version: 9995, expiresAt: now, manifestDigest: null, sealedAt: null, _links: {} };
  h.data.receipts = manifest.entries.map((entry, index) => ({ id: String(index).padStart(26, '0'), runId: h.run.id, submissionId,
    path: entry.path, byteLength: entry.byteLength, sha256: entry.sha256, completedAt: now }));
  h.data.workflow = 'finalize';
  h.data.pendingCommand = { kind: 'submission:seal', idempotencyKey: require('node:crypto').randomUUID(), phase: 'prepared', operationId: null, preparedAt: now,
    request: { method: 'POST', path: `/v1/runs/${h.run.id}/submissions/${submissionId}/seal`, body: {
      manifest, receipts: h.data.receipts.map(receipt => ({ path: receipt.path, receiptId: receipt.id })),
    } } };
  const expected = JSON.stringify(h.data.pendingCommand); const receipts = JSON.stringify(h.data.receipts);
  await h.save(); const bytes = (await fs.stat(h.privateStatePath)).size;
  assert(bytes <= 32 * 1024 * 1024, 'legal capture/receipt/pending metadata must remain within the readable journal budget');
  const resumed = await client.resumeWorkspace(h.privateStatePath);
  assert.equal(JSON.stringify(resumed.data.pendingCommand), expected); assert.equal(JSON.stringify(resumed.data.receipts), receipts);
  console.log('OBS metadata-pending ' + JSON.stringify({ entries: manifest.entries.length, receiptCount: resumed.data.receipts.length,
    manifestBytes: Buffer.byteLength(JSON.stringify(manifest)), pendingRequestBytes: Buffer.byteLength(JSON.stringify(resumed.data.pendingCommand.request)), journalBytes: bytes }));
  await assertError(() => resumed.abort({ ...stopped, reason: 'pending fixture must remain guarded' }), sdk.ValidationError, 'INVALID_TRANSITION');
  // This prepared command is synthetic and was never dispatched; reset only the fixture before ordinary terminal cleanup.
  resumed.data.pendingCommand = null; resumed.data.workflow = 'idle'; await resumed.save();
  await resumed.abort({ ...stopped, reason: 'metadata fixture complete' }); await resumed.cleanup(stopped);
}
async function metadataBudget() {
  const files = require(path.join(path.dirname(require.resolve('@contextvault/sdk')), 'files.js'));
  const parent = await fs.mkdtemp('/consumer/json-budget-'); const journal = path.join(parent, 'state.json');
  const maximum = 32 * 1024 * 1024; const overhead = Buffer.byteLength(JSON.stringify({ value: '' }));
  await files.saveJson(journal, { value: 'x'.repeat(maximum - overhead) });
  assert.equal((await fs.stat(journal)).size, maximum); assert.equal((await files.readJson(journal)).value.length, maximum - overhead);
  const before = sha(await fs.readFile(journal));
  await assertError(() => files.saveJson(journal, { value: 'x'.repeat(maximum - overhead + 1) }), sdk.ValidationError, 'QUOTA_EXCEEDED');
  assert.equal(sha(await fs.readFile(journal)), before, 'overflow must preserve the previous readable journal');
  assert.equal((await files.readJson(journal)).value.length, maximum - overhead); assert.deepEqual(await fs.readdir(parent), ['state.json']);
  console.log('OBS metadata-budget ' + JSON.stringify({ acceptedBytes: maximum, rejectedBytes: maximum + 1, previousJournalPreserved: true }));
  await fs.rm(parent, { recursive: true });
}
async function knownRejection() {
  let uploads = 0; let publications = 0;
  const c = new sdk.ContextVaultClient({ ...config, fetch: (url, init) => {
    if (String(url).includes('/files?')) uploads++;
    if (String(url).endsWith('/finalize')) publications++;
    return fetch(url, init);
  }});
  const h = await c.openWorkspace({ create: { customerId: process.env.CV_CUSTOMER_A, name: 'known-first-rejection' }, ...request });
  await fs.writeFile(path.join(h.path, 'two.txt'), 'ab');
  await assert.rejects(h.finalize(stopped), error => { assert.equal(error.code, 'QUOTA_EXCEEDED'); assert(error.statusCode >= 400 && error.statusCode < 500); return true; });
  const saved = await readState(h); assert.equal(saved.pendingCommand, null, 'a definite first HTTP rejection must settle only its rejected command');
  assert.equal(uploads, 1); assert.equal(publications, 0); assert(saved.capture); await fs.stat(saved.capture.path);
  assert.equal(await fs.readFile(path.join(h.path, 'two.txt'), 'utf8'), 'ab'); assert.equal((await client.runs.get(h.run.id)).state, 'active');
  await h.abort({ ...stopped, reason: 'rejected before publication' });
  assert.equal(await fs.readFile(path.join(h.path, 'two.txt'), 'utf8'), 'ab'); await fs.stat(saved.capture.path);
  await h.cleanup(stopped); await assert.rejects(fs.stat(h.path), { code: 'ENOENT' });
}
async function crashAcceptedUpload() {
  let h;
  const c = new sdk.ContextVaultClient({ ...config, fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).includes('/files?')) { assert.equal(response.status, 201); await response.arrayBuffer(); console.log(h.privateStatePath); process.exit(77); }
    return response;
  }});
  h = await c.openWorkspace({ create: { customerId: process.env.CV_CUSTOMER_A, name: 'dispatched-before-process-exit' }, ...request });
  await fs.writeFile(path.join(h.path, 'two.txt'), 'ab'); await h.finalize(stopped);
}
async function uncertainRejection() {
  for (const mode of ['lost-response', 'dispatched-crash', 'local-receipt-error', 'ambiguous-5xx']) {
    let statePath;
    if (mode === 'dispatched-crash') {
      const childResult = spawnSync(process.execPath, [__filename, 'crash-accepted-upload'], { encoding: 'utf8', env: process.env, timeout: 20000, killSignal: 'SIGKILL' });
      assert.equal(childResult.status, 77, childResult.stderr); statePath = childResult.stdout.trim().split('\n').pop();
    } else {
      const c = new sdk.ContextVaultClient({ ...config, fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (!String(url).includes('/files?')) return response;
        assert.equal(response.status, 201);
        if (mode === 'local-receipt-error') {
          const receipt = await response.json(); return new Response(JSON.stringify({ ...receipt, byteLength: receipt.byteLength + 1 }), { status: 201, headers: { 'Content-Type': 'application/json' } });
        }
        await response.arrayBuffer();
        if (mode === 'ambiguous-5xx') return new Response(JSON.stringify({ error: { code: 'STORAGE_UNAVAILABLE', message: 'owned ambiguous upstream failure' } }), { status: 503, headers: { 'Content-Type': 'application/json' } });
        throw new TypeError('owned lost accepted upload response');
      }});
      const h = await c.openWorkspace({ create: { customerId: process.env.CV_CUSTOMER_A, name: mode }, ...request });
      statePath = h.privateStatePath; await fs.writeFile(path.join(h.path, 'two.txt'), 'ab');
      await assert.rejects(h.finalize(stopped), error => {
        if (mode === 'local-receipt-error') { assert(error instanceof sdk.ValidationError); assert.equal(error.code, 'RECEIPT_MISMATCH'); }
        else if (mode === 'ambiguous-5xx') assert.equal(error.statusCode, 503);
        else assert(error instanceof sdk.OutcomeUnknownError);
        return true;
      });
    }
    const before = JSON.parse(await fs.readFile(statePath, 'utf8')); assert.equal(before.pendingCommand.kind, 'submission:file');
    assert.notEqual(before.pendingCommand.phase, 'prepared'); const original = before.pendingCommand;
    await fs.writeFile(path.join(before.path, 'two.txt'), 'changed after accepted upload');
    let deniedKind = 'quota'; let aborts = 0;
    const denied = new sdk.ContextVaultClient({ ...config, fetch: (url, init) => {
      if (String(url).endsWith('/abort')) aborts++;
      if (String(url).includes('/files?')) return Promise.resolve(new Response(JSON.stringify({ error: {
        code: deniedKind === 'quota' ? 'QUOTA_EXCEEDED' : 'FORBIDDEN', message: 'owned rejection after earlier accepted response', retryable: false,
      } }), { status: deniedKind === 'quota' ? 413 : 403, headers: { 'Content-Type': 'application/json' } }));
      return fetch(url, init);
    }});
    for (deniedKind of ['quota', 'auth']) {
      const resumed = await denied.resumeWorkspace(statePath);
      await assert.rejects(resumed.reconcile(stopped), error => {
        assert.equal(error.code, deniedKind === 'quota' ? 'QUOTA_EXCEEDED' : 'FORBIDDEN');
        if (deniedKind === 'auth') assert(error instanceof sdk.AuthError, 'retry authorization errors retain their public type');
        return true;
      });
      const saved = await readState(resumed); assert.equal(saved.pendingCommand.idempotencyKey, original.idempotencyKey);
      assert.deepEqual(saved.pendingCommand.request, original.request); assert.equal(saved.capture.captureId, before.capture.captureId);
      await assertError(() => resumed.abort({ ...stopped, reason: 'must reconcile accepted command' }), sdk.ValidationError, 'INVALID_TRANSITION');
      await assertError(() => resumed.cleanup(stopped), sdk.ValidationError, 'INVALID_TRANSITION'); await fs.stat(saved.capture.path);
    }
    assert.equal(aborts, 0);
    const recovered = await client.resumeWorkspace(statePath); await recovered.reconcile(stopped);
    const verified = await reader(recovered.workspaceId); assert.equal(await fs.readFile(path.join(verified.path, 'two.txt'), 'utf8'), 'ab');
    await verified.finalize(stopped); await verified.cleanup(stopped); await recovered.cleanup(stopped);
  }
  const knownPath = child('lose-known-finalize'); const known = JSON.parse(await fs.readFile(knownPath, 'utf8'));
  assert(known.pendingCommand.operationId);
  const denied = new sdk.ContextVaultClient({ ...config, fetch: (url, init) => String(url).includes('/operations/')
    ? Promise.resolve(new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'owned lookup denial' } }), { status: 403, headers: { 'Content-Type': 'application/json' } }))
    : fetch(url, init) });
  const pending = await denied.resumeWorkspace(knownPath); await assertError(() => pending.reconcile(stopped), sdk.AuthError, 'FORBIDDEN');
  const retained = await readState(pending); assert.equal(retained.pendingCommand.operationId, known.pendingCommand.operationId);
  assert.equal(retained.pendingCommand.idempotencyKey, known.pendingCommand.idempotencyKey); assert.deepEqual(retained.pendingCommand.request, known.pendingCommand.request);
  await assertError(() => pending.abort({ ...stopped, reason: 'known operation still needs reconciliation' }), sdk.ValidationError, 'INVALID_TRANSITION');
  const completed = await client.resumeWorkspace(knownPath); await completed.reconcile(stopped); await completed.cleanup(stopped);
}
async function cleanedSession() {
  for (const terminal of ['finalized', 'aborted']) {
    let mutations = 0;
    const c = new sdk.ContextVaultClient({ ...config, fetch: (url, init) => { if (init.method !== 'GET') mutations++; return fetch(url, init); } });
    const h = await c.openWorkspace({ create: { customerId: process.env.CV_CUSTOMER_A, name: 'cleaned-' + terminal }, ...request });
    await fs.writeFile(path.join(h.path, 'owned'), 'session files');
    if (terminal === 'finalized') await h.finalize(stopped); else await h.abort({ ...stopped, reason: 'closed session' });
    await h.cleanup(stopped); const before = await fs.readFile(h.privateStatePath, 'utf8'); mutations = 0;
    const resumed = await c.resumeWorkspace(h.privateStatePath);
    for (const action of [() => resumed.checkpoint(stopped), () => resumed.submit(stopped), () => resumed.finalize(stopped),
      () => resumed.heartbeat(), () => resumed.capture(stopped), () => resumed.abort({ ...stopped, reason: 'already cleaned' })]) {
      await assertError(action, sdk.ValidationError, 'INVALID_TRANSITION');
    }
    assert.equal(mutations, 0, 'a cleaned session must not admit any new command');
    assert.equal(await fs.readFile(h.privateStatePath, 'utf8'), before); await resumed.reconcile(stopped);
    const status = await resumed.status(); assert.equal(status.state, terminal); assert.equal(resumed.cleanupState, 'complete');
    await resumed.cleanup(stopped); assert.equal(mutations, 0); await assert.rejects(fs.stat(resumed.path), { code: 'ENOENT' });
    const fresh = await client.openWorkspace({ workspaceId: h.workspaceId, ...request }); assert.notEqual(fresh.run.id, h.run.id);
    await fresh.abort({ ...stopped, reason: 'new session is independent' }); await fresh.cleanup(stopped);
  }
}
async function reopenCleanup(unknown) {
  let opens = 0; let forwardedOpens = 0; let finalizes = 0; let aborts = 0; let retryDenied = false;
  const requests = [];
  const c = new sdk.ContextVaultClient({ ...config, fetch: async (url, init) => {
    if (String(url).endsWith('/finalize')) finalizes++;
    if (String(url).endsWith('/abort')) aborts++;
    if (String(url).endsWith('/runs')) {
      opens++; requests.push({ key: init.headers['Idempotency-Key'], body: init.body });
      if (opens > 1 && (!unknown || retryDenied)) return new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'owned rejected reopen before forwarding' } }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      forwardedOpens++;
    }
    const response = await fetch(url, init);
    if (unknown && String(url).endsWith('/runs') && opens === 2) {
      assert.equal(response.status, 201); await response.arrayBuffer(); throw new TypeError('owned lost accepted reopen response');
    }
    return response;
  }});
  const h = await c.openWorkspace({ create: { customerId: process.env.CV_CUSTOMER_A, name: unknown ? 'unknown-reopen-cleanup' : 'rejected-reopen-cleanup' }, ...request });
  await fs.writeFile(path.join(h.path, 'accepted.txt'), 'checkpoint accepted exactly');
  await assertError(() => h.checkpoint(stopped), unknown ? sdk.OutcomeUnknownError : sdk.AuthError, unknown ? 'PUBLICATION_OUTCOME_UNKNOWN' : 'FORBIDDEN');
  const receipt = h.checkpointReceipt; assert.equal(receipt.operation.result.runState, 'finalized'); assert(receipt.operation.result.revisionId);
  const outcome = h.outcome; assert.equal(outcome.state, 'finalized'); assert.equal(outcome.revisionId, receipt.operation.result.revisionId);
  const saved = await readState(h); assert.equal(h.run.state, 'finalized'); assert.equal(h.sessionStatus, 'published-needs-reopen');
  assert.equal(finalizes, 1); assert.equal(forwardedOpens, unknown ? 2 : 1);
  const verifyAccepted = async () => {
    const read = await reader(h.workspaceId); assert.equal(read.run.baseRevisionId, receipt.operation.result.revisionId);
    assert.equal(await fs.readFile(path.join(read.path, 'accepted.txt'), 'utf8'), 'checkpoint accepted exactly');
    await assert.rejects(fs.stat(path.join(read.path, 'unpublished.txt')), { code: 'ENOENT' });
    await read.finalize(stopped); await read.cleanup(stopped);
    const operation = await client.operations.get(receipt.operation.id); assert.equal(operation.state, 'succeeded');
    assert.equal(operation.result.revisionId, receipt.operation.result.revisionId);
  };
  await verifyAccepted();
  if (unknown) {
    assert.equal(saved.pendingCommand.kind, 'run:open'); const original = saved.pendingCommand;
    retryDenied = true; const resumed = await c.resumeWorkspace(h.privateStatePath);
    await assertError(() => resumed.reconcile(stopped), sdk.AuthError, 'FORBIDDEN');
    const retained = await readState(resumed); assert.equal(retained.pendingCommand.idempotencyKey, original.idempotencyKey);
    assert.deepEqual(retained.pendingCommand.request, original.request);
    await assertError(() => resumed.cleanup(stopped), sdk.ValidationError, 'INVALID_TRANSITION');
    await assertError(() => resumed.abort({ ...stopped, reason: 'unknown reopen must reconcile' }), sdk.ValidationError, 'INVALID_TRANSITION');
    assert.equal(await fs.readFile(path.join(resumed.path, 'accepted.txt'), 'utf8'), 'checkpoint accepted exactly'); await fs.stat(retained.capture.path);
    retryDenied = false; await resumed.reconcile(stopped); assert.equal(resumed.run.state, 'active');
    assert.equal(requests[1].key, requests[2].key); assert.equal(requests[1].key, requests[3].key);
    assert.equal(requests[1].body, requests[3].body);
    await assertError(() => resumed.cleanup(stopped), sdk.ValidationError, 'INVALID_TRANSITION');
    await resumed.abort({ ...stopped, reason: 'known next run can now be stopped' }); await resumed.cleanup(stopped);
    assert.deepEqual(resumed.checkpointReceipt, receipt); assert.equal(aborts, 1);
  } else {
    assert.equal(saved.pendingCommand, null);
    const resumed = await c.resumeWorkspace(h.privateStatePath);
    await assertError(() => resumed.abort({ ...stopped, reason: 'accepted publication cannot be aborted' }), sdk.ValidationError, 'INVALID_TRANSITION');
    await assertError(() => resumed.cleanup(), sdk.ValidationError, 'INVALID_REQUEST');
    await fs.writeFile(path.join(resumed.path, 'unpublished.txt'), 'local writes after rejection');
    await resumed.cleanup(stopped);
    assert.equal(resumed.cleanupState, 'complete'); assert.equal(resumed.sessionStatus, 'finalized');
    assert.deepEqual(resumed.outcome, outcome); assert.deepEqual(resumed.checkpointReceipt, receipt);
    assert.equal((await readState(resumed)).workflow, 'idle'); await assert.rejects(fs.stat(resumed.path), { code: 'ENOENT' });
    const attempts = opens;
    await assertError(() => resumed.checkpoint(stopped), sdk.ValidationError, 'INVALID_TRANSITION');
    await resumed.reconcile(stopped); await resumed.cleanup(stopped); assert.equal(opens, attempts); assert.equal(aborts, 0);
    assert.equal((await resumed.status()).state, 'finalized');
  }
  assert.equal(finalizes, 1); await verifyAccepted();
}
(async () => {
  const scenario = process.argv[2];
  if (scenario === 'ignore-termination') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return; }
  if (scenario === 'crash-capture') return crashCapture();
  if (scenario === 'crash-accepted-upload') return crashAcceptedUpload();
  if (scenario.startsWith('lose-')) return lose(scenario.slice(5));
  await ({ lifecycle, secure, checkpoint, recovery, terminal, 'competing-workflow': competingWorkflow, 'poll-deadline': pollDeadline,
    'refresh-abort': refreshAbort, 'orphan-capture': orphanCapture, 'commit-receipt': commitReceipt,
    'early-abort-finalize': () => earlyAbort('finalize'), 'early-abort-checkpoint': () => earlyAbort('checkpoint'),
    'early-abort-unknown-publication': earlyAbortUnknownPublication, 'metadata-retention': metadataRetention,
    'metadata-pending': metadataPending, 'metadata-budget': metadataBudget, 'boundary-known-rejection': knownRejection,
    'boundary-uncertain-rejection': uncertainRejection, 'boundary-cleaned-session': cleanedSession,
    'reopen-known-cleanup': () => reopenCleanup(false), 'reopen-unknown-cleanup': () => reopenCleanup(true) }[scenario])();
  console.log(`PASS ${scenario} Node18`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
