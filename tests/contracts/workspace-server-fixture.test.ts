import { afterEach, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, CreateMultipartUploadCommand, ListMultipartUploadsCommand, AbortMultipartUploadCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { startWorkspaceServer } from "../helpers/workspace-server.mjs";

const fixtures: Awaited<ReturnType<typeof startWorkspaceServer>>[] = [];
const directories: string[] = [];
const root = path.resolve(import.meta.dirname, "../..");
const backend = process.env.CV_TEST_BACKEND ?? "git";
const execute = promisify(execFile);
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.dispose(); });
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function canaries(fixture: Awaited<ReturnType<typeof startWorkspaceServer>>) {
  if (backend !== "s3") return async () => {};
  const Bucket = process.env.CV_TEST_S3_BUCKET!;
  const owned = `${process.env.CV_TEST_S3_PREFIX}http-fixture-${fixture.id}/`;
  const sibling = `${process.env.CV_TEST_S3_PREFIX}fixture-sibling-${randomUUID()}/`;
  const storage = new S3Client({ region: process.env.CV_TEST_S3_REGION, endpoint: process.env.CV_TEST_S3_ENDPOINT, ignoreConfiguredEndpointUrls: true, forcePathStyle: true, maxAttempts: 1,
    ...(process.env.CV_TEST_S3_PROVIDER === "localstack" ? { credentials: { accessKeyId: "test", secretAccessKey: "test" } } : {}) });
  let siblingUpload: string | undefined;
  const clearSibling = async () => {
    await storage.send(new DeleteObjectCommand({ Bucket, Key: `${sibling}canary` }));
    for (const upload of (await storage.send(new ListMultipartUploadsCommand({ Bucket, Prefix: sibling }))).Uploads ?? []) {
      if (upload.Key?.startsWith(sibling) && upload.UploadId) await storage.send(new AbortMultipartUploadCommand({ Bucket, Key: upload.Key, UploadId: upload.UploadId }));
    }
  };
  try {
    for (const Key of [`${owned}canary`, `${sibling}canary`]) await storage.send(new PutObjectCommand({ Bucket, Key, Body: "fixture-only", ServerSideEncryption: "AES256" }));
    for (let start = 0; start < 100; start += 4) await Promise.all(Array.from({ length: 4 }, (_, index) => storage.send(new PutObjectCommand({ Bucket, Key: `${owned}page-${start + index}`, Body: "fixture-only", ServerSideEncryption: "AES256" }))));
    await storage.send(new CreateMultipartUploadCommand({ Bucket, Key: `${owned}multipart`, ServerSideEncryption: "AES256" }));
    siblingUpload = (await storage.send(new CreateMultipartUploadCommand({ Bucket, Key: `${sibling}multipart`, ServerSideEncryption: "AES256" }))).UploadId;
    if (!siblingUpload) throw new Error("Fixture sibling upload identity is missing");
  } catch (error) { try { await clearSibling(); } finally { storage.destroy(); } throw error; }
  return async () => {
    try {
      await fixture.dispose();
      await expect(storage.send(new GetObjectCommand({ Bucket, Key: `${owned}canary` }))).rejects.toMatchObject({ name: "NoSuchKey" });
      expect((await storage.send(new ListObjectsV2Command({ Bucket, Prefix: owned }))).Contents ?? []).toHaveLength(0);
      const retained = await storage.send(new GetObjectCommand({ Bucket, Key: `${sibling}canary` }));
      expect(await retained.Body?.transformToString()).toBe("fixture-only");
      expect((await storage.send(new ListMultipartUploadsCommand({ Bucket, Prefix: owned }))).Uploads ?? []).toHaveLength(0);
      expect((await storage.send(new ListMultipartUploadsCommand({ Bucket, Prefix: sibling }))).Uploads).toHaveLength(1);
    } finally {
      try { await clearSibling(); } finally { storage.destroy(); }
    }
  };
}

