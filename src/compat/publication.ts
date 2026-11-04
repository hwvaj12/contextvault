import { canonicalizeManifest, manifestDigest, verifyFileStream, WorkspaceError, type Manifest, type Principal, type Run, type WorkspaceScope, type Revision } from '../domain';
import type { WorkspaceRuntime } from '../config/runtime';
import { createHash } from 'node:crypto';
import { hash, journalPath, loadJournal, saveJournal, serialize } from './journal';
import { runScope } from './context';
import { bindCaptureRun, captureInline, capturedProvider, type CapturedSource } from './capture';
import type { SnapshotSource } from '../ports/streams';
import { operationView } from '../routes/v1/views';

export interface Snapshot { manifest: Manifest; files: { path: string; base64: string }[] }
export function snapshot(runtime: WorkspaceRuntime, files: { path: string; content: string; encoding?: 'utf8' | 'base64' }[]): Snapshot {
  const bytes = files.map(file => ({ path: file.path, bytes: Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8') }));
  const manifest = canonicalizeManifest({ schemaVersion: 1, entries: bytes.map(file => ({ path: file.path, kind: 'file', byteLength: file.bytes.length, sha256: createHash('sha256').update(file.bytes).digest('hex') })) }, runtime.configuration.limits);
  return { manifest, files: bytes.map(file => ({ path: file.path, base64: file.bytes.toString('base64') })) };
}
async function revisionSource(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, revisionId?: string) {
  await runtime.lifecycle.runtime.authorize(principal, 'workspace:read', scope);
  const workspace = await runtime.control.getWorkspace(scope);
  if (!workspace) throw new WorkspaceError('WORKSPACE_NOT_FOUND', 'Workspace not found');
  if (workspace.status !== 'active') throw new WorkspaceError('WORKSPACE_INACTIVE', 'Workspace is not active');
  let revision = await runtime.control.getRevision(scope, (revisionId ?? workspace.currentRevisionId) as Revision['id']);
  if (!revision && revisionId) { const alias = await runtime.control.getLegacyRevisionAlias(scope, revisionId); if (alias) revision = await runtime.control.getRevision(scope, alias.revisionId); }
  if (!revision) throw new WorkspaceError('REVISION_NOT_FOUND', 'Accepted revision not found');
  const binding = await runtime.control.getBinding(scope, revision.scope.storageBindingId);
  if (!binding || binding.generation !== revision.scope.bindingGeneration) throw new WorkspaceError('STORAGE_BINDING_CHANGED', 'Accepted revision binding is unavailable');
  const store = await runtime.revisionStore(binding); const reference = { ...revision, revisionId: revision.id };
  const manifest = canonicalizeManifest(await store.readManifest(reference), runtime.configuration.limits);
  await runtime.lifecycle.runtime.authorize(principal, 'workspace:read', scope);
  return { revision, manifest, store, reference };
}
export async function acceptedManifest(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, revisionId?: string) {
  const { revision, manifest } = await revisionSource(runtime, principal, scope, revisionId); return { revision, manifest };
}
export async function acceptedSnapshot(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, revisionId?: string) {
  const { revision, manifest, store, reference } = await revisionSource(runtime, principal, scope, revisionId);
  const files: Snapshot['files'] = [];
  for (const entry of manifest.entries) {
    if (entry.kind !== 'file') continue;
    await runtime.lifecycle.runtime.authorize(principal, 'workspace:read', scope);
    const chunks: Buffer[] = [];
    for await (const chunk of verifyFileStream(entry, await store.openFile(reference, entry.path), runtime.configuration.limits)) chunks.push(Buffer.from(chunk));
    files.push({ path: entry.path, base64: Buffer.concat(chunks).toString('base64') });
  }
  await runtime.lifecycle.runtime.authorize(principal, 'workspace:read', scope);
  return { revision, manifest, files };
}
export interface AcceptedSource { kind: 'accepted'; revisionId: Revision['id']; manifest: Manifest }
export type ImmutableSource = CapturedSource | AcceptedSource;
export async function acceptedReference(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, revisionId?: string): Promise<AcceptedSource> {
  const { revision, manifest } = await revisionSource(runtime, principal, scope, revisionId); return { kind: 'accepted', revisionId: revision.id, manifest };
}
export async function immutableProvider(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, source: ImmutableSource): Promise<SnapshotSource> {
  const manifest = canonicalizeManifest(source.manifest, runtime.configuration.limits); const expectedManifestDigest = manifestDigest(manifest); const entries = new Map(manifest.entries.filter(entry => entry.kind === 'file').map(entry => [entry.path, entry]));
  const captured = source.kind === 'capture' ? await capturedProvider(runtime, principal, scope, { ...source, manifest }) : null;
  return { manifest, async openFile(path, options) {
    const entry = entries.get(path); if (!entry) throw new WorkspaceError('REVISION_NOT_FOUND', 'File is absent from the immutable source');
    if (captured) return verifyFileStream(entry, await captured.openFile(path, options), runtime.configuration.limits);
    if (source.kind !== 'accepted') throw new WorkspaceError('RECEIPT_MISMATCH', 'Unknown immutable source');
    await runtime.lifecycle.runtime.authorize(principal, 'workspace:read', scope);
    const revision = await runtime.control.getRevision(scope, source.revisionId);
    if (!revision || revision.manifestDigest !== expectedManifestDigest) throw new WorkspaceError('REVISION_NOT_FOUND', 'Pinned accepted source is unavailable');
    const binding = await runtime.control.getBinding(scope, revision.scope.storageBindingId);
    if (!binding || binding.generation !== revision.scope.bindingGeneration) throw new WorkspaceError('STORAGE_BINDING_CHANGED', 'Pinned accepted source binding is unavailable');
    const store = await runtime.revisionStore(binding); const bytes = await store.openFile({ ...revision, revisionId: revision.id }, path, options);
    return (async function* () { for await (const chunk of verifyFileStream(entry, bytes, runtime.configuration.limits)) { await runtime.lifecycle.runtime.authorize(principal, 'workspace:read', scope); yield chunk; } })();
  } };
}
function journalRequest(kind: string, request: unknown): unknown {
  if (kind !== 'push') return request;
  const body = request as { files: { content: string; path: string; encoding?: string }[]; metadata?: unknown };
  return { ...body, files: body.files.map(({ content: _content, ...description }) => description) };
}
interface PublicationJournal {
  schemaVersion: 1 | 2; request: unknown; digest: string; key: string; source: ImmutableSource | Snapshot;
  runId: Run['id'] | null; runVersion: number | null; submissionId: string | null;
  finalizeRequest: { expectedRunVersion: number; submissionId?: string } | null;
  operationId: string | null;
  commandRunId?: string;
}
export async function publishSnapshot(runtime: WorkspaceRuntime, input: { principal: Principal; scope: WorkspaceScope; key: string; request: unknown; source: () => Promise<ImmutableSource | Snapshot>; run?: Run; agentLabel?: string; expectedRunVersion?: number; kind: string }) {
  const { principal, scope, key } = input;
  await runtime.lifecycle.runtime.authorize(principal, 'run:finalize', scope);
  const identity = { ...scope, actorId: principal.actorId, credentialId: principal.credential.id, kind: input.kind, key };
  const file = journalPath(runtime, 'commands', { ...identity, ...(input.run ? { requestedRunId: input.run.id } : {}) });
  const captureOwner = { group: `publication:${hash(file)}`, key, requestDigest: hash(input.request), journalFile: file, runId: input.run?.id ?? null };
  return serialize(file, runtime.control, scope, async () => {
    await runtime.lifecycle.runtime.authorize(principal, 'run:finalize', scope);
    const digest = hash(input.request);
    let journal = await loadJournal<PublicationJournal>(file);
    if (!journal && input.run) {
      const legacy = await loadJournal<PublicationJournal>(journalPath(runtime, 'commands', identity));
      if (legacy?.runId === input.run.id) journal = legacy;
    }
    if (journal && input.run && journal.runId !== input.run.id) throw new WorkspaceError('IDEMPOTENCY_KEY_REUSED', 'Compatibility command belongs to another requested run');
    if (journal && journal.digest !== digest) throw new WorkspaceError('IDEMPOTENCY_KEY_REUSED', 'Compatibility key belongs to another request');
    if (!journal) {
      const inputSource = await input.source(); canonicalizeManifest(inputSource.manifest, runtime.configuration.limits);
      const source = 'kind' in inputSource ? inputSource : await captureInline(runtime, principal, scope, inputSource, captureOwner);
      journal = { schemaVersion: 2, key, digest, request: journalRequest(input.kind, input.request), source, runId: input.run?.id ?? null, runVersion: input.expectedRunVersion ?? input.run?.version ?? null, submissionId: null, finalizeRequest: null, operationId: null, ...(input.run ? { commandRunId: input.run.id } : {}) };
      await saveJournal(file, journal);
    }
    if (!('kind' in journal.source)) { journal.source = await captureInline(runtime, principal, scope, journal.source, { ...captureOwner, runId: journal.runId }); journal.schemaVersion = 2; journal.request = journalRequest(input.kind, journal.request); await saveJournal(file, journal); }
    const source = journal.source as ImmutableSource;
    const commandIdentity = journal.commandRunId ? [input.kind, key, journal.commandRunId] : [input.kind, key];
    let run: Run;
    if (!journal.runId) {
      const opened = await runtime.lifecycle.openRun({ scope, principal, idempotencyKey: `compat-open-${hash(commandIdentity)}`, request: { mode: 'read-write', agentLabel: input.agentLabel || 'legacy-client', task: 'Legacy complete snapshot publication', reason: 'Legacy compatibility mutation' } });
      run = opened.value; journal.runId = run.id; journal.runVersion = run.version; await saveJournal(file, journal);
    } else {
      const found = await runtime.control.getRun(scope, journal.runId);
      if (!found) throw new WorkspaceError('RUN_NOT_FOUND', 'Compatibility run no longer exists'); run = found;
    }
    if (source.kind === 'capture' && !journal.finalizeRequest) await bindCaptureRun(runtime, principal, scope, source, run.id);
    const submissions = runtime.lifecycle.runtime.dependencies.submissions; const rscope = runScope(run);
    const command = (kind: 'submission:create' | 'submission:file' | 'submission:seal', stage: unknown, request: unknown) => runtime.lifecycle.runtime.command(kind, { principal, idempotencyKey: `compat-${hash([...commandIdentity, stage])}`, request }, scope, run.id);
    if (!journal.finalizeRequest) {
      let submission;
      if (journal.submissionId) submission = await submissions.get(rscope, journal.submissionId as any);
      else {
        submission = await submissions.begin({ scope: rscope, principal, command: command('submission:create', 'begin', {}), submissionId: runtime.lifecycle.runtime.id('submission') as any, expiresAt: runtime.lifecycle.runtime.until(runtime.now(), runtime.lifecycle.runtime.leaseTtlMs) });
        journal.submissionId = submission.id; await saveJournal(file, journal);
      }
      if (!submission) throw new WorkspaceError('SUBMISSION_NOT_FOUND', 'Compatibility submission is unavailable');
      if (submission.state !== 'sealed') {
        const receipts = []; const provider = await immutableProvider(runtime, principal, scope, source);
        for (const entry of source.manifest.entries) {
          if (entry.kind !== 'file') continue;
          const request = { submissionId: submission.id, path: entry.path, declaredByteLength: entry.byteLength, declaredSha256: entry.sha256 };
          const receipt = await submissions.writeFile({ scope: rscope, principal, command: command('submission:file', ['file', entry.path], request), submissionId: submission.id, receiptId: runtime.lifecycle.runtime.id('receipt') as any, path: entry.path, bytes: await provider.openFile(entry.path), declaredByteLength: entry.byteLength, declaredSha256: entry.sha256 as any });
          receipts.push({ path: entry.path, receiptId: receipt.id });
        }
        const request = { submissionId: submission.id, manifest: journal.source.manifest, receipts };
        submission = await submissions.seal({ scope: rscope, principal, command: command('submission:seal', 'seal', request), submissionId: submission.id, manifest: journal.source.manifest, receipts, sealedAt: runtime.now() });
      }
      journal.finalizeRequest = { expectedRunVersion: journal.runVersion!, submissionId: submission.id };
      await saveJournal(file, journal);
    }
    // Persisted original request/key and immutable source survive uncertainty and HTTP response loss.
    const finalizeKey = `compat-finalize-${hash(commandIdentity)}`;
    const expectedCommand = runtime.lifecycle.runtime.command('finalize', { principal, idempotencyKey: finalizeKey, request: journal.finalizeRequest }, scope, run.id);
    const existing = await runtime.control.findOperation(expectedCommand.idempotencyScope, finalizeKey);
    if (input.kind === 'push' && !existing) {
      const authorization = await runtime.lifecycle.runtime.authorize(principal, 'run:finalize', scope);
      await runtime.control.recordLegacyPush({ scope: rscope, principal, authorization, command: expectedCommand });
    }
    if (existing && (existing.kind !== 'finalize' || existing.command.requestDigest !== expectedCommand.requestDigest || existing.principal.credential.id !== principal.credential.id)) throw new WorkspaceError('IDEMPOTENCY_KEY_REUSED', 'Persisted finalization command differs from the original request');
    // Current read authority may reconcile an accepted original command after an authority epoch changes.
    // It cannot execute the old claim or allocate a replacement command.
    if (existing) await runtime.lifecycle.runtime.authorize(principal, 'operation:read', scope);
    const claimed = existing?.kind === 'finalize' ? { operation: existing, replayed: true } : await runtime.lifecycle.claimFinalization({ scope: rscope, principal, idempotencyKey: finalizeKey, request: journal.finalizeRequest });
    journal.operationId = claimed.operation.id; await saveJournal(file, journal);
    runtime.schedule(claimed.operation, claimed.replayed);
    let operation = claimed.operation;
    const deadline = Date.now() + Math.min(runtime.configuration.requestTimeoutMs / 2, 10_000);
    while (operation.state === 'processing' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
      const current = await runtime.control.getOperation(scope, operation.id); if (current?.kind === 'finalize') operation = current;
    }
    await runtime.lifecycle.runtime.authorize(principal, 'run:read', scope);
    if (operation.state !== 'succeeded') {
      if (operation.state === 'failed') throw new WorkspaceError(operation.error?.code ?? 'INVALID_TRANSITION', 'Compatibility publication failed', { operationId: operation.id });
      throw new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'Reuse the original command and key before cleanup or another checkpoint', { operationId: operation.id, retryable: true });
    }
    const currentRun = await runtime.control.getRun(scope, run.id);
    if (!currentRun?.outcome?.revisionId) throw new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'Accepted outcome requires reconciliation', { operationId: operation.id });
    const revision = await runtime.control.getRevision(scope, currentRun.outcome.revisionId);
    if (!revision) throw new WorkspaceError('STORAGE_UNAVAILABLE', 'Accepted revision is unavailable');
    return { commitId: revision.id, workspaceId: scope.workspaceId, parentId: run.baseRevisionId, files: source.manifest.entries.filter(entry => entry.kind === 'file').map(entry => entry.path), sizeBytes: journal.source.manifest.entries.reduce((size, entry) => size + (entry.kind === 'file' ? entry.byteLength : 0), 0), createdAt: operation.updatedAt, outcome: currentRun.outcome, run: currentRun, operation: operationView(operation), idempotencyKey: key };
  });
}
