import { fork, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { storageEnvironment, cleanupHttpStorage } from '../http/helpers';
import { faultFixture } from './fault-fixture';
import { call, workspace, push } from './helpers';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const captures = (directory: string): Promise<string[]> => readdir(join(directory, 'legacy-compat/captures')).catch(() => []);
async function captureOwnership(directory: string, captureId: string) {
  const root = join(directory, 'legacy-compat/capture-owners');
  for (const group of await readdir(root)) for (const name of await readdir(join(root, group))) {
    const record = JSON.parse(await readFile(join(root, group, name), 'utf8')); if (record.captureId === captureId) return record;
  }
  throw new Error('Capture ownership record is missing');
}
async function until(condition: () => boolean, timeout = 15000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (condition()) return; await pause(10); } throw new Error('Capture process fixture timed out'); }
async function processFixture() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'cv-capture-lifecycle-')); const data = join(directory, 'private'); const storage = storageEnvironment(); const source = resolve(import.meta.dirname, '../..');
  const children: { child: ChildProcess; events: any[]; exited: Promise<void>; done: boolean }[] = [];
  const launch = async () => {
    const child = fork(join(source, 'tests/compat/capture-process.cjs'), [], { cwd: directory, execArgv: ['-r', join(source, 'node_modules/ts-node/register/transpile-only')], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH, ...storage, CV_DATA_DIR: data, CV_SOURCE_ROOT: source, CONTEXTVAULT_API_KEY: 'capture-owned-master', TS_NODE_PROJECT: join(source, 'tsconfig.json'), V8_COMPILE_CACHE_CACHE_DIR: join(directory, 'compile-cache') } });
    const entry = { child, events: [] as any[], done: false, exited: Promise.resolve() }; child.on('message', event => entry.events.push(event)); entry.exited = new Promise<void>(resolve => child.once('exit', () => { entry.done = true; resolve(); })); children.push(entry);
    await until(() => entry.events.some(event => event.kind === 'ready') || entry.done); if (entry.done) throw new Error('Capture process failed to start'); return { ...entry, entry, baseUrl: entry.events.find(event => event.kind === 'ready').baseUrl };
  };
  const stop = async (entry: typeof children[number], crash = false) => { if (entry.done) return; if (crash) entry.child.kill('SIGKILL'); else entry.child.send('stop'); const timeout = setTimeout(() => entry.child.kill('SIGKILL'), 5000); try { await entry.exited; } finally { clearTimeout(timeout); } };
  let active = await launch(); const c: any = { baseUrl: active.baseUrl, customerA: 'capture-a', customerB: 'capture-b' }; const key = await call(c, '/api-keys', 'POST', { customerId: c.customerA, name: 'capture-owned-key' }, 'capture-owned-master'); expect(key.status).toBe(201); c.keyA = key.body.plainKey;
  return { c, data, async arm(mode: string) { active.child.send({ arm: mode }); await until(() => active.events.some(event => event.kind === 'armed' && event.mode === mode)); }, async fault() { await until(() => active.events.some(event => event.kind === 'fault')); return active.events.find(event => event.kind === 'fault'); }, async restart() { await stop(active.entry, true); active = await launch(); c.baseUrl = active.baseUrl; }, async dispose() { for (const child of children) await stop(child); await cleanupHttpStorage(storage); await rm(directory, { recursive: true, force: true }); } };
}
it('does not allocate private payloads for repeated no-change checkpoints and preserves the separate seed push source on cleanup', async () => {
  const server = await faultFixture();
  try {
    const c = server.client; const w = await workspace(c); expect((await push(c, w.id, [{ path: 'private.txt', content: 'seed accepted' }])).status).toBe(201);
    const opened = await call(c, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'open'); const before = await captures(server.configuration.dataDirectory);
    for (const key of ['no-change-1', 'no-change-2']) expect((await call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, key)).status).toBe(400);
    expect(await captures(server.configuration.dataDirectory)).toEqual(before);
    expect((await call(c, `/workspaces/${w.id}/sandbox`, 'DELETE', { writersStopped: true }, c.keyA, 'cleanup')).status).toBe(200); expect(await captures(server.configuration.dataDirectory)).toEqual(before);
    expect((await call(c, `/v1/runs/${opened.body.runId}`)).body.state).toBe('aborted'); expect((await call(c, `/workspaces/${w.id}/pull`)).body.files).toEqual([{ path: 'private.txt', content: 'seed accepted' }]);
  } finally { await server.dispose(); }
});
it('owns payload before a fresh copy failure, disposes that unused copy, and retries without cleanup growth', async () => {
  const server = await processFixture();
  try {
    const c = server.c; const w = await workspace(c); await push(c, w.id, [{ path: 'private.txt', content: 'seed' }]); const opened = await call(c, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'open'); const before = await captures(server.data);
    await writeFile(join(opened.body.sandboxPath, 'private.txt'), 'retry selected'); await server.arm('failure'); const request = call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'copy-key'); const fault = await server.fault(); expect((await request).status).toBe(503); expect(fault.durableOwner).toBe(true); expect(await captures(server.data)).toEqual(before);
    const retry = await call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'copy-key'); expect(retry.status).toBe(201);
    expect((await call(c, `/workspaces/${w.id}/sandbox`, 'DELETE', { writersStopped: true }, c.keyA, 'cleanup')).status).toBe(200); expect(await captures(server.data)).toEqual(before); expect((await call(c, `/workspaces/${w.id}/pull`)).body.files).toEqual([{ path: 'private.txt', content: 'retry selected' }]);
  } finally { await server.dispose(); }
});
for (const mode of ['sealed', 'partial']) it(`retains ${mode} capture ownership through real process interruption and safely reconciles or abandons it`, async () => {
  const server = await processFixture();
  try {
    const c = server.c; const w = await workspace(c); await push(c, w.id, [{ path: 'private.txt', content: 'seed accepted' }]); const opened = await call(c, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'open'); const before = await captures(server.data); const selected = 'original-selected-'.repeat(8192);
    await writeFile(join(opened.body.sandboxPath, 'private.txt'), selected); await server.arm(mode); const pending = call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'interrupted-key').catch(() => null); const fault = await server.fault();
    await writeFile(join(opened.body.sandboxPath, 'private.txt'), 'changed after interruption'); await server.restart(); expect(await pending).toBe(null); expect(fault.durableOwner).toBe(true);
    const retry = await call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'interrupted-key'); expect(retry.status).toBe(mode === 'sealed' ? 201 : 503); expect((await captures(server.data)).length).toBe(before.length + 1);
    expect((await call(c, `/workspaces/${w.id}/sandbox`, 'DELETE', { writersStopped: true, abandon: true }, c.keyA, 'abandon')).status).toBe(200); expect(await captures(server.data)).toEqual(before); await expect(access(join(server.data, 'legacy-compat/captures', fault.captureId))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await call(c, `/workspaces/${w.id}/pull`)).body.files).toEqual([{ path: 'private.txt', content: mode === 'sealed' ? selected : 'seed accepted' }]);
  } finally { await server.dispose(); }
});
it('keeps interrupted explicit disposal terminal and finishes cleanup after another process death', async () => {
  const server = await processFixture();
  try {
    const c = server.c; const w = await workspace(c); await push(c, w.id, [{ path: 'private.txt', content: 'seed accepted' }]); const opened = await call(c, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'open'); const before = await captures(server.data);
    await writeFile(join(opened.body.sandboxPath, 'private.txt'), 'abandoned selected'); await server.arm('sealed'); const capture = call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'abandoned-key').catch(() => null); await server.fault(); await server.restart(); expect(await capture).toBe(null);
    await server.arm('cleanup'); const cleanup = call(c, `/workspaces/${w.id}/sandbox`, 'DELETE', { writersStopped: true, abandon: true }, c.keyA, 'cleanup').catch(() => null); const fault = await server.fault(); await server.restart(); expect(await cleanup).toBe(null); expect(fault.durableOwner).toBe(true);
    const retry = await call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'abandoned-key'); expect(retry.status).toBe(409); expect(retry.body.error.code).toBe('INVALID_TRANSITION');
    expect((await captureOwnership(server.data, fault.captureId)).state).toBe('discarding');
    expect((await call(c, `/workspaces/${w.id}/sandbox`, 'DELETE', { writersStopped: true, abandon: true }, c.keyA, 'cleanup')).status).toBe(200); expect(await captures(server.data)).toEqual(before); expect((await call(c, `/workspaces/${w.id}/pull`)).body.files).toEqual([{ path: 'private.txt', content: 'seed accepted' }]);
  } finally { await server.dispose(); }
});
it('retains the selected capture while publication is unknown, then disposes it only after reconciliation and explicit cleanup', async () => {
  let reached!: () => void; let release!: () => void; const ready = new Promise<void>(resolve => { reached = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
  const server = await faultFixture({ lifecycle: { hook: async (stage, operation) => { if (stage === 'before-accept' && operation.kind === 'finalize') { reached(); await held; } } } }, 1000);
  try {
    const c = server.client; const w = await workspace(c); const opened = await call(c, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'open'); const before = await captures(server.configuration.dataDirectory);
    await writeFile(join(opened.body.sandboxPath, 'private.txt'), 'unknown selected'); const pending = call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'unknown'); await ready; const unknown = await pending; expect(unknown.status).toBe(503);
    const owned = (await captures(server.configuration.dataDirectory)).filter(id => !before.includes(id)); expect(owned).toHaveLength(1);
    expect((await call(c, `/workspaces/${w.id}/sandbox`, 'DELETE', { writersStopped: true, abandon: true }, c.keyA, 'unsafe-cleanup')).status).toBe(503); expect(await readFile(join(server.configuration.dataDirectory, 'legacy-compat/captures', owned[0], 'files/private.txt'), 'utf8')).toBe('unknown selected');
    release(); const replay = await call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'unknown'); expect(replay.status).toBe(201); expect(replay.body.operation.id).toBe(unknown.body.error.operationId);
    expect((await call(c, `/workspaces/${w.id}/sandbox`, 'DELETE', { writersStopped: true }, c.keyA, 'cleanup')).status).toBe(200); expect(await captures(server.configuration.dataDirectory)).toEqual(before); expect((await call(c, `/workspaces/${w.id}/pull`)).body.files).toEqual([{ path: 'private.txt', content: 'unknown selected' }]);
  } finally { release(); await server.dispose(); }
});
