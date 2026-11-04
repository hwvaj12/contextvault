import {
  Workspace,
  Sandbox,
  PullResult,
  FileEntry,
  HistoryResult,
  CommitEntry,
  CommitResult,
  CreateWorkspaceOptions,
  ListWorkspacesOptions,
  CommitOptions,
  DiffResult,
  DestroyResult,
  BulkDeleteResult,
} from "./types";
import { ConflictError, NetworkError, localError, mapResponseToError } from "./errors";
import type { LocalWorkspaceSession, OpenWorkspaceOptions } from "./session";
import type { WorkspaceView } from "./resources";

export interface HttpConfig {
  baseUrl: string;
  apiKey: string;
  maxRetries: number;
}

export class Workspaces {
  private readonly config: HttpConfig;
  private readonly sessions = new Map<string, LocalWorkspaceSession>();
  private readonly opening = new Set<string>();

  constructor(config: HttpConfig, private readonly openLocal?: (options: OpenWorkspaceOptions) => Promise<LocalWorkspaceSession>,
    private readonly createCanonical?: (options: CreateWorkspaceOptions) => Promise<WorkspaceView>,
    private readonly getCanonical?: (id: string) => Promise<WorkspaceView>) {
    this.config = config;
  }

  // ─── Workspace CRUD ──────────────────────────────────────────────

  /** Create a new workspace. */
  async create(options: CreateWorkspaceOptions): Promise<Workspace> {
    if (this.createCanonical) return legacyWorkspace(await this.createCanonical(options));
    return this.request<Workspace>("POST", "/workspaces", {
      body: { customerId: options.customerId, name: options.name },
    });
  }

  /** List workspaces, optionally filtered by customerId. */
  async list(options: ListWorkspacesOptions = {}): Promise<Workspace[]> {
    const params = new URLSearchParams();
    if (options.customerId) params.set("customerId", options.customerId);
    const qs = params.toString();
    const path = qs ? `/workspaces?${qs}` : "/workspaces";
    const response = await this.request<Workspace[] | { data: Workspace[] }>("GET", path);
    return Array.isArray(response) ? response : response.data;
  }

  /** Get a single workspace by ID. */
  async get(workspaceId: string): Promise<Workspace> {
    if (this.getCanonical) return legacyWorkspace(await this.getCanonical(workspaceId));
    return this.request<Workspace>("GET", `/workspaces/${enc(workspaceId)}`);
  }

  /** Soft-delete a workspace. */
  async delete(workspaceId: string): Promise<void> {
    await this.request<void>("DELETE", `/workspaces/${enc(workspaceId)}`);
  }

  /** Hard-delete multiple workspaces (removes DB records, repos, and sandboxes). */
  async bulkDelete(workspaceIds: string[]): Promise<BulkDeleteResult> {
    return this.request<BulkDeleteResult>("POST", "/workspaces/bulk-delete", {
      body: { workspaceIds },
    });
  }

  /** Clone a workspace to a new customer (or same customer). */
  async clone(
    workspaceId: string,
    targetCustomerId: string,
    newName?: string
  ): Promise<Workspace> {
    const body: Record<string, string> = { targetCustomerId };
    if (newName) body.name = newName;
    return this.request<Workspace>("POST", `/workspaces/${enc(workspaceId)}/clone`, { body });
  }

  // ─── Sandbox lifecycle ───────────────────────────────────────────

  /** Checkout a workspace (create a sandbox). */
  async checkout(workspaceId: string): Promise<Sandbox> {
    if (!this.openLocal) throw localError("INVALID_REQUEST", "Construct ContextVaultClient to use client-local checkout");
    if (this.sessions.has(workspaceId) || this.opening.has(workspaceId)) throw new ConflictError("A local session already exists for this workspace");
    this.opening.add(workspaceId);
    try {
      const session = await this.openLocal({ workspaceId, mode: "read-write", agentLabel: "legacy-sdk", task: "legacy checkout", reason: "client-local compatibility" });
      this.sessions.set(workspaceId, session);
      return { workspaceId, sandboxId: session.run.id, runId: session.run.id, sandboxPath: session.path, path: session.path, baseCommit: session.baseCommit, status: "ready" };
    } finally { this.opening.delete(workspaceId); }
  }

