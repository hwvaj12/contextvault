import { ClientOptions } from "./types";
import { Workspaces } from "./workspaces";

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

  /** The resolved base URL for the API. */
  public readonly baseUrl: string;

  constructor(options: ClientOptions) {
    if (!options.apiKey) {
      throw new Error("apiKey is required");
    }

    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

    this.workspaces = new Workspaces({
      baseUrl: this.baseUrl,
      apiKey: options.apiKey,
      maxRetries,
    });
  }
}
