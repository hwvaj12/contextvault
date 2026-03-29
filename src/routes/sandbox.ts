import { FastifyInstance } from "fastify";
import { z } from "zod";
import { getWorkspace } from "../services/workspace.service";
import {
  checkoutSandbox,
  getSandboxStatus,
  commitSandbox,
  destroySandbox,
} from "../services/sandbox.service";
import { verifyWorkspaceOwnership } from "../middleware/tenant";

const CommitSandboxSchema = z.object({
  agentId: z.string().optional(),
  taskId: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

function handleServiceError(error: any, reply: any) {
  if (error.code === "SANDBOX_EXISTS") {
    return reply.code(409).send({ error: { code: "SANDBOX_EXISTS", message: error.message } });
  }
  if (error.code === "SANDBOX_NOT_FOUND") {
    return reply.code(404).send({ error: { code: "SANDBOX_NOT_FOUND", message: error.message } });
  }
  if (error.code === "WORKSPACE_NOT_FOUND") {
    return reply.code(404).send({ error: { code: "WORKSPACE_NOT_FOUND", message: error.message } });
  }
  if (error.code === "NO_CHANGES") {
    return reply.code(400).send({ error: { code: "NO_CHANGES", message: error.message } });
  }
  return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: error.message } });
}

export async function sandboxRoutes(app: FastifyInstance) {
  // POST /workspaces/:id/sandbox - Checkout (create sandbox)
  app.post(
    "/workspaces/:id/sandbox",
    {
      schema: {
        description: "Create a sandbox (checkout workspace)",
        tags: ["Sandbox"],
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
        return reply.code(404).send({ error: { code: "WORKSPACE_NOT_FOUND", message: `Workspace ${id} not found` } });
      }

      try {
        const result = await checkoutSandbox(id);
        reply.code(201).send(result);
      } catch (error: any) {
        return handleServiceError(error, reply);
      }
    }
  );

  // GET /workspaces/:id/sandbox - Get sandbox status
  app.get(
    "/workspaces/:id/sandbox",
    {
      schema: {
        description: "Get sandbox status",
        tags: ["Sandbox"],
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

      try {
        const status = await getSandboxStatus(id);
        reply.send(status);
      } catch (error: any) {
        return handleServiceError(error, reply);
      }
    }
  );

  // POST /workspaces/:id/sandbox/commit - Commit sandbox changes
  app.post(
    "/workspaces/:id/sandbox/commit",
    {
      schema: {
        description: "Commit sandbox changes back to workspace",
        tags: ["Sandbox"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: {
            agentId: { type: "string" },
            taskId: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      if (!verifyWorkspaceOwnership(request, reply, id)) return;

      const body = CommitSandboxSchema.parse(request.body || {});

      try {
        const result = await commitSandbox(id, body);
        reply.code(201).send(result);
      } catch (error: any) {
        return handleServiceError(error, reply);
      }
    }
  );

  // DELETE /workspaces/:id/sandbox - Destroy sandbox
  app.delete(
    "/workspaces/:id/sandbox",
    {
      schema: {
        description: "Destroy a sandbox",
        tags: ["Sandbox"],
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

      try {
        const result = await destroySandbox(id);
        reply.send(result);
      } catch (error: any) {
        return handleServiceError(error, reply);
      }
    }
  );
}
