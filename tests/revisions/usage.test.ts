import { expect, it } from 'vitest';
import { call, faultFixture, publish, workspace } from './helpers';
it('reports real accepted-head logical bytes and catalog actions while marking unmeasured usage unavailable', async () => {
  const server = await faultFixture();
  try {
    const c = server.client; const empty = await call(c, '/analytics/usage?period=7d'); expect(empty.status).toBe(200);
    expect(empty.body.totalRequests).toBe(null); expect(empty.body.totalStorageBytes).toBe(null); expect(empty.body.activeApiKeys).toBe(null);
    expect(empty.body.recordedActions).toBe(0); expect(empty.body.logicalAcceptedBytes).toBe(0); expect(empty.body.recordedActionsByDay.every((day: any) => day.count === 0)).toBe(true);
    const w = await workspace(c); await publish(c, w.id, { 'binary.bin': Buffer.from([0, 255, 128]), 'text.txt': Buffer.from('hello') }, ['empty']);
    const before = await call(c, '/analytics/usage?period=7d'); expect(before.body.uniqueWorkspaces).toBe(1); expect(before.body.logicalAcceptedBytes).toBe(8); expect(before.body.recordedActions).toBe(3);
    await call(c, `/v1/workspaces/${w.id}`); await call(c, `/v1/workspaces/${w.id}`);
    const after = await call(c, '/analytics/usage?period=7d'); expect(after.body).toEqual(before.body); expect(after.body.recordedActionsByDay.reduce((n: number, day: any) => n + day.count, 0)).toBe(3);
    expect(after.body.metricsUnavailable).toEqual(expect.arrayContaining(['allHttpRequests', 'physicalStorageBytes', 'activeApiKeys']));
    const other = await call(c, '/analytics/usage?period=7d', 'GET', undefined, c.keyB); expect(other.body.uniqueWorkspaces).toBe(0); expect(other.body.recordedActions).toBe(0);
    expect((await fetch(`${c.baseUrl}/v1/workspaces/${w.id}`, { method: 'DELETE', headers: { 'X-API-Key': c.keyA, 'Idempotency-Key': 'delete' } })).status).toBe(204);
    const deleted = await call(c, '/analytics/usage?period=7d'); expect(deleted.body.uniqueWorkspaces).toBe(0); expect(deleted.body.logicalAcceptedBytes).toBe(0); expect(deleted.body.recordedActions).toBe(4);
  } finally { await server.dispose(); }
}, 60000);
