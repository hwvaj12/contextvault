import { ClientOptions } from "./types";
import { Workspaces } from "./workspaces";
import { Webhooks } from "./webhooks";
import { ApiKeys } from "./apikeys";
import { WorkspaceTransport, Runs, Submissions, Operations, Revisions } from "./resources";
import { LocalWorkspaceSession, type OpenWorkspaceOptions } from "./session";

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
  public readonly runs: Runs;
  public readonly submissions: Submissions;
  public readonly operations: Operations;
  public readonly revisions: Revisions;
  private readonly transport: WorkspaceTransport;
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
    this.transport = new WorkspaceTransport(options);
    this.runs = new Runs(this.transport);
    this.submissions = new Submissions(this.transport);
    this.operations = new Operations(this.transport);
    this.revisions = new Revisions(this.transport);
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

    const httpConfig = {
      baseUrl: this.baseUrl,
      apiKey: options.apiKey,
      maxRetries,
    };

    this.workspaces = new Workspaces(httpConfig, options => this.openWorkspace(options), options => this.createWorkspace(options), id => this.transport.json("GET", `/v1/workspaces/${encodeURIComponent(id)}`));
    this.webhooks = new Webhooks(httpConfig);
    this.apiKeys = new ApiKeys(httpConfig);
  }

  openWorkspace(options: OpenWorkspaceOptions): Promise<LocalWorkspaceSession> {
    return LocalWorkspaceSession.open(this.transport, options);
  }
  createWorkspace(options: { customerId: string; name: string; stateDirectory?: string }) {
    return LocalWorkspaceSession.createWorkspace(this.transport, options);
  }

  /** Load durable state without sending HTTP commands or changing agent files. Call reconcile with stopped writers. */
  resumeWorkspace(privateStatePath: string): Promise<LocalWorkspaceSession> {
    return LocalWorkspaceSession.resume(this.transport, privateStatePath);
  }
}
