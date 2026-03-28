import { FastifyRequest, FastifyReply } from "fastify";

const API_KEY = "cv-test-api-key-123";

const PUBLIC_PATHS = ["/health", "/docs", "/docs/"];

function extractBasicAuthKey(authHeader: string | undefined, apiKey: string): boolean {
  if (!authHeader || !authHeader.startsWith("Basic ")) return false;
  const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
  // Git sends "username:password" — we accept the API key as either part
  const colonIdx = decoded.indexOf(":");
  if (colonIdx === -1) return decoded === apiKey;
  const username = decoded.slice(0, colonIdx);
  const password = decoded.slice(colonIdx + 1);
  return username === apiKey || password === apiKey;
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
  const apiKey = request.headers["x-api-key"];
  if (apiKey === API_KEY) return;

  // Fall back to HTTP Basic Auth (used by git clone/push)
  if (extractBasicAuthKey(request.headers.authorization, API_KEY)) return;

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
