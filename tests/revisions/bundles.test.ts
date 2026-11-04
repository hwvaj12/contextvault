import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { verifyWorkspaceBundleSignature } from '../../sdk/typescript/src/bundles';
import { call, configuredFixture, publish, workspace } from './helpers';

it('rejects a non-stream upload before taking a payload lock and permits a later valid retry', async () => {
  const keys = generateKeyPairSync('ed25519'); const server = await configuredFixture({ CONTEXTVAULT_SIGNING_PRIVATE_KEY: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), CONTEXTVAULT_SIGNING_PUBLIC_KEY: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), CONTEXTVAULT_SIGNING_KEY_ID: 'stream-validation-key' });
  const control = server.app.contextVault.control; const original = control.acquireCompatibilityLock.bind(control); const locks: { release(): Promise<void> }[] = [];
  const spy = vi.spyOn(control, 'acquireCompatibilityLock').mockImplementation(async (...args) => { const lock = await original(...args); locks.push(lock); return lock; });
  try {
    const c = server.client; const w = await workspace(c); const exported = await call(c, `/workspaces/${w.id}/export`, 'POST', {}, c.keyA, 'stream-export'); expect(exported.status).toBe(201);
    const downloaded = await fetch(`${c.baseUrl}/v1/bundles/${exported.body.bundlePath}`, { headers: { 'X-API-Key': c.keyA } }); const bytes = Buffer.from(await downloaded.arrayBuffer());
    const upload = await call(c, '/v1/bundles', 'POST', {}, c.keyA, 'stream-owner'); expect(upload.status).toBe(201); const before = spy.mock.calls.length;
    const invalid = await call(c, `/v1/bundles/${upload.body.bundlePath}`, 'PUT', {}, c.keyA, 'invalid-json-upload'); expect(invalid.status).toBe(400); expect(spy.mock.calls).toHaveLength(before);
    const retry = await fetch(`${c.baseUrl}/v1/bundles/${upload.body.bundlePath}`, { method: 'PUT', headers: { 'X-API-Key': c.keyA, 'Idempotency-Key': 'valid-stream-upload', 'Content-Type': 'application/vnd.contextvault.bundle' }, body: bytes }); expect(retry.status).toBe(200); expect((await retry.json()).state).toBe('ready');
  } finally { spy.mockRestore(); for (const lock of locks) await lock.release(); await server.dispose(); }
}, 60000);

it('roundtrips signed binary bundles and empty directories using opaque legacy handles and authenticated streaming', async () => {
  const keys = generateKeyPairSync('ed25519'); const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const server = await configuredFixture({ CONTEXTVAULT_SIGNING_PRIVATE_KEY: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), CONTEXTVAULT_SIGNING_PUBLIC_KEY: publicKey, CONTEXTVAULT_SIGNING_KEY_ID: 'bundle-test-key' });
  try {
    const c = server.client; const w = await workspace(c); const source = await publish(c, w.id, { 'binary.bin': Buffer.from([0, 255, 128]), 'readme.txt': Buffer.from('portable') }, ['empty']);
    const exported = await call(c, `/workspaces/${w.id}/export`, 'POST', {}, c.keyA, 'export-key'); expect(exported.status, JSON.stringify(exported.body)).toBe(201); const handle = exported.body.bundlePath;
    expect(handle).toMatch(/^bundle-[a-f0-9-]{36}$/); expect(exported.body.manifest.signatureAlgorithm).toBe('Ed25519'); expect(exported.body.manifest.files).toEqual([{ path: 'binary.bin', size: 3, hash: expect.stringMatching(/^sha256:/) }, { path: 'readme.txt', size: 8, hash: expect.stringMatching(/^sha256:/) }]);
    expect((await verifyWorkspaceBundleSignature(exported.body.manifest, [{ keyId: 'bundle-test-key', publicKey }])).valid).toBe(true);
    const download = await fetch(`${c.baseUrl}/v1/bundles/${handle}`, { headers: { 'X-API-Key': c.keyA } }); expect(download.status).toBe(200); const bytes = Buffer.from(await download.arrayBuffer()); expect(bytes.subarray(0, 8).toString()).toBe('CVBNDL1\n');
    expect((await fetch(`${c.baseUrl}/v1/bundles/${handle}`, { headers: { 'X-API-Key': c.keyB } })).status).toBe(404);
    await publish(c, w.id, { 'later.txt': Buffer.from('later') });
    const imported = await call(c, '/workspaces/import', 'POST', { bundlePath: handle, customerId: c.customerA, name: 'imported', targetWorkspaceId: `import-${randomUUID()}` }, c.keyA, 'import-key'); expect(imported.status).toBe(201); expect(imported.body.verified).toBe(true);
    const target = imported.body.workspaceId; const metadata = (await call(c, `/v1/workspaces/${target}`)).body; const actual = (await call(c, `/v1/workspaces/${target}/revisions/${metadata.currentRevisionId}/manifest`)).body;
    expect(actual).toEqual((await call(c, `/v1/workspaces/${w.id}/revisions/${source}/manifest`)).body);
    const binary = await fetch(`${c.baseUrl}/v1/workspaces/${target}/revisions/${metadata.currentRevisionId}/files?path=binary.bin`, { headers: { 'X-API-Key': c.keyA } }); expect(Buffer.from(await binary.arrayBuffer())).toEqual(Buffer.from([0, 255, 128]));
    const replay = await call(c, '/workspaces/import', 'POST', { bundlePath: handle, customerId: c.customerA, name: 'imported', targetWorkspaceId: target }, c.keyA, 'import-key'); expect(replay.status).toBe(201); expect(replay.body.workspaceId).toBe(target);
    expect((await call(c, '/workspaces/import', 'POST', { bundlePath: '/tmp/private', customerId: c.customerA, name: 'unsafe' }, c.keyA, randomUUID())).status).toBe(400);
    expect((await call(c, '/workspaces/import', 'POST', { bundlePath: handle, customerId: c.customerA, name: 'unchecked', skipHashVerification: true }, c.keyA, randomUUID())).status).toBe(400);
    const upload = await call(c, '/v1/bundles', 'POST', {}, c.keyA, randomUUID()); expect(upload.status).toBe(201);
    const response = await fetch(`${c.baseUrl}/v1/bundles/${upload.body.bundlePath}`, { method: 'PUT', headers: { 'X-API-Key': c.keyA, 'Idempotency-Key': 'upload-key', 'Content-Type': 'application/vnd.contextvault.bundle' }, body: bytes }); expect(response.status).toBe(200);
    const again = await call(c, '/workspaces/import', 'POST', { bundlePath: upload.body.bundlePath, customerId: c.customerA, name: 'uploaded' }, c.keyA, randomUUID()); expect(again.status).toBe(201);
  } finally { await server.dispose(); }
}, 60000);

