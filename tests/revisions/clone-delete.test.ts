import { expect, it } from 'vitest';
import { call, faultFixture, publish, workspace } from './helpers';
const adminClone = async (server: Awaited<ReturnType<typeof faultFixture>>, id: string, body: unknown, selected: string, key = 'admin-clone') => {
  const response = await fetch(`${server.client.baseUrl}/v1/workspaces/${id}/clone`, { method: 'POST', headers: { 'X-API-Key': server.master, 'X-ContextVault-Customer-Id': selected, 'Idempotency-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
it('requires source-read and target-create, preserves binary clone contents, and tombstones deletion without erasing history', async () => {
  const server = await faultFixture();
  try {
    const c = server.client; const source = await workspace(c); const revision = await publish(c, source.id, { 'binary.bin': Buffer.from([255, 0, 128]), 'text.txt': Buffer.from('clone') }, ['empty']);
    expect((await call(c, `/v1/workspaces/${source.id}/clone`, 'POST', { targetCustomerId: c.customerB }, c.keyA, 'denied')).status).toBe(403);
    const local = await call(c, `/workspaces/${source.id}/clone`, 'POST', { targetCustomerId: c.customerA, name: 'local clone' }, c.keyA, 'clone-local'); expect(local.status).toBe(201);
    expect((await call(c, `/v1/workspaces/${local.body.id}/revisions/${local.body.latestCommitId}/manifest`)).body).toEqual((await call(c, `/v1/workspaces/${source.id}/revisions/${revision}/manifest`)).body);
    const cross = await adminClone(server, source.id, { targetCustomerId: c.customerB, name: 'cross-customer clone' }, c.customerA); expect(cross.status, JSON.stringify(cross.body)).toBe(201); expect(cross.body.customerId).toBe(c.customerB);
    expect((await call(c, `/v1/workspaces/${cross.body.id}`, 'GET', undefined, c.keyA)).status).toBe(404);
    expect((await call(c, `/v1/workspaces/${cross.body.id}`, 'GET', undefined, c.keyB)).status).toBe(200);
    const manifest = await call(c, `/v1/workspaces/${cross.body.id}/revisions/${cross.body.currentRevisionId}/manifest`, 'GET', undefined, c.keyB); expect(manifest.status).toBe(200); expect(manifest.body.entries.map((entry: any) => entry.path)).toEqual(['binary.bin', 'empty', 'text.txt']);
    expect((await adminClone(server, source.id, { targetCustomerId: c.customerB }, c.customerB, 'wrong-selection')).status).toBe(404);
    const removed = await fetch(`${c.baseUrl}/v1/workspaces/${local.body.id}`, { method: 'DELETE', headers: { 'X-API-Key': c.keyA, 'Idempotency-Key': 'delete-local' } }); expect(removed.status).toBe(204);
    const scope: any = { customerId: c.customerA, workspaceId: local.body.id }; expect((await server.app.contextVault.control.getWorkspace(scope))?.status).toBe('deleted'); expect(await server.app.contextVault.control.getRevision(scope, local.body.latestCommitId)).not.toBeNull();
    expect((await call(c, '/workspaces')).body.data.map((w: any) => w.id)).not.toContain(local.body.id);
  } finally { await server.dispose(); }
}, 60000);

for (const revoked of ['source', 'destination'] as const) it(`rechecks the ${revoked} administrator credential during clone publication`, async () => {
  let reached!: () => void; let release!: () => void; let saved: any; const ready = new Promise<void>(resolve => { reached = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
  const server = await faultFixture({ lifecycle: { hook: async (stage, operation) => { if (stage === 'before-accept' && operation.kind === 'restore') { saved = operation; reached(); await held; } } } });
  try {
    const c = server.client; const source = await workspace(c); const revision = await publish(c, source.id, { 'retained.txt': Buffer.from('source remains') });
    const pending = adminClone(server, source.id, { targetCustomerId: c.customerB, name: 'revoked clone' }, c.customerA); await ready;
    const principal = revoked === 'source' ? saved.intent.source.principal : saved.principal; const customerId = revoked === 'source' ? c.customerA : c.customerB; const scope: any = { customerId }; const runtime = server.app.contextVault;
    const authority = await runtime.control.getAuthority(scope, principal); expect(authority).not.toBeNull();
    const authorization = await runtime.lifecycle.runtime.authorize(principal, 'credential:manage', scope);
    await runtime.control.updateAuthority({ scope, principal, authorization, expectedCredentialVersion: authority!.credentialVersion, expectedPermissionEpoch: authority!.permissionEpoch,
      authority: { ...authority!, credentialVersion: authority!.credentialVersion + 1, permissionEpoch: authority!.permissionEpoch + 1, revokedAt: runtime.now() } });
    release(); const response = await pending; expect(response.status, JSON.stringify(response.body)).toBe(403); expect(response.body.error.code).toBe('CREDENTIAL_REVOKED');
    const target = await runtime.control.getWorkspace(saved.scope); expect(target?.version).toBe(1); expect((await runtime.control.getOperation(saved.scope, saved.id))?.state).toBe('failed');
    expect((await runtime.control.getWorkspace({ customerId: c.customerA, workspaceId: source.id } as any))?.currentRevisionId).toBe(revision);
  } finally { release(); await server.dispose(); }
}, 60000);
