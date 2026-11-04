import { afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceLifecycle, type LifecycleDependencies } from "../../src/application/runs";
import { SqliteControlStore, bootstrapAuthority } from "../../src/adapters/control/sqlite-control-store";
import { CatalogAccessPolicy } from "../../src/adapters/access/catalog-access-policy";
import { GitRevisionStore } from "../../src/adapters/revisions/git";
import { LocalSubmissionStore } from "../../src/adapters/submissions/local";
import { createTestDb } from "../../src/db";
import { canonicalRequestDigest, type CommandIdentity, type Manifest, type OperationKind, type Run, type RunScope, type StorageBinding, type WorkspaceScope } from "../../src/domain";
import type { RevisionStore, SubmissionStore } from "../../src/ports";
import { authority, now, principal } from "../control/helpers";
import { bytes, hash, source } from "../adapters/git/fixtures";

export { now, principal, bytes, hash, source };
const resources: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of resources.splice(0)) await close(); });

export async function setup(overrides: Partial<LifecycleDependencies> = {}) {
  const backend = process.env.CV_TEST_BACKEND ?? "git";
  if (backend !== "git" && backend !== "s3") throw new Error("Unsupported explicit application test backend");
  const root = await mkdtemp(join(await realpath(tmpdir()), "cv-lifecycle-"));
  const filename = join(root, "catalog.sqlite");
  const databases = [createTestDb(filename)];
  let control = new SqliteControlStore(databases[0]);
  bootstrapAuthority(databases[0], authority);
  const clock = { value: now };
  let store: RevisionStore;
  let submissions: SubmissionStore;
  let storeId: string;
  let closeStorage = async () => {};
  let reopenStorage: () => RevisionStore;
  let makeSubmissions: (catalog: SqliteControlStore) => SubmissionStore;
  if (backend === "s3") {
    const { setup: s3 } = await import("../adapters/s3/helpers");
    const { S3SubmissionStore } = await import("../../src/adapters/submissions/s3");
    const target = await s3();
    store = target.store; storeId = target.options.storeId; reopenStorage = target.reopen;
    makeSubmissions = catalog => new S3SubmissionStore({ ...target.options, control: catalog, now: () => clock.value });
    closeStorage = target.close;
  } else {
    const options = { rootDirectory: join(root, "revisions"), storeId: "git-lifecycle-test" };
    store = new GitRevisionStore(options); storeId = options.storeId;
    reopenStorage = () => new GitRevisionStore(options);
    makeSubmissions = catalog => new LocalSubmissionStore({ root: join(root, "submissions"), storeId: "local-lifecycle-test", control: catalog, now: () => clock.value });
  }
  submissions = makeSubmissions(control);
  const make = () => new WorkspaceLifecycle({
    control, accessPolicy: new CatalogAccessPolicy(control), submissions,
    revisionStore: async () => store,
    createBinding: async (scope, id, createdAt): Promise<StorageBinding> => ({ id, scope, backend, generation: 1, location: { storeId, opaqueKey: scope.workspaceId }, configurationRef: "test", status: "active", createdAt }),
    now: () => clock.value, newId: kind => `${kind}-${randomUUID()}`, ownerId: "lifecycle-test-worker", ...overrides,
  });
  let app = make();
  resources.push(async () => {
    for (const database of databases) if (database.open) database.close();
    await closeStorage(); await rm(root, { recursive: true, force: true });
  });
  const context = {
    root, backend, clock, get control() { return control; }, get store() { return store; }, get submissions() { return submissions; }, get app() { return app; },
    async create(key = randomUUID()) {
      const created = await app.createWorkspace({ principal, idempotencyKey: key, request: { customerId: "tenant-a", name: "Lifecycle" } });
      if (created.status !== "accepted") throw new Error("Fixture creation must finish before the dependent journey");
      return created;
    },
    async open(scope: WorkspaceScope, mode: Run["mode"] = "read-write", key = randomUUID()) {
      return (await app.openRun({ scope, principal, idempotencyKey: key, request: { mode, agentLabel: "existing-agent", task: "test task", reason: "test reason" } })).value;
    },
    async upload(run: Run, files: Record<string, Buffer>, directories: string[] = []) {
      const scope: RunScope = { ...run.scope, runId: run.id };
      const id = `submission-${randomUUID()}` as any;
      await submissions.begin({ scope, principal, submissionId: id, command: command("submission:create", {}, scope), expiresAt: "2026-11-03T13:00:00.000Z" });
      const snapshot = source(files, directories);
      const receipts = [];
      for (const entry of snapshot.manifest.entries) if (entry.kind === "file") {
        const receipt = await submissions.writeFile({ scope, principal, submissionId: id, receiptId: `receipt-${randomUUID()}` as any, path: entry.path, declaredByteLength: entry.byteLength, declaredSha256: entry.sha256, bytes: await snapshot.openFile(entry.path), command: command("submission:file", { submissionId: id, path: entry.path, declaredByteLength: entry.byteLength, declaredSha256: entry.sha256 }, scope) });
        receipts.push({ path: entry.path, receiptId: receipt.id });
      }
      return submissions.seal({ scope, principal, submissionId: id, manifest: snapshot.manifest, receipts, sealedAt: clock.value, command: command("submission:seal", { manifest: snapshot.manifest, receipts }, scope) });
    },
    async read(scope: WorkspaceScope, revisionId?: string) {
      const workspace = await control.getWorkspace(scope);
      const revision = await control.getRevision(scope, (revisionId ?? workspace!.currentRevisionId) as any);
      if (!revision) throw new Error("Expected accepted revision");
      const manifest = await store.readManifest({ ...revision, revisionId: revision.id });
      const files: Record<string, Buffer> = {};
      for (const entry of manifest.entries) if (entry.kind === "file") files[entry.path] = await bytes(await store.openFile({ ...revision, revisionId: revision.id }, entry.path));
      return { workspace, revision, manifest, files };
    },
    async reopen() {
      control.database.close(); databases.push(createTestDb(filename));
      control = new SqliteControlStore(databases.at(-1)!); store = reopenStorage(); submissions = makeSubmissions(control); app = make();
    },
    peer(ownerId: string) {
      const database = createTestDb(filename); databases.push(database);
      const peerControl = new SqliteControlStore(database);
      return new WorkspaceLifecycle({ ...app.runtime.dependencies, control: peerControl, accessPolicy: new CatalogAccessPolicy(peerControl), submissions: makeSubmissions(peerControl), revisionStore: async () => reopenStorage(), ownerId });
    },
  };
  return context;
}

export function command<Kind extends OperationKind>(kind: Kind, payload: unknown, scope: RunScope, key = randomUUID()): CommandIdentity<Kind> {
  return { idempotencyScope: { customerId: scope.customerId, workspaceId: scope.workspaceId, runId: scope.runId, actorId: principal.actorId, kind }, idempotencyKey: key,
    operationId: `operation-${randomUUID()}` as any, requestedAt: now,
    requestDigest: canonicalRequestDigest({ schemaVersion: 1, customerId: scope.customerId, actorId: principal.actorId, credentialId: principal.credential.id, kind, resource: { workspaceId: scope.workspaceId, runId: scope.runId }, payload }) };
}
export const scopeOf = (workspace: { customerId: string; id: string }): WorkspaceScope => ({ customerId: workspace.customerId, workspaceId: workspace.id }) as WorkspaceScope;
export const finalInput = (run: Run, submissionId?: string, key = randomUUID()) => ({ scope: { ...run.scope, runId: run.id }, principal, idempotencyKey: key, request: { expectedRunVersion: run.version, ...(submissionId ? { submissionId } : {}) } });
