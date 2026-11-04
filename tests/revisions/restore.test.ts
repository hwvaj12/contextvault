import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { call, faultFixture, operation, publish, workspace } from './helpers';

it('restores an exact older tree through a durable typed operation, with CAS and original-key replay', async () => {
  let seen: any; const server = await faultFixture({ lifecycle: { hook: async (stage, value) => { if (stage === 'before-prepare' && value.kind === 'restore') { const durable = await server.app.contextVault.control.getOperation(value.scope, value.id); expect(durable).toEqual(value); seen = structuredClone(value); } } } });
  try {
    const c = server.client; const w = await workspace(c); const first = await publish(c, w.id, { 'binary.bin': Buffer.from([0, 255, 128]), 'old.txt': Buffer.from('old tree') }, ['empty']);
    const second = await publish(c, w.id, { 'new.txt': Buffer.from('remove by restore') }); const current = (await call(c, `/v1/workspaces/${w.id}`)).body;
    const body = { revisionId: first, expectedRevisionId: second, expectedWorkspaceVersion: current.version, reason: 'recover the approved older context' }; const key = randomUUID();
    expect((await call(c, `/v1/workspaces/${w.id}/restore`, 'POST', body)).status).toBe(400);
    const accepted = await call(c, `/v1/workspaces/${w.id}/restore`, 'POST', body, c.keyA, key); expect(accepted.status).toBe(202); const result = await operation(c, accepted.body);
    expect(result.kind).toBe('restore'); expect(result.runId).toBe(null); expect(result.state).toBe('succeeded'); expect(result.result.changed).toBe(true); expect(result.result.revisionId).not.toBe(first);
    expect(seen.intent.request.body).toEqual(body); expect(seen.intent.source.revision.id).toBe(first); expect(seen.intent.candidateIdentity.parentRevisionId).toBe(second); expect(seen.candidate).toBe(null);
    const restored = (await call(c, `/v1/workspaces/${w.id}/revisions/${result.result.revisionId}/manifest`)).body; const original = (await call(c, `/v1/workspaces/${w.id}/revisions/${first}/manifest`)).body; expect(restored).toEqual(original);
    const revision = await server.app.contextVault.control.getRevision({ customerId: c.customerA, workspaceId: w.id } as any, result.result.revisionId); expect(revision?.parentRevisionId).toBe(second);
    const next = await publish(c, w.id, { 'later.txt': Buffer.from('later') }); const retry = await call(c, `/v1/workspaces/${w.id}/restore`, 'POST', body, c.keyA, key); expect(retry.status).toBe(202); expect(retry.body.id).toBe(result.id); expect(retry.body.result).toEqual(result.result);
    expect((await call(c, `/v1/workspaces/${w.id}`)).body.currentRevisionId).toBe(next);
    expect((await call(c, `/v1/workspaces/${w.id}/restore`, 'POST', { ...body, reason: 'changed' }, c.keyA, key)).status).toBe(409);
    expect((await call(c, `/v1/workspaces/${w.id}/restore`, 'POST', body, c.keyA, randomUUID())).status).toBe(409);
    const audits = await server.app.contextVault.control.listAudit({ customerId: c.customerA, workspaceId: w.id } as any); expect(audits.events.filter(e => e.operationId === result.id)).toHaveLength(1);
  } finally { await server.dispose(); }
}, 60000);

