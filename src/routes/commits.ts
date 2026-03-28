import { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { getWorkspace, updateLatestCommit } from "../services/workspace.service";
import { createCommit, getCommitHistory } from "../services/commit.service";

const DATA_DIR = path.join(process.cwd(), "data", "workspaces");

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

async function writeCommitFiles(
  workspaceId: string,
  commitId: string,
  files: { path: string; content: string }[],
  metadata: Record<string, unknown>,
  parentId: string | null
) {
  const commitDir = path.join(DATA_DIR, workspaceId, "commits", commitId);
  await fs.mkdir(commitDir, { recursive: true });

  let sizeBytes = 0;
  for (const file of files) {
    const filePath = path.join(commitDir, file.path);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, file.content, "utf-8");
    sizeBytes += Buffer.byteLength(file.content, "utf-8");
  }

  const manifest = {
    id: commitId,
    workspaceId,
    parentId,
    files: files.map((f) => ({ path: f.path })),
    metadata,
    sizeBytes,
    createdAt: new Date().toISOString(),
  };

  await fs.writeFile(
    path.join(commitDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );

  return { sizeBytes, createdAt: manifest.createdAt };
}

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
      const body = PushSchema.parse(request.body);

      const workspace = getWorkspace(id);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const commitId = `v_${ulid()}`;
      const parentId = workspace.latestCommitId || null;

      const { sizeBytes, createdAt } = await writeCommitFiles(
        id,
        commitId,
        body.files,
        body.metadata,
        parentId
      );

      createCommit(commitId, id, parentId, body.metadata, sizeBytes, createdAt);
      updateLatestCommit(id, commitId, createdAt);

      reply.code(201).send({
        commitId,
        workspaceId: id,
        parentId,
        files: body.files.map((f) => f.path),
        metadata: body.metadata,
        sizeBytes,
        createdAt,
      });
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
      const { version } = request.query as { version?: string };

      const workspace = getWorkspace(id);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const commitId = version || workspace.latestCommitId;
      if (!commitId) {
        return reply.send({ commitId: null, files: [], metadata: {} });
      }

      const commitDir = path.join(DATA_DIR, id, "commits", commitId);
      try {
        const manifestRaw = await fs.readFile(
          path.join(commitDir, "manifest.json"),
          "utf-8"
        );
        const manifest = JSON.parse(manifestRaw);

        const files = await Promise.all(
          manifest.files.map(async (f: { path: string }) => {
            const content = await fs.readFile(
              path.join(commitDir, f.path),
              "utf-8"
            );
            return { path: f.path, content };
          })
        );

        reply.send({
          commitId: manifest.id,
          workspaceId: id,
          parentId: manifest.parentId,
          files,
          metadata: manifest.metadata,
          sizeBytes: manifest.sizeBytes,
          createdAt: manifest.createdAt,
        });
      } catch {
        return reply.code(404).send({ error: "Commit not found" });
      }
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

      const workspace = getWorkspace(id);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const commits = getCommitHistory(id, limit || 20);
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

      const readManifest = async (commitId: string) => {
        const manifestPath = path.join(
          DATA_DIR,
          id,
          "commits",
          commitId,
          "manifest.json"
        );
        const raw = await fs.readFile(manifestPath, "utf-8");
        return JSON.parse(raw);
      };

      const readFileContent = async (commitId: string, filePath: string) => {
        return fs.readFile(
          path.join(DATA_DIR, id, "commits", commitId, filePath),
          "utf-8"
        );
      };

      try {
        const [fromManifest, toManifest] = await Promise.all([
          readManifest(from),
          readManifest(to),
        ]);

        const fromFiles = new Map<string, boolean>();
        for (const f of fromManifest.files) {
          fromFiles.set(f.path, true);
        }

        const toFiles = new Map<string, boolean>();
        for (const f of toManifest.files) {
          toFiles.set(f.path, true);
        }

        const added: string[] = [];
        const removed: string[] = [];
        const modified: string[] = [];
        const unchanged: string[] = [];

        for (const f of toManifest.files) {
          if (!fromFiles.has(f.path)) {
            added.push(f.path);
          } else {
            const [fromContent, toContent] = await Promise.all([
              readFileContent(from, f.path),
              readFileContent(to, f.path),
            ]);
            if (fromContent !== toContent) {
              modified.push(f.path);
            } else {
              unchanged.push(f.path);
            }
          }
        }

        for (const f of fromManifest.files) {
          if (!toFiles.has(f.path)) {
            removed.push(f.path);
          }
        }

        reply.send({
          from,
          to,
          diff: { added, removed, modified, unchanged },
        });
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
      const body = RollbackSchema.parse(request.body);

      const workspace = getWorkspace(id);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      // Read files from target version
      const targetDir = path.join(
        DATA_DIR,
        id,
        "commits",
        body.toVersion
      );

      let manifest;
      try {
        const raw = await fs.readFile(
          path.join(targetDir, "manifest.json"),
          "utf-8"
        );
        manifest = JSON.parse(raw);
      } catch {
        return reply.code(404).send({ error: "Target version not found" });
      }

      // Read all files from target commit
      const files = await Promise.all(
        manifest.files.map(async (f: { path: string }) => {
          const content = await fs.readFile(
            path.join(targetDir, f.path),
            "utf-8"
          );
          return { path: f.path, content };
        })
      );

      // Create new commit with same content
      const newCommitId = `v_${ulid()}`;
      const parentId = workspace.latestCommitId || null;
      const rollbackMetadata = { ...manifest.metadata, rollbackFrom: body.toVersion };

      const { sizeBytes, createdAt } = await writeCommitFiles(
        id,
        newCommitId,
        files,
        rollbackMetadata,
        parentId
      );

      createCommit(newCommitId, id, parentId, rollbackMetadata, sizeBytes, createdAt);
      updateLatestCommit(id, newCommitId, createdAt);

      reply.code(201).send({
        commitId: newCommitId,
        rolledBackTo: body.toVersion,
        workspaceId: id,
        files: files.map((f) => f.path),
        sizeBytes,
        createdAt,
      });
    }
  );
}
