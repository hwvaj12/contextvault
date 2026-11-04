import Fastify, { type FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { createAuthMiddleware } from "./middleware/auth";
import { workspaceRoutes } from "./routes/workspaces";
import { commitRoutes } from "./routes/commits";
import { gitRemoteRoutes } from "./routes/git-remote";
import { sandboxRoutes } from "./routes/sandbox";
import { runRoutes } from "./routes/runs";
import { webhookRoutes } from "./routes/webhooks";
import { apiKeyRoutes } from "./routes/apikeys";
import { analyticsRoutes } from "./routes/analytics";
import { vaultBrowserRoutes } from "./routes/vault-browser";
import { getDb, withDatabase } from "./db";
import { dirname } from "node:path";
import { ZodError } from "zod";
import { WorkspaceError } from "./domain";
import { loadConfiguration } from "./config";
import { createRuntime, preparePrivateDirectory, type RuntimeOptions } from "./config/runtime";
import { synchronizeConfiguredAdministrator } from "./middleware/catalog-identity";
import { documentV1Schema, v1Routes } from "./routes/v1";
import { documentRevisionSchema, revisionRoutes } from "./routes/v1/revisions";
import { adminRoutes, documentAdminSchema, legacyAdminRoutes } from "./routes/v1/admin";
import { createSafeDirectory } from "./application/files";

export type ApplicationOptions = FastifyServerOptions & { contextVault?: RuntimeOptions };

/** Build the existing HTTP application without binding a network listener. */
export async function createApp(options: ApplicationOptions = {}) {
  const { contextVault = {}, ...fastifyOptions } = options;
  const configuration = structuredClone(contextVault.configuration ?? loadConfiguration());
  await preparePrivateDirectory(configuration.dataDirectory);
  await createSafeDirectory(dirname(configuration.databasePath));
  const database = contextVault.database ?? getDb(configuration.databasePath);
  let runtime: Awaited<ReturnType<typeof createRuntime>>;
  try {
    synchronizeConfiguredAdministrator(database, configuration.masterKey, contextVault.now?.() ?? new Date().toISOString());
    runtime = await createRuntime(configuration, database, contextVault);
  } catch (error) { if (!contextVault.database && database.open) database.close(); throw error; }
  const app = Fastify({ logger: true, bodyLimit: 16 * 1024 * 1024, requestTimeout: configuration.requestTimeoutMs, ...fastifyOptions });
  app.decorate("contextVault", runtime);
  app.addHook("onRequest", (_request, _reply, done) => withDatabase(database, done));
  app.addHook("onSend", async (request, reply) => { if (request.url.startsWith("/v1/")) reply.header("Cache-Control", "no-store"); });
  app.addHook("onClose", async () => { await runtime.stop(); if (!contextVault.database && database.open) database.close(); });
  app.addHook("onReady", async () => { if (contextVault.maintenance !== false) runtime.maintenance.start(); });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof WorkspaceError) return reply.code(error.statusCode).send(error.toJSON());
    if (error instanceof ZodError) return reply.code(400).send(new WorkspaceError("INVALID_REQUEST", "Request fields are invalid").toJSON());
    if (request.url.startsWith("/v1/")) {
      const status = (error as { statusCode?: number }).statusCode;
      const publicError = new WorkspaceError(status === 413 ? "QUOTA_EXCEEDED" : status && status < 500 ? "INVALID_REQUEST" : "STORAGE_UNAVAILABLE", status && status < 500 ? "The request is invalid" : "The operation is temporarily unavailable");
      return reply.code(publicError.statusCode).send(publicError.toJSON());
    }
    return reply.send(error);
  });

  // CORS
  await app.register(cors, { origin: true });

  // Swagger
  await app.register(swagger, {
    transform: ({ schema, url, route }) => ({ schema: documentAdminSchema(documentRevisionSchema(documentV1Schema(schema, url, route.method), url, route.method), url, route.method), url }),
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

  // Vault browser — registered before auth middleware (handles own auth via UI)
  await app.register(vaultBrowserRoutes, { prefix: "/vault" });

  // Redirect /vault to /vault/
  app.get("/vault", async (_, reply) => {
    return reply.redirect("/vault/");
  });

  // Git remote routes — registered before auth middleware (handles own auth)
  await app.register(gitRemoteRoutes);

  // Auth for other routes
  app.addHook("onRequest", createAuthMiddleware({ database, masterKey: configuration.masterKey, now: runtime.now, provisionLegacyTenant: runtime.provisionLegacyTenant }));

  // Health check (explicitly allowed by the auth middleware)
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
  await app.register(legacyAdminRoutes);
  await app.register(commitRoutes);
  await app.register(sandboxRoutes);
  await app.register(runRoutes);
  await app.register(webhookRoutes);
  await app.register(apiKeyRoutes);
  await app.register(analyticsRoutes);
  await app.register(v1Routes, { prefix: "/v1" });
  await app.register(revisionRoutes, { prefix: "/v1" });
  await app.register(adminRoutes, { prefix: "/v1" });

  return app;
}