for (const committed of [false, true]) it(`reconciles unknown restore acceptance when the commit ${committed ? 'succeeds' : 'does not happen'} and both acknowledgements are lost`, async () => {
  let clock = Date.now(); const server = await faultFixture({ now: () => new Date(clock).toISOString(), lifecycle: { processingTtlMs: 1000, processingRenewIntervalMs: 0 } });
  const runtime = server.app.contextVault; const spies: { mockRestore(): void }[] = [];
  try {
    const c = server.client; const w = await workspace(c); const old = await publish(c, w.id, { 'binary.bin': Buffer.from([0, 255, 128]) }, ['empty']); const head = await publish(c, w.id, { 'remove.txt': Buffer.from('later') }); const current = (await call(c, `/v1/workspaces/${w.id}`)).body;
    const body = { revisionId: old, expectedRevisionId: head, expectedWorkspaceVersion: current.version, reason: 'reconcile an unknown publication' }; const key = randomUUID();
    const accept = runtime.control.acceptRestore.bind(runtime.control); const process = runtime.restore.process.bind(runtime.restore); let unknown: any;
    spies.push(vi.spyOn(runtime.restore, 'process').mockImplementation(async input => { try { return await process(input); } catch (error) { unknown = error; throw error; } }));
    spies.push(vi.spyOn(runtime.control, 'acceptRestore').mockImplementationOnce(async input => {
      if (committed) await accept(input);
      spies.push(vi.spyOn(runtime.control, 'getOperation').mockRejectedValueOnce(new Error('catalog observation unavailable')));
      throw new Error('acceptance acknowledgement unavailable');
    }));
    const response = await call(c, `/v1/workspaces/${w.id}/restore`, 'POST', body, c.keyA, key); expect(response.status).toBe(202);
    for (let attempt = 0; attempt < 500 && !unknown; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(unknown?.code).toBe('PUBLICATION_OUTCOME_UNKNOWN'); const scope: any = { customerId: c.customerA, workspaceId: w.id };
    const retained = await runtime.control.getOperation(scope, response.body.id); expect(retained?.state).toBe(committed ? 'succeeded' : 'processing'); expect(retained?.candidate).not.toBeNull();
    expect((await runtime.control.getWorkspace(scope))?.currentRevisionId).toBe(committed ? retained?.result?.revisionId : head);
    const retry = await call(c, `/v1/workspaces/${w.id}/restore`, 'POST', body, c.keyA, key); expect(retry.status).toBe(202); expect(retry.body.id).toBe(response.body.id);
    if (!committed) { clock += 2000; const report = await runtime.maintenance.runOnce(); expect(report.recovered).toBe(1); expect(report.errors).toEqual([]); }
    const settled = await operation(c, retry.body); expect(settled.state).toBe('succeeded'); expect(settled.result.revisionId).toBe(retained?.candidate?.revisionId);
    expect((await runtime.control.getOperation(scope, settled.id))?.candidate).toEqual(retained?.candidate);
    expect((await call(c, `/v1/workspaces/${w.id}/revisions`)).body.revisions).toHaveLength(4);
    const rows = runtime.database.prepare("SELECT kind,data FROM catalog_records WHERE kind IN ('audit','outbox') AND customer_id=? AND workspace_id=? AND json_extract(data,'$.operationId')=?").all(c.customerA, w.id, settled.id) as any[];
    expect(rows.map(row => row.kind).sort()).toEqual(['audit', 'outbox']); expect(rows.map(row => JSON.parse(row.data).type)).toEqual(['workspace.restored', 'workspace.restored']);
    const binary = await fetch(`${c.baseUrl}/v1/workspaces/${w.id}/revisions/${settled.result.revisionId}/files?path=binary.bin`, { headers: { 'X-API-Key': c.keyA } }); expect(Buffer.from(await binary.arrayBuffer())).toEqual(Buffer.from([0, 255, 128]));
  } finally { for (const spy of spies.reverse()) spy.mockRestore(); await server.dispose(); }
}, 60000);

it('rejects a prepared restore after another accepted publication advances the head', async () => {
  let reached!: () => void; let release!: () => void; const ready = new Promise<void>(resolve => { reached = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
  const server = await faultFixture({ lifecycle: { hook: async (stage, value) => { if (stage === 'before-accept' && value.kind === 'restore') { reached(); await held; } } } });
  try {
    const c = server.client; const w = await workspace(c); const old = await publish(c, w.id, { old: Buffer.from('old') }); const head = await publish(c, w.id, { previous: Buffer.from('previous') }); const current = (await call(c, `/v1/workspaces/${w.id}`)).body;
    const response = await call(c, `/v1/workspaces/${w.id}/restore`, 'POST', { revisionId: old, expectedRevisionId: head, expectedWorkspaceVersion: current.version, reason: 'test publication conflict' }, c.keyA, randomUUID()); expect(response.status).toBe(202); await ready;
    const latest = await publish(c, w.id, { latest: Buffer.from('accepted while restore prepared') }); release(); const settled = await operation(c, response.body);
    expect(settled.state).toBe('failed'); expect(settled.error.code).toBe('REVISION_CONFLICT'); expect((await call(c, `/v1/workspaces/${w.id}`)).body.currentRevisionId).toBe(latest);
    expect((await call(c, `/v1/workspaces/${w.id}/revisions`)).body.revisions).toHaveLength(4);
  } finally { release(); await server.dispose(); }
}, 60000);

it('rechecks revocation during restore preparation and cannot publish a stale or foreign source', async () => {
  let reached!: () => void; let release!: () => void; const ready = new Promise<void>(resolve => { reached = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
  const server = await faultFixture({ lifecycle: { hook: async (stage, value) => { if (stage === 'before-accept' && value.kind === 'restore') { reached(); await held; } } } });
  try {
    const c = server.client; const w = await workspace(c); const old = await publish(c, w.id, { 'old': Buffer.from('old') }); const head = await publish(c, w.id, { 'new': Buffer.from('new') }); const current = (await call(c, `/v1/workspaces/${w.id}`)).body;
    const body = { revisionId: old, expectedRevisionId: head, expectedWorkspaceVersion: current.version, reason: 'test current authority' };
    expect((await call(c, `/v1/workspaces/${w.id}/restore`, 'POST', body, c.keyB, randomUUID())).status).toBe(404);
    const foreign = await call(c, '/v1/workspaces', 'POST', { customerId: c.customerB, name: 'foreign' }, c.keyB, randomUUID()); expect(foreign.status).toBe(201);
    expect((await call(c, `/v1/workspaces/${w.id}/restore`, 'POST', { ...body, revisionId: foreign.body.currentRevisionId }, c.keyA, randomUUID())).status).toBe(404);
    const response = await call(c, `/v1/workspaces/${w.id}/restore`, 'POST', body, c.keyA, randomUUID()); expect(response.status).toBe(202); await ready;
    expect((await fetch(`${c.baseUrl}/api-keys/${server.keys[0].id}`, { method: 'DELETE', headers: { 'X-API-Key': server.master } })).status).toBe(204); release();
    let settled: any; for (let i = 0; i < 100; i++) { settled = await server.app.contextVault.control.getOperation({ customerId: c.customerA, workspaceId: w.id } as any, response.body.id); if (settled?.state === 'failed') break; await new Promise(resolve => setTimeout(resolve, 10)); }
    expect(settled.state).toBe('failed'); expect(settled.error.code).toBe('CREDENTIAL_REVOKED'); expect((await server.app.contextVault.control.getWorkspace({ customerId: c.customerA, workspaceId: w.id } as any))?.currentRevisionId).toBe(head);
  } finally { release(); await server.dispose(); }
}, 60000);