it("starts the real entrypoint and keeps installed-client access separate from server control", async () => {
  const fixture = await startWorkspaceServer({ backend, serverEnv: { CV_REQUEST_TIMEOUT_MS: "12345" } });
  fixtures.push(fixture);
  const verifyCleanup = await canaries(fixture);
  try {
  const { baseUrl, keyA, keyB } = fixture.client;
  expect(Object.keys(fixture.client).sort()).toEqual(["baseUrl", "customerA", "customerB", "keyA", "keyB"]);
  expect(keyA === keyB).toBe(false);
  const original = fingerprint(fixture.client);
  expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  const keys = async (key: string) => {
    const response = await fetch(`${baseUrl}/api-keys`, { headers: { "X-API-Key": key } });
    expect(response.status).toBe(200);
    return response.json();
  };
  expect((await keys(keyA)).data).toHaveLength(1);
  expect((await keys(keyB)).data).toHaveLength(1);
  const environment = fixture.clientEnvironment();
  expect(environment.CV_URL).toBe(baseUrl);
  expect(fingerprint(environment.CV_KEY_A)).toBe(fingerprint(keyA));
  const clientNames = new Set(["CV_URL", "CV_KEY_A", "CV_KEY_B"]);
  expect(Object.keys(environment).some(name => /^(AWS_|CONTEXTVAULT_|TS_NODE_|V8_)/.test(name) || (name.startsWith("CV_") && !clientNames.has(name)))).toBe(false);
  const inspected = await execute(process.execPath, ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], { env: environment });
  // macOS adds this runtime field during exec; it does not carry server authority.
  const allowed = new Set([...Object.keys(environment), ...(process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : [])]);
  expect(JSON.parse(inspected.stdout).every((name: string) => allowed.has(name))).toBe(true);
  await fixture.restart();
  expect(fingerprint(fixture.client)).toBe(original);
  expect((await keys(keyA)).data).toHaveLength(1);
  await fixture.crash();
  await fixture.start();
  expect((await keys(keyB)).data).toHaveLength(1);
  const keyId = (await keys(keyA)).data[0].id;
  expect((await fetch(`${baseUrl}/api-keys/${encodeURIComponent(keyId)}`, { method: "DELETE", headers: { "X-API-Key": keyA } })).status).toBe(204);
  await fixture.restart();
  expect(fingerprint(fixture.client)).toBe(original);
  expect((await fetch(`${baseUrl}/api-keys`, { headers: { "X-API-Key": keyA } })).status).toBe(401);
  expect((await keys(keyB)).data).toHaveLength(1);
  await fixture.stop();
  await expect(fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  } finally { await verifyCleanup(); }
}, 60000);

it("rejects invalid targets, missing server executables and unsafe server overrides before startup", async () => {
  await expect(startWorkspaceServer({ backend: "invalid" })).rejects.toThrow(/explicitly git or s3/);
  await expect(startWorkspaceServer({ backend: "git", serverEnv: { CV_DATA_DIR: "/not-owned" } })).rejects.toThrow(/allowlist/);
  await expect(startWorkspaceServer({ backend: "git", serverNode: "/not-a-real-fixture-node" })).rejects.toThrow(/server executable/);
  await expect(startWorkspaceServer({ backend: "git", serverNode: "/bin/echo" })).rejects.toThrow(/Node.js 22/);
  await expect(startWorkspaceServer({ backend: "git", serverEnv: { CV_LEASE_TTL_MS: "0" } })).rejects.toThrow(/positive safe integers/);
  await expect(startWorkspaceServer({ backend: "git", startupTimeoutMs: 1 })).rejects.toThrow(/before its deadline|before becoming healthy/);
  await expect(startWorkspaceServer({ backend: "s3", env: {} })).rejects.toThrow(/s3-provider/);
  await expect(startWorkspaceServer({ backend: "s3", env: { CV_TEST_S3_PROVIDER: "localstack", CV_TEST_S3_BUCKET: "fixture", CV_TEST_S3_REGION: "us-east-1", CV_TEST_S3_PREFIX: "production/", CV_TEST_S3_ENDPOINT: "http://127.0.0.1:51744" } })).rejects.toThrow(/contextvault-tests/);
  await expect(startWorkspaceServer({ backend: "s3", env: { CV_TEST_S3_PROVIDER: "aws", CV_TEST_S3_BUCKET: "fixture", CV_TEST_S3_REGION: "us-east-1", CV_TEST_S3_PREFIX: "contextvault-tests/fixture-aws/", AWS_PROFILE: `${process.env.AWS_PROFILE ?? ""}-unselected-${randomUUID()}` } })).rejects.toThrow(/controller environment/);
});

