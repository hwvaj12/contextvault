#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, stat, lstat, realpath, mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireS3 } from "./run-workspace-tests.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientVariables = ["CV_API_URL", "CV_API_KEY", "CV_CUSTOMER_ID"];
export function documentationEnvironment(extra = {}) {
  const result = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR", "PATHEXT"]) if (process.env[name] !== undefined) result[name] = process.env[name];
  for (const name of [...clientVariables, "HOME", "PATH", "CV_DOCS_WORK_DIR"]) if (extra[name] !== undefined) result[name] = extra[name];
  return result;
}

function inside(root, relative) {
  if (typeof relative !== "string" || !relative) throw new Error("A documentation path is required");
  const absolute = path.resolve(root, relative);
  const difference = path.relative(root, absolute);
  if (difference.startsWith(".." + path.sep) || difference === ".." || path.isAbsolute(difference)) throw new Error("Documentation path escapes the project");
  return absolute;
}
function withoutFences(markdown) { return markdown.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, ""); }
function withoutCodeSpans(markdown) {
  const runs = [...markdown.matchAll(/`+/g)];
  let result = ""; let cursor = 0;
  for (let index = 0; index < runs.length; index++) {
    const opening = runs[index]; let slashes = 0;
    for (let offset = opening.index - 1; offset >= 0 && markdown[offset] === "\\"; offset--) slashes++;
    if (slashes % 2) continue;
    let closing = index + 1;
    while (closing < runs.length && runs[closing][0].length !== opening[0].length) closing++;
    if (closing === runs.length || /[\r\n]/.test(markdown.slice(opening.index, runs[closing].index))) continue;
    const end = runs[closing].index + runs[closing][0].length;
    result += markdown.slice(cursor, opening.index) + markdown.slice(opening.index, end).replace(/[^\n]/g, " ");
    cursor = end; index = closing;
  }
  return result + markdown.slice(cursor);
}
function anchors(markdown) {
  const result = new Set();
  const duplicates = new Map();
  for (const match of withoutFences(markdown).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const slug = match[1].toLowerCase().replace(/<[^>]*>/g, "").replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-");
    const count = duplicates.get(slug) ?? 0;
    duplicates.set(slug, count + 1);
    result.add(count ? `${slug}-${count}` : slug);
  }
  for (const match of markdown.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) result.add(match[1]);
  return result;
}

/** Check local Markdown targets without making network requests. */
export async function checkMarkdownLinks(root, files) {
  let count = 0;
  for (const file of files) {
    const source = inside(root, file);
    const markdown = withoutCodeSpans(withoutFences(await readFile(source, "utf8")));
    const definitions = new Map([...markdown.matchAll(/^\s*\[([^\]]+)\]:\s*<?([^\s>]+)>?/gm)].map((match) => [match[1].toLowerCase(), match[2]]));
    const targets = [...markdown.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*["'])?\s*\)/g)].map((match) => match[1].replace(/^<|>$/g, ""));
    for (const match of markdown.matchAll(/!?\[([^\]]+)\]\[([^\]]*)\]/g)) {
      const target = definitions.get((match[2] || match[1]).toLowerCase());
      if (!target) throw new Error(`Missing Markdown reference in ${file}`);
      targets.push(target);
    }
    for (const target of targets) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
      const [pathname, fragment] = target.split("#", 2);
      const destination = inside(root, path.relative(root, pathname ? path.resolve(path.dirname(source), decodeURIComponent(pathname.split("?")[0])) : source));
      try { await stat(destination); } catch { throw new Error(`Missing local link in ${file}: ${target}`); }
      if (fragment && /\.md$/i.test(destination)) {
        if (!anchors(await readFile(destination, "utf8")).has(decodeURIComponent(fragment))) throw new Error(`Missing anchor in ${file}: ${target}`);
      }
      count++;
    }
  }
  return count;
}

function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false, stdio: "ignore" });
    const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeout ?? 30000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Command failed (${signal ?? `exit ${code}`})`));
    });
  });
}

