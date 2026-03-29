import simpleGit from "simple-git";

export interface ConflictCheckResult {
  hasConflict: boolean;
  canFastForward: boolean;
  divergedCommits: number;
  conflictingFiles: string[];
}

/**
 * Check if merging a run branch into the main branch would conflict.
 *
 * @param repoDir - Path to the workspace repo
 * @param baseBranch - The main branch (e.g. "main")
 * @param runBranch - The run branch (e.g. "run/run_01HXXX")
 * @param baseCommit - The commit the run branched from
 */
export async function checkForConflicts(
  repoDir: string,
  baseBranch: string,
  runBranch: string,
  baseCommit: string
): Promise<ConflictCheckResult> {
  const git = simpleGit(repoDir);

  // Get current HEAD of base branch
  let currentHead: string;
  try {
    currentHead = (await git.raw(["rev-parse", baseBranch])).trim();
  } catch {
    // If base branch doesn't exist yet, no conflict possible
    return { hasConflict: false, canFastForward: true, divergedCommits: 0, conflictingFiles: [] };
  }

  // If HEAD hasn't moved since run started, it's a fast-forward
  if (currentHead === baseCommit) {
    return { hasConflict: false, canFastForward: true, divergedCommits: 0, conflictingFiles: [] };
  }

  // Count diverged commits on the base branch since baseCommit
  let divergedCommits = 0;
  try {
    const countRaw = await git.raw(["rev-list", "--count", `${baseCommit}..${baseBranch}`]);
    divergedCommits = parseInt(countRaw.trim(), 10);
  } catch {
    divergedCommits = 0;
  }

  // Try a dry-run merge to detect conflicts
  try {
    // Use merge-tree to check for conflicts without modifying worktree
    const mergeBase = await git.raw(["merge-base", baseBranch, runBranch]);
    const mergeTreeOutput = await git.raw([
      "merge-tree",
      mergeBase.trim(),
      baseBranch,
      runBranch,
    ]);

    // If merge-tree output contains conflict markers, there's a conflict
    const hasConflict = mergeTreeOutput.includes("<<<<<<<") || mergeTreeOutput.includes("changed in both");

    const conflictingFiles: string[] = [];
    if (hasConflict) {
      // Parse conflicting file paths from merge-tree output
      const lines = mergeTreeOutput.split("\n");
      for (const line of lines) {
        if (line.startsWith("changed in both")) {
          // Extract filename
          const match = line.match(/changed in both\s+(.+)/);
          if (match) conflictingFiles.push(match[1].trim());
        }
      }
    }

    return {
      hasConflict,
      canFastForward: false,
      divergedCommits,
      conflictingFiles,
    };
  } catch {
    // If merge-tree fails, assume conflict
    return {
      hasConflict: true,
      canFastForward: false,
      divergedCommits,
      conflictingFiles: [],
    };
  }
}

/**
 * Check if the workspace HEAD has moved since a run started.
 */
export async function hasHeadDiverged(
  repoDir: string,
  baseCommit: string
): Promise<boolean> {
  const git = simpleGit(repoDir);
  try {
    const currentHead = (await git.raw(["rev-parse", "HEAD"])).trim();
    return currentHead !== baseCommit;
  } catch {
    return false;
  }
}
