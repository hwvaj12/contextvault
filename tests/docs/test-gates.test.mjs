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
    await assert.rejects(planTestRun("adapters", ["--backend", "s3", "--s3-provider", "aws"], { root, env: { CV_TEST_S3_BUCKET: "fixture", CV_TEST_S3_REGION: "fixture", CV_TEST_S3_PREFIX: "production/" } }), /contextvault-tests/);
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

test("requires explicit provider, isolates LocalStack credentials, and keeps real S3 strict", async () => {
  const { planTestRun } = await launcher();
  await fixture(async (root) => {
    await mkdir(path.join(root, 'tests/adapters/s3'), { recursive: true });
    await writeFile(path.join(root, 'tests/adapters/s3/contract.test.ts'), '');
    const env = { CV_TEST_S3_BUCKET: 'fixture', CV_TEST_S3_REGION: 'us-east-1', CV_TEST_S3_PREFIX: 'contextvault-tests/fixture-run/', CV_TEST_S3_ENDPOINT: 'http://127.0.0.1:51744', AWS_ACCESS_KEY_ID: 'inherited-secret', AWS_SECRET_ACCESS_KEY: 'inherited-secret', AWS_PROFILE: 'real' };
    await assert.rejects(planTestRun('adapters', ['--backend', 's3'], { root, env }), /--s3-provider localstack or aws is required/);
    const plan = await planTestRun('adapters', ['--backend', 's3', '--s3-provider', 'localstack'], { root, env });
    assert.equal(plan.env.CV_TEST_S3_PROVIDER, 'localstack');
    assert.equal(plan.env.AWS_ACCESS_KEY_ID, 'test');
    assert.equal(plan.env.AWS_SECRET_ACCESS_KEY, 'test');
    assert.equal(plan.env.AWS_PROFILE, undefined);
    await assert.rejects(planTestRun('adapters', ['--backend', 's3', '--s3-provider', 'localstack', '--require-real-s3'], { root, env }), /requires AWS/);
    await assert.rejects(planTestRun('adapters', ['--backend', 's3', '--s3-provider', 'aws', '--require-real-s3'], { root, env }), /AWS service endpoint/);
    await assert.rejects(planTestRun('adapters', ['--backend', 'git', '--s3-provider', 'localstack'], { root, env }), /requires --backend s3/);
    await assert.rejects(planTestRun('adapters', ['--backend', 's3', '--s3-provider', 'localstack'], { root, env: { ...env, CV_TEST_S3_PROVIDER: 'aws' } }), /conflicts/);
    await assert.rejects(planTestRun('adapters', ['--backend', 's3', '--s3-provider', 'localstack'], { root, env: { ...env, CV_TEST_S3_ENDPOINT: '' } }), /CV_TEST_S3_ENDPOINT/);
  });
});

test('rejects ambient local endpoint overrides and strict-gate conflicts', async () => {
  const { planTestRun } = await launcher();
  await fixture(async root => {
    await mkdir(path.join(root, 'tests/adapters/s3'), { recursive: true });
    await writeFile(path.join(root, 'tests/adapters/s3/contract.test.ts'), '');
    const env = { CV_TEST_S3_BUCKET: 'fixture', CV_TEST_S3_REGION: 'us-east-1', CV_TEST_S3_PREFIX: 'contextvault-tests/fixture-run/' };
    for (const variable of ['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_S3']) {
      await assert.rejects(planTestRun('adapters', ['--backend', 's3', '--require-real-s3'], { root, env: { ...env, [variable]: 'http://localhost:4566' } }), /AWS service endpoint/);
    }
    await assert.rejects(planTestRun('adapters', ['--backend', 's3', '--s3-provider', 'localstack'], { root, env: { ...env, CV_TEST_S3_ENDPOINT: 'http://localhost:4566', CV_REQUIRE_REAL_S3: '1' } }), /requires AWS/);
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await writeFile(path.join(root, 'scripts/verify-workspace-release.mjs'), '');
    const release = await planTestRun('release', ['--s3-provider', 'localstack'], { root, env: { ...env, CV_TEST_S3_ENDPOINT: 'http://localhost:4566' } });
    assert.equal(release.env.CV_TEST_S3_PROVIDER, 'localstack');
    await assert.rejects(planTestRun('release', ['--s3-provider', 'localstack', '--require-real-s3'], { root, env }), /requires AWS/);
  });
});

test('exports the same strict S3 validator for shared server fixtures', async () => {
  const { requireS3 } = await launcher();
  assert.equal(typeof requireS3, 'function');
  const source = { CV_TEST_S3_BUCKET: 'fixture', CV_TEST_S3_REGION: 'us-east-1', CV_TEST_S3_PREFIX: 'contextvault-tests/fixture-export/', CV_TEST_S3_ENDPOINT: 'http://127.0.0.1:51744', AWS_PROFILE: 'unrelated', AWS_WEB_IDENTITY_TOKEN_FILE: '/not-read', AWS_ACCESS_KEY_ID: 'fixture-inherited' };
  const env = { ...source };
  requireS3(env, { s3Provider: 'localstack' });
  assert.equal(env.AWS_PROFILE, undefined);
  assert.equal(env.AWS_WEB_IDENTITY_TOKEN_FILE, undefined);
  assert.equal(env.AWS_ACCESS_KEY_ID, 'test');
  assert.equal(env.AWS_SECRET_ACCESS_KEY, 'test');
  assert.equal(source.AWS_PROFILE, 'unrelated');
  assert.throws(() => requireS3({ ...source, CV_TEST_S3_PREFIX: 'production/' }, { s3Provider: 'localstack' }), /contextvault-tests/);
  assert.throws(() => requireS3({ ...source }, { s3Provider: 'aws', realS3: true }), /AWS service endpoint/);
  assert.throws(() => requireS3({ ...source }, { s3Provider: 'localstack', realS3: true }), /requires AWS/);
});

test('rejects unknown providers before mutating shared fixture credentials', async () => {
  const { requireS3 } = await launcher();
  for (const provider of ['localstak', 'AWS', 'unknown']) {
    const env = { CV_TEST_S3_PROVIDER: provider, CV_TEST_S3_BUCKET: 'fixture', CV_TEST_S3_REGION: 'us-east-1', CV_TEST_S3_PREFIX: 'contextvault-tests/provider-guard/', CV_TEST_S3_ENDPOINT: 'http://127.0.0.1:1', AWS_PROFILE: 'fixture-only-profile', AWS_ACCESS_KEY_ID: 'fixture-only-key' };
    const before = { ...env };
    assert.throws(() => requireS3(env, { s3Provider: provider }), /--s3-provider localstack or aws is required/);
    assert.deepEqual(env, before);
    assert.throws(() => requireS3({ ...env }, { s3Provider: provider, realS3: true }), /--s3-provider localstack or aws is required/);
  }
});
