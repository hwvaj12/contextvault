import { expect, it } from 'vitest';
import { command, fixture, later, now, principal, scope } from './helpers';
import { retainedRevisionSetDigest } from '../../src/adapters/control/sqlite-control-store';

it('recovers a clone source and target selected before any private journal or target I/O', async () => {
  const f = await fixture();
  try {
    const revision = (await f.store.listRevisions(scope)).revisions[0]; const source: any = { kind: 'revision', revision, binding: f.intent.binding, principal };
    const target: any = { customerId: scope.customerId, workspaceId: 'copy-target', name: 'copy', principal, createIdempotencyKey: 'copy-creation-key', restoreIdempotencyKey: 'copy-publication-key' };
    const input: any = { scope, principal, authorization: await f.auth('workspace:read'), destinationAuthorization: await f.auth('workspace:create', { customerId: scope.customerId }), idempotencyKey: 'copy-command', request: { targetCustomerId: scope.customerId, name: 'copy' }, source, target, now };
    const pin = await f.store.claimCopySourcePin(input); expect(pin).toMatchObject({ state: 'held', source, target });
    // A new process has no journal and proposes a fresh random target. The original command owns its first selection.
    expect(await f.store.claimCopySourcePin({ ...input, target: { ...target, workspaceId: 'another-target' } })).toEqual(pin);
    const revisions = (await f.store.listRevisions(scope)).revisions; const cmd = command('storage:migrate');
    const binding: any = { ...f.intent.binding, id: 'next-binding', generation: 2 };
    const migration = await f.store.claimStorageMigration({ scope, principal, authorization: await f.auth('workspace:migrate'), command: cmd, migrationId: 'copy-blocked-migration' as any, expectedWorkspaceVersion: 1, expectedHeadRevisionId: revision.id, expectedSourceBindingGeneration: 1, retainedRevisionSetDigest: retainedRevisionSetDigest(revisions), targetBinding: binding, claim: { ownerId: 'migration', fence: 1, expiresAt: later }, now });
    const identity: any = { candidateId: 'blocked-copy', revisionId: revision.id, operationId: cmd.operationId, scope: { ...scope, storageBindingId: binding.id, bindingGeneration: 2 }, parentRevisionId: revision.parentRevisionId, createdAt: now };
    await expect(f.store.claimMigrationCandidate({ scope, principal, authorization: await f.auth('workspace:migrate'), migrationId: migration.id, expectedMigrationVersion: migration.version, migrationFence: 1, revisionId: revision.id, identity, now })).rejects.toMatchObject({ code: 'FINALIZATION_IN_PROGRESS' });
    await expect(f.store.claimCopySourcePin({ ...input, idempotencyKey: 'another-copy' })).rejects.toMatchObject({ code: 'FINALIZATION_IN_PROGRESS' });
    await expect(f.store.completeCopySourcePin({ scope, pinId: pin.id, operationId: cmd.operationId, now })).rejects.toMatchObject({ code: 'PUBLICATION_OUTCOME_UNKNOWN' });
    expect((await f.store.listCopySourcePins(scope))[0].state).toBe('held');
  } finally { f.db.close(); }
});
