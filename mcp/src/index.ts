import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { simpleGit } from "simple-git";
import { ulid } from "ulid";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import process from "process";

// ============ Types ============

interface WorkspaceMeta {
  id: string;
  customerId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface Workspace extends WorkspaceMeta {
  latestCommitId: string | null;
}

interface Commit {
  id: string;
  workspaceId: string;
  parentId: string | null;
  metadata: Record<string, unknown>;
  sizeBytes: number;
  createdAt: string;
}

// ============ Storage Layer ============

const DATA_DIR = path.join(process.cwd(), "data");
const WORKSPACES_DIR = path.join(DATA_DIR, "workspaces");
const META_DIR = path.join(DATA_DIR, "workspace-meta");

function ensureDirs() {
  fsSync.mkdirSync(WORKSPACES_DIR, { recursive: true });
  fsSync.mkdirSync(META_DIR, { recursive: true });
}
ensureDirs();

function metaPath(workspaceId: string): string {
  return path.join(META_DIR, `${workspaceId}.json`);
}

function repoPath(workspaceId: string): string {
  return path.join(WORKSPACES_DIR, workspaceId);
}

function gitFor(workspaceId: string) {
  return simpleGit(repoPath(workspaceId));
}

function readMeta(workspaceId: string): WorkspaceMeta | null {
  const p = metaPath(workspaceId);
  if (!fsSync.existsSync(p)) return null;
  return JSON.parse(fsSync.readFileSync(p, "utf-8"));
}

function writeMeta(meta: WorkspaceMeta): void {
  fsSync.writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2), "utf-8");
}

function encodeCommitMessage(
  metadata: Record<string, unknown>,
  files: string[],
  sizeBytes: number
): string {
  const parts: string[] = [];
  if (metadata.agentId) parts.push(`agent: ${metadata.agentId}`);
  if (metadata.taskId) parts.push(`task: ${metadata.taskId}`);
  if (metadata.tags && Array.isArray(metadata.tags) && metadata.tags.length > 0) {
    parts.push(`tags: ${(metadata.tags as string[]).join(",")}`);
  }
  const summary = parts.length > 0 ? parts.join(" | ") : "commit";

  const body = { ...metadata, files, sizeBytes };
  return `${summary}\n---\n${JSON.stringify(body)}`;
}

function parseCommitMessage(message: string): {
  metadata: Record<string, unknown>;
  files: string[];
  sizeBytes: number;
} {
  const sepIndex = message.indexOf("\n---\n");
  if (sepIndex === -1) {
    return { metadata: {}, files: [], sizeBytes: 0 };
  }
  try {
    const json = JSON.parse(message.slice(sepIndex + 5));
    const { files, sizeBytes, ...metadata } = json;
    return { metadata, files: files || [], sizeBytes: sizeBytes || 0 };
  } catch {
    return { metadata: {}, files: [], sizeBytes: 0 };
  }
}

// ============ Workspace Operations ============

async function createWorkspace(customerId: string, name: string): Promise<Workspace> {
  const id = `ws_${ulid()}`;
  const now = new Date().toISOString();
  const dir = repoPath(id);

  await fs.mkdir(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("receive.denyCurrentBranch", "updateInstead");

  const meta: WorkspaceMeta = {
    id,
    customerId,
    name,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  writeMeta(meta);

  return { ...meta, latestCommitId: null };
}

async function getWorkspace(id: string): Promise<Workspace | null> {
  const meta = readMeta(id);
  if (!meta || meta.deletedAt) return null;

  let latestCommitId: string | null = null;
  try {
    const git = gitFor(id);
    const log = await git.log({ maxCount: 1 });
    if (log.latest) latestCommitId = log.latest.hash;
  } catch {
    // No commits yet
  }

  return { ...meta, latestCommitId };
}

async function listWorkspaces(): Promise<Workspace[]> {
  const files = fsSync.readdirSync(META_DIR).filter((f) => f.endsWith(".json"));
  const workspaces: Workspace[] = [];

  for (const file of files) {
    const raw = fsSync.readFileSync(path.join(META_DIR, file), "utf-8");
    const meta: WorkspaceMeta = JSON.parse(raw);
    if (meta.deletedAt) continue;

    let latestCommitId: string | null = null;
    try {
      const git = gitFor(meta.id);
      const log = await git.log({ maxCount: 1 });
      if (log.latest) latestCommitId = log.latest.hash;
    } catch {
      // No commits yet
    }

    workspaces.push({ ...meta, latestCommitId });
  }

  return workspaces;
}

async function deleteWorkspace(id: string): Promise<void> {
  const meta = readMeta(id);
  if (!meta) return;
  meta.deletedAt = new Date().toISOString();
  meta.updatedAt = meta.deletedAt;
  writeMeta(meta);
}

// ============ Commit Operations ============

async function listWorkingTreeFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (current: string, prefix: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), rel);
      } else {
        results.push(rel);
      }
    }
  };
  await walk(dir, "");
  return results;
}

