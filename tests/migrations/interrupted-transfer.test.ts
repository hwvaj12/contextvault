import { expect, it } from 'vitest';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { call, migrationFixture, publish, workspace } from './helpers';
import { pauseTransfer, resumeTransfer, service, waitClaim } from './process-helpers';

it('survives actual SIGKILL after preparation and resumes the original candidate under a new fence', async () => {
  const f = await migrationFixture();
  try {
    const w = await workspace(f.client); const head = await publish(f.client, w.id, { 'binary.bin': Buffer.from([0, 255, 17]) });
    const paused = await pauseTransfer(f, w.id, 'candidate-prepared'); const before = paused.migration;
    expect(before.candidates).toHaveLength(1); expect(before.copies).toHaveLength(0);
    expect(await paused.kill()).toEqual({ code: null, signal: 'SIGKILL' });
    const durable = await f.app.contextVault.control.getStorageMigration(paused.input.scope, before.id); expect(durable).toEqual(before);
    expect((await call(f.client, `/v1/workspaces/${w.id}`)).body.currentRevisionId).toBe(head);
    await waitClaim(before); const result = await resumeTransfer(f, paused.input); expect(result.state).toBe('complete');
    const after = (await f.app.contextVault.control.getStorageMigration(paused.input.scope, before.id))!;
    expect(after.claim.fence).toBe(before.claim.fence + 1); expect(after.candidates![0]).toEqual(before.candidates[0]); expect(after.copies[0].target.candidateId).toBe(before.candidates[0].identity.candidateId);
    await expect(f.app.contextVault.control.recordVerifiedRevisionCopy({ scope: paused.input.scope, migrationId: before.id, expectedMigrationVersion: before.version, migrationFence: before.claim.fence, now: f.app.contextVault.now(), copy: after.copies[0] })).rejects.toMatchObject({ code: 'STALE_FENCE' });
    const file = await fetch(`${f.client.baseUrl}/v1/workspaces/${w.id}/revisions/${head}/files?path=binary.bin`, { headers: { 'X-API-Key': f.client.keyA } }); expect(file.status).toBe(200); expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from([0, 255, 17]));
    expect((await service(f).transfer(paused.input)).bindingId).toBe(after.targetBinding.id); expect((await f.app.contextVault.control.getWorkspace(paused.input.scope))!.bindingGeneration).toBe(2);
  } finally { await f.dispose(); }
}, 60000);

it('recovers a catalog backup after SIGKILL between exclusive linking and temporary-link cleanup', async () => {
  const f = await migrationFixture();
  try {
    const w = await workspace(f.client); const paused = await pauseTransfer(f, w.id, 'backup-linked', 'kill-backup-link'); const path = join(paused.migration.backup.directory, 'catalog.sqlite');
    expect((await stat(path)).nlink).toBe(2); expect(await paused.kill()).toEqual({ code: null, signal: 'SIGKILL' }); await waitClaim(paused.migration);
    expect((await resumeTransfer(f, paused.input)).state).toBe('complete'); expect((await stat(path)).nlink).toBe(1);
  } finally { await f.dispose(); }
}, 60000);

it('replays the committed result after actual SIGKILL loses the cutover acknowledgement', async () => {
  const f = await migrationFixture();
  try {
    const w = await workspace(f.client); const paused = await pauseTransfer(f, w.id, 'after-switch', 'lost-ack'); expect(paused.migration.state).toBe('complete');
    expect(await paused.kill()).toEqual({ code: null, signal: 'SIGKILL' });
    expect(await service(f).transfer(paused.input)).toMatchObject({ state: 'complete', bindingId: paused.migration.targetBinding.id, generation: 2 });
    expect((await f.app.contextVault.control.getWorkspace(paused.input.scope))!.bindingGeneration).toBe(2);
  } finally { await f.dispose(); }
}, 60000);

it('resumes after SIGKILL inside a tracked copy without treating lease expiry as stopped-writer proof', async () => {
  const f = await migrationFixture();
  try {
    const w = await workspace(f.client); const head = await publish(f.client, w.id, { 'copy.bin': Buffer.from([255, 0, 19]) });
    const paused = await pauseTransfer(f, w.id, 'writer-open', 'kill-during-copy'); const before = paused.migration; const selected = before.candidates.find((value: any) => value.revisionId === head);
    expect(selected).toBeDefined();
    const active = () => f.app.contextVault.database.prepare("SELECT data FROM catalog_records WHERE kind='candidate-writer' AND json_extract(data,'$.identity.candidateId')=? AND json_extract(data,'$.state')='active'").all(selected.identity.candidateId);
    const originalWriters = active(); expect(originalWriters).toHaveLength(1); expect(await paused.kill()).toEqual({ code: null, signal: 'SIGKILL' });
    await waitClaim(before); expect(active()).toEqual(originalWriters);
    expect(await resumeTransfer(f, paused.input)).toMatchObject({ state: 'complete', currentRevisionId: head });
    const after = (await f.app.contextVault.control.getStorageMigration(paused.input.scope, before.id))!;
    const recovered = after.candidates!.filter(value => value.revisionId === selected.revisionId);
    expect(after.claim.fence).toBe(before.claim.fence + 1); expect(recovered).toHaveLength(1); expect(recovered[0].identity.candidateId).toBe(selected.identity.candidateId); expect(recovered[0]).toEqual(selected); expect(active()).toEqual(originalWriters);
    const copy = after.copies.find(value => value.revisionId === selected.identity.revisionId)!;
    expect(copy.target.candidateId).toBe(selected.identity.candidateId);
    await expect(f.app.contextVault.control.claimCandidateCollection({ scope: copy.target.scope, candidateId: copy.target.candidateId, now: f.app.contextVault.now(), expiresAt: new Date(Date.now() + 10000).toISOString() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const file = await fetch(`${f.client.baseUrl}/v1/workspaces/${w.id}/revisions/${head}/files?path=copy.bin`, { headers: { 'X-API-Key': f.client.keyA } }); expect(file.status).toBe(200); expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from([255, 0, 19]));
  } finally { await f.dispose(); }
}, 60000);
