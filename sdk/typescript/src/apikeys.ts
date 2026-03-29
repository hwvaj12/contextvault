import { NetworkError, mapResponseToError } from "./errors";

export interface HttpConfig {
  baseUrl: string;
  apiKey: string;
  maxRetries: number;
}

export interface ApiKey {
  id: string;
  customerId: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ApiKeyWithPlainKey extends ApiKey {
  plainKey: string;
}

export interface CreateApiKeyOptions {
  customerId: string;
  name: string;
}

export class ApiKeys {
  private readonly config: HttpConfig;

  constructor(config: HttpConfig) {
    this.config = config;
  }

  /** Create a new API key. The plain key is only returned once. */
  async create(options: CreateApiKeyOptions): Promise<ApiKeyWithPlainKey> {
    return this.request<ApiKeyWithPlainKey>("POST", "/api-keys", {
      body: { customerId: options.customerId, name: options.name },
    });
  }

  /** List API keys for the authenticated customer. */
  async list(): Promise<ApiKey[]> {
    const result = await this.request<{ data: ApiKey[] }>("GET", "/api-keys");
    return result.data;
  }

  /** Revoke (delete) an API key by ID. */
  async revoke(keyId: string): Promise<void> {
    await this.request<void>("DELETE", `/api-keys/${encodeURIComponent(keyId)}`);
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
        const delayMs = 200 * Math.pow(2, attempt - 1);
        await sleep(delayMs);
      }

      try {
        const response = await fetch(url, init);

        if (response.ok) {
          if (response.status === 204) {
            return undefined as T;
          }
          return (await response.json()) as T;
        }

        let errorBody: unknown;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = await response.text().catch(() => null);
        }

        if (response.status >= 400 && response.status < 500) {
          throw mapResponseToError(response.status, errorBody);
        }

        lastError = mapResponseToError(response.status, errorBody);
      } catch (err) {
        if (err instanceof Error && err.name !== "TypeError" && (err as any).statusCode !== undefined) {
          throw err;
        }

        lastError = new NetworkError(
          `Network error: ${(err as Error).message}`,
          err as Error
        );
      }
    }

    throw lastError!;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
