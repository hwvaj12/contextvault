import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CollectionPermit } from "../../../src/domain";
import { GitRevisionStore } from "../../../src/adapters/revisions/git";
import { createTestWriterTracking } from "../../recovery/tracking";

const exec = promisify(execFile);
export * from "./fixtures";
export async function setup(verifyCollectionPermit?: (permit: CollectionPermit, now: string) => Promise<boolean>) {
  const rootDirectory = await mkdtemp(path.join(tmpdir(), "cv-git-contract-"));
  const options = { rootDirectory, storeId: "private-git-test", verifyCollectionPermit, writerTracking: verifyCollectionPermit ? createTestWriterTracking() : undefined };
  return { rootDirectory, repository: path.join(rootDirectory, "objects.git"), store: new GitRevisionStore(options),
    reopen: () => new GitRevisionStore(options), close: () => rm(rootDirectory, { recursive: true, force: true }) };
}
export async function git(repository: string, ...args: string[]): Promise<string> {
  return (await exec("/usr/bin/git", ["--git-dir", repository, ...args], { env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } })).stdout;
}
