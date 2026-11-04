import { describe, it, expect } from "vitest";
import { createTestDb } from "../../src/db";
describe("transactional catalog schema", () => {
    it("initializes versioned catalog tables while preserving legacy columns", () => {
        const db = createTestDb();
        try {
            const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
                name: string;
            }[];
            expect(tables.map(t => t.name)).toContain("catalog_schema_migrations");
            expect(tables.map(t => t.name)).toContain("catalog_records");
            expect(db.prepare("PRAGMA table_info(workspaces)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "current_head" })]));
        }
        finally {
            db.close();
        }
    });
});
it("leaves an existing legacy head readable and absent from accepted catalog state after reopen", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs"), { join } = await import("node:path"), { tmpdir } = await import("node:os");
    const { SqliteControlStore } = await import("../../src/adapters/control/sqlite-control-store");
    const directory = mkdtempSync(join(tmpdir(), "cv-upgrade-"));
    const filename = join(directory, "catalog.sqlite");
    let db = createTestDb(filename);
    try {
        db.prepare("INSERT INTO workspaces(id,customer_id,name,repo_location,current_head,created_at,updated_at,last_accessed_at) VALUES(?,?,?,?,?,?,?,?)").run("legacy", "tenant-a", "legacy", "/old/repo", "ambiguous-head", "now", "now", "now");
        db.close();
        db = createTestDb(filename);
        expect(db.prepare("SELECT current_head FROM workspaces WHERE id='legacy'").get()).toEqual({ current_head: "ambiguous-head" });
        expect(await new SqliteControlStore(db).getWorkspace({ customerId: "tenant-a", workspaceId: "legacy" } as any)).toBeNull();
        expect(db.prepare("SELECT COUNT(*) AS count FROM catalog_records WHERE kind='revision'").get()).toEqual({ count: 0 });
    }
    finally {
        db.close();
        rmSync(directory, { recursive: true, force: true });
    }
});
it("bootstraps the usable concrete store against a raw SQLite connection", async () => { const { default: Database } = await import("better-sqlite3"); const { bootstrapAuthority, SqliteControlStore } = await import("../../src/adapters/control/sqlite-control-store"); const { authority, principal, scope } = await import("./helpers"); const db = new Database(":memory:"); try {
    const store = new SqliteControlStore(db);
    bootstrapAuthority(db, authority);
    expect(await store.getAuthority(scope, principal)).toEqual(authority);
}
finally {
    db.close();
} });
