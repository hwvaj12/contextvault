import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { canonicalJson } from "../../src/domain/idempotency";

const servers: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });
async function read(relative: string) { return JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8")); }
async function validator() {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  servers.push(app);
  const http = await read("../../contracts/http.v1.schema.json");
  const recovery = await read("../../contracts/recovery.v1.schema.json");
  app.addSchema(await read("../../contracts/manifest.v1.schema.json"));
  app.addSchema(http);
  app.addSchema(recovery);
  for (const name of ["FinalizationIntent", "WorkspaceCreationIntent", "ClientSessionState", "ExpiredActiveRun", "FinalizationOperation", "WorkspaceCreationOperation"]) {
    app.post(`/${name}`, { schema: { body: { $ref: `${recovery.$id}#/definitions/${name}` } } }, async (request) => request.body);
  }
  return (name: string, payload: object) => app.inject({ method: "POST", url: `/${name}`, payload });
}

describe("durable recovery contracts", () => {
  it("retains the exact sealed source and original request before candidate preparation", async () => {
    const validate = await validator();
    const fixture = await read("../fixtures/workspaces/recovery.v1.json");
    const operation = JSON.parse(JSON.stringify(fixture.finalizationOperation));
    expect((await validate("FinalizationOperation", operation)).statusCode).toBe(200);
    expect(operation.candidate).toBeNull();
    const intent = operation.intent;
    expect((await validate("FinalizationIntent", intent)).statusCode).toBe(200);
    expect(intent.source).toEqual({ submissionId: "sub_sealed_selected", submissionVersion: 4, manifestDigest: fixture.manifestDigest });
    expect(intent.request.body.submissionId).toBe(intent.source.submissionId);
    expect(intent.candidateIdentity.operationId).toBe("op_finalize");
    const missingDigest = structuredClone(intent);
    delete missingDigest.source.manifestDigest;
    expect((await validate("FinalizationIntent", missingDigest)).statusCode).toBe(400);
    expect((await validate("FinalizationIntent", { ...intent, source: null })).statusCode).toBe(400);
    expect((await validate("FinalizationIntent", fixture.readOnlyIntent)).statusCode).toBe(200);
  });

  it("retains creation identity and exact request before preparing an empty revision", async () => {
    const validate = await validator();
    const fixture = await read("../fixtures/workspaces/recovery.v1.json");
    const operation = JSON.parse(JSON.stringify(fixture.creationOperation));
    expect((await validate("WorkspaceCreationOperation", operation)).statusCode).toBe(200);
    const intent = operation.intent;
    expect((await validate("WorkspaceCreationIntent", intent)).statusCode).toBe(200);
    expect(intent.request.body).toEqual({ customerId: "customer-a", name: "Original requested name" });
    expect(intent.initialManifest).toEqual({ schemaVersion: 1, entries: [] });
    expect(intent.candidateIdentity.revisionId).toBe(intent.workspace.currentRevisionId);
    const missingCandidate = { ...intent };
    delete missingCandidate.candidateIdentity;
    expect((await validate("WorkspaceCreationIntent", missingCandidate)).statusCode).toBe(400);
  });

  it("requires both lifecycle and lease versions for active-run expiry", async () => {
    const validate = await validator();
    const fixture = await read("../fixtures/workspaces/recovery.v1.json");
    expect((await validate("ExpiredActiveRun", fixture.expiredActiveRun)).statusCode).toBe(200);
    expect((await validate("ExpiredActiveRun", { ...fixture.expiredActiveRun, expectedState: "finalizing" })).statusCode).toBe(400);
    const missingLeaseVersion = { ...fixture.expiredActiveRun };
    delete missingLeaseVersion.expectedLeaseVersion;
    expect((await validate("ExpiredActiveRun", missingLeaseVersion)).statusCode).toBe(400);
  });

  it("persists pending create/open/finalize commands before server IDs or responses exist", async () => {
    const validate = await validator();
    const fixture = await read("../fixtures/workspaces/recovery.v1.json");
    for (const session of fixture.clientSessions) {
      const restored = JSON.parse(JSON.stringify(session));
      expect((await validate("ClientSessionState", restored)).statusCode).toBe(200);
      expect(restored.pendingCommand.idempotencyKey).toBe(session.pendingCommand.idempotencyKey);
      expect(canonicalJson(restored.pendingCommand.request)).toBe(canonicalJson(session.pendingCommand.request));
      expect(restored.pendingCommand.operationId).toBeNull();
    }
    expect(fixture.clientSessions[0].workspaceId).toBeNull();
    expect(fixture.clientSessions[0].run).toBeNull();
    expect(fixture.clientSessions[1].run).toBeNull();
    const finalized = fixture.clientSessions[2];
    expect(finalized.pendingCommand.selectedSubmission.submissionId).toBe(finalized.pendingCommand.request.body.submissionId);
    const missingKey = structuredClone(finalized);
    delete missingKey.pendingCommand.idempotencyKey;
    expect((await validate("ClientSessionState", missingKey)).statusCode).toBe(400);
    const leakedBinding = structuredClone(finalized);
    leakedBinding.run.storageBindingId = "server-private";
    expect((await validate("ClientSessionState", leakedBinding)).statusCode).toBe(400);
    const leakedCredentials = { ...finalized, apiKey: "must-not-persist" };
    expect((await validate("ClientSessionState", leakedCredentials)).statusCode).toBe(400);
  });
});
