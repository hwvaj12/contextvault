import { expect, it } from 'vitest';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db';
import { inventory, legacyFixture } from './legacy-helpers';

it('never invokes a repository content filter while inspecting same-sized dirty bytes', async () => {
  const f = await legacyFixture();
  try {
    await writeFile(join(f.repo, '.gitattributes'), 'notes.txt filter=inventory\n');
    await f.git('add', '.gitattributes'); await f.git('commit', '-m', 'retain legacy attributes');
    const head = (await f.git('rev-parse', 'HEAD')).stdout.trim();
    const db = new Database(f.database); db.prepare('UPDATE workspaces SET current_head=?').run(head); db.close();
    await writeFile(join(f.directory, 'workspace-meta/legacy-a.json'), JSON.stringify({ id: 'legacy-a', customerId: 'tenant-a', name: 'legacy workspace', latestCommitId: head }));
    await f.git('config', 'filter.inventory.clean', 'touch inventory-wrote; cat');
    const bytes = Buffer.from('modified old contents\n');
    expect(bytes.length).toBe((await readFile(join(f.repo, 'notes.txt'))).length);
    await writeFile(join(f.repo, 'notes.txt'), bytes);
    const original = { database: await readFile(f.database), index: await readFile(join(f.repo, '.git/index')), configuration: await readFile(join(f.repo, '.git/config')) };
    const result = await inventory(f.directory, f.database); expect(result.code, result.stderr).toBe(0);
    await expect(readFile(join(f.repo, 'inventory-wrote'))).rejects.toMatchObject({ code: 'ENOENT' });
    const value = JSON.parse(result.stdout).workspaces[0]; expect(value.eligible).toBe(false);
    expect(value.issues.some((issue: any) => issue.code === 'UNSUPPORTED_GIT_FILTER')).toBe(true);
    expect(result.stdout).not.toContain('touch inventory-wrote');
    expect(await readFile(f.database)).toEqual(original.database); expect(await readFile(join(f.repo, '.git/index'))).toEqual(original.index);
    expect(await readFile(join(f.repo, '.git/config'))).toEqual(original.configuration); expect(await readFile(join(f.repo, 'notes.txt'))).toEqual(bytes);
  } finally { await f.dispose(); }
});

it('retains every workspace owner when terminal legacy runs share surviving sandbox data', async () => {
  const f = await legacyFixture();
  try {
    const second = join(f.directory, 'workspaces/legacy-b'); await cp(f.repo, second, { recursive: true });
    const sandbox = join(f.directory, 'sandboxes/shared'); await mkdir(sandbox, { recursive: true }); await writeFile(join(sandbox, 'draft.txt'), 'retained shared draft');
    const db = new Database(f.database); initSchema(db);
    db.prepare('INSERT INTO workspaces(id,customer_id,name,repo_location,current_head,status,created_at,updated_at) SELECT ?,customer_id,name,?,current_head,status,created_at,updated_at FROM workspaces WHERE id=?').run('legacy-b', second, 'legacy-a');
    for (const [runId, workspaceId] of [['run-a', 'legacy-a'], ['run-b', 'legacy-b']]) db.prepare('INSERT INTO runs(id,workspace_id,agent_id,base_commit,workspace_head_at_start,status,sandbox_path,completed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(runId, workspaceId, 'legacy agent', f.head, f.head, 'merged', sandbox, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    db.close();
    await writeFile(join(f.directory, 'workspace-meta/legacy-b.json'), JSON.stringify({ id: 'legacy-b', customerId: 'tenant-a', name: 'legacy workspace', latestCommitId: f.head }));
    const original = await readFile(f.database);
    const result = await inventory(f.directory, f.database); expect(result.code, result.stderr).toBe(0);
    const values = JSON.parse(result.stdout).workspaces;
    for (const [index, runId] of ['run-a', 'run-b'].entries()) {
      expect(values[index].eligible).toBe(false); expect(values[index].issues.map((issue: any) => issue.code)).toContain('SURVIVING_SANDBOX');
      expect(values[index].legacyWork.sandboxes).toEqual([expect.objectContaining({ path: sandbox, runId, exists: true })]);
    }
    expect(await readFile(f.database)).toEqual(original); expect(await readFile(join(sandbox, 'draft.txt'), 'utf8')).toBe('retained shared draft');
  } finally { await f.dispose(); }
});

it('reports ignored untracked contents as unresolved dirty work rather than silently adopting around them', async () => {
  const f = await legacyFixture();
  try {
    await writeFile(join(f.repo, '.git/info/exclude'), 'unfinished.txt\n'); await writeFile(join(f.repo, 'unfinished.txt'), 'retained ignored draft');
    const result = await inventory(f.directory, f.database); expect(result.code, result.stderr).toBe(0); const value = JSON.parse(result.stdout).workspaces[0];
    expect(value.eligible).toBe(false); expect(value.issues.map((issue: any) => issue.code)).toContain('DIRTY_WORKSPACE');
    expect(await readFile(join(f.repo, 'unfinished.txt'), 'utf8')).toBe('retained ignored draft');
  } finally { await f.dispose(); }
});
