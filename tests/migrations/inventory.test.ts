import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { legacyFixture, inventory } from './legacy-helpers';

it('inventories an actual checked-out legacy repository without changing its database, index or files', async () => {
  const f = await legacyFixture();
  try {
    const before = { database: await readFile(f.database), index: await readFile(join(f.repo, '.git/index')), notes: await readFile(join(f.repo, 'notes.txt')) };
    const result = await inventory(f.directory, f.database); expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout); expect(report.workspaces).toHaveLength(1);
    expect(report.workspaces[0]).toMatchObject({ workspaceId: 'legacy-a', customerId: 'tenant-a', eligible: true, selectedHead: f.head, issues: [] });
    expect(report.workspaces[0].revisions.map((revision: any) => revision.alias)).toEqual([f.head]);
    expect(await readFile(f.database)).toEqual(before.database); expect(await readFile(join(f.repo, '.git/index'))).toEqual(before.index); expect(await readFile(join(f.repo, 'notes.txt'))).toEqual(before.notes);
  } finally { await f.dispose(); }
});

it('reports all conflicting authority heads and preserves dirty files without selecting a head', async () => {
  const f = await legacyFixture();
  try {
    await writeFile(join(f.repo, 'untracked.txt'), 'owner data');
    await writeFile(join(f.directory, 'workspace-meta/legacy-a.json'), JSON.stringify({ id: 'legacy-a', customerId: 'another-tenant', name: 'legacy workspace', latestCommitId: '0'.repeat(40) }));
    const result = await inventory(f.directory, f.database); expect(result.code, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout).workspaces[0]; expect(value.eligible).toBe(false);
    expect(value.issues.map((issue: any) => issue.code)).toEqual(expect.arrayContaining(['AUTHORITY_CONFLICT', 'DIRTY_WORKSPACE']));
    expect(value.selectedHead).toBeNull();
    expect(value.authorityHeads).toEqual([{ source: 'sqlite', head: f.head }, { source: 'json', head: '0'.repeat(40) }, { source: 'git', head: f.head }]);
    expect(await readFile(join(f.repo, 'untracked.txt'), 'utf8')).toBe('owner data');
    expect((await f.git('rev-parse', 'HEAD')).stdout.trim()).toBe(f.head);
  } finally { await f.dispose(); }
});

it('retains JSON-only ownership records and identifies a mismatched metadata filename', async () => {
  const f = await legacyFixture();
  try {
    const db = new Database(f.database); db.prepare('DELETE FROM workspaces').run(); db.close();
    const first = JSON.parse((await inventory(f.directory, f.database)).stdout).workspaces[0]; expect(first).toMatchObject({ workspaceId: 'legacy-a', customerId: 'tenant-a', eligible: true, selectedHead: f.head });
    await writeFile(join(f.directory, 'workspace-meta/legacy-a.json'), JSON.stringify({ id: 'different-id', customerId: 'tenant-a', name: 'ambiguous name', latestCommitId: f.head }));
    const value = JSON.parse((await inventory(f.directory, f.database)).stdout).workspaces[0];
    expect(value.eligible).toBe(false); expect(value.issues.map((issue: any) => issue.code)).toContain('AUTHORITY_CONFLICT');
  } finally { await f.dispose(); }
});
