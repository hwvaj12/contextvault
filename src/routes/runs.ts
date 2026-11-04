import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WorkspaceError } from '../domain';
import { authorizedWorkspace, commandKey, identity, legacyRunView, resolveRun, runScope, workspaceScope } from '../compat/context';
import { journalPath, hash, loadJournal, saveJournal, serialize } from '../compat/journal';
import { publishSnapshot, acceptedReference } from '../compat/publication';

export async function runRoutes(app: FastifyInstance) {
  const runtime = app.contextVault;
  app.post('/workspaces/:id/runs', async (request, reply) => {
    const body = z.object({ agentId: z.string().min(1), mode: z.enum(['read-only', 'read-write']).default('read-write'), task: z.string().min(1).default('Legacy run'), reason: z.string().min(1).default('Legacy run access') }).parse(request.body);
    const key = commandKey(request);
    const opened = await runtime.lifecycle.openRun({ scope: workspaceScope(request), principal: identity(request), idempotencyKey: key, request: { mode: body.mode, agentLabel: body.agentId, task: body.task, reason: body.reason } });
    return reply.code(201).header('Idempotency-Key', key).send(await legacyRunView(runtime, opened.value));
  });
  app.get('/workspaces/:id/runs', async request => {
    const { scope } = await authorizedWorkspace(runtime, request, 'run:read');
    const query = z.object({ cursor: z.string().max(255).optional(), limit: z.coerce.number().int().min(1).max(1000).default(20) }).parse(request.query);
    const page = await runtime.control.listRuns(scope, query.cursor, query.limit);
    await runtime.lifecycle.runtime.authorize(identity(request), 'run:read', scope);
    return { runs: await Promise.all(page.runs.map(run => legacyRunView(runtime, run))), count: page.runs.length, nextCursor: page.nextCursor };
  });
  app.get('/runs/:id', async request => legacyRunView(runtime, await resolveRun(runtime, request)));
  app.post('/runs/:id/finalize', async (request, reply) => {
    const run = await resolveRun(runtime, request, true); const principal = identity(request); const key = commandKey(request);
    const body = z.object({ expectedRunVersion: z.number().int().positive().optional(), submissionId: z.string().optional(), executionSummary: z.string().optional() }).parse(request.body ?? {});
    if (run.mode === 'read-write' && !body.submissionId) {
      // Legacy runs with no materialization submit their pinned accepted tree, never a Git worktree.
      const result = await publishSnapshot(runtime, { kind: 'run-finalize', key, principal, scope: run.scope, run, expectedRunVersion: body.expectedRunVersion, request: body,
        source: () => acceptedReference(runtime, principal, run.scope, run.baseRevisionId) });
      return reply.header('Idempotency-Key', key).send(await legacyRunView(runtime, result.run));
    }
    const file = journalPath(runtime, 'run-commands', { scope: run.scope, runId: run.id, actorId: principal.actorId, kind: 'finalize', key });
    const finalizeRequest = await serialize(file, runtime.control, run.scope, async () => {
      const previous = await loadJournal<{ digest: string; request: { expectedRunVersion: number; submissionId?: string } }>(file);
      if (previous && previous.digest !== hash(body)) throw new WorkspaceError('IDEMPOTENCY_KEY_REUSED', 'Finalize key belongs to another request');
      if (previous) return previous.request;
      const request = { expectedRunVersion: body.expectedRunVersion ?? run.version, ...(body.submissionId ? { submissionId: body.submissionId } : {}) };
      await saveJournal(file, { digest: hash(body), request }); return request;
    });
    const result = await runtime.lifecycle.claimFinalization({ principal, scope: runScope(run), idempotencyKey: key, request: finalizeRequest });
    runtime.schedule(result.operation, result.replayed);
    const deadline = Date.now() + 10_000;
    let current = await runtime.control.getRun(run.scope, run.id);
    while (current?.state === 'finalizing' && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 10)); current = await runtime.control.getRun(run.scope, run.id); }
    if (!current || current.state === 'finalizing') throw new WorkspaceError('PUBLICATION_OUTCOME_UNKNOWN', 'Reuse the original finalize key before cleanup', { operationId: result.operation.id, retryable: true });
    return reply.header('Idempotency-Key', key).send(await legacyRunView(runtime, current));
  });
  app.post('/runs/:id/abort', async request => {
    const run = await resolveRun(runtime, request, true); const body = z.object({ expectedRunVersion: z.number().int().positive().optional(), reason: z.string().min(1).default('Manually aborted') }).parse(request.body ?? {});
    const result = await runtime.lifecycle.abort({ principal: identity(request), scope: runScope(run), idempotencyKey: commandKey(request), request: { expectedRunVersion: body.expectedRunVersion ?? (run.state === 'aborted' ? run.version - 1 : run.version), reason: body.reason } });
    return legacyRunView(runtime, result.value);
  });
}
