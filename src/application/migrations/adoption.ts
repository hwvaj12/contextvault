import { isAbsolute, join, resolve } from 'node:path';
import { canonicalJson, manifestDigest, WorkspaceError, type LegacyAdoption, type Principal, type WorkspaceScope } from '../../domain';
import type { WorkspaceRuntime } from '../../config/runtime';
import type { LegacyAdoptionSource } from '../../ports/control-store';
import { proofDigest } from './archive';

export interface AdoptInput { scope: WorkspaceScope; principal: Principal; idempotencyKey: string; request: { sourceFingerprint: string; targetConfigurationRef: string; backupRoot: string; reason: string; sourceOffline: true } }
export type AdoptionHook = (stage: 'draft-owned' | 'backup-ready' | 'candidate-prepared' | 'before-accept' | 'after-accept', adoption: LegacyAdoption) => Promise<void>;
/** Offline, explicit catalog adoption. Inventory never acts as runtime authority. */
export class LegacyAdoptionService {
  constructor(readonly runtime: WorkspaceRuntime, readonly source: LegacyAdoptionSource, readonly hook?: AdoptionHook) {}
  private get rt() { return this.runtime.lifecycle.runtime; }
  private cas(value: LegacyAdoption) { return { scope: value.scope, adoptionId: value.id, expectedVersion: value.version, fence: value.claim.fence, now: this.rt.now() }; }
  private async authorities(input: AdoptInput) { const customer = { customerId: input.scope.customerId }; return { authorization: await this.rt.authorize(input.principal, 'workspace:create', customer), migrationAuthorization: await this.rt.authorize(input.principal, 'workspace:migrate', customer) }; }
  async adopt(input: AdoptInput) {
    input = structuredClone(input);
    if (!input.request.sourceOffline || !/^[a-f0-9]{64}$/.test(input.request.sourceFingerprint) || !input.request.reason?.trim() || input.request.reason.length > 4096 || !isAbsolute(input.request.backupRoot)) throw new WorkspaceError('INVALID_REQUEST', 'Adoption requires a reviewed fingerprint, offline source, absolute backup root and reason');
    input.request.backupRoot = resolve(input.request.backupRoot); const authority = await this.authorities(input);
    const command = this.rt.command('storage:migrate', input, input.scope); const id = `adoption-${proofDigest([command.idempotencyScope, input.idempotencyKey])}` as LegacyAdoption['id'];
    const previous = await this.runtime.control.getLegacyAdoption(input.scope, id);
    if (previous?.state === 'complete') { await this.runtime.control.claimLegacyAdoption({ principal: input.principal, ...authority, adoption: { ...previous, command }, now: this.rt.now() }); return previous; }
    const inventory = await this.source.inspect(this.runtime.configuration.limits);
    if (inventory.sourceFingerprint !== input.request.sourceFingerprint) throw new WorkspaceError('CAPTURE_CHANGED', 'Legacy source differs from the reviewed inventory');
    const workspace = inventory.workspaces.find(value => value.workspaceId === input.scope.workspaceId);
    if (!workspace || workspace.customerId !== input.scope.customerId) throw new WorkspaceError('FORBIDDEN', 'Reviewed legacy owner does not match the selected customer');
    if (!workspace.eligible || workspace.issues.length || workspace.status !== 'active' || !workspace.selectedHead) throw new WorkspaceError('INVALID_MANIFEST', 'Legacy workspace has unresolved inventory blockers');
    let draft: LegacyAdoption;
    if (previous) draft = { ...previous, command };
    else {
      const profile = this.runtime.configuration.profiles.find(value => value.configurationRef === input.request.targetConfigurationRef); if (!profile) throw new WorkspaceError('INVALID_REQUEST', 'Adoption target must be explicitly configured');
      const now = this.rt.now(); const binding = { id: this.rt.id('binding') as LegacyAdoption['binding']['id'], scope: input.scope, backend: profile.backend, generation: 1, location: { storeId: profile.storeId, opaqueKey: input.scope.workspaceId }, configurationRef: profile.configurationRef, status: 'active' as const, createdAt: now };
      const revisions = new Map(workspace.revisions.map(source => [source.alias, this.rt.id('revision') as LegacyAdoption['workspace']['currentRevisionId']]));
      const candidates = workspace.revisions.map(source => ({ source, identity: { candidateId: this.rt.id('candidate') as LegacyAdoption['candidates'][number]['identity']['candidateId'], revisionId: revisions.get(source.alias)!, operationId: command.operationId, scope: { ...input.scope, storageBindingId: binding.id, bindingGeneration: 1 }, parentRevisionId: source.parentAlias === null ? null : revisions.get(source.parentAlias)!, createdAt: now } }));
      draft = { id, scope: input.scope, command, sourceFingerprint: inventory.sourceFingerprint, sourceRoot: inventory.sourceRoot, databasePath: inventory.databasePath, inventory: workspace,
        workspace: { id: input.scope.workspaceId, customerId: input.scope.customerId, name: workspace.name, currentRevisionId: revisions.get(workspace.selectedHead)!, version: 1, status: 'active', storageBindingId: binding.id, bindingGeneration: 1, createdAt: now, updatedAt: now }, binding, candidates,
        backup: { directory: join(input.request.backupRoot, proofDigest(input.scope), id), state: 'preparing', receiptDigest: null }, copies: [], state: 'preparing', version: 1, claim: { ownerId: this.runtime.ownerId, fence: 1, expiresAt: this.rt.until(now, this.rt.processingTtlMs) }, createdAt: now, updatedAt: now };
    }
    let value = await this.runtime.control.claimLegacyAdoption({ principal: input.principal, ...authority, adoption: draft, now: this.rt.now() });
    if (value.claim.ownerId !== this.runtime.ownerId || value.claim.expiresAt <= this.rt.now()) {
      if (value.claim.expiresAt > this.rt.now()) throw new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'The original legacy adoption controller still owns its claim', { operationId: value.command.operationId, retryable: true });
      value = await this.runtime.control.claimLegacyAdoptionRecovery({ scope: input.scope, adoptionId: id, expectedVersion: value.version, ownerId: this.runtime.ownerId, now: this.rt.now(), expiresAt: this.rt.until(this.rt.now(), this.rt.processingTtlMs) });
    }
    const io = async <T>(action: () => Promise<T>): Promise<T> => {
      let renewal = Promise.resolve(); let renewing = false; let error: unknown;
      const timer = setInterval(() => { if (renewing || error) return; renewing = true; renewal = (async () => { try { value = await this.runtime.control.renewLegacyAdoptionClaim({ ...this.cas(value), expiresAt: new Date(Math.max(Date.parse(this.rt.until(this.rt.now(), this.rt.processingTtlMs)), Date.parse(value.claim.expiresAt) + 1)).toISOString() }); } catch (caught) { error = caught; } finally { renewing = false; } })(); }, Math.max(50, Math.floor(this.rt.processingTtlMs / 3))); timer.unref();
      try { const result = await action(); if (error) throw error; return result; } finally { clearInterval(timer); await renewal; if (error) throw error; }
    };
    try {
      await this.hook?.('draft-owned', value);
      const backupDigest = await io(() => this.source.backup(inventory, workspace, value.backup.directory));
      value = await this.runtime.control.recordLegacyAdoptionBackup({ ...this.cas(value), receiptDigest: backupDigest });
      await this.hook?.('backup-ready', value);
      const target = await this.runtime.revisionStore(value.binding);
      for (const selected of value.candidates) {
        await this.authorities(input); const source = await this.source.openRevision(workspace, selected.source, this.runtime.configuration.limits);
        const candidate = await io(async () => {
          const prepared = await target.inspectCandidate(selected.identity) ?? await target.prepare({ identity: selected.identity, source });
          if (prepared.manifestDigest !== selected.source.manifestDigest) throw new WorkspaceError('RECEIPT_MISMATCH', 'Adoption target differs from retained source'); return prepared;
        });
        await this.hook?.('candidate-prepared', value);
        if (!value.copies.some(copy => copy.revisionId === candidate.revisionId)) value = await this.runtime.control.recordLegacyAdoptionCopy({ ...this.cas(value), candidate });
      }
      for (const candidate of value.copies) await io(async () => {
        const manifest = await target.readManifest({ ...candidate, revisionId: candidate.revisionId }); const selected = value.candidates.find(value => value.identity.revisionId === candidate.revisionId)!;
        if (canonicalJson(manifest) !== canonicalJson(selected.source.manifest) || manifestDigest(manifest) !== selected.source.manifestDigest) throw new WorkspaceError('RECEIPT_MISMATCH', 'Adoption target manifest changed');
        const { verifyFileStream } = await import('../../domain'); for (const entry of manifest.entries) if (entry.kind === 'file') for await (const _bytes of verifyFileStream(entry, await target.openFile({ ...candidate, revisionId: candidate.revisionId }, entry.path), this.runtime.configuration.limits)) { /* Complete target readback precedes authority installation. */ }
      });
      if ((await io(() => this.source.inspect(this.runtime.configuration.limits))).sourceFingerprint !== value.sourceFingerprint) throw new WorkspaceError('CAPTURE_CHANGED', 'Legacy source changed before adoption acceptance');
      const verifiedBackup = await io(() => this.source.backup(inventory, workspace, value.backup.directory));
      await this.hook?.('before-accept', value);
      value = await this.runtime.control.acceptLegacyAdoption({ ...this.cas(value), principal: input.principal, ...await this.authorities(input), sourceFingerprint: inventory.sourceFingerprint, backupDigest: verifiedBackup, verifiedCopyDigest: proofDigest(value.copies), events: this.rt.events({ id: value.command.operationId, scope: input.scope, runId: null, principal: input.principal }, 'workspace.legacy-adopted') });
      await this.hook?.('after-accept', value); return value;
    } catch (error) {
      const recorded = await this.runtime.control.getLegacyAdoption(input.scope, id); if (recorded?.state === 'complete') return recorded;
      if (error instanceof WorkspaceError) throw error; throw new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'Legacy adoption must resume with the original command', { operationId: value.command.operationId, retryable: true });
    } finally { const current = await this.runtime.control.getLegacyAdoption(input.scope, id).catch(() => null); if (current?.state === 'preparing' && current.claim.ownerId === this.runtime.ownerId && current.claim.expiresAt > this.rt.now()) await this.runtime.control.releaseLegacyAdoptionClaim({ ...this.cas(current), ownerId: this.runtime.ownerId }).catch(() => { /* Unknown live writers retain conservative ownership. */ }); }
  }
}
