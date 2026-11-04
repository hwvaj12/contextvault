import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import * as s3 from "@aws-sdk/client-s3";
import * as helpers from "./helpers";
import { fixture } from "./helpers";

vi.mock("@aws-sdk/client-s3", async importOriginal => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return { ...actual, S3Client: vi.fn(function (...args: ConstructorParameters<typeof actual.S3Client>) { return new actual.S3Client(...args); }) };
});

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(s3.S3Client).mockReset();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const unsupportedStorage = [
  { CV_STORAGE_BACKEND: "s33", CV_S3_PROVIDER: "aws" },
  { CV_STORAGE_BACKEND: "s3", CV_S3_PROVIDER: "localstak" },
  { CV_STORAGE_BACKEND: "s3" },
];

it.each(unsupportedStorage)("rejects unsupported storage selection %j before reading fixture credentials", storage => {
  const reads: PropertyKey[] = [];
  const ambient = new Proxy({}, {
    get(_target, name) { reads.push(name); throw new Error("Fixture read ambient configuration before validation"); },
    ownKeys() { throw new Error("Fixture enumerated ambient credentials before validation"); },
  });
  expect(() => helpers.fixtureEnvironment("/fixture/owned", 3000, storage, {}, ambient)).toThrow(/unsupported.*(backend|provider)/i);
  expect(reads).toEqual([]);
});

it.each(unsupportedStorage)("rejects unsupported storage selection %j before constructing a cleanup client", async storage => {
  const client = vi.mocked(s3.S3Client).mockImplementation(function () { throw new Error("Cleanup constructed a client before validation"); });
  await expect(helpers.cleanupHttpStorage(storage)).rejects.toThrow(/unsupported.*(backend|provider)/i);
  expect(client).not.toHaveBeenCalled();
});

it.each([{ backend: "s33", provider: "localstack" }, { backend: "s3", provider: "localstak" }])("rejects unsupported test selection %j before creating fixture resources", async ({ backend, provider }) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "cv-http-invalid-selection-")); directories.push(directory);
  for (const [name, value] of Object.entries({ CV_TEST_BACKEND: backend, CV_TEST_S3_PROVIDER: provider, CV_TEST_S3_ENDPOINT: "http://127.0.0.1:1", CV_TEST_S3_BUCKET: "fixture-owned", CV_TEST_S3_REGION: "us-east-1", CV_TEST_S3_PREFIX: "contextvault-tests/provider-guard/", TMPDIR: join(directory, "must-not-be-read") })) vi.stubEnv(name, value);
  expect.soft(() => helpers.storageEnvironment()).toThrow(/unsupported.*(backend|provider)/i);
  await expect(fixture()).rejects.toThrow(/unsupported.*(backend|provider)/i);
});

it("rejects an unsupported backend override before reading fixture credentials", () => {
  const ambient = new Proxy({}, { get() { throw new Error("Fixture read ambient configuration before validation"); } });
  expect(() => helpers.fixtureEnvironment("/fixture/owned", 3000, { CV_STORAGE_BACKEND: "git" }, { CV_STORAGE_BACKEND: "s33" }, ambient)).toThrow(/unsupported.*backend/i);
});

it.each(["localstack", "aws"])("retains explicit %s cleanup credential selection", async provider => {
  const client = { send: vi.fn().mockResolvedValue({}), destroy: vi.fn() };
  const constructor = vi.mocked(s3.S3Client).mockImplementation(function () { return client as unknown as s3.S3Client; });
  await helpers.cleanupHttpStorage({ CV_STORAGE_BACKEND: "s3", CV_S3_PROVIDER: provider, CV_S3_ENDPOINT: "http://127.0.0.1:1", CV_S3_REGION: "us-east-1", CV_S3_BUCKET: "fixture-owned", CV_S3_PREFIX: `contextvault-tests/provider-guard/http-${randomUUID()}/` });
  const configuration = constructor.mock.calls[0][0];
  if (provider === "localstack") expect(configuration.credentials).toEqual({ accessKeyId: "test", secretAccessKey: "test" });
  else expect(configuration).not.toHaveProperty("credentials");
  expect(client.send).toHaveBeenCalledTimes(4);
  expect(client.destroy).toHaveBeenCalled();
});

it("bounds shared HTTP fixture cleanup against a stalled owned responder", async () => {
  const server = createHttpServer(() => {}); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const storage = { CV_STORAGE_BACKEND: "s3", CV_S3_PROVIDER: "localstack", CV_S3_ENDPOINT: `http://127.0.0.1:${(server.address() as { port: number }).port}`, CV_S3_REGION: "us-east-1", CV_S3_BUCKET: "contextvault-fixture-owned", CV_S3_PREFIX: `contextvault-tests/cleanup-fixture/http-${randomUUID()}/` };
  const started = Date.now();
  await expect(helpers.cleanupHttpStorage(storage, 150)).rejects.toThrow(/cleanup.*timed out/i);
  expect(Date.now() - started).toBeLessThan(1500);
});

