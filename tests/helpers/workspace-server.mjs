import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, chmod, realpath, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { requireS3 } from "../../scripts/run-workspace-tests.mjs";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeNames = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR", "PATHEXT"];
const runtimeEnvironment = () => Object.fromEntries(runtimeNames.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const execute = promisify(execFile);
const serverSettings = new Set(["CV_LEASE_TTL_MS", "CV_PROCESSING_TTL_MS", "CV_MAINTENANCE_INTERVAL_MS", "CV_REQUEST_TIMEOUT_MS", "CV_WORKSPACE_LIMITS"]);

function milliseconds(value, fallback) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 120_000) throw new Error("Fixture timeouts must be between 1 and 120000 milliseconds");
  return result;
}
async function unusedPort() {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    return server.address().port;
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
async function bounded(promise, timeout, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); })]); }
  finally { clearTimeout(timer); }
}

/**
 * Run this test controller on Node 22+, separately from minimum-version clients.
 * Required: backend. Optional: serverRoot/serverNode, explicit test env, timing
 * bounds, and the five allowlisted serverEnv settings. No data-root overrides.
 * Only `client` and `clientEnvironment()` belong in installed client processes.
 * The controller id correlates its unique `http-fixture-<id>/` test namespace.
 * This is environment separation, not operating-system filesystem denial.
 */
