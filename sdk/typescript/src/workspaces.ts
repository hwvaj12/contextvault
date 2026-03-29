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
import { NetworkError, mapResponseToError } from "./errors";

export interface HttpConfig {
  baseUrl: string;
  apiKey: string;
  maxRetries: number;
}

export class Workspaces {
  private readonly config: HttpConfig;

  constructor(config: HttpConfig) {
    this.config = config;
  }

  // ─── Workspace CRUD ──────────────────────────────────────────────

  /** Create a new workspace. */
  async create(options: CreateWorkspaceOptions): Promise<Workspace> {
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
    return this.request<Workspace[]>("GET", path);
  }

  /** Get a single workspace by ID. */
  async get(workspaceId: string): Promise<Workspace> {
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

  // ─── Sandbox lifecycle ───────────────────────────────────────────

  /** Checkout a workspace (create a sandbox). */
  async checkout(workspaceId: string): Promise<Sandbox> {
    return this.request<Sandbox>("POST", `/workspaces/${enc(workspaceId)}/sandbox`);
  }

  /** Commit sandbox changes back to the workspace. */
  async commit(workspaceId: string, options: CommitOptions = {}): Promise<CommitResult> {
    return this.request<CommitResult>("POST", `/workspaces/${enc(workspaceId)}/sandbox/commit`, {
      body: {
        ...(options.agentId && { agentId: options.agentId }),
        ...(options.taskId && { taskId: options.taskId }),
        ...(options.tags && { tags: options.tags }),
        ...(options.message && { message: options.message }),
        ...(options.author && { author: options.author }),
      },
    });
  }

  /** Destroy (tear down) the sandbox for a workspace. */
  async destroy(workspaceId: string): Promise<DestroyResult> {
    return this.request<DestroyResult>("DELETE", `/workspaces/${enc(workspaceId)}/sandbox`);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
