import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createApp } from '../../src/app';
import { loadConfiguration } from '../../src/config';
import { WorkspaceError } from '../../src/domain';
import { FilesystemLegacyInventory } from '../../src/adapters/control/legacy-inventory';
import { migrationPrincipal } from '../../src/adapters/control/migration-auth';
import { LegacyAdoptionService } from '../../src/application/migrations/adoption';
import { StorageMigrationService } from '../../src/application/migrations/storage';
import { call, workspace } from '../revisions/helpers';
import { legacyFixture } from './legacy-helpers';
import type { RuntimeOptions } from '../../src/config/runtime';

// Lead-owned independent probes. Both use real Git, SQLite and HTTP without Docker or S3.
async function gitFixture(hook?: NonNullable<RuntimeOptions['lifecycle']>['hook']) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'cv-migration-review-'));
  const master = 'owned-review-' + randomUUID();
  const alternate = { backend: 'git', rootDirectory: join(directory, 'alternate-revisions'), submissionRoot: join(directory, 'alternate-submissions') };
  const configuration = loadConfiguration({ CV_STORAGE_BACKEND: 'git', CV_DATA_DIR: join(directory, 'private'), CONTEXTVAULT_API_KEY: master, CV_STORAGE_PROFILES: JSON.stringify([alternate]) });
  const app = await createApp({ logger: false, contextVault: { configuration, maintenance: false, lifecycle: { hook } } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const client: any = { baseUrl: `http://127.0.0.1:${(app.server.address() as any).port}`, customerA: 'review-a' };
  const key = await call(client, '/api-keys', 'POST', { customerId: client.customerA, name: 'owned migration review' }, master);
  expect(key.status).toBe(201); client.keyA = key.body.plainKey;
  expect((await call(client, '/v1/workspaces')).status).toBe(200);
  return { app, directory, configuration, client, async dispose() { app.server.closeAllConnections(); await app.close(); await rm(directory, { recursive: true, force: true }); } };
}

it('adopts two independent legacy workspaces that retain the same Git commit without global revision identity collisions', async () => {
  const legacy = await legacyFixture(); const f = await gitFixture();
  try {
    await cp(legacy.repo, join(legacy.directory, 'workspaces/legacy-b'), { recursive: true });
    const db = new Database(legacy.database);
    db.prepare('UPDATE workspaces SET customer_id=?').run(f.client.customerA);
    db.prepare('INSERT INTO workspaces SELECT ?,customer_id,name,?,current_head,status,created_at,updated_at FROM workspaces WHERE id=?').run('legacy-b', join(legacy.directory, 'workspaces/legacy-b'), 'legacy-a');
    db.close();
    for (const id of ['legacy-a', 'legacy-b']) await writeFile(join(legacy.directory, 'workspace-meta', id + '.json'), JSON.stringify({ id, customerId: f.client.customerA, name: 'legacy workspace', latestCommitId: legacy.head }));
    const source = new FilesystemLegacyInventory({ sourceRoot: legacy.directory, databasePath: legacy.database });
    const inventory = await source.inspect(); expect(inventory.workspaces.map(value => value.eligible)).toEqual([true, true]);
    const runtime = f.app.contextVault;
    const principal = migrationPrincipal(runtime.database, f.client.keyA, f.client.customerA, runtime.now(), f.configuration.masterKey);
    const adopted = [];
    for (const workspaceId of ['legacy-a', 'legacy-b']) {
      const scope: any = { customerId: f.client.customerA, workspaceId };
      const value = await new LegacyAdoptionService(runtime, source).adopt({ scope, principal, idempotencyKey: 'owned-adoption-' + workspaceId, request: { sourceFingerprint: inventory.sourceFingerprint, targetConfigurationRef: f.configuration.defaultConfigurationRef, backupRoot: join(f.directory, 'backups'), reason: 'retain independent legacy workspace identities', sourceOffline: true } });
      expect(value.state).toBe('complete'); expect(value.workspace.id).toBe(workspaceId); adopted.push(value);
      const alias = await runtime.control.getLegacyRevisionAlias(scope, legacy.head);
      expect(alias?.revisionId).toBe(value.workspace.currentRevisionId);
      const read = await fetch(`${f.client.baseUrl}/v1/workspaces/${workspaceId}/revisions/${legacy.head}/files?path=notes.txt`, { headers: { 'X-API-Key': f.client.keyA } });
      expect(read.status).toBe(200); expect(await read.text()).toBe('accepted old contents\n');
    }
    expect(adopted[0].workspace.currentRevisionId).not.toBe(adopted[1].workspace.currentRevisionId);
  } finally { await legacy.dispose(); await f.dispose(); }
}, 60000);

it('releases a clone source after its exact target creation records a terminal failure so migration can drain', async () => {
  let failTarget = false;
  const f = await gitFixture(async (stage, operation) => {
    if (failTarget && stage === 'before-prepare' && operation.kind === 'workspace:create') throw new WorkspaceError('INVALID_MANIFEST', 'owned terminal target creation failure');
  });
  try {
    const source = await workspace(f.client); failTarget = true;
    const cloned = await call(f.client, `/v1/workspaces/${source.id}/clone`, 'POST', { targetCustomerId: f.client.customerA, name: 'failed target' }, f.client.keyA, 'owned-terminal-clone');
    expect(cloned.status).toBe(422); expect(cloned.body.error.code).toBe('INVALID_MANIFEST');
    const runtime = f.app.contextVault; const scope: any = { customerId: f.client.customerA, workspaceId: source.id };
    const failedCreation = runtime.database.prepare("SELECT data FROM catalog_records WHERE kind='operation' AND json_extract(data,'$.kind')='workspace:create' AND json_extract(data,'$.state')='failed'").all() as { data: string }[];
    expect(failedCreation).toHaveLength(1);
    const pins = await runtime.control.listCopySourcePins(scope); expect(pins).toHaveLength(1);
    expect(JSON.parse(failedCreation[0].data).scope.workspaceId).toBe(pins[0].target.workspaceId);
    const principal = migrationPrincipal(runtime.database, f.client.keyA, f.client.customerA, runtime.now(), f.configuration.masterKey);
    const target = f.configuration.profiles.find(profile => profile.configurationRef !== f.configuration.defaultConfigurationRef)!;
    const transferred = await new StorageMigrationService(runtime).transfer({ scope, principal, idempotencyKey: 'owned-after-failed-clone', request: { targetConfigurationRef: target.configurationRef, backupRoot: join(f.directory, 'backups'), reason: 'drain proven terminal failed clone' } });
    expect(transferred.state).toBe('complete'); expect((await runtime.control.listCopySourcePins(scope))[0].state).toBe('released');
  } finally { await f.dispose(); }
}, 60000);
