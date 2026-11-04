'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { ContextVaultClient, OutcomeUnknownError } = require(path.join(process.env.CV_ARTIFACTS, 'typescript/node_modules/@contextvault/sdk'));
const parent = process.env.CV_CLIENT_PARENT;
const privatePath = path.join(parent, 'session/state.json');
const handlePath = path.join(parent, 'handle.json');
const first = Buffer.from('00ff6167656e740a', 'hex');
const second = Buffer.from('ff006e657874800a', 'hex');
const client = () => new ContextVaultClient({ apiKey: process.env.CV_API_KEY, baseUrl: process.env.CV_API_URL, maxRetries: 0 });
const agent = (directory, stage) => { const result = spawnSync('/bin/sh', [path.join(__dirname, 'agent.sh'), directory, stage], { env: { PATH: process.env.PATH }, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
const save = value => { const fd = fs.openSync(handlePath, 'w', 0o600); try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
async function version(id) { const response = await fetch(process.env.CV_API_URL + '/v1/workspaces/' + id, { headers: { 'X-API-Key': process.env.CV_API_KEY } }); assert.equal(response.status, 200); return (await response.json()).version; }
async function denied(host, port) { await new Promise((resolve, reject) => { const socket = net.connect({ host, port: Number(port) }); socket.setTimeout(700); socket.once('connect', () => { socket.destroy(); reject(new Error('Canonical storage is directly reachable: ' + host)); }); socket.once('error', resolve); socket.once('timeout', () => { socket.destroy(); resolve(); }); }); }
async function boundary() {
  for (const name of Object.keys(process.env)) assert(!name.startsWith('AWS_') && !['CV_DATA_DIR', 'CV_S3_BUCKET', 'CV_S3_ENDPOINT'].includes(name));
  if (process.env.CV_BOUNDARY === 'worker') return { kind: 'cooperating-host-process' };
  assert(!fs.existsSync(process.env.CV_HOST_ONLY_FILE)); assert(!fs.existsSync('/var/run/docker.sock'));
  const storageProbe = process.env.CV_STORAGE_PROBE_REQUIRED === '1';
  if (storageProbe) { await denied(process.env.CV_STORAGE_PROBE_IP, 4566); await denied(process.env.CV_STORAGE_PROBE_HOST_IP, process.env.CV_STORAGE_PROBE_HOST_PORT); }
  const status = await new Promise((resolve, reject) => { const url = new URL(process.env.CV_API_URL); const request = http.request({ hostname: url.hostname, port: url.port, method: 'GET', path: 'http://' + process.env.CV_STORAGE_PROBE_IP + ':4566/' }, response => { response.resume(); resolve(response.statusCode); }); request.setTimeout(1500, () => request.destroy(new Error('Relay bypass probe timed out'))); request.once('error', reject); request.end(); });
  assert.equal(status, 400); return { kind: 'isolated-container-network', storageIpDenied: storageProbe ? true : null, hostEndpointDenied: storageProbe ? true : null, relayDestinationDenied: true, hostFilesystemDenied: true };
}
async function minimumCli() {
  const executable = path.join(process.env.CV_ARTIFACTS, 'typescript/node_modules/@contextvault/cli/bin/contextvault.cjs');
  const invoke = args => { const result = spawnSync(process.execPath, [executable, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, CV_API_URL: process.env.CV_API_URL, CV_API_KEY: process.env.CV_API_KEY }, timeout: 15000 }); assert.equal(result.status, 0, result.stderr + result.stdout); assert(!result.stdout.includes(process.env.CV_API_KEY)); return JSON.parse(result.stdout); };
  const opened = invoke(['open', '--customer', process.env.CV_CUSTOMER_ID, '--name', 'minimum-cli', '--state-dir', path.join(parent, 'minimum-cli'), '--agent-label', 'node18-cli', '--task', 'minimum CLI lifecycle', '--reason', 'installed executable']);
  const local = opened.workspace; agent(local.path, 'first'); invoke(['submit', '--session', local.privateStatePath, '--writers-stopped']); assert.equal(await version(local.workspaceId), 1);
  const checkpoint = invoke(['checkpoint', '--session', local.privateStatePath, '--writers-stopped']); assert.notEqual(checkpoint.workspace.runId, local.runId); agent(local.path, 'next');
  invoke(['finalize', '--session', local.privateStatePath, '--writers-stopped']); invoke(['cleanup', '--session', local.privateStatePath, '--writers-stopped']);
  const reader = invoke(['open', '--workspace', local.workspaceId, '--mode', 'read-only', '--state-dir', path.join(parent, 'minimum-cli-reader'), '--agent-label', 'node18-cli', '--task', 'minimum CLI readback', '--reason', 'verify publication']).workspace;
  assert(fs.readFileSync(reader.path + '/payload.bin').equals(second)); assert(!fs.existsSync(reader.path + '/delete-me.txt'));
  invoke(['status', '--session', reader.privateStatePath]); invoke(['heartbeat', '--session', reader.privateStatePath]); invoke(['reconcile', '--session', reader.privateStatePath, '--writers-stopped']);
  invoke(['abort', '--session', reader.privateStatePath, '--writers-stopped', '--reason', 'minimum CLI complete']); invoke(['cleanup', '--session', reader.privateStatePath, '--writers-stopped']);
  return { runtime: process.versions.node, os: process.platform + '/' + process.arch, installed: true, separateSubmit: true, checkpoint: true, binaryDeletion: true, finalized: true, aborted: true, cleaned: true };
}
async function main() {
  const action = process.argv[2];
  if (action === 'tamper') { const saved = JSON.parse(fs.readFileSync(handlePath)); agent(saved.path, 'tamper'); console.log(JSON.stringify({ ok: true })); return; }
  const isolation = await boundary(); const cv = client();
  if (action === 'start') {
    const session = await cv.openWorkspace({ create: { customerId: process.env.CV_CUSTOMER_ID, name: 'host-typescript' }, stateDirectory: path.dirname(privatePath), mode: 'read-write', agentLabel: 'independent-shell-agent', task: 'host matrix', reason: 'client-local files' });
    agent(session.path, 'first');
    let unknown; try { await session.checkpoint({ writersStopped: true }); } catch (error) { unknown = error; }
    assert(unknown instanceof OutcomeUnknownError); const state = JSON.parse(fs.readFileSync(session.privateStatePath));
    assert(state.pendingCommand?.idempotencyKey); assert(fs.readFileSync(session.path + '/payload.bin').equals(first));
    assert(!JSON.stringify(state).includes(process.env.CV_API_KEY));
    const saved = { privatePath: session.privateStatePath, path: session.path, workspaceId: session.workspaceId, originalRunId: session.run.id, originalKey: state.pendingCommand.idempotencyKey };
    save(saved);
    process.stdout.write(JSON.stringify({ phase: 'crash', ...saved }) + '\n', () => process.kill(process.pid, 'SIGKILL')); return;
  }
  assert.equal(action, 'resume'); const saved = JSON.parse(fs.readFileSync(handlePath)); const session = await cv.resumeWorkspace(saved.privatePath);
  assert.equal(JSON.parse(fs.readFileSync(saved.privatePath)).pendingCommand.idempotencyKey, saved.originalKey);
  await session.reconcile({ writersStopped: true }); assert.equal(await version(saved.workspaceId), 2); assert.notEqual(session.run.id, saved.originalRunId);
  assert.equal((await cv.runs.get(saved.originalRunId)).state, 'finalized'); assert(fs.readFileSync(session.path + '/payload.bin').equals(first));
  await session.heartbeat(); agent(session.path, 'next'); await session.finalize({ writersStopped: true }); const oldPath = session.path; await session.cleanup({ writersStopped: true }); assert(!fs.existsSync(oldPath));
  const read = await cv.openWorkspace({ workspaceId: saved.workspaceId, mode: 'read-only', agentLabel: 'reader', task: 'readback', reason: 'verify accepted files' });
  assert(fs.readFileSync(read.path + '/payload.bin').equals(second)); assert(fs.statSync(read.path + '/empty').isDirectory()); assert(!fs.existsSync(read.path + '/delete-me.txt'));
  assert.equal(fs.readFileSync(read.path + '/café.txt', 'utf8'), 'unicode file\n'); await read.finalize({ writersStopped: true }); await read.cleanup({ writersStopped: true });
  const abort = await cv.openWorkspace({ workspaceId: saved.workspaceId, mode: 'read-write', agentLabel: 'discard', task: 'abort', reason: 'do not publish' }); agent(abort.path, 'abort'); const discardedPath = abort.path; await abort.abort({ writersStopped: true, reason: 'discard ordinary agent files' }); await abort.cleanup({ writersStopped: true }); assert(!fs.existsSync(discardedPath));
  assert.equal(await version(saved.workspaceId), 3);
  const minimumCliProof = process.env.CV_BOUNDARY === 'container' ? await minimumCli() : null;
  console.log(JSON.stringify({ ok: true, language: 'typescript', runtime: process.versions.node, os: process.platform + '/' + process.arch, package: require(path.join(process.env.CV_ARTIFACTS, 'typescript/node_modules/@contextvault/sdk/package.json')).version, isolation, workspaceId: saved.workspaceId, version: 3, binaryDeletion: true, checkpoint: true, killedControllerRecovery: true, originalKey: saved.originalKey, finalized: true, aborted: true, cleaned: true, minimumCliProof }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
