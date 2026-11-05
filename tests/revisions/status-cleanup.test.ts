import { expect, it } from 'vitest';
import { call, faultFixture, publish, workspace } from './helpers';

for (const prefix of ['', '/v1']) it(`completes ${prefix || 'legacy'} deletion cleanup and retains accepted bytes on replay`, async () => {
  const server = await faultFixture();
  try {
    const c = server.client, runtime = server.app.contextVault;
    const value = await workspace(c), bytes = Buffer.from([0, 255, 128, 13, 10]);
    const revisionId = await publish(c, value.id, { 'retained.bin': bytes });
    const scope: any = { customerId: c.customerA, workspaceId: value.id };
    const before = (await runtime.control.listRevisions(scope)).revisions;
    for (let attempt = 0; attempt < 2; attempt++) {
      const deleted = await fetch(c.baseUrl + prefix + '/workspaces/' + value.id, {
        method: 'DELETE', headers: { 'X-API-Key': c.keyA, 'Idempotency-Key': 'same-deletion' },
      });
      expect(deleted.status).toBe(204);
    }
    const deleted = (await runtime.control.getWorkspace(scope))!;
    expect(deleted.status).toBe('deleted');
    const cleanupId: any = `workspace:${value.id}:${deleted.version}`;
    let cleanup;
    for (let turn = 0; turn < 8; turn++) {
      const report = await runtime.maintenance.runOnce();
      expect(report.errors).toEqual([]);
      cleanup = await runtime.control.getCleanup(scope, cleanupId);
      if (cleanup?.state === 'complete') break;
    }
    expect(cleanup?.state).toBe('complete');
    expect((await runtime.control.listRevisions(scope)).revisions.map(v => v.id)).toEqual(before.map(v => v.id));
    expect(deleted.currentRevisionId).toBe(revisionId);
    const revision = (await runtime.control.getRevision(scope, revisionId))!;
    const binding = (await runtime.control.getBinding(scope, revision.scope.storageBindingId))!;
    const store = await runtime.revisionStore(binding);
    const chunks: Uint8Array[] = [];
    for await (const chunk of await store.openFile({ scope: revision.scope, revisionId: revision.id,
      manifestDigest: revision.manifestDigest, privateReference: revision.privateReference }, 'retained.bin')) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(bytes);
    const events = (await runtime.control.listAudit(scope)).events.filter(event => event.type === 'workspace.deleted');
    expect(events).toHaveLength(1);
    const outbox = runtime.database.prepare("SELECT count(*) AS count FROM catalog_records WHERE kind='outbox' AND customer_id=? AND workspace_id=? AND json_extract(data,'$.operationId')=?").get(scope.customerId, scope.workspaceId, events[0].operationId) as { count: number };
    expect(outbox.count).toBe(1);
    expect((await call(c, `/v1/workspaces/${value.id}/revisions/${revisionId}/manifest`)).status).toBe(403);
    await expect(runtime.control.getCleanupTargets({ ...scope, customerId: c.customerB }, cleanupId)).resolves.toBeNull();
    runtime.database.prepare("DELETE FROM catalog_records WHERE kind='cleanup-owner' AND id=? AND customer_id=? AND workspace_id=?").run(cleanupId, scope.customerId, scope.workspaceId);
    await expect(runtime.control.getCleanupTargets(scope, cleanupId)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  } finally { await server.dispose(); }
}, 60000);
