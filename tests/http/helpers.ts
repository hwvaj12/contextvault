import { afterEach, expect } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";

export const root = resolve(import.meta.dirname, "../..");
export const master = "cv-http-tests-explicit-master";
export const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const resources: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });
const runtimeNames = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR", "PATHEXT"];
const controlledSettings = new Set(["PATH", "CONTEXTVAULT_API_KEY", "CV_LEASE_TTL_MS", "CV_PROCESSING_TTL_MS", "CV_MAINTENANCE_INTERVAL_MS", "CV_REQUEST_TIMEOUT_MS", "CV_WORKSPACE_LIMITS", "CV_STORAGE_BACKEND", "CV_GIT_ROOT", "CV_SUBMISSION_ROOT", "CV_STORAGE_PROFILES", "CV_S3_PREFIX"]);
function settings(changes: NodeJS.ProcessEnv) {
  for (const [name, value] of Object.entries(changes)) if (!controlledSettings.has(name) || typeof value !== "string") throw new Error(`Unsupported fixture controlled setting: ${name}`);
  return changes;
}
function validateStorageSelection(storage: NodeJS.ProcessEnv) {
  if (storage.CV_STORAGE_BACKEND !== "git" && storage.CV_STORAGE_BACKEND !== "s3") throw new Error(`Unsupported fixture storage backend: ${storage.CV_STORAGE_BACKEND}`);
  if (storage.CV_STORAGE_BACKEND === "s3" && storage.CV_S3_PROVIDER !== "localstack" && storage.CV_S3_PROVIDER !== "aws") throw new Error(`Unsupported fixture S3 provider: ${storage.CV_S3_PROVIDER}`);
}

