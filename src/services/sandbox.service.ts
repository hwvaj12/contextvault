import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSafeDirectory, removeWorkspace } from '../application/files';
import { canonicalJson, manifestDigest, WorkspaceError, type Principal, type Run, type WorkspaceScope } from '../domain';
import type { WorkspaceRuntime } from '../config/runtime';
import { acceptedManifest, acceptedReference, immutableProvider, publishSnapshot, type ImmutableSource, type Snapshot } from '../compat/publication';
import { captureWorkspace, cleanupOwnedCaptures, discardUnselectedCapture, hasPendingCapture, hydrateWorkspace, inspectWorkspace, ownedCaptureRuns } from '../compat/capture';
import { hash, journalPath, loadJournal, saveJournal, serialize } from '../compat/journal';
import { runScope } from '../compat/context';

export interface SandboxContext { runtime: WorkspaceRuntime; principal: Principal; scope: WorkspaceScope; key: string }
interface Session {
  sandboxId: string; workspaceId: string; sandboxPath: string; createdAt: string; owner: string; openKey: string;
  phase: 'opening' | 'active' | 'uncertain' | 'published-needs-reopen' | 'failed' | 'destroyed'; runId: Run['id'] | null;
  openCommandKey?: string; pendingKey: string | null; lastOutcome: Run['outcome'];
}
interface Checkpoint { request: unknown; digest: string; runId: Run['id']; result?: Record<string, unknown>; published?: Record<string, unknown>; reopenKey: string; reopenRunId?: Run["id"]; source?: ImmutableSource | Snapshot; filesChanged?: string[] }
const owner = (principal: Principal) => hash({ actorId: principal.actorId, credentialId: principal.credential.id });
const fileFor = (context: SandboxContext) => journalPath(context.runtime, 'sessions', context.scope);
async function authorize(context: SandboxContext, action: 'run:read' | 'run:open-write' | 'run:finalize' | 'run:abort') { await context.runtime.lifecycle.runtime.authorize(context.principal, action, context.scope); }
async function session(context: SandboxContext): Promise<Session> {
  await authorize(context, 'run:read'); const value = await loadJournal<Session>(fileFor(context));
  if (!value || value.phase === 'destroyed') throw new WorkspaceError('RUN_NOT_FOUND', 'Sandbox not found');
  if (value.owner !== owner(context.principal)) throw new WorkspaceError('FORBIDDEN', 'Sandbox belongs to another authenticated identity');
  return value;
}
const view = (value: Session, run?: Run | null) => ({ sandboxId: value.sandboxId, workspaceId: value.workspaceId, sandboxPath: value.sandboxPath,
  pathSemantics: 'server-colocated-only', writersMustStopBeforeCaptureAndCleanup: true, createdAt: value.createdAt, state: value.phase, runId: value.runId,
  baseCommit: run?.baseRevisionId ?? null, outcome: value.lastOutcome, ...(value.pendingKey ? { pendingIdempotencyKey: value.pendingKey } : {}) });
