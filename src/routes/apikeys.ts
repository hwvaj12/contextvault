import { FastifyInstance } from "fastify";
import { z } from "zod";
import { createApiKey, listApiKeys, revokeApiKey } from "../services/apikey.service";
import { getDb } from "../db";
import { canonicalJson, WorkspaceError, type CustomerId } from "../domain";
import { decideAccess } from "../adapters/access/catalog-access-policy";
import { SqliteControlStore } from "../adapters/control/sqlite-control-store";
import { CONFIGURED_ADMINISTRATOR_ACTOR, isCurrentConfiguredAdministrator } from "../db/configured-administrator";
import type { CredentialAuthority } from "../ports/control-store";
import type { FastifyRequest } from "fastify";

async function authorize(request: FastifyRequest, customerId: string) {
  const principal = request.principal;
  if (!principal) throw new WorkspaceError("UNAUTHENTICATED", "An authenticated principal is required");
  if (request.selectedCustomerId && request.selectedCustomerId !== customerId) throw new WorkspaceError("FORBIDDEN", "Selected customer differs from credential scope");
  const control = new SqliteControlStore(getDb()); const scope = { customerId: customerId as CustomerId };
  const current = await control.getAuthority(scope, principal);
  if (principal.kind === "administrator" && request.isAdmin === true && !request.selectedCustomerId && principal.actorId === CONFIGURED_ADMINISTRATOR_ACTOR) {
    if (current && !current.revokedAt && current.credentialVersion === principal.credential.version && current.permissionEpoch === principal.permissionEpoch) return current;
    throw new WorkspaceError("CREDENTIAL_REVOKED", "Administrator authority is no longer current");
  }
  const decision = decideAccess(current, principal, "credential:manage", scope);
  if (!decision.allowed) throw new WorkspaceError(decision.code, decision.message);
  return current!;
}

/** Keep the legacy credential mutation and its source/authority recheck in one immediate transaction. */
function mutateAuthorized<T>(request: FastifyRequest, customerId: string, authorized: CredentialAuthority, work: () => T): T {
  const database = getDb();
  return database.transaction(() => {
    const principal = request.principal!;
    const row = database.prepare("SELECT data FROM catalog_records WHERE kind='authority' AND id=?").get(principal.credential.id) as { data: string } | undefined;
    const current = row ? JSON.parse(row.data) as CredentialAuthority : null;
    const source = database.prepare("SELECT data FROM catalog_records WHERE kind='credential-source' AND id=?").get(principal.credential.id) as { data: string } | undefined;
    const key = principal.credential.kind === "api-key" ? database.prepare("SELECT customer_id FROM api_keys WHERE id=?").get(principal.credential.id) as { customer_id: string } | undefined : undefined;
    if (!current || canonicalJson(current) !== canonicalJson(authorized) || !source || JSON.parse(source.data).kind !== principal.credential.kind || !isCurrentConfiguredAdministrator(database, current)
      || (principal.credential.kind === "api-key" && key?.customer_id !== customerId)) throw new WorkspaceError("CREDENTIAL_REVOKED", "Credential authority changed before mutation");
    return work();
  }).immediate();
}

const CreateApiKeySchema = z.object({
  customerId: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
});

export async function apiKeyRoutes(app: FastifyInstance) {
  // POST /api-keys - Create a new API key
  app.post(
    "/api-keys",
    {
      schema: {
        description: "Create a new API key for a customer",
        tags: ["API Keys"],
        body: {
          type: "object",
          required: ["customerId", "name"],
          properties: {
            customerId: { type: "string" },
            name: { type: "string" },
          },
        },
        response: {
          201: {
            type: "object",
            properties: {
              id: { type: "string" },
              customerId: { type: "string" },
              name: { type: "string" },
              plainKey: { type: "string" },
              createdAt: { type: "string" },
              lastUsedAt: { type: ["string", "null"] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = CreateApiKeySchema.parse(request.body);
      const authorization = await authorize(request, body.customerId);
      const result = mutateAuthorized(request, body.customerId, authorization, () => createApiKey(body.customerId, body.name));
      reply.code(201).send(result);
    }
  );

  // GET /api-keys - List keys for the authenticated customer
  app.get(
    "/api-keys",
    {
      schema: {
        description: "List API keys for the authenticated customer",
        tags: ["API Keys"],
      },
    },
    async (request, reply) => {
      const customerId = request.principal?.kind === "administrator" ? request.selectedCustomerId : request.principal?.customerId;
      if (!customerId) {
        return reply.code(400).send({ error: "Customer context required" });
      }
      await authorize(request, customerId);
      const keys = listApiKeys(customerId);
      reply.send({ data: keys });
    }
  );

  // DELETE /api-keys/:id - Revoke an API key
  app.delete(
    "/api-keys/:id",
    {
      schema: {
        description: "Revoke an API key",
        tags: ["API Keys"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!request.principal) throw new WorkspaceError("UNAUTHENTICATED", "An authenticated principal is required");
      const row = getDb().prepare("SELECT customer_id FROM api_keys WHERE id=?").get(id) as { customer_id: string } | undefined;
      if (!row || (request.principal.kind !== "administrator" && row.customer_id !== request.principal.customerId)) return reply.code(404).send({ error: "API key not found" });
      const authorization = await authorize(request, row.customer_id);
      const deleted = mutateAuthorized(request, row.customer_id, authorization, () => {
        const current = getDb().prepare("SELECT customer_id FROM api_keys WHERE id=?").get(id) as { customer_id: string } | undefined;
        return current?.customer_id === row.customer_id ? revokeApiKey(id) : false;
      });
      if (!deleted) {
        return reply.code(404).send({ error: "API key not found" });
      }
      reply.code(204).send();
    }
  );
}
