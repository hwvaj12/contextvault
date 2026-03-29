import Fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { authMiddleware } from "./middleware/auth";
import { workspaceRoutes } from "./routes/workspaces";
import { commitRoutes } from "./routes/commits";
import { gitRemoteRoutes } from "./routes/git-remote";
import { sandboxRoutes } from "./routes/sandbox";
import { runRoutes } from "./routes/runs";
import { webhookRoutes } from "./routes/webhooks";
import { getDb, closeDb } from "./db";

async function main() {
  const app = Fastify({ logger: true });

  // Initialize database
  getDb();
  app.addHook("onClose", () => closeDb());

  // CORS
  await app.register(cors, { origin: true });

  // Swagger
  await app.register(swagger, {
    openapi: {
      info: {
        title: "ContextVault API",
        description:
          "Multi-tenant, versioned workspace layer for AI agent memory",
        version: "1.0.0",
      },
      components: {
        securitySchemes: {
          apiKey: {
            type: "apiKey",
            name: "X-API-Key",
            in: "header",
          },
        },
      },
      security: [{ apiKey: [] }],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  // Git remote routes — registered before auth middleware (handles own auth)
  await app.register(gitRemoteRoutes);

  // Auth for other routes
  app.addHook("onRequest", authMiddleware);

  // Health check (no auth — registered before auth hook takes effect)
  app.get(
    "/health",
    { schema: { description: "Health check", tags: ["System"] } },
    async () => ({ status: "healthy", version: "1.0.0", timestamp: new Date().toISOString() })
  );

  // API info (no auth)
  app.get(
    "/",
    { schema: { description: "API info", tags: ["System"] } },
    async () => ({
      name: "ContextVault",
      version: "1.0.0",
      documentation: "https://github.com/lab-rat0212/contextvault",
    })
  );

  // Routes
  await app.register(workspaceRoutes);
  await app.register(commitRoutes);
  await app.register(sandboxRoutes);
  await app.register(runRoutes);
  await app.register(webhookRoutes);

  const port = parseInt(process.env.PORT || "3000", 10);
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`ContextVault API running on http://localhost:${port}`);
  app.log.info(`Swagger docs at http://localhost:${port}/docs`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
