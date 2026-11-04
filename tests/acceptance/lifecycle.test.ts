import { afterEach, expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { requireS3 } from "../../scripts/run-workspace-tests.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const children: ChildProcess[] = [];
const directories: string[] = [];
const masterKey = "cv-acceptance-only-master";
const storagePrefix = `${process.env.CV_TEST_S3_PREFIX ?? ""}acceptance-${randomUUID()}/`;
function serverEnvironment(serverDirectory: string, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TZ", "__CF_USER_TEXT_ENCODING"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  const backend = process.env.CV_TEST_BACKEND ?? "git";
  if (!["git", "s3"].includes(backend)) throw new Error("Explicit supported test backend required");
  Object.assign(env, { PORT: String(port), HOST: "127.0.0.1", CONTEXTVAULT_API_KEY: masterKey, HOME: serverDirectory, V8_COMPILE_CACHE_CACHE_DIR: path.join(serverDirectory, "compile-cache"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(serverDirectory, "gitconfig"), CV_DATA_DIR: path.join(serverDirectory, "data"), TS_NODE_PROJECT: path.join(root, "tsconfig.json"), CV_STORAGE_BACKEND: backend,
    GIT_AUTHOR_NAME: "Acceptance", GIT_AUTHOR_EMAIL: "acceptance@example.invalid", GIT_COMMITTER_NAME: "Acceptance", GIT_COMMITTER_EMAIL: "acceptance@example.invalid" });
  if (backend === "s3") {
    for (const key of ["PROVIDER", "BUCKET", "REGION", "PREFIX"]) if (!process.env[`CV_TEST_S3_${key}`]) throw new Error(`Missing CV_TEST_S3_${key}`);
    const provider = process.env.CV_TEST_S3_PROVIDER;
    if (!["aws", "localstack"].includes(provider!)) throw new Error("Explicit supported S3 provider required");
    requireS3({ ...process.env }, { s3Provider: provider });
    Object.assign(env, { CV_S3_PROVIDER: provider, CV_S3_ENDPOINT: process.env.CV_TEST_S3_ENDPOINT, CV_S3_BUCKET: process.env.CV_TEST_S3_BUCKET, CV_S3_REGION: process.env.CV_TEST_S3_REGION, CV_S3_PREFIX: storagePrefix });
    if (provider === "localstack") Object.assign(env, { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", AWS_EC2_METADATA_DISABLED: "true" });
    else { if (process.env.HOME) env.HOME = process.env.HOME; for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE", "AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_EC2_METADATA_DISABLED"]) if (process.env[key] !== undefined) env[key] = process.env[key]; }
  }
  return env;
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startServer(serverDirectory: string, port: number) {
  const child = spawn(process.execPath, [
    "-r", path.join(root, "node_modules/ts-node/register/transpile-only"),
    path.join(root, "src/index.ts"),
  ], {
    cwd: serverDirectory,
    env: serverEnvironment(serverDirectory, port),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server startup failed: ${output}`);
    try {
      const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (health.ok && (await health.json() as { status: string }).status === "healthy") return { child, baseUrl };
    } catch { /* Wait for the real listener. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become healthy: ${output}`);
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(force);
}

async function client(baseUrl: string, directory: string, keys: string[], action: string, workspaceId?: string) {
  const child = spawn(process.execPath, [path.join(root, "tests/helpers/public-lifecycle-client.mjs"), action], {
    cwd: directory,
    // The HTTP client receives no server directory or storage credentials.
    env: { PATH: process.env.PATH, CV_URL: baseUrl, CV_KEY_A: keys[0], CV_KEY_B: keys[1], CV_WORKSPACE_ID: workspaceId },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  expect(code, `Public lifecycle client failed:\n${output}`).toBe(0);
  return JSON.parse(output) as { workspaceId: string };
}

async function cleanStorage() {
  if (process.env.CV_TEST_BACKEND !== "s3") return;
  const { S3Client, ListMultipartUploadsCommand, AbortMultipartUploadCommand, ListObjectsV2Command, DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
  const env = serverEnvironment(directories[0], 1);
  const client = new S3Client({ region: env.CV_S3_REGION, endpoint: env.CV_S3_ENDPOINT, forcePathStyle: env.CV_S3_PROVIDER === "localstack", ignoreConfiguredEndpointUrls: true, maxAttempts: 1,
    ...(env.CV_S3_PROVIDER === "localstack" ? { credentials: { accessKeyId: "test", secretAccessKey: "test" } } : {}) });
  const deadline = Date.now() + 10000;
  const send = (command: any) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Owned acceptance storage cleanup timed out");
    return client.send(command, { abortSignal: AbortSignal.timeout(remaining) }) as Promise<any>;
  };
  const owned = (key: unknown): key is string => typeof key === "string" && key.startsWith(storagePrefix) && key.length > storagePrefix.length;
  try {
    let complete = false;
    for (let page = 0; page < 100; page++) {
      const value = await send(new ListMultipartUploadsCommand({ Bucket: env.CV_S3_BUCKET, Prefix: storagePrefix, MaxUploads: 100 }));
      if (!value.Uploads?.length) { if (value.IsTruncated) throw new Error("Invalid owned upload cleanup page"); complete = true; break; }
      for (const upload of value.Uploads) {
        if (!owned(upload.Key) || typeof upload.UploadId !== "string" || !upload.UploadId) throw new Error("Upload escaped owned acceptance prefix");
        await send(new AbortMultipartUploadCommand({ Bucket: env.CV_S3_BUCKET, Key: upload.Key, UploadId: upload.UploadId }));
      }
    }
    if (!complete) throw new Error("Owned upload cleanup page limit exceeded");
    complete = false;
    for (let page = 0; page < 100; page++) {
      const value = await send(new ListObjectsV2Command({ Bucket: env.CV_S3_BUCKET, Prefix: storagePrefix, MaxKeys: 100 }));
      if (!value.Contents?.length) { if (value.IsTruncated) throw new Error("Invalid owned object cleanup page"); complete = true; break; }
      if (value.Contents.some((object: any) => !owned(object.Key))) throw new Error("Object escaped owned acceptance prefix");
      const result = await send(new DeleteObjectsCommand({ Bucket: env.CV_S3_BUCKET, Delete: { Objects: value.Contents.map((object: any) => ({ Key: object.Key })) } }));
      if (result.Errors?.length) throw new Error("Owned acceptance storage cleanup failed");
    }
    if (!complete) throw new Error("Owned object cleanup page limit exceeded");
  } finally { client.destroy(); }
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stop));
  try { await cleanStorage(); } finally { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); }
});

it("A01/A06: publishes exact bytes and deletions through HTTP, survives restart, and preserves abort isolation", async () => {
  const serverDirectory = await mkdtemp(path.join(await realpath(tmpdir()), "cv-http-server-"));
  const clientDirectory = await mkdtemp(path.join(await realpath(tmpdir()), "cv-http-client-"));
  directories.push(serverDirectory, clientDirectory);
  const port = await unusedPort();
  let server = await startServer(serverDirectory, port);
  const keys = [];
  for (const customerId of ["acceptance-customer-a", "acceptance-customer-b"]) {
    const response = await fetch(`${server.baseUrl}/api-keys`, {
      method: "POST", headers: { "X-API-Key": masterKey, "Content-Type": "application/json" },
      body: JSON.stringify({ customerId, name: "isolated-lifecycle-test" }),
    });
    expect(response.status, "Legacy identity setup must succeed before acceptance assertions").toBe(201);
    keys.push((await response.json() as { plainKey: string }).plainKey);
  }
  const { workspaceId } = await client(server.baseUrl, clientDirectory, keys, "publish");
  await stop(server.child);
  server = await startServer(serverDirectory, port);
  await client(server.baseUrl, clientDirectory, keys, "reopen-and-abort", workspaceId);
  await rm(clientDirectory, { recursive: true, force: true });
  const secondClient = await mkdtemp(path.join(await realpath(tmpdir()), "cv-http-other-client-"));
  directories.push(secondClient);
  await client(server.baseUrl, secondClient, keys, "verify", workspaceId);
}, 60000);
