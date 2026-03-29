import simpleGit from "simple-git";
import * as path from "path";
import { getDb } from "../db";

const DATA_DIR = path.join(process.cwd(), "data");
const WORKSPACES_DIR = path.join(DATA_DIR, "workspaces");

function repoDir(workspaceId: string): string {
  // Try to look up from DB first
  try {
    const db = getDb();
    const row = db.prepare("SELECT repo_location FROM workspaces WHERE id = ?").get(workspaceId) as any;
    if (row?.repo_location) return row.repo_location;
  } catch {
    // DB not available, fall back
  }
  return path.join(WORKSPACES_DIR, workspaceId);
}

export interface ChangeDetectionResult {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
  totalFiles: number;
}

export interface StructuredCommitMessage {
  subject: string;
  body: string;
  trailer: string;
  full: string;
}

export interface MergeResult {
  success: boolean;
  commitHash: string | null;
  mergeType: "fast-forward" | "merge-commit" | "conflict" | "no-changes";
  conflictingFiles: string[];
}

// ── Run Branches ──────────────────────────────────────────────

/** Create a run branch from the current HEAD of the workspace */
export async function createRunBranch(
  workspaceId: string,
  runId: string
): Promise<{ branchName: string; baseCommit: string }> {
  const dir = repoDir(workspaceId);
  const git = simpleGit(dir);

  const branchName = `run/${runId}`;

  // Get current HEAD
  let baseCommit: string;
  try {
    baseCommit = (await git.raw(["rev-parse", "HEAD"])).trim();
  } catch {
    // No commits yet — create an initial empty commit
    await git.raw(["commit", "--allow-empty", "-m", "Initial empty commit"]);
    baseCommit = (await git.raw(["rev-parse", "HEAD"])).trim();
  }

  // Create the run branch
  await git.raw(["branch", branchName, baseCommit]);

  return { branchName, baseCommit };
}

/** Delete a run branch after cleanup */
export async function deleteRunBranch(
  workspaceId: string,
  runId: string
): Promise<void> {
  const dir = repoDir(workspaceId);
  const git = simpleGit(dir);
  const branchName = `run/${runId}`;

  try {
    await git.raw(["branch", "-D", branchName]);
  } catch {
    // Branch may not exist, ignore
  }
}

// ── Structured Commit Messages ────────────────────────────────

/** Build a structured commit message per ARCHITECTURE.md spec */
export function buildStructuredCommitMessage(params: {
  workspaceId: string;
  runId: string;
  agentId: string;
  changes: ChangeDetectionResult;
  summary?: string;
}): StructuredCommitMessage {
  const { workspaceId, runId, agentId, changes, summary } = params;

  // Subject line
  const subject = `contextvault: workspace=${workspaceId} run=${runId} agent=${agentId}`;

  // Summary section
  const changeSummaryLines: string[] = [];
  for (const f of changes.added) changeSummaryLines.push(`- added ${f}`);
  for (const f of changes.modified) changeSummaryLines.push(`- updated ${f}`);
  for (const f of changes.deleted) changeSummaryLines.push(`- deleted ${f}`);
  for (const r of changes.renamed) changeSummaryLines.push(`- renamed ${r.from} → ${r.to}`);

  const bodyLines = ["Summary:"];
  if (changeSummaryLines.length > 0) {
    bodyLines.push(...changeSummaryLines);
  } else {
    bodyLines.push("- no changes");
  }
  if (summary) {
    bodyLines.push("", `Note: ${summary}`);
  }
  const body = bodyLines.join("\n");

  // JSON trailer
  const totalBytes = 0; // Calculated separately if needed
  const allFiles = [
    ...changes.added,
    ...changes.modified,
    ...changes.renamed.map((r) => r.to),
  ];
  const trailerData = {
    workspaceId,
    runId,
    agentId,
    files: allFiles,
    deleted: changes.deleted,
    sizeBytes: totalBytes,
  };
  const trailer = JSON.stringify(trailerData);

  const full = `${subject}\n\n${body}\n\n---\n${trailer}`;

  return { subject, body, trailer, full };
}

// ── Change Detection ──────────────────────────────────────────

