import { isAbsolute, join, resolve } from 'node:path';
import { canonicalJson, canonicalizeManifest, manifestDigest, retainedRevisionSetDigest, verifiedCopySetDigest, verifyFileStream, WorkspaceError, type CandidateIdentity, type Principal, type Revision, type StorageBinding, type StorageMigration, type StorageMigrationRequest, type WorkspaceScope } from '../../domain';
import type { WorkspaceRuntime } from '../../config/runtime';
import type { SnapshotSource } from '../../ports/streams';
import type { RevisionStore } from '../../ports/revision-store';
import { archiveRevision, archiveSecrets, proofDigest, saveImmutableJson, verifyMigrationBackup, type BackupReceipt } from './archive';

export interface TransferInput { scope: WorkspaceScope; principal: Principal; idempotencyKey: string; request: StorageMigrationRequest }
export type MigrationHook = (stage: 'claimed' | 'backup-ready' | 'candidate-owned' | 'candidate-prepared' | 'copy-verified' | 'before-switch' | 'after-switch', migration: StorageMigration) => Promise<void>;
const terminal = new Set(['FORBIDDEN', 'CREDENTIAL_REVOKED', 'REVISION_CONFLICT', 'STORAGE_BINDING_CHANGED', 'WORKSPACE_INACTIVE', 'WORKSPACE_NOT_FOUND', 'REVISION_NOT_FOUND', 'INVALID_MANIFEST', 'QUOTA_EXCEEDED', 'RECEIPT_MISMATCH', 'INVALID_REQUEST']);

