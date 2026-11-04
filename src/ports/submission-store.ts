import type { CommandIdentity, Manifest, Principal, ReceiptId, ReceiptSelection, RunScope, Sha256, Submission, SubmissionId, Timestamp, UploadReceipt } from "../domain";
import type { ByteStream, StreamOptions } from "./streams";

export interface BeginSubmissionInput {
  scope: RunScope;
  principal: Principal;
  command: CommandIdentity;
  submissionId: SubmissionId;
  expiresAt: Timestamp;
}
export interface WriteSubmissionFileInput {
  scope: RunScope;
  principal: Principal;
  command: CommandIdentity;
  submissionId: SubmissionId;
  /** New attempt identity; retries never replace a previously registered receipt's bytes. */
  receiptId: ReceiptId;
  path: string;
  bytes: ByteStream;
  declaredByteLength?: number;
  /** X-Content-SHA256: lowercase hex digest, included in stable request identity and checked independently. */
  declaredSha256: Sha256;
  signal?: AbortSignal;
}
export interface SealSubmissionInput {
  scope: RunScope;
  principal: Principal;
  command: CommandIdentity;
  submissionId: SubmissionId;
  manifest: Manifest;
  receipts: readonly ReceiptSelection[];
  sealedAt: Timestamp;
}

/** Byte persistence plus catalog receipt/seal coordination; backend locations never come from agents. */
export interface SubmissionStore {
  begin(input: BeginSubmissionInput): Promise<Submission>;
  /** Register only after durable completion, and only while run/session remain writable. */
  writeFile(input: WriteSubmissionFileInput): Promise<UploadReceipt>;
  /** Select exact registered immutable receipts atomically; late attempts cannot change sealed bytes. */
  seal(input: SealSubmissionInput): Promise<Submission>;
  get(scope: RunScope, submissionId: SubmissionId): Promise<Submission | null>;
  /** Reject unsealed submissions and verify bytes independently of client-provided digests. */
  openSealedFile(scope: RunScope, submissionId: SubmissionId, path: string, options?: StreamOptions): Promise<ByteStream>;
  /** Catalog eligibility must protect recoverable finalizations from submission expiry. */
  expire(scope: RunScope, submissionId: SubmissionId, expectedVersion: number, now: Timestamp): Promise<void>;
}
