import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { call, migrationFixture, publish, workspace } from './helpers';
import { transferInput } from './process-helpers';

const execute = promisify(execFile); const root = resolve(import.meta.dirname, '../..');
it('moves exact accepted history Git to S3 and back through an explicit operator command with HTTP readback', async () => {
  const f = await migrationFixture();
  try {
    const c = f.client; const w = await workspace(c);
    const first = await publish(c, w.id, { 'binary.bin': Buffer.from([0, 255, 128]), 'removed.txt': Buffer.from('retained old bytes') }, ['empty']);
    const head = await publish(c, w.id, { 'binary.bin': Buffer.from([0, 255, 128, 10]) }, ['empty']);
    const input = transferInput(f, w.id); const rt = f.app.contextVault.lifecycle.runtime; const aliases: any = [{ alias: 'release-before-transfer', revisionId: first }]; const command = rt.command('revision:alias', { ...input, idempotencyKey: 'retained-alias', request: { aliases } }, input.scope);
    await f.app.contextVault.control.registerLegacyRevisionAliases({ scope: input.scope, principal: input.principal, authorization: await rt.authorize(input.principal, 'workspace:admin', input.scope), command, expectedWorkspaceVersion: (await f.app.contextVault.control.getWorkspace(input.scope))!.version, aliases, events: rt.events({ id: command.operationId, scope: input.scope, runId: null, principal: input.principal }, 'workspace.alias-added') });
    const history = (await call(c, `/v1/workspaces/${w.id}/revisions`)).body;
    const env = { PATH: process.env.PATH, TS_NODE_PROJECT: join(root, 'tsconfig.json'), CV_DATA_DIR: f.configuration.dataDirectory, ...f.storage, CV_STORAGE_BACKEND: 'git', CV_MIGRATION_API_KEY: c.keyA };
    for (const backend of ['s3', 'git']) {
      const profile = f.configuration.profiles.find(value => value.backend === backend)!;
      const result = await execute(process.execPath, ['-r', join(root, 'node_modules/ts-node/register/transpile-only'), join(root, 'scripts/migrate-storage.ts'), 'transfer', '--customer', c.customerA, '--workspace', w.id, '--target-profile', profile.configurationRef, '--backup-root', join(f.directory, 'backups'), '--idempotency-key', `migration-${backend}`, '--reason', 'independent operator parity check'], { cwd: root, env, timeout: 60000, maxBuffer: 1024 * 1024 });
      expect(JSON.parse(result.stdout)).toMatchObject({ state: 'complete', backend, currentRevisionId: head, revisions: 3 });
      const current = (await call(c, `/v1/workspaces/${w.id}`)).body; expect(current.currentRevisionId).toBe(head);
      const scope: any = { customerId: c.customerA, workspaceId: w.id }; const accepted = (await f.app.contextVault.control.getWorkspace(scope))!; expect((await f.app.contextVault.control.getBinding(scope, accepted.storageBindingId))?.backend).toBe(backend);
      expect((await call(c, `/v1/workspaces/${w.id}/revisions`)).body).toEqual(history);
      expect(await f.app.contextVault.control.getLegacyRevisionAlias(input.scope, aliases[0].alias)).toEqual(aliases[0]); expect(current.customerId).toBe(c.customerA);
      const old = await fetch(`${c.baseUrl}/v1/workspaces/${w.id}/revisions/${first}/files?path=removed.txt`, { headers: { 'X-API-Key': c.keyA } }); expect(old.status).toBe(200); expect(await old.text()).toBe('retained old bytes');
      const binary = await fetch(`${c.baseUrl}/v1/workspaces/${w.id}/revisions/${head}/files?path=binary.bin`, { headers: { 'X-API-Key': c.keyA } }); expect(binary.status).toBe(200); expect(Buffer.from(await binary.arrayBuffer())).toEqual(Buffer.from([0, 255, 128, 10]));
      expect((await call(c, `/v1/workspaces/${w.id}/revisions/${head}/manifest`)).body.entries.map((entry: any) => entry.path)).toEqual(['binary.bin', 'empty']);
    }
  } finally { await f.dispose(); }
}, 180000);