/** Explicit operator use case. Configuration selects available stores; only catalog cutover selects authority. */
export class StorageMigrationService {
  constructor(readonly runtime: WorkspaceRuntime, readonly hook?: MigrationHook) {}
  private get rt() { return this.runtime.lifecycle.runtime; }
  private async revisions(scope: WorkspaceScope) {
    const revisions: Revision[] = []; let cursor: string | undefined;
    do { const page = await this.runtime.control.listRevisions(scope, cursor, 1000); revisions.push(...page.revisions); cursor = page.nextCursor ?? undefined; } while (cursor);
    return revisions;
  }
  private async source(principal: Principal, revision: Revision): Promise<SnapshotSource> {
    await this.rt.authorize(principal, 'workspace:read', revision.scope);
    const binding = await this.runtime.control.getBinding(revision.scope, revision.scope.storageBindingId);
    if (!binding || binding.generation !== revision.scope.bindingGeneration) throw new WorkspaceError('STORAGE_BINDING_CHANGED', 'Retained source binding is unavailable');
    const store = await this.runtime.revisionStore(binding); const reference = { ...revision, revisionId: revision.id };
    const manifest = canonicalizeManifest(await store.readManifest(reference), this.runtime.configuration.limits);
    if (manifestDigest(manifest) !== revision.manifestDigest) throw new WorkspaceError('RECEIPT_MISMATCH', 'Retained source manifest differs from its catalog digest');
    const rt = this.rt; const limits = this.runtime.configuration.limits;
    return { manifest, openFile: async (path, options) => {
      await rt.authorize(principal, 'workspace:read', revision.scope); const entry = manifest.entries.find(entry => entry.path === path && entry.kind === 'file');
      if (!entry || entry.kind !== 'file') throw new WorkspaceError('REVISION_NOT_FOUND', 'Selected retained file is unavailable');
      const bytes = await store.openFile(reference, path, options);
      return (async function* () { for await (const chunk of verifyFileStream(entry, bytes, limits)) { options?.signal?.throwIfAborted(); await rt.authorize(principal, 'workspace:read', revision.scope); yield chunk; } })();
    } };
  }
  async inspect(input: TransferInput) {
    await this.rt.authorize(input.principal, 'workspace:migrate', input.scope);
    const workspace = await this.runtime.control.getWorkspace(input.scope); if (!workspace) throw new WorkspaceError('WORKSPACE_NOT_FOUND', 'Workspace not found');
    const revisions = await this.revisions(input.scope);
    for (const revision of revisions) { const source = await this.source(input.principal, revision); for (const entry of source.manifest.entries) if (entry.kind === 'file') for await (const _bytes of await source.openFile(entry.path)) { /* Inventory verifies every retained file, never only HEAD. */ } }
    return { workspace, revisions, retainedRevisionSetDigest: retainedRevisionSetDigest(revisions) };
  }
  private async verifyTarget(store: RevisionStore, candidate: NonNullable<StorageMigration['copies'][number]>['target'], source: SnapshotSource, signal?: AbortSignal) {
    const reference = { scope: candidate.scope, revisionId: candidate.revisionId, manifestDigest: candidate.manifestDigest, privateReference: candidate.privateReference };
    const manifest = canonicalizeManifest(await store.readManifest(reference), this.runtime.configuration.limits);
    if (canonicalJson(manifest) !== canonicalJson(source.manifest) || manifestDigest(manifest) !== candidate.manifestDigest) throw new WorkspaceError('RECEIPT_MISMATCH', 'Target manifest differs from the complete selected source');
    for (const entry of manifest.entries) if (entry.kind === 'file') for await (const _bytes of verifyFileStream(entry, await store.openFile(reference, entry.path, { signal }), this.runtime.configuration.limits)) signal?.throwIfAborted();
  }
  private async io<T>(context: { migration: StorageMigration }, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(); let renewing = false; let renewal = Promise.resolve(); let error: unknown;
    const timer = this.rt.renewalIntervalMs ? setInterval(() => {
      if (renewing || error) return; renewing = true;
      renewal = (async () => { try {
        const migration = context.migration; const now = this.rt.now();
        context.migration = await this.runtime.control.renewStorageMigrationClaim({ scope: migration.scope, migrationId: migration.id, expectedMigrationVersion: migration.version, migrationFence: migration.claim.fence, now, expiresAt: new Date(Math.max(Date.parse(this.rt.until(now, this.rt.processingTtlMs)), Date.parse(migration.claim.expiresAt) + 1)).toISOString() });
      } catch (caught) { error = caught; controller.abort(caught); } finally { renewing = false; } })();
    }, this.rt.renewalIntervalMs) : undefined; timer?.unref();
    try { const value = await action(controller.signal); if (error) throw error; return value; }
    finally { if (timer) clearInterval(timer); await renewal; if (error) throw error; }
  }
  private cas(migration: StorageMigration) { return { scope: migration.scope, migrationId: migration.id, expectedMigrationVersion: migration.version, migrationFence: migration.claim.fence, now: this.rt.now() }; }
  private summary(migration: StorageMigration) {
    return { migrationId: migration.id, state: migration.state, backend: migration.targetBinding.backend, currentRevisionId: migration.expectedHeadRevisionId, revisions: migration.copies.length, bindingId: migration.targetBinding.id, generation: migration.targetBinding.generation, backupDirectory: migration.backup?.directory ?? null };
  }
  async transfer(input: TransferInput) {
    input = structuredClone(input);
    if (!input.request.reason?.trim() || input.request.reason.length > 4096 || !isAbsolute(input.request.backupRoot)) throw new WorkspaceError('INVALID_REQUEST', 'Transfer requires a reason and an explicit absolute backup root');
    input.request.backupRoot = resolve(input.request.backupRoot);
    const authorization = await this.rt.authorize(input.principal, 'workspace:migrate', input.scope);
    const command = this.rt.command('storage:migrate', input, input.scope);
    const migrationId = `migration-${proofDigest([command.idempotencyScope, input.idempotencyKey])}` as StorageMigration['id'];
    const previous = await this.runtime.control.getStorageMigration(input.scope, migrationId);
    let workspace = await this.runtime.control.getWorkspace(input.scope); if (!workspace) throw new WorkspaceError('WORKSPACE_NOT_FOUND', 'Workspace not found');
    let revisions: Revision[]; let target: StorageBinding;
    if (previous) { revisions = await this.revisions(input.scope); target = previous.targetBinding; }
    else {
      const inventory = await this.inspect(input); workspace = inventory.workspace; revisions = inventory.revisions;
      const profile = this.runtime.configuration.profiles.find(profile => profile.configurationRef === input.request.targetConfigurationRef);
      if (!profile) throw new WorkspaceError('INVALID_REQUEST', 'Target must be an explicitly configured retained profile');
      const source = await this.runtime.control.getBinding(input.scope, workspace.storageBindingId);
      if (!source || source.configurationRef === profile.configurationRef) throw new WorkspaceError('INVALID_REQUEST', 'Target profile must differ from the current source profile');
      target = { id: this.rt.id('binding') as StorageBinding['id'], scope: input.scope, backend: profile.backend, generation: workspace.bindingGeneration + 1, location: { storeId: profile.storeId, opaqueKey: input.scope.workspaceId }, configurationRef: profile.configurationRef, status: 'active', createdAt: this.rt.now() };
    }
    const now = this.rt.now();
    let migration = await this.runtime.control.claimStorageMigration({ scope: input.scope, principal: input.principal, authorization, command, migrationId,
      expectedWorkspaceVersion: workspace.version, expectedHeadRevisionId: workspace.currentRevisionId, expectedSourceBindingGeneration: workspace.bindingGeneration,
      retainedRevisionSetDigest: previous?.retainedRevisionSetDigest ?? retainedRevisionSetDigest(revisions), targetBinding: target, request: input.request,
      claim: { ownerId: this.runtime.ownerId, fence: 1, expiresAt: this.rt.until(now, this.rt.processingTtlMs) }, now });
    if (migration.state === 'complete') return this.summary(migration);
    if (migration.state === 'failed') throw new WorkspaceError('INVALID_TRANSITION', migration.lastError ?? 'Migration has a recorded terminal failure');
    if (migration.claim.ownerId !== this.runtime.ownerId || migration.claim.expiresAt <= this.rt.now()) {
      if (migration.claim.expiresAt > this.rt.now()) throw new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'The original migration controller still owns its processing claim', { operationId: migration.command.operationId, retryable: true });
      migration = await this.runtime.control.claimStorageMigrationRecovery({ scope: migration.scope, migrationId: migration.id, expectedMigrationVersion: migration.version, ownerId: this.runtime.ownerId, now: this.rt.now(), expiresAt: this.rt.until(this.rt.now(), this.rt.processingTtlMs) });
    }
    const context = { migration };
    try {
      await this.hook?.('claimed', context.migration);
      if (retainedRevisionSetDigest(revisions) !== context.migration.retainedRevisionSetDigest || workspace.currentRevisionId !== context.migration.expectedHeadRevisionId || workspace.storageBindingId !== context.migration.sourceBindingId) throw new WorkspaceError('REVISION_CONFLICT', 'Accepted history changed after the migration claim');
      const backupDirectory = join(input.request.backupRoot, proofDigest(input.scope), context.migration.id);
      context.migration = await this.runtime.control.claimMigrationBackup({ ...this.cas(context.migration), directory: backupDirectory });
      if (context.migration.backup?.state !== 'ready') {
        const catalog = await this.io(context, () => this.runtime.control.captureMigrationCatalog(this.cas(context.migration)));
        const manifests: BackupReceipt['manifests'][number][] = [];
        for (const revision of revisions) await this.io(context, async signal => { const source = await this.source(input.principal, revision); await archiveRevision(backupDirectory, revision, source, this.runtime.configuration.limits, signal); manifests.push({ revisionId: revision.id, manifest: source.manifest }); });
        const secrets = await this.io(context, () => archiveSecrets(backupDirectory, this.runtime.configuration.legacySecretsPath, this.runtime.configuration.limits));
        const receipt: BackupReceipt = { schemaVersion: 1, workspace, revisions, manifests, catalogSha256: catalog.sha256, secrets };
        await saveImmutableJson(backupDirectory, 'receipt.json', receipt);
        context.migration = await this.runtime.control.completeMigrationBackup({ ...this.cas(context.migration), receiptDigest: proofDigest(receipt) });
      }
      await this.io(context, async signal => { const catalog = await this.runtime.control.captureMigrationCatalog(this.cas(context.migration)); await verifyMigrationBackup(context.migration, workspace, revisions, catalog.sha256, this.runtime.configuration.limits, signal); });
      await this.hook?.('backup-ready', context.migration);
      const targetStore = await this.runtime.revisionStore(context.migration.targetBinding);
      for (const revision of revisions) {
        if (context.migration.copies.some(copy => copy.revisionId === revision.id)) continue;
        const selected = context.migration.candidates?.find(candidate => candidate.revisionId === revision.id);
        const identity: CandidateIdentity = selected?.identity ?? { candidateId: this.rt.id('candidate') as CandidateIdentity['candidateId'], revisionId: revision.id, operationId: context.migration.command.operationId, scope: { ...input.scope, storageBindingId: context.migration.targetBinding.id, bindingGeneration: context.migration.targetBinding.generation }, parentRevisionId: revision.parentRevisionId, createdAt: this.rt.now() };
        context.migration = await this.runtime.control.claimMigrationCandidate({ ...this.cas(context.migration), principal: input.principal, authorization: await this.rt.authorize(input.principal, 'workspace:migrate', input.scope), revisionId: revision.id, identity });
        await this.hook?.('candidate-owned', context.migration);
        const source = await this.source(input.principal, revision);
        const candidate = await this.io(context, async signal => {
          const prepared = await targetStore.inspectCandidate(identity) ?? await targetStore.prepare({ identity, source, signal });
          await this.verifyTarget(targetStore, prepared, source, signal); return prepared;
        });
        await this.hook?.('candidate-prepared', context.migration);
        context.migration = await this.runtime.control.recordVerifiedRevisionCopy({ ...this.cas(context.migration), copy: { revisionId: revision.id, sourceManifestDigest: revision.manifestDigest, target: candidate, verifiedAt: this.rt.now() } });
        await this.hook?.('copy-verified', context.migration);
      }
      // Recheck every checkpoint's physical contents before selecting the atomic cutover.
      for (const copy of context.migration.copies) await this.io(context, async signal => {
        const source = await this.source(input.principal, revisions.find(revision => revision.id === copy.revisionId)!); await this.verifyTarget(targetStore, copy.target, source, signal);
      });
      await this.hook?.('before-switch', context.migration);
      await this.io(context, async signal => { const catalog = await this.runtime.control.captureMigrationCatalog(this.cas(context.migration)); await verifyMigrationBackup(context.migration, workspace, revisions, catalog.sha256, this.runtime.configuration.limits, signal); });
      const result = await this.runtime.control.switchStorageBinding({ ...this.cas(context.migration), principal: input.principal, authorization: await this.rt.authorize(input.principal, 'workspace:migrate', input.scope),
        expectedWorkspaceVersion: workspace.version, expectedHeadRevisionId: context.migration.expectedHeadRevisionId, expectedSourceBindingGeneration: context.migration.sourceBindingGeneration,
        expectedRetainedRevisionSetDigest: context.migration.retainedRevisionSetDigest, expectedVerifiedCopySetDigest: verifiedCopySetDigest(context.migration.copies),
        events: this.rt.events({ id: context.migration.command.operationId, scope: input.scope, runId: null, principal: input.principal }, 'workspace.storage-migrated') });
      context.migration = (await this.runtime.control.getStorageMigration(input.scope, context.migration.id))!;
      if (result.operation.state !== 'succeeded' || context.migration.state !== 'complete') throw new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'Migration acceptance requires reconciliation', { operationId: result.operation.id, retryable: true });
      await this.hook?.('after-switch', context.migration); return this.summary(context.migration);
    } catch (error) {
      const current = await this.runtime.control.getStorageMigration(input.scope, context.migration.id).catch(() => null);
      if (current?.state === 'complete') return this.summary(current);
      if (current) context.migration = current;
      if (current && error instanceof WorkspaceError && terminal.has(error.code) && current.claim.ownerId === this.runtime.ownerId) {
        context.migration = await this.runtime.control.failStorageMigration({ ...this.cas(current), message: error.message }); throw error;
      }
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'Migration storage work requires reconciliation with its original command', { operationId: context.migration.command.operationId, retryable: true });
    } finally {
      const current = await this.runtime.control.getStorageMigration(input.scope, context.migration.id).catch(() => null);
      if (current && !['complete', 'failed'].includes(current.state) && current.claim.ownerId === this.runtime.ownerId && current.claim.expiresAt > this.rt.now()) await this.runtime.control.releaseStorageMigrationClaim({ ...this.cas(current), ownerId: this.runtime.ownerId }).catch(() => { /* A live writer or expired claim must retain conservative ownership. */ });
    }
  }
}
