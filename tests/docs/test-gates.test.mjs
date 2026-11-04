import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function launcher() {
  const module = await import("../../scripts/run-workspace-tests.mjs");
  assert.equal(typeof module.planTestRun, "function", "The named test gates need an explicit launcher");
  return module;
}
async function fixture(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "cv-gates-self-test-"));
  try { await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("requires supported explicit backend and language arguments", async () => {
  const { planTestRun } = await launcher();
  await assert.rejects(planTestRun("adapters", []), /--backend git or s3 is required/);
  await assert.rejects(planTestRun("sdk", ["--language", "rust"]), /--language typescript, python, or php is required/);
  await assert.rejects(planTestRun("contracts", ["--unknown"]), /Unknown argument/);
  await assert.rejects(planTestRun("adapters", ["--backend", "git", "--require-real-s3"]), /requires --backend s3/);
});

test("fails missing suites instead of falling back to the baseline", async () => {
  const { planTestRun } = await launcher();
  await fixture(async (root) => {
    await assert.rejects(planTestRun("adapters", ["--backend", "git"], { root, env: {} }), /Required test suite is missing: tests\/adapters\/git/);
    await assert.rejects(planTestRun("release", ["--require-real-s3", "--require-all-hosts", "--require-all-sdks"], { root, env: {} }), /Required release runner is missing/);
  });
});

test("requires nonproduction S3 configuration without assuming static credentials", async () => {
  const { planTestRun } = await launcher();
  await fixture(async (root) => {
    await mkdir(path.join(root, "tests/adapters/s3"), { recursive: true });
    await writeFile(path.join(root, "tests/adapters/s3/contract.test.ts"), "");
    await assert.rejects(planTestRun("adapters", ["--backend", "s3", "--require-real-s3"], { root, env: {} }), /CV_TEST_S3_BUCKET/);
    await assert.rejects(planTestRun("adapters", ["--backend", "s3"], { root, env: { CV_TEST_S3_BUCKET: "fixture", CV_TEST_S3_REGION: "fixture", CV_TEST_S3_PREFIX: "production/" } }), /contextvault-tests/);
    const plan = await planTestRun("adapters", ["--backend", "s3", "--require-real-s3"], { root, env: { CV_TEST_S3_BUCKET: "fixture", CV_TEST_S3_REGION: "fixture", CV_TEST_S3_PREFIX: "contextvault-tests/fixture-run/" } });
    assert.equal(plan.env.CV_TEST_BACKEND, "s3");
    assert.equal(plan.env.CV_REQUIRE_REAL_S3, "1");
    assert.deepEqual(plan.args.slice(-1), ["tests/adapters/s3"]);
  });
});

test("targets acceptance explicitly while leaving its missing product behavior visible", async () => {
  const { planTestRun } = await launcher();
  await fixture(async (root) => {
    await mkdir(path.join(root, "tests/acceptance"), { recursive: true });
    await writeFile(path.join(root, "tests/acceptance/lifecycle.test.ts"), "");
    const plan = await planTestRun("acceptance", ["--backend", "git"], { root, env: {} });
    assert.equal(plan.env.CV_TEST_SUITE, "acceptance");
    assert.equal(plan.env.CV_TEST_BACKEND, "git");
    assert.deepEqual(plan.args.slice(-1), ["tests/acceptance"]);
  });
});