/** Detect changes in a sandbox directory using git diff --name-status */
export async function detectChanges(
  sandboxDir: string,
  baseCommit?: string
): Promise<ChangeDetectionResult> {
  const git = simpleGit(sandboxDir);

  // Stage everything first
  await git.add("-A");

  // Get status against HEAD (or base commit)
  let raw: string;
  if (baseCommit) {
    raw = await git.raw(["diff", "--name-status", "--cached", baseCommit]);
  } else {
    // Diff staged against HEAD
    try {
      raw = await git.raw(["diff", "--name-status", "--cached", "HEAD"]);
    } catch {
      // No HEAD yet, everything is added
      raw = await git.raw(["diff", "--name-status", "--cached", "--diff-filter=A"]);
      // Fall back: list all staged files as added
      const statusResult = await git.status();
      return {
        added: [...statusResult.created, ...statusResult.staged],
        modified: [],
        deleted: [],
        renamed: [],
        totalFiles: statusResult.created.length + statusResult.staged.length,
      };
    }
  }

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];

  for (const line of raw.trim().split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const status = parts[0];

    if (status === "A") {
      added.push(parts[1]);
    } else if (status === "M") {
      modified.push(parts[1]);
    } else if (status === "D") {
      deleted.push(parts[1]);
    } else if (status.startsWith("R")) {
      renamed.push({ from: parts[1], to: parts[2] });
    }
  }

  const totalFiles = added.length + modified.length + deleted.length + renamed.length;
  return { added, modified, deleted, renamed, totalFiles };
}

// ── Merge Policy ──────────────────────────────────────────────

/**
 * Merge a run branch into the main branch.
 * Supports fast-forward when possible, otherwise creates a merge commit.
 */
export async function mergeRunBranch(
  workspaceId: string,
  runId: string,
  baseBranch: string = "main"
): Promise<MergeResult> {
  const dir = repoDir(workspaceId);
  const git = simpleGit(dir);
  const runBranchName = `run/${runId}`;

  // Check if run branch has any commits beyond base
  let runHead: string;
  try {
    runHead = (await git.raw(["rev-parse", runBranchName])).trim();
  } catch {
    return {
      success: false,
      commitHash: null,
      mergeType: "no-changes",
      conflictingFiles: [],
    };
  }

  let baseHead: string;
  try {
    baseHead = (await git.raw(["rev-parse", baseBranch])).trim();
  } catch {
    // Base branch doesn't exist — just rename the run branch
    await git.raw(["branch", "-M", runBranchName, baseBranch]);
    return {
      success: true,
      commitHash: runHead,
      mergeType: "fast-forward",
      conflictingFiles: [],
    };
  }

  // Check if run branch is same as base (no changes)
  if (runHead === baseHead) {
    return {
      success: true,
      commitHash: baseHead,
      mergeType: "no-changes",
      conflictingFiles: [],
    };
  }

  // Check if fast-forward is possible
  try {
    const mergeBase = (await git.raw(["merge-base", baseBranch, runBranchName])).trim();

    if (mergeBase === baseHead) {
      // Fast-forward: base hasn't moved
      await git.raw(["checkout", baseBranch]);
      await git.raw(["merge", "--ff-only", runBranchName]);
      const newHead = (await git.raw(["rev-parse", "HEAD"])).trim();
      return {
        success: true,
        commitHash: newHead,
        mergeType: "fast-forward",
        conflictingFiles: [],
      };
    }

    // Try merge commit
    await git.raw(["checkout", baseBranch]);
    try {
      await git.raw([
        "merge",
        "--no-ff",
        "-m",
        `Merge run/${runId} into ${baseBranch}`,
        runBranchName,
      ]);
      const newHead = (await git.raw(["rev-parse", "HEAD"])).trim();
      return {
        success: true,
        commitHash: newHead,
        mergeType: "merge-commit",
        conflictingFiles: [],
      };
    } catch {
      // Merge conflict — abort and report
      const conflictingFiles: string[] = [];
      try {
        const statusRaw = await git.raw(["diff", "--name-only", "--diff-filter=U"]);
        conflictingFiles.push(...statusRaw.trim().split("\n").filter(Boolean));
      } catch {
        // ignore
      }

      try {
        await git.raw(["merge", "--abort"]);
      } catch {
        // ignore
      }

      return {
        success: false,
        commitHash: null,
        mergeType: "conflict",
        conflictingFiles,
      };
    }
  } catch {
    return {
      success: false,
      commitHash: null,
      mergeType: "conflict",
      conflictingFiles: [],
    };
  }
}

/**
 * Commit changes on a run branch with structured message.
 */
export async function commitOnRunBranch(
  sandboxDir: string,
  commitMessage: string
): Promise<string | null> {
  const git = simpleGit(sandboxDir);

  await git.add("-A");

  // Check if there are changes to commit
  const status = await git.status();
  if (status.isClean()) return null;

  const result = await git.commit(commitMessage);
  let commitHash = result.commit || "";
  if (!commitHash) {
    const log = await git.log({ maxCount: 1 });
    commitHash = log.latest?.hash || "";
  }

  return commitHash || null;
}
