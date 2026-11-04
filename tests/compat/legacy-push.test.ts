import { describe, it, expect } from 'vitest';
import { fixture, workspace, push, call } from './helpers';
describe('legacy complete replacement publication', () => {
  it('publishes catalog revisions, preserves deletions, retries and rollback, and denies another tenant', async () => {
    const server = await fixture();
    try {
      const c = server.client; const w = await workspace(c); const key = crypto.randomUUID();
      const a = await push(c, w.id, [{ path: 'a.txt', content: 'first' }, { path: 'deleted.txt', content: 'old' }], key);
      expect(a.status).toBe(201); expect(a.body.commitId).toBeTruthy();
      expect((await push(c, w.id, [{ path: 'a.txt', content: 'first' }, { path: 'deleted.txt', content: 'old' }], key)).body.commitId).toBe(a.body.commitId);
      const b = await push(c, w.id, [{ path: 'a.txt', content: 'second' }]); expect(b.status).toBe(201);
      const current = await call(c, `/v1/workspaces/${w.id}`); expect(current.body.currentRevisionId).toBe(b.body.commitId);
      const pulled = await call(c, `/workspaces/${w.id}/pull`); expect(pulled.body.files).toEqual([{ path: 'a.txt', content: 'second' }]);
      const rolled = await call(c, `/workspaces/${w.id}/rollback`, 'POST', { toVersion: a.body.commitId }, c.keyA, crypto.randomUUID()); expect(rolled.status).toBe(201);
      expect((await call(c, `/workspaces/${w.id}/pull`)).body.files).toHaveLength(2);
      expect((await call(c, `/workspaces/${w.id}/push`, 'POST', { files: [] }, c.keyB, crypto.randomUUID())).status).toBeGreaterThanOrEqual(400);
      const empty = await push(c, w.id, []); expect(empty.status).toBe(201); expect((await call(c, `/workspaces/${w.id}/pull`)).body.files).toEqual([]);
    } finally { await server.dispose(); }
  });
});
