import { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { z } from "zod";
import { PutCommand, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import * as fs from "fs/promises";
import * as path from "path";
import { docClient, TABLE_WORKSPACES, TABLE_COMMITS } from "../db/client";

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

async function getWorkspace(id: string) {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_WORKSPACES,
      Key: { PK: `WORKSPACE#${id}`, SK: "METADATA" },
    })
  );
  if (!result.Item || result.Item.deletedAt) return null;
  return result.Item;
}

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

      const workspace = await getWorkspace(id);
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

      // Store commit record in DynamoDB
      await docClient.send(
        new PutCommand({
          TableName: TABLE_COMMITS,
          Item: {
            PK: `WORKSPACE#${id}`,
            SK: `COMMIT#${commitId}`,
            id: commitId,
            workspaceId: id,
            parentId,
            metadata: body.metadata,
            sizeBytes,
            createdAt,
          },
        })
      );

      // Update workspace latestCommitId
      await docClient.send(
        new UpdateCommand({
          TableName: TABLE_WORKSPACES,
          Key: { PK: `WORKSPACE#${id}`, SK: "METADATA" },
          UpdateExpression:
            "SET latestCommitId = :commitId, updatedAt = :updatedAt",
          ExpressionAttributeValues: {
            ":commitId": commitId,
            ":updatedAt": createdAt,
          },
        })
      );

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

      const workspace = await getWorkspace(id);
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

      const workspace = await getWorkspace(id);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const result = await docClient.send(
        new QueryCommand({
          TableName: TABLE_COMMITS,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
          ExpressionAttributeValues: {
            ":pk": `WORKSPACE#${id}`,
            ":skPrefix": "COMMIT#",
          },
          ScanIndexForward: false,
          Limit: limit || 20,
        })
      );

      const commits = (result.Items || []).map((item) => ({
        id: item.id,
        workspaceId: item.workspaceId,
        parentId: item.parentId,
        metadata: item.metadata,
        sizeBytes: item.sizeBytes,
        createdAt: item.createdAt,
      }));

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

      const workspace = await getWorkspace(id);
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

      const { sizeBytes, createdAt } = await writeCommitFiles(
        id,
        newCommitId,
        files,
        { ...manifest.metadata, rollbackFrom: body.toVersion },
        parentId
      );

      await docClient.send(
        new PutCommand({
          TableName: TABLE_COMMITS,
          Item: {
            PK: `WORKSPACE#${id}`,
            SK: `COMMIT#${newCommitId}`,
            id: newCommitId,
            workspaceId: id,
            parentId,
            metadata: { ...manifest.metadata, rollbackFrom: body.toVersion },
            sizeBytes,
            createdAt,
          },
        })
      );

      await docClient.send(
        new UpdateCommand({
          TableName: TABLE_WORKSPACES,
          Key: { PK: `WORKSPACE#${id}`, SK: "METADATA" },
          UpdateExpression:
            "SET latestCommitId = :commitId, updatedAt = :updatedAt",
          ExpressionAttributeValues: {
            ":commitId": newCommitId,
            ":updatedAt": createdAt,
          },
        })
      );

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
