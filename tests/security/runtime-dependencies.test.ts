import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { simpleGit } from "simple-git";
import { serialize } from "fast-uri";

describe("runtime dependency security boundaries", () => {
  it("rejects URI authority delimiters supplied through a port component", () => {
    expect(serialize({ scheme: "http", host: "service.invalid", port: 8080, path: "/resource" }))
      .toBe("http://service.invalid:8080/resource");
    expect(() => serialize({ scheme: "http", host: "service.invalid", port: "@127.0.0.1:8124", path: "/resource" }))
      .toThrow();
  });

  it("rejects command-bearing inline Git configuration before spawning", async () => {
    await expect(simpleGit().raw(["version"])).resolves.toMatch(/^git version /);
    // The version command never executes this harmless fixture helper.
    await expect((async () => simpleGit({
      config: ["trailer.contextvault.cmd=echo contextvault-security-fixture"],
    }).raw(["version"]))()).rejects.toThrow();
  });

  it("rejects malformed public URLs before a private fallback can disclose data", async () => {
    const app = Fastify();
    let privateCalls = 0;
    await app.register(async (publicApi) => {
      publicApi.get("/ping", async () => ({ status: "ok" }));
      publicApi.setNotFoundHandler(async (_, reply) => reply.code(404).send({ scope: "public" }));
    }, { prefix: "/open" });
    await app.register(async (privateApi) => {
      privateApi.setNotFoundHandler({ preHandler: async (request, reply) => {
        if (request.headers["x-api-key"] !== "fixture-key") return reply.code(401).send({ error: "unauthorized" });
      } }, (_, reply) => { privateCalls++; return reply.send({ scope: "private" }); });
    }, { prefix: "/restricted" });
    try {
      const malformed = await app.inject({ method: "DELETE", url: "/open/%FF" });
      expect(malformed.statusCode).toBe(400);
      expect(privateCalls).toBe(0);
      const denied = await app.inject({ method: "DELETE", url: "/restricted/missing" });
      expect(denied.statusCode).toBe(401);
      expect(privateCalls).toBe(0);
      const allowed = await app.inject({ method: "DELETE", url: "/restricted/missing", headers: { "x-api-key": "fixture-key" } });
      expect(allowed.statusCode).toBe(200);
      expect(privateCalls).toBe(1);
    } finally { await app.close(); }
  });
});
