import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as path from "path";
import * as fs from "fs";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export async function vaultBrowserRoutes(app: FastifyInstance) {
  // __dirname at runtime is dist/routes/; vault-browser dist is at src/vault-browser/dist
  const rootDir = path.join(__dirname, "..", "..");
  const distPath = path.join(rootDir, "src", "vault-browser", "dist");

  app.get("/*", async (request: FastifyRequest, reply: FastifyReply) => {
    const urlPath = (request.params as { "*": string })["*"] || "";
    const filePath = path.join(distPath, urlPath);

    // Prevent directory traversal
    if (!filePath.startsWith(distPath)) {
      return reply.status(403).send("Forbidden");
    }

    // Try to serve the requested file
    if (urlPath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const contentType = CONTENT_TYPES[ext] || "application/octet-stream";
      const content = fs.readFileSync(filePath);
      return reply.type(contentType).send(content);
    }

    // Fallback to index.html for SPA routing
    const indexPath = path.join(distPath, "index.html");
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, "utf-8");
      return reply.type("text/html; charset=utf-8").send(content);
    }

    return reply.status(404).send("Vault browser not built. Run: cd src/vault-browser && npm run build");
  });
}
