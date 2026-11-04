import type { ClientOptions } from "./types";
import { ContextVaultError, NetworkError, OutcomeUnknownError, localError, mapResponseToError } from "./errors";
import { canonicalizeManifest, verifyFileStream, workspaceLimits, type Manifest, type ManifestFile, type WorkspaceLimits } from "./manifest";

export interface Links { [relation: string]: { href: string } }
export interface WorkspaceView { id: string; customerId: string; name: string; currentRevisionId: string; version: number; status: "active" | "suspended" | "deleted"; createdAt: string; updatedAt: string; _links: Links }
export interface OpenRunRequest { mode: "read-only" | "read-write"; agentLabel: string; task: string; reason: string }
export interface RunView {
  id: string; workspaceId: string; mode: "read-only" | "read-write"; agentLabel: string; task: string; reason: string;
  baseRevisionId: string; version: number; state: "active" | "finalizing" | "finalized" | "aborted" | "conflicted" | "expired" | "failed";
  expiresAt: string; leaseVersion: number; operationId: string | null;
  outcome: { state: string; revisionId: string | null; changed: boolean; completedAt: string; errorCode?: string } | null;
  cleanup: { state: string; version: number; attempts: number; lastError: string | null }; createdAt: string; updatedAt: string; _links: Links;
}
export interface SubmissionView { id: string; runId: string; state: "uploading" | "sealed" | "expired"; version: number; expiresAt: string; manifestDigest: string | null; sealedAt: string | null; _links: Links }
export interface UploadReceipt { id: string; runId: string; submissionId: string; path: string; byteLength: number; sha256: string; completedAt: string }
export interface OperationView {
  id: string; workspaceId: string; runId: string | null; kind: string; state: "pending" | "processing" | "succeeded" | "failed";
  phase: string; version: number; result: { kind: string; runState?: "finalized" | "conflicted" | "failed"; revisionId?: string | null; changed?: boolean; workspaceId?: string; [key: string]: unknown } | null;
  error: { code: string; message: string; retryable?: boolean; operationId?: string } | null; createdAt: string; updatedAt: string; _links: Links;
}
export interface SealRequest { manifest: Manifest; receipts: readonly { path: string; receiptId: string }[] }
export interface FinalizeRequest { expectedRunVersion: number; submissionId?: string }
export interface RevisionView { id: string; workspaceId: string; parentRevisionId: string | null; manifestDigest: string; createdAt: string; _links: Links }
export const enc = encodeURIComponent;

