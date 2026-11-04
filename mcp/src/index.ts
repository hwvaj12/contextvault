import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ContextVaultClient, WorkspaceTransport, ContextVaultError, NetworkError, type WorkspaceView } from "@contextvault/sdk";
import { z } from "zod";
import { Sessions } from './sessions.js';
import { Administration } from './administration.js';

export function configuration(env: NodeJS.ProcessEnv = process.env) {
  if (!env.CV_API_URL || !env.CV_API_KEY?.trim() || !env.CV_MCP_STATE_DIR) throw new Error("Set CV_API_URL, CV_API_KEY and CV_MCP_STATE_DIR");
  const selectedCustomer = env.CV_CUSTOMER_ID?.trim();
  if (selectedCustomer && selectedCustomer.length > 255) throw new Error("CV_CUSTOMER_ID exceeds its limit");
  const duration = (value: string | undefined, fallback: number) => { const number = Number(value ?? fallback); if (!Number.isSafeInteger(number) || number < 1 || number > 120000) throw new Error('MCP deadlines must be between 1 and 120000 milliseconds'); return number; };
  const options = { baseUrl: env.CV_API_URL.replace(/\/$/, ''), apiKey: env.CV_API_KEY, maxRetries: 0, requestTimeoutMs: duration(env.CV_MCP_REQUEST_TIMEOUT_MS, 30000), operationTimeoutMs: duration(env.CV_MCP_OPERATION_TIMEOUT_MS, 30000),
    fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (selectedCustomer) headers.set("X-ContextVault-Customer-Id", selectedCustomer);
      return fetch(input, { ...init, headers });
    } };
  return { options, stateDirectory: env.CV_MCP_STATE_DIR, selectedCustomer };
}
const legacy = (workspace: WorkspaceView) => ({ ...workspace, latestCommitId: workspace.currentRevisionId, deletedAt: workspace.status === "deleted" ? workspace.updatedAt : null });
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
export function createMcpServer(config = configuration()) {
  const http = new WorkspaceTransport(config.options);
  const client = new ContextVaultClient(config.options);
  const sessions = new Sessions(client, config.stateDirectory, config.options.apiKey, config.selectedCustomer);
  const administration = new Administration(client, sessions, config.options);
  const server = new McpServer({ name: "contextvault-mcp", version: "0.1.0" });
  const guard = (handler: (...args: any[]) => Promise<unknown>) => async (...args: any[]) => {
    try { return result(await handler(...args)); }
    catch (error) {
      const known = error instanceof ContextVaultError;
      const code = known ? error.code ?? (error instanceof NetworkError ? "NETWORK_ERROR" : "REQUEST_FAILED") : "INTERNAL_ERROR";
      const handle = error instanceof Error ? (error as Error & { workspaceHandle?: string }).workspaceHandle : undefined;
      const commandHandle = error instanceof Error ? (error as Error & { commandHandle?: string }).commandHandle : undefined;
      return { ...result({ error: { code, message: known ? error.message : "Workspace request could not complete", ...(known && error.operationId ? { operationId: error.operationId } : {}), ...(handle ? { workspaceHandle: handle } : {}), ...(commandHandle ? { commandHandle } : {}), ...(known && error.retryable !== undefined ? { retryable: error.retryable } : {}) } }), isError: true };
    }
  };
  server.registerTool("list_workspaces", { description: "List authenticated customer workspaces from ContextVault", inputSchema: { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(1000).default(100) } }, guard(async ({ offset, limit }) => {
    const page = await http.json<{ workspaces: WorkspaceView[] }>("GET", `/v1/workspaces?offset=${offset}&limit=${limit}`);
    return page.workspaces.map(legacy);
  }));
  server.registerTool("get_workspace", { description: "Read an authorized canonical workspace", inputSchema: { workspaceId: z.string().min(1).max(255) } }, guard(async ({ workspaceId }) => legacy(await http.json<WorkspaceView>("GET", `/v1/workspaces/${encodeURIComponent(workspaceId)}`))));
  const id = z.string().min(1).max(255); const requestId = z.string().min(1).max(256).optional();
  server.registerTool('create_workspace', { description: 'Create an authorized canonical workspace. Reuse requestId for the same exact request.', inputSchema: { customerId: id, name: id, requestId } }, guard(async ({ requestId, ...input }) => {
    const value = await administration.execute('create', input, requestId, async () => ({ method: 'POST', path: '/v1/workspaces', body: input }));
    return legacy(value.currentRevisionId ? value : await http.json<WorkspaceView>('GET', `/v1/workspaces/${encodeURIComponent(value.result.workspaceId)}`));
  }));
  server.registerTool('delete_workspace', { description: 'Tombstone an authorized workspace while retaining accepted history. Reuse requestId after uncertainty.', inputSchema: { workspaceId: id, requestId, reason: z.string().min(1).max(4096).default('explicit MCP deletion') } }, guard(async ({ requestId, ...input }) => {
    await administration.execute('delete', input, requestId, async () => ({ method: 'DELETE', path: `/v1/workspaces/${encodeURIComponent(input.workspaceId)}`, body: { reason: input.reason } })); return { workspaceId: input.workspaceId, deleted: true };
  }));
  server.registerTool('get_workspace_history', { description: 'Read accepted opaque revisions in current-head ancestry order', inputSchema: { workspaceId: id, limit: z.number().int().min(1).max(1000).default(20), cursor: id.optional() } }, guard(async input => {
    const value = await http.json<any>('GET', `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/revisions?limit=${input.limit}${input.cursor ? '&cursor=' + encodeURIComponent(input.cursor) : ''}`);
    return value.revisions.map((revision: any) => ({ ...revision, parentId: revision.parentRevisionId }));
  }));
  server.registerTool('diff_workspace', { description: 'Compare two accepted opaque revisions through canonical administration', inputSchema: { workspaceId: id, from: id, to: id } }, guard(async input => {
    const value = await http.json<any>('GET', `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/diff?from=${encodeURIComponent(input.from)}&to=${encodeURIComponent(input.to)}`);
    return { ...value, added: value.files.filter((file: any) => file.status === 'added').map((file: any) => file.path), removed: value.files.filter((file: any) => file.status === 'deleted').map((file: any) => file.path), modified: value.files.filter((file: any) => file.status === 'modified').map((file: any) => file.path) };
  }));
  server.registerTool('rollback_workspace', { description: 'Restore accepted contents with a durable command and optimistic current-head check; reuse requestId on retry', inputSchema: { workspaceId: id, toVersion: id, requestId, reason: z.string().min(1).max(4096).default('explicit MCP restore') } }, guard(async ({ requestId, ...input }) => {
    const value = await administration.execute('restore', input, requestId, async () => { const workspace = await http.json<WorkspaceView>('GET', `/v1/workspaces/${encodeURIComponent(input.workspaceId)}`); return { method: 'POST', path: `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/restore`, body: { revisionId: input.toVersion, expectedRevisionId: workspace.currentRevisionId, expectedWorkspaceVersion: workspace.version, reason: input.reason } }; });
    return { ...value, commitId: value.result?.revisionId, rolledBackTo: input.toVersion };
  }));
  server.registerTool('push_to_workspace', { description: 'Replace the complete accepted file snapshot through the canonical legacy bridge. Direct requests are limited to 512 KiB; use local files or chunk tools for larger work.', inputSchema: { workspaceId: id, files: z.array(z.object({ path: z.string().min(1).max(1024), content: z.string().max(524288), encoding: z.enum(['utf8', 'base64']).optional() }).strict()).max(10000), requestId, agentId: id.optional(), taskId: id.optional(), tags: z.array(z.string().max(255)).max(100).optional() } }, guard(async ({ requestId, ...input }) => {
    const { workspaceId, files, agentId, taskId, tags } = input;
    return administration.execute('push', input, requestId, async () => ({ method: 'POST', path: `/workspaces/${encodeURIComponent(workspaceId)}/push`, body: { files, metadata: { ...(agentId ? { agentId } : {}), ...(taskId ? { taskId } : {}), ...(tags ? { tags } : {}) } } }));
  }));
  server.registerTool('pull_from_workspace', { description: 'Read a small accepted snapshot with explicit base64 for binary files; use workspace chunk tools for larger content', inputSchema: { workspaceId: id, version: id.optional() } }, guard(input => administration.request('GET', `/workspaces/${encodeURIComponent(input.workspaceId)}/pull${input.version ? '?version=' + encodeURIComponent(input.version) : ''}`)));
  server.registerTool('reconcile_command', { description: 'Reconcile the original durable administration command. Known operation IDs use authenticated GET; otherwise explicitly resend its exact original stable key.', inputSchema: { commandHandle: id } }, guard(input => administration.reconcile(input.commandHandle)));
  server.registerTool('recover_command_controller', { description: 'Remove a retained command controller marker only after every controller has stopped', inputSchema: { commandHandle: id, controllersStopped: z.literal(true) } }, guard(input => administration.recover(input.commandHandle)));
  const selection = { workspaceHandle: z.string().min(1).max(255).optional(), workspaceId: z.string().min(1).max(255).optional() };
  const openSchema = { workspaceId: z.string().min(1).max(255), access: z.enum(['local', 'remote']).default('local'), mode: z.enum(['read-only', 'read-write']).default('read-write'), requestId: z.string().min(1).max(256).optional(), agentLabel: z.string().min(1).max(255).default('mcp-agent'), task: z.string().min(1).max(4096).default('MCP workspace task'), reason: z.string().min(1).max(4096).default('explicit MCP checkout') };
  for (const name of ['checkout_workspace', 'open_workspace']) server.registerTool(name, { description: 'Open a durable client workspace. Local paths belong to the MCP host; remote access returns only an opaque handle. Reuse requestId to recover the exact checkout.', inputSchema: openSchema }, guard(input => sessions.open(input)));
  for (const [name, command] of [['get_sandbox_status', 'status'], ['workspace_status', 'status'], ['heartbeat_workspace', 'heartbeat']] as const) server.registerTool(name, { description: 'Read or renew the current authorized run for an exact MCP workspace handle', inputSchema: selection }, guard(input => sessions.command(input, command)));
  for (const [name, command] of [['commit_workspace', 'checkpoint'], ['checkpoint_workspace', 'checkpoint'], ['finalize_workspace', 'finalize'], ['cleanup_workspace', 'cleanup'], ['reconcile_workspace', 'reconcile'], ['destroy_workspace', 'destroy']] as const) {
    server.registerTool(name, { description: command === 'checkpoint' ? 'Publish the complete stopped-writer snapshot and reopen the same local workspace. Retain the original handle on uncertainty.' : 'Control the exact durable workspace after all agent writers have stopped. Uncertain commands require reconciliation before cleanup or another mutation.', inputSchema: { ...selection, writersStopped: z.literal(true) } }, guard(input => sessions.command(input, command)));
  }
  server.registerTool('abort_workspace', { description: 'Abort a known active run after writers stop. Accepted revisions remain intact.', inputSchema: { ...selection, writersStopped: z.literal(true), reason: z.string().min(1).max(4096) } }, guard(input => sessions.command(input, 'abort', input.reason)));
  server.registerTool('recover_workspace_controller', { description: 'Recover a controller marker only after every controller for this handle has stopped. This never infers stopped writers or retries a mutation.', inputSchema: { ...selection, controllersStopped: z.literal(true) } }, guard(input => sessions.recover(input)));
  server.registerTool('list_workspace_files', { description: 'List ordinary files and directories in an authorized MCP-host workspace', inputSchema: selection }, guard(input => sessions.files(input)));
  const filePath = z.string().min(1).max(1024);
  server.registerTool('read_workspace_file', { description: 'Read at most 64 KiB as base64 from an authorized workspace; no private state or server path is accepted', inputSchema: { ...selection, path: filePath, offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(65536).default(65536) } }, guard(input => sessions.read(input, input.path, input.offset, input.length)));
  server.registerTool('write_workspace_file', { description: 'Write one canonical base64 chunk of at most 64 KiB at an explicit offset. Use truncate:true only for the first chunk at offset 0.', inputSchema: { ...selection, path: filePath, base64: z.string().max(87384), offset: z.number().int().min(0).default(0), truncate: z.boolean().default(false) } }, guard(input => sessions.write(input, input.path, input.base64, input.offset, input.truncate)));
  server.registerTool('delete_workspace_file', { description: 'Remove one regular file from the active local workspace; publication still requires explicit finalize or checkpoint', inputSchema: { ...selection, path: filePath } }, guard(input => sessions.remove(input, input.path)));
  server.registerTool('make_workspace_directory', { description: 'Create an ordinary directory in the active local workspace', inputSchema: { ...selection, path: filePath } }, guard(input => sessions.directoryEntry(input, input.path)));
  return Object.assign(server, { initializePrivateState: () => Promise.all([sessions.initialize(), administration.initialize()]) });
}
export async function main() {
  const server = createMcpServer();
  await server.initializePrivateState();
  await server.connect(new StdioServerTransport());
}
