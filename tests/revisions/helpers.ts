import { createHash, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app';
import { loadConfiguration } from '../../src/config';
import { storageEnvironment, cleanupHttpStorage } from '../http/helpers';
import { faultFixture } from '../compat/fault-fixture';
import { call, workspace } from '../compat/helpers';
export { call, workspace, faultFixture };
export async function configuredFixture(settings: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'cv-admin-configured-')); const storage = storageEnvironment(); const master = `master-${randomUUID()}`;
  const configuration = loadConfiguration({ ...storage, ...settings, CONTEXTVAULT_API_KEY: master, CV_DATA_DIR: join(directory, 'non-default-private-root'), CONTEXTVAULT_SECRETS_PATH: join(directory, 'configured-secrets.json') });
  const app = await createApp({ logger: false, contextVault: { configuration, maintenance: false } }); await app.listen({ port: 0, host: '127.0.0.1' });
  const client: any = { baseUrl: `http://127.0.0.1:${(app.server.address() as any).port}`, customerA: 'configured-a', customerB: 'configured-b' }; const keys = [];
  for (const customerId of [client.customerA, client.customerB]) { const result = await call(client, '/api-keys', 'POST', { customerId, name: 'configured-key' }, master); expect(result.status).toBe(201); keys.push(result.body); }
  client.keyA = keys[0].plainKey; client.keyB = keys[1].plainKey;
  return { app, configuration, directory, client, keys, master, async dispose() { app.server.closeAllConnections(); await app.close(); await cleanupHttpStorage(storage); await rm(directory, { recursive: true, force: true }); } };
}
export async function operation(c: any, value: any) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (value.state === 'succeeded' || value.state === 'failed') return value;
    const read = await call(c, `/v1/operations/${value.id}`); expect(read.status).toBe(200); value = read.body;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Durable operation did not settle');
}
export async function publish(c: any, id: string, files: Record<string, Buffer>, directories: string[] = []) {
  const opened = await call(c, `/v1/workspaces/${id}/runs`, 'POST', { mode: 'read-write', agentLabel: 'revision-test', task: 'exact contents', reason: 'verify authoritative administration' }, c.keyA, randomUUID()); expect(opened.status).toBe(201);
  const run = opened.body; const submitted = await call(c, `/v1/runs/${run.id}/submissions`, 'POST', {}, c.keyA, randomUUID()); expect(submitted.status).toBe(201);
  const entries: any[] = directories.map(path => ({ path, kind: 'directory' })); const receipts = [];
  for (const [path, bytes] of Object.entries(files)) {
    const response = await fetch(`${c.baseUrl}/v1/runs/${run.id}/submissions/${submitted.body.id}/files?path=${encodeURIComponent(path)}`, { method: 'PUT', headers: { 'X-API-Key': c.keyA, 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': createHash('sha256').update(bytes).digest('hex') }, body: bytes });
    expect(response.status).toBe(201); receipts.push({ path, receiptId: (await response.json()).id }); entries.push({ path, kind: 'file', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const sealed = await call(c, `/v1/runs/${run.id}/submissions/${submitted.body.id}/seal`, 'POST', { manifest: { schemaVersion: 1, entries }, receipts }, c.keyA, randomUUID()); expect(sealed.status).toBe(200);
  const finalized = await call(c, `/v1/runs/${run.id}/finalize`, 'POST', { expectedRunVersion: run.version, submissionId: submitted.body.id }, c.keyA, randomUUID()); expect(finalized.status).toBe(202);
  const result = await operation(c, finalized.body); expect(result.state).toBe('succeeded'); return result.result.revisionId;
}