async function pushCommit(
  workspaceId: string,
  files: { path: string; content: string }[],
  metadata: Record<string, unknown>
): Promise<{ commitId: string; parentId: string | null; sizeBytes: number; createdAt: string }> {
  const dir = repoPath(workspaceId);
  const git = gitFor(workspaceId);

  let parentId: string | null = null;
  try {
    const log = await git.log({ maxCount: 1 });
    if (log.latest) parentId = log.latest.hash;
  } catch {
    // First commit
  }

  // Clear working tree
  const existingFiles = await listWorkingTreeFiles(dir);
  for (const f of existingFiles) {
    await fs.unlink(path.join(dir, f)).catch(() => {});
  }

  // Write new files
  let sizeBytes = 0;
  for (const file of files) {
    const filePath = path.join(dir, file.path);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, file.content, "utf-8");
    sizeBytes += Buffer.byteLength(file.content, "utf-8");
  }

  const filePaths = files.map((f) => f.path);
  const message = encodeCommitMessage(metadata, filePaths, sizeBytes);

  await git.add("-A");
  const result = await git.commit(message);
  let commitId = result.commit || "";

  if (!commitId) {
    const log = await git.log({ maxCount: 1 });
    commitId = log.latest?.hash || "";
  }

  const createdAt = new Date().toISOString();

  const meta = readMeta(workspaceId);
  if (meta) {
    meta.updatedAt = createdAt;
    writeMeta(meta);
  }

  return { commitId, parentId, sizeBytes, createdAt };
}

async function pullCommit(
  workspaceId: string,
  version?: string
): Promise<{
  commitId: string;
  parentId: string | null;
  files: { path: string; content: string }[];
  metadata: Record<string, unknown>;
  sizeBytes: number;
  createdAt: string;
} | null> {
  const git = gitFor(workspaceId);

  let targetHash: string;
  try {
    if (version) {
      targetHash = version;
    } else {
      const log = await git.log({ maxCount: 1 });
      if (!log.latest) return null;
      targetHash = log.latest.hash;
    }
  } catch {
    return null;
  }

  const rawLog = await git.raw([
    "log", "-1",
    "--format=format:%H%x00%P%x00%aI%x00%B",
    targetHash
  ]);
  const parts = rawLog.split("\x00");
  const [hash, parentHash, dateStr, body] = parts;
  const { metadata, sizeBytes } = parseCommitMessage(body);

  const treeRaw = await git.raw(["ls-tree", "-r", "--name-only", targetHash]);
  const filePaths = treeRaw.trim().split("\n").filter(Boolean);

  const files: { path: string; content: string }[] = [];
  for (const fp of filePaths) {
    const content = await git.raw(["show", `${targetHash}:${fp}`]);
    files.push({ path: fp, content });
  }

  return {
    commitId: hash,
    parentId: parentHash || null,
    files,
    metadata,
    sizeBytes,
    createdAt: dateStr,
  };
}

async function getHistory(workspaceId: string, limit: number = 20): Promise<Commit[]> {
  const git = gitFor(workspaceId);

  try {
    const raw = await git.raw([
      "log",
      `--max-count=${limit}`,
      "--format=%H %P %aI"
    ]);

    if (!raw.trim()) return [];

    const commits: Commit[] = [];
    const lines = raw.trim().split("\n");

    for (const line of lines) {
      const [hash, parent, dateStr] = line.split(" ");
      const parentHash = parent || null;

      const msgRaw = await git.raw(["log", "-1", "--format=%B", hash]);
      const { metadata, sizeBytes } = parseCommitMessage(msgRaw.trim());

      commits.push({
        id: hash,
        workspaceId,
        parentId: parentHash,
        metadata,
        sizeBytes,
        createdAt: dateStr,
      });
    }

    return commits;
  } catch {
    return [];
  }
}

