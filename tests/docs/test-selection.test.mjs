import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function fixture(run) {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), "cv-test-selection-"));
  try {
    await mkdir(path.join(directory, "tests/unit"), { recursive: true });
    await mkdir(path.join(directory, "tests/sdk/typescript"), { recursive: true });
    for (const suite of ["hosts", "mcp", "migrations"]) await mkdir(path.join(directory, "tests", suite), { recursive: true });
    await writeFile(path.join(directory, "tests/unit/default.test.ts"), 'it("default-canary", () => expect(true).toBe(true));\n');
    await writeFile(path.join(directory, "tests/sdk/typescript/installed.test.ts"), 'it("sdk-canary", () => { throw new Error("EXPLICIT_SDK_SENTINEL"); });\n');
    await writeFile(path.join(directory, "tests/hosts/installed.test.ts"), 'it("hosts-canary", () => { throw new Error("EXPLICIT_HOST_SENTINEL"); });\n');
    for (const suite of ["mcp", "migrations"]) await writeFile(path.join(directory, "tests", suite, "installed.test.ts"), `it("${suite}-canary", () => { throw new Error("EXPLICIT_${suite.toUpperCase()}_SENTINEL"); });\n`);
    await run(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function vitest(directory, suite, filters = []) {
  const env = { HOME: directory };
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR", "PATHEXT"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  if (suite) Object.assign(env, { CV_TEST_SUITE: suite, CV_TEST_LANGUAGE: "typescript" });
  const args = [path.join(root, "node_modules/vitest/vitest.mjs"), "run", ...filters, "--root", directory, "--config", path.join(root, "vitest.config.ts"), "--maxWorkers", "1"];
  try {
    const result = await execute(process.execPath, args, { cwd: directory, env, timeout: 15000, killSignal: "SIGKILL", maxBuffer: 256 * 1024 });
    return { code: 0, output: stripVTControlCharacters(result.stdout + result.stderr) };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, output: stripVTControlCharacters(error.stdout + error.stderr) };
  }
}

test("default root tests exclude explicit installed-client and migration gates", () => fixture(async directory => {
  const result = await vitest(directory);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Tests\s+1 passed/);
  assert.doesNotMatch(result.output, /EXPLICIT_(SDK|HOST|MCP|MIGRATIONS)_SENTINEL/);
}));

test("explicit SDK selection runs its tests and propagates their failure", () => fixture(async directory => {
  const result = await vitest(directory, "sdk", ["tests/sdk/typescript"]);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /EXPLICIT_SDK_SENTINEL/);
  assert.match(result.output, /Tests\s+1 failed/);
  assert.doesNotMatch(result.output, /No test files found/);
}));

test("explicit SDK selection cannot succeed with no matching tests", () => fixture(async directory => {
  await rm(path.join(directory, "tests/sdk/typescript/installed.test.ts"));
  const result = await vitest(directory, "sdk", ["tests/sdk/typescript"]);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /No test files found/);
}));

test("explicit host selection runs its tests and propagates their failure", () => fixture(async directory => {
  const result = await vitest(directory, "hosts", ["tests/hosts"]);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /EXPLICIT_HOST_SENTINEL/);
  assert.match(result.output, /Tests\s+1 failed/);
  assert.doesNotMatch(result.output, /No test files found/);
}));

test("explicit host selection cannot succeed with no matching tests", () => fixture(async directory => {
  await rm(path.join(directory, "tests/hosts/installed.test.ts"));
  const result = await vitest(directory, "hosts", ["tests/hosts"]);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /No test files found/);
}));

for (const [suite, directoryName] of [["mcp", "mcp"], ["migration", "migrations"]]) {
  test(`explicit ${suite} selection propagates its failure`, () => fixture(async directory => {
    const result = await vitest(directory, suite, [`tests/${directoryName}`]);
    assert.equal(result.code, 1, result.output);
    assert.ok(result.output.includes(`EXPLICIT_${directoryName.toUpperCase()}_SENTINEL`), result.output);
    assert.match(result.output, /Tests\s+1 failed/);
    assert.doesNotMatch(result.output, /No test files found/);
  }));
  test(`explicit ${suite} selection rejects an empty gate`, () => fixture(async directory => {
    await rm(path.join(directory, "tests", directoryName, "installed.test.ts"));
    const result = await vitest(directory, suite, [`tests/${directoryName}`]);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /No test files found/);
  }));
}
