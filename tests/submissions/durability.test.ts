import { afterEach, expect, it, vi } from "vitest";
import { constants } from "node:fs";
import * as filesystem from "node:fs/promises";
import { dirname, join } from "node:path";
import { LocalSubmissionStore } from "../../src/adapters/submissions/local";
import { captureWorkspace } from "../../src/application/files";
import { catalog, command, digest, now, principal, remove, scope, stream, submissionId, temporary } from "./helpers";

vi.mock("node:fs/promises", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));

let root: string;
afterEach(async () => { vi.restoreAllMocks(); if (root) await remove(root); });
type Event = { kind: "created" | "synced"; path: string };

/** Records completed real fsync calls. This does not simulate physical power loss. */
function directorySyncEvents(beforeSync?: (path: string) => Promise<void>): Event[] {
  const events: Event[] = [];
  const realOpen = filesystem.open;
  vi.spyOn(filesystem, "open").mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    if (typeof args[1] === "number" && (args[1] & constants.O_DIRECTORY) !== 0) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { await beforeSync?.(String(args[0])); await sync(); events.push({ kind: "synced", path: String(args[0]) }); };
    }
    return handle;
  });
  return events;
}

it("syncs every newly created store directory's parent before registering a receipt", async () => {
  root = await temporary(); const events = directorySyncEvents();
  const realMkdir = filesystem.mkdir;
  vi.spyOn(filesystem, "mkdir").mockImplementation(async (...args) => {
    const result = await realMkdir(...args); events.push({ kind: "created", path: String(args[0]) }); return result;
  });
  const db = catalog(); const register = db.control.registerUploadReceipt.bind(db.control);
  let checked = false;
  db.control.registerUploadReceipt = async (input) => {
    const creations = events.filter((event) => event.kind === "created");
    expect(creations.some((event) => event.path === join(root, "new-parent", "store"))).toBe(true);
    for (const creation of creations) {
      const index = events.indexOf(creation);
      expect(events.slice(index + 1), `Durability barrier for ${creation.path}`).toContainEqual({ kind: "synced", path: dirname(creation.path) });
    }
    checked = true; return register(input);
  };
  const store = new LocalSubmissionStore({ root: join(root, "new-parent", "store"), control: db.control, now: () => now });
  await store.begin({ scope, principal, command: command("submission:create"), submissionId, expiresAt: now });
  await store.writeFile({ scope, principal, command: command("submission:file"), submissionId, receiptId: "receipt" as never, path: "file", bytes: stream("x"), declaredSha256: digest("x") });
  expect(checked).toBe(true);
});

it("repairs an interrupted ancestor sync before a later retry registers bytes", async () => {
  root = await temporary();
  let failed = false;
  const events = directorySyncEvents(async (path) => {
    if (path === root && !failed) { failed = true; throw new Error("transient ancestor sync failure"); }
  });
  const db = catalog();
  const store = new LocalSubmissionStore({ root: join(root, "new-parent", "store"), control: db.control, now: () => now });
  const begin = { scope, principal, command: command("submission:create"), submissionId, expiresAt: now };
  await expect(store.begin(begin)).rejects.toThrow("transient ancestor sync failure");
  expect((await filesystem.lstat(join(root, "new-parent"))).isDirectory()).toBe(true);
  const register = db.control.registerUploadReceipt.bind(db.control);
  let registered = false;
  db.control.registerUploadReceipt = async (input) => {
    expect(events).toContainEqual({ kind: "synced", path: root });
    registered = true;
    return register(input);
  };
  await store.begin(begin);
  await store.writeFile({ scope, principal, command: command("submission:file"), submissionId, receiptId: "receipt" as never, path: "file", bytes: stream("x"), declaredSha256: digest("x") });
  expect(registered).toBe(true);
});

it("syncs the capture root's parent after mkdtemp and before returning a retryable source", async () => {
  root = await temporary(); await filesystem.writeFile(join(root, "file"), "x");
  const events = directorySyncEvents(); const realMkdtemp = filesystem.mkdtemp;
  vi.spyOn(filesystem, "mkdtemp").mockImplementation(async (...args) => {
    const path = await realMkdtemp(...args); events.push({ kind: "created", path: String(path) }); return path;
  });
  const snapshot = await captureWorkspace(root);
  try {
    const creation = events.find((event) => event.kind === "created")!;
    expect(creation).toBeDefined();
    expect(events.slice(events.indexOf(creation) + 1)).toContainEqual({ kind: "synced", path: dirname(creation.path) });
  } finally { await snapshot.release(); }
});
