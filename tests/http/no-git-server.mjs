#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand, ListMultipartUploadsCommand, AbortMultipartUploadCommand } from "@aws-sdk/client-s3";

// Explicit standalone runtime gate. Ordinary unit tests do not silently substitute a PATH probe for Git absence.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const run = promisify(execFile);
const dockerCommand = async (args, timeout) => (await run("docker", args, { maxBuffer: 4 * 1024 * 1024, timeout, killSignal: "SIGKILL" })).stdout.trim();
const docker = (...args) => dockerCommand(args, 120000);

export const cleanupNoGitFixture = options => cleanupOwnedFixture({ ...options, kind: "no-git" });
export const cleanupHttpFixtureStorage = options => cleanupOwnedFixture({ ...options, kind: "http", created: false });

async function cleanupOwnedFixture({ client, bucket, prefix, name, kind, created = false, docker = dockerCommand, timeoutMs = 30000, maxPages = 1000 }) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, "Cleanup timeout must be between 1 and 120000 milliseconds");
  assert.ok(Number.isSafeInteger(maxPages) && maxPages > 0 && maxPages <= 1000, "Cleanup page bound must be between 1 and 1000");
  const owned = /^contextvault-tests\/[A-Za-z0-9][A-Za-z0-9._-]*\/(no-git|http)-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/$/.exec(prefix);
  assert.ok(owned && owned[1] === kind && !prefix.includes(".."), "Cleanup requires the exact owned prefix");
  if (kind === "no-git") assert.equal(name, `cv-no-git-${owned[2]}`, "Cleanup requires the exact owned container");
  assert.match(bucket, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
  const deadline = Date.now() + timeoutMs;
  const remaining = () => { const value = deadline - Date.now(); if (value <= 0) throw new Error("Owned fixture cleanup timed out"); return value; };
  const send = async command => {
    const signal = AbortSignal.timeout(remaining());
    try { return await client.send(command, { abortSignal: signal }); }
    catch (error) { if (signal.aborted || Date.now() >= deadline) throw new Error("Owned fixture storage cleanup timed out", { cause: error }); throw error; }
  };
  const ownedKey = key => { assert.ok(typeof key === "string" && key.startsWith(prefix), "Cleanup key escaped its owned prefix"); return key; };
  const failures = [];
  try {
    if (created) {
      let timer;
      try {
        const timeout = remaining();
        await Promise.race([
          docker(["rm", "--force", name], timeout),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Owned fixture container cleanup timed out")), timeout); }),
        ]);
      } catch (error) { if (!String(error).includes("No such container")) failures.push(error); }
      finally { clearTimeout(timer); }
    }
    try {
      let KeyMarker; let UploadIdMarker; const multipartMarkers = new Set();
      for (let pages = 0; ; pages++) {
        assert.ok(pages < maxPages, "Owned fixture multipart cleanup exceeded its page bound");
        const page = await send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker, UploadIdMarker, MaxUploads: 100 }));
        for (const upload of page.Uploads ?? []) {
          const Key = ownedKey(upload.Key); assert.ok(upload.UploadId, "Owned fixture multipart cleanup requires an upload ID");
          await send(new AbortMultipartUploadCommand({ Bucket: bucket, Key, UploadId: upload.UploadId }));
        }
        if (!page.IsTruncated) break;
        ownedKey(page.NextKeyMarker);
        const marker = JSON.stringify([page.NextKeyMarker, page.NextUploadIdMarker]);
        assert.ok(!multipartMarkers.has(marker), "Owned fixture multipart cleanup did not advance"); multipartMarkers.add(marker);
        KeyMarker = page.NextKeyMarker; UploadIdMarker = page.NextUploadIdMarker;
      }
      let ContinuationToken; const objectMarkers = new Set();
      for (let pages = 0; ; pages++) {
        assert.ok(pages < maxPages, "Owned fixture object cleanup exceeded its page bound");
        const page = await send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken, MaxKeys: 100 }));
        const Objects = (page.Contents ?? []).map(object => ({ Key: ownedKey(object.Key) }));
        if (Objects.length) {
          const result = await send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects, Quiet: true } }));
          assert.ok(!result.Errors?.length, "Owned fixture object cleanup was incomplete");
        }
        if (!page.IsTruncated) break;
        assert.ok(page.NextContinuationToken && !objectMarkers.has(page.NextContinuationToken), "Owned fixture object cleanup did not advance");
        objectMarkers.add(page.NextContinuationToken); ContinuationToken = page.NextContinuationToken;
      }
      const uploads = await send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix, MaxUploads: 1 }));
      assert.ok(!uploads.Uploads?.length && !uploads.IsTruncated, "Owned fixture multipart cleanup retained uploads");
      const objects = await send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 }));
      assert.ok(!objects.Contents?.length && !objects.IsTruncated, "Owned fixture object cleanup retained objects");
    } catch (error) { failures.push(error); }
  } finally { client.destroy(); }
  if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join("; "));
}

