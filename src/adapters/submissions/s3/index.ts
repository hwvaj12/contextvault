import { WorkspaceError, canonicalJson, canonicalizeManifest, manifestDigest, validatePortablePath, type FileEntry } from '../../../domain';
import type { CommandIdentity, Operation, PrivateLocator, RunScope, Submission, SubmissionId, Timestamp, UploadReceipt } from '../../../domain';
import type { ControlStore } from '../../../ports/control-store';
import type { BeginSubmissionInput, SealSubmissionInput, SubmissionStore, WriteSubmissionFileInput } from '../../../ports/submission-store';
import type { ByteStream, StreamOptions } from '../../../ports/streams';
import { receiptMatches, sameRunScope, validateReceiptSelection } from '../../../application/submissions';
import { S3Objects, hash, type S3ObjectOptions } from '../../revisions/s3/objects';
export interface S3SubmissionStoreOptions extends S3ObjectOptions { control: ControlStore; now?: () => Timestamp }
interface AttemptIntent {
  schemaVersion: 1; requestDigest: string; fingerprint: string; startedAt: Timestamp;
  receipt: Omit<UploadReceipt, 'byteLength' | 'completedAt'>; declaredByteLength: number | null;
}
interface DurableAttempt { schemaVersion: 1; requestDigest: string; fingerprint: string; receipt: UploadReceipt }
const reused = (): never => { throw new WorkspaceError('IDEMPOTENCY_KEY_REUSED', 'Upload key already binds different bytes or metadata'); };
const mismatch = (): never => { throw new WorkspaceError('RECEIPT_MISMATCH', 'Immutable upload receipt does not match retained bytes'); };
/** Immutable S3 attempts prepare bytes; real catalog transactions authorize registration and sealing. */
export class S3SubmissionStore implements SubmissionStore {
  private readonly objects: S3Objects;
  private readonly control: ControlStore;
  private readonly now: () => Timestamp;
  private readonly storeId: string;
  constructor(options: S3SubmissionStoreOptions) {
    this.objects = new S3Objects(options); this.control = options.control; this.now = options.now ?? (() => new Date().toISOString()); this.storeId = options.storeId;
  }
  private root(key: string): string { return `submissions/v1/attempts/${key}`; }
  private receiptKey(reference: PrivateLocator): string {
    if (reference.storeId !== this.storeId || !/^[a-f0-9]{64}$/.test(reference.opaqueKey)) return mismatch();
    return `${this.root(reference.opaqueKey)}/bytes`;
  }
  async begin(input: BeginSubmissionInput): Promise<Submission> { return (await this.control.createSubmission(input)).value; }
  async get(scope: RunScope, submissionId: SubmissionId): Promise<Submission | null> {
    const submission = await this.control.getSubmission(scope, submissionId);
    if (submission && (!sameRunScope(submission.scope, scope) || submission.id !== submissionId)) throw new WorkspaceError('SUBMISSION_NOT_FOUND', 'Submission not found');
    return submission;
  }
  private async required(scope: RunScope, submissionId: SubmissionId): Promise<Submission> {
    const submission = await this.get(scope, submissionId);
    if (!submission) throw new WorkspaceError('SUBMISSION_NOT_FOUND', 'Submission not found');
    return submission;
  }
  private checkCommand(input: { scope: RunScope; principal: WriteSubmissionFileInput['principal']; command: CommandIdentity }, kind: 'submission:file' | 'submission:seal'): void {
    const { idempotencyScope } = input.command;
    if (idempotencyScope.kind !== kind || idempotencyScope.customerId !== input.scope.customerId || idempotencyScope.workspaceId !== input.scope.workspaceId || idempotencyScope.runId !== input.scope.runId || idempotencyScope.actorId !== input.principal.actorId || !input.command.idempotencyKey || !/^[a-f0-9]{64}$/.test(input.command.requestDigest)) throw new WorkspaceError('INVALID_REQUEST', 'Command identity does not match upload scope');
  }
  private async replay(command: CommandIdentity): Promise<Operation | null> {
    const operation = await this.control.findOperation(command.idempotencyScope, command.idempotencyKey);
    if (operation && operation.command.requestDigest !== command.requestDigest) return reused();
    return operation;
  }
  private attemptIdentity(input: WriteSubmissionFileInput): { key: string; fingerprint: string } {
    return { key: hash({ scope: input.command.idempotencyScope, key: input.command.idempotencyKey }), fingerprint: hash({ scope: input.scope, submissionId: input.submissionId,
      actorId: input.principal.actorId, credentialId: input.principal.credential.id, path: input.path, declaredSha256: input.declaredSha256, declaredByteLength: input.declaredByteLength ?? null }) };
  }
  private async verifyReceipt(receipt: UploadReceipt, options: StreamOptions = {}): Promise<void> {
    const release = await this.objects.limiter.acquire(options.signal);
    try { await this.objects.verify(this.receiptKey(receipt.privateReference), { path: receipt.path, kind: 'file', byteLength: receipt.byteLength, sha256: receipt.sha256 }, options.signal); }
    finally { release(); }
  }
  private async retainedAttempt(root: string, intent: AttemptIntent, signal?: AbortSignal): Promise<UploadReceipt | null> {
    const record = await this.objects.json<DurableAttempt>(`${root}/receipt.json`, signal);
    if (!record) return null;
    if (!record.receipt) return mismatch();
    const { byteLength, completedAt, ...identity } = record.receipt;
    if (record.schemaVersion !== 1 || record.requestDigest !== intent.requestDigest || record.fingerprint !== intent.fingerprint
      || canonicalJson(identity) !== canonicalJson(intent.receipt) || !Number.isSafeInteger(byteLength) || byteLength < 0
      || !Number.isFinite(Date.parse(completedAt)) || (intent.declaredByteLength !== null && byteLength !== intent.declaredByteLength)) return mismatch();
    await this.verifyReceipt(record.receipt, { signal }); return record.receipt;
  }
  private async persistAttempt(input: WriteSubmissionFileInput, key: string, fingerprint: string): Promise<UploadReceipt> {
    const root = this.root(key); const intentKey = `${root}/intent.json`;
    let intent = await this.objects.json<AttemptIntent>(intentKey, input.signal);
    if (!intent) {
      const proposed: AttemptIntent = { schemaVersion: 1, requestDigest: input.command.requestDigest, fingerprint, startedAt: this.now(), declaredByteLength: input.declaredByteLength ?? null,
        receipt: { id: input.receiptId, scope: input.scope, submissionId: input.submissionId, path: input.path, sha256: input.declaredSha256,
          privateReference: { storeId: this.storeId, opaqueKey: key } } };
      try { await this.objects.putJson(intentKey, proposed, reused, input.signal); }
      catch (error) { if (!(error instanceof WorkspaceError) || error.code !== 'IDEMPOTENCY_KEY_REUSED') throw error; }
      intent = await this.objects.json<AttemptIntent>(intentKey, input.signal);
    }
    if (!intent || intent.schemaVersion !== 1 || intent.requestDigest !== input.command.requestDigest || intent.fingerprint !== fingerprint
      || !receiptMatches({ ...intent.receipt, completedAt: intent.startedAt, byteLength: input.declaredByteLength ?? 0 }, input.scope, input.submissionId, { path: input.path, sha256: input.declaredSha256 })
      || intent.declaredByteLength !== (input.declaredByteLength ?? null) || intent.receipt.privateReference.opaqueKey !== key || intent.receipt.privateReference.storeId !== this.storeId) return reused();
    const existing = await this.retainedAttempt(root, intent, input.signal);
    if (existing) return existing;
    const verified = await this.objects.upload(this.receiptKey(intent.receipt.privateReference), input.bytes, { sha256: input.declaredSha256, byteLength: input.declaredByteLength }, input.signal);
    const receipt: UploadReceipt = { ...intent.receipt, ...verified, completedAt: this.now() };
    try { await this.objects.putJson(`${root}/receipt.json`, { schemaVersion: 1, requestDigest: intent.requestDigest, fingerprint, receipt }, mismatch, input.signal); }
    catch (error) { if (!(error instanceof WorkspaceError) || error.code !== 'RECEIPT_MISMATCH') throw error; }
    // Concurrent equal uploads can complete at different times. Adopt the first immutable receipt after full verification.
    const retained = await this.retainedAttempt(root, intent, input.signal);
    if (!retained) return mismatch();
    return retained;
  }
  async writeFile(input: WriteSubmissionFileInput): Promise<UploadReceipt> {
    input = { ...input, scope: structuredClone(input.scope), principal: structuredClone(input.principal), command: structuredClone(input.command) };
    this.checkCommand(input, 'submission:file'); validatePortablePath(input.path, this.objects.limits); input.signal?.throwIfAborted();
    if (!/^[a-f0-9]{64}$/.test(input.declaredSha256)) throw new WorkspaceError('INVALID_MANIFEST', 'Expected lowercase SHA-256');
    const operation = await this.replay(input.command);
    if (operation?.state === 'succeeded' && operation.result?.kind === 'submission:file') {
      const receipt = await this.control.getReceipt(input.scope, input.submissionId, operation.result.receiptId);
      if (!receipt || !receiptMatches(receipt, input.scope, input.submissionId, { path: input.path, sha256: input.declaredSha256, byteLength: input.declaredByteLength })) return mismatch();
      await this.verifyReceipt(receipt, { signal: input.signal });
      const current = await this.required(input.scope, input.submissionId);
      return (await this.control.registerUploadReceipt({ scope: input.scope, principal: input.principal, command: input.command, expectedSubmissionVersion: current.version, receipt, now: this.now() })).value;
    }
    const submission = await this.required(input.scope, input.submissionId);
    if (submission.state !== 'uploading') throw new WorkspaceError('SUBMISSION_SEALED', 'Submission does not accept uploads');
    const { key, fingerprint } = this.attemptIdentity(input); const receipt = await this.persistAttempt(input, key, fingerprint);
    for (let attempt = 0; attempt < 32; attempt++) {
      const current = await this.required(input.scope, input.submissionId);
      try { return (await this.control.registerUploadReceipt({ scope: input.scope, principal: input.principal, command: input.command, expectedSubmissionVersion: current.version, receipt, now: this.now() })).value; }
      catch (error) { if (!(error instanceof WorkspaceError) || error.code !== 'VERSION_CONFLICT' || attempt === 31) throw error; }
    }
    throw new WorkspaceError('VERSION_CONFLICT', 'Submission changed repeatedly');
  }
  async seal(input: SealSubmissionInput): Promise<Submission> {
    input = structuredClone(input); this.checkCommand(input, 'submission:seal');
    const manifest = await validateReceiptSelection(this.control, input.scope, input.submissionId, input.manifest, input.receipts, this.objects.limits);
    const digest = manifestDigest(manifest, this.objects.limits); const operation = await this.replay(input.command);
    if (operation?.state === 'succeeded' && operation.result?.kind === 'submission:seal') {
      const submission = await this.required(input.scope, input.submissionId);
      if (submission.manifestDigest !== digest || operation.result.manifestDigest !== digest) return reused();
      return (await this.control.sealSubmission({ ...input, manifest, manifestDigest: digest, expectedSubmissionVersion: submission.version, now: input.sealedAt })).value;
    }
    for (const selection of input.receipts) {
      const receipt = await this.control.getReceipt(input.scope, input.submissionId, selection.receiptId); if (!receipt) return mismatch();
      await this.verifyReceipt(receipt);
    }
    const current = await this.required(input.scope, input.submissionId);
    return (await this.control.sealSubmission({ ...input, manifest, manifestDigest: digest, expectedSubmissionVersion: current.version, now: input.sealedAt })).value;
  }
  async openSealedFile(scope: RunScope, submissionId: SubmissionId, path: string, options: StreamOptions = {}): Promise<ByteStream> {
    options.signal?.throwIfAborted(); validatePortablePath(path, this.objects.limits);
    const submission = await this.required(scope, submissionId);
    if (submission.state !== 'sealed' || !submission.manifest) throw new WorkspaceError('SUBMISSION_SEALED', 'Submission is not sealed');
    const manifest = canonicalizeManifest(submission.manifest, this.objects.limits);
    if (manifestDigest(manifest, this.objects.limits) !== submission.manifestDigest) return mismatch();
    const entry = manifest.entries.find((e): e is FileEntry => e.path === path && e.kind === 'file');
    const selected = submission.receipts.find(s => s.path === path); const receipt = selected ? await this.control.getReceipt(scope, submissionId, selected.receiptId) : null;
    if (!entry || !receipt || !receiptMatches(receipt, scope, submissionId, entry)) return mismatch();
    return this.objects.file(this.receiptKey(receipt.privateReference), entry, options);
  }
  async expire(scope: RunScope, submissionId: SubmissionId, expectedVersion: number, now: Timestamp): Promise<void> {
    // Retain failed/partial attempts. Catalog expiry cannot authorize arbitrary object deletion.
    await this.control.expireSubmission({ scope, submissionId, expectedVersion, now });
  }
}
export function createS3SubmissionStore(options: S3SubmissionStoreOptions): SubmissionStore { return new S3SubmissionStore(options); }