export async function startWorkspaceServer(options = {}) {
  if (!["git", "s3"].includes(options.backend)) throw new Error("Fixture backend must be explicitly git or s3");
  const suppliedEnvironment = options.env ?? process.env;
  if (options.backend === "s3" && !["localstack", "aws"].includes(suppliedEnvironment.CV_TEST_S3_PROVIDER)) throw new Error("--s3-provider localstack or aws is required");
  const targetEnvironment = options.backend === "s3" ? { ...suppliedEnvironment } : {};
  const serverRoot = await realpath(options.serverRoot ?? defaultRoot);
  const serverNode = options.serverNode ?? process.env.CV_TEST_SERVER_NODE ?? process.execPath;
  const startupMs = milliseconds(options.startupTimeoutMs, 15_000);
  const shutdownMs = milliseconds(options.shutdownTimeoutMs, 10_000);
  const cleanupMs = milliseconds(options.cleanupTimeoutMs, 30_000);
  const settings = options.serverEnv ?? {};
  if (!settings || typeof settings !== "object" || Array.isArray(settings) || Object.entries(settings).some(([name, value]) => !serverSettings.has(name) || typeof value !== "string")) throw new Error("Fixture server settings must use the explicit timing/limit allowlist");
  for (const [name, value] of Object.entries(settings)) {
    if (name !== "CV_WORKSPACE_LIMITS" && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)) throw new Error("Fixture timing settings must be positive safe integers");
    if (name === "CV_WORKSPACE_LIMITS") {
      let limits;
      try { limits = JSON.parse(value); } catch { throw new Error("Fixture workspace limits must be a JSON object"); }
      if (!limits || typeof limits !== "object" || Array.isArray(limits)) throw new Error("Fixture workspace limits must be a JSON object");
    }
  }
  await access(path.join(serverRoot, "src/index.ts"));
  let version;
  try { version = (await execute(serverNode, ["-p", "process.versions.node"], { timeout: 3000, killSignal: "SIGKILL", maxBuffer: 1024, env: runtimeEnvironment() })).stdout.trim(); }
  catch { throw new Error("Fixture server executable did not report its Node.js version"); }
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) || Number(version.split(".")[0]) < 22) throw new Error("Fixture server requires an explicit Node.js 22 or later executable");
  const id = randomUUID();
  let target;
  if (options.backend === "s3") {
    // Both server and cleanup use the controller's standard AWS credential chain.
    if (targetEnvironment.CV_TEST_S3_PROVIDER === "aws") {
      for (const name of Object.keys(targetEnvironment)) if (name.startsWith("AWS_") && name !== "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS" && targetEnvironment[name] !== process.env[name]) throw new Error("AWS fixture settings must come from the controller environment");
      for (const name of Object.keys(process.env)) if (name.startsWith("AWS_")) targetEnvironment[name] = process.env[name];
    }
    requireS3(targetEnvironment, { s3Provider: targetEnvironment.CV_TEST_S3_PROVIDER, realS3: targetEnvironment.CV_REQUIRE_REAL_S3 === "1" });
    target = {
      provider: targetEnvironment.CV_TEST_S3_PROVIDER,
      bucket: targetEnvironment.CV_TEST_S3_BUCKET,
      region: targetEnvironment.CV_TEST_S3_REGION,
      endpoint: targetEnvironment.CV_TEST_S3_ENDPOINT,
      prefix: `${targetEnvironment.CV_TEST_S3_PREFIX}http-fixture-${id}/`,
    };
  }
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), "cv-http-fixture-"));
  let port;
  try { await chmod(directory, 0o700); port = await unusedPort(); } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  const baseUrl = `http://127.0.0.1:${port}`;
  const masterKey = `cv-fixture-${randomUUID()}`;
  const customerA = `fixture-a-${id}`;
  const customerB = `fixture-b-${id}`;
  let keys;
  let child;
  let closed;
  let exit;
  let disposed = false;
  let queue = Promise.resolve();
  const serial = work => { const result = queue.then(work); queue = result.catch(() => {}); return result; };
  const client = () => {
    if (!keys) throw new Error("Fixture has not provisioned client credentials");
    return { baseUrl, customerA, customerB, keyA: keys[0], keyB: keys[1] };
  };
  const serverEnvironment = {
    ...runtimeEnvironment(), ...settings, HOME: directory,
    PORT: String(port), CONTEXTVAULT_API_KEY: masterKey,
    CV_DATA_DIR: path.join(directory, "data"), CV_STORAGE_BACKEND: options.backend,
    TS_NODE_PROJECT: path.join(serverRoot, "tsconfig.json"),
    V8_COMPILE_CACHE_CACHE_DIR: path.join(directory, "compile-cache"),
    GIT_AUTHOR_NAME: "ContextVault fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "ContextVault fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  if (target) {
    for (const name of Object.keys(targetEnvironment)) if (name.startsWith("AWS_")) serverEnvironment[name] = targetEnvironment[name];
    if (target.provider === "aws" && process.env.HOME) serverEnvironment.HOME = process.env.HOME;
    Object.assign(serverEnvironment, { CV_S3_PROVIDER: target.provider, CV_S3_ENDPOINT: target.endpoint, CV_S3_BUCKET: target.bucket, CV_S3_REGION: target.region, CV_S3_PREFIX: target.prefix });
  }
  async function terminate(signal, graceful) {
    if (!child) return { running: false };
    const current = child;
    const killOwned = signal => {
      if (process.platform !== "win32" && current.pid) {
        try { process.kill(-current.pid, signal); return true; } catch (error) { if (error.code !== "ESRCH") throw error; return false; }
      } else return current.kill(signal);
    };
    if (!closed) {
      if (graceful) current.kill(signal); else killOwned(signal);
      try { await bounded(exit, shutdownMs, "Fixture server shutdown timed out"); }
      catch (error) {
        killOwned("SIGKILL");
        await bounded(exit, shutdownMs, "Fixture server did not stop after forced termination");
        child = undefined;
        throw error;
      }
    }
    const result = await exit;
    // The dedicated process group contains only this fixture's server descendants.
    const retainedDescendants = killOwned("SIGKILL");
    child = undefined;
    if (graceful && retainedDescendants) throw new Error("Fixture server left running descendants after shutdown");
    if (result.error || (graceful && result.code !== 0 && result.signal !== "SIGTERM")) throw new Error("Fixture server exited unsuccessfully");
    return { running: false };
  }
  async function launch() {
    if (disposed) throw new Error("Fixture has been disposed");
    if (child && !closed) return client();
    closed = false;
    child = spawn(serverNode, ["-r", path.join(serverRoot, "node_modules/ts-node/register/transpile-only"), path.join(serverRoot, "src/index.ts")], {
      cwd: directory, env: serverEnvironment, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    // Consume output without retaining private server logs or allowing unbounded buffers.
    child.stdout.on("data", () => {}); child.stderr.on("data", () => {});
    exit = new Promise(resolve => {
      let failure;
      child.once("error", error => { failure = error; });
      child.once("close", (code, signal) => { closed = true; resolve({ code, signal, error: failure }); });
    });
    const deadline = Date.now() + startupMs;
    try {
      let healthy = false;
      while (Date.now() < deadline) {
        if (closed) throw new Error("Fixture server exited before becoming healthy");
        try {
          const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(Math.max(1, Math.min(500, deadline - Date.now()))) });
          healthy = response.ok && (await response.json()).status === "healthy";
          if (healthy) break;
        } catch { /* A real listener may still be starting. */ }
        await pause(25);
      }
      if (!healthy || closed) throw new Error("Fixture server did not become healthy before its deadline");
      if (!keys) {
        keys = [];
        for (const customerId of [customerA, customerB]) {
          const response = await fetch(`${baseUrl}/api-keys`, { method: "POST", headers: { "X-API-Key": masterKey, "Content-Type": "application/json" }, body: JSON.stringify({ customerId, name: "installed-client-fixture" }), signal: AbortSignal.timeout(startupMs) });
          if (response.status !== 201) throw new Error("Fixture tenant credential setup failed");
          const key = (await response.json()).plainKey;
          if (typeof key !== "string" || !key) throw new Error("Fixture omitted its tenant credential");
          keys.push(key);
        }
      }
      // A health response from another process cannot satisfy ownership after a port race.
      const verified = await fetch(`${baseUrl}/workspaces?customerId=${encodeURIComponent(customerA)}`, { headers: { "X-API-Key": masterKey, "X-ContextVault-Customer-Id": customerA }, signal: AbortSignal.timeout(startupMs) });
      if (verified.status !== 200 || closed) throw new Error("Fixture server ownership check failed");
      await verified.body?.cancel();
      return client();
    } catch (error) { try { await terminate("SIGTERM", false); } catch { /* Disposal will report any remaining cleanup failure. */ } throw error; }
  }
  async function cleanStorage() {
    if (!target) return;
    const sdk = createRequire(path.join(serverRoot, "package.json"))("@aws-sdk/client-s3");
    const storage = new sdk.S3Client({ region: target.region, endpoint: target.endpoint, forcePathStyle: true, ignoreConfiguredEndpointUrls: true, maxAttempts: 1,
      ...(target.provider === "localstack" ? { credentials: { accessKeyId: "test", secretAccessKey: "test" } } : {}) });
    const Bucket = target.bucket; const Prefix = target.prefix;
    const deadline = Date.now() + cleanupMs;
    const send = command => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Fixture storage cleanup timed out");
      return storage.send(command, { abortSignal: AbortSignal.timeout(remaining) });
    };
    try {
      let KeyMarker; let UploadIdMarker;
      let pages = 0;
      do {
        if (++pages > 1000) throw new Error("Fixture multipart cleanup exceeded its page bound");
        const page = await send(new sdk.ListMultipartUploadsCommand({ Bucket, Prefix, KeyMarker, UploadIdMarker, MaxUploads: 100 }));
        for (const upload of page.Uploads ?? []) {
          if (!upload.Key?.startsWith(Prefix) || !upload.UploadId) throw new Error("Fixture multipart cleanup escaped its owned prefix");
          await send(new sdk.AbortMultipartUploadCommand({ Bucket, Key: upload.Key, UploadId: upload.UploadId }));
        }
        KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined; UploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
        if (page.IsTruncated && !KeyMarker) throw new Error("Fixture multipart cleanup did not advance");
      } while (KeyMarker);
      let ContinuationToken;
      pages = 0;
      do {
        if (++pages > 1000) throw new Error("Fixture object cleanup exceeded its page bound");
        const page = await send(new sdk.ListObjectsV2Command({ Bucket, Prefix, ContinuationToken, MaxKeys: 100 }));
        const Objects = (page.Contents ?? []).map(item => {
          if (!item.Key?.startsWith(Prefix)) throw new Error("Fixture object cleanup escaped its owned prefix");
          return { Key: item.Key };
        });
        if (Objects.length) {
          const deleted = await send(new sdk.DeleteObjectsCommand({ Bucket, Delete: { Objects, Quiet: true } }));
          if (deleted.Errors?.length) throw new Error("Fixture object cleanup was incomplete");
        }
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && !ContinuationToken) throw new Error("Fixture object cleanup did not advance");
      } while (ContinuationToken);
    } finally { storage.destroy(); }
  }
  async function dispose() {
    if (disposed) return { disposed: true };
    let failure;
    try { await terminate("SIGTERM", true); } catch (error) { failure = error; }
    if (child && !closed) throw failure ?? new Error("Fixture server is still running; cleanup retained its resources");
    await cleanStorage();
    await rm(directory, { recursive: true, force: true }); disposed = true;
    if (failure) throw failure;
    return { disposed: true };
  }
  const fixture = {
    id,
    get client() { return client(); },
    clientEnvironment() { const value = client(); return { ...runtimeEnvironment(), CV_URL: value.baseUrl, CV_KEY_A: value.keyA, CV_KEY_B: value.keyB }; },
    start: () => serial(launch),
    restart: () => serial(async () => { await terminate("SIGTERM", true); return launch(); }),
    stop: () => serial(() => terminate("SIGTERM", true)),
    crash: () => serial(async () => { if (!child || closed) throw new Error("Fixture server is not running"); return terminate("SIGKILL", false); }),
    dispose: () => serial(dispose),
  };
  try { await fixture.start(); return fixture; }
  catch (error) {
    try { await fixture.dispose(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Fixture startup and disposal both failed"); }
    throw error;
  }
}

/** Private test-parent protocol. This controller is not an installed agent client. */
async function controlStdio() {
  let fixture;
  let backend;
  let pending = Promise.resolve();
  let queued = 0;
  let finishing;
  let input = "";
  let failed = false;
  let outputFailed = false;
  let terminalError;
  // One response may be in flight. Parsed commands, identifiers and frames also have fixed bounds.
  const fail = (message, brokenOutput = false) => {
    terminalError ??= message; failed = true; process.exitCode = 1; input = "";
    if (brokenOutput) { outputFailed = true; process.stdout.destroy(); }
    process.stdin.destroy();
    void finish().catch(() => {});
  };
  const respond = async value => {
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line) > 4096) { fail("Fixture response exceeded its byte limit"); throw new Error("Fixture response exceeded its byte limit"); }
    try {
      if (outputFailed || process.stdout.destroyed) throw new Error("Fixture output is closed");
      await new Promise((resolve, reject) => {
        let written = false; let drained = true; let ready = false; let settled = false;
        const complete = error => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          process.stdout.removeListener("error", onError); process.stdout.removeListener("close", onClose); process.stdout.removeListener("drain", onDrain);
          if (error) reject(error); else resolve();
        };
        const check = () => { if (ready && written && drained) complete(); };
        const onError = error => complete(error);
        const onClose = () => complete(new Error("Fixture output closed before its response completed"));
        const onDrain = () => { drained = true; check(); };
        const timer = setTimeout(() => complete(new Error("Fixture output did not drain before its deadline")), 1000);
        process.stdout.once("error", onError); process.stdout.once("close", onClose);
        try {
          drained = process.stdout.write(line, error => { if (error) complete(error); else { written = true; check(); } });
          if (!drained) process.stdout.once("drain", onDrain);
          ready = true; check();
        } catch (error) { complete(error); }
      });
    } catch (error) { fail("Fixture output failed or did not drain", true); throw error; }
  };
  const command = async line => {
    let request; let responseId = null;
    try {
      request = JSON.parse(line);
      if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Control request needs an id");
      if (typeof request.id === "string" && Buffer.byteLength(request.id) > 256) { fail("Fixture control identifier exceeded its byte limit"); return; }
      if (typeof request.id !== "string" && (typeof request.id !== "number" || !Number.isFinite(request.id))) throw new Error("Control request needs a bounded id");
      responseId = request.id;
      if (request.command === "start") {
        if (!fixture) {
          fixture = await startWorkspaceServer({ backend: request.backend, serverRoot: request.serverRoot, serverNode: request.serverNode, serverEnv: request.serverEnv });
          backend = request.backend;
        } else {
          if ((request.backend !== undefined && request.backend !== backend) || request.serverRoot !== undefined || request.serverNode !== undefined || request.serverEnv !== undefined) throw new Error("An existing fixture cannot change configuration");
          await fixture.start();
        }
        await respond({ id: responseId, ok: true, client: fixture.client });
      } else if (["restart", "stop", "crash", "dispose"].includes(request.command)) {
        if (!fixture) throw new Error("Control fixture has not started");
        const result = await fixture[request.command]();
        await respond({ id: responseId, ok: true, ...(request.command === "restart" ? { client: fixture.client } : { status: result }) });
        if (request.command === "dispose") { fixture = undefined; backend = undefined; }
      } else throw new Error("Unknown fixture control command");
    } catch { if (!failed) await respond({ id: responseId, ok: false, error: "Fixture control command failed" }); }
  };
  const schedule = line => {
    if (failed) return;
    if (queued >= 64) { fail("Fixture control queue is full"); return; }
    queued++;
    pending = pending.then(() => { if (!failed) return command(line); }).catch(() => { fail("Fixture controller command failed"); }).finally(() => { queued--; });
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    if (failed) return;
    input += chunk;
    for (;;) {
      const end = input.indexOf("\n"); if (end < 0) break;
      const line = input.slice(0, end); input = input.slice(end + 1);
      if (Buffer.byteLength(line) > 64 * 1024) { fail("Fixture control frame exceeded its byte limit"); return; }
      schedule(line); if (failed) return;
    }
    if (Buffer.byteLength(input) > 64 * 1024) fail("Fixture control frame exceeded its byte limit");
  });
  function finish() {
    if (finishing) return finishing;
    finishing = (async () => {
      try { await pending; if (terminalError && !outputFailed) await respond({ id: null, ok: false, error: terminalError }); }
      finally { await fixture?.dispose(); }
    })();
    void finishing.then(() => { if (failed) process.exit(1); }, () => { process.exitCode = 1; process.stdout.destroy(); process.exit(1); });
    return finishing;
  }
  const end = () => { if (!failed && input.trim()) { schedule(input); input = ""; } void finish().catch(() => {}); };
  process.stdin.once("end", end); process.stdin.once("close", end);
  process.stdout.on("error", () => fail("Fixture output failed", true));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { process.stdin.destroy(); void finish().then(() => process.exit(failed ? 1 : 0), () => process.exit(1)); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "--stdio") { process.stderr.write("Use --stdio for the private fixture controller\n"); process.exitCode = 1; }
  else await controlStdio();
}
