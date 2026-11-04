import { expect, it } from 'vitest';
import { command, fixture, later, now, principal, scope } from './helpers';
import { retainedRevisionSetDigest } from '../../src/adapters/control/sqlite-control-store';

it('persists the exact migration candidate before the target adapter may start writing', async () => {
  const f = await fixture();
  try {
    const revisions = (await f.store.listRevisions(scope)).revisions; const cmd = command('storage:migrate');
    const target: any = { ...f.intent.binding, id: 'migration-target', generation: 2, backend: 's3', location: { storeId: 's3', opaqueKey: scope.workspaceId } };
    const reader = await f.open('read-only');
    let migration = await f.store.claimStorageMigration({ scope, principal, authorization: await f.auth('workspace:migrate'), command: cmd, migrationId: 'owned-copy' as any, expectedWorkspaceVersion: 1, expectedHeadRevisionId: revisions[0].id, expectedSourceBindingGeneration: 1, retainedRevisionSetDigest: retainedRevisionSetDigest(revisions), targetBinding: target, claim: { ownerId: 'copy-worker', fence: 1, expiresAt: later }, now });
    const identity: any = { candidateId: 'owned-target-candidate', revisionId: revisions[0].id, operationId: cmd.operationId, scope: { ...scope, storageBindingId: target.id, bindingGeneration: 2 }, parentRevisionId: revisions[0].parentRevisionId, createdAt: now };
    await expect(f.store.beginCandidateWrite({ identity, writerId: 'premature', ownerId: 'copy-worker', now })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const claim = { scope, principal, authorization: await f.auth('workspace:migrate'), migrationId: migration.id, expectedMigrationVersion: migration.version, migrationFence: 1, revisionId: revisions[0].id, identity, now };
    await expect(f.store.claimMigrationCandidate(claim)).rejects.toMatchObject({ code: 'FINALIZATION_IN_PROGRESS' });
    const abort = command('abort', { expectedRunVersion: reader.version, reason: 'owner settled pinned reader' }, reader.id);
    await f.store.abortRun({ scope: { ...reader.scope, runId: reader.id }, principal, authorization: await f.auth('run:abort'), command: abort, expectedRunVersion: reader.version, reason: 'owner settled pinned reader', events: (await import('./helpers')).events(abort.operationId, reader.id), now });
    await expect(f.store.claimMigrationCandidate(claim)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    migration = await f.store.claimMigrationBackup({ scope, migrationId: migration.id, expectedMigrationVersion: migration.version, migrationFence: 1, directory: '/private/tmp/synthetic-control-backup', now });
    migration = await f.store.completeMigrationBackup({ scope, migrationId: migration.id, expectedMigrationVersion: migration.version, migrationFence: 1, receiptDigest: 'b'.repeat(64), now });
    migration = await f.store.claimMigrationCandidate({ ...claim, expectedMigrationVersion: migration.version });
    expect(migration.candidates).toEqual([{ revisionId: revisions[0].id, source: revisions[0], identity }]);
    const writer = await f.store.beginCandidateWrite({ identity, writerId: 'owned-write', ownerId: 'copy-worker', now }); expect(writer.state).toBe('active');
    await expect(f.store.claimCandidateCollection({ scope: identity.scope, candidateId: identity.candidateId, now, expiresAt: later })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await f.store.finishCandidateWrite({ identity, writerId: writer.id, now });
    await expect(f.store.claimMigrationCandidate({ scope, principal, authorization: await f.auth('workspace:migrate'), migrationId: migration.id, expectedMigrationVersion: migration.version, migrationFence: 1, revisionId: revisions[0].id, identity: { ...identity, candidateId: 'replacement' }, now })).rejects.toMatchObject({ code: 'RECEIPT_MISMATCH' });
  } finally { f.db.close(); }
});
