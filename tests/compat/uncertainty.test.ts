import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { faultFixture } from './fault-fixture';
import { call, workspace } from './helpers';
import { principalForVerifiedApiKey } from '../../src/middleware/catalog-identity';
import type { Principal } from '../../src/domain';

it('retains unknown checkpoint source and original command, blocks cleanup, then reconciles without recapture', async () => {
  let signal!: () => void; let release!: () => void; const reached = new Promise<void>(resolve => { signal = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
  const server = await faultFixture({ lifecycle: { hook: async (stage, operation) => { if (stage === 'before-accept' && operation.kind === 'finalize') { signal(); await held; } } } }, 1000);
  try {
    const c = server.client; const w = await workspace(c); const opened = await call(c, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'checkout');
    const path = join(opened.body.sandboxPath, 'checkpoint.txt'); await writeFile(path, 'original selected bytes');
    const pending = call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'original-checkpoint'); await reached;
    const unknown = await pending; expect(unknown.status).toBe(503); expect(unknown.body.error.code).toBe('PUBLICATION_OUTCOME_UNKNOWN'); expect(unknown.body.error.operationId).toBeTruthy();
    expect((await call(c, `/workspaces/${w.id}/sandbox`, 'DELETE', { writersStopped: true }, c.keyA, 'cleanup')).status).toBe(503);
    expect((await call(c, `/workspaces/${w.id}/sandbox`, 'DELETE', { writersStopped: true, abandon: true }, c.keyA, 'unknown-abandon')).status).toBe(503);
    expect((await call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'different-checkpoint')).status).toBe(503);
    expect(await readFile(path, 'utf8')).toBe('original selected bytes');
    release();
    let replay: any; for (let attempt = 0; attempt < 50; attempt++) { replay = await call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'original-checkpoint'); if (replay.status === 201) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    expect(replay.status).toBe(201); expect(replay.body.operation.id).toBe(unknown.body.error.operationId);
    expect((await call(c, `/workspaces/${w.id}/pull`)).body.files).toEqual([{ path: 'checkpoint.txt', content: 'original selected bytes' }]);
    const scope = { customerId: c.customerA as never, workspaceId: w.id };
    expect((await server.app.contextVault.control.listRevisions(scope)).revisions).toHaveLength(2);
  } finally { release(); await server.dispose(); }
});

it('keeps published-needs-reopen and retries its original open key without another publication', async () => {
  let removeOpenGrant = true;
  const server = await faultFixture({ lifecycle: { hook: async (stage, operation) => {
    if (stage === 'after-accept' && operation.kind === 'finalize' && removeOpenGrant) {
      removeOpenGrant = false; const runtime = server.app.contextVault; const principal = operation.principal;
      const authority = await runtime.control.getAuthority(operation.scope, principal); if (!authority) throw new Error('Missing authority');
      const authorization = await runtime.lifecycle.runtime.authorize(principal, 'credential:manage', { customerId: operation.scope.customerId });
      await runtime.control.updateAuthority({ scope: { customerId: operation.scope.customerId }, principal, authorization, expectedCredentialVersion: authority.credentialVersion, expectedPermissionEpoch: authority.permissionEpoch, authority: { ...authority, credentialVersion: authority.credentialVersion + 1, permissionEpoch: authority.permissionEpoch + 1, grants: authority.grants.filter(grant => grant.action !== 'run:open-write') } });
    }
  } } });
  try {
    const c = server.client; const w = await workspace(c); const opened = await call(c, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'open'); await writeFile(join(opened.body.sandboxPath, 'published.txt'), 'published');
    const first = await call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'checkpoint');
    // Acceptance can race the post-accept credential update. Retry observes the same durable outcome.
    let pending = first; if (pending.status !== 201) pending = await call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'checkpoint');
    expect(pending.status).toBe(201); expect(pending.body.state).toBe('published-needs-reopen'); expect(pending.body.outcome.state).toBe('finalized');
    const runtime = server.app.contextVault; const principal = (await principalForVerifiedApiKey(runtime.database, { id: server.keys[0].id, customerId: c.customerA }, runtime.now())) as Principal;
    const authority = (await runtime.control.getAuthority({ customerId: c.customerA }, principal))!; const authorization = await runtime.lifecycle.runtime.authorize(principal, 'credential:manage', { customerId: c.customerA });
    await runtime.control.updateAuthority({ scope: { customerId: c.customerA }, principal, authorization, expectedCredentialVersion: authority.credentialVersion, expectedPermissionEpoch: authority.permissionEpoch, authority: { ...authority, credentialVersion: authority.credentialVersion + 1, permissionEpoch: authority.permissionEpoch + 1, grants: [...authority.grants, { action: 'run:open-write', customerId: c.customerA, workspaceId: null }] } });
    const replay = await call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'checkpoint'); expect(replay.status).toBe(201); expect(replay.body.state).toBe('active'); expect(replay.body.commitId).toBe(pending.body.commitId); expect(replay.body.operation.id).toBe(pending.body.operation.id);
    expect((await runtime.control.listRevisions({ customerId: c.customerA, workspaceId: w.id })).revisions).toHaveLength(2);
  } finally { await server.dispose(); }
});

it('replays the original checkpoint after a genuinely lost HTTP response without capturing changed files', async () => {
  let reached!: () => void; let release!: () => void; const ready = new Promise<void>(resolve => { reached = resolve; }); const held = new Promise<void>(resolve => { release = resolve; }); let operationId = '';
  const server = await faultFixture({ lifecycle: { hook: async (stage, operation) => { if (stage === 'before-accept' && operation.kind === 'finalize') { operationId = operation.id; reached(); await held; } } } });
  try {
    const c = server.client; const w = await workspace(c); const opened = await call(c, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'lost-open'); const file = join(opened.body.sandboxPath, 'selected.txt'); await writeFile(file, 'selected before dispatch');
    const controller = new AbortController();
    const pending = fetch(`${c.baseUrl}/workspaces/${w.id}/sandbox/commit`, { method: 'POST', signal: controller.signal, headers: { 'X-API-Key': c.keyA, 'Content-Type': 'application/json', 'Idempotency-Key': 'lost-checkpoint' }, body: JSON.stringify({ writersStopped: true }) });
    await ready; controller.abort(); await expect(pending).rejects.toBeTruthy();
    // Changed local bytes must remain local; the retry selects the already persisted source.
    await writeFile(file, 'changed after response loss'); release();
    let replay: any; for (let attempt = 0; attempt < 50; attempt++) { replay = await call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'lost-checkpoint'); if (replay.status === 201) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    expect(replay.status).toBe(201); expect(replay.body.operation.id).toBe(operationId);
    expect((await call(c, `/workspaces/${w.id}/pull`)).body.files).toEqual([{ path: 'selected.txt', content: 'selected before dispatch' }]);
    expect(await readFile(file, 'utf8')).toBe('changed after response loss');
    expect((await server.app.contextVault.control.listRevisions({ customerId: c.customerA, workspaceId: w.id })).revisions).toHaveLength(2);
  } finally { release(); await server.dispose(); }
});
