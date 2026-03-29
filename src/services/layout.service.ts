import simpleGit from "simple-git";
import * as fs from "fs/promises";
import * as path from "path";

/** Default workspace layout per ARCHITECTURE.md */
const DEFAULT_FILES: { path: string; content: string }[] = [
  {
    path: "profile/summary.md",
    content: "# Summary\n\nAdd a human-readable summary here.\n",
  },
  {
    path: "profile/facts.json",
    content: JSON.stringify({ facts: [] }, null, 2) + "\n",
  },
  {
    path: "memory/timeline.md",
    content: "# Timeline\n\nChronological events.\n",
  },
  {
    path: "memory/known_entities.json",
    content: JSON.stringify({ entities: [] }, null, 2) + "\n",
  },
  {
    path: "state/current.json",
    content: JSON.stringify({ state: {} }, null, 2) + "\n",
  },
  {
    path: "state/preferences.json",
    content: JSON.stringify({ preferences: {} }, null, 2) + "\n",
  },
  {
    path: "tasks/open.yaml",
    content: "# Open Tasks\ntasks: []\n",
  },
  {
    path: "tasks/completed.yaml",
    content: "# Completed Tasks\ntasks: []\n",
  },
  {
    path: "system/workspace_manifest.yaml",
    content: "", // filled dynamically
  },
];

const EMPTY_DIRS = [
  "decisions",
  "artifacts/reports",
  "artifacts/drafts",
  "artifacts/outputs",
  "logs/run_summaries",
];

export async function seedWorkspaceLayout(
  repoDir: string,
  workspaceId: string,
  customerId: string,
  name: string
): Promise<string> {
  const git = simpleGit(repoDir);

  // Write default files
  for (const file of DEFAULT_FILES) {
    const fullPath = path.join(repoDir, file.path);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    let content = file.content;
    if (file.path === "system/workspace_manifest.yaml") {
      content = [
        `workspace_id: "${workspaceId}"`,
        `customer_id: "${customerId}"`,
        `name: "${name}"`,
        `created_at: "${new Date().toISOString()}"`,
        `schema_version: "1.0"`,
        "",
      ].join("\n");
    }

    await fs.writeFile(fullPath, content, "utf-8");
  }

  // Create empty directories with .gitkeep
  for (const dir of EMPTY_DIRS) {
    const fullDir = path.join(repoDir, dir);
    await fs.mkdir(fullDir, { recursive: true });
    await fs.writeFile(path.join(fullDir, ".gitkeep"), "", "utf-8");
  }

  // Stage and commit
  await git.add("-A");
  const result = await git.commit("Initial workspace layout");
  let commitHash = result.commit || "";
  if (!commitHash) {
    const log = await git.log({ maxCount: 1 });
    commitHash = log.latest?.hash || "";
  }

  return commitHash;
}
