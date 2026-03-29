import { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { z } from "zod";
import {
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  softDeleteWorkspace,
  bulkDeleteWorkspaces,
} from "../services/workspace.service";

const CreateWorkspaceSchema = z.object({
  customerId: z.string().min(1),
  name: z.string().min(1),
});

const BulkDeleteSchema = z.object({
  workspaceIds: z.array(z.string().min(1)).min(1).max(100),
});

export async function workspaceRoutes(app: FastifyInstance) {
  // POST /workspaces - Create workspace
  app.post(
    "/workspaces",
    {
      schema: {
        description: "Create a new workspace",
        tags: ["Workspaces"],
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
              latestCommitId: { type: ["string", "null"] },
              createdAt: { type: "string" },
              updatedAt: { type: "string" },
              deletedAt: { type: ["string", "null"] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = CreateWorkspaceSchema.parse(request.body);
      const id = `ws_${ulid()}`;
      const workspace = await createWorkspace(id, body.customerId, body.name);
      reply.code(201).send(workspace);
    }
  );

  // GET /workspaces - List workspaces (with pagination)
  app.get(
    "/workspaces",
    {
      schema: {
        description: "List workspaces with pagination",
        tags: ["Workspaces"],
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            offset: { type: "integer", minimum: 0, default: 0 },
            customerId: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              data: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    customerId: { type: "string" },
                    name: { type: "string" },
                    latestCommitId: { type: ["string", "null"] },
                    createdAt: { type: "string" },
                    updatedAt: { type: "string" },
                    deletedAt: { type: ["string", "null"] },
                  },
                },
              },
              pagination: {
                type: "object",
                properties: {
                  total: { type: "integer" },
                  limit: { type: "integer" },
                  offset: { type: "integer" },
                  hasMore: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { limit = 50, offset = 0, customerId } = request.query as {
        limit?: number;
        offset?: number;
        customerId?: string;
      };

      const result = await listWorkspaces({ limit, offset, customerId });
      reply.send({
        data: result.workspaces,
        pagination: {
          total: result.total,
          limit,
          offset,
          hasMore: offset + result.workspaces.length < result.total,
        },
      });
    }
  );

  // GET /workspaces/:id - Get workspace
  app.get(
    "/workspaces/:id",
    {
      schema: {
        description: "Get a single workspace",
        tags: ["Workspaces"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const workspace = await getWorkspace(id);

      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      reply.send(workspace);
    }
  );

  // POST /workspaces/bulk-delete - Hard delete multiple workspaces
  app.post(
    "/workspaces/bulk-delete",
    {
      schema: {
        description: "Hard delete multiple workspaces (removes DB records, repos, and sandboxes)",
        tags: ["Workspaces"],
        body: {
          type: "object",
          required: ["workspaceIds"],
          properties: {
            workspaceIds: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 100,
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              deleted: { type: "integer" },
              failed: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    error: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = BulkDeleteSchema.parse(request.body);
      const result = await bulkDeleteWorkspaces(body.workspaceIds);
      reply.send(result);
    }
  );

  // DELETE /workspaces/:id - Soft delete workspace
  app.delete(
    "/workspaces/:id",
    {
      schema: {
        description: "Soft delete a workspace",
        tags: ["Workspaces"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await softDeleteWorkspace(id);
      reply.code(204).send();
    }
  );
}
