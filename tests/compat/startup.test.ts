import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { it, expect } from 'vitest';
import { storageEnvironment, cleanupHttpStorage } from '../http/helpers';
const execute = promisify(execFile);
it('starts with an explicit data root without creating or changing legacy CWD storage', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'cv-compat-startup-')); const cwd = join(directory, 'readonly-cwd'); const storage = storageEnvironment();
  await mkdir(join(cwd, 'data', 'workspaces'), { recursive: true }); await writeFile(join(cwd, 'data', 'workspaces', 'retained.txt'), 'retained original layout');
  await chmod(join(cwd, 'data'), 0o500); await chmod(cwd, 0o500);
  const root = resolve(import.meta.dirname, '../..');
  try {
    await execute(process.execPath, ['-r', join(root, 'node_modules/ts-node/register/transpile-only'), '-e', `const { createApp } = require(${JSON.stringify(join(root, 'src/app.ts'))}); createApp({ logger: false, contextVault: { maintenance: false } }).then(async app => { await app.ready(); await app.close(); }).catch(() => { process.exitCode = 1; });`], { cwd, timeout: 15_000, env: { PATH: process.env.PATH, HOME: directory, ...storage, CV_DATA_DIR: join(directory, 'configured-private'), CONTEXTVAULT_API_KEY: 'fixture-startup-master', TS_NODE_PROJECT: join(root, 'tsconfig.json') } });
    await access(join(directory, 'configured-private', 'contextvault.db'));
    expect(await readFile(join(cwd, 'data', 'workspaces', 'retained.txt'), 'utf8')).toBe('retained original layout');
    await expect(access(join(cwd, 'data', 'workspace-meta'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(cwd, 'data', 'sandboxes'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await chmod(cwd, 0o700); await chmod(join(cwd, 'data'), 0o700); await cleanupHttpStorage(storage); await rm(directory, { recursive: true, force: true }); }
});
