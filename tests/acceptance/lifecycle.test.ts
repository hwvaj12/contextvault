import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

const root = path.resolve(import.meta.dirname, "../..");
const children: ChildProcess[] = [];
const directories: string[] = [];
const masterKey = "cv-acceptance-only-master";

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startServer(serverDirectory: string, port: number) {
  const child = spawn(process.execPath, [
    "-r", path.join(root, "node_modules/ts-node/register/transpile-only"),
    path.join(root, "src/index.ts"),
  ], {
    cwd: serverDirectory,
    env: {
      ...process.env, PORT: String(port), CONTEXTVAULT_API_KEY: masterKey,
      TS_NODE_PROJECT: path.join(root, "tsconfig.json"),
      CV_STORAGE_BACKEND: process.env.CV_TEST_BACKEND ?? "git",
      GIT_AUTHOR_NAME: "Acceptance", GIT_AUTHOR_EMAIL: "acceptance@example.invalid",
      GIT_COMMITTER_NAME: "Acceptance", GIT_COMMITTER_EMAIL: "acceptance@example.invalid",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server startup failed: ${output}`);
    try {
      const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (health.ok && (await health.json() as { status: string }).status === "healthy") return { child, baseUrl };
    } catch { /* Wait for the real listener. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become healthy: ${output}`);
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(force);
}

async function client(baseUrl: string, directory: string, keys: string[], action: string, workspaceId?: string) {
  const child = spawn(process.execPath, [path.join(root, "tests/helpers/public-lifecycle-client.mjs"), action], {
    cwd: directory,
    // The HTTP client receives no server directory or storage credentials.
    env: { PATH: process.env.PATH, CV_URL: baseUrl, CV_KEY_A: keys[0], CV_KEY_B: keys[1], CV_WORKSPACE_ID: workspaceId },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  expect(code, `Public lifecycle client failed:\n${output}`).toBe(0);
  return JSON.parse(output) as { workspaceId: string };
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stop));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it("A01/A06: publishes exact bytes and deletions through HTTP, survives restart, and preserves abort isolation", async () => {
  const serverDirectory = await mkdtemp(path.join(tmpdir(), "cv-http-server-"));
  const clientDirectory = await mkdtemp(path.join(tmpdir(), "cv-http-client-"));
  directories.push(serverDirectory, clientDirectory);
  const port = await unusedPort();
  let server = await startServer(serverDirectory, port);
  const keys = [];
  for (const customerId of ["acceptance-customer-a", "acceptance-customer-b"]) {
    const response = await fetch(`${server.baseUrl}/api-keys`, {
      method: "POST", headers: { "X-API-Key": masterKey, "Content-Type": "application/json" },
      body: JSON.stringify({ customerId, name: "isolated-lifecycle-test" }),
    });
    expect(response.status, "Legacy identity setup must succeed before acceptance assertions").toBe(201);
    keys.push((await response.json() as { plainKey: string }).plainKey);
  }
  const { workspaceId } = await client(server.baseUrl, clientDirectory, keys, "publish");
  await stop(server.child);
  server = await startServer(serverDirectory, port);
  await client(server.baseUrl, clientDirectory, keys, "reopen-and-abort", workspaceId);
  await rm(clientDirectory, { recursive: true, force: true });
  const secondClient = await mkdtemp(path.join(tmpdir(), "cv-http-other-client-"));
  directories.push(secondClient);
  await client(server.baseUrl, secondClient, keys, "verify", workspaceId);
}, 60000);
