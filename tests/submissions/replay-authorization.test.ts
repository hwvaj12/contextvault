import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteControlStore } from "../../src/adapters/control/sqlite-control-store";
import { LocalSubmissionStore } from "../../src/adapters/submissions/local";
import { createTestDb } from "../../src/db";
import type { Principal, RunScope, UploadReceipt } from "../../src/domain";
import type { SealSubmissionInput, WriteSubmissionFileInput } from "../../src/ports/submission-store";
import { command, fixture, later, now, principal, scope } from "../control/helpers";
import { consume, digest, stream } from "./helpers";

const resources: { root: string; databases: ReturnType<typeof createTestDb>[] }[] = [];
const binary = Buffer.from([0, 255, 128, 13, 10, 65, 0]);
const submissionId = "replay-submission" as UploadReceipt["submissionId"];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    for (const database of resource.databases) if (database.open) database.close();
    await rm(resource.root, { recursive: true, force: true });
  }
});

async function setup() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "cv-replay-authorization-"));
  const resource = { root, databases: [] as ReturnType<typeof createTestDb>[] };
  resources.push(resource);
  const connect = () => {
    const database = createTestDb(join(root, "catalog.sqlite"));
    resource.databases.push(database);
    return new SqliteControlStore(database);
  };
  const control = connect();
  const catalog = await fixture(control.database);
  const run = await catalog.open();
  const runScope: RunScope = { ...run.scope, runId: run.id };
  const adapter = (store = control) => new LocalSubmissionStore({ root: join(root, "bytes"), control: store, now: () => now });
  const store = adapter();
  await store.begin({ scope: runScope, principal, submissionId, command: command("submission:create", {}, run.id), expiresAt: later });
  const payload = { submissionId, path: "snapshot.bin", declaredByteLength: binary.length, declaredSha256: digest(binary) };
  const input: WriteSubmissionFileInput = {
    scope: runScope, principal, submissionId, ...payload,
    command: command("submission:file", payload, run.id), receiptId: "replay-receipt" as UploadReceipt["id"], bytes: stream(binary),
  };
  const receipt = await store.writeFile(input);
  const selected = {
    manifest: { schemaVersion: 1 as const, entries: [{ path: receipt.path, kind: "file" as const, byteLength: receipt.byteLength, sha256: receipt.sha256 }] },
    receipts: [{ path: receipt.path, receiptId: receipt.id }],
  };
  const sealInput: SealSubmissionInput = {
    scope: runScope, principal, submissionId, ...selected, command: command("submission:seal", selected, run.id), sealedAt: now,
  };
  return { root, control, catalog, runScope, store, input, receipt, sealInput, connect, adapter };
}

type Context = Awaited<ReturnType<typeof setup>>;
type AuthorityChange = "revoked credential" | "removed upload grant";

async function changeAuthority(context: Context, change: AuthorityChange): Promise<Principal> {
  const customer = { customerId: scope.customerId };
  const authority = await context.control.getAuthority(customer, principal);
  if (!authority) throw new Error("Expected bootstrapped authority");
  await context.control.updateAuthority({
    scope: customer, principal, authorization: await context.catalog.auth("credential:manage", customer),
    authority: {
      ...authority, credentialVersion: 2, permissionEpoch: 2,
      ...(change === "revoked credential" ? { revokedAt: now } : { grants: authority.grants.filter(grant => grant.action !== "run:upload") }),
    },
    expectedCredentialVersion: 1, expectedPermissionEpoch: 1,
  });
  if (change === "revoked credential") return principal;
  // Model fresh authentication after permission removal, rather than testing a stale epoch alone.
  const current = { ...principal, credential: { ...principal.credential, version: 2 }, permissionEpoch: 2 } as Principal;
  expect(await context.catalog.policy.evaluate(current, "run:upload", scope)).toMatchObject({ allowed: false, code: "FORBIDDEN" });
  return current;
}

describe("local successful submission replay authorization", () => {
  it.each<AuthorityChange>(["revoked credential", "removed upload grant"])("denies upload replay after %s without consuming retry bytes", async change => {
    const context = await setup();
    const current = await changeAuthority(context, change);
    const before = await context.control.getSubmission(context.runScope, submissionId);
    let consumed = false;
    async function* replacement() { consumed = true; yield Buffer.from("different retry bytes"); }
    await expect(context.store.writeFile({ ...context.input, principal: current, bytes: replacement() })).rejects.toMatchObject({
      code: change === "revoked credential" ? "CREDENTIAL_REVOKED" : "FORBIDDEN",
    });
    expect(consumed).toBe(false);
    expect(await context.control.getReceipt(context.runScope, submissionId, context.receipt.id)).toEqual(context.receipt);
    expect(await context.control.getSubmission(context.runScope, submissionId)).toEqual(before);
    expect((await context.control.getWorkspace(scope))?.currentRevisionId).toBe("revision-initial");
  });

  it.each<AuthorityChange>(["revoked credential", "removed upload grant"])("denies seal replay after %s while retaining the original seal", async change => {
    const context = await setup();
    const sealed = await context.store.seal(context.sealInput);
    const current = await changeAuthority(context, change);
    await expect(context.store.seal({ ...context.sealInput, principal: current })).rejects.toMatchObject({
      code: change === "revoked credential" ? "CREDENTIAL_REVOKED" : "FORBIDDEN",
    });
    expect(await context.control.getSubmission(context.runScope, submissionId)).toEqual(sealed);
    expect((await context.control.getWorkspace(scope))?.currentRevisionId).toBe("revision-initial");
  });

  it("reopens authorized same-key upload and seal results without consuming replacement bytes or advancing catalog versions", async () => {
    const context = await setup();
    const sealed = await context.store.seal(context.sealInput);
    context.control.database.close();
    const reopened = context.connect();
    const store = context.adapter(reopened);
    const authenticated = { ...principal, authenticatedAt: later };
    let consumed = false;
    async function* replacement() { consumed = true; yield Buffer.from("different retry bytes"); }
    expect(await store.writeFile({ ...context.input, principal: authenticated, bytes: replacement() })).toEqual(context.receipt);
    expect(consumed).toBe(false);
    expect(await store.seal({ ...context.sealInput, principal: authenticated })).toEqual(sealed);
    expect(await reopened.getSubmission(context.runScope, submissionId)).toEqual(sealed);
    expect(await consume(await store.openSealedFile(context.runScope, submissionId, context.receipt.path))).toEqual(binary);
    expect((await reopened.getWorkspace(scope))?.currentRevisionId).toBe("revision-initial");
  });
});
