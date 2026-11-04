import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { inventory, legacyFixture } from './legacy-helpers';

const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_AUTHOR_NAME: 'inventory acceptance', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'inventory acceptance', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
function inputGit(repository: string, args: string[], input = '') {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repository, ...args], { input, env: environment, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 }).trim();
}
async function snapshot(root: string) {
  const values: Record<string, unknown> = {};
  async function visit(relative: string) {
    for (const name of (await readdir(join(root, relative))).sort()) {
      const path = relative ? relative + '/' + name : name; const file = join(root, path); const stat = await lstat(file);
      if (stat.isSymbolicLink()) values[path] = { link: await readlink(file), mode: stat.mode };
      else if (stat.isDirectory()) await visit(path);
      else values[path] = { mode: stat.mode, mtimeMs: stat.mtimeMs, sha256: createHash('sha256').update(await readFile(file)).digest('hex') };
    }
  }
  await visit(''); return values;
}

for (const scenario of ['case collision', 'reserved path', 'symlink', 'oversized file']) {
  it(`blocks ${scenario} in an old commit beneath a clean head without changing original evidence`, async () => {
    const f = await legacyFixture();
    try {
      const contents = scenario === 'oversized file' ? 'x'.repeat(65) : scenario === 'symlink' ? '../outside.txt' : 'old contents';
      const blob = inputGit(f.repo, ['hash-object', '-w', '--stdin'], contents);
      const entries = scenario === 'case collision' ? [`100644 blob ${blob}\tReport.txt`, `100644 blob ${blob}\treport.txt`] : [`${scenario === 'symlink' ? '120000' : '100644'} blob ${blob}\t${scenario === 'reserved path' ? 'CON.txt' : 'old.txt'}`];
      const badTree = inputGit(f.repo, ['mktree'], entries.join('\n') + '\n');
      const incompatible = inputGit(f.repo, ['commit-tree', badTree, '-p', f.head, '-m', 'incompatible retained revision']);
      const goodTree = (await f.git('rev-parse', f.head + '^{tree}')).stdout.trim();
      const head = inputGit(f.repo, ['commit-tree', goodTree, '-p', incompatible, '-m', 'clean current revision']);
      await f.git('update-ref', 'refs/heads/main', head); await f.git('reset', '--hard', head);
      const db = new Database(f.database); try { db.prepare('UPDATE workspaces SET current_head=? WHERE id=?').run(head, 'legacy-a'); } finally { db.close(); }
      await writeFile(join(f.directory, 'workspace-meta/legacy-a.json'), JSON.stringify({ id: 'legacy-a', customerId: 'tenant-a', name: 'legacy workspace', latestCommitId: head }));
      expect((await f.git('status', '--porcelain')).stdout).toBe('');
      const before = await snapshot(f.directory);
      const result = await inventory(f.directory, f.database, scenario === 'oversized file' ? { maxFileBytes: 64, maxTotalBytes: 128, maxChunkBytes: 32 } : undefined);
      expect(result.code, result.stderr).toBe(0); const report = JSON.parse(result.stdout); const value = report.workspaces.find((workspace: any) => workspace.workspaceId === 'legacy-a');
      expect(value).toMatchObject({ eligible: false, selectedHead: head, customerId: 'tenant-a' });
      expect(value.issues).toEqual(expect.arrayContaining([expect.objectContaining({ revision: incompatible, code: scenario === 'oversized file' ? 'QUOTA_EXCEEDED' : 'INVALID_MANIFEST' })]));
      expect(value.revisions.some((revision: any) => revision.alias === head)).toBe(true);
      expect(await snapshot(f.directory)).toEqual(before);
    } finally { await f.dispose(); }
  });
}

it('reports malformed JSON per workspace while preserving a valid workspace and every source byte', async () => {
  const f = await legacyFixture();
  try {
    await writeFile(join(f.directory, 'workspace-meta/broken.json'), '{broken owner data'); const before = await snapshot(f.directory);
    const result = await inventory(f.directory, f.database); expect(result.code, result.stderr).toBe(0); const values = JSON.parse(result.stdout).workspaces;
    expect(values.find((value: any) => value.workspaceId === 'legacy-a')).toMatchObject({ eligible: true, customerId: 'tenant-a', selectedHead: f.head });
    expect(values.find((value: any) => value.workspaceId === 'broken')).toMatchObject({ eligible: false });
    expect(values.find((value: any) => value.workspaceId === 'broken').issues.length).toBeGreaterThan(0);
    expect(await snapshot(f.directory)).toEqual(before);
  } finally { await f.dispose(); }
});

it('reports an orphan Git repository without inventing ownership or hiding valid workspaces', async () => {
  const f = await legacyFixture();
  try {
    const orphan = join(f.directory, 'workspaces/orphan'); await mkdir(orphan); inputGit(orphan, ['init', '-b', 'main']);
    await writeFile(join(orphan, 'retained.txt'), 'unmapped owner data'); inputGit(orphan, ['add', '.']); inputGit(orphan, ['commit', '-m', 'retain original unmapped repository']);
    const before = await snapshot(f.directory); const result = await inventory(f.directory, f.database); expect(result.code, result.stderr).toBe(0); const values = JSON.parse(result.stdout).workspaces;
    expect(values.find((value: any) => value.workspaceId === 'legacy-a')).toMatchObject({ eligible: true, customerId: 'tenant-a' });
    expect(values.find((value: any) => value.workspaceId === 'orphan')).toMatchObject({ eligible: false, customerId: null, repository: orphan });
    expect(values.find((value: any) => value.workspaceId === 'orphan').issues.length).toBeGreaterThan(0);
    expect(await snapshot(f.directory)).toEqual(before);
  } finally { await f.dispose(); }
});
