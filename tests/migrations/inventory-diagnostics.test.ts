import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { inventory, legacyFixture } from './legacy-helpers';

const environment = { ...process.env, GIT_AUTHOR_NAME: 'diagnostic fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'diagnostic fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
const cases = [
  { kind: 'collision', path: 'report.txt', rule: 'Manifest contains portable-name collisions' },
  { kind: 'reserved', path: 'CON.txt', rule: 'Path contains a reserved Windows name' },
  { kind: 'symlink', path: 'link.txt', rule: 'Legacy history contains a link or unsupported Git entry' },
  { kind: 'oversized', path: 'large.bin', rule: 'Legacy retained file exceeds its byte limit' },
];
for (const scenario of cases) it(`reports the exact old revision, offending ${scenario.kind} path and violated rule without file contents`, async () => {
  const f = await legacyFixture();
  try {
    const git = (args: string[], input = '') => execFileSync('git', ['-C', f.repo, ...args], { env: environment, input, encoding: 'utf8' }).trim(); const secret = 'do-not-print-source-file-contents'; const blob = git(['hash-object', '-w', '--stdin'], scenario.kind === 'oversized' ? secret.repeat(3) : secret);
    const records = scenario.kind === 'collision' ? [`100644 blob ${blob}\tReport.txt`, `100644 blob ${blob}\treport.txt`] : [`${scenario.kind === 'symlink' ? '120000' : '100644'} blob ${blob}\t${scenario.path}`];
    const tree = git(['mktree'], records.join('\n') + '\n'); const bad = git(['commit-tree', tree, '-p', f.head, '-m', 'incompatible old revision']); const head = git(['commit-tree', git(['rev-parse', f.head + '^{tree}']), '-p', bad, '-m', 'clean head']); await f.git('update-ref', 'refs/heads/main', head); await f.git('reset', '--hard', head);
    const db = new Database(f.database); db.prepare('UPDATE workspaces SET current_head=?').run(head); db.close(); await writeFile(join(f.directory, 'workspace-meta/legacy-a.json'), JSON.stringify({ id: 'legacy-a', customerId: 'tenant-a', name: 'legacy workspace', latestCommitId: head }));
    const result = await inventory(f.directory, f.database, scenario.kind === 'oversized' ? { maxFileBytes: 64, maxTotalBytes: 128, maxChunkBytes: 32 } : undefined); expect(result.code, result.stderr).toBe(0); const value = JSON.parse(result.stdout).workspaces[0];
    expect(value.issues).toEqual(expect.arrayContaining([expect.objectContaining({ revision: bad, path: scenario.path, rule: scenario.rule })])); expect(result.stdout).not.toContain(secret); expect(value.selectedHead).toBe(head); expect((await f.git('cat-file', 'blob', blob)).stdout).toBe(scenario.kind === 'oversized' ? secret.repeat(3) : secret);
  } finally { await f.dispose(); }
});
