import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
// The controller owns server resources. Only its client DTO crosses into consumers.
// @ts-ignore private test controller is deliberately JavaScript
import { startWorkspaceServer } from "../../helpers/workspace-server.mjs";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const runtime = "node:18-bookworm-slim";
const ownerLabel = "io.contextvault.sdk-test.owner";
const commandOptions = { killSignal: "SIGKILL" as const, maxBuffer: 1024 * 1024 };

async function removeContainer(identity: string) {
  const name = `cv-ts-${identity}`;
  const absent = (error: any) => /No such (?:object|container)/i.test(error.stderr ?? "");
  let inspected;
  try { inspected = await execute("docker", ["inspect", "--format", `{{index .Config.Labels "${ownerLabel}"}}`, name], { ...commandOptions, timeout: 2000 }); }
  catch (error) { if (absent(error)) return; throw error; }
  if (inspected.stdout.trim() !== identity) throw new Error("Container cleanup refused a different owner");
  try { await execute("docker", ["rm", "-f", name], { ...commandOptions, timeout: 3000 }); }
  catch (error) { if (!absent(error)) throw error; }
}
async function runContainer(args: string[], options: { timeout: number; env?: NodeJS.ProcessEnv; identity?: string }) {
  const identity = options.identity ?? randomUUID();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(identity)) throw new Error("Container identity must be an owned UUID");
  try {
    return await execute("docker", ["run", "--name", `cv-ts-${identity}`, "--label", `${ownerLabel}=${identity}`, "--rm", "--pull=never", ...args], {
      ...commandOptions, timeout: options.timeout, ...(options.env ? { env: options.env } : {}),
    });
  } finally { await removeContainer(identity); }
}

export async function installedJourney(backend: "git" | "s3", scenario: string, serverEnv: Record<string, string> = {}, options: { consumerTimeoutMs?: number; consumerIdentity?: string } = {}) {
  // No default provider, inferred endpoint, skips, or fallback backend.
  if (backend === "s3" && process.env.CV_TEST_S3_PROVIDER !== "localstack") throw new Error("SDK gate requires explicitly selected LocalStack");
  const directory = await mkdtemp(path.join(await import("node:fs/promises").then(fs => fs.realpath(tmpdir())), "cv-installed-ts-"));
  const deadline = performance.now() + 150000;
  const remaining = (maximum: number) => {
    const duration = Math.floor(Math.min(maximum, deadline - performance.now()));
    if (duration < 1) throw new Error("Installed SDK journey exceeded its overall deadline");
    return duration;
  };
  let server: any;
  try {
    const packed = await execute("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { ...commandOptions, cwd: path.join(root, "sdk/typescript"), timeout: remaining(20000) });
    const [{ filename }] = JSON.parse(packed.stdout);
    await copyFile(path.join(directory, filename), path.join(directory, "sdk.tgz"));
    await copyFile(path.join(root, "tests/fixtures/workspaces/canonical.v1.json"), path.join(directory, "canonical.json"));
    await copyFile(path.join(root, "tests/sdk/typescript/consumer.cjs"), path.join(directory, "consumer.cjs"));
    await writeFile(path.join(directory, "package.json"), '{"name":"installed-sdk-consumer","version":"1.0.0","private":true}');
    await runContainer(["-v", `${directory}:/consumer`, "-w", "/consumer", runtime,
      "npm", "install", "--engine-strict", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "./sdk.tgz"], { timeout: remaining(60000) });
    const manifest = JSON.parse(await readFile(path.join(directory, "node_modules/@contextvault/sdk/package.json"), "utf8"));
    if (manifest.engines.node !== ">=18.0.0") throw new Error("SDK changed its minimum Node runtime");
    server = await startWorkspaceServer({ backend, serverEnv, startupTimeoutMs: remaining(10000), shutdownTimeoutMs: 5000, cleanupTimeoutMs: 10000 });
    const client = server.client;
    const url = client.baseUrl.replace("127.0.0.1", "host.docker.internal");
    const env = { CV_URL: url, CV_KEY_A: client.keyA, CV_KEY_B: client.keyB,
      CV_CUSTOMER_A: client.customerA, CV_CUSTOMER_B: client.customerB };
    const result = await runContainer(["--add-host=host.docker.internal:host-gateway",
      "-v", `${directory}:/consumer`, "-w", "/consumer", ...Object.keys(env).flatMap(name => ["-e", name]), runtime,
      "node", "consumer.cjs", scenario], { env: { ...server.clientEnvironment(), ...env }, timeout: remaining(options.consumerTimeoutMs ?? 120000), identity: options.consumerIdentity });
    if (!result.stdout.includes(`PASS ${scenario} Node18`)) throw new Error(`Installed consumer omitted outcome: ${result.stdout}`);
    return result.stdout.trim();
  } finally {
    // The controller bounds shutdown and storage cleanup separately; filesystem teardown owns only this unique temp directory.
    try { await server?.dispose(); }
    finally { await execute("/bin/rm", ["-rf", directory], { ...commandOptions, timeout: 10000 }); }
  }
}
