import { FastifyRequest, FastifyReply } from "fastify";
import { getDb } from "../db";

/**
 * Get the customerId from the request, or null if admin (no scoping).
 */
export function getRequestCustomerId(request: FastifyRequest): string | null {
  if ((request as any).isAdmin) return null;
  return (request as any).customerId ?? null;
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
