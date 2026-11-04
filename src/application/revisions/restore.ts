import { canonicalJson, canonicalizeManifest, manifestDigest, verifyFileStream, WorkspaceError, type BundleRecord, type OperationId, type Principal, type RestoreIntent, type RestoreOperation, type RestoreRequest, type RestoreSource, type RevisionId, type WorkspaceLimits, type WorkspaceScope } from '../../domain';
import type { SnapshotSource } from '../../ports/streams';
import type { AuthenticatedCommand, LifecycleRuntime } from '../runs/runtime';
const terminal = new Set(['FORBIDDEN', 'CREDENTIAL_REVOKED', 'REVISION_CONFLICT', 'STORAGE_BINDING_CHANGED', 'WORKSPACE_INACTIVE', 'WORKSPACE_NOT_FOUND', 'REVISION_NOT_FOUND', 'INVALID_MANIFEST', 'QUOTA_EXCEEDED', 'RECEIPT_MISMATCH', 'INVALID_REQUEST']);
export class RestoreService {
  constructor(readonly runtime: LifecycleRuntime, readonly limits: WorkspaceLimits, readonly bundleSource: (bundle: BundleRecord) => Promise<SnapshotSource>) {}
  async claim(input: AuthenticatedCommand<RestoreRequest> & { scope: WorkspaceScope }) {
    await this.runtime.authorize(input.principal, 'workspace:restore', input.scope);
    const command = this.runtime.command('restore', input, input.scope); const previous = await this.runtime.control.findOperation(command.idempotencyScope, command.idempotencyKey);
    let source: RestoreSource;
    if (previous?.kind === 'restore') source = previous.intent.source;
    else {
      await this.runtime.authorize(input.principal, 'workspace:read', input.scope);
      let revision = await this.runtime.control.getRevision(input.scope, input.request.revisionId as RevisionId);
      if (!revision) { const alias = await this.runtime.control.getLegacyRevisionAlias(input.scope, input.request.revisionId); if (alias) revision = await this.runtime.control.getRevision(input.scope, alias.revisionId); }
      if (!revision) throw new WorkspaceError('REVISION_NOT_FOUND', 'Accepted restore source not found');
      const binding = await this.runtime.control.getBinding(input.scope, revision.scope.storageBindingId); if (!binding) throw new WorkspaceError('STORAGE_BINDING_CHANGED', 'Source binding is unavailable');
      source = { kind: 'revision', revision, binding, principal: input.principal };
    }
    return this.claimSource(input, source, 'workspace:restore');
  }
  async claimSource(input: AuthenticatedCommand<RestoreRequest> & { scope: WorkspaceScope }, source: RestoreSource, action: RestoreIntent['destinationAction']) {
    const authorization = await this.runtime.authorize(input.principal, action, action === 'workspace:create' ? { customerId: input.scope.customerId } : input.scope);
    const command = this.runtime.command('restore', input, input.scope); const previous = await this.runtime.control.findOperation(command.idempotencyScope, command.idempotencyKey);
    const workspace = await this.runtime.control.getWorkspace(input.scope); if (!workspace) throw new WorkspaceError('WORKSPACE_NOT_FOUND', 'Restore destination not found');
    const now = this.runtime.now();
    const intent: RestoreIntent = previous?.kind === 'restore' ? { ...previous.intent, destinationAction: action, request: { method: 'POST', path: `/v1/workspaces/${encodeURIComponent(input.scope.workspaceId)}/restore`, body: input.request } } : {
      schemaVersion: 1, kind: 'restore', request: { method: 'POST', path: `/v1/workspaces/${encodeURIComponent(input.scope.workspaceId)}/restore`, body: input.request }, source,
      sourceManifestDigest: source.kind === 'revision' ? source.revision.manifestDigest : source.bundle.manifestDigest!, destinationAction: action,
      candidateIdentity: { candidateId: this.runtime.id('candidate') as any, revisionId: this.runtime.id('revision') as any, operationId: command.operationId,
        scope: { ...input.scope, storageBindingId: workspace.storageBindingId, bindingGeneration: workspace.bindingGeneration }, parentRevisionId: input.request.expectedRevisionId as RevisionId, createdAt: now },
    };
    return this.runtime.control.claimRestore({ scope: input.scope, principal: input.principal, authorization, command, intent,
      claim: { ownerId: this.runtime.dependencies.ownerId, fence: 1, expiresAt: this.runtime.until(now, this.runtime.processingTtlMs) }, now });
  }
  private assert(operation: RestoreOperation, fence: number) {
    if (operation.state !== 'processing' || !operation.claim || operation.claim.ownerId !== this.runtime.dependencies.ownerId || operation.claim.fence !== fence || operation.claim.expiresAt <= this.runtime.now()) throw new WorkspaceError('STALE_FENCE', 'Restore requires the current processing claim', { operationId: operation.id });
  }
  private async source(operation: RestoreOperation): Promise<SnapshotSource> {
    const source = operation.intent.source;
    if (source.kind === 'bundle') return this.bundleSource(source.bundle);
    const { principal, revision, binding } = source;
    await this.runtime.authorize(principal, 'workspace:read', revision.scope);
    const retained = await this.runtime.control.getRevision(revision.scope, revision.id);
    if (!retained || canonicalJson(retained) !== canonicalJson(revision)) throw new WorkspaceError('STORAGE_BINDING_CHANGED', 'Restore source reference changed');
    const store = await this.runtime.dependencies.revisionStore(binding); const reference = { ...revision, revisionId: revision.id };
    const manifest = canonicalizeManifest(await store.readManifest(reference), this.limits);
    if (manifestDigest(manifest) !== operation.intent.sourceManifestDigest) throw new WorkspaceError('RECEIPT_MISMATCH', 'Restore source manifest differs from the durable intent');
    return { manifest, openFile: async (path, options) => {
      await this.runtime.authorize(principal, 'workspace:read', revision.scope);
      const entry = manifest.entries.find(e => e.path === path); if (!entry || entry.kind !== 'file') throw new WorkspaceError('REVISION_NOT_FOUND', 'Source file not found');
      const bytes = await store.openFile(reference, path, options);
      return (async function* (runtime: LifecycleRuntime, limits: WorkspaceLimits) { for await (const chunk of verifyFileStream(entry, bytes, limits)) { await runtime.authorize(principal, 'workspace:read', revision.scope); yield chunk; } })(this.runtime, this.limits);
    } };
  }
  async process(input: { scope: WorkspaceScope; operationId: OperationId; processingFence: number }): Promise<RestoreOperation> {
    let current = await this.runtime.control.getOperation(input.scope, input.operationId); if (!current || current.kind !== 'restore') throw new WorkspaceError('OPERATION_NOT_FOUND', 'Restore operation not found');
    if (current.state === 'succeeded' || current.state === 'failed') return current;
    this.assert(current, input.processingFence); let operation: RestoreOperation = current;
    const unknown = () => new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'Restore requires reconciliation using its durable operation', { operationId: input.operationId, retryable: true });
    try {
      const action = operation.intent.destinationAction; await this.runtime.authorize(operation.principal, action, action === 'workspace:create' ? { customerId: operation.scope.customerId } : operation.scope);
      let renewal = Promise.resolve(); let renewing = false; let renewalError: unknown; const controller = new AbortController();
      const timer = this.runtime.renewalIntervalMs ? setInterval(() => {
        if (renewing || renewalError) return; renewing = true;
        renewal = (async () => {
          try { const now = this.runtime.now(); operation = await this.runtime.control.renewProcessingClaim({ scope: operation.scope, operationId: operation.id, expectedOperationVersion: operation.version, processingFence: input.processingFence, now, expiresAt: new Date(Math.max(Date.parse(this.runtime.until(now, this.runtime.processingTtlMs)), Date.parse(operation.claim!.expiresAt) + 1)).toISOString() }) as RestoreOperation; }
          catch (error) { renewalError = error; controller.abort(error); } finally { renewing = false; }
        })();
      }, this.runtime.renewalIntervalMs) : undefined; timer?.unref();
      let candidate;
      try {
        await this.runtime.dependencies.hook?.('before-prepare', operation);
        const source = await this.source(operation); const identity = operation.intent.candidateIdentity;
        if (manifestDigest(source.manifest) !== operation.intent.sourceManifestDigest) throw new WorkspaceError('RECEIPT_MISMATCH', 'Copy source changed');
        const binding = await this.runtime.control.getBinding(operation.scope, identity.scope.storageBindingId);
        if (!binding || binding.generation !== identity.scope.bindingGeneration) throw new WorkspaceError('STORAGE_BINDING_CHANGED', 'Restore destination binding is unavailable');
        const store = await this.runtime.dependencies.revisionStore(binding);
        candidate = await store.inspectCandidate(identity) ?? await store.prepare({ identity, source, signal: controller.signal });
        await this.runtime.dependencies.hook?.('after-prepare', operation);
      } finally { if (timer) clearInterval(timer); await renewal; }
      if (renewalError) throw renewalError;
      operation = await this.runtime.control.recordPreparedRevision({ scope: operation.scope, operationId: operation.id, expectedOperationVersion: operation.version, processingFence: input.processingFence, now: this.runtime.now(), candidate }) as RestoreOperation;
      await this.runtime.dependencies.hook?.('after-record-prepared', operation); await this.runtime.dependencies.hook?.('before-accept', operation);
      const authorization = await this.runtime.authorize(operation.principal, action, action === 'workspace:create' ? { customerId: operation.scope.customerId } : operation.scope);
      const now = this.runtime.now(); const accepted = await this.runtime.control.acceptRestore({ scope: operation.scope, operationId: operation.id, expectedOperationVersion: operation.version, processingFence: input.processingFence, now, authorization, candidate, events: this.runtime.events(operation, 'workspace.restored', now) });
      await this.runtime.dependencies.hook?.('after-accept', accepted); return accepted;
    } catch (error) {
      try { current = await this.runtime.control.getOperation(input.scope, input.operationId); } catch { throw unknown(); }
      if (!current || current.kind !== 'restore') throw unknown();
      if (current.state === 'succeeded' || current.state === 'failed') return current;
      this.assert(current, input.processingFence);
      if (!(error instanceof WorkspaceError) || !terminal.has(error.code)) { if (error instanceof WorkspaceError && ['STALE_FENCE', 'VERSION_CONFLICT'].includes(error.code)) throw error; throw unknown(); }
      try { return await this.runtime.control.failRestore({ scope: current.scope, operationId: current.id, expectedOperationVersion: current.version, processingFence: input.processingFence, now: this.runtime.now(), code: error.code, message: error.message, events: this.runtime.events(current, 'workspace.restore-failed') }); }
      catch { const settled = await this.runtime.control.getOperation(input.scope, input.operationId).catch(() => null); if (settled?.kind === 'restore' && ['succeeded', 'failed'].includes(settled.state)) return settled; throw unknown(); }
    }
  }
}
