import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { initSchema } from '../../src/db';
import { inventory, legacyFixture } from './legacy-helpers';

for (const status of ['ready', 'running', 'finalizing']) it(`blocks surviving ${status} legacy work and expired locks while preserving original database and sandbox bytes`, async () => {
  const f = await legacyFixture();
  try {
    const sandbox = join(f.directory, 'sandboxes', 'run-a'); await mkdir(sandbox, { recursive: true }); await writeFile(join(sandbox, 'uncommitted.txt'), 'agent-owned unfinished contents');
    const db = new Database(f.database); initSchema(db);
    db.prepare('INSERT INTO runs(id,workspace_id,agent_id,base_commit,workspace_head_at_start,status,sandbox_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('run-a', 'legacy-a', 'existing-agent', f.head, f.head, status, sandbox, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO locks VALUES(?,?,?,?,?,?,?)').run('lock-a', 'legacy-a', 'exclusive', 'run-a', '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z', '2020-01-01T00:00:00.000Z'); db.close();
    const before = await readFile(f.database); const result = await inventory(f.directory, f.database); expect(result.code, result.stderr).toBe(0); const value = JSON.parse(result.stdout).workspaces[0];
    expect(value.eligible).toBe(false); expect(value.issues.map((issue: any) => issue.code)).toEqual(expect.arrayContaining(['SURVIVING_RUN', 'SURVIVING_LOCK', 'SURVIVING_SANDBOX']));
    expect(value.legacyWork.runs).toEqual([expect.objectContaining({ id: 'run-a', status, sandboxPath: sandbox })]); expect(value.legacyWork.locks).toEqual([expect.objectContaining({ id: 'lock-a', ownerRunId: 'run-a', expiresAt: '2020-01-02T00:00:00.000Z' })]);
    expect(value.legacyWork.sandboxes).toEqual([expect.objectContaining({ path: sandbox, runId: 'run-a', exists: true })]);
    expect(await readFile(f.database)).toEqual(before); expect(await readFile(join(sandbox, 'uncommitted.txt'), 'utf8')).toBe('agent-owned unfinished contents'); expect((await f.git('status', '--porcelain')).stdout).toBe('');
  } finally { await f.dispose(); }
});

it('blocks an orphan legacy sandbox directory without inventing a settled run', async () => {
  const f = await legacyFixture();
  try { const sandbox = join(f.directory, 'sandboxes', 'unmapped-run'); await mkdir(sandbox, { recursive: true }); await writeFile(join(sandbox, 'draft.txt'), 'unmapped unfinished data');
    const result = await inventory(f.directory, f.database); expect(result.code, result.stderr).toBe(0); const value = JSON.parse(result.stdout).workspaces[0]; expect(value.eligible).toBe(false);
    expect(value.legacyWork.sandboxes).toEqual([expect.objectContaining({ path: sandbox, runId: null, exists: true })]); expect(await readFile(join(sandbox, 'draft.txt'), 'utf8')).toBe('unmapped unfinished data');
  } finally { await f.dispose(); }
});
