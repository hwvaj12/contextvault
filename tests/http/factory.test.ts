import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app";
import { loadConfiguration } from "../../src/config";
import type { RuntimeOptions } from "../../src/config/runtime";
import { SqliteControlStore } from "../../src/adapters/control/sqlite-control-store";
import { SecretsService } from "../../src/services/secrets.service";
import { create, finalize, hash, json, open, submit } from "./helpers";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function factory(masterKey: string, options: RuntimeOptions = {}, environment: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "cv-http-factory-"));
  const configuration = loadConfiguration({ ...environment, CV_DATA_DIR: join(directory, "private"), CONTEXTVAULT_API_KEY: masterKey });
  const app = await createApp({ logger: false, contextVault: { configuration, maintenance: false, ...options } });
  await app.listen({ port: 0, host: "127.0.0.1" }); const baseUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  closes.push(async () => { app.server.closeAllConnections(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, directory, configuration,
    request(method: string, route: string, body?: unknown, key = masterKey, extra: Record<string, string> = {}) {
      const binary = body instanceof Uint8Array;
      return fetch(baseUrl + route, { method, headers: { "X-API-Key": key, "Idempotency-Key": randomUUID(), ...(body === undefined ? {} : { "Content-Type": binary ? "application/octet-stream" : "application/json" }), ...(binary ? { "X-Content-SHA256": hash(body) } : {}), ...extra }, body: body === undefined ? undefined : binary ? Buffer.from(body) : JSON.stringify(body) });
    },
  };
}

it("isolates simultaneous application credentials, databases and private legacy key files", async () => {
  const a = await factory("factory-a-master"); const b = await factory("factory-b-master"); const disabled = await factory("");
  const body = { customerId: "same-customer-name", name: "same-name" };
  const [keyA, keyB] = await Promise.all([json(await a.request("POST", "/api-keys", body), 201), json(await b.request("POST", "/api-keys", body), 201)]);
  expect((await b.request("GET", "/api-keys", undefined, keyA.plainKey)).status).toBe(401);
  expect((await a.request("GET", "/api-keys", undefined, keyB.plainKey)).status).toBe(401);
  expect((await b.request("POST", "/api-keys", body, "factory-a-master")).status).toBe(401);
  expect((await disabled.request("POST", "/api-keys", body, "cv-test-api-key-123")).status).toBe(401);
  for (const [context, key] of [[a, keyA], [b, keyB]] as const) {
    expect((await json(await context.request("GET", "/api-keys", undefined, key.plainKey), 200)).data).toHaveLength(1);
    expect(context.app.contextVault.database.prepare("SELECT id FROM api_keys").all()).toEqual([{ id: key.id }]);
    expect((await stat(context.configuration.databasePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(context.configuration.dataDirectory, "secrets"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(context.configuration.dataDirectory, "secrets/tenant-keys.json"))).mode & 0o777).toBe(0o600);
  }
  const document = (await json(await a.request("GET", "/docs/json"), 200)) as any;
  expect(document.paths["/v1/workspaces"].post.requestBody.content["application/json"].schema.required).toEqual(["customerId", "name"]);
  expect(document.paths["/v1/runs/{id}/submissions/{sid}/files"].put.requestBody.content["application/octet-stream"].schema.format).toBe("binary");
  expect((await a.request("POST", "/v1/workspaces", { customerId: "same-customer-name", name: "strict", storageLocation: "client-selected" }, keyA.plainKey)).status).toBe(400);
});

it("returns finalize202 before processing finishes, preserves pending replay, and blocks publication after HTTP credential revocation", async () => {
  let ready!: () => void; let release!: () => void; const started = new Promise<void>(resolve => { ready = resolve; }); const held = new Promise<void>(resolve => { release = resolve; }); let prepares = 0;
  const context = await factory("pending-finalize-master", { lifecycle: { hook: async (stage, operation) => { if (stage === "before-prepare" && operation.kind === "finalize") { prepares++; ready(); await held; } } } });
  const credential = await json(await context.request("POST", "/api-keys", { customerId: "tenant-a", name: "pending" }), 201); const key = credential.plainKey;
  const workspace = await create(context, key); const run = await open(context, workspace.id, key); const submission = await submit(context, run, key, { "unaccepted.bin": Buffer.from([0, 255]) });
  const payload = { expectedRunVersion: run.version, submissionId: submission.id }; const header = { "Idempotency-Key": "pending-finalize" };
  const first = context.request("POST", `/v1/runs/${run.id}/finalize`, payload, key, header);
  try {
    await started;
    const response = await Promise.race([first, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Finalize must return202 while processing is held")), 5000); timer.unref(); })]);
    const pending = await json(response, 202);
    expect((await json(await context.request("POST", `/v1/runs/${run.id}/finalize`, payload, key, header), 202)).id).toBe(pending.id);
    const current = await json(await context.request("GET", `/v1/runs/${run.id}`, undefined, key), 200);
    const aborted = await context.request("POST", `/v1/runs/${run.id}/abort`, { expectedRunVersion: current.version, reason: "too late" }, key);
    expect((await json(aborted, 409)).error.code).toBe("FINALIZATION_IN_PROGRESS");
    expect((await context.request("DELETE", `/api-keys/${credential.id}`)).status).toBe(204);
    release(); let outcome: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      outcome = await json(await context.request("GET", `/v1/operations/${pending.id}`, undefined, undefined, { "X-ContextVault-Customer-ID": "tenant-a" }), 200);
      if (outcome.state === "failed") break; await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(outcome.state).toBe("failed"); expect(outcome.error.code).toBe("CREDENTIAL_REVOKED"); expect(prepares).toBe(1);
    expect((await context.app.contextVault.control.listRevisions({ customerId: "tenant-a" as never, workspaceId: workspace.id })).revisions).toHaveLength(1);
  } finally { release(); await first; }
});

it("independently validates supplied Content-Length rather than trusting upload bytes", async () => {
  const context = await factory("length-master"); const credential = await json(await context.request("POST", "/api-keys", { customerId: "tenant-a", name: "length" }), 201); const key = credential.plainKey;
  const workspace = await create(context, key); const run = await open(context, workspace.id, key);
  const submission = await json(await context.request("POST", `/v1/runs/${run.id}/submissions`, {}, key), 201); const bytes = Buffer.from([0, 255, 128]);
  const response = await context.app.inject({ method: "PUT", url: `/v1/runs/${run.id}/submissions/${submission.id}/files?path=length.bin`, headers: { "X-API-Key": key, "Idempotency-Key": "declared-length", "Content-Type": "application/octet-stream", "Content-Length": "4", "X-Content-SHA256": hash(bytes) }, payload: bytes });
  expect(response.statusCode).toBe(422); expect(response.json().error.code).toBe("RECEIPT_MISMATCH");
});

it("rechecks credential revocation atomically before issuing another credential", async () => {
  const context = await factory("credential-race-master");
  const credential = await json(await context.request("POST", "/api-keys", { customerId: "tenant-a", name: "revoked-parent" }), 201);
  const original = SqliteControlStore.prototype.getAuthority; let observed = 0;
  const spy = vi.spyOn(SqliteControlStore.prototype, "getAuthority").mockImplementation(async function (scope, principal) {
    const snapshot = await original.call(this, scope, principal);
    if (principal.credential.id === credential.id && ++observed === 2) expect((await context.request("DELETE", `/api-keys/${credential.id}`)).status).toBe(204);
    return snapshot;
  });
  try {
    const response = await context.request("POST", "/api-keys", { customerId: "tenant-a", name: "must-not-survive-revocation" }, credential.plainKey);
    expect(response.status).toBe(403);
    expect(context.app.contextVault.database.prepare("SELECT id FROM api_keys WHERE name=?").all("must-not-survive-revocation")).toEqual([]);
  } finally { spy.mockRestore(); }
});

it("bounds concurrent HTTP downloads independently of backend implementation", async () => {
  const context = await factory("download-limit-master", {}, { CV_WORKSPACE_LIMITS: '{"maxConcurrentStreams":1}' });
  const key = (await json(await context.request("POST", "/api-keys", { customerId: "tenant-a", name: "downloads" }), 201)).plainKey;
  const workspace = await create(context, key); const run = await open(context, workspace.id, key); const submission = await submit(context, run, key, { "file.bin": Buffer.from([0, 255]) });
  expect((await finalize(context, run, key, submission.id)).state).toBe("succeeded"); const read = await open(context, workspace.id, key, "read-only");
  const binding = await context.app.contextVault.control.getBinding({ customerId: "tenant-a" as never, workspaceId: workspace.id }, (await context.app.contextVault.control.getWorkspace({ customerId: "tenant-a" as never, workspaceId: workspace.id }))!.storageBindingId);
  const store = await context.app.contextVault.revisionStore(binding!); const originalOpen = store.openFile.bind(store); const originalManifest = store.readManifest.bind(store);
  let release!: () => void; let firstReady!: () => void; let secondReady!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { firstReady = resolve; }); const secondMetadata = new Promise<void>(resolve => { secondReady = resolve; }); let manifests = 0;
  const opened = vi.spyOn(store, "openFile").mockImplementation(async (...args) => { const bytes = await originalOpen(...args); return (async function* () { firstReady(); await held; yield* bytes; })(); });
  const metadata = vi.spyOn(store, "readManifest").mockImplementation(async (...args) => { const value = await originalManifest(...args); if (++manifests === 2) secondReady(); return value; });
  const first = context.request("GET", `/v1/runs/${read.id}/workspace/files?path=file.bin`, undefined, key); let second: Promise<Response> | undefined;
  try {
    await started; second = context.request("GET", `/v1/runs/${read.id}/workspace/files?path=file.bin`, undefined, key); await secondMetadata; await new Promise<void>(resolve => setImmediate(resolve));
    expect(opened).toHaveBeenCalledTimes(1); release();
    for (const response of await Promise.all([first, second])) { expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0, 255])); }
  } finally {
    release(); const completed = await Promise.allSettled([first, ...(second ? [second] : [])]);
    for (const result of completed) if (result.status === "fulfilled" && !result.value.bodyUsed) await result.value.body?.cancel();
    opened.mockRestore(); metadata.mockRestore();
  }
});

