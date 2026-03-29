import { FastifyInstance } from "fastify";
import { z } from "zod";
import { getWorkspace } from "../services/workspace.service";
import {
  createRun,
  getRun,
  listRunsForWorkspace,
  transitionRun,
} from "../services/run.service";
import { verifyWorkspaceOwnership, getRequestCustomerId } from "../middleware/tenant";
import { getDb } from "../db";

const CreateRunSchema = z.object({
  agentId: z.string().min(1),
});

/**
 * Verify that a run belongs to a workspace owned by the authenticated customer.
 * Returns false and sends 404 if not allowed.
 */
function verifyRunOwnership(request: any, reply: any, run: any): boolean {
  const customerId = getRequestCustomerId(request);
  if (customerId === null) return true; // admin

  const db = getDb();
  const row = db
    .prepare("SELECT customer_id FROM workspaces WHERE id = ? AND status != 'deleted'")
    .get(run.workspaceId) as { customer_id: string } | undefined;

  if (!row || row.customer_id !== customerId) {
    reply.code(404).send({ error: { code: "RUN_NOT_FOUND", message: `Run ${run.id} not found` } });
    return false;
  }

  return true;
}

export async function runRoutes(app: FastifyInstance) {
  // POST /workspaces/:id/runs - Create a new run
  app.post(
    "/workspaces/:id/runs",
    {
      schema: {
        description: "Create and start a new run",
        tags: ["Runs"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          required: ["agentId"],
          properties: { agentId: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = CreateRunSchema.parse(request.body);

      if (!verifyWorkspaceOwnership(request, reply, id)) return;

      const workspace = await getWorkspace(id);
      if (!workspace) {
        return reply.code(404).send({
          error: { code: "WORKSPACE_NOT_FOUND", message: `Workspace ${id} not found` },
        });
      }

      const run = createRun(id, body.agentId);
      reply.code(201).send(run);
    }
  );

  // GET /workspaces/:id/runs - List runs for workspace
  app.get(
    "/workspaces/:id/runs",
    {
      schema: {
        description: "List runs for a workspace",
        tags: ["Runs"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        querystring: {
          type: "object",
          properties: { limit: { type: "integer", default: 20 } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { limit } = request.query as { limit?: number };

      if (!verifyWorkspaceOwnership(request, reply, id)) return;

      const workspace = await getWorkspace(id);
      if (!workspace) {
        return reply.code(404).send({
          error: { code: "WORKSPACE_NOT_FOUND", message: `Workspace ${id} not found` },
        });
      }

      const runs = listRunsForWorkspace(id, limit || 20);
      reply.send({ runs, count: runs.length });
    }
  );

  // GET /runs/:id - Get run status
  app.get(
    "/runs/:id",
    {
      schema: {
        description: "Get run status",
        tags: ["Runs"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const run = getRun(id);
      if (!run) {
        return reply.code(404).send({
          error: { code: "RUN_NOT_FOUND", message: `Run ${id} not found` },
        });
      }

      if (!verifyRunOwnership(request, reply, run)) return;

      reply.send(run);
    }
  );

  // POST /runs/:id/finalize - Finalize a run
  app.post(
    "/runs/:id/finalize",
    {
      schema: {
        description: "Finalize a run (commit changes)",
        tags: ["Runs"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: {
            executionSummary: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body as any) || {};

      const run = getRun(id);
      if (!run) {
        return reply.code(404).send({
          error: { code: "RUN_NOT_FOUND", message: `Run ${id} not found` },
        });
      }

      if (!verifyRunOwnership(request, reply, run)) return;

      try {
        const finalizing = transitionRun(id, "finalizing", {
          executionSummary: body.executionSummary,
        });
        reply.send(finalizing);
      } catch (error: any) {
        return reply.code(400).send({
          error: { code: "INVALID_TRANSITION", message: error.message },
        });
      }
    }
  );

  // POST /runs/:id/abort - Abort a run
  app.post(
    "/runs/:id/abort",
    {
      schema: {
        description: "Abort a run",
        tags: ["Runs"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: {
            reason: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body as any) || {};

      const run = getRun(id);
      if (!run) {
        return reply.code(404).send({
          error: { code: "RUN_NOT_FOUND", message: `Run ${id} not found` },
        });
      }

      if (!verifyRunOwnership(request, reply, run)) return;

      try {
        const aborted = transitionRun(id, "aborted", {
          failureReason: body.reason || "Manually aborted",
        });
        reply.send(aborted);
      } catch (error: any) {
        return reply.code(400).send({
          error: { code: "INVALID_TRANSITION", message: error.message },
        });
      }
    }
  );
}
