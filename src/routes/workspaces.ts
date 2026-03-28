import { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { z } from "zod";
import { PutCommand, GetCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLE_WORKSPACES } from "../db/client";

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
      const now = new Date().toISOString();

      const workspace = {
        PK: `WORKSPACE#${id}`,
        SK: "METADATA",
        id,
        customerId: body.customerId,
        name: body.name,
        latestCommitId: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };

      await docClient.send(
        new PutCommand({ TableName: TABLE_WORKSPACES, Item: workspace })
      );

      reply.code(201).send({
        id: workspace.id,
        customerId: workspace.customerId,
        name: workspace.name,
        latestCommitId: workspace.latestCommitId,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
        deletedAt: workspace.deletedAt,
      });
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
      const result = await docClient.send(
        new ScanCommand({
          TableName: TABLE_WORKSPACES,
          FilterExpression: "SK = :sk AND attribute_not_exists(deletedAt) OR (SK = :sk AND deletedAt = :null)",
          ExpressionAttributeValues: { ":sk": "METADATA", ":null": null },
        })
      );

      const workspaces = (result.Items || []).map((item) => ({
        id: item.id,
        customerId: item.customerId,
        name: item.name,
        latestCommitId: item.latestCommitId,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        deletedAt: item.deletedAt,
      }));

      reply.send(workspaces);
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

      const result = await docClient.send(
        new GetCommand({
          TableName: TABLE_WORKSPACES,
          Key: { PK: `WORKSPACE#${id}`, SK: "METADATA" },
        })
      );

      if (!result.Item || result.Item.deletedAt) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      reply.send({
        id: result.Item.id,
        customerId: result.Item.customerId,
        name: result.Item.name,
        latestCommitId: result.Item.latestCommitId,
        createdAt: result.Item.createdAt,
        updatedAt: result.Item.updatedAt,
        deletedAt: result.Item.deletedAt,
      });
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
      const now = new Date().toISOString();

      await docClient.send(
        new UpdateCommand({
          TableName: TABLE_WORKSPACES,
          Key: { PK: `WORKSPACE#${id}`, SK: "METADATA" },
          UpdateExpression: "SET deletedAt = :deletedAt, updatedAt = :updatedAt",
          ExpressionAttributeValues: {
            ":deletedAt": now,
            ":updatedAt": now,
          },
        })
      );

      reply.code(204).send();
    }
  );
}
