import { createHash, randomBytes } from "crypto";
import { ulid } from "ulid";
import { getDb } from "../db";

export interface ApiKey {
  id: string;
  customerId: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ApiKeyWithPlainKey extends ApiKey {
  plainKey: string;
}

export interface VerifiedKey {
  id: string;
  customerId: string;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function createApiKey(customerId: string, name: string): ApiKeyWithPlainKey {
  const plainKey = `cvk_${randomBytes(32).toString("hex")}`;
  const keyHash = hashKey(plainKey);
  const id = `ak_${ulid()}`;
  const now = new Date().toISOString();

  const db = getDb();
  db.prepare(
    `INSERT INTO api_keys (id, customer_id, key_hash, name, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, NULL)`
  ).run(id, customerId, keyHash, name, now);

  return {
    id,
    customerId,
    name,
    plainKey,
    createdAt: now,
    lastUsedAt: null,
  };
}

export function verifyKey(plainKey: string): VerifiedKey | null {
  const keyHash = hashKey(plainKey);
  const db = getDb();
  const row = db
    .prepare("SELECT id, customer_id FROM api_keys WHERE key_hash = ?")
    .get(keyHash) as { id: string; customer_id: string } | undefined;

  if (!row) return null;

  // Update last_used_at
  db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    row.id
  );

  return { id: row.id, customerId: row.customer_id };
}

export function listApiKeys(customerId: string): ApiKey[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, customer_id, name, created_at, last_used_at FROM api_keys WHERE customer_id = ? ORDER BY created_at DESC"
    )
    .all(customerId) as any[];

  return rows.map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    name: r.name,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

export function revokeApiKey(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
  return result.changes > 0;
}
