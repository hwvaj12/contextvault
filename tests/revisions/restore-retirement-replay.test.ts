import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { call, faultFixture, operation, publish, workspace } from './helpers';

it('replays a completed restore after controlled catalog reference retirement without backend reads', async () => {
  const server = await faultFixture(); const spies: { mockRestore(): void }[] = [];
  try {
    const c = server.client; const w = await workspace(c); const old = await publish(c, w.id, { 'binary.bin': Buffer.from([0, 255, 128]) }, ['empty']); const head = await publish(c, w.id, { later: Buffer.from('later') }); const current = (await call(c, `/v1/workspaces/${w.id}`)).body;
    const body = { revisionId: old, expectedRevisionId: head, expectedWorkspaceVersion: current.version, reason: 'preserve the durable outcome after retirement' }; const key = 'restore-before-reference-retirement';
    const response = await call(c, `/v1/workspaces/${w.id}/restore`, 'POST', body, c.keyA, key); expect(response.status).toBe(202); const accepted = await operation(c, response.body); expect(accepted.state).toBe('succeeded');
    const runtime = server.app.contextVault; const scope: any = { customerId: c.customerA, workspaceId: w.id }; const control = runtime.control;
    const stored = await control.getOperation(scope, accepted.id); if (!stored || stored.kind !== 'restore') throw new Error('Typed restore operation is required');
    const before = (await control.getWorkspace(scope))!; const original = (await control.getBinding(scope, before.storageBindingId))!; const revisions = (await control.listRevisions(scope, undefined, 1000)).revisions; const store = await runtime.revisionStore(original);
    const target = { ...original, id: `binding-${randomUUID()}` as any, generation: original.generation + 1 }; const moved = { ...before, storageBindingId: target.id, bindingGeneration: target.generation, version: before.version + 1 };
    // Controlled catalog fixture only: CV25 owns migration execution, candidate ownership and physical copy proof.
    // These deliberately unreadable references model retired locators without bypassing runtime writer tracking.
    runtime.database.transaction(() => {
      const update = runtime.database.prepare('UPDATE catalog_records SET data=? WHERE kind=? AND id=? AND customer_id=? AND workspace_id=?');
      update.run(JSON.stringify({ ...original, status: 'retired' }), 'binding', original.id, c.customerA, w.id);
      runtime.database.prepare("INSERT INTO catalog_records(kind,id,customer_id,workspace_id,run_id,data) VALUES('binding',?,?,?,NULL,?)").run(target.id, c.customerA, w.id, JSON.stringify(target));
      for (const revision of revisions) update.run(JSON.stringify({ ...revision, scope: { ...revision.scope, storageBindingId: target.id, bindingGeneration: target.generation }, privateReference: { ...revision.privateReference, opaqueKey: `controlled-unreadable-${revision.id}` } }), 'revision', revision.id, c.customerA, w.id);
      update.run(JSON.stringify(moved), 'workspace', w.id, c.customerA, w.id);
    }).immediate();
    expect((await control.getBinding(scope, original.id))?.status).toBe('retired'); expect((await control.getRevision(scope, old as any))?.scope.storageBindingId).toBe(target.id);
    for (const method of ['readManifest', 'openFile', 'inspectCandidate', 'prepare'] as const) spies.push(vi.spyOn(store, method).mockRejectedValue(new Error('Replay must not access backend bytes')) as any);
    const replay = await call(c, `/v1/workspaces/${w.id}/restore`, 'POST', body, c.keyA, key); expect(replay.status).toBe(202); expect(replay.body.id).toBe(accepted.id); expect(replay.body.result).toEqual(accepted.result);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled(); expect(await control.getOperation(scope, accepted.id)).toEqual(stored);
    expect(await control.getWorkspace(scope)).toEqual(moved); expect((await control.listAudit(scope)).events.filter(event => event.operationId === accepted.id)).toHaveLength(1);
    expect((await fetch(`${c.baseUrl}/api-keys/${server.keys[0].id}`, { method: 'DELETE', headers: { 'X-API-Key': server.master } })).status).toBe(204);
    expect((await call(c, `/v1/workspaces/${w.id}/restore`, 'POST', body, c.keyA, key)).status).toBe(401);
  } finally { for (const spy of spies.reverse()) spy.mockRestore(); await server.dispose(); }
}, 60000);
