import { FastifyRequest, FastifyReply } from "fastify";
import { getDb } from "../db";
import { WorkspaceError } from "../domain";

/**
 * Get the customerId from the request, or null if admin (no scoping).
 */
export function getRequestCustomerId(request: FastifyRequest): string | null {
  if (!request.principal) throw new WorkspaceError("UNAUTHENTICATED", "An authenticated principal is required");
  if (request.principal.kind === "administrator" && request.isAdmin === true) return request.selectedCustomerId ?? null;
  if (request.principal.kind === "administrator") throw new WorkspaceError("FORBIDDEN", "Verified administrator authority is required");
  return request.principal.customerId;
}

/**
 * Verify the authenticated customer owns the given workspace.
 * Returns true if allowed, sends 404 and returns false if not.
 * Admin requests always pass.
 */
export function verifyWorkspaceOwnership(
  request: FastifyRequest,
  reply: FastifyReply,
  workspaceId: string
): boolean {
  const customerId = getRequestCustomerId(request);
  if (customerId === null) return true; // admin

  const db = getDb();
  const row = db
    .prepare("SELECT customer_id FROM workspaces WHERE id = ? AND status != 'deleted'")
    .get(workspaceId) as { customer_id: string } | undefined;

  if (!row || row.customer_id !== customerId) {
    reply.code(404).send({ error: "Workspace not found" });
    return false;
  }

  return true;
}
