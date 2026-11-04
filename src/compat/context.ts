import type { FastifyRequest } from 'fastify';
import { canonicalJson, WorkspaceError, type CustomerScope, type Principal, type Run, type RunScope, type WorkspaceScope } from '../domain';
import type { WorkspaceRuntime } from '../config/runtime';
import type { ResourceLookupContext } from '../ports/control-store';
import { runView } from '../routes/v1/views';
import { randomUUID } from 'node:crypto';

export function identity(request: FastifyRequest): Principal {
  if (!request.principal) throw new WorkspaceError('UNAUTHENTICATED', 'An authenticated principal is required');
  return request.principal;
}
export function customerScope(request: FastifyRequest): CustomerScope {
  const principal = identity(request);
  const customerId = principal.kind === 'administrator' ? request.selectedCustomerId : principal.customerId;
  if (!customerId) throw new WorkspaceError('INVALID_REQUEST', 'Administrators must select X-ContextVault-Customer-Id');
  const selected = request.headers['x-contextvault-customer-id'];
  if (selected !== undefined && selected !== customerId) throw new WorkspaceError('FORBIDDEN', 'Customer selection differs from authenticated customer');
  return { customerId: customerId as CustomerScope['customerId'] };
}
export function workspaceScope(request: FastifyRequest): WorkspaceScope {
  const id = (request.params as { id: string }).id;
  if (typeof id !== 'string' || !id || id.length > 255) throw new WorkspaceError('INVALID_REQUEST', 'Workspace ID is required');
  return { ...customerScope(request), workspaceId: id as WorkspaceScope['workspaceId'] };
}
export function commandKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (key !== undefined && (typeof key !== 'string' || !key || key.length > 256)) throw new WorkspaceError('INVALID_REQUEST', 'Invalid Idempotency-Key');
  return key as string | undefined ?? randomUUID();
}
export const runScope = (run: Run): RunScope => ({ ...run.scope, runId: run.id });
export async function authorizedWorkspace(runtime: WorkspaceRuntime, request: FastifyRequest, action: 'workspace:read' | 'workspace:write' | 'workspace:restore' | 'run:read') {
  const scope = workspaceScope(request);
  await runtime.lifecycle.runtime.authorize(identity(request), action, scope);
  const workspace = await runtime.control.getWorkspace(scope);
  if (!workspace) throw new WorkspaceError('WORKSPACE_NOT_FOUND', 'Workspace not found in this customer scope');
  if (workspace.status !== 'active' && action !== 'run:read') throw new WorkspaceError('WORKSPACE_INACTIVE', 'Workspace is not active');
  return { scope, workspace };
}
export async function resolveRun(runtime: WorkspaceRuntime, request: FastifyRequest, own = false) {
  const principal = identity(request); const scope = customerScope(request);
  let context: ResourceLookupContext;
  if (principal.kind === 'administrator') {
    const authorization = await runtime.lifecycle.runtime.authorize(principal, 'run:read', scope);
    context = { kind: 'administrator', principal, scope, authorization: { ...authorization, action: 'run:read', scope } };
  } else context = { kind: 'tenant', principal };
  const run = await runtime.control.resolveRun(context, (request.params as { id: string }).id as Run['id']);
  if (!run) throw new WorkspaceError('RUN_NOT_FOUND', 'Run not found in this customer scope');
  if (own && (run.principal.actorId !== principal.actorId || canonicalJson(run.principal.credential) !== canonicalJson(principal.credential) || run.principal.permissionEpoch !== principal.permissionEpoch)) throw new WorkspaceError('FORBIDDEN', 'Run belongs to another authenticated identity');
  return run;
}
export async function legacyRunView(runtime: WorkspaceRuntime, run: Run) {
  const cleanup = await runtime.control.getCleanup(run.scope, run.cleanupId);
  const view = runView(run, cleanup ?? { state: 'pending', version: 0, attempts: 0, lastError: null }, runtime.now());
  return { ...view, agentId: run.agentLabel, baseCommit: run.baseRevisionId, workspaceHeadAtStart: run.baseRevisionId,
    finalCommit: run.outcome?.revisionId ?? null, status: cleanup?.state === 'complete' ? 'cleaned_up' : run.state === 'finalized' ? 'merged' : run.state === 'active' ? 'running' : run.state,
    mergeStatus: run.state === 'finalized' ? 'merged' : run.state === 'conflicted' ? 'conflicted' : run.state === 'failed' ? 'failed' : 'pending',
    startedAt: run.createdAt, completedAt: run.outcome?.completedAt ?? null, failureReason: run.outcome?.errorCode ?? null, sandboxPath: null };
}
