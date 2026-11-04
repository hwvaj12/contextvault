import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  registerWebhook,
  listWebhooks,
  deleteWebhook,
  getWebhook,
  WebhookEvent,
  WEBHOOK_EVENTS,
} from "../services/webhook.service";
import { getDb } from "../db";
import { SqliteControlStore } from "../adapters/control/sqlite-control-store";
import { CatalogAccessPolicy } from "../adapters/access/catalog-access-policy";
import { CONFIGURED_ADMINISTRATOR_ACTOR } from "../db/configured-administrator";
import { WorkspaceError, type CustomerId } from "../domain";
import type { FastifyRequest } from "fastify";

async function authorize(request: FastifyRequest, customerId: string): Promise<void> {
  const principal = request.principal;
  if (!principal) throw new WorkspaceError("UNAUTHENTICATED", "An authenticated principal is required");
  if (request.selectedCustomerId && request.selectedCustomerId !== customerId) throw new WorkspaceError("FORBIDDEN", "Selected customer does not match webhook scope");
  const scope = { customerId: customerId as CustomerId };
  const control = new SqliteControlStore(getDb());
  // The configured root administrator retains legacy customer management. A missing identity never enters this branch.
  if (principal.kind === "administrator" && request.isAdmin === true && !request.selectedCustomerId && principal.actorId === CONFIGURED_ADMINISTRATOR_ACTOR) {
    const current = await control.getAuthority(scope, principal);
    if (current && !current.revokedAt && current.actorId === principal.actorId && current.credentialVersion === principal.credential.version && current.permissionEpoch === principal.permissionEpoch) return;
    throw new WorkspaceError("CREDENTIAL_REVOKED", "Administrator authority is no longer current");
  }
  const decision = await new CatalogAccessPolicy(control).evaluate(principal, "workspace:admin", scope);
  if (!decision.allowed) throw new WorkspaceError(decision.code, decision.message);
}

const RegisterWebhookSchema = z.object({
  customerId: z.string().min(1),
  url: z.string().url(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  secret: z.string().optional(),
});

export async function webhookRoutes(app: FastifyInstance) {
  // POST /webhooks - Register a webhook
  app.post(
    "/webhooks",
    {
      schema: {
        description: "Register a webhook endpoint",
        tags: ["Webhooks"],
        body: {
          type: "object",
          required: ["customerId", "url", "events"],
          properties: {
            customerId: { type: "string" },
            url: { type: "string", format: "uri" },
            events: {
              type: "array",
              items: { type: "string", enum: WEBHOOK_EVENTS },
            },
            secret: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const body = RegisterWebhookSchema.parse(request.body);
      await authorize(request, body.customerId);
      const webhook = registerWebhook(
        body.customerId,
        body.url,
        body.events as WebhookEvent[],
        body.secret
      );
      reply.code(201).send(webhook);
    }
  );

  // GET /webhooks - List webhooks for a customer
  app.get(
    "/webhooks",
    {
      schema: {
        description: "List webhooks for a customer",
        tags: ["Webhooks"],
        querystring: {
          type: "object",
          required: ["customerId"],
          properties: {
            customerId: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { customerId } = request.query as { customerId: string };
      if (!customerId) {
        return reply.code(400).send({ error: "customerId query param is required" });
      }
      await authorize(request, customerId);
      const webhooks = listWebhooks(customerId);
      reply.send({ data: webhooks });
    }
  );

  // DELETE /webhooks/:id - Remove a webhook
  app.delete(
    "/webhooks/:id",
    {
      schema: {
        description: "Delete a webhook",
        tags: ["Webhooks"],
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
      const customerId = request.principal.kind === "administrator" ? request.selectedCustomerId : request.principal.customerId;
      const webhook = getWebhook(id, customerId);
      if (!webhook) return reply.code(404).send({ error: "Webhook not found" });
      await authorize(request, webhook.customerId);
      const deleted = deleteWebhook(id, webhook.customerId);
      if (!deleted) {
        return reply.code(404).send({ error: "Webhook not found" });
      }
      reply.code(204).send();
    }
  );
}