async function getDiff(
  workspaceId: string,
  from: string,
  to: string
): Promise<{ added: string[]; removed: string[]; modified: string[] }> {
  const git = gitFor(workspaceId);

  const raw = await git.raw(["diff", "--name-status", from, to]);
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];

  for (const line of raw.trim().split("\n").filter(Boolean)) {
    const [status, ...fileParts] = line.split("\t");
    const filePath = fileParts.join("\t");
    switch (status) {
      case "A": added.push(filePath); break;
      case "D": removed.push(filePath); break;
      case "M": modified.push(filePath); break;
    }
  }

  return { added, removed, modified };
}

async function rollbackWorkspace(
  workspaceId: string,
  toVersion: string,
  metadata: Record<string, unknown>
): Promise<{ commitId: string; parentId: string | null; sizeBytes: number; createdAt: string; files: string[] }> {
  const git = gitFor(workspaceId);

  let parentId: string | null = null;
  try {
    const log = await git.log({ maxCount: 1 });
    if (log.latest) parentId = log.latest.hash;
  } catch {
    // empty
  }

  const treeRaw = await git.raw(["ls-tree", "-r", "--name-only", toVersion]);
  const files = treeRaw.trim().split("\n").filter(Boolean);

  await git.raw(["checkout", toVersion, "--", "."]);
  await git.add("-A");

  const dir = repoPath(workspaceId);
  let sizeBytes = 0;
  for (const f of files) {
    try {
      const stat = await fs.stat(path.join(dir, f));
      sizeBytes += stat.size;
    } catch {
      // file might not exist
    }
  }

  const rollbackMetadata = { ...metadata, rollbackFrom: toVersion };
  const message = encodeCommitMessage(rollbackMetadata, files, sizeBytes);

  const result = await git.commit(message, { "--allow-empty": null });
  let commitId = result.commit || "";
  if (!commitId) {
    const log = await git.log({ maxCount: 1 });
    commitId = log.latest?.hash || "";
  }

  const createdAt = new Date().toISOString();

  const meta = readMeta(workspaceId);
  if (meta) {
    meta.updatedAt = createdAt;
    writeMeta(meta);
  }

  return { commitId, parentId, sizeBytes, createdAt, files };
}

// ============ MCP Server ============

const WORKSPACE_ID_REGEX = /^ws_[A-Za-z0-9]{10,26}$/;

