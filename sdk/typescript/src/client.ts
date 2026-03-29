import { ClientOptions } from "./types";
import { Workspaces } from "./workspaces";
import { Webhooks } from "./webhooks";
import { ApiKeys } from "./apikeys";

const DEFAULT_BASE_URL = "http://localhost:3000";
const DEFAULT_MAX_RETRIES = 3;

/**
 * Main entry point for the ContextVault SDK.
 *
 * @example
 * ```typescript
 * const cv = new ContextVaultClient({ apiKey: "cv-my-key" });
 * const workspace = await cv.workspaces.create({ customerId: "cust_1", name: "my-project" });
 * ```
 */
export class ContextVaultClient {
  /** Workspace, sandbox, and file operations. */
  public readonly workspaces: Workspaces;

  /** Webhook registration and management. */
  public readonly webhooks: Webhooks;

  /** API key management. */
  public readonly apiKeys: ApiKeys;

  /** The resolved base URL for the API. */
  public readonly baseUrl: string;

  constructor(options: ClientOptions) {
    if (!options.apiKey) {
      throw new Error("apiKey is required");
    }

    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

    const httpConfig = {
      baseUrl: this.baseUrl,
      apiKey: options.apiKey,
      maxRetries,
    };

    this.workspaces = new Workspaces(httpConfig);
    this.webhooks = new Webhooks(httpConfig);
    this.apiKeys = new ApiKeys(httpConfig);
  }
}
