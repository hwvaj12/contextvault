import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, readdir, unlink, lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { WorkspaceError } from "../../../domain/errors";
import { canonicalJson } from "../../../domain/idempotency";
import { canonicalizeManifest, manifestDigest, validatePortablePath, workspaceLimits, type FileEntry, type WorkspaceLimits } from "../../../domain/manifest";
import type { CommandIdentity, Operation, PrivateLocator, RunScope, Submission, SubmissionCollectionPermit, SubmissionId, Timestamp, UploadReceipt } from "../../../domain/model";
import type { ControlStore } from "../../../ports/control-store";
import type { BeginSubmissionInput, SealSubmissionInput, SubmissionStore, WriteSubmissionFileInput } from "../../../ports/submission-store";
import type { ByteStream, StreamOptions } from "../../../ports/streams";
import { assertSafeDirectory, checkAbort, createSafeDirectory, openRegularFile, persistByteStream, readVerifiedFile, removeWorkspace, StreamLimiter, syncDirectory } from "../../../application/files";
import { receiptMatches, sameRunScope, validateReceiptSelection } from "../../../application/submissions";

export interface LocalSubmissionStoreOptions {
  /** Trusted server configuration. The HTTP request cannot select this path. */
  root: string;
  control: ControlStore;
  storeId?: string;
  limits?: Partial<WorkspaceLimits>;
  now?: () => Timestamp;
}
interface DurableAttempt { schemaVersion: 1; requestDigest: string; fingerprint: string; receipt: UploadReceipt }
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const exists = (error: unknown) => ["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "");

/** Local immutable staging with catalog-owned coordination and lifecycle decisions. */
export class LocalSubmissionStore implements SubmissionStore {
  private readonly root: string;
  private readonly control: ControlStore;
  private readonly limits: WorkspaceLimits;
  private readonly limiter: StreamLimiter;
  private readonly now: () => Timestamp;
  private readonly storeId: string;
  private ready: Promise<void> | undefined;
  constructor(options: LocalSubmissionStoreOptions) {
    if (!isAbsolute(options.root)) throw new WorkspaceError("INVALID_REQUEST", "Submission root must be absolute");
    this.root = resolve(options.root); this.control = options.control;
    this.limits = workspaceLimits(options.limits); this.limiter = new StreamLimiter(this.limits.maxConcurrentStreams);
    this.now = options.now ?? (() => new Date().toISOString());
    this.storeId = options.storeId ?? `local-submissions-${hash(this.root)}`;
  }

  private async initialize(): Promise<void> {
    if (!this.ready) this.ready = (async () => {
      await createSafeDirectory(this.root);
      await createSafeDirectory(join(this.root, "attempts"));
      await createSafeDirectory(join(this.root, "staging"));
      await syncDirectory(this.root);
    })().catch((error) => { this.ready = undefined; throw error; });
    await this.ready;
    await assertSafeDirectory(this.root);
  }

  /** A private locator is validated even though only catalog records should supply it. */
  private receiptPath(reference: PrivateLocator): string {
    if (reference.storeId !== this.storeId || !/^[a-f0-9]{64}$/.test(reference.opaqueKey)) throw new WorkspaceError("RECEIPT_MISMATCH", "Receipt location is outside this store");
    return join(this.root, "attempts", reference.opaqueKey, "bytes");
  }

  async begin(input: BeginSubmissionInput): Promise<Submission> {
    await this.initialize();
    return (await this.control.createSubmission(input)).value;
  }

  async get(scope: RunScope, submissionId: SubmissionId): Promise<Submission | null> {
    const submission = await this.control.getSubmission(scope, submissionId);
    if (submission && (!sameRunScope(submission.scope, scope) || submission.id !== submissionId)) throw new WorkspaceError("SUBMISSION_NOT_FOUND", "Submission not found");
    return submission;
  }

  private async required(scope: RunScope, submissionId: SubmissionId): Promise<Submission> {
    const submission = await this.get(scope, submissionId);
    if (!submission) throw new WorkspaceError("SUBMISSION_NOT_FOUND", "Submission not found");
    return submission;
  }

  private checkCommand(input: { scope: RunScope; principal: WriteSubmissionFileInput["principal"]; command: CommandIdentity }, kind: "submission:file" | "submission:seal"): void {
    const { idempotencyScope } = input.command;
    if (idempotencyScope.kind !== kind || idempotencyScope.customerId !== input.scope.customerId || idempotencyScope.workspaceId !== input.scope.workspaceId || idempotencyScope.runId !== input.scope.runId || idempotencyScope.actorId !== input.principal.actorId || !input.command.idempotencyKey || !/^[a-f0-9]{64}$/.test(input.command.requestDigest)) throw new WorkspaceError("INVALID_REQUEST", "Command identity does not match its upload scope");
  }

  private async replay(command: CommandIdentity): Promise<Operation | null> {
    const operation = await this.control.findOperation(command.idempotencyScope, command.idempotencyKey);
    if (operation && operation.command.requestDigest !== command.requestDigest) throw new WorkspaceError("IDEMPOTENCY_KEY_REUSED", "Idempotency key already binds another request");
    return operation;
  }

  private attemptIdentity(input: WriteSubmissionFileInput): { key: string; fingerprint: string } {
    return {
      key: hash({ scope: input.command.idempotencyScope, key: input.command.idempotencyKey }),
      fingerprint: hash({ scope: input.scope, submissionId: input.submissionId, actorId: input.principal.actorId, credentialId: input.principal.credential.id, path: input.path, declaredSha256: input.declaredSha256, declaredByteLength: input.declaredByteLength ?? null }),
    };
  }

  private async readAttempt(key: string): Promise<DurableAttempt | null> {
    const directory = join(this.root, "attempts", key);
    let handle;
    try { handle = await openRegularFile(directory, "receipt.json"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const stat = await handle.stat();
      if (stat.size > 64 * 1024) throw new WorkspaceError("RECEIPT_MISMATCH", "Invalid durable receipt");
      const record = JSON.parse(await handle.readFile("utf8")) as DurableAttempt;
      if (record.schemaVersion !== 1 || !record.receipt || record.receipt.privateReference.opaqueKey !== key) throw new WorkspaceError("RECEIPT_MISMATCH", "Invalid durable receipt");
      this.receiptPath(record.receipt.privateReference);
      return record;
    } finally { await handle.close(); }
  }

  private async verifyReceipt(receipt: UploadReceipt, options?: StreamOptions): Promise<void> {
    this.receiptPath(receipt.privateReference);
    for await (const _ of readVerifiedFile(join(this.root, "attempts", receipt.privateReference.opaqueKey), "bytes", { path: receipt.path, kind: "file", byteLength: receipt.byteLength, sha256: receipt.sha256 }, this.limits, options)) { /* Consume before catalog registration or seal. */ }
  }

  private async readCollectionMarker(key: string, signal?: AbortSignal): Promise<unknown> {
    checkAbort(signal);
    let file;
    try { file = await openRegularFile(join(this.root, "attempts", key), "collected.json"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try {
      const bytes = Buffer.alloc(16 * 1024 + 1); let length = 0;
      for (;;) {
        checkAbort(signal);
        const read = await file.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
        if (length > 16 * 1024) throw new WorkspaceError("STORAGE_UNAVAILABLE", "Invalid submission collection marker");
      }
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))); }
      catch { throw new WorkspaceError("STORAGE_UNAVAILABLE", "Invalid submission collection marker"); }
    } finally { await file.close(); }
  }

  private async persistAttempt(input: WriteSubmissionFileInput, key: string, fingerprint: string, writerId: string): Promise<UploadReceipt> {
    const existing = await this.readAttempt(key);
    if (existing) {
      if (existing.requestDigest !== input.command.requestDigest || existing.fingerprint !== fingerprint) throw new WorkspaceError("IDEMPOTENCY_KEY_REUSED", "Upload key already binds different bytes or metadata");
      // A concurrent publisher can expose its rename before completing either parent durability barrier.
      await syncDirectory(join(this.root, "attempts"));
      await syncDirectory(join(this.root, "staging"));
      await this.verifyReceipt(existing.receipt, { signal: input.signal });
      return existing.receipt;
    }
    const temporary = join(this.root, "staging", hash(writerId));
    await assertSafeDirectory(join(this.root, "staging"));
    await mkdir(temporary, { mode: 0o700 });
    const handle = await open(join(temporary, "bytes"), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    let moved = false;
    try {
      const verified = await persistByteStream(handle, input.bytes, { byteLength: input.declaredByteLength, sha256: input.declaredSha256 }, this.limits, input.signal);
      await handle.close();
      const receipt: UploadReceipt = { id: input.receiptId, scope: structuredClone(input.scope), submissionId: input.submissionId, path: input.path, ...verified, privateReference: { storeId: this.storeId, opaqueKey: key }, completedAt: this.now() };
      const record: DurableAttempt = { schemaVersion: 1, requestDigest: input.command.requestDigest, fingerprint, receipt };
      const metadata = await open(join(temporary, "receipt.json"), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await metadata.writeFile(canonicalJson(record), "utf8"); await metadata.sync(); } finally { await metadata.close(); }
      await syncDirectory(temporary);
      await assertSafeDirectory(join(this.root, "attempts"));
      try { await rename(temporary, join(this.root, "attempts", key)); moved = true; }
      catch (error) { if (!exists(error)) throw error; }
      await syncDirectory(join(this.root, "attempts"));
      await syncDirectory(join(this.root, "staging"));
      const published = await this.readAttempt(key);
      if (!published || published.requestDigest !== input.command.requestDigest || published.fingerprint !== fingerprint) throw new WorkspaceError("IDEMPOTENCY_KEY_REUSED", "Concurrent upload binds another request");
      await this.verifyReceipt(published.receipt, { signal: input.signal });
      return published.receipt;
    } finally {
      await handle.close().catch(() => {});
      if (!moved) await removeWorkspace(temporary);
    }
  }

  async writeFile(input: WriteSubmissionFileInput): Promise<UploadReceipt> {
    input = { ...input, scope: structuredClone(input.scope), principal: structuredClone(input.principal), command: structuredClone(input.command) };
    this.checkCommand(input, "submission:file");
    validatePortablePath(input.path, this.limits);
    if (!/^[a-f0-9]{64}$/.test(input.declaredSha256)) throw new WorkspaceError("INVALID_MANIFEST", "Expected lowercase SHA-256");
    const release = await this.limiter.acquire(input.signal);
    try {
      await this.initialize();
      const operation = await this.replay(input.command);
      if (operation?.state === "succeeded" && operation.result?.kind === "submission:file") {
        const receipt = await this.control.getReceipt(input.scope, input.submissionId, operation.result.receiptId);
        if (!receipt || !receiptMatches(receipt, input.scope, input.submissionId, { path: input.path, sha256: input.declaredSha256, byteLength: input.declaredByteLength })) throw new WorkspaceError("RECEIPT_MISMATCH", "Recorded receipt does not match upload");
        const current = await this.required(input.scope, input.submissionId);
        // Successful retries still require the catalog's current authority check.
        const replayed = (await this.control.registerUploadReceipt({ scope: input.scope, principal: input.principal, command: input.command, expectedSubmissionVersion: current.version, receipt, now: this.now() })).value;
        if (!await this.control.isUploadReceiptRetired(replayed)) {
          try { await this.verifyReceipt(replayed, { signal: input.signal }); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            const marker = await this.readCollectionMarker(replayed.privateReference.opaqueKey, input.signal);
            if (!await this.control.isUploadReceiptRetired(replayed, marker)) throw error;
          }
        }
        return replayed;
      }
      const submission = await this.required(input.scope, input.submissionId);
      if (submission.state !== "uploading") throw new WorkspaceError("SUBMISSION_SEALED", "Submission does not accept uploads");
      const { key, fingerprint } = this.attemptIdentity(input);
      const writerId = randomUUID();
      await this.control.beginSubmissionWrite({ scope: input.scope, principal: input.principal, command: input.command, submissionId: input.submissionId, writerId, attemptKey: key, storeId: this.storeId, now: this.now() });
      try {
        const receipt = await this.persistAttempt(input, key, fingerprint, writerId);
        // A different upload can advance the version while bytes stream; only catalog CAS authorizes registration.
        for (let attempt = 0; attempt < 32; attempt++) {
          const current = await this.required(input.scope, input.submissionId);
          try { return (await this.control.registerUploadReceipt({ scope: input.scope, principal: input.principal, command: input.command, expectedSubmissionVersion: current.version, receipt, now: this.now() })).value; }
          catch (error) { if (!(error instanceof WorkspaceError) || error.code !== "VERSION_CONFLICT" || attempt === 31) throw error; }
        }
        throw new WorkspaceError("VERSION_CONFLICT", "Submission changed repeatedly");
      } finally {
        await this.control.finishSubmissionWrite({ scope: input.scope, submissionId: input.submissionId, writerId, now: this.now() });
      }
    } finally { release(); }
  }

  async seal(input: SealSubmissionInput): Promise<Submission> {
    input = structuredClone(input);
    this.checkCommand(input, "submission:seal");
    await this.initialize();
    const manifest = await validateReceiptSelection(this.control, input.scope, input.submissionId, input.manifest, input.receipts, this.limits);
    const digest = manifestDigest(manifest, this.limits);
    const operation = await this.replay(input.command);
    if (operation?.state === "succeeded" && operation.result?.kind === "submission:seal") {
      const submission = await this.required(input.scope, input.submissionId);
      if (submission.manifestDigest !== digest || operation.result.manifestDigest !== digest) throw new WorkspaceError("IDEMPOTENCY_KEY_REUSED", "Seal key already binds another manifest");
      return (await this.control.sealSubmission({ ...input, manifest, manifestDigest: digest, expectedSubmissionVersion: submission.version, now: input.sealedAt })).value;
    }
    for (const selection of input.receipts) {
      const receipt = await this.control.getReceipt(input.scope, input.submissionId, selection.receiptId);
      if (!receipt) throw new WorkspaceError("RECEIPT_MISMATCH", "Selected receipt is unavailable");
      const release = await this.limiter.acquire();
      try { await this.verifyReceipt(receipt); } finally { release(); }
    }
    const current = await this.required(input.scope, input.submissionId);
    return (await this.control.sealSubmission({ ...input, manifest, manifestDigest: digest, expectedSubmissionVersion: current.version, now: input.sealedAt })).value;
  }

  async openSealedFile(scope: RunScope, submissionId: SubmissionId, path: string, options?: StreamOptions): Promise<ByteStream> {
    checkAbort(options?.signal);
    validatePortablePath(path, this.limits);
    const submission = await this.required(scope, submissionId);
    if (submission.state !== "sealed" || !submission.manifest) throw new WorkspaceError("SUBMISSION_SEALED", "Submission is not sealed");
    const manifest = canonicalizeManifest(submission.manifest, this.limits);
    if (manifestDigest(manifest, this.limits) !== submission.manifestDigest) throw new WorkspaceError("RECEIPT_MISMATCH", "Sealed manifest digest changed");
    const entry = manifest.entries.find((item): item is FileEntry => item.path === path && item.kind === "file");
    const selection = submission.receipts.find((item) => item.path === path);
    const receipt = selection ? await this.control.getReceipt(scope, submissionId, selection.receiptId) : null;
    if (!entry || !receipt || !receiptMatches(receipt, scope, submissionId, entry)) throw new WorkspaceError("RECEIPT_MISMATCH", "Path is not an exact sealed receipt");
    this.receiptPath(receipt.privateReference);
    return readVerifiedFile(join(this.root, "attempts", receipt.privateReference.opaqueKey), "bytes", entry, this.limits, options, this.limiter);
  }

  async expire(scope: RunScope, submissionId: SubmissionId, expectedVersion: number, now: Timestamp): Promise<void> {
    // Catalog checks recoverable finalization references before expiry. Retain immutable bytes for explicit collection.
    await this.control.expireSubmission({ scope, submissionId, expectedVersion, now });
  }
  async collect(input: SubmissionCollectionPermit, _now: Timestamp): Promise<void> {
    const permit = structuredClone(input);
    const authorize = async () => { if (!await this.control.verifySubmissionCollectionPermit(permit, this.now())) throw new WorkspaceError("STALE_FENCE", "Submission collection requires a current catalog mark and stopped writers"); };
    await this.initialize(); await authorize();
    let cursor: string | undefined;
    do {
      const page = await this.control.listSubmissionCollectionAttempts({ permit, now: this.now(), cursor, limit: 100 });
      for (const attempt of page.attempts) {
        if (attempt.storeId !== this.storeId || !/^[a-f0-9]{64}$/.test(attempt.attemptKey)) throw new WorkspaceError("STORAGE_UNAVAILABLE", "Submission cleanup requires its original private store");
        const root = join(this.root, "attempts", attempt.attemptKey);
        await createSafeDirectory(root);
        const expected = { scope: permit.scope, submissionId: permit.submissionId, attemptKey: attempt.attemptKey, storeId: this.storeId };
        let marker: unknown;
        try { const file = await openRegularFile(root, "collected.json"); try { if ((await file.stat()).size > 16 * 1024) throw new WorkspaceError("STORAGE_UNAVAILABLE", "Invalid submission collection marker"); marker = JSON.parse(await file.readFile("utf8")); } finally { await file.close(); } }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (marker && canonicalJson(marker) !== canonicalJson(expected)) throw new WorkspaceError("STALE_FENCE", "Submission attempt belongs to another collection target");
        if (!marker) {
          const recorded = await this.readAttempt(attempt.attemptKey);
          if (recorded && (!sameRunScope(recorded.receipt.scope, permit.scope) || recorded.receipt.submissionId !== permit.submissionId)) throw new WorkspaceError("STALE_FENCE", "Submission attempt belongs to another run");
          const names = await readdir(root);
          if (names.some(name => !["bytes", "receipt.json", "collected.json"].includes(name)) || (!recorded && names.includes("bytes"))) throw new WorkspaceError("STORAGE_UNAVAILABLE", "Missing immutable attempt ownership; retain bytes");
          await authorize();
          let file;
          try { file = await open(join(root, "collected.json"), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new WorkspaceError("STORAGE_UNAVAILABLE", "Concurrent collection marker requires retry"); throw error; }
          try { await file.writeFile(canonicalJson(expected)); await file.sync(); } finally { await file.close(); }
          await syncDirectory(root);
        }
        for (const name of ["bytes", "receipt.json"]) {
          await authorize();
          try { const file = await openRegularFile(root, name); await file.close(); await unlink(join(root, name)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        await syncDirectory(root);
        if (attempt.writerId) {
          await authorize(); const staging = join(this.root, "staging", hash(attempt.writerId));
          let exists = false; try { await lstat(staging); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          if (exists) await removeWorkspace(staging);
          await syncDirectory(join(this.root, "staging"));
        }
        await this.control.recordSubmissionCollectionProgress({ permit, attemptId: attempt.id, now: this.now() });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    await this.control.completeSubmissionCollection(permit, this.now());
  }
}

export function createLocalSubmissionStore(options: LocalSubmissionStoreOptions): SubmissionStore { return new LocalSubmissionStore(options); }
