import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { StorageMigrationService } from '../../src/application/migrations/storage';
import { call, migrationFixture, publish, workspace } from './helpers';
import { service, transferInput } from './process-helpers';

it('drains existing readers, fences new run admission and retains ordinary history reads before explicit settlement', async () => {
  const f = await migrationFixture();
  try {
    const c = f.client; const w = await workspace(c); const head = await publish(c, w.id, { 'context.txt': Buffer.from('accepted source') });
    const opened = await call(c, `/v1/workspaces/${w.id}/runs`, 'POST', { mode: 'read-only', agentLabel: 'existing agent', task: 'read context', reason: 'verify explicit settlement' }, c.keyA, randomUUID()); expect(opened.status).toBe(201);
    const input = transferInput(f, w.id); const before = await f.app.contextVault.control.getWorkspace(input.scope);
    await expect(service(f).transfer(input)).rejects.toMatchObject({ code: 'FINALIZATION_IN_PROGRESS' });
    expect(await f.app.contextVault.control.getWorkspace(input.scope)).toEqual(before);
    const denied = await call(c, `/v1/workspaces/${w.id}/runs`, 'POST', { mode: 'read-only', agentLabel: 'late agent', task: 'new read', reason: 'must wait for cutover' }, c.keyA, randomUUID()); expect(denied.status).toBe(409); expect(denied.body.error.code).toBe('FINALIZATION_IN_PROGRESS');
    expect((await call(c, `/v1/runs/${opened.body.id}`)).body.state).toBe('active');
    const file = await fetch(`${c.baseUrl}/v1/workspaces/${w.id}/revisions/${head}/files?path=context.txt`, { headers: { 'X-API-Key': c.keyA } }); expect(file.status).toBe(200); expect(await file.text()).toBe('accepted source');
    expect((await call(c, `/v1/workspaces/${w.id}/revisions`)).status).toBe(200);
    expect((await call(c, `/v1/runs/${opened.body.id}/abort`, 'POST', { expectedRunVersion: opened.body.version, reason: 'owner explicitly settled the reader' }, c.keyA, randomUUID())).status).toBe(200);
    const result = await service(f).transfer(input); expect(result.state).toBe('complete');
    expect((await call(c, `/v1/workspaces/${w.id}/runs`, 'POST', { mode: 'read-only', agentLabel: 'new agent', task: 'read after cutover', reason: 'admission reopens' }, c.keyA, randomUUID())).status).toBe(201);
  } finally { await f.dispose(); }
}, 60000);

it('rejects damaged ready backups before cutover and preserves the original accepted authority', async () => {
  const f = await migrationFixture();
  try {
    const w = await workspace(f.client); const input = transferInput(f, w.id); const before = await f.app.contextVault.control.getWorkspace(input.scope);
    let directory = '';
    const transfer = new StorageMigrationService(f.app.contextVault, async (stage, migration) => {
      if (stage !== 'before-switch') return; directory = migration.backup!.directory;
      expect((await stat(join(directory, 'catalog.sqlite'))).mode & 0o777).toBe(0o600);
      const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8')); expect(receipt.revisions).toHaveLength(1);
      await writeFile(join(directory, 'legacy-secrets.json'), 'damaged backup');
    });
    await expect(transfer.transfer(input)).rejects.toMatchObject({ code: 'RECEIPT_MISMATCH' });
    expect(await f.app.contextVault.control.getWorkspace(input.scope)).toEqual(before); expect((await call(f.client, `/v1/workspaces/${w.id}`)).status).toBe(200);
    expect(await readFile(join(directory, 'legacy-secrets.json'), 'utf8')).toBe('damaged backup');
  } finally { await f.dispose(); }
}, 60000);

it('rechecks current permission after verified copying and rejects revoked publication', async () => {
  const f = await migrationFixture();
  try {
    const w = await workspace(f.client); const input = transferInput(f, w.id); const before = await f.app.contextVault.control.getWorkspace(input.scope);
    const transfer = new StorageMigrationService(f.app.contextVault, async stage => { if (stage === 'before-switch') expect((await fetch(`${f.client.baseUrl}/api-keys/${f.keys[0].id}`, { method: 'DELETE', headers: { 'X-API-Key': f.master } })).status).toBe(204); });
    await expect(transfer.transfer(input)).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' });
    expect(await f.app.contextVault.control.getWorkspace(input.scope)).toEqual(before);
  } finally { await f.dispose(); }
}, 60000);
