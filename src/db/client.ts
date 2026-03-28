import Database, { Database as DatabaseType } from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "contextvault.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db: DatabaseType = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Auto-create tables on startup
db.exec(`
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    name TEXT NOT NULL,
    latest_commit_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS commits (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    parent_id TEXT,
    metadata TEXT,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
`);
