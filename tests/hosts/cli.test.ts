import { afterAll, beforeAll, it, expect } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, realpath, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { backend, fixture, cliPath, recordEvidence, run, type HostFixture } from './harness';
let server: HostFixture;
let directory: string;
beforeAll(async () => { server = await fixture(); directory = await mkdtemp(join(await realpath(tmpdir()), 'cv-host-cli-')); }, 240000);
afterAll(async () => { await server?.dispose(); if (directory) await rm(directory, { recursive: true, force: true }); }, 60000);
const cliEnvironment = () => ({ PATH: process.env.PATH, CV_API_URL: server.origin, CV_API_KEY: server.client.keyA });
async function cli(args: string[], expectedCode = 0, environment: any = cliEnvironment()) {
  let result: any;
  try { result = await promisify(execFile)(cliPath(server.artifact), args, { env: environment, timeout: 20000 }); expect(expectedCode).toBe(0); }
  catch (error: any) { if (!error.stdout) throw error; expect(error.code, error.stderr).toBe(expectedCode); result = error; }
  expect(result.stdout).not.toContain(server.client.keyA);
  return JSON.parse(result.stdout);
}
function openArgs(name: string, workspace?: string, mode = 'read-write') { return ['open', ...(workspace ? ['--workspace', workspace] : ['--customer', server.client.customerA, '--name', name]), '--state-dir', join(directory, name), '--mode', mode, '--agent-label', 'independent-agent', '--task', 'CLI host acceptance', '--reason', 'ordinary client-local access']; }
async function head(workspace: string) { const response = await fetch(server.client.baseUrl + '/v1/workspaces/' + workspace, { headers: { 'X-API-Key': server.client.keyA } }); expect(response.status).toBe(200); return response.json(); }
async function agent(path: string, stage: string) { await run('/bin/sh', [join(import.meta.dirname, 'consumers/agent.sh'), path, stage], { env: { PATH: process.env.PATH } }); }

it('installed CLI separates submit from publication, reads exact binary, finalizes and explicitly cleans up', async () => {
  const opened = await cli(openArgs('ordinary')); const workspace = opened.workspace;
  expect(opened.ok).toBe(true); expect(workspace.path).toBe(join(directory, 'ordinary/workspace')); expect(workspace.runId).toBeTruthy();
  await agent(workspace.path, 'first');
  const submitted = await cli(['submit', '--session', workspace.privateStatePath, '--writers-stopped']);
  expect(submitted.result.state).toBe('sealed'); expect((await head(workspace.workspaceId)).version).toBe(1);
  await agent(workspace.path, 'tamper');
  const finalized = await cli(['finalize', '--session', workspace.privateStatePath, '--writers-stopped']);
  expect(finalized.result.result.runState).toBe('finalized'); expect((await head(workspace.workspaceId)).version).toBe(2);
  await cli(['cleanup', '--session', workspace.privateStatePath, '--writers-stopped']); await expect(access(workspace.path)).rejects.toBeDefined();
  const reader = (await cli(openArgs('reader', workspace.workspaceId, 'read-only'))).workspace;
  expect((await readFile(join(reader.path, 'payload.bin'))).toString('hex')).toBe('00ff6167656e740a');
  const status = await cli(['status', '--session', reader.privateStatePath]); expect(status.result.state).toBe('active');
  const heartbeat = await cli(['heartbeat', '--session', reader.privateStatePath]); expect(heartbeat.result.leaseVersion).toBeGreaterThan(1);
  await cli(['finalize', '--session', reader.privateStatePath, '--writers-stopped']); await cli(['cleanup', '--session', reader.privateStatePath, '--writers-stopped']);
  const checkpoint = (await cli(openArgs('checkpoint', workspace.workspaceId))).workspace;
  await agent(checkpoint.path, 'next');
  const checked = await cli(['checkpoint', '--session', checkpoint.privateStatePath, '--writers-stopped']);
  expect(checked.workspace.path).toBe(checkpoint.path); expect(checked.workspace.runId).not.toBe(checkpoint.runId); expect(checked.workspace.checkpointReceipt.operation.result.changed).toBe(true);
  await agent(checkpoint.path, 'abort'); await cli(['abort', '--session', checkpoint.privateStatePath, '--writers-stopped', '--reason', 'discard remaining files']);
  await cli(['cleanup', '--session', checkpoint.privateStatePath, '--writers-stopped']); expect((await head(workspace.workspaceId)).version).toBe(3);
  await recordEvidence('cli', { backend, runtime: process.versions.node, os: process.platform + '/' + process.arch, image: null, packageArtifact: server.artifact.artifacts.cli, sdkArtifact: server.artifact.artifacts.typescript, artifactSet: server.artifact.key, installed: true, separateSubmit: true, binaryDeletion: true, checkpoint: true, finalized: true, aborted: true, cleaned: true });
});