it("keeps ambient database, secrets, preload, and Git settings outside its owned server", async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "cv-http-canaries-")); directories.push(directory);
  const databasePath = join(directory, "outside.db"); const secretsPath = join(directory, "outside-secrets.json");
  const database = new Database(databasePath); database.exec("CREATE TABLE canary (value TEXT); INSERT INTO canary VALUES ('fixture-owned');"); database.close();
  await writeFile(secretsPath, "{}\n");
  const originalDatabase = await readFile(databasePath); const originalSecrets = await readFile(secretsPath);
  const preloadPath = join(directory, "preload.cjs"); const preloadMarker = join(directory, "preload-ran");
  await writeFile(preloadPath, `require('node:fs').writeFileSync(${JSON.stringify(preloadMarker)}, 'ran');`);
  const ambient = {
    CV_TEST_BACKEND: "git", CV_DATABASE_PATH: databasePath, CONTEXTVAULT_SECRETS_PATH: secretsPath,
    CV_GIT_ROOT: join(directory, "outside-git"), CV_SUBMISSION_ROOT: join(directory, "outside-submissions"),
    CV_STORAGE_PROFILES: "[]", CV_AMBIENT_CANARY: "must-not-inherit", CONTEXTVAULT_API_KEY: "ambient-master",
    NODE_OPTIONS: `--require=${preloadPath}`, NODE_PATH: directory, DOTENV_CONFIG_PATH: join(directory, "outside.env"),
    GIT_CONFIG_GLOBAL: join(directory, "outside-gitconfig"), AWS_PROFILE: "fixture-only-unselected-profile",
  };
  for (const [name, value] of Object.entries(ambient)) vi.stubEnv(name, value);
  const context = await fixture(); await context.key(); await context.stop();
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  expect(hash(await readFile(databasePath)), "Ambient catalog canary must remain byte-identical").toBe(hash(originalDatabase));
  expect(hash(await readFile(secretsPath)), "Ambient secret canary must remain byte-identical").toBe(hash(originalSecrets));
  await expect(readFile(preloadMarker)).rejects.toMatchObject({ code: "ENOENT" });
  for (const name of Object.keys(ambient).filter(name => !["CONTEXTVAULT_API_KEY", "GIT_CONFIG_GLOBAL"].includes(name))) expect(context.env[name], name).toBeUndefined();
  expect(context.env.HOME).toBe(context.directory);
  expect(context.env.GIT_CONFIG_GLOBAL).toBe(join(context.directory, "gitconfig"));
  expect(context.env.V8_COMPILE_CACHE_CACHE_DIR).toBe(join(context.directory, "compile-cache"));
});

it("selects dummy LocalStack credentials and preserves the AWS chain only for an explicitly selected AWS provider", () => {
  const ambient = { PATH: "/fixture/bin", HOME: "/fixture/aws-home", AWS_PROFILE: "fixture-profile", AWS_CONFIG_FILE: "/fixture/aws-config", AWS_SESSION_TOKEN: "fixture-token", CV_DATABASE_PATH: "/fixture/foreign.db", NODE_OPTIONS: "--require=/fixture/preload.cjs" };
  const localstack = helpers.fixtureEnvironment("/fixture/owned", 3000, { CV_STORAGE_BACKEND: "s3", CV_S3_PROVIDER: "localstack" }, {}, ambient);
  expect(Object.fromEntries(Object.entries(localstack).filter(([name]) => name.startsWith("AWS_")))).toEqual({ AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", AWS_EC2_METADATA_DISABLED: "true" });
  expect(localstack.HOME).toBe("/fixture/owned");
  const aws = helpers.fixtureEnvironment("/fixture/owned", 3000, { CV_STORAGE_BACKEND: "s3", CV_S3_PROVIDER: "aws" }, {}, ambient);
  for (const name of ["AWS_PROFILE", "AWS_CONFIG_FILE", "AWS_SESSION_TOKEN", "HOME"] as const) expect(aws[name]).toBe(ambient[name]);
  for (const name of ["CV_DATABASE_PATH", "NODE_OPTIONS"]) expect(aws[name]).toBeUndefined();
  const git = helpers.fixtureEnvironment("/fixture/owned", 3000, { CV_STORAGE_BACKEND: "git" }, {}, ambient);
  expect(Object.keys(git).some(name => name.startsWith("AWS_"))).toBe(false);
  expect(() => helpers.fixtureEnvironment("/fixture/owned", 3000, {}, { NODE_OPTIONS: "--require=foreign" }, ambient)).toThrow(/controlled setting/i);
});
