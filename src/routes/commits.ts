import { FastifyInstance } from "fastify";
import { z } from "zod";
import { getWorkspace } from "../services/workspace.service";
import { getCommitHistory } from "../services/commit.service";
import { deliver } from "../services/webhook.service";
import { getStorage } from "../storage";
import { verifyWorkspaceOwnership } from "../middleware/tenant";

const PushSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().min(1),
      content: z.string(),
    })
  ).min(1),
  metadata: z.object({
    agentId: z.string().optional(),
    taskId: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }).optional().default({}),
});

const RollbackSchema = z.object({
  toVersion: z.string().min(1),
});

export async function commitRoutes(app: FastifyInstance) {
  // POST /workspaces/:id/push
  app.post(
    "/workspaces/:id/push",
    {
      schema: {
        description: "Push state (create a new commit)",
        tags: ["Commits"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          required: ["files"],
          properties: {
            files: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  content: { type: "string" },
                },
                required: ["path", "content"],
              },
            },
            metadata: {
              type: "object",
              properties: {
                agentId: { type: "string" },
                taskId: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      if (!verifyWorkspaceOwnership(request, reply, id)) return;

      const body = PushSchema.parse(request.body);

      const workspace = await getWorkspace(id);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const storage = getStorage();
      const result = await storage.pushCommit(id, body.files, body.metadata);

      const commitResponse = {
        commitId: result.commitId,
        workspaceId: id,
        parentId: result.parentId,
        files: body.files.map((f) => f.path),
        metadata: body.metadata,
        sizeBytes: result.sizeBytes,
        createdAt: result.createdAt,
      };

      deliver("commit.created", { workspaceId: id, commitId: result.commitId });

      reply.code(201).send(commitResponse);
    }
  );

  // GET /workspaces/:id/pull
  app.get(
    "/workspaces/:id/pull",
    {
      schema: {
        description: "Pull latest state or a specific version",
        tags: ["Commits"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        querystring: {
          type: "object",
          properties: { version: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { version, v } = request.query as { version?: string; v?: string };
      const commitRef = version || v;

      if (!verifyWorkspaceOwnership(request, reply, id)) return;

      const workspace = await getWorkspace(id);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const storage = getStorage();
      const result = await storage.pullCommit(id, commitRef);

      if (!result) {
        return reply.send({ commitId: null, files: [], metadata: {} });
      }

      reply.send({
        commitId: result.commitId,
        workspaceId: id,
        parentId: result.parentId,
        files: result.files,
        metadata: result.metadata,
        sizeBytes: result.sizeBytes,
        createdAt: result.createdAt,
      });
    }
  );

  // GET /workspaces/:id/history
  app.get(
    "/workspaces/:id/history",
    {
      schema: {
        description: "List commit history for a workspace",
        tags: ["History"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", default: 20 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { limit } = request.query as { limit?: number };

      if (!verifyWorkspaceOwnership(request, reply, id)) return;

      const workspace = await getWorkspace(id);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const commits = await getCommitHistory(id, limit || 20);
      reply.send({ commits, count: commits.length });
    }
  );

  // GET /workspaces/:id/diff
  app.get(
    "/workspaces/:id/diff",
    {
      schema: {
        description: "Compare two versions",
        tags: ["History"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        querystring: {
          type: "object",
          required: ["from", "to"],
          properties: {
            from: { type: "string" },
            to: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { from, to } = request.query as { from: string; to: string };

      if (!from || !to) {
        return reply
          .code(400)
          .send({ error: "Both 'from' and 'to' query params are required" });
      }

      if (!verifyWorkspaceOwnership(request, reply, id)) return;

      const workspace = await getWorkspace(id);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      try {
        const storage = getStorage();
        const result = await storage.getDiff(id, from, to);
        reply.send({ from, to, files: result.files, summary: result.summary });
      } catch {
        return reply.code(404).send({ error: "One or both commits not found" });
      }
    }
  );

  // POST /workspaces/:id/rollback
  app.post(
    "/workspaces/:id/rollback",
    {
      schema: {
        description: "Rollback to a specific version",
        tags: ["History"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          required: ["toVersion"],
          properties: {
            toVersion: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      if (!verifyWorkspaceOwnership(request, reply, id)) return;

      const body = RollbackSchema.parse(request.body);

      const workspace = await getWorkspace(id);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      try {
        const storage = getStorage();
        const result = await storage.rollback(id, body.toVersion, {});

        reply.code(201).send({
          commitId: result.commitId,
          rolledBackTo: body.toVersion,
          workspaceId: id,
          files: result.files,
          sizeBytes: result.sizeBytes,
          createdAt: result.createdAt,
        });
      } catch {
        return reply.code(404).send({ error: "Target version not found" });
      }
    }
  );

  // GET /workspaces/:id/search
  app.get(
    "/workspaces/:id/search",
    {
      schema: {
        description: "Search files within a workspace",
        tags: ["Search"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        querystring: {
          type: "object",
          required: ["q"],
          properties: {
            q: { type: "string", minLength: 1 },
            limit: { type: "integer", default: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { q, limit } = request.query as { q: string; limit?: number };

      if (!verifyWorkspaceOwnership(request, reply, id)) return;

      const workspace = await getWorkspace(id);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const storage = getStorage();
      const results = await storage.searchFiles(id, q, { limit: limit || 50 });

      reply.send({ query: q, results, count: results.length });
    }
  );
}
