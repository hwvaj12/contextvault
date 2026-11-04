import { WorkspaceError, type OpenRunRequest, type WorkspaceScope } from "../../domain";
import { LifecycleRuntime, type AuthenticatedCommand } from "../runs/runtime";

export async function openRun(runtime: LifecycleRuntime, input: AuthenticatedCommand<OpenRunRequest> & { scope: WorkspaceScope }) {
  input = structuredClone(input);
  const request = input.request;
  if (!["read-only", "read-write"].includes(request.mode) || [request.agentLabel, request.task, request.reason].some(value => typeof value !== "string" || !value.trim() || value.length > 4096)) throw new WorkspaceError("INVALID_REQUEST", "Run mode, agent label, task, and access reason are required");
  const authorization = await runtime.authorize(input.principal, request.mode === "read-only" ? "run:open-read" : "run:open-write", input.scope);
  const command = runtime.command("run:open", input, input.scope);
  return runtime.control.openRun({ scope: input.scope, principal: input.principal, authorization, command, ...request, runId: runtime.id("run") as any, cleanupId: runtime.id("cleanup") as any, expiresAt: runtime.until(command.requestedAt, runtime.leaseTtlMs), createdAt: command.requestedAt });
}
