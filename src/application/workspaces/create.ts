import { manifestDigest, WorkspaceError, type CreateWorkspaceRequest, type WorkspaceCreationIntent, type WorkspaceScope } from "../../domain";
import { type AuthenticatedCommand, LifecycleRuntime } from "../runs/runtime";

export async function claimWorkspaceCreation(runtime: LifecycleRuntime, input: AuthenticatedCommand<CreateWorkspaceRequest>) {
  input = structuredClone(input);
  if (!input.request.customerId || typeof input.request.name !== "string" || !input.request.name.trim() || input.request.name.length > 255) throw new WorkspaceError("INVALID_REQUEST", "Workspace customer and name are required");
  const customer = { customerId: input.request.customerId as WorkspaceScope["customerId"] };
  const authorization = await runtime.authorize(input.principal, "workspace:create", customer);
  const command = runtime.command("workspace:create", input, customer);
  const existing = await runtime.control.findOperation(command.idempotencyScope, command.idempotencyKey);
  let intent: WorkspaceCreationIntent;
  if (existing) {
    if (existing.kind !== "workspace:create") throw new WorkspaceError("IDEMPOTENCY_KEY_REUSED", "Creation key belongs to another operation");
    intent = { ...existing.intent, request: { method: "POST", path: "/v1/workspaces", body: input.request } };
  } else {
    const scope: WorkspaceScope = { ...customer, workspaceId: runtime.id("workspace") as any };
    const binding = await runtime.dependencies.createBinding(scope, runtime.id("binding") as any, command.requestedAt);
    const revisionId = runtime.id("revision") as WorkspaceCreationIntent["workspace"]["currentRevisionId"];
    const initialManifest = { schemaVersion: 1 as const, entries: [] as const };
    intent = {
      schemaVersion: 1, kind: "workspace:create", request: { method: "POST", path: "/v1/workspaces", body: input.request },
      workspace: { id: scope.workspaceId, customerId: scope.customerId, name: input.request.name, currentRevisionId: revisionId, version: 1, status: "active", storageBindingId: binding.id, bindingGeneration: binding.generation, createdAt: command.requestedAt, updatedAt: command.requestedAt }, binding,
      candidateIdentity: { candidateId: runtime.id("candidate") as any, revisionId, operationId: command.operationId, scope: { ...scope, storageBindingId: binding.id, bindingGeneration: binding.generation }, parentRevisionId: null, createdAt: command.requestedAt },
      initialManifest, initialManifestDigest: manifestDigest(initialManifest),
    };
  }
  const now = runtime.now();
  return runtime.control.claimWorkspaceCreation({ principal: input.principal, authorization, command, intent, claim: { ownerId: runtime.dependencies.ownerId, fence: 1, expiresAt: runtime.until(now, runtime.processingTtlMs) }, now });
}