export function fixtureEnvironment(directory: string, selectedPort: number, storage: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv = {}, ambient: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const selectedStorage = { ...storage, ...settings(overrides) };
  validateStorageSelection(selectedStorage);
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(runtimeNames.filter(name => ambient[name] !== undefined).map(name => [name, ambient[name]])),
    ...selectedStorage, HOME: directory,
    PORT: String(selectedPort), HOST: "127.0.0.1", CONTEXTVAULT_API_KEY: overrides.CONTEXTVAULT_API_KEY ?? master,
    CV_DATA_DIR: join(directory, "data"), TS_NODE_PROJECT: join(root, "tsconfig.json"), V8_COMPILE_CACHE_CACHE_DIR: join(directory, "compile-cache"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(directory, "gitconfig"),
    GIT_AUTHOR_NAME: "ContextVault fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "ContextVault fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  if (selectedStorage.CV_STORAGE_BACKEND === "s3" && selectedStorage.CV_S3_PROVIDER === "aws") {
    for (const name of Object.keys(ambient)) if (name.startsWith("AWS_")) env[name] = ambient[name];
    if (ambient.HOME) env.HOME = ambient.HOME;
  } else if (selectedStorage.CV_STORAGE_BACKEND === "s3" && selectedStorage.CV_S3_PROVIDER === "localstack") {
    Object.assign(env, { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", AWS_EC2_METADATA_DISABLED: "true" });
  }
  return env;
}

async function port() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const value = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return value;
}
export function storageEnvironment(prefix?: string): NodeJS.ProcessEnv {
  const selection = { CV_STORAGE_BACKEND: process.env.CV_TEST_BACKEND ?? "git", CV_S3_PROVIDER: process.env.CV_TEST_S3_PROVIDER };
  validateStorageSelection(selection);
  if (selection.CV_STORAGE_BACKEND === "git") return { CV_STORAGE_BACKEND: "git" };
  for (const key of ["CV_TEST_S3_PROVIDER", "CV_TEST_S3_ENDPOINT", "CV_TEST_S3_BUCKET", "CV_TEST_S3_REGION", "CV_TEST_S3_PREFIX"]) if (!process.env[key]) throw new Error(`Missing explicit ${key}`);
  return { CV_STORAGE_BACKEND: "s3", CV_S3_PROVIDER: process.env.CV_TEST_S3_PROVIDER, CV_S3_ENDPOINT: process.env.CV_TEST_S3_ENDPOINT,
    CV_S3_BUCKET: process.env.CV_TEST_S3_BUCKET, CV_S3_REGION: process.env.CV_TEST_S3_REGION, CV_S3_PREFIX: prefix ?? `${process.env.CV_TEST_S3_PREFIX}http-${randomUUID()}/` };
}
export async function cleanupHttpStorage(storage: NodeJS.ProcessEnv, timeoutMs = 10000) {
  validateStorageSelection(storage);
  if (storage.CV_STORAGE_BACKEND === "git") return;
  const [{ S3Client }, { cleanupHttpFixtureStorage }] = await Promise.all([import("@aws-sdk/client-s3"), import("./no-git-server.mjs")]);
  const client = new S3Client({ region: storage.CV_S3_REGION, endpoint: storage.CV_S3_ENDPOINT, forcePathStyle: true, ignoreConfiguredEndpointUrls: true, maxAttempts: 1,
    ...(storage.CV_S3_PROVIDER === "localstack" ? { credentials: { accessKeyId: "test", secretAccessKey: "test" } } : {}) });
  try { await cleanupHttpFixtureStorage({ client, bucket: storage.CV_S3_BUCKET, prefix: storage.CV_S3_PREFIX, timeoutMs }); }
  finally { client.destroy(); }
}
export async function fixture(overrides: NodeJS.ProcessEnv = {}) {
  settings(overrides);
  const storage = storageEnvironment();
  validateStorageSelection({ ...storage, ...overrides });
  const directory = await mkdtemp(join(await realpath(tmpdir()), "cv-http-"));
  const selectedPort = await port();
  const env = fixtureEnvironment(directory, selectedPort, storage, overrides);
  let child: ChildProcess | undefined; let output = "";
  const baseUrl = `http://127.0.0.1:${selectedPort}`;
  const context = {
    directory, env, baseUrl,
    get child() { return child!; },
    get output() { return output; },
    async start(changes: NodeJS.ProcessEnv = {}) {
      Object.assign(env, settings(changes)); output = "";
      child = spawn(process.execPath, ["-r", join(root, "node_modules/ts-node/register/transpile-only"), join(root, "src/index.ts")], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout!.on("data", bytes => { output += bytes; }); child.stderr!.on("data", bytes => { output += bytes; });
      for (let attempt = 0; attempt < 150; attempt++) {
        if (child.exitCode !== null) throw new Error(`Server exited before health: ${output}`);
        try { if ((await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* Await owned listener. */ }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Server startup timed out: ${output}`);
    },
    async stop(signal: NodeJS.Signals = "SIGTERM") {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>(resolve => child!.once("exit", () => resolve())); child.kill(signal);
      const force = setTimeout(() => child?.kill("SIGKILL"), 5000); await exited; clearTimeout(force);
    },
    request(method: string, route: string, body?: unknown, key = master, extra: Record<string, string> = {}) {
      const binary = body instanceof Uint8Array;
      return fetch(`${baseUrl}${route}`, { method, headers: { "X-API-Key": key, "Idempotency-Key": randomUUID(), ...(body === undefined ? {} : { "Content-Type": binary ? "application/octet-stream" : "application/json" }), ...(binary ? { "X-Content-SHA256": hash(body) } : {}), ...extra }, body: body === undefined ? undefined : binary ? Buffer.from(body) : JSON.stringify(body) });
    },
    async key(customerId = "tenant-a") {
      const response = await context.request("POST", "/api-keys", { customerId, name: "isolated-http-test" }); expect(response.status).toBe(201);
      return (await response.json() as { plainKey: string }).plainKey;
    },
  };
  resources.push(async () => {
    try { await context.stop(); await cleanupHttpStorage(storage); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  await context.start(); return context;
}

export async function json(response: Response, status: number) {
  expect(response.status, await response.clone().text()).toBe(status); return response.json();
}
export interface HttpClient { request(method: string, route: string, body?: unknown, key?: string, extra?: Record<string, string>): Promise<Response> }
export async function create(context: HttpClient, key: string, customerId = "tenant-a") {
  return json(await context.request("POST", "/v1/workspaces", { customerId, name: "HTTP workspace" }, key), 201);
}
export async function open(context: HttpClient, workspaceId: string, key: string, mode = "read-write") {
  return json(await context.request("POST", `/v1/workspaces/${workspaceId}/runs`, { mode, agentLabel: "existing-agent", task: "HTTP test", reason: "verify authoritative changes" }, key), 201);
}
export async function submit(context: HttpClient, run: any, key: string, files: Record<string, Buffer>) {
  const submission = await json(await context.request("POST", `/v1/runs/${run.id}/submissions`, {}, key), 201); const entries = []; const receipts = [];
  for (const path of Object.keys(files).sort()) {
    const bytes = files[path]; const receipt = await json(await context.request("PUT", `/v1/runs/${run.id}/submissions/${submission.id}/files?path=${encodeURIComponent(path)}`, bytes, key), 201);
    entries.push({ path, kind: "file", byteLength: bytes.length, sha256: hash(bytes) }); receipts.push({ path, receiptId: receipt.id });
  }
  await json(await context.request("POST", `/v1/runs/${run.id}/submissions/${submission.id}/seal`, { manifest: { schemaVersion: 1, entries }, receipts }, key), 200);
  return submission;
}
export async function finalize(context: HttpClient, run: any, key: string, submissionId?: string) {
  const operation = await json(await context.request("POST", `/v1/runs/${run.id}/finalize`, { expectedRunVersion: run.version, ...(submissionId ? { submissionId } : {}) }, key), 202);
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await json(await context.request("GET", `/v1/operations/${operation.id}`, undefined, key), 200);
    if (["succeeded", "failed"].includes(result.state)) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Finalization did not reach a durable outcome");
}
