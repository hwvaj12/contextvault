// ContextVault MCP Server
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import simpleGit from "simple-git";
import { ulid } from "ulid";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import process from "process";
import * as z from "zod";

// ============ Storage Layer ============

const DATA_DIR = path.join(process.cwd(), "data");
const WORKSPACES_DIR = path.join(DATA_DIR, "workspaces");
const SANDBOX_DIR = path.join(DATA_DIR, "sandboxes");
const META_DIR = path.join(DATA_DIR, "workspace-meta");

function ensureDirs() {
  fsSync.mkdirSync(WORKSPACES_DIR, { recursive: true });
  fsSync.mkdirSync(SANDBOX_DIR, { recursive: true });
  fsSync.mkdirSync(META_DIR, { recursive: true });
}
ensureDirs();

function metaPath(workspaceId) { return path.join(META_DIR, `${workspaceId}.json`); }
function repoPath(workspaceId) { return path.join(WORKSPACES_DIR, workspaceId); }
function sandboxPath(workspaceId) { return path.join(SANDBOX_DIR, workspaceId); }
function gitFor(workspaceId) { return simpleGit(repoPath(workspaceId)); }
function gitForSandbox(workspaceId) { return simpleGit(sandboxPath(workspaceId)); }

function readMeta(workspaceId) {
  const p = metaPath(workspaceId);
  if (!fsSync.existsSync(p)) return null;
  return JSON.parse(fsSync.readFileSync(p, "utf-8"));
}

function writeMeta(meta) {
  fsSync.writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2), "utf-8");
}

function encodeCommitMessage(metadata, files, sizeBytes) {
  const parts = [];
  if (metadata.agentId) parts.push(`agent: ${metadata.agentId}`);
  if (metadata.taskId) parts.push(`task: ${metadata.taskId}`);
  if (metadata.tags?.length) parts.push(`tags: ${metadata.tags.join(",")}`);
  const summary = parts.length > 0 ? parts.join(" | ") : "commit";
  const body = { ...metadata, files, sizeBytes };
  return `${summary}\n---\n${JSON.stringify(body)}`;
}

function parseCommitMessage(message) {
  const sepIndex = message.indexOf("\n---\n");
  if (sepIndex === -1) return { metadata: {}, files: [], sizeBytes: 0 };
  try {
    const json = JSON.parse(message.slice(sepIndex + 5));
    const { files, sizeBytes, ...metadata } = json;
    return { metadata, files: files || [], sizeBytes: sizeBytes || 0 };
  } catch { return { metadata: {}, files: [], sizeBytes: 0 }; }
}

// ============ Workspace Operations ============