async function currentRun(context: SandboxContext, id: Run['id']) { const run = await context.runtime.control.getRun(context.scope, id); if (!run) throw new WorkspaceError('RUN_NOT_FOUND', 'Sandbox run not found'); return run; }
const openRequest = { mode: 'read-write' as const, agentLabel: 'legacy-sandbox', task: 'Legacy checkpoint session', reason: 'Colocated sandbox session' };
async function open(context: SandboxContext, key: string) { return (await context.runtime.lifecycle.openRun({ scope: context.scope, principal: context.principal, idempotencyKey: key, request: openRequest })).value; }
async function recordedOpen(context: SandboxContext, idempotencyKey: string): Promise<Run['id'] | null> {
  await context.runtime.lifecycle.runtime.authorize(context.principal, 'operation:read', context.scope);
  const command = context.runtime.lifecycle.runtime.command('run:open', { principal: context.principal, idempotencyKey, request: openRequest }, context.scope);
  const operation = await context.runtime.control.findOperation(command.idempotencyScope, idempotencyKey);
  if (!operation) return null;
  if (operation.command.requestDigest !== command.requestDigest || operation.principal.credential.id !== context.principal.credential.id || operation.kind !== 'run:open' || operation.state !== 'succeeded' || operation.result?.kind !== 'run:open') throw new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'Original opening requires reconciliation');
  return operation.result.runId;
}
async function hydrate(context: SandboxContext, value: Session, run: Run): Promise<void> {
  const source = await acceptedReference(context.runtime, context.principal, context.scope, run.baseRevisionId);
  const provider = await immutableProvider(context.runtime, context.principal, context.scope, source);
  // Never overwrite an existing path. Incomplete openings require explicit stopped-writer abandonment.
  await hydrateWorkspace(context.runtime, value.sandboxPath, provider.manifest, path => provider.openFile(path));
}
export async function checkoutSandbox(context: SandboxContext) {
  await authorize(context, 'run:open-write'); const file = fileFor(context);
  return serialize(file, context.runtime.control, context.scope, async () => {
    await authorize(context, 'run:open-write');
    let value = await loadJournal<Session>(file);
    if (value && value.phase !== 'destroyed') {
      if (value.owner !== owner(context.principal) || value.openKey !== context.key) throw new WorkspaceError('INVALID_TRANSITION', 'Sandbox already exists for this workspace');
      if (value.phase !== 'opening') return view(value, value.runId ? await currentRun(context, value.runId) : null);
      // An interrupted initial hydration retains files for inspection. It cannot delete or overwrite a possibly exposed tree.
      throw new WorkspaceError('STORAGE_UNAVAILABLE', 'Sandbox opening was interrupted; retained files require explicit reconciliation');
    }
    const sandboxId = `sandbox-${randomUUID()}`;
    if (value?.phase === 'destroyed' && value.openKey === context.key) throw new WorkspaceError('INVALID_TRANSITION', 'Use a new checkout key after explicit session abandonment');
    value = { sandboxId, workspaceId: context.scope.workspaceId, sandboxPath: join(context.runtime.configuration.dataDirectory, 'legacy-compat', 'sandboxes', sandboxId), createdAt: context.runtime.now(), owner: owner(context.principal), openKey: context.key, phase: 'opening', runId: null, openCommandKey: `sandbox-open-${hash([context.scope, sandboxId, context.key])}`, pendingKey: null, lastOutcome: null };
    await saveJournal(file, value);
    const run = await open(context, value.openCommandKey!); value.runId = run.id; await saveJournal(file, value);
    await hydrate(context, value, run); value.phase = 'active'; await saveJournal(file, value);
    return view(value, run);
  });
}
export async function getSandboxStatus(context: SandboxContext) {
  const value = await session(context); const run = value.runId ? await currentRun(context, value.runId) : null;
  if (value.phase === 'opening' || !run) {
    let exists = false; try { exists = (await lstat(value.sandboxPath)).isDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { ...view(value, run), exists, hasChanges: null, recovery: 'explicit-stopped-writer-abandonment' };
  }
  const accepted = await acceptedManifest(context.runtime, context.principal, context.scope, run.outcome?.revisionId ?? run.baseRevisionId);
  const current = await inspectWorkspace(context.runtime, value.sandboxPath, accepted.manifest);
  return { ...view(value, run), exists: true, hasChanges: accepted.revision.manifestDigest !== manifestDigest(current) };
}
export async function commitSandbox(context: SandboxContext, request: Record<string, unknown>) {
  if (request.writersStopped !== true) throw new WorkspaceError('INVALID_REQUEST', 'Stop all agent writers and send writersStopped: true before capture');
  await authorize(context, 'run:finalize'); const file = fileFor(context);
  return serialize(file, context.runtime.control, context.scope, async () => {
    await authorize(context, 'run:finalize');
    const value = await session(context);
    const checkpointFile = journalPath(context.runtime, 'checkpoints', { ...context.scope, sandboxId: value.sandboxId, key: context.key });
    let checkpoint = await loadJournal<Checkpoint>(checkpointFile);
    if (checkpoint?.digest !== undefined && checkpoint.digest !== hash(request)) throw new WorkspaceError('IDEMPOTENCY_KEY_REUSED', 'Checkpoint key belongs to another request');
    if (checkpoint?.result) return checkpoint.result;
    if (value.pendingKey && value.pendingKey !== context.key) throw new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'Reconcile the original checkpoint key before another command');
    if (!checkpoint) {
      if (!value.runId || value.phase !== 'active') throw new WorkspaceError('INVALID_TRANSITION', 'Sandbox requires an active run');
      const run = await currentRun(context, value.runId);
      const base = await acceptedManifest(context.runtime, context.principal, context.scope, run.baseRevisionId);
      const captureOwner = { group: `sandbox:${value.sandboxId}`, key: context.key, requestDigest: hash(request), journalFile: checkpointFile, runId: run.id };
      const retained = await hasPendingCapture(context.runtime, context.principal, context.scope, captureOwner);
      if (!retained && base.revision.manifestDigest === manifestDigest(await inspectWorkspace(context.runtime, value.sandboxPath, base.manifest))) throw Object.assign(new Error('No changes to commit'), { code: 'NO_CHANGES' });
      const source = await captureWorkspace(context.runtime, context.principal, context.scope, value.sandboxPath, base.manifest, captureOwner);
      if (!retained && base.revision.manifestDigest === manifestDigest(source.manifest)) {
        await discardUnselectedCapture(context.runtime, context.principal, context.scope, captureOwner); throw Object.assign(new Error('No changes to commit'), { code: 'NO_CHANGES' });
      }
      const before = new Map(base.manifest.entries.filter(entry => entry.kind === 'file').map(entry => [entry.path, entry]));
      const after = new Map(source.manifest.entries.filter(entry => entry.kind === 'file').map(entry => [entry.path, entry]));
      const filesChanged = [...new Set([...before.keys(), ...after.keys()])].filter(path => canonicalJson(before.get(path) ?? null) !== canonicalJson(after.get(path) ?? null)).sort();
      checkpoint = { request, digest: hash(request), runId: value.runId, source, filesChanged, reopenKey: `sandbox-reopen-${hash([value.sandboxId, context.key])}` }; await saveJournal(checkpointFile, checkpoint);
    }
    value.pendingKey = context.key; await saveJournal(file, value);
    if (!checkpoint.published) {
      try {
        const run = await currentRun(context, checkpoint.runId);
        const result = await publishSnapshot(context.runtime, { scope: context.scope, principal: context.principal, key: context.key, kind: `sandbox-${value.sandboxId}`, request: checkpoint.request, run, source: async () => { if (!checkpoint!.source) throw new WorkspaceError('STORAGE_UNAVAILABLE', 'Checkpoint source is unavailable'); return checkpoint!.source; } });
        checkpoint.published = { commitId: result.commitId, parentId: result.parentId, createdAt: result.createdAt, filesChanged: checkpoint.filesChanged ?? result.files, operation: result.operation, outcome: result.outcome, publishedRunId: result.run.id };
        value.lastOutcome = result.outcome; value.phase = 'published-needs-reopen'; await saveJournal(checkpointFile, checkpoint); await saveJournal(file, value);
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === 'PUBLICATION_OUTCOME_UNKNOWN') { value.phase = 'uncertain'; await saveJournal(file, value); }
        else {
          const terminal = await currentRun(context, checkpoint.runId);
          if (terminal.outcome && !['active', 'finalizing'].includes(terminal.state)) {
            value.lastOutcome = terminal.outcome; value.phase = 'failed'; value.pendingKey = null; await saveJournal(file, value);
          }
        }
        throw error;
      }
    }
    // Publication is already durable. Reopening retries only this saved command, never the checkpoint.
    try {
      const next = checkpoint.reopenRunId ? await currentRun(context, checkpoint.reopenRunId) : await open(context, checkpoint.reopenKey);
      checkpoint.reopenRunId = next.id; value.runId = next.id; await saveJournal(checkpointFile, checkpoint); await saveJournal(file, value);
      if (next.state !== 'active') throw new WorkspaceError('INVALID_TRANSITION', 'The recorded reopened run is terminal; explicitly abandon the stopped session');
      if (next.baseRevisionId !== checkpoint.published.commitId) throw new WorkspaceError('REVISION_CONFLICT', 'Accepted head changed; retain stopped sandbox for refresh before resuming');
      value.runId = next.id; value.phase = 'active'; value.pendingKey = null; await saveJournal(file, value);
      checkpoint.result = { ...view(value, next), ...checkpoint.published, runId: checkpoint.runId, nextRunId: next.id, state: 'active' };
      await saveJournal(checkpointFile, checkpoint); return checkpoint.result;
    } catch (error) {
      value.phase = 'published-needs-reopen'; await saveJournal(file, value);
      return { ...view(value), ...checkpoint.published, state: value.phase, reopenError: error instanceof WorkspaceError ? error.code : 'STORAGE_UNAVAILABLE', reopenIdempotencyKey: checkpoint.reopenKey, reopenRunId: checkpoint.reopenRunId ?? null, recovery: 'explicit-stopped-writer-abandonment' };
    }
  });
}
export async function destroySandbox(context: SandboxContext, request: Record<string, unknown>) {
  if (request.writersStopped !== true) throw new WorkspaceError('INVALID_REQUEST', 'Stop all agent writers and send writersStopped: true before cleanup');
  await authorize(context, 'run:abort'); const file = fileFor(context);
  return serialize(file, context.runtime.control, context.scope, async () => {
    await authorize(context, 'run:abort');
    const value = await session(context);
    const abandoning = request.abandon === true;
    if (value.phase === 'uncertain') throw new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'Reconcile the original publication before cleanup');
    if ((value.pendingKey || ['published-needs-reopen', 'opening'].includes(value.phase)) && !abandoning) throw new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'Explicit stopped-writer abandonment is required for an incomplete session');
    const runIds = new Set<Run['id']>();
    if (value.runId) runIds.add(value.runId);
    for await (const allocation of ownedCaptureRuns(context.runtime, context.principal, context.scope, `sandbox:${value.sandboxId}`)) {
      const run = await currentRun(context, allocation.runId);
      if (allocation.pending && run.state === 'active' && !abandoning) throw new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'Explicit stopped-writer abandonment is required for a retained capture');
      runIds.add(allocation.runId);
    }
    if (value.phase === 'opening' && !value.runId) {
      const idempotencyKey = value.openCommandKey ?? `sandbox-open-${hash([context.scope, value.openKey])}`;
      const runId = await recordedOpen(context, idempotencyKey);
      if (runId) { value.runId = runId; runIds.add(runId); await saveJournal(file, value); }
    }
    if (value.pendingKey) {
      const checkpoint = await loadJournal<Checkpoint>(journalPath(context.runtime, 'checkpoints', { ...context.scope, sandboxId: value.sandboxId, key: value.pendingKey }));
      if (!checkpoint?.published) throw new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'Reconcile the pending checkpoint before cleanup');
      const published = await currentRun(context, checkpoint.runId);
      if (published.state !== 'finalized' || published.outcome?.revisionId !== checkpoint.published.commitId) throw new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'Published checkpoint requires reconciliation');
      if (!checkpoint.reopenRunId) {
        const runId = await recordedOpen(context, checkpoint.reopenKey);
        if (runId) { checkpoint.reopenRunId = runId; await saveJournal(journalPath(context.runtime, 'checkpoints', { ...context.scope, sandboxId: value.sandboxId, key: value.pendingKey }), checkpoint); }
      }
      runIds.add(checkpoint.runId); if (checkpoint.reopenRunId) { runIds.add(checkpoint.reopenRunId); value.runId = checkpoint.reopenRunId; await saveJournal(file, value); }
    }
    for (const runId of runIds) {
      const run = await currentRun(context, runId);
      if (run.state === 'finalizing') throw new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'Reconcile publication before cleanup');
      if (run.state === 'active') await context.runtime.lifecycle.abort({ scope: runScope(run), principal: context.principal, idempotencyKey: `sandbox-destroy-${value.sandboxId}-${run.id}`, request: { expectedRunVersion: run.version, reason: 'Legacy sandbox cleanup' } });
    }
    await authorize(context, 'run:abort');
    await cleanupOwnedCaptures(context.runtime, context.principal, context.scope, `sandbox:${value.sandboxId}`);
    try { await assertSafeDirectory(value.sandboxPath); await removeWorkspace(value.sandboxPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    value.pendingKey = null;
    value.phase = 'destroyed'; await saveJournal(file, value);
    return { success: true, ...view(value), status: 'cleaned_up' };
  });
}
