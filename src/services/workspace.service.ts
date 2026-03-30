import { getDb } from "../db";
import { getStorage } from "../storage";
import { Workspace } from "../storage/interfaces";
import { logAuditEvent } from "./audit.service";
import { deliver } from "./webhook.service";
import {
  buildManifest,
  verifyManifest,
  Manifest,
} from "./manifest.service";
import { scanWorkspace } from "../utils/secrets-scanner";
import { getConfig } from "./config.service";
import * as path from "path";
import * as fs from "fs/promises";
import * as fsSync from "fs";

export type { Workspace };

const DATA_DIR = path.join(process.cwd(), "data");
const WORKSPACES_DIR = path.join(DATA_DIR, "workspaces");

function rowToWorkspace(row: any): Workspace {
  return {
    id: row.id,
    customerId: row.customer_id,
    name: row.name,
    latestCommitId: row.current_head ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.status === "deleted" ? row.updated_at : null,
  };
}

export async function createWorkspace(
  id: string,
  customerId: string,
  name: string
): Promise<Workspace> {
  // Create the git repo via existing storage layer
  const ws = await getStorage().createWorkspace({ id, customerId, name });

  const now = new Date().toISOString();
  const repoLocation = path.join(WORKSPACES_DIR, id);

  // Insert into SQLite
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO workspaces (id, customer_id, name, repo_location, default_branch, current_head, status, storage_class, created_at, updated_at, last_accessed_at)
    VALUES (?, ?, ?, ?, 'main', NULL, 'active', 'standard', ?, ?, ?)
  `).run(id, customerId, name, repoLocation, now, now, now);

  logAuditEvent({
    workspaceId: id,
    actorType: "user",
    actorId: customerId,
    eventType: "workspace.created",
    payload: { name, customerId },
  });

  deliver("workspace.created", { workspaceId: id, customerId, name });

  return {
    ...ws,
  };
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  const db = getDb();
  const row = db.prepare("SELECT * FROM workspaces WHERE id = ? AND status != 'deleted'").get(id) as any;

  if (row) {
    // Update last_accessed_at
    db.prepare("UPDATE workspaces SET last_accessed_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id
    );
    return rowToWorkspace(row);
  }

  // Fall back to JSON metadata for backward compatibility
  return getStorage().getWorkspace(id);
}

export interface ListWorkspacesOptions {
  limit?: number;
  offset?: number;
  customerId?: string;
}

export interface ListWorkspacesResult {
  workspaces: Workspace[];
  total: number;
}

export async function listWorkspaces(options: ListWorkspacesOptions = {}): Promise<ListWorkspacesResult> {
  const { limit = 50, offset = 0, customerId } = options;

  const db = getDb();

  if (customerId) {
    const rows = db.prepare(
      "SELECT * FROM workspaces WHERE status != 'deleted' AND customer_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
    ).all(customerId, limit, offset) as any[];

    const total = db.prepare(
      "SELECT COUNT(*) as count FROM workspaces WHERE status != 'deleted' AND customer_id = ?"
    ).get(customerId) as { count: number };

    return {
      workspaces: rows.map(rowToWorkspace),
      total: total.count,
    };
  }

  const rows = db.prepare(
    "SELECT * FROM workspaces WHERE status != 'deleted' ORDER BY created_at DESC LIMIT ? OFFSET ?"
  ).all(limit, offset) as any[];

  const total = db.prepare(
    "SELECT COUNT(*) as count FROM workspaces WHERE status != 'deleted'"
  ).get() as { count: number };

  if (rows.length > 0) {
    return {
      workspaces: rows.map(rowToWorkspace),
      total: total.count,
    };
  }

  // Fall back to JSON metadata
  const fallback = await getStorage().listWorkspaces();
  return {
    workspaces: fallback,
    total: fallback.length,
  };
}

export async function softDeleteWorkspace(id: string): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE workspaces SET status = 'deleted', updated_at = ? WHERE id = ?").run(now, id);

  // Also delete from JSON metadata for backward compatibility
  await getStorage().deleteWorkspace(id);

  logAuditEvent({
    workspaceId: id,
    actorType: "user",
    actorId: "system",
    eventType: "workspace.deleted",
  });

  deliver("workspace.deleted", { workspaceId: id });
}

export async function deleteWorkspace(id: string): Promise<void> {
  const db = getDb();

  // Remove any active sandbox
  const sandboxDir = path.join(DATA_DIR, "sandboxes", id);
  const sandboxMeta = path.join(DATA_DIR, "sandboxes", `${id}.meta.json`);
  await fs.rm(sandboxDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(sandboxMeta, { force: true }).catch(() => {});

  // Remove the bare repo
  const repoDir = path.join(WORKSPACES_DIR, id);
  await fs.rm(repoDir, { recursive: true, force: true }).catch(() => {});

  // Remove JSON metadata
  const metaFile = path.join(DATA_DIR, "workspace-meta", `${id}.json`);
  await fs.rm(metaFile, { force: true }).catch(() => {});

  // Delete related DB records (audit_events don't have FK, locks/runs do)
  db.prepare("DELETE FROM locks WHERE workspace_id = ?").run(id);
  db.prepare("DELETE FROM runs WHERE workspace_id = ?").run(id);
  db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);

  logAuditEvent({
    workspaceId: id,
    actorType: "user",
    actorId: "system",
    eventType: "workspace.hard_deleted",
  });
}

export interface BulkDeleteResult {
  deleted: number;
  failed: { id: string; error: string }[];
}

export async function bulkDeleteWorkspaces(ids: string[]): Promise<BulkDeleteResult> {
  let deleted = 0;
  const failed: { id: string; error: string }[] = [];

  for (const id of ids) {
    try {
      await deleteWorkspace(id);
      deleted++;
    } catch (err) {
      failed.push({ id, error: (err as Error).message });
    }
  }

  return { deleted, failed };
}

export async function cloneWorkspace(
  sourceId: string,
  targetCustomerId: string,
  newName?: string
): Promise<Workspace> {
  // Verify source exists
  const source = await getWorkspace(sourceId);
  if (!source) {
    throw new Error(`Source workspace not found: ${sourceId}`);
  }

  const newId = `ws_${(await import("ulid")).ulid()}`;
  const name = newName || `${source.name} (clone)`;
  const sourceRepoDir = path.join(WORKSPACES_DIR, sourceId);
  const targetRepoDir = path.join(WORKSPACES_DIR, newId);

  // Clone the bare git repo
  const { execSync } = await import("child_process");
  execSync(`git clone --bare "${sourceRepoDir}" "${targetRepoDir}"`, {
    stdio: "pipe",
  });

  const now = new Date().toISOString();

  // Insert new workspace record into SQLite
  const db = getDb();
  const sourceRow = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(sourceId) as any;
  const currentHead = sourceRow?.current_head ?? null;

  db.prepare(`
    INSERT INTO workspaces (id, customer_id, name, repo_location, default_branch, current_head, status, storage_class, created_at, updated_at, last_accessed_at)
    VALUES (?, ?, ?, ?, 'main', ?, 'active', 'standard', ?, ?, ?)
  `).run(newId, targetCustomerId, name, targetRepoDir, currentHead, now, now, now);

  // Write JSON metadata for backward compatibility
  const metaDir = path.join(DATA_DIR, "workspace-meta");
  if (!fsSync.existsSync(metaDir)) {
    await fs.mkdir(metaDir, { recursive: true });
  }
  await fs.writeFile(
    path.join(metaDir, `${newId}.json`),
    JSON.stringify({ id: newId, customerId: targetCustomerId, name, createdAt: now, updatedAt: now })
  );

  logAuditEvent({
    workspaceId: newId,
    actorType: "user",
    actorId: targetCustomerId,
    eventType: "workspace.cloned",
    payload: { sourceWorkspaceId: sourceId, name, customerId: targetCustomerId },
  });

  deliver("workspace.cloned", { sourceWorkspaceId: sourceId, workspaceId: newId, customerId: targetCustomerId, name });

  return {
    id: newId,
    customerId: targetCustomerId,
    name,
    latestCommitId: currentHead,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

export function updateWorkspaceHead(workspaceId: string, commitHash: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE workspaces SET current_head = ?, updated_at = ? WHERE id = ?").run(
    commitHash,
    now,
    workspaceId
  );
}

// ─── Workspace Export / Import ────────────────────────────────────────────────

export interface WorkspaceExportResult {
  workspaceId: string;
  bundlePath: string;
  manifest: Manifest;
  fileCount: number;
  totalSizeBytes: number;
}

/**
 * Export a workspace as a signed bundle.
 * Scans for secrets before building the manifest.
 * Requires signing keys to be configured via CONTEXTVAULT_SIGNING_* env vars.
 */
export async function exportWorkspace(workspaceId: string): Promise<WorkspaceExportResult> {
  // Verify workspace exists
  const ws = await getWorkspace(workspaceId);
  if (!ws) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  // Get signing configuration
  const config = getConfig();
  if (!config.signing.privateKey || !config.signing.publicKey || !config.signing.keyId) {
    throw new Error(
      "Signing keys not configured. Set CONTEXTVAULT_SIGNING_PRIVATE_KEY, " +
      "CONTEXTVAULT_SIGNING_PUBLIC_KEY, and CONTEXTVAULT_SIGNING_KEY_ID env vars."
    );
  }

  const workspaceDir = path.join(config.workspacesDir, workspaceId);

  // Verify workspace directory exists
  if (!fsSync.existsSync(workspaceDir)) {
    throw new Error(`Workspace directory not found: ${workspaceDir}`);
  }

  // ── Step 1: Secrets scan (reject if secrets found) ──
  await scanWorkspace(workspaceDir);

  // ── Step 2: Build signed manifest ──
  const privateKeyBuffer = Buffer.from(config.signing.privateKey, "base64");

  const manifest = await buildManifest(workspaceDir, {
    workspaceId,
    schemaVersion: "1.0",
    signingKey: privateKeyBuffer,
    keyId: config.signing.keyId,
  });

  // ── Step 3: Create bundle directory ──
  const { createBundleDirectory, saveManifest } = await import("./manifest.service");
  const bundleDir = await createBundleDirectory(config.bundlesDir, workspaceId);

  // Save manifest
  await saveManifest(bundleDir, manifest);

  // ── Step 4: Copy workspace files into bundle ──
  const { listBundleFiles } = await import("./manifest.service");
  const filePaths = await listBundleFiles(bundleDir);
  const totalSizeBytes = manifest.files.reduce((sum, f) => sum + f.size, 0);

  return {
    workspaceId,
    bundlePath: bundleDir,
    manifest,
    fileCount: manifest.files.length,
    totalSizeBytes,
  };
}

export interface WorkspaceImportOptions {
  /** Path to the bundle directory */
  bundlePath: string;
  /** Target workspace ID (uses existing workspace or creates new) */
  targetWorkspaceId?: string;
  /** Customer ID for new workspace creation */
  customerId?: string;
  /** Workspace name */
  name?: string;
  /** Skip file hash verification */
  skipHashVerification?: boolean;
}

export interface WorkspaceImportResult {
  workspaceId: string;
  manifest: Manifest;
  fileCount: number;
  verified: boolean;
}

/**
 * Import a workspace from a signed bundle.
 * Verifies the manifest signature before mounting.
 */
export async function importWorkspace(
  options: WorkspaceImportOptions
): Promise<WorkspaceImportResult> {
  const { bundlePath, targetWorkspaceId, customerId, name, skipHashVerification } = options;

  // ── Step 1: Load manifest ──
  const { loadManifest, extractBundle, validateManifestStructure } = await import(
    "./manifest.service"
  );

  let manifest: Manifest;
  try {
    manifest = await loadManifest(bundlePath);
  } catch (err) {
    throw new Error(`Failed to load manifest from bundle: ${(err as Error).message}`);
  }

  // ── Step 2: Validate manifest structure ──
  const structureValidation = validateManifestStructure(manifest);
  if (!structureValidation.valid) {
    throw new Error(
      `Invalid manifest structure:\n${structureValidation.errors.join("\n")}`
    );
  }

  // ── Step 3: Verify manifest signature ──
  const config = getConfig();
  if (!config.signing.publicKey) {
    throw new Error(
      "Signing public key not configured. Set CONTEXTVAULT_SIGNING_PUBLIC_KEY env var " +
      "to verify workspace bundles."
    );
  }

  const publicKeyBuffer = Buffer.from(config.signing.publicKey, "base64");
  const signatureValid = verifyManifest(manifest, publicKeyBuffer);

  if (!signatureValid) {
    throw new Error(
      `Workspace bundle signature verification failed for workspace ${manifest.workspaceId}. ` +
      "The bundle may have been tampered with or was signed with a different key. " +
      "Import rejected for security."
    );
  }

  // ── Step 4: Verify file hashes (optional, enabled by default) ──
  // Extract to a temp directory for verification
  if (!skipHashVerification) {
    const tempDir = path.join(config.bundlesDir, `_verify_${manifest.workspaceId}_${Date.now()}`);
    try {
      const { verifyFileHashes } = await import("./manifest.service");
      await extractBundle(bundlePath, tempDir);

      const hashResult = await verifyFileHashes(manifest, tempDir);
      if (!hashResult.valid) {
        throw new Error(
          `File hash mismatch — bundle may be corrupted:\n${hashResult.mismatches.join("\n")}`
        );
      }
    } finally {
      // Clean up temp directory
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ── Step 5: Mount workspace ──
  const workspaceId = targetWorkspaceId ?? manifest.workspaceId;

  // Check if workspace already exists
  const existing = await getWorkspace(workspaceId);
  if (existing) {
    throw new Error(
      `Workspace ${workspaceId} already exists. ` +
      "Provide a new targetWorkspaceId or delete the existing workspace first."
    );
  }

  // Create new workspace
  const wsCustomerId = customerId ?? "imported";
  const wsName = name ?? `Imported workspace ${manifest.workspaceId}`;

  const ws = await createWorkspace(workspaceId, wsCustomerId, wsName);

  // Extract bundle files to the workspace directory
  const targetDir = path.join(config.workspacesDir, workspaceId);
  await fs.mkdir(targetDir, { recursive: true });
  await extractBundle(bundlePath, targetDir);

  logAuditEvent({
    workspaceId,
    actorType: "system",
    actorId: "import",
    eventType: "workspace.imported",
    payload: {
      originalWorkspaceId: manifest.workspaceId,
      signedAt: manifest.signedAt,
      keyId: manifest.keyId,
      fileCount: manifest.files.length,
      signatureValid: true,
    },
  });

  return {
    workspaceId,
    manifest,
    fileCount: manifest.files.length,
    verified: true,
  };
}
