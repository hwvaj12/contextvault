import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPostman } from "../../scripts/verify-workspace-docs.mjs";

const collection = {
  info: { name: "report acceptance", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  item: [{ name: "health", request: { method: "GET", url: "{{baseUrl}}/health" }, event: [{ listen: "test", script: { exec: ["pm.test('healthy', () => pm.response.to.have.status(200));"] } }] }],
};
function report() {
  return { run: { stats: { requests: { total: 1, failed: 0 }, assertions: { total: 1, failed: 0, pending: 0 } }, failures: [], executions: [{ item: { name: "health" }, response: { code: 200 }, assertions: [{ assertion: "healthy", skipped: false }] }] } };
}
async function fixture(check) {
  const root = await mkdtemp(path.join(tmpdir(), "cv-postman-report-"));
  try {
    await writeFile(path.join(root, "collection.json"), JSON.stringify(collection));
    await check(root, { file: "collection.json", variables: { baseUrl: "http://127.0.0.1:32345" } });
  } finally { await rm(root, { recursive: true, force: true }); }
}
function runtime(value) {
  return { resolveRuntime: () => "postman", run: async (_command, args) => {
    const index = args.indexOf("--reporter-json-export");
    if (index !== -1 && value !== undefined) await writeFile(args[index + 1], typeof value === "string" ? value : JSON.stringify(value));
  } };
}

test("requires the actual JSON report even after a successful runtime exit", () => fixture(async (root, spec) => {
  await assert.rejects(runPostman(root, spec, runtime(undefined)), /report.*missing|missing.*report/i);
}));
test("returns observed request and assertion counts from a successful report", () => fixture(async (root, spec) => {
  const observed = await runPostman(root, spec, runtime(report()));
  assert.equal(observed.requests, 1);
  assert.equal(observed.assertions, 1);
  assert.equal(observed.skipped, 0);
}));
test("rejects skipped assertions even when the runtime exits successfully", () => fixture(async (root, spec) => {
  const value = report(); value.run.executions[0].assertions[0].skipped = true;
  await assert.rejects(runPostman(root, spec, runtime(value)), /skipped/i);
}));
test("rejects zero assertion coverage", () => fixture(async (root, spec) => {
  const value = report(); value.run.stats.assertions.total = 0; value.run.executions[0].assertions = [];
  await assert.rejects(runPostman(root, spec, runtime(value)), /assertion.*coverage|no assertions/i);
}));
test("rejects zero request coverage", () => fixture(async (root, spec) => {
  const value = report(); value.run.stats.requests.total = 0; value.run.executions = [];
  await assert.rejects(runPostman(root, spec, runtime(value)), /request.*coverage|no requests/i);
}));
test("rejects recorded assertion failures even when the runtime exits successfully", () => fixture(async (root, spec) => {
  const value = report(); value.run.failures = [{ error: { name: "AssertionError" } }];
  await assert.rejects(runPostman(root, spec, runtime(value)), /failure/i);
}));
test("rejects malformed reporter output", () => fixture(async (root, spec) => {
  await assert.rejects(runPostman(root, spec, runtime("not-json")), /report.*invalid|invalid.*report/i);
}));