async function main() {
  const server = new McpServer({
    name: "contextvault-mcp",
    version: "0.1.0"
  });

  // Workspace management tools
  server.registerTool("create_workspace", {
    description: "Create a new workspace for storing agent context and files",
    inputSchema: {
      customerId: { type: "string", description: "Customer ID this workspace belongs to" },
      name: { type: "string", description: "Human-readable name for the workspace" },
    }
  }, async ({ customerId, name }: { customerId: string; name: string }) => {
    const result = await createWorkspace(customerId, name);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool("list_workspaces", {
    description: "List all workspaces, optionally filtered by customer",
    inputSchema: {
      customerId: { type: "string", description: "Filter by customer ID" }
    }
  }, async ({ customerId }: { customerId?: string }) => {
    const workspaces = await listWorkspaces();
    const filtered = customerId 
      ? workspaces.filter(w => w.customerId === customerId)
      : workspaces;
    return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
  });

  server.registerTool("get_workspace", {
    description: "Get details of a specific workspace",
    inputSchema: {
      workspaceId: { type: "string", description: "Workspace ID (format: ws_<ulid>)" },
    }
  }, async ({ workspaceId }: { workspaceId: string }) => {
    if (!WORKSPACE_ID_REGEX.test(workspaceId)) {
      return { content: [{ type: "text", text: `Invalid workspace ID format: ${workspaceId}` }], isError: true };
    }
    const ws = await getWorkspace(workspaceId);
    if (!ws) {
      return { content: [{ type: "text", text: `Workspace ${workspaceId} not found` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(ws, null, 2) }] };
  });

  server.registerTool("delete_workspace", {
    description: "Soft-delete a workspace",
    inputSchema: {
      workspaceId: { type: "string", description: "Workspace ID to delete" },
    }
  }, async ({ workspaceId }: { workspaceId: string }) => {
    if (!WORKSPACE_ID_REGEX.test(workspaceId)) {
      return { content: [{ type: "text", text: `Invalid workspace ID format: ${workspaceId}` }], isError: true };
    }
    await deleteWorkspace(workspaceId);
    return { content: [{ type: "text", text: `Workspace ${workspaceId} deleted` }] };
  });

  // Commit operations
  server.registerTool("push_to_workspace", {
    description: "Push files to a workspace as a new commit (agent saves state)",
    inputSchema: {
      workspaceId: { type: "string", description: "Target workspace ID" },
      files: { 
        type: "array", 
        description: "Files to push",
        items: {
          path: { type: "string", description: "File path within workspace" },
          content: { type: "string", description: "File content" },
        }
      },
      agentId: { type: "string", description: "ID of the agent pushing" },
      taskId: { type: "string", description: "Current task ID" },
      tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
    }
  }, async ({ workspaceId, files, agentId, taskId, tags }: { 
    workspaceId: string; 
    files: { path: string; content: string }[];
    agentId?: string;
    taskId?: string;
    tags?: string[];
  }) => {
    if (!WORKSPACE_ID_REGEX.test(workspaceId)) {
      return { content: [{ type: "text", text: `Invalid workspace ID format: ${workspaceId}` }], isError: true };
    }
    const metadata: Record<string, unknown> = {};
    if (agentId) metadata.agentId = agentId;
    if (taskId) metadata.taskId = taskId;
    if (tags) metadata.tags = tags;

    const result = await pushCommit(workspaceId, files, metadata);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool("pull_from_workspace", {
    description: "Pull files from a workspace (agent restores state)",
    inputSchema: {
      workspaceId: { type: "string", description: "Workspace to pull from" },
      version: { type: "string", description: "Specific commit hash to pull (optional, defaults to HEAD)" },
    }
  }, async ({ workspaceId, version }: { workspaceId: string; version?: string }) => {
    if (!WORKSPACE_ID_REGEX.test(workspaceId)) {
      return { content: [{ type: "text", text: `Invalid workspace ID format: ${workspaceId}` }], isError: true };
    }
    const result = await pullCommit(workspaceId, version);
    if (!result) {
      return { content: [{ type: "text", text: `No commits found in workspace ${workspaceId}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool("get_workspace_history", {
    description: "Get commit history for a workspace",
    inputSchema: {
      workspaceId: { type: "string", description: "Workspace ID" },
      limit: { type: "number", description: "Max commits to return (default 20)" },
    }
  }, async ({ workspaceId, limit }: { workspaceId: string; limit?: number }) => {
    if (!WORKSPACE_ID_REGEX.test(workspaceId)) {
      return { content: [{ type: "text", text: `Invalid workspace ID format: ${workspaceId}` }], isError: true };
    }
    const history = await getHistory(workspaceId, limit || 20);
    return { content: [{ type: "text", text: JSON.stringify(history, null, 2) }] };
  });

  server.registerTool("diff_workspace", {
    description: "Compare two versions of a workspace",
    inputSchema: {
      workspaceId: { type: "string", description: "Workspace ID" },
      from: { type: "string", description: "Source commit hash" },
      to: { type: "string", description: "Target commit hash" },
    }
  }, async ({ workspaceId, from, to }: { workspaceId: string; from: string; to: string }) => {
    if (!WORKSPACE_ID_REGEX.test(workspaceId)) {
      return { content: [{ type: "text", text: `Invalid workspace ID format: ${workspaceId}` }], isError: true };
    }
    const diff = await getDiff(workspaceId, from, to);
    return { content: [{ type: "text", text: JSON.stringify(diff, null, 2) }] };
  });

  server.registerTool("rollback_workspace", {
    description: "Rollback a workspace to a previous version (creates new commit)",
    inputSchema: {
      workspaceId: { type: "string", description: "Workspace ID" },
      toVersion: { type: "string", description: "Commit hash to rollback to" },
      agentId: { type: "string", description: "Agent performing rollback" },
    }
  }, async ({ workspaceId, toVersion, agentId }: { workspaceId: string; toVersion: string; agentId?: string }) => {
    if (!WORKSPACE_ID_REGEX.test(workspaceId)) {
      return { content: [{ type: "text", text: `Invalid workspace ID format: ${workspaceId}` }], isError: true };
    }
    const metadata: Record<string, unknown> = {};
    if (agentId) metadata.agentId = agentId;

    const result = await rollbackWorkspace(workspaceId, toVersion, metadata);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ContextVault MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
