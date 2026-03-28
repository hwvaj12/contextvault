import { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { z } from "zod";
import {
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  softDeleteWorkspace,
} from "../services/workspace.service";

const CreateWorkspaceSchema = z.object({
  customerId: z.string().min(1),
  name: z.string().min(1),
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
      const workspace = createWorkspace(id, body.customerId, body.name);
      reply.code(201).send(workspace);
    }
  );

  // GET /workspaces - List workspaces
  app.get(
    "/workspaces",
    {
      schema: {
        description: "List all workspaces",
        tags: ["Workspaces"],
        response: {
          200: {
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
        },
      },
    },
    async (_request, reply) => {
      reply.send(listWorkspaces());
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
      const workspace = getWorkspace(id);

      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      reply.send(workspace);
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
      softDeleteWorkspace(id);
      reply.code(204).send();
    }
  );
}
