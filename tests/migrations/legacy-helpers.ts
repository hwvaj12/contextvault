import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const gitEnvironment = { ...process.env, GIT_AUTHOR_NAME: 'migration fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'migration fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
export async function legacyFixture() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'cv-legacy-inventory-'));
  const repo = join(directory, 'workspaces', 'legacy-a'); await mkdir(repo, { recursive: true });
  const git = (...args: string[]) => execute('git', ['-C', repo, ...args], { env: gitEnvironment });
  await git('init', '-b', 'main'); await writeFile(join(repo, 'notes.txt'), 'accepted old contents\n'); await git('add', '.'); await git('commit', '-m', 'legacy accepted revision');
  const head = (await git('rev-parse', 'HEAD')).stdout.trim();
  const database = join(directory, 'legacy.db'); const db = new Database(database);
  db.exec('CREATE TABLE workspaces(id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,repo_location TEXT NOT NULL,current_head TEXT,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)');
  db.prepare('INSERT INTO workspaces VALUES(?,?,?,?,?,?,?,?)').run('legacy-a', 'tenant-a', 'legacy workspace', repo, head, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'); db.close();
  await mkdir(join(directory, 'workspace-meta')); await writeFile(join(directory, 'workspace-meta', 'legacy-a.json'), JSON.stringify({ id: 'legacy-a', customerId: 'tenant-a', name: 'legacy workspace', latestCommitId: head }));
  return { directory, repo, head, database, git, async dispose() { await rm(directory, { recursive: true, force: true }); } };
}
export async function inventory(directory: string, database: string, limits?: Record<string, number>) {
  try {
    const result = await execute(process.execPath, ['-r', join(root, 'node_modules/ts-node/register/transpile-only'), join(root, 'scripts/migrate-workspaces.ts'), 'inventory', '--source-root', directory, '--database', database, ...(limits ? ['--limits-json', JSON.stringify(limits)] : []), '--json'], { cwd: root, timeout: 15000, maxBuffer: 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: any) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}