/** Low-level mutations require caller-owned stable keys and reconciliation. They do not persist commands. */
export class WorkspaceTransport {
  readonly baseUrl: string;
  readonly limits: WorkspaceLimits;
  readonly operationTimeoutMs: number;
  readonly requestTimeoutMs: number;
  private readonly send: typeof fetch;
  private readonly responses = new WeakMap<Response, { signal: AbortSignal; release: () => void }>();
  private readonly clientRejections = new WeakSet<ContextVaultError>();
  constructor(private readonly options: ClientOptions) {
    const url = new URL(options.baseUrl ?? "http://localhost:3000");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw localError("INVALID_REQUEST", "baseUrl must be an HTTP origin without credentials or a path");
    this.baseUrl = url.origin; this.send = options.fetch ?? fetch; this.limits = workspaceLimits(options.limits);
    this.operationTimeoutMs = options.operationTimeoutMs ?? 30000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    if (!Number.isSafeInteger(this.operationTimeoutMs) || this.operationTimeoutMs < 1) throw localError("INVALID_REQUEST", "operationTimeoutMs must be positive");
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1) throw localError("INVALID_REQUEST", "requestTimeoutMs must be positive");
  }
  private async interruptible<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) { void work.catch(() => {}); throw new NetworkError("HTTP request deadline exceeded"); }
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(new NetworkError("HTTP request deadline exceeded"));
      signal.addEventListener("abort", aborted, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    });
  }
  private release(response: Response) { this.responses.get(response)?.release(); this.responses.delete(response); }
  /** Only actual HTTP 4xx mappings qualify; local validation after HTTP success is not a rejection receipt. */
  isHttpClientRejection(error: unknown): boolean { return error instanceof ContextVaultError && this.clientRejections.has(error); }
  private async readJson<T>(response: Response): Promise<T> {
    const lifetime = this.responses.get(response);
    if (!response.body || !lifetime) { this.release(response); throw new NetworkError("HTTP response has no JSON body"); }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const part = await this.interruptible(reader.read(), lifetime.signal);
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 32 * 1024 * 1024) throw new NetworkError("HTTP JSON metadata exceeded its byte limit");
        chunks.push(part.value);
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as T;
    } catch (error) { if (error instanceof ContextVaultError) throw error; throw new NetworkError("HTTP response was interrupted", error as Error); }
    finally { void reader.cancel().catch(() => {}); reader.releaseLock(); this.release(response); }
  }
  async response(method: string, path: string, options: { body?: unknown; key?: string; bytes?: AsyncIterable<Uint8Array>; entry?: ManifestFile; timeoutMs?: number } = {}): Promise<Response> {
    if (!path.startsWith("/v1/") || path.startsWith("//")) throw localError("INVALID_REQUEST", "Expected an origin-relative v1 route");
    const headers: Record<string, string> = { "X-API-Key": this.options.apiKey, Accept: "application/json" };
    if (method !== "GET") {
      if (typeof options.key !== "string" || !options.key.trim()) throw localError("INVALID_REQUEST", "Mutations require a stable idempotency key; persist it with the exact request before dispatch");
      headers["Idempotency-Key"] = options.key;
    }
    const controller = new AbortController();
    const duration = Math.min(this.requestTimeoutMs, options.timeoutMs ?? this.requestTimeoutMs);
    if (!(duration > 0 && Number.isFinite(duration))) throw new NetworkError("HTTP request deadline exceeded");
    const timer = setTimeout(() => controller.abort(), duration); timer.unref();
    const release = () => clearTimeout(timer);
    const init: RequestInit & { duplex?: string } = { method, headers, redirect: "error", signal: controller.signal };
    if (options.bytes && options.entry) {
      headers["Content-Type"] = "application/octet-stream"; headers["Content-Length"] = String(options.entry.byteLength); headers["X-Content-SHA256"] = options.entry.sha256;
      init.body = verifyFileStream(options.entry, options.bytes, this.limits) as unknown as BodyInit; init.duplex = "half";
    } else if (options.body !== undefined) { headers["Content-Type"] = "application/json"; init.body = JSON.stringify(options.body); }
    let response: Response;
    try { response = await this.interruptible(this.send(this.baseUrl + path, init), controller.signal); }
    catch (error) { release(); if (error instanceof ContextVaultError) throw error; throw new NetworkError("HTTP transport failed", error as Error); }
    this.responses.set(response, { signal: controller.signal, release });
    if (!response.ok) {
      let body: unknown;
      try { body = await this.readJson(response); }
      catch (error) { if (controller.signal.aborted) throw error; body = null; }
      const error = mapResponseToError(response.status, body);
      if (response.status >= 400 && response.status < 500) this.clientRejections.add(error);
      throw error;
    }
    return response;
  }
  async json<T>(method: string, path: string, body?: unknown, key?: string, options: { timeoutMs?: number } = {}): Promise<T> {
    const response = await this.response(method, path, { body, key, ...options });
    return this.readJson<T>(response);
  }
  async upload(runId: string, submissionId: string, entry: ManifestFile, bytes: AsyncIterable<Uint8Array>, key: string): Promise<UploadReceipt> {
    canonicalizeManifest({ schemaVersion: 1, entries: [entry] }, this.limits);
    const response = await this.response("PUT", `/v1/runs/${enc(runId)}/submissions/${enc(submissionId)}/files?path=${enc(entry.path)}`, { bytes, entry, key });
    const receipt = await this.readJson<UploadReceipt>(response);
    if (receipt.path !== entry.path || receipt.byteLength !== entry.byteLength || receipt.sha256 !== entry.sha256 || receipt.runId !== runId || receipt.submissionId !== submissionId) throw localError("RECEIPT_MISMATCH", "Receipt differs from the uploaded file");
    return receipt;
  }
  async *download(runId: string, entry: ManifestFile): AsyncIterable<Uint8Array> {
    canonicalizeManifest({ schemaVersion: 1, entries: [entry] }, this.limits);
    const response = await this.response("GET", `/v1/runs/${enc(runId)}/workspace/files?path=${enc(entry.path)}`);
    if (response.headers.get("x-content-sha256") !== entry.sha256 || response.headers.get("content-length") !== String(entry.byteLength) || response.headers.get("content-type")?.split(";")[0] !== "application/octet-stream") {
      void response.body?.cancel().catch(() => {}); this.release(response); throw localError("RECEIPT_MISMATCH", "Download headers differ from the pinned manifest");
    }
    if (!response.body) { this.release(response); throw localError("RECEIPT_MISMATCH", "Download has no byte stream"); }
    const reader = response.body.getReader();
    const lifetime = this.responses.get(response)!; const interruptible = this.interruptible.bind(this);
    async function* source() { try { for (;;) { const part = await interruptible(reader.read(), lifetime.signal); if (part.done) return; yield part.value; } } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); } }
    try { yield* verifyFileStream(entry, source(), this.limits); }
    finally { this.release(response); }
  }
}
export class Runs {
  constructor(private readonly http: WorkspaceTransport) {}
  open(workspaceId: string, body: OpenRunRequest, key: string) { return this.http.json<RunView>("POST", `/v1/workspaces/${enc(workspaceId)}/runs`, body, key); }
  get(runId: string) { return this.http.json<RunView>("GET", `/v1/runs/${enc(runId)}`); }
  async manifest(runId: string) { return canonicalizeManifest(await this.http.json<Manifest>("GET", `/v1/runs/${enc(runId)}/workspace/manifest`), this.http.limits); }
  file(runId: string, entry: ManifestFile) { return this.http.download(runId, entry); }
  finalize(runId: string, body: FinalizeRequest, key: string) { return this.http.json<OperationView>("POST", `/v1/runs/${enc(runId)}/finalize`, body, key); }
  abort(runId: string, body: { expectedRunVersion: number; reason: string }, key: string) { return this.http.json<RunView>("POST", `/v1/runs/${enc(runId)}/abort`, body, key); }
  heartbeat(runId: string, body: { expectedLeaseVersion: number }, key: string) { return this.http.json<RunView>("POST", `/v1/runs/${enc(runId)}/heartbeat`, body, key); }
}
export class Submissions {
  constructor(private readonly http: WorkspaceTransport) {}
  create(runId: string, body: Record<string, never>, key: string) { return this.http.json<SubmissionView>("POST", `/v1/runs/${enc(runId)}/submissions`, body, key); }
  upload(runId: string, submissionId: string, entry: ManifestFile, bytes: AsyncIterable<Uint8Array>, key: string) { return this.http.upload(runId, submissionId, entry, bytes, key); }
  seal(runId: string, submissionId: string, body: SealRequest, key: string) { canonicalizeManifest(body.manifest, this.http.limits); return this.http.json<SubmissionView>("POST", `/v1/runs/${enc(runId)}/submissions/${enc(submissionId)}/seal`, body, key); }
}
export class Operations {
  constructor(private readonly http: WorkspaceTransport) {}
  get(id: string) { return this.http.json<OperationView>("GET", `/v1/operations/${enc(id)}`); }
  async wait(id: string): Promise<OperationView> {
    const deadline = performance.now() + this.http.operationTimeoutMs;
    for (;;) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new OutcomeUnknownError("Operation is still pending; reconcile its durable ID", { operationId: id });
      let result: OperationView;
      try { result = await this.http.json<OperationView>("GET", `/v1/operations/${enc(id)}`, undefined, undefined, { timeoutMs: remaining }); }
      catch (error) { if (error instanceof NetworkError) throw new OutcomeUnknownError("Operation lookup did not complete; reconcile its durable ID", { operationId: id }); throw error; }
      if (result.state === "succeeded" || result.state === "failed") return result;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(50, deadline - performance.now()))));
    }
  }
}
export class Revisions {
  constructor(private readonly http: WorkspaceTransport) {}
  list(workspaceId: string) { return this.http.json<{ revisions: RevisionView[]; nextCursor: string | null }>("GET", `/v1/workspaces/${enc(workspaceId)}/revisions`); }
  async manifest(workspaceId: string, revisionId: string) { return canonicalizeManifest(await this.http.json<Manifest>("GET", `/v1/workspaces/${enc(workspaceId)}/revisions/${enc(revisionId)}/manifest`), this.http.limits); }
  restore(workspaceId: string, body: { revisionId: string; expectedRevisionId: string; expectedWorkspaceVersion: number; reason: string }, key: string) { return this.http.json<OperationView>("POST", `/v1/workspaces/${enc(workspaceId)}/restore`, body, key); }
}
