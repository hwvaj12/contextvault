/** Explicit composition facade. Catalog authority never falls back to JSON or Git pointers. */
import type { Principal, WorkspaceScope } from '../domain';
import type { WorkspaceRuntime } from '../config/runtime';
export type { Workspace } from '../domain';
export { workspaceMetadata as getWorkspace, listWorkspaceMetadata as listWorkspaces, deleteWorkspace as softDeleteWorkspace, deleteWorkspace } from '../application/workspaces/admin/metadata';
export { copyWorkspace as cloneWorkspace } from '../application/workspaces/admin/copy';
export { bundleMetadata } from '../application/workspaces/admin/bundles';
export async function createWorkspace(runtime: WorkspaceRuntime, principal: Principal, customerId: string, name: string, idempotencyKey: string) {
  return runtime.lifecycle.createWorkspace({ principal, request: { customerId, name }, idempotencyKey });
}
export async function exportWorkspace(runtime: WorkspaceRuntime, principal: Principal, scope: WorkspaceScope, idempotencyKey: string, revisionId?: string) {
  return runtime.bundles.export(runtime, principal, scope, idempotencyKey, revisionId);
}