it("preserves an explicitly configured legacy local secret store instead of generating replacement tenant keys", async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "cv-existing-secrets-")); const path = join(directory, "existing.json");
  const contents = JSON.stringify({ "tenant-a": { tmk: JSON.stringify({ tmk: Buffer.alloc(32, 7).toString("base64"), keyId: "retained-key", createdAt: "2026-01-01T00:00:00.000Z" }) } }); await writeFile(path, contents, { mode: 0o600 });
  const original = SecretsService.prototype.ensureTmk; const observed: string[] = [];
  const spy = vi.spyOn(SecretsService.prototype, "ensureTmk").mockImplementation(async function (customerId) { const key = await original.call(this, customerId); observed.push(key.keyId); return key; });
  try {
    const context = await factory("legacy-store-master", {}, { CONTEXTVAULT_SECRETS_PATH: path });
    const key = (await json(await context.request("POST", "/api-keys", { customerId: "tenant-a", name: "legacy" }), 201)).plainKey;
    expect((await context.request("GET", "/api-keys", undefined, key)).status).toBe(200); expect(observed).toEqual(["retained-key"]);
    expect(await readFile(path, "utf8")).toBe(contents); expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally { spy.mockRestore(); await rm(directory, { recursive: true, force: true }); }
});

it("returns pending creation202 without inventing an accepted workspace or processing the same claim twice", async () => {
  let ready!: () => void; let release!: () => void; const started = new Promise<void>(resolve => { ready = resolve; }); const held = new Promise<void>(resolve => { release = resolve; }); let prepares = 0;
  const context = await factory("pending-creation-master", { lifecycle: { hook: async (stage, operation) => { if (stage === "before-prepare" && operation.kind === "workspace:create") { prepares++; ready(); await held; } } } });
  const key = (await json(await context.request("POST", "/api-keys", { customerId: "tenant-a", name: "pending" }), 201)).plainKey;
  const body = { customerId: "tenant-a", name: "pending" }; const header = { "Idempotency-Key": "pending-creation" };
  const first = context.request("POST", "/v1/workspaces", body, key, header);
  try {
    await started; const pending = await json(await context.request("POST", "/v1/workspaces", body, key, header), 202);
    expect(pending.kind).toBe("workspace:create"); expect(pending).not.toHaveProperty("currentRevisionId"); expect(pending).not.toHaveProperty("intent");
    expect((await json(await context.request("GET", `/v1/operations/${pending.id}`, undefined, key), 200)).state).toBe("processing");
    expect((await context.request("GET", `/v1/workspaces/${pending.workspaceId}`, undefined, key)).status).toBe(404);
    release(); const accepted = await json(await first, 201); expect(accepted.id).toBe(pending.workspaceId); expect(prepares).toBe(1);
    expect((await json(await context.request("GET", `/v1/operations/${pending.id}`, undefined, key), 200)).state).toBe("succeeded");
  } finally { release(); await first; }
});
