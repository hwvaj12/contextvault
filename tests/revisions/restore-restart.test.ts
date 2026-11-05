import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { cleanupHttpStorage, storageEnvironment } from '../http/helpers';
import { call, operation, publish, workspace } from './helpers';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { for (let i = 0; i < 1500; i++) { if (check()) return; await pause(10); } throw new Error('Restore process fixture timed out'); }
it('recovers the exact typed restore source after real SIGKILL following durable candidate preparation', async () => {
  const source = resolve(import.meta.dirname, '../..'); const directory = await mkdtemp(join(await realpath(tmpdir()), 'cv-restore-restart-')); const storage = storageEnvironment();
  const clock = new Date();
  const children: { child: ChildProcess; events: any[]; exited: Promise<void>; done: boolean }[] = [];
  const launch = async (mode: string) => {
    const child = fork(join(source, 'tests/revisions/restore-process.cjs'), [], { cwd: directory, execArgv: ['-r', join(source, 'node_modules/ts-node/register/transpile-only')], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH, ...storage, CV_SOURCE_ROOT: source, CV_RESTORE_MODE: mode, CV_RESTORE_CLOCK: new Date(clock.getTime() + (mode === 'recover' ? 60000 : 0)).toISOString(), CV_DATA_DIR: join(directory, 'private'), CONTEXTVAULT_API_KEY: 'restore-process-master', CV_PROCESSING_TTL_MS: '5000', CV_MAINTENANCE_INTERVAL_MS: '50', TS_NODE_PROJECT: join(source, 'tsconfig.json'), V8_COMPILE_CACHE_CACHE_DIR: join(directory, 'compile-cache') } });
    const item = { child, events: [] as any[], exited: Promise.resolve(), done: false }; child.on('message', value => item.events.push(value)); item.exited = new Promise<void>(resolve => child.once('exit', () => { item.done = true; resolve(); })); children.push(item);
    await until(() => item.done || item.events.some(e => e.kind === 'ready')); if (item.done) throw new Error(JSON.stringify(item.events)); return { item, baseUrl: item.events.find(e => e.kind === 'ready').baseUrl };
  };
  const stop = async (item: typeof children[number], kill = false) => { if (item.done) return; if (kill) item.child.kill('SIGKILL'); else item.child.send('stop'); const timer = setTimeout(() => item.child.kill('SIGKILL'), 5000); try { await item.exited; } finally { clearTimeout(timer); } };
  try {
    const first = await launch('crash'); const c: any = { baseUrl: first.baseUrl, customerA: 'restore-a', customerB: 'restore-b' };
    const key = await call(c, '/api-keys', 'POST', { customerId: c.customerA, name: 'restore-client' }, 'restore-process-master'); expect(key.status).toBe(201); c.keyA = key.body.plainKey;
    const w = await workspace(c); const previous = await publish(c, w.id, { 'binary.bin': Buffer.from([255, 0, 128]) }, ['empty']); const head = await publish(c, w.id, { 'removed.txt': Buffer.from('later tree') }); const current = (await call(c, `/v1/workspaces/${w.id}`)).body;
    const body = { revisionId: previous, expectedRevisionId: head, expectedWorkspaceVersion: current.version, reason: 'recover original restore intent' };
    const claimed = await call(c, `/v1/workspaces/${w.id}/restore`, 'POST', body, c.keyA, 'restore-crash-key'); expect(claimed.status).toBe(202);
    await until(() => first.item.events.some(e => e.kind === 'prepared')); const frozen = first.item.events.find(e => e.kind === 'prepared').operation;
    expect(frozen.intent.request.body).toEqual(body); expect(frozen.intent.source.revision.id).toBe(previous); expect(frozen.intent.candidateIdentity.parentRevisionId).toBe(head); expect(frozen.candidate).toBe(null);
    await stop(first.item, true); const restarted = await launch('recover'); c.baseUrl = restarted.baseUrl;
    expect(Date.parse(frozen.claim.expiresAt)).toBeLessThan(Date.parse(restarted.item.events.find(e => e.kind === 'ready').clock));
    const result = await operation(c, claimed.body); expect(result.state).toBe('succeeded'); expect(result.kind).toBe('restore'); expect(result.result.revisionId).not.toBe(previous);
    await until(() => restarted.item.events.some(e => e.kind === 'accepted')); expect(restarted.item.events.find(e => e.kind === 'accepted').fence).toBeGreaterThan(1);
    const manifest = await call(c, `/v1/workspaces/${w.id}/revisions/${result.result.revisionId}/manifest`); expect(manifest.body.entries.map((e: any) => e.path)).toEqual(['binary.bin', 'empty']);
    const binary = await fetch(`${c.baseUrl}/v1/workspaces/${w.id}/revisions/${result.result.revisionId}/files?path=binary.bin`, { headers: { 'X-API-Key': c.keyA } }); expect(Buffer.from(await binary.arrayBuffer())).toEqual(Buffer.from([255, 0, 128]));
    const replay = await call(c, `/v1/workspaces/${w.id}/restore`, 'POST', body, c.keyA, 'restore-crash-key'); expect(replay.body.id).toBe(result.id); expect(replay.body.result).toEqual(result.result);
    expect((await call(c, `/v1/workspaces/${w.id}/revisions`)).body.revisions).toHaveLength(4);
  } finally { for (const child of children) await stop(child); await cleanupHttpStorage(storage); await rm(directory, { recursive: true, force: true }); }
}, 60000);
