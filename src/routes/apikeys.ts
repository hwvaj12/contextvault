import { FastifyInstance } from "fastify";
import { z } from "zod";
import { createApiKey, listApiKeys, revokeApiKey } from "../services/apikey.service";

const CreateApiKeySchema = z.object({
  customerId: z.string().min(1),
  name: z.string().min(1),
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
      const result = createApiKey(body.customerId, body.name);
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
      const customerId = (request as any).customerId as string | undefined;
      if (!customerId) {
        return reply.code(400).send({ error: "Customer context required" });
      }
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
      const deleted = revokeApiKey(id);
      if (!deleted) {
        return reply.code(404).send({ error: "API key not found" });
      }
      reply.code(204).send();
    }
  );
}
