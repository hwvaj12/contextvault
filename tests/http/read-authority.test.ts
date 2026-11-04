import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app";
import { loadConfiguration } from "../../src/config";
import { StreamLimiter } from "../../src/application/files";
import type { Timestamp } from "../../src/domain";
import { create, finalize, hash, json, open, storageEnvironment, submit } from "./helpers";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const contents = Buffer.from([0, 255, 128, 42]);
const master = "cv-read-authority-owned-master";
function gate() {
  let enter!: () => void; let release!: () => void;
  return { started: new Promise<void>(resolve => { enter = resolve; }), held: new Promise<void>(resolve => { release = resolve; }),
    enter: () => enter(), release: () => release() };
}

async function fixture() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "cv-read-authority-"));
  // Pass only explicit owned configuration. Never load the user's server paths or credentials.
  const storage = storageEnvironment();
  const configuration = loadConfiguration({ ...storage, CV_DATA_DIR: directory, CONTEXTVAULT_API_KEY: master,
    CV_WORKSPACE_LIMITS: '{"maxConcurrentStreams":1,"maxChunkBytes":2}' });
  let now = "2026-11-04T12:00:00.000Z" as Timestamp;
  const app = await createApp({ logger: false, contextVault: { configuration, maintenance: false, now: () => now } });
  closes.push(async () => {
    app.server.closeAllConnections(); await app.close();
    try {
      if (storage.CV_STORAGE_BACKEND === "s3") {
        const parentPrefix = process.env.CV_TEST_S3_PREFIX!; const prefix = storage.CV_S3_PREFIX!;
        if (!prefix.startsWith(parentPrefix) || !/^http-[a-f0-9-]+\/$/.test(prefix.slice(parentPrefix.length))) throw new Error("Cleanup requires an exact owned child prefix");
        const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
        const client = new S3Client({ region: storage.CV_S3_REGION, endpoint: storage.CV_S3_ENDPOINT, forcePathStyle: true,
          ...(storage.CV_S3_PROVIDER === "localstack" ? { credentials: { accessKeyId: "test", secretAccessKey: "test" } } : {}), ignoreConfiguredEndpointUrls: true });
        const abortSignal = AbortSignal.timeout(10_000); let complete = false;
        try {
          for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
            const page = await client.send(new ListObjectsV2Command({ Bucket: storage.CV_S3_BUCKET, Prefix: prefix, MaxKeys: 1000 }), { abortSignal });
            if (!page.Contents?.length) { complete = true; break; }
            if (page.Contents.some(item => !item.Key?.startsWith(prefix))) throw new Error("Cleanup listing escaped the owned child prefix");
            const removed = await client.send(new DeleteObjectsCommand({ Bucket: storage.CV_S3_BUCKET,
              Delete: { Objects: page.Contents.map(item => ({ Key: item.Key! })) } }), { abortSignal });
            if (removed.Errors?.length) throw new Error("Owned child-prefix cleanup did not remove every object");
          }
          if (!complete) throw new Error("Owned child-prefix cleanup exceeded its page budget");
        } finally { client.destroy(); }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const context = { app,
    request(method: string, route: string, body?: unknown, key = master, extra: Record<string, string> = {}) {
      const binary = body instanceof Uint8Array;
      return fetch(baseUrl + route, { method, headers: { "X-API-Key": key, "Idempotency-Key": randomUUID(),
        ...(body === undefined ? {} : { "Content-Type": binary ? "application/octet-stream" : "application/json" }),
        ...(binary ? { "X-Content-SHA256": hash(body) } : {}), ...extra },
      body: body === undefined ? undefined : binary ? Buffer.from(body) : JSON.stringify(body) });
    },
  };
  const credential = await json(await context.request("POST", "/api-keys", { customerId: "tenant-a", name: "owned-reader" }), 201);
  const recovery = await json(await context.request("POST", "/api-keys", { customerId: "tenant-a", name: "owned-recovery" }), 201);
  const workspace = await create(context, credential.plainKey); const writer = await open(context, workspace.id, credential.plainKey);
  const submission = await submit(context, writer, credential.plainKey, { "pinned.bin": contents, "empty.bin": Buffer.alloc(0) });
  expect((await finalize(context, writer, credential.plainKey, submission.id)).state).toBe("succeeded");
  const read = await open(context, workspace.id, credential.plainKey, "read-only");
  const scope = { customerId: "tenant-a" as never, workspaceId: workspace.id };
  const pinned = (await app.contextVault.control.getRun(scope, read.id))!;
  const binding = (await app.contextVault.control.getBinding(scope, pinned.scope.storageBindingId))!;
  const store = await app.contextVault.revisionStore(binding);
  return { ...context, credential, recovery, workspace, read, store,
    expire() { now = pinned.lease.expiresAt; },
    file(runId = read.id) { return `/v1/runs/${runId}/workspace/files?path=pinned.bin`; },
  };
}

type Context = Awaited<ReturnType<typeof fixture>>;
const changes = ["revoke", "abort", "expire"] as const;
async function invalidate(context: Context, change: typeof changes[number]) {
  if (change === "revoke") expect((await context.request("DELETE", `/api-keys/${context.credential.id}`)).status).toBe(204);
  else if (change === "abort") await json(await context.request("POST", `/v1/runs/${context.read.id}/abort`,
    { expectedRunVersion: context.read.version, reason: "owned authority test" }, context.credential.plainKey), 200);
  else context.expire();
}
async function denied(response: Response, change: typeof changes[number]) {
  const expected = change === "revoke" ? [403, "CREDENTIAL_REVOKED"] : change === "abort" ? [409, "INVALID_TRANSITION"] : [410, "RUN_EXPIRED"];
  const body = await response.text();
  expect(response.status, body).toBe(expected[0]); expect(JSON.parse(body).error.code).toBe(expected[1]);
  expect(response.headers.get("x-content-sha256")).toBeNull();
}
async function recovered(context: Context) {
  const read = await open(context, context.workspace.id, context.recovery.plainKey, "read-only");
  const response = await context.request("GET", context.file(read.id), undefined, context.recovery.plainKey);
  expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(contents);
}

const delays = ["manifest", "file-manifest", "open-file", "first-chunk"] as const;
it.each(delays.flatMap(delay => changes.map(change => ({ delay, change }))))(
  "blocks $change during a delayed $delay before workspace disclosure", async ({ delay, change }) => {
    const context = await fixture(); const held = gate(); let sourceClosed = false;
    const originalManifest = context.store.readManifest.bind(context.store); const originalOpen = context.store.openFile.bind(context.store);
    const metadata = vi.spyOn(context.store, "readManifest").mockImplementation(async (...args) => {
      const manifest = await originalManifest(...args);
      if (delay === "manifest" || delay === "file-manifest") { held.enter(); await held.held; }
      return manifest;
    });
    const opened = vi.spyOn(context.store, "openFile").mockImplementation(async (...args) => {
      if (delay === "open-file") { held.enter(); await held.held; }
      const bytes = await originalOpen(...args);
      if (delay !== "first-chunk") return bytes;
      return (async function* () {
        try { held.enter(); await held.held; yield* bytes; } finally { sourceClosed = true; }
      })();
    });
    const route = delay === "manifest" ? `/v1/runs/${context.read.id}/workspace/manifest` : context.file();
    const pending = context.request("GET", route, undefined, context.credential.plainKey);
    try {
      await held.started; await invalidate(context, change); held.release();
      await denied(await pending, change);
      if (delay === "first-chunk") expect(sourceClosed).toBe(true);
    } finally {
      held.release(); const response = await pending; if (!response.bodyUsed) await response.body?.cancel();
      metadata.mockRestore(); opened.mockRestore();
    }
    await recovered(context);
  });

it.each(changes)("blocks %s while a download waits for stream capacity", async change => {
  const context = await fixture(); const held = gate(); const queued = gate(); let acquisitions = 0; let sourceClosed = false;
  const originalAcquire = StreamLimiter.prototype.acquire; const originalOpen = context.store.openFile.bind(context.store);
  const capacity = vi.spyOn(StreamLimiter.prototype, "acquire").mockImplementation(function (signal) {
    const acquired = originalAcquire.call(this, signal);
    if (++acquisitions === 2) queued.enter();
    return acquired;
  });
  const opened = vi.spyOn(context.store, "openFile").mockImplementation(async (...args) => {
    const bytes = await originalOpen(...args);
    return (async function* () { try { held.enter(); await held.held; yield* bytes; } finally { sourceClosed = true; } })();
  });
  const first = context.request("GET", context.file(), undefined, context.credential.plainKey); let second: Promise<Response> | undefined;
  try {
    await held.started; second = context.request("GET", context.file(), undefined, context.credential.plainKey); await queued.started;
    expect(opened).toHaveBeenCalledTimes(1); await invalidate(context, change); held.release();
    for (const response of await Promise.all([first, second])) await denied(response, change);
    expect(opened).toHaveBeenCalledTimes(1); expect(sourceClosed).toBe(true);
  } finally {
    held.release(); const responses = await Promise.all([first, ...(second ? [second] : [])]);
    for (const response of responses) if (!response.bodyUsed) await response.body?.cancel();
    opened.mockRestore(); capacity.mockRestore();
  }
  await recovered(context);
});

it("keeps the original revision when another run publishes during a manifest wait", async () => {
  const context = await fixture(); const held = gate(); const original = context.store.readManifest.bind(context.store); let first = true;
  const metadata = vi.spyOn(context.store, "readManifest").mockImplementation(async (...args) => {
    const manifest = await original(...args);
    if (first) { first = false; held.enter(); await held.held; }
    return manifest;
  });
  const pending = context.request("GET", context.file(), undefined, context.credential.plainKey);
  try {
    await held.started;
    const writer = await open(context, context.workspace.id, context.recovery.plainKey);
    const submission = await submit(context, writer, context.recovery.plainKey, { "pinned.bin": Buffer.from("new revision") });
    expect((await finalize(context, writer, context.recovery.plainKey, submission.id)).state).toBe("succeeded");
    held.release(); const response = await pending;
    expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(contents);
    expect(response.headers.get("x-content-sha256")).toBe(hash(contents));
  } finally { held.release(); const response = await pending; if (!response.bodyUsed) await response.body?.cancel(); metadata.mockRestore(); }
});