async function createWorkspace(customerId, name) {
  const id = `ws_${ulid()}`;
  const now = new Date().toISOString();
  const dir = repoPath(id);
  await fs.mkdir(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("receive.denyCurrentBranch", "updateInstead");
  const meta = { id, customerId, name, createdAt: now, updatedAt: now, deletedAt: null };
  writeMeta(meta);
  return { ...meta, latestCommitId: null };
}

async function getWorkspace(id) {
  const meta = readMeta(id);
  if (!meta || meta.deletedAt) return null;
  let latestCommitId = null;
  try {
    const git = gitFor(id);
    const log = await git.log({ maxCount: 1 });
    if (log.latest) latestCommitId = log.latest.hash;
  } catch {}
  return { ...meta, latestCommitId };
}

async function listWorkspaces() {
  const files = fsSync.readdirSync(META_DIR).filter(f => f.endsWith(".json"));
  const workspaces = [];
  for (const file of files) {
    const meta = JSON.parse(fsSync.readFileSync(path.join(META_DIR, file), "utf-8"));
    if (meta.deletedAt) continue;
    let latestCommitId = null;
    try {
      const git = gitFor(meta.id);
      const log = await git.log({ maxCount: 1 });
      if (log.latest) latestCommitId = log.latest.hash;
    } catch {}
    workspaces.push({ ...meta, latestCommitId });
  }
  return workspaces;
}

async function deleteWorkspace(id) {
  const meta = readMeta(id);
  if (!meta) return;
  meta.deletedAt = new Date().toISOString();
  meta.updatedAt = meta.deletedAt;
  writeMeta(meta);
}

// ============ Commit Operations ============

async function listWorkingTreeFiles(dir) {
  const results = [];
  const walk = async (current, prefix) => {
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

async function pushCommit(workspaceId, files, metadata) {
  const dir = repoPath(workspaceId);
  const git = gitFor(workspaceId);
  let parentId = null;
  try {
    const log = await git.log({ maxCount: 1 });
    if (log.latest) parentId = log.latest.hash;
  } catch {}

  const existingFiles = await listWorkingTreeFiles(dir);
  for (const f of existingFiles) {
    try { await fs.unlink(path.join(dir, f)); } catch {}
  }

  let sizeBytes = 0;
  for (const file of files) {
    const filePath = path.join(dir, file.path);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, file.content, "utf-8");
    sizeBytes += Buffer.byteLength(file.content, "utf-8");
  }

  const filePaths = files.map(f => f.path);
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
  if (meta) { meta.updatedAt = createdAt; writeMeta(meta); }
  return { commitId, parentId, sizeBytes, createdAt };
}

async function pullCommit(workspaceId, version) {
  const git = gitFor(workspaceId);
  let targetHash;
  try {
    if (version) {
      targetHash = version;
    } else {
      const log = await git.log({ maxCount: 1 });
      if (!log.latest) return null;
      targetHash = log.latest.hash;
    }
  } catch { return null; }

  const rawLog = await git.raw(["log", "-1", "--format=format:%H%x00%P%x00%aI%x00%B", targetHash]);
  const [hash, parentHash, dateStr, body] = rawLog.split("\x00");
  const { metadata, sizeBytes } = parseCommitMessage(body);

  const treeRaw = await git.raw(["ls-tree", "-r", "--name-only", targetHash]);
  const filePaths = treeRaw.trim().split("\n").filter(Boolean);

  const files = [];
  for (const fp of filePaths) {
    const content = await git.raw(["show", `${targetHash}:${fp}`]);
    files.push({ path: fp, content });
  }
  return { commitId: hash, parentId: parentHash || null, files, metadata, sizeBytes, createdAt: dateStr };
}

async function getHistory(workspaceId, limit = 20) {
  const git = gitFor(workspaceId);
  try {
    const raw = await git.raw(["log", `--max-count=${limit}`, "--format=%H %P %aI"]);
    if (!raw.trim()) return [];
    const commits = [];
    for (const line of raw.trim().split("\n")) {
      const [hash, parent, dateStr] = line.split(" ");
      const msgRaw = await git.raw(["log", "-1", "--format=%B", hash]);
      const { metadata, sizeBytes } = parseCommitMessage(msgRaw.trim());
      commits.push({ id: hash, workspaceId, parentId: parent || null, metadata, sizeBytes, createdAt: dateStr });
    }
    return commits;
  } catch { return []; }
}

async function getDiff(workspaceId, from, to) {
  const git = gitFor(workspaceId);
  const raw = await git.raw(["diff", "--name-status", from, to]);
  const added = [], removed = [], modified = [];
  for (const line of raw.trim().split("\n").filter(Boolean)) {
    const [status, ...fp] = line.split("\t");
    if (status === "A") added.push(fp.join("\t"));
    else if (status === "D") removed.push(fp.join("\t"));
    else if (status === "M") modified.push(fp.join("\t"));
  }
  return { added, removed, modified };
}

async function rollbackWorkspace(workspaceId, toVersion, metadata) {
  const git = gitFor(workspaceId);
  let parentId = null;
  try {
    const log = await git.log({ maxCount: 1 });
    if (log.latest) parentId = log.latest.hash;
  } catch {}

  const treeRaw = await git.raw(["ls-tree", "-r", "--name-only", toVersion]);
  const files = treeRaw.trim().split("\n").filter(Boolean);
  await git.raw(["checkout", toVersion, "--", "."]);
  await git.add("-A");

  let sizeBytes = 0;
  for (const f of files) {
    try { const stat = await fs.stat(path.join(repoPath(workspaceId), f)); sizeBytes += stat.size; } catch {}
  }

  const rollbackMetadata = { ...metadata, rollbackFrom: toVersion };
  const message = encodeCommitMessage(rollbackMetadata, files, sizeBytes);
  const result = await git.commit(message);
  let commitId = result.commit || "";
  if (!commitId) {
    const log = await git.log({ maxCount: 1 });
    commitId = log.latest?.hash || "";
  }

  const createdAt = new Date().toISOString();
  const meta = readMeta(workspaceId);
  if (meta) { meta.updatedAt = createdAt; writeMeta(meta); }
  return { commitId, parentId, sizeBytes, createdAt, files };
}

// ============ Sandbox Operations ============

async function checkoutWorkspace(workspaceId) {
  const src = repoPath(workspaceId);
  const dest = sandboxPath(workspaceId);

  // Verify source exists
  if (!fsSync.existsSync(src)) {
    throw new Error(`Workspace ${workspaceId} does not exist`);
  }

  // Remove existing sandbox if present
  if (fsSync.existsSync(dest)) {
    await fs.rm(dest, { recursive: true, force: true });
  }

  // Create sandbox directory
  fsSync.mkdirSync(dest, { recursive: true });

  // Clone from persistent to sandbox (with working tree)
  const git = simpleGit(src);
  const log = await git.log({ maxCount: 1 });

  if (log.latest) {
    // Clone to sandbox with working tree
    await git.clone(src, dest, ['--single-branch', '--branch', 'main']);
    const sandboxGit = simpleGit(dest);
    // Checkout to the latest commit
    await sandboxGit.checkout(log.latest.hash);
  } else {
    // Empty workspace - just init
    const sandboxGit = simpleGit(dest);
    await sandboxGit.init();
    await sandboxGit.addConfig("receive.denyCurrentBranch", "updateInstead");
  }

  return { sandboxPath: dest };
}

async function commitWorkspace(workspaceId, agentId, taskId, tags) {
  const sandbox = sandboxPath(workspaceId);
  const persistent = repoPath(workspaceId);

  // Verify sandbox exists
  if (!fsSync.existsSync(sandbox)) {
    throw new Error(`Sandbox ${workspaceId} does not exist`);
  }

  const sandboxGit = gitForSandbox(workspaceId);

  // Check if there are changes to commit
  const status = await sandboxGit.status();
  if (status.files.length === 0) {
    throw new Error("No changes to commit in sandbox");
  }

  // Commit in sandbox
  const metadata = {};
  if (agentId) metadata.agentId = agentId;
  if (taskId) metadata.taskId = taskId;
  if (tags) metadata.tags = tags;

  const filePaths = status.files;
  const message = encodeCommitMessage(metadata, filePaths, 0);

  await sandboxGit.add("-A");
  const result = await sandboxGit.commit(message);
  let commitId = result.commit || "";
  if (!commitId) {
    const log = await sandboxGit.log({ maxCount: 1 });
    commitId = log.latest?.hash || "";
  }

  // Push to persistent storage - handle files directly
  const persistentGit = gitFor(workspaceId);
  
  // Get the committed files from sandbox
  const treeRaw = await sandboxGit.raw(["ls-tree", "-r", "--name-only", commitId]);
  const files = treeRaw.trim().split("\n").filter(Boolean);
  
  // Sync files to persistent storage
  for (const fp of files) {
    const content = await sandboxGit.raw(["show", `${commitId}:${fp}`]);
    const filePath = path.join(persistent, fp);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
  }
  
  // Commit to persistent storage
  await persistentGit.add("-A");
  const persistResult = await persistentGit.commit(message);
  let persistCommitId = persistResult.commit || "";
  if (!persistCommitId) {
    const log = await persistentGit.log({ maxCount: 1 });
    persistCommitId = log.latest?.hash || "";
  }

  return { commitId: persistCommitId };
}

async function destroySandbox(workspaceId) {
  const sandbox = sandboxPath(workspaceId);

  if (fsSync.existsSync(sandbox)) {
    await fs.rm(sandbox, { recursive: true, force: true });
  }

  return { success: true };
}

async function getSandboxStatus(workspaceId) {
  const sandbox = sandboxPath(workspaceId);
  const exists = fsSync.existsSync(sandbox);

  if (!exists) {
    return { exists: false, path: sandbox, hasChanges: false };
  }

  let hasChanges = false;
  try {
    const sandboxGit = gitForSandbox(workspaceId);
    const status = await sandboxGit.status();
    hasChanges = status.files.length > 0;
  } catch {}

  return { exists: true, path: sandbox, hasChanges };
}

// ============ MCP Server ============

const WORKSPACE_ID_REGEX = /^ws_[A-Za-z0-9]{10,26}$/;

const mcpServer = new McpServer({ name: "contextvault-mcp", version: "0.1.0" });

mcpServer.registerTool("create_workspace", {
  description: "Create a new workspace",
  inputSchema: {
    customerId: z.string().describe("Customer ID"),
    name: z.string().describe("Workspace name"),
  }
}, async ({ customerId, name }) => {
  const result = await createWorkspace(customerId, name);
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

mcpServer.registerTool("list_workspaces", {
  description: "List all workspaces",
  inputSchema: {}
}, async () => {
  const workspaces = await listWorkspaces();
  return { content: [{ type: "text", text: JSON.stringify(workspaces) }] };
});

mcpServer.registerTool("get_workspace", {
  description: "Get workspace details",
  inputSchema: { workspaceId: z.string().describe("Workspace ID") }
}, async ({ workspaceId }) => {
  if (!WORKSPACE_ID_REGEX.test(workspaceId)) {
    return { content: [{ type: "text", text: "Invalid workspace ID" }], isError: true };
  }
  const ws = await getWorkspace(workspaceId);
  if (!ws) return { content: [{ type: "text", text: "Workspace not found" }], isError: true };
  return { content: [{ type: "text", text: JSON.stringify(ws) }] };
});

mcpServer.registerTool("delete_workspace", {
  description: "Delete a workspace",
  inputSchema: { workspaceId: z.string().describe("Workspace ID") }
}, async ({ workspaceId }) => {
  if (!WORKSPACE_ID_REGEX.test(workspaceId)) {
    return { content: [{ type: "text", text: "Invalid workspace ID" }], isError: true };
  }
  await deleteWorkspace(workspaceId);
  return { content: [{ type: "text", text: `Deleted ${workspaceId}` }] };
});

mcpServer.registerTool("push_to_workspace", {
  description: "Push files to workspace",
  inputSchema: {
    workspaceId: z.string().describe("Workspace ID"),
    files: z.array(z.object({ path: z.string(), content: z.string() })).describe("Files to push"),
    agentId: z.string().optional().describe("Agent ID"),
    taskId: z.string().optional().describe("Task ID"),
    tags: z.array(z.string()).optional().describe("Tags"),
  }
}, async ({ workspaceId, files, agentId, taskId, tags }) => {
  if (!WORKSPACE_ID_REGEX.test(workspaceId)) {
    return { content: [{ type: "text", text: "Invalid workspace ID" }], isError: true };
  }
  const metadata = {};
  if (agentId) metadata.agentId = agentId;
  if (taskId) metadata.taskId = taskId;
  if (tags) metadata.tags = tags;
  const result = await pushCommit(workspaceId, files, metadata);
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

mcpServer.registerTool("pull_from_workspace", {
  description: "Pull files from workspace",
  inputSchema: {
    workspaceId: z.string().describe("Workspace ID"),
    version: z.string().optional().describe("Commit hash (optional, defaults to HEAD"),
  }
}, async ({ workspaceId, version }) => {
  if (!WORKSPACE_ID_REGEX.test(workspaceId)) {
    return { content: [{ type: "text", text: "Invalid workspace ID" }], isError: true };
  }
  const result = await pullCommit(workspaceId, version);
  if (!result) return { content: [{ type: "text", text: "No commits found" }], isError: true };
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

mcpServer.registerTool("get_workspace_history", {
  description: "Get workspace history",
  inputSchema: {
    workspaceId: z.string().describe("Workspace ID"),
    limit: z.number().optional().describe("Max commits (default 20)"),
  }
}, async ({ workspaceId, limit }) => {
  if (!WORKSPACE_ID_REGEX.test(workspaceId)) {
    return { content: [{ type: "text", text: "Invalid workspace ID" }], isError: true };
  }
  const history = await getHistory(workspaceId, limit || 20);
  return { content: [{ type: "text", text: JSON.stringify(history) }] };
});

mcpServer.registerTool("diff_workspace", {
  description: "Compare two versions",
  inputSchema: {
    workspaceId: z.string().describe("Workspace ID"),
    from: z.string().describe("Source commit"),
    to: z.string().describe("Target commit"),
  }
}, async ({ workspaceId, from, to }) => {
  if (!WORKSPACE_ID_REGEX.test(workspaceId)) {
    return { content: [{ type: "text", text: "Invalid workspace ID" }], isError: true };
  }
  const diff = await getDiff(workspaceId, from, to);
  return { content: [{ type: "text", text: JSON.stringify(diff) }] };
});

mcpServer.registerTool("rollback_workspace", {
  description: "Rollback to previous version",
  inputSchema: {
    workspaceId: z.string().describe("Workspace ID"),
    toVersion: z.string().describe("Commit to rollback to"),
    agentId: z.string().optional().describe("Agent performing rollback"),
  }
}, async ({ workspaceId, toVersion, agentId }) => {
  if (!WORKSPACE_ID_REGEX.test(workspaceId)) {
    return { content: [{ type: "text", text: "Invalid workspace ID" }], isError: true };
  }
  const metadata = {};
  if (agentId) metadata.agentId = agentId;
  const result = await rollbackWorkspace(workspaceId, toVersion, metadata);
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

mcpServer.registerTool("checkout_workspace", {
  description: "Checkout a workspace into a sandbox for editing",
  inputSchema: {
    workspaceId: z.string().describe("Workspace ID to checkout"),
  }
}, async ({ workspaceId }) => {
  if (!WORKSPACE_ID_REGEX.test(workspaceId)) {
    return { content: [{ type: "text", text: "Invalid workspace ID" }], isError: true };
  }
  try {
    const result = await checkoutWorkspace(workspaceId);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err) {
    return { content: [{ type: "text", text: err.message }], isError: true };
  }
});

mcpServer.registerTool("commit_workspace", {
  description: "Commit sandbox changes back to the persistent workspace",
  inputSchema: {
    workspaceId: z.string().describe("Workspace ID"),
    agentId: z.string().optional().describe("Agent ID"),
    taskId: z.string().optional().describe("Task ID"),
    tags: z.array(z.string()).optional().describe("Tags"),
  }
}, async ({ workspaceId, agentId, taskId, tags }) => {
  if (!WORKSPACE_ID_REGEX.test(workspaceId)) {
    return { content: [{ type: "text", text: "Invalid workspace ID" }], isError: true };
  }
  try {
    const result = await commitWorkspace(workspaceId, agentId, taskId, tags);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err) {
    return { content: [{ type: "text", text: err.message }], isError: true };
  }
});

mcpServer.registerTool("destroy_workspace", {
  description: "Destroy a workspace sandbox (does not affect persistent storage)",
  inputSchema: {
    workspaceId: z.string().describe("Workspace ID"),
  }
}, async ({ workspaceId }) => {
  if (!WORKSPACE_ID_REGEX.test(workspaceId)) {
    return { content: [{ type: "text", text: "Invalid workspace ID" }], isError: true };
  }
  const result = await destroySandbox(workspaceId);
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

mcpServer.registerTool("get_sandbox_status", {
  description: "Get sandbox status for a workspace",
  inputSchema: {
    workspaceId: z.string().describe("Workspace ID"),
  }
}, async ({ workspaceId }) => {
  if (!WORKSPACE_ID_REGEX.test(workspaceId)) {
    return { content: [{ type: "text", text: "Invalid workspace ID" }], isError: true };
  }
  const result = await getSandboxStatus(workspaceId);
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("ContextVault MCP server running on stdio");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
