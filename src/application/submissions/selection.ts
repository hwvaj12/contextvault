import { WorkspaceError } from "../../domain/errors";
import { canonicalizeManifest, type Manifest, type WorkspaceLimits } from "../../domain/manifest";
import type { ReceiptSelection, RunScope, SubmissionId, UploadReceipt } from "../../domain/model";
import type { ControlStore } from "../../ports/control-store";

export function sameRunScope(left: RunScope, right: RunScope): boolean {
  return left.customerId === right.customerId && left.workspaceId === right.workspaceId && left.storageBindingId === right.storageBindingId && left.bindingGeneration === right.bindingGeneration && left.runId === right.runId;
}

export async function validateReceiptSelection(control: ControlStore, scope: RunScope, submissionId: SubmissionId, input: Manifest, selections: readonly ReceiptSelection[], limits: Partial<WorkspaceLimits> = {}): Promise<Manifest> {
  const manifest = canonicalizeManifest(input, limits);
  const files = manifest.entries.filter((entry) => entry.kind === "file");
  if (!Array.isArray(selections) || selections.length !== files.length) throw new WorkspaceError("RECEIPT_MISMATCH", "Select exactly one receipt per file");
  const paths = new Set<string>();
  for (const selection of selections) {
    if (!selection || Object.keys(selection).length !== 2 || typeof selection.path !== "string" || typeof selection.receiptId !== "string" || paths.has(selection.path)) throw new WorkspaceError("RECEIPT_MISMATCH", "Receipt selections must be unique and exact");
    paths.add(selection.path);
    const file = files.find((entry) => entry.path === selection.path);
    const receipt = await control.getReceipt(scope, submissionId, selection.receiptId);
    if (!file || !receipt || !receiptMatches(receipt, scope, submissionId, file)) throw new WorkspaceError("RECEIPT_MISMATCH", "Selected receipt differs from manifest file");
  }
  return manifest;
}

export function receiptMatches(receipt: UploadReceipt, scope: RunScope, submissionId: SubmissionId, file: { path: string; byteLength?: number; sha256: string }): boolean {
  return sameRunScope(receipt.scope, scope) && receipt.submissionId === submissionId && receipt.path === file.path && receipt.sha256 === file.sha256 && (file.byteLength === undefined || file.byteLength === receipt.byteLength);
}
