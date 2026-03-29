import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  registerWebhook,
  listWebhooks,
  deleteWebhook,
  WebhookEvent,
} from "../services/webhook.service";

const VALID_EVENTS: WebhookEvent[] = [
  "workspace.created",
  "workspace.deleted",
  "sandbox.checked_out",
  "sandbox.destroyed",
  "run.started",
  "run.completed",
  "run.failed",
  "commit.created",
];

const RegisterWebhookSchema = z.object({
  customerId: z.string().min(1),
  url: z.string().url(),
  events: z.array(z.enum(VALID_EVENTS as [string, ...string[]])).min(1),
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
              items: { type: "string", enum: VALID_EVENTS },
            },
            secret: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const body = RegisterWebhookSchema.parse(request.body);
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
      const deleted = deleteWebhook(id);
      if (!deleted) {
        return reply.code(404).send({ error: "Webhook not found" });
      }
      reply.code(204).send();
    }
  );
}
