import { FastifyRequest, FastifyReply } from "fastify";

const API_KEY = "cv-test-api-key-123";

const PUBLIC_PATHS = ["/health", "/docs", "/docs/"];

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

  const apiKey = request.headers["x-api-key"];
  if (!apiKey || apiKey !== API_KEY) {
    reply.code(401).send({ error: "Unauthorized", message: "Invalid or missing API key" });
  }
}
