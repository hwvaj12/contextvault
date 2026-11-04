#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendSuites = new Set(["adapters", "acceptance", "hosts"]);
const suites = new Set(["contracts", "adapters", "acceptance", "hosts", "sdk", "mcp", "legacy", "recovery", "migration", "e2e", "release"]);

async function exists(file) { try { return (await stat(file)).isFile(); } catch { return false; } }
async function hasTests(directory, suffix) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(suffix)) return true;
    if (entry.isDirectory() && await hasTests(path.join(directory, entry.name), suffix)) return true;
  }
  return false;
}

function optionsFor(suite, args) {
  if (!suites.has(suite)) throw new Error(`Unknown test suite: ${suite}`);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--backend" && backendSuites.has(suite)) options.backend = args[++index];
    else if (argument === "--language" && suite === "sdk") options.language = args[++index];
    else if (argument === "--require-real-s3" && (backendSuites.has(suite) || suite === "release")) options.realS3 = true;
    else if (argument === "--require-all-hosts" && suite === "release") options.allHosts = true;
    else if (argument === "--require-all-sdks" && suite === "release") options.allSdks = true;
    else throw new Error(`Unknown argument for ${suite}: ${argument}`);
  }
  if (backendSuites.has(suite) && !["git", "s3"].includes(options.backend)) throw new Error("--backend git or s3 is required");
  if (suite === "sdk" && !["typescript", "python", "php"].includes(options.language)) throw new Error("--language typescript, python, or php is required");
  if (options.realS3 && suite !== "release" && options.backend !== "s3") throw new Error("--require-real-s3 requires --backend s3");
  return options;
}
function requireS3(env) {
  for (const name of ["CV_TEST_S3_BUCKET", "CV_TEST_S3_REGION", "CV_TEST_S3_PREFIX"]) if (!env[name]?.trim()) throw new Error(`Real S3 verification requires ${name}`);
  const prefix = env.CV_TEST_S3_PREFIX;
  if (!/^contextvault-tests\/[A-Za-z0-9][A-Za-z0-9._-]*\/$/.test(prefix) || prefix.includes("..")) throw new Error("CV_TEST_S3_PREFIX must be a unique nonproduction contextvault-tests/<run-id>/ prefix");
}

/** Build one explicit gate. An absent suite can never run unrelated baseline tests. */
export async function planTestRun(suite, args, { root = projectRoot, env = process.env } = {}) {
  const options = optionsFor(suite, args);
  const childEnv = { ...env, CV_TEST_SUITE: suite };
  if (options.backend) childEnv.CV_TEST_BACKEND = options.backend;
  if (options.language) childEnv.CV_TEST_LANGUAGE = options.language;
  if (options.realS3) childEnv.CV_REQUIRE_REAL_S3 = "1";
  if (options.allHosts) childEnv.CV_REQUIRE_ALL_HOSTS = "1";
  if (options.allSdks) childEnv.CV_REQUIRE_ALL_SDKS = "1";
  if (suite === "release") {
    const runner = path.join(root, "scripts/verify-workspace-release.mjs");
    if (!await exists(runner)) throw new Error("Required release runner is missing: scripts/verify-workspace-release.mjs (CV-27)");
    return { command: process.execPath, args: [runner, ...args], env: childEnv, cwd: root };
  }
  let directory = `tests/${{ legacy: "compat", migration: "migrations" }[suite] ?? suite}`;
  if (suite === "adapters") directory += `/${options.backend}`;
  if (suite === "sdk") directory += `/${options.language}`;
  const suffix = suite === "sdk" && options.language === "python" ? ".py" : suite === "sdk" && options.language === "php" ? "Test.php" : suite === "e2e" ? ".test.mjs" : ".test.ts";
  if (!await hasTests(path.join(root, directory), suffix)) throw new Error(`Required test suite is missing: ${directory}`);
  if (options.backend === "s3") requireS3(childEnv);
  if (suite === "e2e") {
    if (!env.CV_TEST_API_URL || !env.CV_TEST_API_KEY) throw new Error("Legacy HTTP tests require explicit CV_TEST_API_URL and CV_TEST_API_KEY");
    const origin = new URL(env.CV_TEST_API_URL);
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) && origin.origin !== env.CV_TEST_NONPRODUCTION_ORIGIN)) throw new Error("Legacy HTTP tests require an explicit nonproduction origin");
    childEnv.API_BASE_URL = origin.href.replace(/\/$/, "");
    childEnv.API_KEY = env.CV_TEST_API_KEY;
    const files = (await readdir(path.join(root, directory))).filter((file) => file.endsWith(suffix)).sort();
    return { commands: files.map((file) => ({ command: process.execPath, args: [path.join(root, directory, file)] })), env: childEnv, cwd: root };
  }
  if (suite === "sdk" && options.language === "python") return { command: "python3", args: ["-m", "pytest", directory], env: childEnv, cwd: root };
  if (suite === "sdk" && options.language === "php") {
    const runner = path.join(root, "sdk/php/vendor/bin/phpunit");
    if (!await exists(runner)) throw new Error("Installed PHP test runner is missing: sdk/php/vendor/bin/phpunit");
    return { command: runner, args: [directory], env: childEnv, cwd: root };
  }
  return { command: process.execPath, args: [path.join(root, "node_modules/vitest/vitest.mjs"), "run", directory], env: childEnv, cwd: root };
}

async function run(command, args, plan) {
  const child = spawn(command, args, { cwd: plan.cwd, env: plan.env, shell: false, stdio: "inherit" });
  const stop = (signal) => child.kill(signal);
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0))); });
    if (result !== 0) process.exitCode = result;
    return result;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
async function main() {
  const [suite, ...args] = process.argv.slice(2);
  const plan = await planTestRun(suite, args);
  for (const command of plan.commands ?? [plan]) if (await run(command.command, command.args, plan) !== 0) break;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
