import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app';
import { loadConfiguration } from '../../src/config';
import type { RuntimeOptions } from '../../src/config/runtime';
import { storageEnvironment, cleanupHttpStorage } from '../http/helpers';
import { call } from './helpers';
// Fault tests still bind the normal createApp composition, real SQLite, real Git/S3 and real HTTP.
export async function faultFixture(options: RuntimeOptions = {}, requestTimeoutMs = 30_000) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'cv-compat-fault-'));
  const storage = storageEnvironment(); const master = `fixture-${randomUUID()}`;
  const configuration = loadConfiguration({ ...storage, CV_DATA_DIR: join(directory, 'private'), CONTEXTVAULT_API_KEY: master, CV_REQUEST_TIMEOUT_MS: String(requestTimeoutMs) });
  const app = await createApp({ logger: false, contextVault: { configuration, maintenance: false, ...options } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const client: any = { baseUrl: `http://127.0.0.1:${(app.server.address() as any).port}`, customerA: 'fault-a', customerB: 'fault-b' };
  const keys = [];
  for (const customerId of [client.customerA, client.customerB]) { const value = await call(client, '/api-keys', 'POST', { customerId, name: 'fault-key' }, master); if (value.status !== 201) throw new Error('Fault fixture credential setup failed'); keys.push(value.body); }
  client.keyA = keys[0].plainKey; client.keyB = keys[1].plainKey;
  return { app, directory, configuration, client, master, keys, async dispose() { app.server.closeAllConnections(); await app.close(); await cleanupHttpStorage(storage); await rm(directory, { recursive: true, force: true }); } };
}
