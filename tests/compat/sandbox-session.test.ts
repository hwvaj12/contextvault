import { writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { it, expect } from 'vitest';
import { fixture, workspace, push, call } from './helpers';
it('keeps a colocated directory over sequential checkpoint runs, including binary bytes', async () => {
  const server = await fixture();
  try {
    const c = server.client; const w = await workspace(c); await push(c, w.id, [{ path: 'nested/old.txt', content: 'old' }]);
    const opened = await call(c, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'checkout'); expect(opened.status).toBe(201); expect(opened.body.pathSemantics).toBe('server-colocated-only');
    expect((await call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'no-change')).status).toBe(400);
    const directory = opened.body.sandboxPath; expect(await readFile(path.join(directory, 'nested/old.txt'), 'utf8')).toBe('old');
    await unlink(path.join(directory, 'nested/old.txt')); await writeFile(path.join(directory, 'binary.bin'), Buffer.from([0, 255, 1]));
    const a = await call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'checkpoint-a'); expect(a.status).toBe(201); expect(a.body.state).toBe('active'); expect(a.body.outcome.state).toBe('finalized'); expect(a.body.filesChanged.sort()).toEqual(['binary.bin', 'nested/old.txt']);
    expect((await call(c, `/workspaces/${w.id}/pull`)).body.files).toEqual([{ path: 'binary.bin', content: 'AP8B', encoding: 'base64' }]);
    await server.restart();
    const retry = await call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'checkpoint-a'); expect(retry.body.commitId).toBe(a.body.commitId);
    await writeFile(path.join(directory, 'next.txt'), 'next');
    const b = await call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'checkpoint-b'); expect(b.status).toBe(201); expect(b.body.runId).not.toBe(a.body.runId); expect(b.body.sandboxPath).toBe(directory);
    expect((await call(c, `/workspaces/${w.id}/sandbox`, 'DELETE', { writersStopped: true }, c.keyA, 'cleanup')).status).toBe(200);
  } finally { await server.dispose(); }
});

it('keeps a definitive conflict separate from cleanup and preserves accepted concurrent contents', async () => {
  const server = await fixture();
  try {
    const c = server.client; const w = await workspace(c); const opened = await call(c, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'open-conflict');
    await writeFile(path.join(opened.body.sandboxPath, 'local.txt'), 'local');
    await push(c, w.id, [{ path: 'external.txt', content: 'accepted externally' }]);
    const checkpoint = await call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'conflicting-checkpoint'); expect(checkpoint.status).toBe(409);
    const status = await call(c, `/workspaces/${w.id}/sandbox`); expect(status.body.state).toBe('failed'); expect(status.body.outcome.state).toBe('conflicted');
    expect((await call(c, `/workspaces/${w.id}/sandbox`, 'DELETE', { writersStopped: true }, c.keyA, 'clean-conflict')).status).toBe(200);
    expect((await call(c, `/workspaces/${w.id}/pull`)).body.files).toEqual([{ path: 'external.txt', content: 'accepted externally' }]);
  } finally { await server.dispose(); }
});

it('rejects competing sandbox sessions and requires stopped writers before capture or cleanup', async () => {
  const server = await fixture();
  try {
    const c = server.client; const w = await workspace(c);
    const requests = await Promise.all([call(c, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'first'), call(c, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'competing')]);
    expect(requests.map(request => request.status).sort()).toEqual([201, 409]);
    const opened = requests.find(request => request.status === 201)!;
    expect((await call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', {}, c.keyA, 'unsafe-capture')).status).toBe(400);
    expect((await call(c, `/workspaces/${w.id}/sandbox`, 'DELETE', {}, c.keyA, 'unsafe-cleanup')).status).toBe(400);
    expect((await call(c, `/workspaces/${w.id}/sandbox`, 'GET', undefined, c.keyB)).status).toBeGreaterThanOrEqual(400);
    expect((await call(c, `/workspaces/${w.id}/sandbox`)).body.sandboxPath).toBe(opened.body.sandboxPath);
  } finally { await server.dispose(); }
});
