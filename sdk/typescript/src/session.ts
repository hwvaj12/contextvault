import { mkdir, mkdtemp, lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { NetworkError, OutcomeUnknownError, RunExpiredError, localError, mapResponseToError } from "./errors";
import { canonicalizeManifest, manifestDigest, type ManifestFile } from "./manifest";
import { capture, captureManifestsPath, captureOwnersPath, createDirectory, inside, ownedCaptures, prepareCaptureManifest, privateJsonBytes, readCaptureManifest, readJson, readVerified, removeOwnedTree, safeDirectory, saveJson, syncDirectory, writeVerified, type CapturedWorkspace, type CaptureManifestReference } from "./files";
import { Operations, Runs, WorkspaceTransport, enc, type OpenRunRequest, type OperationView, type RunView, type SubmissionView, type UploadReceipt, type WorkspaceView } from "./resources";

export interface StoppedWriters { writersStopped: true }
export interface OpenWorkspaceOptions extends OpenRunRequest {
  workspaceId?: string;
  create?: { customerId: string; name: string };
  /** New private directory owned by this session. Defaults to a fresh directory under the system temp directory. */
  stateDirectory?: string;
}
export interface PendingCommand {
  kind: "workspace:create" | "run:open" | "submission:create" | "submission:file" | "submission:seal" | "run:heartbeat" | "finalize" | "abort";
  idempotencyKey: string;
  request: { method: "POST"; path: string; body: unknown } | { method: "PUT"; path: string; capture: { captureId: string; privateFilePath: string; byteLength: number; sha256: string } };
  phase: "prepared" | "dispatched" | "outcome-unknown"; operationId: string | null; preparedAt: string;
  mode?: "read-only" | "read-write"; selectedSubmission?: { submissionId: string; manifestDigest: string } | null;
}
export interface LocalSessionState {
  schemaVersion: 1; sessionId: string; serverOrigin: string; workspaceId: string | null;
  run: Pick<RunView, "id" | "workspaceId" | "baseRevisionId" | "version" | "mode"> | null;
  path: string; privateStatePath: string; state: "provisioning" | "ready" | "failed"; pendingCommand: PendingCommand | null;
  runView: RunView | null; openRequest: OpenRunRequest; createRequest: { customerId: string; name: string } | null;
  sessionStatus: "opening" | "ready" | "submitting" | "finalized" | "aborted" | "conflicted" | "expired" | "failed" | "published-needs-reopen" | "refreshing";
  workflow: "creating" | "opening" | "idle" | "submit" | "finalize" | "checkpoint";
  capture: CapturedWorkspace | null; retainedCaptures: Pick<CapturedWorkspace, "captureId" | "path">[]; submission: SubmissionView | null; receipts: UploadReceipt[];
  lastOperation: OperationView | null;
  checkpointReceipt: CheckpointReceipt | null;
  cleanup: { state: "pending" | "complete" | "failed"; attempts: number; lastError: string | null };
}
export interface CheckpointReceipt { operation: OperationView; runId: string; parentRevisionId: string }
interface ReceiptSelection { entry: number; id: string; completedAt: string }
interface StoredCapture { captureId: string; path: string; manifestRef: CaptureManifestReference }
type StoredSessionState = Omit<LocalSessionState, "capture" | "receipts"> & {
  capture: StoredCapture | CapturedWorkspace | null;
  receiptSelections?: ReceiptSelection[];
  /** Readable earlier journals may contain full receipts; every new write uses compact selections. */
  receipts?: UploadReceipt[];
};
const stopped = (options?: StoppedWriters): void => { if (options?.writersStopped !== true) throw localError("INVALID_REQUEST", "Stop agent writers and pass writersStopped: true before capture, checkpoint, finalize, reconciliation or cleanup"); };
const exposeRecovery = (error: unknown, privateStatePath: string): unknown => {
  if (error instanceof Error && Object.isExtensible(error) && !(error as { privateStatePath?: string }).privateStatePath) {
    Object.defineProperty(error, "privateStatePath", { value: privateStatePath, enumerable: true, configurable: true });
  }
  return error;
};

/** Durable session control is separate from ordinary agent file access. Use one controller per private state file. */
export class LocalWorkspaceSession {
  private busy = false;
  private manifestReference: { capture: CapturedWorkspace; reference: CaptureManifestReference } | null = null;
  private constructor(private readonly http: WorkspaceTransport, private readonly data: LocalSessionState) {}
  get sessionId() { return this.data.sessionId; }
  get workspaceId(): string { if (!this.data.workspaceId) throw localError("INVALID_TRANSITION", "Workspace identity is still pending"); return this.data.workspaceId; }
  get path() { return this.data.path; }
  get sandboxPath() { return this.path; }
  get privateStatePath() { return this.data.privateStatePath; }
  get run(): RunView { if (!this.data.runView) throw localError("INVALID_TRANSITION", "Run identity is still pending"); return JSON.parse(JSON.stringify(this.data.runView)) as RunView; }
  get baseCommit() { return this.run.baseRevisionId; }
  get sessionStatus() { return this.data.sessionStatus; }
  get materializationState() { return this.data.state; }
  get cleanupState() { return this.data.cleanup.state; }
  get outcome() { return this.data.runView?.outcome ? { ...this.data.runView.outcome } : null; }
  /** Publication identity remains separate from the next run's potentially newer pinned base. */
  get checkpointReceipt(): CheckpointReceipt | null { return this.data.checkpointReceipt ? JSON.parse(JSON.stringify(this.data.checkpointReceipt)) as CheckpointReceipt : null; }
  /** Legacy aliases retain the separate v1 outcome. */
  get statusAlias() { return this.cleanupState === "complete" ? "cleaned_up" : this.data.sessionStatus === "finalized" ? "merged" : this.data.sessionStatus; }

  static async open(http: WorkspaceTransport, options: OpenWorkspaceOptions, createOnly = false): Promise<LocalWorkspaceSession> {
    if ((Boolean(options.workspaceId) === Boolean(options.create))) throw localError("INVALID_REQUEST", "Provide exactly one workspaceId or create request");
    const openRequest = { mode: options.mode, agentLabel: options.agentLabel, task: options.task, reason: options.reason };
    if (!["read-only", "read-write"].includes(openRequest.mode) || [openRequest.agentLabel, openRequest.task, openRequest.reason].some(v => typeof v !== "string" || !v.trim())) throw localError("INVALID_REQUEST", "Provide a mode, agentLabel, task and reason");
    let directory: string;
    if (options.stateDirectory) {
      if (!isAbsolute(options.stateDirectory)) throw localError("INVALID_REQUEST", "stateDirectory must be absolute and new");
      directory = resolve(options.stateDirectory); await safeDirectory(dirname(directory)); await mkdir(directory, { mode: 0o700 });
    } else directory = await mkdtemp(join(await realpath(tmpdir()), "contextvault-session-"));
    await syncDirectory(dirname(directory));
    const sessionId = randomUUID();
    // A separate ownership marker prevents a modified state path from redirecting cleanup elsewhere.
    await saveJson(join(directory, "owner.json"), { sessionId });
    const data: LocalSessionState = {
      schemaVersion: 1, sessionId, serverOrigin: http.baseUrl, workspaceId: options.workspaceId ?? null,
      run: null, path: join(directory, "workspace"), privateStatePath: join(directory, "state.json"), state: "provisioning", pendingCommand: null,
      runView: null, openRequest, createRequest: options.create ? { customerId: options.create.customerId, name: options.create.name } : null,
      sessionStatus: "opening", workflow: createOnly ? "creating" : "opening", capture: null, retainedCaptures: [], submission: null, receipts: [], lastOperation: null, checkpointReceipt: null,
      cleanup: { state: "pending", attempts: 0, lastError: null },
    };
    const session = new LocalWorkspaceSession(http, data);
    try {
      await session.save();
      if (createOnly) await session.creating(); else await session.opening();
      return session;
    } catch (error) { throw exposeRecovery(error, session.privateStatePath); }
  }
  static async createWorkspace(http: WorkspaceTransport, request: { customerId: string; name: string; stateDirectory?: string }): Promise<WorkspaceView & { privateStatePath: string }> {
    const session = await LocalWorkspaceSession.open(http, { create: { customerId: request.customerId, name: request.name },
      stateDirectory: request.stateDirectory, mode: "read-only", agentLabel: "sdk", task: "create workspace", reason: "workspace creation" }, true);
    try {
      const workspace = await http.json<WorkspaceView>("GET", `/v1/workspaces/${enc(session.workspaceId)}`);
      return { ...workspace, privateStatePath: session.privateStatePath };
    } catch (error) { throw exposeRecovery(error, session.privateStatePath); }
  }
  static async resume(http: WorkspaceTransport, privateStatePath: string): Promise<LocalWorkspaceSession> {
    if (!isAbsolute(privateStatePath) || resolve(privateStatePath) !== privateStatePath) throw localError("INVALID_REQUEST", "Use an absolute private state file path");
    const stored = await readJson(privateStatePath) as StoredSessionState;
    const data = { ...stored, capture: null, receipts: [], retainedCaptures: [] } as LocalSessionState;
    if (!data || data.schemaVersion !== 1 || typeof data.sessionId !== "string" || data.serverOrigin !== http.baseUrl || data.privateStatePath !== privateStatePath || data.path !== join(dirname(privateStatePath), "workspace")) throw localError("INVALID_REQUEST", "Private state identity or origin does not match this client");
    const directory = await lstat(dirname(privateStatePath));
    if ((directory.mode & 0o077) !== 0) throw localError("INVALID_REQUEST", "Session directory must be private to its owner");
    const owner = await readJson(join(dirname(privateStatePath), "owner.json")) as { sessionId: string };
    if (owner.sessionId !== data.sessionId) throw localError("INVALID_REQUEST", "Session ownership marker differs from private state");
    if (data.run && (data.run.workspaceId !== data.workspaceId || data.runView?.id !== data.run.id)) throw localError("INVALID_REQUEST", "Persisted run identity differs from its workspace");
    if (!data.openRequest || !["read-only", "read-write"].includes(data.openRequest.mode) || !data.cleanup || !["creating", "opening", "idle", "submit", "finalize", "checkpoint"].includes(data.workflow)) throw localError("INVALID_REQUEST", "Private state is incomplete");
    if (!Array.isArray(stored.retainedCaptures)) throw localError("INVALID_REQUEST", "Private state has no capture retention record");
    for (const retained of [...stored.retainedCaptures, ...(stored.capture ? [stored.capture] : [])]) {
      const parent = join(dirname(privateStatePath), "captures");
      if (dirname(retained.path) !== parent || !retained.path.startsWith(join(parent, "capture-"))) throw localError("INVALID_REQUEST", "Capture is outside this session's owned directory");
    }
    let reference: CaptureManifestReference | null = null;
    if (stored.capture) {
      const saved = stored.capture;
      reference = "manifestRef" in saved ? saved.manifestRef : null;
      const manifest = reference ? await readCaptureManifest(join(dirname(privateStatePath), "captures"), saved.captureId, reference, http.limits)
        : canonicalizeManifest((saved as CapturedWorkspace).manifest, http.limits);
      data.capture = { captureId: saved.captureId, path: saved.path, manifest };
    }
    data.receipts = stored.receiptSelections ? restoreReceipts(data, stored.receiptSelections) : stored.receipts ?? [];
    // Historical capture ownership lives in the separately durable registry, rather than duplicated manifests in this journal.
    const session = new LocalWorkspaceSession(http, data);
    if (data.capture && reference) session.manifestReference = { capture: data.capture, reference };
    session.validatePending(); return session;
  }
  private async save() {
    const { capture: captured, receipts, retainedCaptures: _retained, ...small } = this.data;
    const parent = join(dirname(this.privateStatePath), "captures");
    const prepared = captured && this.manifestReference?.capture !== captured ? prepareCaptureManifest(parent, captured, this.http.limits) : null;
    const reference = prepared?.reference ?? this.manifestReference?.reference;
    const stored: StoredSessionState = { ...small, capture: captured ? { captureId: captured.captureId, path: captured.path, manifestRef: reference! } : null,
      retainedCaptures: [], receiptSelections: selectReceipts(this.data, receipts) };
    // Reject overflow before replacing the last readable journal or writing a new metadata reference.
    privateJsonBytes(stored);
    if (prepared && captured) { await prepared.persist(); this.manifestReference = { capture: captured, reference: prepared.reference }; }
    await saveJson(this.privateStatePath, stored);
  }
  private setRun(run: RunView) {
    this.data.runView = run;
    this.data.run = { id: run.id, workspaceId: run.workspaceId, baseRevisionId: run.baseRevisionId, version: run.version, mode: run.mode };
  }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw localError("INVALID_TRANSITION", "A session command is already running");
    this.busy = true; try { return await work(); } finally { this.busy = false; }
  }
  private assertOpen() {
    if (this.data.cleanup.state === "complete") throw localError("INVALID_TRANSITION", "This session was cleaned; open a new session before starting work");
  }
  private beginWorkflow(workflow: "submit" | "finalize" | "checkpoint") {
    this.assertOpen();
    if ((this.data.workflow !== "idle" && this.data.workflow !== workflow) || (this.data.workflow === "idle" && this.data.pendingCommand)) {
      throw localError("INVALID_TRANSITION", "Reconcile the existing session workflow before starting another workflow");
    }
    this.data.workflow = workflow;
  }
  private async prepare(kind: PendingCommand["kind"], path: string, body: unknown) {
    this.assertOpen();
    if (this.data.pendingCommand) throw localError("INVALID_TRANSITION", "Reconcile the persisted command before starting another command");
    const pending: PendingCommand = { kind, idempotencyKey: randomUUID(), request: { method: "POST", path, body }, phase: "prepared", operationId: null, preparedAt: new Date().toISOString() };
    if (kind === "finalize") { pending.mode = this.run.mode; pending.selectedSubmission = this.run.mode === "read-only" ? null : { submissionId: this.data.submission!.id, manifestDigest: this.data.submission!.manifestDigest! }; }
    this.data.pendingCommand = pending; await this.save();
  }
  private validatePending() {
    const pending = this.data.pendingCommand; if (!pending) return;
    const run = this.data.run; const workspace = this.data.workspaceId; const submission = this.data.submission;
    const prefix = run ? `/v1/runs/${enc(run.id)}` : "";
    const expected: Partial<Record<PendingCommand["kind"], string>> = {
      "workspace:create": "/v1/workspaces", "run:open": workspace ? `/v1/workspaces/${enc(workspace)}/runs` : "",
      "submission:create": prefix + "/submissions", "submission:seal": prefix + `/submissions/${enc(submission?.id ?? "")}/seal`,
      "run:heartbeat": prefix + "/heartbeat", finalize: prefix + "/finalize", abort: prefix + "/abort",
    };
    if (typeof pending.idempotencyKey !== "string" || !pending.idempotencyKey || !["prepared", "dispatched", "outcome-unknown"].includes(pending.phase)) throw localError("INVALID_REQUEST", "Invalid persisted command identity");
    if (pending.kind === "submission:file") {
      if (pending.request.method !== "PUT" || !this.data.capture || !run || !submission) throw localError("INVALID_REQUEST", "Upload command has no persisted immutable capture");
      const request = pending.request;
      const entry = this.data.capture.manifest.entries.find((e): e is ManifestFile => e.kind === "file" && inside(this.data.capture!.path, e.path) === request.capture.privateFilePath);
      if (!entry || request.capture.captureId !== this.data.capture.captureId || request.capture.byteLength !== entry.byteLength || request.capture.sha256 !== entry.sha256 || request.path !== `${prefix}/submissions/${enc(submission.id)}/files?path=${enc(entry.path)}`) throw localError("INVALID_REQUEST", "Upload command differs from its immutable capture");
    } else if (pending.request.method !== "POST" || pending.request.path !== expected[pending.kind]) throw localError("INVALID_REQUEST", "Persisted command route differs from session identity");
  }
  private unknown(message: string): OutcomeUnknownError {
    return new OutcomeUnknownError(message, { privateStatePath: this.privateStatePath, idempotencyKey: this.data.pendingCommand?.idempotencyKey, operationId: this.data.pendingCommand?.operationId ?? undefined });
  }
  private async dispatch() {
    const pending = this.data.pendingCommand; if (!pending) return;
    const firstAttempt = pending.phase === "prepared" && pending.operationId === null;
    this.validatePending(); if (pending.phase === "prepared") pending.phase = "dispatched"; await this.save();
    try {
      let result: unknown;
      if (pending.operationId && (pending.kind === "finalize" || pending.kind === "workspace:create")) result = await new Operations(this.http).wait(pending.operationId);
      else if (pending.request.method === "PUT") {
        const capture = this.data.capture!; const request = pending.request;
        const entry = capture.manifest.entries.find((e): e is ManifestFile => e.kind === "file" && inside(capture.path, e.path) === request.capture.privateFilePath)!;
        result = await this.http.upload(this.run.id, this.data.submission!.id, entry, readVerified(capture.path, entry, this.http.limits), pending.idempotencyKey);
      } else result = await this.http.json(pending.request.method, pending.request.path, pending.request.body, pending.idempotencyKey);
      if (pending.kind === "workspace:create" && "kind" in (result as object)) {
        const operation = result as OperationView; pending.operationId = operation.id; await this.save();
        const complete = await new Operations(this.http).wait(operation.id);
        if (complete.state === "failed") throw mapResponseToError(409, { error: complete.error });
        this.data.workspaceId = complete.result!.workspaceId!;
      } else if (pending.kind === "workspace:create") this.data.workspaceId = (result as WorkspaceView).id;
      else if (pending.kind === "run:open") { this.setRun(result as RunView); this.data.state = "provisioning"; this.data.sessionStatus = this.data.workflow === "checkpoint" ? "refreshing" : "opening"; this.data.capture = null; this.manifestReference = null; this.data.submission = null; this.data.receipts = []; this.data.lastOperation = null; }
      else if (pending.kind === "submission:create" || pending.kind === "submission:seal") this.data.submission = result as SubmissionView;
      else if (pending.kind === "submission:file") this.data.receipts.push(result as UploadReceipt);
      else if (pending.kind === "run:heartbeat") this.setRun(result as RunView);
      else if (pending.kind === "abort") { this.setRun(result as RunView); this.data.sessionStatus = "aborted"; this.data.workflow = "idle"; }
      else if (pending.kind === "finalize") {
        const operation = result as OperationView; pending.operationId = operation.id; await this.save();
        const complete = await new Operations(this.http).wait(operation.id);
        this.data.lastOperation = complete;
        if (complete.state === "failed" || complete.result?.runState !== "finalized") {
          const code = complete.error?.code ?? "INVALID_TRANSITION";
          this.data.sessionStatus = code === "REVISION_CONFLICT" ? "conflicted" : code === "RUN_EXPIRED" ? "expired" : "failed";
          this.data.runView!.state = this.data.sessionStatus; this.data.pendingCommand = null; this.data.workflow = "idle"; await this.save();
          throw mapResponseToError(409, { error: complete.error ?? { code, message: "Finalization did not publish" } });
        }
        this.data.runView!.state = "finalized";
        this.data.runView!.operationId = complete.id;
        this.data.runView!.outcome = { state: "finalized", revisionId: complete.result.revisionId ?? null, changed: complete.result.changed ?? false, completedAt: complete.updatedAt };
        if (this.data.workflow === "checkpoint") this.data.checkpointReceipt = { operation: complete, runId: this.run.id, parentRevisionId: this.run.baseRevisionId };
        this.data.sessionStatus = this.data.workflow === "checkpoint" ? "published-needs-reopen" : "finalized";
      }
      this.data.pendingCommand = null; await this.save();
    } catch (error) {
      // An auth failure during retry cannot disprove an earlier accepted command.
      if (this.data.pendingCommand && (error instanceof NetworkError || error instanceof OutcomeUnknownError)) {
        if (error instanceof OutcomeUnknownError && error.operationId) this.data.pendingCommand.operationId = error.operationId;
        this.data.pendingCommand.phase = "outcome-unknown"; await this.save(); throw this.unknown("HTTP outcome is unknown; reconcile the original saved command");
      }
      // A definite first HTTP rejection cannot have an earlier accepted attempt for this saved command.
      // Retain every retry or known operation, including authorization denial after an uncertain response.
      if (this.data.pendingCommand && firstAttempt && this.data.pendingCommand.operationId === null && this.http.isHttpClientRejection(error)) {
        this.data.pendingCommand = null; await this.save();
      }
      throw error;
    }
  }
  private async hydrate() {
    this.data.state = "provisioning"; await this.save();
    try {
      const manifest = await new Runs(this.http).manifest(this.run.id);
      try { await lstat(this.path); await removeOwnedTree(this.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await createDirectory(this.path);
      for (const entry of manifest.entries) {
        if (entry.kind === "directory") await createDirectory(inside(this.path, entry.path));
        else await writeVerified(this.path, entry, this.http.download(this.run.id, entry), this.http.limits);
      }
      await syncDirectory(this.path); this.data.state = "ready"; this.data.sessionStatus = "ready"; this.data.workflow = "idle"; await this.save();
    } catch (error) { this.data.state = "failed"; await this.save(); throw error; }
  }
  private async opening() {
    if (this.data.pendingCommand) await this.dispatch();
    if (!this.data.workspaceId) { await this.prepare("workspace:create", "/v1/workspaces", this.data.createRequest); await this.dispatch(); }
    if (!this.data.run) { await this.prepare("run:open", `/v1/workspaces/${enc(this.workspaceId)}/runs`, this.data.openRequest); await this.dispatch(); }
    if (this.data.state !== "ready") await this.hydrate();
  }
  private async creating() {
    if (this.data.pendingCommand) await this.dispatch();
    if (!this.data.workspaceId) { await this.prepare("workspace:create", "/v1/workspaces", this.data.createRequest); await this.dispatch(); }
    await this.save();
  }
  private async captureOnce() {
    this.assertOpen();
    if (this.run.mode === "read-only") throw localError("INVALID_TRANSITION", "Read-only runs cannot capture a submission");
    if (this.data.capture) return this.data.capture;
    if (this.data.pendingCommand || this.run.state !== "active" || this.data.state !== "ready") throw localError("INVALID_TRANSITION", "Capture requires a ready active run without a pending command");
    this.data.capture = await capture(this.path, join(dirname(this.privateStatePath), "captures"), this.http.limits, this.sessionId); await this.save(); return this.data.capture;
  }
  capture(options: StoppedWriters): Promise<CapturedWorkspace> { return this.exclusive(async () => { stopped(options); return JSON.parse(JSON.stringify(await this.captureOnce())) as CapturedWorkspace; }); }
  private async seal() {
    if (this.data.pendingCommand) await this.dispatch();
    const captured = await this.captureOnce();
    if (!this.data.submission) { await this.prepare("submission:create", `/v1/runs/${enc(this.run.id)}/submissions`, {}); await this.dispatch(); }
    if (this.data.submission!.state === "sealed") {
      if (this.data.submission!.manifestDigest !== manifestDigest(captured.manifest, this.http.limits)) throw localError("RECEIPT_MISMATCH", "Sealed submission differs from the immutable capture");
      return this.data.submission!;
    }
    for (const entry of captured.manifest.entries) {
      if (entry.kind !== "file" || this.data.receipts.some(receipt => receipt.path === entry.path)) continue;
      this.data.pendingCommand = {
        kind: "submission:file", idempotencyKey: randomUUID(), phase: "prepared", operationId: null, preparedAt: new Date().toISOString(),
        request: { method: "PUT", path: `/v1/runs/${enc(this.run.id)}/submissions/${enc(this.data.submission!.id)}/files?path=${enc(entry.path)}`,
          capture: { captureId: captured.captureId, privateFilePath: inside(captured.path, entry.path), byteLength: entry.byteLength, sha256: entry.sha256 } },
      };
      await this.save(); await this.dispatch();
    }
    await this.prepare("submission:seal", `/v1/runs/${enc(this.run.id)}/submissions/${enc(this.data.submission!.id)}/seal`, {
      manifest: captured.manifest, receipts: this.data.receipts.map(receipt => ({ path: receipt.path, receiptId: receipt.id })),
    });
    await this.dispatch();
    if (this.data.submission!.manifestDigest !== manifestDigest(captured.manifest, this.http.limits)) throw localError("RECEIPT_MISMATCH", "Sealed submission differs from the immutable capture");
    return this.data.submission!;
  }
  submit(options: StoppedWriters): Promise<SubmissionView> { return this.exclusive(async () => { stopped(options); this.beginWorkflow("submit"); this.data.sessionStatus = "submitting"; await this.save(); const result = await this.seal(); this.data.workflow = "idle"; await this.save(); return result; }); }
  private async finish() {
    if (this.data.pendingCommand) await this.dispatch();
    if (this.data.sessionStatus === "finalized" || this.data.sessionStatus === "published-needs-reopen") return this.data.lastOperation!;
    if (this.data.lastOperation?.state === "failed") throw mapResponseToError(409, { error: this.data.lastOperation.error });
    // Expiry may already be durable; later mutation routes then report INVALID_TRANSITION.
    // Read the scoped run before creating a new command, without replacing any pending command.
    const current = await new Runs(this.http).get(this.run.id); this.setRun(current);
    if (current.state === "expired") { this.data.sessionStatus = "expired"; await this.save(); throw new RunExpiredError(); }
    if (this.run.mode === "read-write") await this.seal();
    await this.prepare("finalize", `/v1/runs/${enc(this.run.id)}/finalize`, { expectedRunVersion: this.run.version, ...(this.run.mode === "read-write" ? { submissionId: this.data.submission!.id } : {}) });
    await this.dispatch(); return this.data.lastOperation!;
  }
  finalize(options: StoppedWriters): Promise<OperationView> {
    return this.exclusive(async () => {
      stopped(options);
      this.beginWorkflow("finalize"); await this.save(); const result = await this.finish(); this.data.workflow = "idle"; await this.save(); return result;
    });
  }
  private async reopen() {
    if (this.data.pendingCommand) await this.dispatch();
    if (this.data.sessionStatus === "finalized") {
      this.data.checkpointReceipt = { operation: this.data.lastOperation!, runId: this.run.id, parentRevisionId: this.run.baseRevisionId };
      this.data.sessionStatus = "published-needs-reopen"; await this.save();
    }
    if (this.data.sessionStatus === "published-needs-reopen") {
      await this.prepare("run:open", `/v1/workspaces/${enc(this.workspaceId)}/runs`, this.data.openRequest); await this.dispatch();
    }
    if (this.data.state !== "ready" || this.data.sessionStatus === "refreshing") await this.hydrate();
  }
  checkpoint(options: StoppedWriters): Promise<LocalWorkspaceSession> {
    return this.exclusive(async () => {
      stopped(options);
      if (this.run.mode !== "read-write") throw localError("INVALID_TRANSITION", "Checkpoint requires a read-write run");
      this.beginWorkflow("checkpoint"); await this.save();
      if (this.data.sessionStatus !== "published-needs-reopen" && this.data.sessionStatus !== "refreshing" && this.data.pendingCommand?.kind !== "run:open") await this.finish();
      await this.reopen(); return this;
    });
  }
  reconcile(options: StoppedWriters): Promise<LocalWorkspaceSession> {
    return this.exclusive(async () => {
      stopped(options);
      if (this.data.cleanup.state === "complete") return this;
      if (this.data.workflow === "creating") await this.creating();
      else if (this.data.workflow === "opening") await this.opening();
      else if (this.data.workflow === "checkpoint") {
        if (this.data.sessionStatus !== "published-needs-reopen" && this.data.sessionStatus !== "refreshing" && this.data.pendingCommand?.kind !== "run:open") await this.finish();
        await this.reopen();
      } else if (this.data.workflow === "finalize") { await this.finish(); this.data.workflow = "idle"; await this.save(); }
      else if (this.data.workflow === "submit") { await this.seal(); this.data.workflow = "idle"; await this.save(); }
      else if (this.data.pendingCommand) await this.dispatch();
      else if (this.data.state !== "ready" && this.data.runView?.state === "active") await this.hydrate();
      return this;
    });
  }
  heartbeat(): Promise<RunView> {
    return this.exclusive(async () => {
      if (this.data.pendingCommand) throw localError("INVALID_TRANSITION", "Reconcile the pending command before heartbeat");
      await this.prepare("run:heartbeat", `/v1/runs/${enc(this.run.id)}/heartbeat`, { expectedLeaseVersion: this.run.leaseVersion }); await this.dispatch(); return this.run;
    });
  }
  status(): Promise<RunView> { return this.exclusive(async () => { const run = await new Runs(this.http).get(this.run.id); this.setRun(run); await this.save(); return run; }); }
  abort(options: StoppedWriters & { reason: string }): Promise<RunView> {
    return this.exclusive(async () => {
      stopped(options);
      this.assertOpen();
      const run = this.run;
      // A workflow name alone does not mean publication started. Every dispatched command has a pending record.
      // A known active run with no pending command can be explicitly abandoned, including local capture or refresh failure.
      if (this.data.pendingCommand || run.state !== "active") throw localError("INVALID_TRANSITION", "Abort requires a known active run without pending commands");
      // Persist the explicit abort intent with its command, so a lost abort response cannot resume hydration instead.
      this.data.workflow = "idle";
      await this.prepare("abort", `/v1/runs/${enc(run.id)}/abort`, { expectedRunVersion: run.version, reason: options.reason }); await this.dispatch(); return this.run;
    });
  }
  cleanup(options: StoppedWriters): Promise<void> {
    return this.exclusive(async () => {
      stopped(options);
      if (this.data.cleanup.state === "complete") return;
      const terminal = (["finalized", "aborted", "conflicted", "expired", "failed"] as const).find(state => state === this.run.state);
      if (this.data.pendingCommand || !terminal) throw localError("INVALID_TRANSITION", "Cleanup requires a known terminal run and no uncertain command");
      // A rejected next-run request does not undo the accepted checkpoint. Explicit cleanup abandons only local continuation.
      this.data.workflow = "idle"; this.data.sessionStatus = terminal;
      this.data.cleanup.attempts++; await this.save();
      try {
        const captures = await ownedCaptures(join(dirname(this.privateStatePath), "captures"), this.sessionId);
        // No publication remains uncertain. Clear live metadata references durably before deleting their targets.
        // A crash during cleanup can then resume from ownership records without reading already-deleted manifests.
        this.data.retainedCaptures = []; this.data.capture = null; this.data.receipts = []; this.manifestReference = null; await this.save();
        try { await removeOwnedTree(this.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        for (const retained of captures) {
          try { await removeOwnedTree(retained); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        try { await removeOwnedTree(captureManifestsPath(join(dirname(this.privateStatePath), "captures"))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        try { await removeOwnedTree(captureOwnersPath(join(dirname(this.privateStatePath), "captures"))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        this.data.retainedCaptures = []; this.data.capture = null;
        this.data.cleanup.state = "complete"; this.data.cleanup.lastError = null; await this.save();
      } catch (error) { this.data.cleanup.state = "failed"; this.data.cleanup.lastError = (error as Error).message; await this.save(); throw error; }
    });
  }
}

function selectReceipts(data: LocalSessionState, receipts: UploadReceipt[]): ReceiptSelection[] {
  if (!receipts.length) return [];
  if (!data.capture || !data.run || !data.submission) throw localError("INVALID_REQUEST", "Receipt metadata has no immutable capture or submission");
  const paths = new Map(data.capture.manifest.entries.map((entry, index) => [entry.path, index]));
  const seen = new Set<number>();
  return receipts.map(receipt => {
    const index = paths.get(receipt.path); const entry = index === undefined ? undefined : data.capture!.manifest.entries[index];
    if (index === undefined || !entry || entry.kind !== "file" || seen.has(index) || receipt.runId !== data.run!.id || receipt.submissionId !== data.submission!.id
      || receipt.sha256 !== entry.sha256 || receipt.byteLength !== entry.byteLength || typeof receipt.id !== "string" || !receipt.id || typeof receipt.completedAt !== "string") {
      throw localError("INVALID_REQUEST", "Receipt metadata differs from the immutable capture");
    }
    seen.add(index); return { entry: index, id: receipt.id, completedAt: receipt.completedAt };
  });
}
function restoreReceipts(data: LocalSessionState, selections: ReceiptSelection[]): UploadReceipt[] {
  if (!Array.isArray(selections)) throw localError("INVALID_REQUEST", "Invalid compact receipt metadata");
  if (!selections.length) return [];
  if (!data.capture || !data.run || !data.submission) throw localError("INVALID_REQUEST", "Compact receipts have no immutable capture or submission");
  const result = selections.map(selection => {
    const entry = Number.isSafeInteger(selection.entry) && selection.entry >= 0 ? data.capture!.manifest.entries[selection.entry] : undefined;
    if (!entry || entry.kind !== "file") throw localError("INVALID_REQUEST", "Compact receipt does not select a captured file");
    return { id: selection.id, runId: data.run!.id, submissionId: data.submission!.id, path: entry.path, byteLength: entry.byteLength, sha256: entry.sha256, completedAt: selection.completedAt };
  });
  selectReceipts(data, result); return result;
}
