import { expect, it } from 'vitest';
import { call, faultFixture, publish, workspace } from './helpers';

it('reads accepted opaque revisions, exact binary files, diff and search through normal HTTP and legacy metadata', async () => {
  const server = await faultFixture();
  try {
    const c = server.client; const w = await workspace(c);
    const first = await publish(c, w.id, { 'binary.bin': Buffer.from([0, 255, 13]), 'readme.txt': Buffer.from('first\nneedle\n'), 'remove.txt': Buffer.from('remove') }, ['empty']);
    const second = await publish(c, w.id, { 'binary.bin': Buffer.from([0, 255, 13, 10]), 'readme.txt': Buffer.from('second\nneedle\n') });
    const history = await call(c, `/v1/workspaces/${w.id}/revisions`); expect(history.status).toBe(200); expect(history.body.revisions.map((r: any) => r.id)).toEqual(expect.arrayContaining([first, second, w.currentRevisionId])); expect(history.body).not.toHaveProperty('privateReference');
    const manifest = await call(c, `/v1/workspaces/${w.id}/revisions/${first}/manifest`); expect(manifest.status).toBe(200); expect(manifest.body.entries.find((e: any) => e.path === 'empty')).toEqual({ path: 'empty', kind: 'directory' });
    const binary = await fetch(`${c.baseUrl}/v1/workspaces/${w.id}/revisions/${first}/files?path=binary.bin`, { headers: { 'X-API-Key': c.keyA } }); expect(binary.status).toBe(200); expect(Buffer.from(await binary.arrayBuffer())).toEqual(Buffer.from([0, 255, 13]));
    const diff = await call(c, `/v1/workspaces/${w.id}/diff?from=${first}&to=${second}`); expect(diff.status).toBe(200); expect(diff.body.files.map((f: any) => [f.path, f.status])).toEqual([['binary.bin', 'modified'], ['empty', 'deleted'], ['readme.txt', 'modified'], ['remove.txt', 'deleted']]);
    const search = await call(c, `/v1/workspaces/${w.id}/search?q=needle`); expect(search.status).toBe(200); expect(search.body.results).toEqual([{ path: 'readme.txt', lineNumber: 2, snippet: 'needle' }]);
    const legacy = await call(c, `/workspaces/${w.id}`); expect(legacy.status).toBe(200); expect(legacy.body.latestCommitId).toBe(second); expect(legacy.body).not.toHaveProperty('repoLocation');
    expect((await call(c, `/v1/workspaces/${w.id}/revisions`, 'GET', undefined, c.keyB)).status).toBe(404);
    expect((await call(c, `/workspaces/${w.id}`, 'GET', undefined, c.keyB)).status).toBe(404);
  } finally { await server.dispose(); }
}, 60000);

it('reports adding and removing an EOF newline with exact hunks while preserving unchanged and ordinary text controls', async () => {
  const server = await faultFixture();
  try {
    const c = server.client; const w = await workspace(c);
    const first = await publish(c, w.id, { 'eof.txt': Buffer.from('same'), 'ordinary.txt': Buffer.from('before\n'), 'stable.txt': Buffer.from('stable\n') });
    const second = await publish(c, w.id, { 'eof.txt': Buffer.from('same\n'), 'ordinary.txt': Buffer.from('after\n'), 'stable.txt': Buffer.from('stable\n') });
    const added = await call(c, `/v1/workspaces/${w.id}/diff?from=${first}&to=${second}`); expect(added.status).toBe(200);
    expect(added.body.summary).toEqual({ filesChanged: 2, additions: 2, deletions: 2 }); expect(added.body.files.map((file: any) => file.path)).toEqual(['eof.txt', 'ordinary.txt']);
    expect(added.body.files[0]).toMatchObject({ status: 'modified', binary: false, additions: 1, deletions: 1, hunks: [{ header: '@@ -1,1 +1,1 @@', content: '-same\n\\ No newline at end of file\n+same' }] });
    expect(added.body.files[1].hunks).toEqual([{ header: '@@ -1,1 +1,1 @@', content: '-before\n+after' }]);
    const removed = await call(c, `/v1/workspaces/${w.id}/diff?from=${second}&to=${first}`); expect(removed.status).toBe(200);
    expect(removed.body.files[0]).toMatchObject({ additions: 1, deletions: 1, hunks: [{ header: '@@ -1,1 +1,1 @@', content: '-same\n+same\n\\ No newline at end of file' }] });
    const unchanged = await call(c, `/v1/workspaces/${w.id}/diff?from=${second}&to=${second}`); expect(unchanged.status).toBe(200); expect(unchanged.body.files).toEqual([]); expect(unchanged.body.summary).toEqual({ filesChanged: 0, additions: 0, deletions: 0 });
  } finally { await server.dispose(); }
}, 60000);