  /** Commit sandbox changes back to the workspace. */
  async commit(workspaceId: string, options: CommitOptions = {}): Promise<CommitResult> {
    const session = this.sessions.get(workspaceId);
    if (!session) throw localError("INVALID_TRANSITION", "Checkout this workspace before committing local files");
    // Legacy commit has always required the caller to finish writes before invoking it.
    await session.checkpoint({ writersStopped: true });
    const receipt = session.checkpointReceipt;
    if (!receipt?.operation.result?.revisionId) throw localError("INVALID_TRANSITION", "Checkpoint has no accepted publication receipt");
    return { workspaceId, sandboxId: receipt.runId, commitId: receipt.operation.result.revisionId, parentId: receipt.parentRevisionId, createdAt: receipt.operation.updatedAt };
  }

  /** Destroy (tear down) the sandbox for a workspace. */
  async destroy(workspaceId: string): Promise<DestroyResult> {
    const session = this.sessions.get(workspaceId);
    if (!session) throw localError("INVALID_TRANSITION", "Checkout this workspace before destroying local files");
    if (session.run.state === "active") await session.abort({ writersStopped: true, reason: "legacy destroy" });
    await session.cleanup({ writersStopped: true }); this.sessions.delete(workspaceId);
    return { workspaceId, status: session.statusAlias };
  }

  // ─── Pull / Files ────────────────────────────────────────────────

  /** Pull the latest committed state (all files) for a workspace. */
  async pull(workspaceId: string, version?: string): Promise<PullResult> {
    const params = new URLSearchParams();
    if (version) params.set("version", version);
    const qs = params.toString();
    const path = `/workspaces/${enc(workspaceId)}/pull${qs ? `?${qs}` : ""}`;
    return this.request<PullResult>("GET", path);
  }

  /** Get a single file from the latest commit of a workspace. */
  async getFile(workspaceId: string, filePath: string): Promise<FileEntry> {
    const params = new URLSearchParams({ path: filePath });
    return this.request<FileEntry>(
      "GET",
      `/workspaces/${enc(workspaceId)}/pull?${params.toString()}`
    );
  }

  /** Compare two commits and return structured diff output. */
  async diff(workspaceId: string, from: string, to: string): Promise<DiffResult> {
    const params = new URLSearchParams({ from, to });
    const path = `/workspaces/${enc(workspaceId)}/diff?${params.toString()}`;
    return this.request<DiffResult>("GET", path);
  }

  /** Get the commit history for a workspace. */
  async history(workspaceId: string, limit?: number): Promise<HistoryResult> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    const qs = params.toString();
    const path = `/workspaces/${enc(workspaceId)}/history${qs ? `?${qs}` : ""}`;
    return this.request<HistoryResult>("GET", path);
  }

  // ─── HTTP layer with retry ──────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    options?: { body?: unknown }
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "X-API-Key": this.config.apiKey,
      "Accept": "application/json",
    };

    const init: RequestInit = { method, headers };

    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff: 200ms, 400ms, 800ms, ...
        const delayMs = 200 * Math.pow(2, attempt - 1);
        await sleep(delayMs);
      }

      try {
        const response = await fetch(url, init);

        // Don't retry client errors (4xx), only retry server errors (5xx) or network issues
        if (response.ok) {
          // 204 No Content
          if (response.status === 204) {
            return undefined as T;
          }
          return (await response.json()) as T;
        }

        // Parse error body
        let errorBody: unknown;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = await response.text().catch(() => null);
        }

        // Client errors are not retryable
        if (response.status >= 400 && response.status < 500) {
          throw mapResponseToError(response.status, errorBody);
        }

        // Server errors (5xx) are retryable
        lastError = mapResponseToError(response.status, errorBody);
      } catch (err) {
        // If it's already one of our mapped errors (client 4xx), rethrow immediately
        if (err instanceof Error && err.name !== "TypeError" && (err as any).statusCode !== undefined) {
          throw err;
        }

        // Network-level failure (TypeError from fetch = connection refused, DNS, etc.)
        lastError = new NetworkError(
          `Network error: ${(err as Error).message}`,
          err as Error
        );
      }
    }

    // All retries exhausted
    throw lastError!;
  }
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

function legacyWorkspace(value: WorkspaceView): Workspace {
  return { ...value, latestCommitId: value.currentRevisionId, deletedAt: value.status === "deleted" ? value.updatedAt : null };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
