import { WorkspaceError } from "../../../domain";
import type { Manifest } from "../../../domain";
import { gitCommand } from "./process";

export interface Directory { children: Map<string, Directory | File> }
export interface File { path: string; objectId: string }
export const oidPattern = /^[a-f0-9]{40}$/;
const broken = (): never => { throw new WorkspaceError("STORAGE_UNAVAILABLE", "Private Git revision contains invalid objects"); };

export function snapshotTree(manifest: Manifest, files: Map<string, string>): Directory {
  const root: Directory = { children: new Map() };
  for (const entry of manifest.entries) {
    const components = entry.path.split("/");
    let directory = root;
    for (const component of components.slice(0, -1)) {
      let child = directory.children.get(component);
      if (!child) { child = { children: new Map() }; directory.children.set(component, child); }
      if (!("children" in child)) return broken();
      directory = child;
    }
    const name = components.at(-1)!;
    if (entry.kind === "file") directory.children.set(name, { path: entry.path, objectId: files.get(entry.path) ?? "" });
    else if (!directory.children.has(name)) directory.children.set(name, { children: new Map() });
  }
  return root;
}

export async function writeTree(repository: string, directory: Directory, signal?: AbortSignal): Promise<string> {
  const records: Buffer[] = [];
  for (const [name, child] of directory.children) {
    const tree = "children" in child;
    const objectId = tree ? await writeTree(repository, child, signal) : child.objectId;
    if (!oidPattern.test(objectId)) return broken();
    records.push(Buffer.from(`${tree ? "040000 tree" : "100644 blob"} ${objectId}\t${name}\0`, "utf8"));
  }
  return (await gitCommand(repository, ["mktree", "-z"], Buffer.concat(records), signal)).bytes.toString("ascii").trim();
}

export async function treeEntries(repository: string, objectId: string, recursive = false): Promise<Map<string, { kind: "file" | "directory"; objectId: string }>> {
  if (!oidPattern.test(objectId)) return broken();
  const raw = (await gitCommand(repository, ["ls-tree", "-z", ...(recursive ? ["-r", "-t"] : []), objectId])).bytes;
  const entries = new Map<string, { kind: "file" | "directory"; objectId: string }>();
  for (const record of raw.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(100644 blob|040000 tree) ([a-f0-9]{40})\t([^\0]+)$/u.exec(record);
    if (!match || entries.has(match[3])) return broken();
    entries.set(match[3], { kind: match[1] === "100644 blob" ? "file" : "directory", objectId: match[2] });
  }
  return entries;
}

/** Compare the complete tree, including inferred and explicitly empty directories. */
export async function validateTree(repository: string, objectId: string, expected: Directory, files = new Map<string, string>()): Promise<Map<string, string>> {
  let entries: Awaited<ReturnType<typeof treeEntries>>;
  try { entries = await treeEntries(repository, objectId, true); }
  catch (error) {
    // Long inferred-directory prefixes can exceed the bounded recursive-listing response.
    if (!(error instanceof WorkspaceError) || error.code !== "QUOTA_EXCEEDED") throw error;
    return validateTreeByDirectory(repository, objectId, expected, files);
  }
  let count = 0;
  function validate(directory: Directory, prefix: string): void {
    for (const [name, child] of directory.children) {
      const fullPath = prefix ? `${prefix}/${name}` : name;
      const entry = entries.get(fullPath);
      count++;
      if (!entry || entry.kind !== ("children" in child ? "directory" : "file")) return broken();
      if ("children" in child) validate(child, fullPath);
      else files.set(child.path, entry.objectId);
    }
  }
  validate(expected, "");
  if (count !== entries.size) return broken();
  return files;
}

async function validateTreeByDirectory(repository: string, objectId: string, expected: Directory, files: Map<string, string>): Promise<Map<string, string>> {
  const entries = await treeEntries(repository, objectId);
  if (entries.size !== expected.children.size) return broken();
  for (const [name, child] of expected.children) {
    const entry = entries.get(name);
    if (!entry || entry.kind !== ("children" in child ? "directory" : "file")) return broken();
    if ("children" in child) await validateTreeByDirectory(repository, entry.objectId, child, files);
    else files.set(child.path, entry.objectId);
  }
  return files;
}