it('CLI returns stable invocation, denial and conflict exit codes without leaking credentials', async () => {
  expect((await cli(['unknown'], 2)).error.code).toBe('INVALID_INVOCATION');
  expect((await cli(['status', '--session', directory], 2, { PATH: process.env.PATH })).error.code).toBe('INVALID_INVOCATION');
  const denied = await cli(openArgs('denied'), 3, { ...cliEnvironment(), CV_API_KEY: 'invalid-owned-test-key' }); expect(denied.error.code).toBeTruthy();
  const initial = (await cli(openArgs('conflict-first'))).workspace;
  const stale = (await cli(openArgs('conflict-stale', initial.workspaceId))).workspace;
  await agent(initial.path, 'first'); await cli(['finalize', '--session', initial.privateStatePath, '--writers-stopped']);
  const conflict = await cli(['finalize', '--session', stale.privateStatePath, '--writers-stopped'], 4); expect(conflict.error.code).toBe('REVISION_CONFLICT');
  for (const value of [initial, stale]) await cli(['cleanup', '--session', value.privateStatePath, '--writers-stopped']);
});

it('CLI reports uncertainty and retains its original command and captured source until reconciliation', async () => {
  const value = (await cli(openArgs('unknown'))).workspace; await agent(value.path, 'first'); await server.arm(true);
  const unknown = await cli(['finalize', '--session', value.privateStatePath, '--writers-stopped'], 5); expect(unknown.error.code).toBe('PUBLICATION_OUTCOME_UNKNOWN');
  const pending = JSON.parse(await readFile(value.privateStatePath, 'utf8')).pendingCommand; expect(pending.idempotencyKey).toBeTruthy(); await access(value.path);
  const reconciled = await cli(['reconcile', '--session', value.privateStatePath, '--writers-stopped']); expect(reconciled.workspace.outcome.state).toBe('finalized');
  expect((await head(value.workspaceId)).version).toBe(2); await cli(['cleanup', '--session', value.privateStatePath, '--writers-stopped']);
});

it('CLI refuses a concurrent controller and recovers a real killed opening before stdout with the original key', async () => {
  const stateDirectory = join(directory, 'killed-opening'); await server.arm(false, '/workspaces');
  const child = spawn(cliPath(server.artifact), openArgs('killed-opening'), { env: cliEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const closed = new Promise<any>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    let held = false;
    for (let attempt = 0; attempt < 200; attempt++) { if ((await server.evidence()).held) { held = true; break; } await new Promise(resolve => setTimeout(resolve, 10)); }
    expect(held, stderr).toBe(true);
    const before = JSON.parse(await readFile(join(stateDirectory, 'state.json'), 'utf8'));
    expect(before.pendingCommand.kind).toBe('workspace:create'); const key = before.pendingCommand.idempotencyKey;
    const concurrent = await cli(['status', '--session', stateDirectory], 4); expect(concurrent.error.code).toBe('LOCAL_CONTROLLER_BUSY');
    child.kill('SIGKILL'); expect((await closed).signal).toBe('SIGKILL'); expect(stdout).toBe('');
    expect((await cli(['status', '--session', stateDirectory], 4)).error.code).toBe('LOCAL_CONTROLLER_BUSY');
    const resumed = await cli(['reconcile', '--session', stateDirectory, '--writers-stopped', '--controllers-stopped']);
    expect(resumed.workspace.runId).toBeTruthy(); expect(resumed.workspace.path).toBe(join(stateDirectory, 'workspace'));
    const evidence = await server.evidence(); const creates = evidence.commandKeys.filter((entry: any) => entry.path === '/v1/workspaces');
    expect(creates.map((entry: any) => entry.key)).toEqual([key, key]);
    await cli(['abort', '--session', stateDirectory, '--writers-stopped', '--reason', 'owned interrupted opening verified']);
    await cli(['cleanup', '--session', stateDirectory, '--writers-stopped']);
  } finally { child.kill('SIGKILL'); await closed; await server.arm(false); }
});

it('explicit stopped-controller recovery retires a partial owned marker without changing the SDK journal', async () => {
  const opened = (await cli(openArgs('partial-marker'))).workspace; const stateDirectory = join(directory, 'partial-marker');
  const marker = join(directory, '.contextvault-controller-' + createHash('sha256').update(stateDirectory).digest('hex') + '.json');
  const original = await readFile(opened.privateStatePath); await writeFile(marker, '', { flag: 'wx', mode: 0o600 });
  expect((await cli(['status', '--session', stateDirectory], 4)).error.code).toBe('LOCAL_CONTROLLER_BUSY');
  const recovered = await cli(['status', '--session', stateDirectory, '--controllers-stopped']); expect(recovered.result.state).toBe('active');
  const after = JSON.parse(await readFile(opened.privateStatePath, 'utf8')); const before = JSON.parse(original.toString());
  expect(after.pendingCommand).toEqual(before.pendingCommand); expect(after.run.id).toBe(before.run.id);
  await cli(['abort', '--session', stateDirectory, '--writers-stopped', '--reason', 'partial marker recovered']);
  await cli(['cleanup', '--session', stateDirectory, '--writers-stopped']);
});
