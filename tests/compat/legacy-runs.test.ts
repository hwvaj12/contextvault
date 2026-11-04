import { it, expect } from 'vitest';
import { fixture, workspace, call } from './helpers';
it('uses scoped catalog runs, bounded listing and aliases without changing v1 outcomes', async () => {
  const server = await fixture();
  try {
    const c = server.client; const w = await workspace(c);
    const a = await call(c, `/workspaces/${w.id}/runs`, 'POST', { agentId: 'old-agent', mode: 'read-only' }, c.keyA, 'run-a'); expect(a.status).toBe(201);
    await call(c, `/workspaces/${w.id}/runs`, 'POST', { agentId: 'old-agent', mode: 'read-only' }, c.keyA, 'run-b');
    const page = await call(c, `/workspaces/${w.id}/runs?limit=1`); expect(page.body.runs).toHaveLength(1); expect(page.body.nextCursor).toBeTruthy();
    expect((await call(c, `/workspaces/${w.id}/runs`, 'GET', undefined, c.keyB)).body.runs).toBeUndefined();
    const final = await call(c, `/runs/${a.body.id}/finalize`, 'POST', {}, c.keyA, 'finish-a'); expect(final.status).toBe(200); expect(['merged', 'cleaned_up']).toContain(final.body.status); expect(final.body.state).toBe('finalized'); expect(final.body.outcome.state).toBe('finalized');
    expect((await call(c, `/v1/runs/${a.body.id}`)).body.state).toBe('finalized');
    const writable = await call(c, `/workspaces/${w.id}/runs`, 'POST', { agentId: 'writable' }, c.keyA, 'writable');
    expect((await call(c, `/runs/${writable.body.id}/finalize`, 'POST', { expectedRunVersion: writable.body.version + 1 }, c.keyA, 'stale-finalize')).status).toBe(409);
    expect((await call(c, `/v1/runs/${writable.body.id}`)).body.state).toBe('active');
    const aborted = await call(c, `/runs/${writable.body.id}/abort`, 'POST', { reason: 'explicit abort' }, c.keyA, 'abort'); expect(aborted.status).toBe(200); expect(aborted.body.outcome.state).toBe('aborted');
    expect((await call(c, `/runs/${writable.body.id}/abort`, 'POST', { reason: 'explicit abort' }, c.keyA, 'abort')).body.outcome).toEqual(aborted.body.outcome);

  } finally { await server.dispose(); }
});