export async function main() {
const required = name => { const value = process.env[name]; assert.ok(value, `${name} is required`); return value; };
assert.equal(required("CV_TEST_S3_PROVIDER"), "localstack", "This gate uses the selected LocalStack target");
const parentPrefix = required("CV_TEST_S3_PREFIX");
assert.match(parentPrefix, /^contextvault-tests\/[A-Za-z0-9][A-Za-z0-9._-]*\/$/); assert.ok(!parentPrefix.includes(".."));
const bucket = required("CV_TEST_S3_BUCKET"); const region = required("CV_TEST_S3_REGION");
const endpoint = new URL(required("CV_TEST_S3_ENDPOINT")); const containerEndpoint = new URL(required("CV_TEST_S3_CONTAINER_ENDPOINT"));
for (const url of [endpoint, containerEndpoint]) { assert.ok(["http:", "https:"].includes(url.protocol)); assert.ok(!url.username && !url.password && !url.search && !url.hash && url.pathname === "/"); assert.ok(!/(?:^|\.)amazonaws\.com(?:\.cn)?$/.test(url.hostname)); }
const network = required("CV_TEST_DOCKER_NETWORK"); assert.match(network, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/); assert.ok(!["host", "none"].includes(network));
const id = randomUUID(); const name = `cv-no-git-${id}`; const prefix = `${parentPrefix}no-git-${id}/`;
const image = "node:20-bookworm-slim"; const master = `cv-no-git-fixture-${id}`;
const imageId = await docker("image", "inspect", "--format", "{{.Id}}", image);
const install = `set -eu
test ! -e /usr/bin/git
if command -v git >/dev/null 2>&1; then exit 1; fi
mkdir /runtime
cp /input/package.json /input/package-lock.json /runtime/
cp -R /input/dist /runtime/dist
cd /runtime
npm ci --omit=dev --engine-strict
test ! -e /usr/bin/git
if command -v git >/dev/null 2>&1; then exit 1; fi
node -e 'console.log("CV_NO_GIT_RUNTIME="+JSON.stringify({node:process.version,gitAbsent:!require("node:fs").existsSync("/usr/bin/git")}))'
exec node dist/index.js`;
let created = false; let failure; let report;
const client = new S3Client({ region, endpoint: endpoint.origin, forcePathStyle: true, ignoreConfiguredEndpointUrls: true, maxAttempts: 1, credentials: { accessKeyId: "test", secretAccessKey: "test" } });
try {
  const variables = { PORT: "3000", HOST: "0.0.0.0", CV_DATA_DIR: "/runtime/data", CONTEXTVAULT_API_KEY: master, CV_STORAGE_BACKEND: "s3", CV_S3_PROVIDER: "localstack", CV_S3_ENDPOINT: containerEndpoint.origin,
    CV_S3_BUCKET: bucket, CV_S3_REGION: region, CV_S3_PREFIX: prefix, AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", AWS_EC2_METADATA_DISABLED: "true" };
  created = true;
  await docker("run", "--detach", "--init", "--pull=never", "--name", name, "--label", "contextvault.test=no-git-server", "--network", network, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--publish", "127.0.0.1::3000",
    "--mount", `type=bind,source=${join(root, "package.json")},target=/input/package.json,readonly`, "--mount", `type=bind,source=${join(root, "package-lock.json")},target=/input/package-lock.json,readonly`,
    "--mount", `type=bind,source=${join(root, "dist")},target=/input/dist,readonly`, ...Object.entries(variables).flatMap(([key, value]) => ["--env", `${key}=${value}`]), image, "sh", "-c", install);
  const mapping = await docker("port", name, "3000/tcp"); assert.match(mapping, /^127\.0\.0\.1:[0-9]+$/); const origin = `http://${mapping}`;
  let healthy = false;
  for (let attempt = 0; attempt < 240; attempt++) {
    try { healthy = (await fetch(origin + "/health", { signal: AbortSignal.timeout(500) })).ok; } catch { /* Wait for production install and normal startup. */ }
    if (healthy) break;
    const running = await docker("inspect", "--format", "{{.State.Running}}", name).catch(() => "false");
    if (running !== "true") throw new Error(`No-Git server exited: ${(await docker("logs", name).catch(() => "Container removed")).slice(-4000)}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(healthy, "No-Git server must become healthy");
  let key = master;
  const request = async (method, path, body, status) => {
    const binary = body instanceof Uint8Array;
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(15000), headers: { "X-API-Key": key, "Idempotency-Key": randomUUID(), ...(body === undefined ? {} : { "Content-Type": binary ? "application/octet-stream" : "application/json" }), ...(binary ? { "X-Content-SHA256": createHash("sha256").update(body).digest("hex") } : {}) }, body: body === undefined ? undefined : binary ? body : JSON.stringify(body) });
    assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`);
    return response.headers.get("content-type")?.includes("application/json") ? response.json() : Buffer.from(await response.arrayBuffer());
  };
  key = (await request("POST", "/api-keys", { customerId: "no-git-tenant", name: "no-git-client" }, 201)).plainKey;
  const workspace = await request("POST", "/v1/workspaces", { customerId: "no-git-tenant", name: "S3 without Git" }, 201);
  const open = () => request("POST", `/v1/workspaces/${workspace.id}/runs`, { mode: "read-write", agentLabel: "external-http-client", task: "no-Git runtime", reason: "verify actual S3 execution dependency" }, 201);
  const run = await open(); const submission = await request("POST", `/v1/runs/${run.id}/submissions`, {}, 201); const bytes = Buffer.from([0, 255, 128, 13, 10]);
  const receipt = await request("PUT", `/v1/runs/${run.id}/submissions/${submission.id}/files?path=bytes.bin`, bytes, 201);
  await request("POST", `/v1/runs/${run.id}/submissions/${submission.id}/seal`, { manifest: { schemaVersion: 1, entries: [{ path: "bytes.bin", kind: "file", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] }, receipts: [{ path: "bytes.bin", receiptId: receipt.id }] }, 200);
  const operation = await request("POST", `/v1/runs/${run.id}/finalize`, { expectedRunVersion: run.version, submissionId: submission.id }, 202);
  let outcome;
  for (let attempt = 0; attempt < 100; attempt++) { outcome = await request("GET", `/v1/operations/${operation.id}`, undefined, 200); if (outcome.state !== "processing") break; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.equal(outcome.state, "succeeded"); const next = await open();
  assert.deepEqual(await request("GET", `/v1/runs/${next.id}/workspace/files?path=bytes.bin`, undefined, 200), bytes);
  assert.equal((await request("POST", `/v1/runs/${next.id}/abort`, { expectedRunVersion: next.version, reason: "no-Git test complete" }, 200)).state, "aborted");
  const runtime = JSON.parse(await docker("exec", name, "node", "-e", 'process.stdout.write(JSON.stringify({node:process.version,gitAbsent:!require("node:fs").existsSync("/usr/bin/git")}))'));
  assert.equal(runtime.gitAbsent, true); assert.match(runtime.node, /^v20\./);
  assert.equal(await docker("exec", name, "sh", "-c", 'if command -v git >/dev/null 2>&1; then exit 1; fi; echo absent'), "absent");
  report = { pass: true, provider: "localstack", image, imageId, ...runtime, installedProductionDependencies: true, normalEntrypoint: "dist/index.js", binaryRoundTrip: true, finalized: true, aborted: true, prefix };
} catch (error) { failure = error; }
finally {
  try { await cleanupNoGitFixture({ client, bucket, prefix, name, created }); }
  catch (error) { failure = failure ? new AggregateError([failure, error], "No-Git gate and owned fixture cleanup failed") : error; }
}
if (failure) throw failure;
console.log(JSON.stringify(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
