import type Database from "better-sqlite3";
/** Additive migrations deliberately leave legacy heads unimported. CV-25 owns reconciliation. */
export function migrateCatalog(database: Database.Database): void {
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    database.transaction(() => {
        database.exec(`
      CREATE TABLE IF NOT EXISTS catalog_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS catalog_records (
        kind TEXT NOT NULL, id TEXT NOT NULL, customer_id TEXT NOT NULL, workspace_id TEXT,
        run_id TEXT, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(kind,id)
      );
      CREATE INDEX IF NOT EXISTS catalog_scope ON catalog_records(kind,customer_id,workspace_id,id);
      CREATE INDEX IF NOT EXISTS catalog_run ON catalog_records(kind,customer_id,workspace_id,run_id);
      CREATE TABLE IF NOT EXISTS catalog_commands (
        scope TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
        value TEXT CHECK(value IS NULL OR json_valid(value)), PRIMARY KEY(scope,key)
      );
    `);
        const future = database.prepare("SELECT version FROM catalog_schema_migrations WHERE version > 2 LIMIT 1").get();
        if (future)
            throw new Error("Catalog schema is newer than this application");
        database.exec(`
      CREATE INDEX IF NOT EXISTS catalog_lifecycle_scan ON catalog_records(kind,json_extract(data,'$.state'),json_extract(data,'$.lease.expiresAt'),id);
      CREATE INDEX IF NOT EXISTS catalog_claim_scan ON catalog_records(kind,json_extract(data,'$.state'),json_extract(data,'$.claim.expiresAt'),id);
      CREATE UNIQUE INDEX IF NOT EXISTS catalog_run_cleanup ON catalog_records(json_extract(data,'$.cleanupId')) WHERE kind='run';
      CREATE INDEX IF NOT EXISTS catalog_due_scan ON catalog_records(kind,json_extract(data,'$.nextAttemptAt'),id);
    `);
        database.prepare("INSERT OR IGNORE INTO catalog_schema_migrations(version,applied_at) VALUES(2,?)").run(new Date().toISOString());
        database.prepare("INSERT OR IGNORE INTO catalog_schema_migrations(version,applied_at) VALUES(1,?)").run(new Date().toISOString());
    }).immediate();
}