it('transfers a legal signed manifest larger than HTTP header limits in the bounded body frame', async () => {
  const keys = generateKeyPairSync('ed25519'); const server = await configuredFixture({ CONTEXTVAULT_SIGNING_PRIVATE_KEY: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), CONTEXTVAULT_SIGNING_PUBLIC_KEY: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), CONTEXTVAULT_SIGNING_KEY_ID: 'large-frame-key' });
  try {
    const c = server.client; const w = await workspace(c); const files = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`${'p'.repeat(220)}/${index}.txt`, Buffer.alloc(0)])); await publish(c, w.id, files, ['empty']);
    const exported = await call(c, `/workspaces/${w.id}/export`, 'POST', {}, c.keyA, 'large-export'); expect(exported.status).toBe(201);
    const response = await fetch(`${c.baseUrl}/v1/bundles/${exported.body.bundlePath}`, { headers: { 'X-API-Key': c.keyA } }); expect(response.status).toBe(200); const bytes = Buffer.from(await response.arrayBuffer()); expect(bytes.readUInt32BE(8)).toBeGreaterThan(16 * 1024);
    const upload = await call(c, '/v1/bundles', 'POST', {}, c.keyA, 'large-upload'); expect(upload.status).toBe(201);
    const uploaded = await fetch(`${c.baseUrl}/v1/bundles/${upload.body.bundlePath}`, { method: 'PUT', headers: { 'X-API-Key': c.keyA, 'Idempotency-Key': 'large-body', 'Content-Type': 'application/vnd.contextvault.bundle' }, body: bytes }); expect(uploaded.status).toBe(200);
    expect((await uploaded.json()).fileCount).toBe(50);
  } finally { await server.dispose(); }
}, 60000);

it('uses the configured app-owned secret provider and rejects tampered uploads before publication', async () => {
  const keys = generateKeyPairSync('ed25519'); const server = await configuredFixture({ CONTEXTVAULT_SIGNING_PRIVATE_KEY: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), CONTEXTVAULT_SIGNING_PUBLIC_KEY: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), CONTEXTVAULT_SIGNING_KEY_ID: 'configured-key' });
  try {
    const c = server.client; const w = await workspace(c); await publish(c, w.id, { 'private.txt': Buffer.from('safe') });
    const exported = await call(c, `/workspaces/${w.id}/export`, 'POST', {}, c.keyA, randomUUID()); expect(exported.status).toBe(201);
    const download = await fetch(`${c.baseUrl}/v1/bundles/${exported.body.bundlePath}`, { headers: { 'X-API-Key': c.keyA } }); const bytes = Buffer.from(await download.arrayBuffer()); bytes[bytes.length - 1] ^= 1;
    const uploaded = await call(c, '/v1/bundles', 'POST', {}, c.keyA, randomUUID()); const id = uploaded.body.bundlePath;
    const corrupt = await fetch(`${c.baseUrl}/v1/bundles/${id}`, { method: 'PUT', headers: { 'X-API-Key': c.keyA, 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/vnd.contextvault.bundle' }, body: bytes }); expect(corrupt.status).toBe(422);
    expect((await call(c, '/workspaces/import', 'POST', { bundlePath: id, name: 'invalid' }, c.keyA, randomUUID())).status).toBe(409);
    const tmk = await server.app.contextVault.secrets.ensureTmk(c.customerA); await publish(c, w.id, { 'private.txt': Buffer.from(tmk.tmk) });
    expect((await call(c, `/workspaces/${w.id}/export`, 'POST', {}, c.keyA, randomUUID())).status).toBe(403);
    expect(server.app.contextVault.configuration.legacySecretsPath).toBe(server.configuration.legacySecretsPath);
  } finally { await server.dispose(); }
}, 60000);
