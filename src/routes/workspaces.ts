import { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { z } from "zod";
import {
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  softDeleteWorkspace,
  bulkDeleteWorkspaces,
  cloneWorkspace,
} from "../services/workspace.service";
import { getRequestCustomerId, verifyWorkspaceOwnership } from "../middleware/tenant";

const CreateWorkspaceSchema = z.object({
  customerId: z.string().min(1),
  name: z.string().min(1),
});

const BulkDeleteSchema = z.object({
  workspaceIds: z.array(z.string().min(1)).min(1).max(100),
});

const CloneWorkspaceSchema = z.object({
  targetCustomerId: z.string().min(1),
  name: z.string().min(1).optional(),
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
      const tenantId = getRequestCustomerId(request);

      // Non-admin users can only create workspaces for themselves
      if (tenantId && body.customerId !== tenantId) {
        return (reply as any).code(403).send({ error: "Cannot create workspace for another customer" });
      }

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

      // Non-admin users always scoped to their own customer
      const tenantId = getRequestCustomerId(request);
      const effectiveCustomerId = tenantId || customerId;

      const result = await listWorkspaces({ limit, offset, customerId: effectiveCustomerId });
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

      if (!verifyWorkspaceOwnership(request, reply, id)) return;

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
      const tenantId = getRequestCustomerId(request);

      // Filter to only workspaces owned by this customer
      let idsToDelete = body.workspaceIds;
      if (tenantId) {
        const { getDb } = await import("../db");
        const db = getDb();
        idsToDelete = body.workspaceIds.filter((wsId) => {
          const row = db
            .prepare("SELECT customer_id FROM workspaces WHERE id = ?")
            .get(wsId) as { customer_id: string } | undefined;
          return row?.customer_id === tenantId;
        });
      }

      const result = await bulkDeleteWorkspaces(idsToDelete);
      reply.send(result);
    }
  );

  // POST /workspaces/:id/clone - Clone workspace to new customer/workspace
  app.post(
    "/workspaces/:id/clone",
    {
      schema: {
        description: "Clone a workspace to a new customer or as a new workspace",
        tags: ["Workspaces"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          required: ["targetCustomerId"],
          properties: {
            targetCustomerId: { type: "string" },
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
      const { id } = request.params as { id: string };

      if (!verifyWorkspaceOwnership(request, reply, id)) return;

      const body = CloneWorkspaceSchema.parse(request.body);
      try {
        const cloned = await cloneWorkspace(id, body.targetCustomerId, body.name);
        reply.code(201).send(cloned);
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes("not found")) {
          return (reply as any).code(404).send({ error: message });
        }
        throw err;
      }
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

      if (!verifyWorkspaceOwnership(request, reply, id)) return;

      await softDeleteWorkspace(id);
      reply.code(204).send();
    }
  );
}
