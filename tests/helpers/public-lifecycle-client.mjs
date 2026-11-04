import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const base = process.env.CV_URL;
const key = process.env.CV_KEY_A;
const action = process.argv[2];
let workspaceId = process.env.CV_WORKSPACE_ID;
let sequence = 0;
const initial = { "notes.txt": Buffer.from("before\r\n"), "delete.txt": Buffer.from("remove me\n"), "binary.bin": Buffer.from([0, 255, 128, 13, 10]) };
const accepted = { "notes.txt": Buffer.from("after\r\n"), "added.txt": Buffer.from("new\n"), "binary.bin": Buffer.from([0, 255, 128, 13, 10, 0, 42]) };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function request(method, route, body, expected, credentials = key, binary = false) {
  const response = await fetch(`${base}${route}`, {
    method, headers: { "X-API-Key": credentials, "Idempotency-Key": `${action}-${++sequence}`, ...(body === undefined ? {} : { "Content-Type": binary ? "application/octet-stream" : "application/json" }), ...(binary ? { "X-Content-SHA256": digest(body) } : {}) },
    body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
  });
  assert.equal(response.status, expected, `${method} ${route} must support the public lifecycle; received ${response.status}: ${await response.clone().text()}`);
  if (response.status === 204) return;
  if (response.headers.get("content-type")?.includes("application/json")) return response.json();
  return Buffer.from(await response.arrayBuffer());
}

async function open(mode = "read-write") {
  const run = await request("POST", `/v1/workspaces/${workspaceId}/runs`, { mode, agentLabel: "ordinary-local-agent", task: "acceptance", reason: "prove publication" }, 201);
  assert.equal("path" in run || "sandboxPath" in run, false, "HTTP must not claim a client-local path");
  return run;
}

async function hydrate(run, name) {
  const directory = path.join(process.cwd(), name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const manifest = await request("GET", `/v1/runs/${run.id}/workspace/manifest`, undefined, 200);
  for (const entry of manifest.entries) {
    const destination = path.join(directory, entry.path);
    await mkdir(entry.kind === "directory" ? destination : path.dirname(destination), { recursive: true });
    if (entry.kind === "file") {
      const bytes = await request("GET", `/v1/runs/${run.id}/workspace/files?path=${encodeURIComponent(entry.path)}`, undefined, 200);
      assert.equal(bytes.length, entry.byteLength);
      assert.equal(digest(bytes), entry.sha256);
      await writeFile(destination, bytes);
    }
  }
  return directory;
}

async function submit(run, directory) {
  const submission = await request("POST", `/v1/runs/${run.id}/submissions`, {}, 201);
  const entries = [];
  const receipts = [];
  for (const file of (await readdir(directory)).sort()) {
    const bytes = await readFile(path.join(directory, file));
    const receipt = await request("PUT", `/v1/runs/${run.id}/submissions/${submission.id}/files?path=${encodeURIComponent(file)}`, bytes, 201, key, true);
    entries.push({ path: file, kind: "file", byteLength: bytes.length, sha256: digest(bytes) });
    receipts.push({ path: file, receiptId: receipt.id });
  }
  await request("POST", `/v1/runs/${run.id}/submissions/${submission.id}/seal`, { manifest: { schemaVersion: 1, entries }, receipts }, 200);
  const operation = await request("POST", `/v1/runs/${run.id}/finalize`, { submissionId: submission.id, expectedRunVersion: run.version }, 202);
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await request("GET", `/v1/operations/${operation.id}`, undefined, 200);
    if (status.state === "succeeded") {
      assert.equal(status.result.runState, "finalized");
      assert.ok(status.result.revisionId);
      return;
    }
    assert.notEqual(status.state, "failed", JSON.stringify(status));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Finalization did not reach a durable outcome");
}

async function assertContents(directory, files) {
  assert.deepEqual((await readdir(directory)).sort(), Object.keys(files).sort());
  for (const [file, bytes] of Object.entries(files)) assert.deepEqual(await readFile(path.join(directory, file)), bytes);
}

async function writeContents(directory, files) {
  for (const [file, bytes] of Object.entries(files)) await writeFile(path.join(directory, file), bytes);
}

if (action === "publish") {
  const workspace = await request("POST", "/v1/workspaces", { customerId: "acceptance-customer-a", name: "HTTP lifecycle" }, 201);
  workspaceId = workspace.id;
  assert.ok(workspace.currentRevisionId, "New workspaces need an accepted empty revision");
  const first = await open();
  const directory = await hydrate(first, "agent-files");
  await writeContents(directory, initial);
  await submit(first, directory);
  const second = await open();
  const secondDirectory = await hydrate(second, "agent-files-next");
  await assertContents(secondDirectory, initial);
  await writeContents(secondDirectory, accepted);
  await rm(path.join(secondDirectory, "delete.txt"));
  await submit(second, secondDirectory);
} else if (action === "reopen-and-abort" || action === "verify") {
  const run = await open();
  const directory = await hydrate(run, "reopened-files");
  await assertContents(directory, accepted);
  await request("GET", `/v1/runs/${run.id}/workspace/manifest`, undefined, 404, process.env.CV_KEY_B);
  if (action === "reopen-and-abort") await writeFile(path.join(directory, "notes.txt"), "aborted change");
  const aborted = await request("POST", `/v1/runs/${run.id}/abort`, { expectedRunVersion: run.version, reason: "acceptance cleanup" }, 200);
  assert.equal(aborted.state, "aborted");
  await rm(directory, { recursive: true, force: true });
} else {
  throw new Error(`Unknown client action: ${action}`);
}
process.stdout.write(JSON.stringify({ workspaceId }));
