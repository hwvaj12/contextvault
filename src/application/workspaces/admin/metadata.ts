import { WorkspaceError, type CustomerScope, type Principal, type Workspace, type WorkspaceScope } from '../../../domain';
import type { WorkspaceRuntime } from '../../../config/runtime';
export const legacyWorkspace = (workspace: Workspace) => ({ id: workspace.id, customerId: workspace.customerId, name: workspace.name, latestCommitId: workspace.currentRevisionId, createdAt: workspace.createdAt, updatedAt: workspace.updatedAt, deletedAt: workspace.status === 'deleted' ? workspace.updatedAt : null });
export async function listWorkspaceMetadata(runtime: WorkspaceRuntime, principal: Principal, scope: CustomerScope, offset: number, limit: number) {
  await runtime.lifecycle.runtime.authorize(principal, 'workspace:read', scope); const result = await runtime.control.listWorkspaceMetadata(scope, offset, limit);
  await runtime.lifecycle.runtime.authorize(principal, 'workspace:read', scope); return result;
}
export async function workspaceMetadata(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope) {
  await runtime.lifecycle.runtime.authorize(principal, 'workspace:read', scope); const workspace = await runtime.control.getWorkspace(scope);
  if (!workspace) throw new WorkspaceError('WORKSPACE_NOT_FOUND', 'Workspace not found'); return workspace;
}
export async function deleteWorkspace(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, key: string, expectedWorkspaceVersion?: number, reason = 'caller requested deletion') {
  const authorization = await runtime.lifecycle.runtime.authorize(principal, 'workspace:delete', scope); const workspace = await runtime.control.getWorkspace(scope);
  if (!workspace) throw new WorkspaceError('WORKSPACE_NOT_FOUND', 'Workspace not found');
  const command = runtime.lifecycle.runtime.command('workspace:status', { principal, idempotencyKey: key, request: { expectedWorkspaceVersion: expectedWorkspaceVersion ?? null, reason } }, scope);
  if (workspace.status === 'deleted' && !(await runtime.control.findOperation(command.idempotencyScope, command.idempotencyKey))) return workspace;
  return (await runtime.control.transitionWorkspaceStatus({ scope, principal, authorization, command, expectedVersion: expectedWorkspaceVersion ?? workspace.version,
    transition: { from: workspace.status === 'suspended' ? 'suspended' : 'active', to: 'deleted' }, now: runtime.now(), events: runtime.lifecycle.runtime.events({ id: command.operationId, scope, runId: null, principal }, 'workspace.deleted') })).value;
}
