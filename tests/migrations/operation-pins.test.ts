import { generateKeyPairSync } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { operation } from '../revisions/helpers';
import { call, migrationFixture, publish, workspace } from './helpers';
import { service, transferInput } from './process-helpers';

it('drains preparing exports and replays completed export and restore after real physical transfer without retired reference reads', async () => {
  const keys = generateKeyPairSync('ed25519');
  const f = await migrationFixture({ CONTEXTVAULT_SIGNING_PRIVATE_KEY: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), CONTEXTVAULT_SIGNING_PUBLIC_KEY: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), CONTEXTVAULT_SIGNING_KEY_ID: 'migration-export-key' });
  let release = () => {}; const spies: any[] = [];
  try {
    const c = f.client; const w = await workspace(c); const old = await publish(c, w.id, { 'old.txt': Buffer.from('retained operation bytes') }, ['empty']); const later = await publish(c, w.id, { 'later.txt': Buffer.from('later') });
    const current = (await call(c, `/v1/workspaces/${w.id}`)).body;
    const body = { revisionId: old, expectedRevisionId: later, expectedWorkspaceVersion: current.version, reason: 'complete before backend transfer' }; const key = 'restore-before-migration';
    const restored = await call(c, `/v1/workspaces/${w.id}/restore`, 'POST', body, c.keyA, key); expect(restored.status).toBe(202); const completed = await operation(c, restored.body); expect(completed.state).toBe('succeeded');
    const control = f.app.contextVault.control; const original = control.createBundle.bind(control); let reached!: () => void;
    const ready = new Promise<void>(resolve => { reached = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
    const stop = vi.spyOn(control, 'createBundle').mockImplementation(async input => { const bundle = await original(input); if (bundle.kind === 'export' && bundle.state === 'preparing') { reached(); await held; } return bundle; });
    const exported = call(c, `/workspaces/${w.id}/export`, 'POST', {}, c.keyA, 'export-before-migration'); await ready;
    const input = transferInput(f, w.id); const before = (await control.getWorkspace(input.scope))!; const binding = (await control.getBinding(input.scope, before.storageBindingId))!; const oldStore = await f.app.contextVault.revisionStore(binding);
    await expect(service(f).transfer(input)).rejects.toMatchObject({ code: 'FINALIZATION_IN_PROGRESS' });
    expect((await call(c, `/v1/workspaces/${w.id}/revisions`)).status).toBe(200); release(); const bundle = await exported; expect(bundle.status).toBe(201); stop.mockRestore();
    const download = await fetch(`${c.baseUrl}/v1/bundles/${bundle.body.bundlePath}`, { headers: { 'X-API-Key': c.keyA } }); expect(download.status).toBe(200); const bytes = Buffer.from(await download.arrayBuffer());
    expect((await service(f).transfer(input)).state).toBe('complete');
    for (const method of ['readManifest', 'openFile', 'inspectCandidate', 'prepare'] as const) spies.push(vi.spyOn(oldStore, method).mockRejectedValue(new Error('Retired backend reference must not be read')));
    const replay = await call(c, `/v1/workspaces/${w.id}/restore`, 'POST', body, c.keyA, key); expect(replay.status).toBe(202); expect(replay.body.id).toBe(completed.id); expect(replay.body.result).toEqual(completed.result);
    const same = await call(c, `/workspaces/${w.id}/export`, 'POST', {}, c.keyA, 'export-before-migration'); expect(same.status).toBe(201); expect(same.body).toEqual(bundle.body);
    const downloaded = await fetch(`${c.baseUrl}/v1/bundles/${same.body.bundlePath}`, { headers: { 'X-API-Key': c.keyA } }); expect(downloaded.status).toBe(200); expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally { release(); for (const spy of spies) spy.mockRestore(); await f.dispose(); }
}, 60000);

it('blocks cutover for an accepted restore intent until its owner resolves the operation', async () => {
  const f = await migrationFixture();
  try {
    const w = await workspace(f.client); const selected = await publish(f.client, w.id, { 'retained.txt': Buffer.from('selected') }); const head = await publish(f.client, w.id, { 'later.txt': Buffer.from('later') });
    const input = transferInput(f, w.id); const current = (await call(f.client, `/v1/workspaces/${w.id}`)).body;
    const claimed = await f.app.contextVault.restore.claim({ scope: input.scope, principal: input.principal, idempotencyKey: 'held-restore', request: { revisionId: selected, expectedRevisionId: head, expectedWorkspaceVersion: current.version, reason: 'owner must settle accepted restore' } });
    await expect(service(f).transfer(input)).rejects.toMatchObject({ code: 'FINALIZATION_IN_PROGRESS' });
    expect((await f.app.contextVault.control.getWorkspace(input.scope))!.currentRevisionId).toBe(head);
    const finished = await f.app.contextVault.restore.process({ scope: input.scope, operationId: claimed.operation.id, processingFence: claimed.operation.claim!.fence }); expect(finished.state).toBe('succeeded');
    await expect(service(f).transfer(input)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect((await service(f).transfer({ ...input, idempotencyKey: 'after-owner-settlement' })).state).toBe('complete');
  } finally { await f.dispose(); }
}, 60000);
