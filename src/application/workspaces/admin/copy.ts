import { canonicalJson, manifestDigest, WorkspaceError, type CustomerId, type Principal, type RestoreSource, type Workspace, type WorkspaceCreationIntent, type WorkspaceScope } from '../../../domain';
import type { WorkspaceRuntime } from '../../../config/runtime';
import { hash, journalPath, loadJournal, saveJournal, serialize } from '../../../compat/journal';
import { principalForVerifiedAdministrator } from '../../../middleware/catalog-identity';
import { legacyWorkspace } from './metadata';

interface CopyJournal { request: unknown; source: RestoreSource; destinationPrincipal: Principal; destinationCustomerId: CustomerId; workspaceId: Workspace['id']; creation: Workspace | null; operationId: string | null; completed: Workspace | null }
export async function destinationPrincipal(runtime: WorkspaceRuntime, principal: Principal, sourceScope: WorkspaceScope | { customerId: CustomerId }, targetCustomerId: string) {
  // Current source-side authority is checked before deriving another scoped administrator identity.
  await runtime.lifecycle.runtime.authorize(principal, 'workspaceId' in sourceScope ? 'workspace:read' : 'workspace:create', sourceScope);
  if (principal.kind !== 'administrator') {
    if (principal.customerId !== targetCustomerId) throw new WorkspaceError('FORBIDDEN', 'Customer credentials cannot create another customer workspace');
    await runtime.lifecycle.runtime.authorize(principal, 'workspace:create', { customerId: principal.customerId }); return principal;
  }
  if (!runtime.configuration.masterKey) throw new WorkspaceError('CREDENTIAL_REVOKED', 'Configured administrator trust root is unavailable');
  const target = principalForVerifiedAdministrator(runtime.database, runtime.configuration.masterKey, targetCustomerId, runtime.now());
  if (target.actorId !== principal.actorId) throw new WorkspaceError('FORBIDDEN', 'Administrator actor changed');
  await runtime.lifecycle.runtime.authorize(target, 'workspace:create', { customerId: targetCustomerId as CustomerId }); return target;
}
async function authorizeSource(runtime: WorkspaceRuntime, source: RestoreSource, principal: Principal) {
  if (source.kind === 'revision') await runtime.lifecycle.runtime.authorize(source.principal, 'workspace:read', source.revision.scope);
  else await runtime.bundles.get({ customerId: source.bundle.customerId }, principal, source.bundle.id);
}
async function createTarget(runtime: WorkspaceRuntime, principal: Principal, customerId: CustomerId, id: Workspace['id'], name: string, key: string) {
  if (!name.trim() || name.length > 255) throw new WorkspaceError('INVALID_REQUEST', 'Workspace name is invalid');
  const rt = runtime.lifecycle.runtime; const customer = { customerId }; const request = { customerId, name }; const authorization = await rt.authorize(principal, 'workspace:create', customer);
  const command = rt.command('workspace:create', { principal, idempotencyKey: key, request }, customer); const previous = await rt.control.findOperation(command.idempotencyScope, key); let intent: WorkspaceCreationIntent;
  if (previous?.kind === 'workspace:create') { intent = previous.intent; if (intent.workspace.id !== id) throw new WorkspaceError('IDEMPOTENCY_KEY_REUSED', 'Copy target differs from its original creation'); }
  else {
    const now = rt.now(); const scope = { customerId, workspaceId: id }; const binding = runtime.createBinding(scope, rt.id('binding') as any, now); const revisionId = rt.id('revision') as any; const manifest = { schemaVersion: 1 as const, entries: [] as const };
    intent = { schemaVersion: 1, kind: 'workspace:create', request: { method: 'POST', path: '/v1/workspaces', body: request }, workspace: { id, customerId, name, currentRevisionId: revisionId, version: 1, status: 'active', storageBindingId: binding.id, bindingGeneration: binding.generation, createdAt: now, updatedAt: now }, binding,
      candidateIdentity: { candidateId: rt.id('candidate') as any, revisionId, operationId: command.operationId, scope: { ...scope, storageBindingId: binding.id, bindingGeneration: binding.generation }, parentRevisionId: null, createdAt: now }, initialManifest: manifest, initialManifestDigest: manifestDigest(manifest) };
  }
  const claimed = await rt.control.claimWorkspaceCreation({ principal, authorization, command, intent, claim: { ownerId: rt.dependencies.ownerId, fence: 1, expiresAt: rt.until(rt.now(), rt.processingTtlMs) }, now: rt.now() });
  let operation = claimed.operation;
  if (!claimed.replayed && operation.state === 'processing') operation = await runtime.lifecycle.processOperation({ scope: operation.scope, operationId: operation.id, processingFence: operation.claim!.fence }) as typeof operation;
  if (operation.state === 'failed') throw new WorkspaceError(operation.error?.code ?? 'STORAGE_UNAVAILABLE', 'Copy target creation failed', { operationId: operation.id });
  if (operation.state !== 'succeeded') throw new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'Copy target creation requires reconciliation', { operationId: operation.id, retryable: true });
  return operation.intent.workspace;
}
/** This journal coordinates server-owned commands; only catalog acceptance establishes either publication. */
export async function copyWorkspace(runtime: WorkspaceRuntime, input: { kind: 'clone' | 'import'; principal: Principal; destination: Principal; sourceScope: WorkspaceScope; targetCustomerId: CustomerId; key: string; request: unknown; name: string; targetWorkspaceId?: string; source: () => Promise<RestoreSource> }) {
  const file = journalPath(runtime, 'administration', { kind: input.kind, scope: input.sourceScope, actorId: input.principal.actorId, credentialId: input.principal.credential.id, key: input.key });
  return serialize(file, runtime.control, input.sourceScope, async () => {
    let journal = await loadJournal<CopyJournal>(file);
    if (journal && canonicalJson(journal.request) !== canonicalJson(input.request)) throw new WorkspaceError('IDEMPOTENCY_KEY_REUSED', 'Copy key belongs to another exact request');
    if (!journal) {
      const source = await input.source(); await authorizeSource(runtime, source, input.principal);
      await runtime.lifecycle.runtime.authorize(input.destination, 'workspace:create', { customerId: input.targetCustomerId });
      journal = { request: input.request, source, destinationPrincipal: input.destination, destinationCustomerId: input.targetCustomerId, workspaceId: (input.targetWorkspaceId ?? runtime.lifecycle.runtime.id('workspace')) as Workspace['id'], creation: null, operationId: null, completed: null };
      // Source and target ownership are durable before workspace creation or copy storage I/O.
      await saveJournal(file, journal);
    }
    await authorizeSource(runtime, journal.source, input.principal);
    await runtime.lifecycle.runtime.authorize(journal.destinationPrincipal, 'workspace:create', { customerId: journal.destinationCustomerId });
    if (journal.completed) return { workspace: journal.completed, operation: null, source: journal.source };
    if (!journal.creation) { journal.creation = await createTarget(runtime, journal.destinationPrincipal, journal.destinationCustomerId, journal.workspaceId, input.name, `copy-create-${hash(file)}`); await saveJournal(file, journal); }
    const scope: WorkspaceScope = { customerId: journal.destinationCustomerId, workspaceId: journal.workspaceId };
    const request = { revisionId: journal.source.kind === 'revision' ? journal.source.revision.id : journal.source.bundle.id, expectedRevisionId: journal.creation.currentRevisionId, expectedWorkspaceVersion: journal.creation.version, reason: `${input.kind} the exact authorized context` };
    const claimed = await runtime.restore.claimSource({ scope, principal: journal.destinationPrincipal, idempotencyKey: `copy-restore-${hash(file)}`, request }, journal.source, 'workspace:create');
    journal.operationId = claimed.operation.id; await saveJournal(file, journal); let operation = claimed.operation;
    if (!claimed.replayed && operation.state === 'processing') operation = await runtime.restore.process({ scope, operationId: operation.id, processingFence: operation.claim!.fence });
    if (operation.state === 'failed') throw new WorkspaceError(operation.error?.code ?? 'STORAGE_UNAVAILABLE', 'Copy publication has a recorded failure', { operationId: operation.id });
    if (operation.state !== 'succeeded' || !operation.result) return { workspace: journal.creation, operation, source: journal.source };
    journal.completed = { ...journal.creation, currentRevisionId: operation.result.revisionId, version: journal.creation.version + (operation.result.changed ? 1 : 0), updatedAt: operation.updatedAt }; await saveJournal(file, journal);
    return { workspace: journal.completed, operation, source: journal.source };
  });
}
export const legacyCopy = (value: Awaited<ReturnType<typeof copyWorkspace>>) => legacyWorkspace(value.workspace);
