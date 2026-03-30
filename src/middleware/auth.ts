import { FastifyRequest, FastifyReply } from "fastify";
import { verifyKey } from "../services/apikey.service";
import { ensureTenantTMK } from "../services/tenant.service";

const MASTER_KEY = process.env.CONTEXTVAULT_API_KEY || "cv-test-api-key-123";

const PUBLIC_PATHS = ["/health", "/docs", "/docs/", "/vault"];

declare module "fastify" {
  interface FastifyRequest {
    customerId?: string;
    isAdmin?: boolean;
  }
}

function extractBasicAuthKey(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith("Basic ")) return null;
  const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
  const colonIdx = decoded.indexOf(":");
  if (colonIdx === -1) return decoded;
  const username = decoded.slice(0, colonIdx);
  const password = decoded.slice(colonIdx + 1);
  // Return whichever part looks like a key
  return password || username;
}

async function authenticateKey(key: string, request: FastifyRequest): Promise<boolean> {
  // Master key = admin bypass (no customer scoping)
  if (key === MASTER_KEY) {
    request.isAdmin = true;
    return true;
  }

  // Try tenant-scoped key lookup
  const verified = verifyKey(key);
  if (verified) {
    request.customerId = verified.customerId;
    request.isAdmin = false;
    
    // Auto-provision TMK for new customers on first authentication
    // This ensures TMK exists before any workspace operations
    try {
      await ensureTenantTMK(verified.customerId);
    } catch (error) {
      // Don't fail auth if TMK provisioning fails, but log it
      console.error('TMK provisioning failed for customer:', verified.customerId, error);
    }
    
    return true;
  }

  return false;
}

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (
    PUBLIC_PATHS.some((p) => request.url.startsWith(p)) ||
    request.url === "/"
  ) {
    return;
  }

  // Check X-API-Key header first
  const apiKey = request.headers["x-api-key"] as string | undefined;
  if (apiKey && (await authenticateKey(apiKey, request))) return;

  // Fall back to HTTP Basic Auth (used by git clone/push)
  const basicKey = extractBasicAuthKey(request.headers.authorization);
  if (basicKey && (await authenticateKey(basicKey, request))) return;

  // For git requests, send WWW-Authenticate to trigger credential prompt
  if (request.url.startsWith("/repos/")) {
    reply
      .code(401)
      .header("WWW-Authenticate", 'Basic realm="ContextVault"')
      .send({ error: "Unauthorized" });
    return;
  }

  reply.code(401).send({ error: "Unauthorized", message: "Invalid or missing API key" });
}
