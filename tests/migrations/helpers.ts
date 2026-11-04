import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { createApp } from '../../src/app';
import { loadConfiguration } from '../../src/config';
import { cleanupHttpStorage } from '../http/helpers';
import { call, publish, workspace } from '../revisions/helpers';
// @ts-ignore explicit JavaScript verification contract
import { requireS3 } from '../../scripts/run-workspace-tests.mjs';
export { call, publish, workspace };

export async function migrationFixture(settings: NodeJS.ProcessEnv = {}) {
  const target = { ...process.env }; requireS3(target, { s3Provider: target.CV_TEST_S3_PROVIDER });
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'cv-migration-'));
  const storage = { CV_STORAGE_BACKEND: 's3', CV_S3_PROVIDER: target.CV_TEST_S3_PROVIDER!, CV_S3_BUCKET: target.CV_TEST_S3_BUCKET!, CV_S3_REGION: target.CV_TEST_S3_REGION!, CV_S3_ENDPOINT: target.CV_TEST_S3_ENDPOINT!, CV_S3_PREFIX: `${target.CV_TEST_S3_PREFIX}http-${randomUUID()}/` };
  const master = `migration-${randomUUID()}`;
  const configuration = loadConfiguration({ ...storage, ...settings, CV_STORAGE_BACKEND: 'git', CV_DATA_DIR: join(directory, 'private'), CONTEXTVAULT_API_KEY: master });
  const app = await createApp({ logger: false, contextVault: { configuration, maintenance: false } }); await app.listen({ port: 0, host: '127.0.0.1' });
  const client: any = { baseUrl: `http://127.0.0.1:${(app.server.address() as any).port}`, customerA: 'migration-a', customerB: 'migration-b' }; const keys = [];
  for (const customerId of [client.customerA, client.customerB]) { const response = await call(client, '/api-keys', 'POST', { customerId, name: 'migration scoped credential' }, master); expect(response.status).toBe(201); keys.push(response.body); }
  client.keyA = keys[0].plainKey; client.keyB = keys[1].plainKey;
  return { directory, storage, configuration, app, client, keys, master, async dispose() { app.server.closeAllConnections(); await app.close(); try { await cleanupHttpStorage(storage); } finally { await rm(directory, { recursive: true, force: true }); } } };
}
