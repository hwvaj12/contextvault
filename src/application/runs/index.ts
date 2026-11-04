import { WorkspaceError, type AbortRequest, type CreateWorkspaceRequest, type FinalizationOperation, type FinalizeRequest, type HeartbeatRequest, type OpenRunRequest, type Operation, type Workspace, type WorkspaceCreationOperation, type WorkspaceScope } from "../../domain";
import type { ExpiredActiveRun } from "../../ports/control-store";
import { claimWorkspaceCreation } from "../workspaces/create";
import { openRun } from "../workspaces/open";
import { abort, claimFinalization, expireActiveRun, heartbeat, type RunCommand } from "./commands";
import { processOperation, renewProcessingClaim, type ProcessOperationInput } from "./process";
import { LifecycleRuntime, type AuthenticatedCommand, type LifecycleDependencies } from "./runtime";
export type { LifecycleDependencies, AuthenticatedCommand } from "./runtime";
export type { ProcessOperationInput } from "./process";
export type { RunCommand } from "./commands";

/** Pending creation has no accepted workspace. HTTP composition may map pending to 202 and accepted to 201. */
export type WorkspaceCreationResult =
  | { status: "pending"; workspace: null; operation: WorkspaceCreationOperation; replayed: boolean }
  | { status: "accepted"; workspace: Workspace; operation: WorkspaceCreationOperation; replayed: boolean };

export class WorkspaceLifecycle {
  readonly runtime: LifecycleRuntime;
  constructor(dependencies: LifecycleDependencies) { this.runtime = new LifecycleRuntime(dependencies); }
  async claimWorkspaceCreation(input: AuthenticatedCommand<CreateWorkspaceRequest>) { return claimWorkspaceCreation(this.runtime, input); }
  async createWorkspace(input: AuthenticatedCommand<CreateWorkspaceRequest>): Promise<WorkspaceCreationResult> {
    const claimed = await this.claimWorkspaceCreation(input);
    const operation = await this.convenienceOperation(claimed.operation, claimed.replayed);
    if (operation.kind !== "workspace:create") throw new WorkspaceError("PUBLICATION_OUTCOME_UNKNOWN", "Workspace creation requires reconciliation", { operationId: operation.id, retryable: true });
    if (operation.state === "pending" || operation.state === "processing") return { status: "pending", workspace: null, operation, replayed: claimed.replayed };
    if (operation.state !== "succeeded") throw new WorkspaceError(operation.error?.code ?? "PUBLICATION_OUTCOME_UNKNOWN", operation.error?.message ?? "Workspace creation requires reconciliation", { operationId: operation.id, retryable: false });
    // The succeeded operation proves atomic creation acceptance. Return its immutable result,
    // including when the current workspace has advanced since the original creation response.
    const workspace = structuredClone(operation.intent.workspace);
    return { status: "accepted", workspace, operation, replayed: claimed.replayed };
  }
  openRun(input: AuthenticatedCommand<OpenRunRequest> & { scope: WorkspaceScope }) { return openRun(this.runtime, input); }
  claimFinalization(input: RunCommand<FinalizeRequest>) { return claimFinalization(this.runtime, input); }
  async finalize(input: RunCommand<FinalizeRequest>): Promise<FinalizationOperation> {
    const claimed = await this.claimFinalization(input);
    const operation = await this.convenienceOperation(claimed.operation, claimed.replayed);
    if (operation.kind !== "finalize") throw new WorkspaceError("PUBLICATION_OUTCOME_UNKNOWN", "Finalization requires reconciliation", { operationId: operation.id, retryable: true });
    return operation;
  }
  /** Only the successful initial claimant starts work. Replays observe durable state, regardless of local owner identity. */
  private async convenienceOperation(operation: WorkspaceCreationOperation | FinalizationOperation, replayed: boolean): Promise<Operation> {
    if (!replayed && operation.state === "processing" && operation.claim?.ownerId === this.runtime.dependencies.ownerId && operation.claim.expiresAt > this.runtime.now()) return this.processOperation({ scope: operation.scope, operationId: operation.id, processingFence: operation.claim.fence });
    if (operation.state === "succeeded" || operation.state === "failed") return operation;
    // An in-flight or expired claim remains pending. Only explicit recovery may acquire a newer fence.
    try {
      const current = await this.runtime.control.getOperation(operation.scope, operation.id);
      if (current && current.kind === operation.kind) return current;
    } catch { /* Preserve the known operation identity when reconciliation is unavailable. */ }
    throw new WorkspaceError("PUBLICATION_OUTCOME_UNKNOWN", "Operation requires reconciliation", { operationId: operation.id, retryable: true });
  }
  processOperation(input: ProcessOperationInput) { return processOperation(this.runtime, input); }
  renewProcessingClaim(input: ProcessOperationInput) { return renewProcessingClaim(this.runtime, input); }
  abort(input: RunCommand<AbortRequest>) { return abort(this.runtime, input); }
  heartbeat(input: RunCommand<HeartbeatRequest>) { return heartbeat(this.runtime, input); }
  expireActiveRun(input: ExpiredActiveRun) { return expireActiveRun(this.runtime, input); }
}
