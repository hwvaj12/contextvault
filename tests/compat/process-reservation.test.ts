import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, realpath, mkdir, writeFile, access, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { storageEnvironment, cleanupHttpStorage } from '../http/helpers';
import { call, workspace } from './helpers';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => Promise<boolean>, timeout = 5000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await condition()) return; await pause(10); } throw new Error('Shared-process fixture condition timed out'); }
async function sharedFixture() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'cv-shared-compat-')); const barrier = join(directory, 'barrier'); await mkdir(barrier);
  const root = resolve(import.meta.dirname, '../..'); const storage = storageEnvironment(); const children: { child: ChildProcess; exit: Promise<void>; info: any; done: boolean }[] = [];
  const launch = async () => {
    const child = fork(join(root, 'tests/compat/shared-server.cjs'), [], { cwd: directory, execArgv: ['-r', join(root, 'node_modules/ts-node/register/transpile-only')], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH, ...storage, CV_DATA_DIR: join(directory, 'private'), CONTEXTVAULT_API_KEY: 'owned-shared-master', CV_SOURCE_ROOT: root, CV_COMPAT_BARRIER: barrier, TS_NODE_PROJECT: join(root, 'tsconfig.json'), V8_COMPILE_CACHE_CACHE_DIR: join(directory, 'compile-cache') } });
    const entry = { child, info: null as any, done: false, exit: Promise.resolve() };
    entry.exit = new Promise<void>(resolve => child.once('exit', () => { entry.done = true; resolve(); })); children.push(entry);
    entry.info = await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Shared server did not start')), 15000); child.once('message', message => { clearTimeout(timeout); resolve(message); }); child.once('exit', () => { clearTimeout(timeout); reject(new Error('Shared server exited before ready')); }); }); return entry;
  };
  const stop = async (entry: typeof children[number], crash = false) => { if (entry.done) return; if (crash) entry.child.kill('SIGKILL'); else entry.child.send('stop'); const timer = setTimeout(() => entry.child.kill('SIGKILL'), 5000); try { await entry.exit; } finally { clearTimeout(timer); } };
  const a = await launch(); const c: any = { baseUrl: a.info.baseUrl, customerA: 'shared-a', customerB: 'shared-b' };
  const key = await call(c, '/api-keys', 'POST', { customerId: c.customerA, name: 'owned shared key' }, 'owned-shared-master'); expect(key.status).toBe(201); c.keyA = key.body.plainKey;
  const w = await workspace(c); await call(c, '/workspaces?customerId=shared-a'); const b = await launch();
  return { a, b, c, w, barrier, launch, stop, async reads() { return (await readdir(barrier)).filter(name => name.endsWith('.read')); }, async release() { await writeFile(join(barrier, 'release'), 'release'); }, async dispose() { await writeFile(join(barrier, 'release'), 'release'); for (const child of children) await stop(child); await cleanupHttpStorage(storage); await rm(directory, { recursive: true, force: true }); } };
}
it('reserves exactly one session and path across two real processes sharing one catalog and data root', async () => {
  const fixture = await sharedFixture();
  try {
    const { c, w } = fixture;
    const first = call(c, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'first-process');
    const second = call({ ...c, baseUrl: fixture.b.info.baseUrl }, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'second-process');
    await until(async () => (await fixture.reads()).length >= 1); await until(async () => (await fixture.reads()).length >= 2, 250).catch(() => {}); await fixture.release();
    const results = await Promise.all([first, second]); expect(results.map(result => result.status).sort()).toEqual([201, 409]);
    const opened = results.find(result => result.status === 201)!; expect((await call(c, `/workspaces/${w.id}/sandbox`)).body.runId).toBe(opened.body.runId);
    expect((await call({ ...c, baseUrl: fixture.b.info.baseUrl }, `/workspaces/${w.id}/sandbox`, 'DELETE', { writersStopped: true }, c.keyA, 'cleanup')).status).toBe(200);
    const runs = await call(c, `/workspaces/${w.id}/runs`); expect(runs.body.runs).toHaveLength(1); expect(runs.body.runs[0].state).toBe('aborted'); await expect(access(opened.body.sandboxPath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await fixture.dispose(); }
});
it('releases reservation on real process death, keeps the waiting event loop responsive, and resumes after restart', async () => {
  const fixture = await sharedFixture();
  try {
    const { c, w } = fixture; const first = call(c, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'crashed-open').catch(() => null);
    await until(async () => (await fixture.reads()).includes(`${fixture.a.info.pid}.read`));
    const secondClient = { ...c, baseUrl: fixture.b.info.baseUrl }; const second = call(secondClient, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'surviving-open').catch(() => ({ status: 0, body: {} }));
    await pause(100); expect((await fixture.reads()).includes(`${fixture.b.info.pid}.read`)).toBe(false);
    expect((await fetch(`${fixture.b.info.baseUrl}/health`, { signal: AbortSignal.timeout(1000) })).status).toBe(200);
    await fixture.stop(fixture.a, true); expect(await first).toBe(null); await until(async () => (await fixture.reads()).includes(`${fixture.b.info.pid}.read`)); await fixture.release();
    const opened = await second; expect(opened.status).toBe(201); await fixture.stop(fixture.b); const restarted = await fixture.launch(); const restartedClient = { ...c, baseUrl: restarted.info.baseUrl };
    const replay = await call(restartedClient, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'surviving-open'); expect(replay.status).toBe(201); expect(replay.body.runId).toBe(opened.body.runId); expect(replay.body.sandboxPath).toBe(opened.body.sandboxPath);
    expect((await call(restartedClient, `/workspaces/${w.id}/sandbox`, 'DELETE', { writersStopped: true }, c.keyA, 'cleanup')).status).toBe(200);
    expect((await call(restartedClient, `/workspaces/${w.id}/runs`)).body.runs).toHaveLength(1);
  } finally { await fixture.dispose(); }
});
