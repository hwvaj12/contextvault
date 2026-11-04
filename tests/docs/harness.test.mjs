import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const runner = new URL("../../scripts/verify-workspace-docs.mjs", import.meta.url);
async function fixture(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "cv-docs-self-test-"));
  try { await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function harness() { return import(runner.href); }
const runtime = (run) => ({ run, resolveRuntime: () => "/fixture/newman.js" });

test("reports missing configuration instead of passing an empty documentation gate", async () => {
  const { verifyDocumentation } = await harness();
  assert.equal(typeof verifyDocumentation, "function", "The documentation harness must export verifyDocumentation");
  await fixture(async (root) => {
    await assert.rejects(verifyDocumentation({ root }), /Documentation configuration is missing/);
  });
});

test("checks local inline links, reference links, and anchor targets", async () => {
  const { checkMarkdownLinks } = await harness();
  assert.equal(typeof checkMarkdownLinks, "function", "The documentation harness must export checkMarkdownLinks");
  await fixture(async (root) => {
    await writeFile(path.join(root, "README.md"), "[guide](guide.md#supported)\n[reference][guide]\n[guide]: guide.md#supported\n");
    await writeFile(path.join(root, "guide.md"), "# Supported\n");
    assert.equal(await checkMarkdownLinks(root, ["README.md"]), 2);
    await writeFile(path.join(root, "guide.md"), "# Changed\n");
    await assert.rejects(checkMarkdownLinks(root, ["README.md"]), /Missing anchor/);
    await rm(path.join(root, "guide.md"));
    await assert.rejects(checkMarkdownLinks(root, ["README.md"]), /Missing local link/);
  });
});

test("executes the selected quickstart block and propagates its failure", async () => {
  const { runQuickstart } = await harness();
  assert.equal(typeof runQuickstart, "function", "The documentation harness must export runQuickstart");
  await fixture(async (root) => {
    await writeFile(path.join(root, "quickstart.md"), "```sh cv-check:demo\nnode -e 'process.exit(0)'\n```\n");
    await runQuickstart(root, { file: "quickstart.md", block: "demo", command: [process.execPath, "-e", "process.exit(0)"], display: "node -e 'process.exit(0)'" });
    await writeFile(path.join(root, "quickstart.md"), "```sh cv-check:demo\nnode -e 'process.exit(7)'\n```\n");
    await assert.rejects(runQuickstart(root, { file: "quickstart.md", block: "demo", command: [process.execPath, "-e", "process.exit(7)"], display: "node -e 'process.exit(7)'" }), /Quickstart demo failed/);
    await assert.rejects(runQuickstart(root, { file: "quickstart.md", block: "absent" }), /Missing quickstart block/);
  });
});

test("requires executable Postman assertions and propagates collection runner failures", async () => {
  const { runPostman } = await harness();
  assert.equal(typeof runPostman, "function", "The documentation harness must export runPostman");
  await fixture(async (root) => {
    const collection = { info: { name: "fixture", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" }, item: [{ name: "health", request: { method: "GET", url: "{{baseUrl}}/health" }, event: [{ listen: "test", script: { exec: ["pm.test('healthy', () => pm.response.to.have.status(200));"] } }] }] };
    await writeFile(path.join(root, "collection.json"), JSON.stringify(collection));
    let invocation;
    const execute = async (command, args) => { invocation = { command, args }; };
    await runPostman(root, { file: "collection.json", variables: { baseUrl: "http://127.0.0.1:32345" } }, runtime(execute));
    assert.equal(invocation.args.includes("--bail"), true);
    assert.equal(invocation.args.includes(path.join(root, "collection.json")), true);
    await assert.rejects(runPostman(root, { file: "collection.json", variables: { baseUrl: "http://127.0.0.1:32345" } }, runtime(async () => { throw new Error("fixture assertion failed"); })), /fixture assertion failed/);
    collection.item[0].event = [];
    await writeFile(path.join(root, "collection.json"), JSON.stringify(collection));
    await assert.rejects(runPostman(root, { file: "collection.json", variables: { baseUrl: "http://127.0.0.1:32345" } }, runtime(execute)), /Postman request lacks test assertions/);
  });
});

test("requires all documentation check families and explicit environment inputs", async () => {
  const { verifyDocumentation } = await harness();
  assert.equal(typeof verifyDocumentation, "function", "The documentation harness must export verifyDocumentation");
  await fixture(async (root) => {
    await mkdir(path.join(root, "tests/docs"), { recursive: true });
    await writeFile(path.join(root, "tests/docs/workspace-docs.json"), JSON.stringify({ markdown: [], quickstarts: [], postman: [] }));
    await assert.rejects(verifyDocumentation({ root }), /markdown must contain at least one check/);
    await writeFile(path.join(root, "tests/docs/workspace-docs.json"), JSON.stringify({ requiredEnvironment: ["CV_DOCS_ABSENT_FIXTURE"], markdown: ["README.md"], quickstarts: [{}], postman: [{}] }));
    await assert.rejects(verifyDocumentation({ root }), /Required documentation environment is missing: CV_DOCS_ABSENT_FIXTURE/);
  });
});

test("permits response-populated path variables while rejecting unresolved or different origins", async () => {
  const { runPostman } = await harness();
  await fixture(async (root) => {
    const collection = { info: { name: "dynamic fixture", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" }, item: [{ name: "run", request: { method: "GET", url: "{{baseUrl}}/v1/workspaces/{{workspaceId}}?run={{runId}}" }, event: [{ listen: "test", script: { exec: ["pm.test('status', () => pm.response.to.have.status(200));"] } }] }] };
    await writeFile(path.join(root, "collection.json"), JSON.stringify(collection));
    const spec = { file: "collection.json", variables: { baseUrl: "http://127.0.0.1:32345" } };
    await runPostman(root, spec, runtime(async () => {}));
    collection.item[0].request.url = "http://{{unresolvedHost}}/v1/workspaces";
    await writeFile(path.join(root, "collection.json"), JSON.stringify(collection));
    await assert.rejects(runPostman(root, spec, runtime(async () => {})), /origin|Invalid URL/);
    collection.item[0].request.url = "https://production.example.invalid/health";
    await writeFile(path.join(root, "collection.json"), JSON.stringify(collection));
    await assert.rejects(runPostman(root, spec, runtime(async () => {})), /nonproduction origin/);
  });
});

test("fails when the safe Postman runtime is unavailable", async () => {
  const { runPostman } = await harness();
  await fixture(async (root) => {
    const collection = { info: { name: "runtime fixture", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" }, item: [{ name: "health", request: { method: "GET", url: "{{baseUrl}}/health" }, event: [{ listen: "test", script: { exec: ["pm.test('status', () => pm.response.to.have.status(200));"] } }] }] };
    await writeFile(path.join(root, "collection.json"), JSON.stringify(collection));
    await assert.rejects(runPostman(root, { file: "collection.json", variables: { baseUrl: "http://127.0.0.1:32345" } }, { run: async () => {}, resolveRuntime: () => { throw new Error("fixture unavailable"); } }), /Postman runtime is unavailable/);
  });
});
