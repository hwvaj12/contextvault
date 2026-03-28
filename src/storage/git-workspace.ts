import simpleGit, { SimpleGit } from "simple-git";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { Workspace, Commit, CreateWorkspaceInput, IStorage } from "./interfaces";

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

function gitFor(workspaceId: string): SimpleGit {
  return simpleGit(repoPath(workspaceId));
}

interface WorkspaceMeta {
  id: string;
  customerId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
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
    parts.push(`tags: ${metadata.tags.join(",")}`);
  }
  const summary = parts.length > 0 ? parts.join(" | ") : "commit";

  const body: Record<string, unknown> = { ...metadata, files, sizeBytes };
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

export class GitStorage implements IStorage {
  // --- Workspace CRUD (JSON metadata files) ---

  async createWorkspace(data: CreateWorkspaceInput): Promise<Workspace> {
    const now = new Date().toISOString();
    const dir = repoPath(data.id);

    await fs.mkdir(dir, { recursive: true });
    const git = simpleGit(dir);
    await git.init();
    // Allow pushes to the checked-out branch (updates working tree automatically)
    await git.addConfig("receive.denyCurrentBranch", "updateInstead");

    const meta: WorkspaceMeta = {
      id: data.id,
      customerId: data.customerId,
      name: data.name,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    writeMeta(meta);

    return { ...meta, latestCommitId: null };
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    const meta = readMeta(id);
    if (!meta || meta.deletedAt) return null;

    let latestCommitId: string | null = null;
    try {
      const git = gitFor(id);
      const log = await git.log({ maxCount: 1 });
      if (log.latest) {
        latestCommitId = log.latest.hash;
      }
    } catch {
      // No commits yet
    }

    return { ...meta, latestCommitId };
  }

  async listWorkspaces(): Promise<Workspace[]> {
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

  async deleteWorkspace(id: string): Promise<void> {
    const meta = readMeta(id);
    if (!meta) return;
    meta.deletedAt = new Date().toISOString();
    meta.updatedAt = meta.deletedAt;
    writeMeta(meta);
  }

  async updateLatestCommit(_id: string, _commitId: string, _updatedAt: string): Promise<void> {
    // No-op: latestCommitId is derived from git HEAD
  }

  // --- Git commit operations ---

  async pushCommit(
    workspaceId: string,
    files: { path: string; content: string }[],
    metadata: Record<string, unknown>
  ): Promise<{ commitId: string; parentId: string | null; sizeBytes: number; createdAt: string }> {
    const dir = repoPath(workspaceId);
    const git = gitFor(workspaceId);

    // Get current HEAD as parentId
    let parentId: string | null = null;
    try {
      const log = await git.log({ maxCount: 1 });
      if (log.latest) parentId = log.latest.hash;
    } catch {
      // First commit
    }

    // Clear working tree (remove all tracked files) so only pushed files remain
    const existingFiles = await this.listWorkingTreeFiles(dir);
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
    const commitId = result.commit || "";

    // If commit was empty (no changes), get HEAD
    let finalCommitId = commitId;
    if (!finalCommitId) {
      const log = await git.log({ maxCount: 1 });
      finalCommitId = log.latest?.hash || "";
    }

    const createdAt = new Date().toISOString();

    // Update workspace meta timestamp
    const meta = readMeta(workspaceId);
    if (meta) {
      meta.updatedAt = createdAt;
      writeMeta(meta);
    }

    return { commitId: finalCommitId, parentId, sizeBytes, createdAt };
  }

  async pullCommit(
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

    // Use null byte as separator (guaranteed unique, not in any field)
    const rawLog = await git.raw([
      "log", "-1",
      "--format=format:%H%x00%P%x00%aI%x00%B",
      targetHash
    ]);
    const parts = rawLog.split("\x00");
    const [hash, parentHash, dateStr, body] = parts;
    const { metadata, sizeBytes } = parseCommitMessage(body);

    // Get file list at this commit
    const treeRaw = await git.raw(["ls-tree", "-r", "--name-only", targetHash]);
    const filePaths = treeRaw.trim().split("\n").filter(Boolean);

    // Read file contents at this commit
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

  async getHistory(
    workspaceId: string,
    limit: number = 20
  ): Promise<Commit[]> {
    const git = gitFor(workspaceId);

    try {
      // Use raw git to get hash, parent, date per line
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
        
        // Get commit message separately
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

  async getDiff(
    workspaceId: string,
    from: string,
    to: string
  ): Promise<{ added: string[]; removed: string[]; modified: string[]; unchanged: string[] }> {
    const git = gitFor(workspaceId);

    const raw = await git.raw(["diff", "--name-status", from, to]);
    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];

    for (const line of raw.trim().split("\n").filter(Boolean)) {
      const [status, ...fileParts] = line.split("\t");
      const filePath = fileParts.join("\t");
      switch (status) {
        case "A":
          added.push(filePath);
          break;
        case "D":
          removed.push(filePath);
          break;
        case "M":
          modified.push(filePath);
          break;
      }
    }

    // Get all files at 'to' commit for unchanged calculation
    const toTreeRaw = await git.raw(["ls-tree", "-r", "--name-only", to]);
    const toFiles = new Set(toTreeRaw.trim().split("\n").filter(Boolean));
    const changedFiles = new Set([...added, ...removed, ...modified]);
    const unchanged = [...toFiles].filter((f) => !changedFiles.has(f));

    return { added, removed, modified, unchanged };
  }

  async rollback(
    workspaceId: string,
    commitHash: string,
    metadata: Record<string, unknown>
  ): Promise<{ commitId: string; parentId: string | null; sizeBytes: number; createdAt: string; files: string[] }> {
    const git = gitFor(workspaceId);

    // Get current HEAD as parentId
    let parentId: string | null = null;
    try {
      const log = await git.log({ maxCount: 1 });
      if (log.latest) parentId = log.latest.hash;
    } catch {
      // empty
    }

    // Get files at target commit to include in commit message
    const treeRaw = await git.raw(["ls-tree", "-r", "--name-only", commitHash]);
    const files = treeRaw.trim().split("\n").filter(Boolean);

    // Revert: checkout the target commit's files into working tree
    await git.raw(["checkout", commitHash, "--", "."]);
    await git.add("-A");

    // Calculate size
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

    const rollbackMetadata = { ...metadata, rollbackFrom: commitHash };
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

  // --- IStorage commit methods (thin wrappers) ---

  async createCommit(): Promise<Commit> {
    throw new Error("Use pushCommit() instead");
  }

  async listCommits(workspaceId: string, limit?: number): Promise<Commit[]> {
    return this.getHistory(workspaceId, limit);
  }

  // --- Helpers ---

  private async listWorkingTreeFiles(dir: string): Promise<string[]> {
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
}
