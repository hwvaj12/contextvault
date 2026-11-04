import { expect, it } from 'vitest';
import { call, faultFixture, publish, workspace } from '../revisions/helpers';

it('bulk deletion tombstones authorized workspaces, reports unauthorized IDs and preserves accepted history and bytes', async () => {
  const server = await faultFixture();
  try {
    const c = server.client; const owned = await workspace(c); const revisionId = await publish(c, owned.id, { 'retained.bin': Buffer.from([0, 255, 128]) });
    const foreign = await call(c, '/v1/workspaces', 'POST', { customerId: c.customerB, name: 'foreign' }, c.keyB, 'foreign-create'); expect(foreign.status).toBe(201);
    const result = await call(c, '/workspaces/bulk-delete', 'POST', { workspaceIds: [owned.id, foreign.body.id, 'unknown-workspace'] }, c.keyA, 'delete-request');
    expect(result.status).toBe(200); expect(result.body.deleted).toBe(1); expect(result.body.failed.map((item: any) => item.id)).toEqual([foreign.body.id, 'unknown-workspace']);
    const scope: any = { customerId: c.customerA, workspaceId: owned.id }; const runtime = server.app.contextVault;
    expect((await runtime.control.getWorkspace(scope))?.status).toBe('deleted');
    const retained = await runtime.control.getRevision(scope, revisionId); expect(retained).not.toBeNull();
    await runtime.maintenance.runOnce();
    const binding = await runtime.control.getBinding(scope, retained!.scope.storageBindingId); const store = await runtime.revisionStore(binding!); const reference = { ...retained!, revisionId };
    expect((await store.readManifest(reference)).entries.map(entry => entry.path)).toEqual(['retained.bin']); const chunks = [];
    for await (const chunk of await store.openFile(reference, 'retained.bin')) chunks.push(Buffer.from(chunk)); expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 255, 128]));
    expect((await call(c, `/v1/operations/${retained!.originatingOperationId}`)).status).toBe(200);
    expect((await call(c, `/v1/workspaces/${owned.id}`)).status).toBe(403);
    expect((await call(c, `/v1/workspaces/${foreign.body.id}`, 'GET', undefined, c.keyB)).status).toBe(200);
    const replay = await call(c, '/workspaces/bulk-delete', 'POST', { workspaceIds: [owned.id, foreign.body.id, 'unknown-workspace'] }, c.keyA, 'delete-request'); expect(replay.body).toEqual(result.body);
    const list = await call(c, '/workspaces'); expect(list.status).toBe(200); expect(list.body.data).toEqual([]);
  } finally { await server.dispose(); }
}, 60000);
