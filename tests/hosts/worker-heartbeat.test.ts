import { beforeAll, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
// @ts-ignore normal-server test controller
import { startWorkspaceServer } from '../helpers/workspace-server.mjs';
import { backend, packages, recordEvidence, root } from './harness';

const execute = promisify(execFile);
let artifact: Awaited<ReturnType<typeof packages>>;
beforeAll(async () => { artifact = await packages(); }, 240000);

it('typescript worker preserves its first unknown heartbeat while an agent delays SIGTERM exit', async () => {
  const application = await mkdtemp(join(await realpath(tmpdir()), 'cv-worker-heartbeat-'));
  const server = await startWorkspaceServer({ backend });
  const client = server.client;
  const commands: Array<{ path: string; key: string | null; status: number }> = [];
  const errors: string[] = [];
  let ready: any;
  let result: any;
  let lostResponses = 0;
  const relay = createServer(async (request, response) => {
    try {
      if (!request.url?.startsWith('/v1/')) throw new Error('Expected a relative API route');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !['host', 'connection', 'content-length', 'transfer-encoding', 'expect'].includes(name))) as Record<string, string>;
      const upstream = await fetch(client.baseUrl + request.url, {
        method: request.method, headers,
        ...(['GET', 'HEAD'].includes(request.method!) ? {} : { body: Buffer.concat(chunks) }),
        signal: AbortSignal.timeout(5000),
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (request.method === 'POST') commands.push({ path: request.url, key: request.headers['idempotency-key'] as string ?? null, status: upstream.status });
      if (request.url.endsWith('/heartbeat') && lostResponses++ === 0) { response.destroy(); return; }
      response.writeHead(upstream.status, { 'content-type': 'application/json', 'content-length': bytes.length });
      response.end(bytes);
    } catch (error: any) { errors.push(error.message); response.destroy(); }
  });
  relay.on('connect', (_request, socket) => socket.destroy());
  relay.on('upgrade', (_request, socket) => socket.destroy());
  await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve));
  try {
    await cp(join(root, 'examples/agents/worker.cjs'), join(application, 'worker.cjs'));
    await symlink(join(artifact.directory, 'typescript/node_modules'), join(application, 'node_modules'), 'dir');
    const agent = `const fs=require('node:fs');fs.writeFileSync('agent.bin',Buffer.from([0,255,128]));let stopping=false;process.on('SIGTERM',()=>{if(stopping)return;stopping=true;fs.writeFileSync('term-received',String(Date.now()));setTimeout(()=>{fs.writeFileSync('term-exit',String(Date.now()));process.exit(0)},700)});setInterval(()=>{},1000);`;
    try {
      result = await execute(process.execPath, [join(application, 'worker.cjs')], {
        cwd: application, timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 65536,
        env: { PATH: process.env.PATH, CV_API_URL: 'http://127.0.0.1:' + (relay.address() as any).port, CV_API_KEY: client.keyA, CV_CUSTOMER_ID: client.customerA, CV_STATE_DIR: join(application, 'session'), CV_HEARTBEAT_SECONDS: '0.15', AGENT_COMMAND_JSON: JSON.stringify([process.execPath, '-e', agent]) },
      });
      throw new Error('Worker unexpectedly succeeded');
    } catch (error: any) { expect(error.code, error.message).toBe(1); result = error; }
    expect(result.stdout + result.stderr).not.toContain(client.keyA);
    ready = JSON.parse(result.stdout.trim().split('\n')[0]);
    const retained = JSON.parse(result.stderr.trim().split('\n').pop());
    const journal = await readFile(ready.privateStatePath, 'utf8');
    const state = JSON.parse(journal);
    const heartbeat = commands.filter(command => command.path.endsWith('/heartbeat'));
    const currentResponse = await fetch(client.baseUrl + '/v1/runs/' + ready.runId, { headers: { 'X-API-Key': client.keyA }, signal: AbortSignal.timeout(5000) });
    const current = await currentResponse.json();
    const headResponse = await fetch(client.baseUrl + '/v1/workspaces/' + current.workspaceId, { headers: { 'X-API-Key': client.keyA }, signal: AbortSignal.timeout(5000) });
    const head = await headResponse.json();
    const grace = Number(await readFile(join(ready.path, 'term-exit'), 'utf8')) - Number(await readFile(join(ready.path, 'term-received'), 'utf8'));
    await recordEvidence('worker-heartbeat-regression-' + (retained.error === 'PUBLICATION_OUTCOME_UNKNOWN' ? 'preserved' : 'overwritten'), { backend, runtime: process.versions.node, packageArtifact: artifact.artifacts.typescript, retainedError: retained.error, pendingCommand: state.pendingCommand, commands, errors, lostResponses, graceMs: grace, runState: current.state, leaseVersion: current.leaseVersion, workspaceVersion: head.version });
    expect(errors).toEqual([]);
    expect(lostResponses).toBe(1);
    expect(heartbeat).toEqual([{ path: '/v1/runs/' + ready.runId + '/heartbeat', key: state.pendingCommand.idempotencyKey, status: 200 }]);
    expect(state.pendingCommand).toMatchObject({ kind: 'run:heartbeat', phase: 'outcome-unknown' });
    expect(journal).not.toContain(client.keyA);
    expect(await readFile(join(ready.path, 'agent.bin'))).toEqual(Buffer.from([0, 255, 128]));
    expect(grace).toBeGreaterThanOrEqual(600);
    expect(currentResponse.status).toBe(200);
    expect(current).toMatchObject({ state: 'active', leaseVersion: 2 });
    expect(headResponse.status).toBe(200);
    expect(head.version).toBe(1);
    expect(commands.some(command => /\/(submissions|finalize|abort)(\/|$)/.test(command.path))).toBe(false);
    expect(retained).toMatchObject({ stage: 'retained', privateStatePath: ready.privateStatePath, publication: null, error: 'PUBLICATION_OUTCOME_UNKNOWN' });
  } finally {
    try {
      if (ready) {
        const response = await fetch(client.baseUrl + '/v1/runs/' + ready.runId, { headers: { 'X-API-Key': client.keyA }, signal: AbortSignal.timeout(5000) });
        const current = await response.json();
        if (response.ok && current.state === 'active') {
          const aborted = await fetch(client.baseUrl + '/v1/runs/' + ready.runId + '/abort', { method: 'POST', headers: { 'X-API-Key': client.keyA, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ expectedRunVersion: current.version, reason: 'owned heartbeat regression inspected' }), signal: AbortSignal.timeout(5000) });
          if (!aborted.ok) throw new Error('Cannot settle owned regression run');
          await aborted.body?.cancel();
        }
      }
    } finally {
      relay.closeAllConnections();
      await new Promise<void>(resolve => relay.close(() => resolve()));
      await server.dispose();
      await rm(application, { recursive: true, force: true });
    }
  }
});