/** Execute only an explicitly allowlisted argv, after matching its documented text. */
export async function runQuickstart(root, spec, { run = execute, prepare, environment = {} } = {}) {
  const markdown = await readFile(inside(root, spec.file), "utf8");
  const blocks = [...markdown.matchAll(/^```[^\n]*\bcv-check:([^\s]+)[^\n]*\n([\s\S]*?)^```\s*$/gm)].filter((match) => match[1] === spec.block);
  if (blocks.length !== 1) throw new Error(`Missing quickstart block or duplicate block: ${spec.block}`);
  if (!Array.isArray(spec.command) || !spec.command.length || spec.command.some((part) => typeof part !== "string" || !part)) throw new Error(`Quickstart ${spec.block} requires an explicit command argv`);
  if (typeof spec.display !== "string" || blocks[0][2].trim() !== spec.display.trim()) throw new Error(`Quickstart ${spec.block} differs from its allowed command`);
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), "cv-docs-quickstart-"));
  try {
    const prepared = await prepare?.(directory, spec);
    const command = spec.command.map((part) => part.replaceAll("${PROJECT_ROOT}", root).replaceAll("${WORK_DIR}", directory));
    await run(command[0], command.slice(1), { cwd: directory, env: documentationEnvironment({ ...environment, ...prepared?.environment, HOME: directory, CV_DOCS_WORK_DIR: directory }), timeout: 30000 });
  } catch (error) { throw new Error(`Quickstart ${spec.block} failed`, { cause: error }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function requests(items, inheritedTests = false) {
  const result = [];
  for (const item of items ?? []) {
    const hasTests = inheritedTests || item.event?.some((event) => event.listen === "test" && /\bpm\.test\s*\(/.test((event.script?.exec ?? []).join("\n")));
    if (item.item) result.push(...requests(item.item, hasTests));
    if (item.request) result.push({ item, hasTests });
  }
  return result;
}
function nonproductionUrl(url, allowedOrigin) {
  const parsed = new URL(url);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || (!loopback && parsed.origin !== allowedOrigin)) throw new Error("Postman URL must use an explicit nonproduction origin");
  return parsed.origin;
}

/** Run the official CLI through an explicitly supplied isolated executor. */
export async function runPostman(root, spec, { run, resolveRuntime = () => "postman", environment: suppliedEnvironment = process.env, variables: suppliedVariables = {}, allowedOrigin = suppliedEnvironment.CV_DOCS_NONPRODUCTION_ORIGIN } = {}) {
  const collectionPath = inside(root, spec.file);
  const collection = JSON.parse(await readFile(collectionPath, "utf8"));
  if (!collection.info?.schema?.includes("/collection/v2.1.0/")) throw new Error("Postman collection must use schema v2.1");
  const entries = requests(collection.item, collection.event?.some((event) => event.listen === "test" && /\bpm\.test\s*\(/.test((event.script?.exec ?? []).join("\n"))));
  if (!entries.length) throw new Error("Postman collection has no requests");
  const variables = { ...spec.variables };
  for (const [name, environmentName] of Object.entries(spec.environment ?? {})) {
    if (!suppliedEnvironment[environmentName]) throw new Error(`Required documentation environment is missing: ${environmentName}`);
    variables[name] = suppliedEnvironment[environmentName];
  }
  Object.assign(variables, suppliedVariables);
  if (!variables.baseUrl) throw new Error("Postman requires an explicit baseUrl");
  const origin = nonproductionUrl(variables.baseUrl, allowedOrigin);
  for (const { item, hasTests } of entries) {
    if (!hasTests) throw new Error(`Postman request lacks test assertions: ${item.name}`);
    let url = typeof item.request.url === "string" ? item.request.url : item.request.url?.raw;
    if (!url) throw new Error("Postman request needs an explicit URL");
    url = url.replace(/\{\{([^}]+)\}\}/g, (match, key) => variables[key] ?? match);
    if (nonproductionUrl(url, allowedOrigin) !== origin) throw new Error("Postman request leaves the allowed origin");
  }
  let runtime;
  try { runtime = resolveRuntime(); if (typeof run !== "function") throw new Error("No isolated executor"); }
  catch { throw new Error("Postman runtime is unavailable. The isolated official CLI executor is required."); }
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), "cv-docs-postman-"));
  try {
    const environment = path.join(directory, "environment.json");
    const copiedCollection = path.join(directory, "collection.json");
    const reportPath = path.join(directory, "report.json");
    await writeFile(copiedCollection, JSON.stringify(collection), { mode: 0o600 });
    await writeFile(environment, JSON.stringify({ values: Object.entries(variables).map(([key, value]) => ({ key, value, enabled: true })) }), { mode: 0o600 });
    const milliseconds = (value, maximum) => { if (value === undefined) return maximum; if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Invalid Postman timeout"); return value; };
    const timeout = milliseconds(spec.timeoutMs, 30000);
    await run(runtime, ["collection", "run", copiedCollection, "--environment", environment, "--bail", "--timeout", String(timeout), "--timeout-request", String(milliseconds(spec.requestTimeoutMs, 5000)), "--timeout-script", String(milliseconds(spec.scriptTimeoutMs, 5000)), "--ignore-redirects", "--no-insecure-file-read", "--working-dir", directory, "--no-report-events", "--reporters", "json", "--reporter-json-structure", "newman", "--reporter-json-export", reportPath, "--reporter-json-omitAllHeadersAndBody"], { cwd: directory, timeout: timeout + 5000 });
    let report;
    try { const info = await lstat(reportPath); if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error("Invalid report file"); report = JSON.parse(await readFile(reportPath, "utf8")); }
    catch (error) { if (error.code === "ENOENT") throw new Error("Postman JSON report is missing"); throw new Error("Postman JSON report is invalid"); }
    const observed = report.run;
    if (!observed || !observed.stats || !Array.isArray(observed.failures) || !Array.isArray(observed.executions)) throw new Error("Postman JSON report is invalid");
    if (observed.failures.length || Object.values(observed.stats).some(value => value?.failed > 0)) throw new Error("Postman report records failures");
    const assertions = observed.executions.flatMap(value => value.assertions ?? []);
    if (observed.stats.assertions?.pending > 0 || assertions.some(value => value.skipped)) throw new Error("Postman report contains skipped assertions");
    if (!Number.isSafeInteger(observed.stats.requests?.total) || observed.stats.requests.total < 1 || observed.executions.length !== observed.stats.requests.total) throw new Error("Postman request coverage is missing");
    if (!Number.isSafeInteger(observed.stats.assertions?.total) || observed.stats.assertions.total < 1 || !assertions.length || observed.executions.some(value => !Array.isArray(value.assertions) || !value.assertions.length)) throw new Error("Postman assertion coverage is missing");
    if (entries.some(({ item }) => !observed.executions.some(value => value.item?.name === item.name))) throw new Error("Postman request coverage is incomplete");
    return { requests: observed.stats.requests.total, assertions: observed.stats.assertions.total, skipped: 0 };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function verifyDocumentation({ root = projectRoot, config = "tests/docs/workspace-docs.json", environment = process.env, quickstart = {}, postman = {} } = {}) {
  let specification;
  try { specification = JSON.parse(await readFile(inside(root, config), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error(`Documentation configuration is missing: ${config}. CV-26 must supply real checks.`);
    throw error;
  }
  for (const kind of ["markdown", "quickstarts", "postman"]) if (!Array.isArray(specification[kind]) || !specification[kind].length) throw new Error(`${kind} must contain at least one check`);
  for (const name of specification.requiredEnvironment ?? []) if (!environment[name]) throw new Error(`Required documentation environment is missing: ${name}`);
  const links = await checkMarkdownLinks(root, specification.markdown);
  for (const example of specification.quickstarts) await runQuickstart(root, example, { environment, ...quickstart });
  const reports = [];
  for (const collection of specification.postman) reports.push(await runPostman(root, collection, { environment, ...postman }));
  return { links, quickstarts: specification.quickstarts.length, postman: specification.postman.length, reports };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--self-test") {
    const files = (await readdir(path.join(projectRoot, "tests/docs"))).filter((file) => file.endsWith(".test.mjs")).sort();
    if (!files.length) throw new Error("Documentation harness self-tests are missing");
    const child = spawn(process.execPath, ["--test", ...files.map((file) => path.join(projectRoot, "tests/docs", file))], { stdio: "inherit", shell: false });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    if (code !== 0) throw new Error("Documentation harness self-tests failed");
    console.log("Documentation harness self-tests passed. Real quickstarts, Postman, and release suites were not checked.");
    return;
  }
  let backend = process.env.CV_TEST_BACKEND ?? "git"; let provider; const selected = new Set();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!["--backend", "--s3-provider"].includes(argument)) throw new Error(`Unknown documentation argument: ${argument}`);
    if (selected.has(argument)) throw new Error(`Duplicate documentation argument: ${argument}`);
    selected.add(argument);
    const value = args[++index]; if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (argument === "--backend") backend = value; else provider = value;
  }
  if (!["git", "s3"].includes(backend)) throw new Error("--backend git or s3 is required");
  if (provider && backend !== "s3") throw new Error("--s3-provider requires --backend s3");
  const environment = { ...process.env, CV_TEST_BACKEND: backend, CV_TEST_SUITE: "docs" };
  if (backend === "s3") requireS3(environment, { s3Provider: provider ?? environment.CV_TEST_S3_PROVIDER });
  try { JSON.parse(await readFile(path.join(projectRoot, "tests/docs/workspace-docs.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") throw new Error("Documentation configuration is missing: tests/docs/workspace-docs.json"); throw error; }
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), "cv-docs-run-"));
  const reportPath = path.join(directory, "vitest.json"); const evidencePath = path.join(directory, "evidence.json");
  let verified = false;
  try {
    const child = spawn(process.execPath, [path.join(projectRoot, "node_modules/vitest/vitest.mjs"), "run", "tests/docs/live.test.mts", "--config", "tests/docs/vitest.config.mjs", "--reporter=json", "--outputFile=" + reportPath], { cwd: projectRoot, env: { ...environment, CV_DOCS_EVIDENCE_PATH: evidencePath }, stdio: "inherit", shell: false });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (value, signal) => resolve(value ?? (signal ? 1 : 0))); });
    if (code !== 0) throw new Error("Executable documentation checks failed; private diagnostic report: " + reportPath);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    if (!report.success || report.numTotalTests !== 2 || report.numPassedTests !== 2 || report.numFailedTests || report.numPendingTests || report.numTodoTests) throw new Error("Documentation checks require both tests with zero skips");
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    if (evidence.backend !== backend || evidence.quickstarts !== 3 || evidence.postman !== 1 || evidence.runtimeProbes?.cases?.length !== 8 || evidence.runtimeProbes.cases.some(value => value.actual !== value.expected)) throw new Error("Documentation outcome evidence is incomplete");
    await writeFile(path.join(projectRoot, "tests/docs/verification-" + backend + ".log"), JSON.stringify({ ...evidence, tests: 2, skipped: 0 }, null, 2) + "\n", { mode: 0o600 });
    verified = true;
    console.log(JSON.stringify({ backend, tests: 2, skipped: 0, links: evidence.links, quickstarts: evidence.quickstarts, postman: evidence.postman, reports: evidence.reports, runtime: evidence.runtimeProbes.version, artifacts: evidence.artifacts }));
  } finally { if (verified) await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
