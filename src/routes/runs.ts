import { FastifyInstance } from "fastify";
import { z } from "zod";
import { getWorkspace } from "../services/workspace.service";
import {
  createRun,
  getRun,
  listRunsForWorkspace,
  transitionRun,
} from "../services/run.service";

const CreateRunSchema = z.object({
  agentId: z.string().min(1),
});

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

      try {
        // Transition to finalizing
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