it("fails a graceful-stop timeout even after it forcibly terminates the owned server", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cv-fixture-stop-check-")); directories.push(directory);
  const wrapper = path.join(directory, "node-wrapper"); const pidFile = path.join(directory, "server-pid");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(wrapper, `#!/bin/sh\nif [ "$1" = "-p" ]; then exec ${quote(process.execPath)} "$@"; fi\nprintf '%s' "$$" > ${quote(pidFile)}\nexec ${quote(process.execPath)} "$@"\n`);
  await chmod(wrapper, 0o700);
  const fixture = await startWorkspaceServer({ backend, serverNode: wrapper, shutdownTimeoutMs: 250 }); fixtures.push(fixture);
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  process.kill(pid, "SIGSTOP");
  try { await expect(fixture.stop()).rejects.toThrow(/shutdown timed out/); }
  finally { try { process.kill(pid, "SIGCONT"); } catch { /* The fixture already proved forced termination. */ } }
  expect(() => process.kill(pid, 0)).toThrow();
}, 30000);

it("serves private JSON-lines controls and disposes its server when the parent closes stdin", async () => {
  const child = spawn(process.execPath, [path.join(root, "tests/helpers/workspace-server.mjs"), "--stdio"], { cwd: root, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", () => {});
  const exit = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const request = async (value: unknown) => {
    child.stdin.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
    const line = await lines.next();
    if (line.done) throw new Error("Fixture controller exited without a response");
    return JSON.parse(line.value);
  };
  try {
    expect((await request("{")).ok).toBe(false);
    const started = await request({ id: "start", command: "start", backend });
    expect(Object.keys(started).sort()).toEqual(["client", "id", "ok"]);
    expect(Object.keys(started.client).sort()).toEqual(["baseUrl", "customerA", "customerB", "keyA", "keyB"]);
    expect(started.ok).toBe(true);
    expect((await request({ id: "changed", command: "start", backend: backend === "git" ? "s3" : "git" })).ok).toBe(false);
    expect((await request({ id: "unknown", command: "not-a-command" })).ok).toBe(false);
    expect(fingerprint((await request({ id: "restart", command: "restart" })).client)).toBe(fingerprint(started.client));
    child.stdin.end();
    expect(await exit).toBe(0);
    await expect(fetch(`${started.client.baseUrl}/health`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  } finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exit;
  }
}, 60000);

it("rejects an unknown provider before invoking a server executable or selecting credentials", async () => {
  const env = { CV_TEST_S3_PROVIDER: "localstak", CV_TEST_S3_BUCKET: "fixture", CV_TEST_S3_REGION: "us-east-1", CV_TEST_S3_PREFIX: "contextvault-tests/provider-guard/", CV_TEST_S3_ENDPOINT: "http://127.0.0.1:1", AWS_PROFILE: "fixture-only-profile", AWS_ACCESS_KEY_ID: "fixture-only-key" };
  const before = fingerprint(env);
  await expect(startWorkspaceServer({ backend: "s3", serverNode: "/not-invoked", env })).rejects.toThrow(/--s3-provider localstack or aws is required/);
  expect(fingerprint(env)).toBe(before);
});

it.each(["oversized identifiers", "valid responses"])("bounds controller output and disposes its live server when a parent never drains %s", async kind => {
  const temporary = await mkdtemp(path.join(tmpdir(), "cv-controller-output-")); directories.push(temporary);
  const child = spawn(process.execPath, [path.join(root, "tests/helpers/workspace-server.mjs"), "--stdio"], { cwd: root, env: { ...process.env, TMPDIR: temporary }, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", () => {});
  let inputClosed = false;
  child.stdin.on("error", () => { inputClosed = true; });
  const exit = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", code => { inputClosed = true; resolve(code); }); });
  const output = createInterface({ input: child.stdout });
  const lines = output[Symbol.asyncIterator]();
  let baseUrl: string | undefined;
  let storage: S3Client | undefined; let ownedPrefix: string | undefined; let uploadId: string | undefined;
  let maximumLineBytes = 0; let lineBytes = 0;
  const observe = (bytes: Buffer) => { for (const byte of bytes) { if (byte === 10) { maximumLineBytes = Math.max(maximumLineBytes, lineBytes); lineBytes = 0; } else lineBytes++; } };
  const deadline = async <T>(promise: Promise<T>, milliseconds: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Controller did not exit while stdout remained blocked")), milliseconds); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    child.stdin.write(`${JSON.stringify({ id: "start", command: "start", backend })}\n`);
    const first = await deadline(lines.next(), 15000);
    if (first.done) throw new Error("Controller did not start its fixture");
    const started = JSON.parse(first.value); expect(started.ok).toBe(true); baseUrl = started.client.baseUrl;
    if (backend === "s3") {
      const fixtureId = started.client.customerA.slice("fixture-a-".length);
      expect(fixtureId).toMatch(/^[a-f0-9-]{36}$/);
      ownedPrefix = `${process.env.CV_TEST_S3_PREFIX}http-fixture-${fixtureId}/`;
      storage = new S3Client({ region: process.env.CV_TEST_S3_REGION, endpoint: process.env.CV_TEST_S3_ENDPOINT, forcePathStyle: true, ignoreConfiguredEndpointUrls: true, maxAttempts: 1,
        ...(process.env.CV_TEST_S3_PROVIDER === "localstack" ? { credentials: { accessKeyId: "test", secretAccessKey: "test" } } : {}) });
      await storage.send(new PutObjectCommand({ Bucket: process.env.CV_TEST_S3_BUCKET, Key: `${ownedPrefix}response-failure-canary`, Body: "fixture-only", ServerSideEncryption: "AES256" }));
      uploadId = (await storage.send(new CreateMultipartUploadCommand({ Bucket: process.env.CV_TEST_S3_BUCKET, Key: `${ownedPrefix}response-failure-upload`, ServerSideEncryption: "AES256" }))).UploadId;
      expect(typeof uploadId).toBe("string");
    }
    output.close(); child.stdout.pause();
    const size = kind === "oversized identifiers" ? 50_000 : 240;
    const count = kind === "oversized identifiers" ? 300 : 4000;
    for (let index = 0; index < count && !inputClosed; index++) {
      child.stdin.write(`${JSON.stringify({ id: `${index}-${"x".repeat(size)}`, command: "unknown" })}\n`);
      await new Promise(resolve => setTimeout(resolve, kind === "oversized identifiers" ? 5 : 1));
    }
    child.stdin.end();
    expect(await deadline(exit, 5000)).toBe(1);
    await expect(fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    expect(await readdir(temporary)).toEqual([]);
    if (storage) {
      await expect(storage.send(new GetObjectCommand({ Bucket: process.env.CV_TEST_S3_BUCKET, Key: `${ownedPrefix}response-failure-canary` }))).rejects.toMatchObject({ name: "NoSuchKey" });
      expect((await storage.send(new ListMultipartUploadsCommand({ Bucket: process.env.CV_TEST_S3_BUCKET, Prefix: ownedPrefix }))).Uploads ?? []).toHaveLength(0);
    }
    child.stdout.on("data", observe); child.stdout.resume();
    await deadline(new Promise<void>(resolve => { if (child.stdout.readableEnded) resolve(); else child.stdout.once("end", resolve); }), 1000);
    expect(maximumLineBytes).toBeLessThanOrEqual(4096);
  } finally {
    output.close(); child.stdout.on("data", observe); child.stdout.resume(); child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    try { await deadline(exit, 15000); } catch { child.kill("SIGKILL"); await exit; }
    if (storage) {
      try {
        await storage.send(new DeleteObjectCommand({ Bucket: process.env.CV_TEST_S3_BUCKET, Key: `${ownedPrefix}response-failure-canary` }));
        if (uploadId) { try { await storage.send(new AbortMultipartUploadCommand({ Bucket: process.env.CV_TEST_S3_BUCKET, Key: `${ownedPrefix}response-failure-upload`, UploadId: uploadId })); } catch (error) { if ((error as { name?: string }).name !== "NoSuchUpload") throw error; } }
      } finally { storage.destroy(); }
    }
  }
}, 45000);
