import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { call, migrationFixture } from './helpers';
import { inventory, legacyFixture } from './legacy-helpers';
import { waitClaim } from './process-helpers';
const root = resolve(import.meta.dirname, '../..'); const execute = promisify(execFile);
for (const jsonOnly of [false, true]) it(`explicitly adopts a clean ${jsonOnly ? 'JSON-only' : 'SQLite/JSON'} checked-out repository into catalog authority with immutable original backups`, async () => {
  const legacy = await legacyFixture(); const f = await migrationFixture();
  try {
    await writeFile(join(legacy.repo, 'binary.bin'), Buffer.from([0, 255, 128])); await legacy.git('add', '.'); await legacy.git('commit', '-m', 'binary history'); const head = (await legacy.git('rev-parse', 'HEAD')).stdout.trim();
    const db = new Database(legacy.database); if (jsonOnly) db.prepare('DELETE FROM workspaces').run(); else db.prepare('UPDATE workspaces SET customer_id=?,current_head=?').run(f.client.customerA, head); db.close();
    await writeFile(join(legacy.directory, 'workspace-meta/legacy-a.json'), JSON.stringify({ id: 'legacy-a', customerId: f.client.customerA, name: 'legacy workspace', latestCommitId: head }));
    const report = JSON.parse((await inventory(legacy.directory, legacy.database)).stdout); expect(report.workspaces[0].eligible).toBe(true);
    const original = { database: await readFile(legacy.database), index: await readFile(join(legacy.repo, '.git/index')), metadata: await readFile(join(legacy.directory, 'workspace-meta/legacy-a.json')) };
    const args = ['-r', join(root, 'node_modules/ts-node/register/transpile-only'), join(root, 'scripts/migrate-workspaces.ts'), 'adopt', '--source-root', legacy.directory, '--database', legacy.database, '--workspace', 'legacy-a', '--customer', f.client.customerA, '--source-fingerprint', report.sourceFingerprint, '--target-profile', f.configuration.profiles.find(value => value.backend === 's3')!.configurationRef, '--backup-root', join(f.directory, 'legacy-backups'), '--idempotency-key', 'reviewed-adoption', '--reason', 'adopt reviewed offline legacy context', '--source-offline', '--json'];
    const env = { PATH: process.env.PATH, TS_NODE_PROJECT: join(root, 'tsconfig.json'), ...f.storage, CV_STORAGE_BACKEND: 'git', CV_DATA_DIR: f.configuration.dataDirectory, CV_MIGRATION_API_KEY: f.client.keyA };
    expect((await call(f.client, '/v1/workspaces/legacy-a')).status).toBe(404);
    let interrupted: any;
    if (jsonOnly) {
      const input = { scope: { customerId: f.client.customerA, workspaceId: 'legacy-a' }, idempotencyKey: 'reviewed-adoption', request: { sourceFingerprint: report.sourceFingerprint, targetConfigurationRef: f.configuration.profiles.find(value => value.backend === 's3')!.configurationRef, backupRoot: join(f.directory, 'legacy-backups'), reason: 'adopt reviewed offline legacy context', sourceOffline: true } };
      const child = fork(join(root, 'tests/migrations/adoption-worker.ts'), [], { cwd: root, execArgv: ['-r', join(root, 'node_modules/ts-node/register/transpile-only')], env: { ...env, CV_PROCESSING_TTL_MS: '5000', CV_ADOPT_INPUT: JSON.stringify(input), CV_ADOPT_SOURCE: legacy.directory, CV_ADOPT_DATABASE: legacy.database }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let errors = ''; child.stderr!.on('data', value => { errors += value; }); child.stdout!.resume();
      try { interrupted = await new Promise<any>((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`Adoption worker timed out: ${errors}`)), 20000); child.once('message', value => { clearTimeout(timer); resolve((value as any).adoption); }); child.once('exit', code => { clearTimeout(timer); reject(new Error(`Adoption worker exited ${code}: ${errors}`)); }); }); expect(interrupted.copies).toHaveLength(0); const exit = new Promise(resolve => child.once('exit', (_code, signal) => resolve(signal))); child.kill('SIGKILL'); expect(await exit).toBe('SIGKILL'); }
      finally { child.kill('SIGKILL'); }
      expect((await call(f.client, '/v1/workspaces/legacy-a')).status).toBe(404); await waitClaim(interrupted);
    }
    const result = JSON.parse((await execute(process.execPath, args, { cwd: root, env, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout); expect(result).toMatchObject({ state: 'complete', workspaceId: 'legacy-a', revisions: 2 }); expect(result.currentRevisionId).not.toBe(head);
    const accepted = await call(f.client, '/v1/workspaces/legacy-a'); expect(accepted.status).toBe(200); expect(accepted.body).toMatchObject({ id: 'legacy-a', customerId: f.client.customerA, currentRevisionId: result.currentRevisionId });
    if (interrupted) { const recovered = (await f.app.contextVault.control.getLegacyAdoption(interrupted.scope, interrupted.id))!; expect(recovered.candidates).toEqual(interrupted.candidates); expect(recovered.claim.fence).toBe(interrupted.claim.fence + 1); }
    const scope: any = { customerId: f.client.customerA, workspaceId: 'legacy-a' }; const oldAlias = (await f.app.contextVault.control.getLegacyRevisionAlias(scope, legacy.head))!; const headAlias = (await f.app.contextVault.control.getLegacyRevisionAlias(scope, head))!;
    const history = (await call(f.client, '/v1/workspaces/legacy-a/revisions')).body.revisions; expect(history.map((value: any) => value.id).sort()).toEqual([oldAlias.revisionId, headAlias.revisionId].sort()); expect(history.find((value: any) => value.id === headAlias.revisionId).parentRevisionId).toBe(oldAlias.revisionId); expect(headAlias.revisionId).toBe(result.currentRevisionId);
    const file = await fetch(`${f.client.baseUrl}/v1/workspaces/legacy-a/revisions/${head}/files?path=binary.bin`, { headers: { 'X-API-Key': f.client.keyA } }); expect(file.status).toBe(200); expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from([0, 255, 128]));
    expect(oldAlias.alias).toBe(legacy.head); expect(oldAlias.revisionId).not.toBe(legacy.head);
    expect(await readFile(legacy.database)).toEqual(original.database); expect(await readFile(join(legacy.repo, '.git/index'))).toEqual(original.index); expect(await readFile(join(legacy.directory, 'workspace-meta/legacy-a.json'))).toEqual(original.metadata);
    expect(await readFile(join(result.backupDirectory, 'repository/binary.bin'))).toEqual(Buffer.from([0, 255, 128])); expect(await readFile(join(result.backupDirectory, 'metadata/legacy.db'))).toEqual(original.database);
    expect(JSON.parse((await execute(process.execPath, args, { cwd: root, env, timeout: 30000 })).stdout)).toEqual(result);
  } finally { await legacy.dispose(); await f.dispose(); }
}, 60000);
