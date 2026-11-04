import { afterEach, expect, it } from "vitest";
import { link, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { captureWorkspace, removeWorkspace, writeWorkspaceFile } from "../../src/application/files";
import { consume, digest, remove, stream, temporary } from "../submissions/helpers";
let root: string;
afterEach(async () => { if (root) await remove(root); });
it("captures binary, CRLF, Unicode, and empty directories while excluding control metadata", async () => {
  root = await temporary(); await mkdir(join(root, "empty")); await mkdir(join(root, ".git")); await writeFile(join(root, ".git", "secret"), "hidden"); await mkdir(join(root, ".contextvault"));
  await writeFile(join(root, "é.txt"), Buffer.from([0, 255, 13, 10]));
  const snapshot = await captureWorkspace(root);
  expect(snapshot.manifest.entries).toEqual([{ path: "empty", kind: "directory" }, { path: "é.txt", kind: "file", byteLength: 4, sha256: digest(Buffer.from([0, 255, 13, 10])) }]);
  expect(await consume(await snapshot.openFile("é.txt"))).toEqual(Buffer.from([0, 255, 13, 10])); await snapshot.release();
});
it.each(["../escape", "/absolute", "a/../../escape", "a\\b", "CON", "bad.", ".git/config", "e\u0301"])("rejects unsafe extraction path %j", async (path) => {
  root = await temporary(); await expect(writeWorkspaceFile(root, { path, kind: "file", byteLength: 1, sha256: digest("x") }, stream("x"))).rejects.toBeDefined();
});
it("rejects portable collisions, symlinks, hardlinks, and special files", async () => {
  root = await temporary(); await writeFile(join(root, "①"), "x"); await writeFile(join(root, "1"), "y");
  await expect(captureWorkspace(root)).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
  await remove(root); root = await temporary(); await writeFile(join(root, "original"), "x"); await link(join(root, "original"), join(root, "hardlink"));
  await expect(captureWorkspace(root)).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
  await remove(root); root = await temporary(); await symlink("/etc/passwd", join(root, "link"));
  await expect(captureWorkspace(root)).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
  await remove(root); root = await temporary(); execFileSync("mkfifo", [join(root, "pipe")]);
  await expect(captureWorkspace(root)).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
});
it("rejects symlink ancestry for reads, writes, and cleanup without touching its target", async () => {
  root = await temporary(); const outside = join(root, "outside"); await mkdir(outside); await writeFile(join(outside, "keep"), "safe"); await symlink(outside, join(root, "alias"));
  await expect(captureWorkspace(join(root, "alias"))).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
  await expect(writeWorkspaceFile(root, { path: "alias/keep", kind: "file", byteLength: 1, sha256: digest("x") }, stream("x"))).rejects.toBeDefined();
  await expect(removeWorkspace(join(root, "alias"))).rejects.toBeDefined();
  const snapshot = await captureWorkspace(outside);
  expect(await consume(await snapshot.openFile("keep"))).toEqual(Buffer.from("safe")); await snapshot.release();
});
it("keeps a captured source immutable after the agent rewrites its working file", async () => {
  root = await temporary(); await writeFile(join(root, "file"), "old");
  const snapshot = await captureWorkspace(root); await writeFile(join(root, "file"), "new");
  expect(await consume(await snapshot.openFile("file"))).toEqual(Buffer.from("old")); await snapshot.release();
});
it("cleans stopped workspaces with excluded control metadata and preserves sibling contents", async () => {
  root = await temporary(); const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".git", "objects"), { recursive: true }); await mkdir(join(workspace, ".contextvault"));
  await writeFile(join(workspace, ".git", "objects", "object"), "git bytes");
  await writeFile(join(workspace, ".contextvault", "state"), "control bytes");
  await writeFile(join(workspace, "file"), "workspace bytes"); await writeFile(join(root, "keep"), "outside bytes");
  const snapshot = await captureWorkspace(workspace);
  expect(snapshot.manifest.entries.map((entry) => entry.path)).toEqual(["file"]); await snapshot.release();
  await removeWorkspace(workspace);
  await expect(lstat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(root, "keep"), "utf8")).toBe("outside bytes");
});
it("rejects links inside control metadata before cleanup can reach an outside directory", async () => {
  root = await temporary(); const workspace = join(root, "workspace"); const outside = join(root, "outside");
  await mkdir(join(workspace, ".git"), { recursive: true }); await mkdir(outside); await writeFile(join(outside, "keep"), "outside bytes");
  await symlink(outside, join(workspace, ".git", "escape"));
  await expect(removeWorkspace(workspace)).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
  expect(await readFile(join(outside, "keep"), "utf8")).toBe("outside bytes");
});
