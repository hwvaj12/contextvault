import type { FastifyRequest, FastifyReply } from "fastify";
import type Database from "better-sqlite3";
import { createHash, timingSafeEqual } from "node:crypto";
import { verifyKey } from "../services/apikey.service";
import { getDb, withDatabase } from "../db";
import { WorkspaceError, type Principal } from "../domain";
import { principalForVerifiedAdministrator, principalForVerifiedApiKey } from "./catalog-identity";

declare module "fastify" {
  interface FastifyRequest { customerId?: string; isAdmin?: boolean; principal?: Principal; selectedCustomerId?: string }
}
export interface AuthenticationOptions {
  database: Database.Database; masterKey: string | null; now?: () => string;
  provisionLegacyTenant?: (customerId: string) => Promise<void>;
}
const matches = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
function basic(header: string | undefined): string | null {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8"); const colon = decoded.indexOf(":");
  return colon < 0 ? decoded : decoded.slice(colon + 1) || decoded.slice(0, colon);
}
function pathname(request: FastifyRequest): string { return request.url.split("?", 1)[0]; }
function publicPath(path: string): boolean { return path === "/" || path === "/health" || path === "/docs" || path.startsWith("/docs/") || path === "/vault" || path.startsWith("/vault/"); }
export function createAuthMiddleware(options: AuthenticationOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  async function authenticate(key: string, request: FastifyRequest): Promise<boolean> {
    if (options.masterKey && matches(key, options.masterKey)) {
      const selected = request.headers["x-contextvault-customer-id"];
      if (selected !== undefined && (typeof selected !== "string" || !selected.trim() || selected.length > 255)) return false;
      try { request.principal = principalForVerifiedAdministrator(options.database, key, selected ?? null, now()); } catch { return false; }
      request.isAdmin = true; if (selected) request.selectedCustomerId = selected; return true;
    }
    const verified = withDatabase(options.database, () => verifyKey(key));
    if (!verified) return false;
    const principal = await principalForVerifiedApiKey(options.database, verified, now());
    if (!principal) return false;
    request.principal = principal; request.customerId = verified.customerId; request.isAdmin = false;
    if (!pathname(request).startsWith("/v1/")) {
      try { await options.provisionLegacyTenant?.(verified.customerId); }
      catch { request.log.warn("Legacy tenant key provisioning failed"); }
    }
    return true;
  }
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (publicPath(pathname(request))) return;
    const presented = request.headers["x-api-key"];
    if (typeof presented === "string" && await authenticate(presented, request)) return;
    const alternative = basic(request.headers.authorization);
    if (alternative && await authenticate(alternative, request)) return;
    if (pathname(request).startsWith("/v1/")) throw new WorkspaceError("UNAUTHENTICATED", "Invalid or missing API key");
    if (pathname(request).startsWith("/repos/")) reply.header("WWW-Authenticate", 'Basic realm="ContextVault"');
    return reply.code(401).send({ error: "Unauthorized", message: "Invalid or missing API key" });
  };
}
/** Compatibility entrypoint; normal application composition supplies explicit per-instance authentication. */
export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  return createAuthMiddleware({ database: getDb(), masterKey: process.env.CONTEXTVAULT_API_KEY?.trim() ? process.env.CONTEXTVAULT_API_KEY : null })(request, reply);
}
