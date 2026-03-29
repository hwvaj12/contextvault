import simpleGit from "simple-git";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { ulid } from "ulid";

const DATA_DIR = path.join(process.cwd(), "data");
const WORKSPACES_DIR = path.join(DATA_DIR, "workspaces");
const SANDBOX_DIR = path.join(DATA_DIR, "sandboxes");

fsSync.mkdirSync(SANDBOX_DIR, { recursive: true });

function sandboxPath(workspaceId: string): string {
  return path.join(SANDBOX_DIR, workspaceId);
}

function repoPath(workspaceId: string): string {
  return path.join(WORKSPACES_DIR, workspaceId);
}

interface SandboxMeta {
  sandboxId: string;
  workspaceId: string;
  sandboxPath: string;
  createdAt: string;
}

function metaPath(workspaceId: string): string {
  return path.join(SANDBOX_DIR, `${workspaceId}.meta.json`);
}

function readSandboxMeta(workspaceId: string): SandboxMeta | null {
  const p = metaPath(workspaceId);
  if (!fsSync.existsSync(p)) return null;
  return JSON.parse(fsSync.readFileSync(p, "utf-8"));
}

function writeSandboxMeta(meta: SandboxMeta): void {
  fsSync.writeFileSync(metaPath(meta.workspaceId), JSON.stringify(meta, null, 2), "utf-8");
}

function removeSandboxMeta(workspaceId: string): void {
  const p = metaPath(workspaceId);
  if (fsSync.existsSync(p)) fsSync.unlinkSync(p);
}

export async function checkoutSandbox(workspaceId: string): Promise<SandboxMeta> {
  const sbPath = sandboxPath(workspaceId);
  const existing = readSandboxMeta(workspaceId);

  if (existing && fsSync.existsSync(sbPath)) {
    const error = new Error("Sandbox already exists for this workspace");
    (error as any).code = "SANDBOX_EXISTS";
    throw error;
  }

  const source = repoPath(workspaceId);
  if (!fsSync.existsSync(path.join(source, ".git"))) {
    const error = new Error("Workspace repository not found");
    (error as any).code = "WORKSPACE_NOT_FOUND";
    throw error;
  }

  // Clone the workspace repo into the sandbox directory
  await fs.mkdir(sbPath, { recursive: true });
  const git = simpleGit();
  await git.clone(source, sbPath);

  const meta: SandboxMeta = {
    sandboxId: `sb_${ulid()}`,
    workspaceId,
    sandboxPath: sbPath,
    createdAt: new Date().toISOString(),
  };
  writeSandboxMeta(meta);

  return meta;
}

export async function getSandboxStatus(workspaceId: string): Promise<{
  workspaceId: string;
  sandboxId: string;
  sandboxPath: string;
  exists: boolean;
  hasChanges: boolean;
  createdAt: string;
}> {
  const meta = readSandboxMeta(workspaceId);
  const sbPath = sandboxPath(workspaceId);
  const exists = !!meta && fsSync.existsSync(sbPath);

  if (!exists || !meta) {
    const error = new Error("Sandbox not found");
    (error as any).code = "SANDBOX_NOT_FOUND";
    throw error;
  }

  let hasChanges = false;
  try {
    const git = simpleGit(sbPath);
    const status = await git.status();
    hasChanges = !status.isClean();
  } catch {
    // If git fails, treat as no changes
  }

  return {
    workspaceId,
    sandboxId: meta.sandboxId,
    sandboxPath: sbPath,
    exists,
    hasChanges,
    createdAt: meta.createdAt,
  };
}

export async function commitSandbox(
  workspaceId: string,
  metadata: Record<string, unknown>
): Promise<{
  workspaceId: string;
  sandboxId: string;
  commitId: string;
  parentId: string | null;
  filesChanged: string[];
  createdAt: string;
}> {
  const meta = readSandboxMeta(workspaceId);
  const sbPath = sandboxPath(workspaceId);

  if (!meta || !fsSync.existsSync(sbPath)) {
    const error = new Error("Sandbox not found");
    (error as any).code = "SANDBOX_NOT_FOUND";
    throw error;
  }

  const git = simpleGit(sbPath);

  // Get parent commit
  let parentId: string | null = null;
  try {
    const log = await git.log({ maxCount: 1 });
    if (log.latest) parentId = log.latest.hash;
  } catch {
    // no commits
  }

  // Stage all changes
  await git.add("-A");
  const status = await git.status();
  const filesChanged = [
    ...status.created,
    ...status.modified,
    ...status.deleted,
    ...status.renamed.map((r) => r.to),
  ];

  if (filesChanged.length === 0) {
    const error = new Error("No changes to commit");
    (error as any).code = "NO_CHANGES";
    throw error;
  }

  // Build commit message
  const parts: string[] = [];
  if (metadata.agentId) parts.push(`agent: ${metadata.agentId}`);
  if (metadata.taskId) parts.push(`task: ${metadata.taskId}`);
  if (metadata.tags && Array.isArray(metadata.tags) && metadata.tags.length > 0) {
    parts.push(`tags: ${(metadata.tags as string[]).join(",")}`);
  }
  const summary = parts.length > 0 ? parts.join(" | ") : "sandbox commit";
  const body = { ...metadata, files: filesChanged, sizeBytes: 0 };
  const message = `${summary}\n---\n${JSON.stringify(body)}`;

  const result = await git.commit(message);
  let commitId = result.commit || "";
  if (!commitId) {
    const log = await git.log({ maxCount: 1 });
    commitId = log.latest?.hash || "";
  }

  // Push changes back to the workspace repo
  await git.push("origin", "main").catch(() => {
    // Try master if main fails
    return git.push("origin", "master");
  });

  const createdAt = new Date().toISOString();

  return {
    workspaceId,
    sandboxId: meta.sandboxId,
    commitId,
    parentId,
    filesChanged,
    createdAt,
  };
}

export async function destroySandbox(workspaceId: string): Promise<{
  success: boolean;
  workspaceId: string;
  sandboxPath: string;
}> {
  const sbPath = sandboxPath(workspaceId);

  if (!fsSync.existsSync(sbPath) && !readSandboxMeta(workspaceId)) {
    const error = new Error("Sandbox not found");
    (error as any).code = "SANDBOX_NOT_FOUND";
    throw error;
  }

  // Remove sandbox directory
  await fs.rm(sbPath, { recursive: true, force: true });
  removeSandboxMeta(workspaceId);

  return {
    success: true,
    workspaceId,
    sandboxPath: sbPath,
  };
}
