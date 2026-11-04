import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '../../../src/db';
import { SqliteControlStore } from '../../../src/adapters/control/sqlite-control-store';
import { CatalogAccessPolicy } from '../../../src/adapters/access/catalog-access-policy';
import { S3SubmissionStore } from '../../../src/adapters/submissions/s3';
import { fixture, command, principal, now, scope } from '../../control/helpers';
import { stream } from '../../submissions/helpers';
import { setup, bytes, hash } from './helpers';
import type { RunScope, UploadReceipt } from '../../../src/domain';
const clean: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of clean.splice(0)) await close(); });
async function context() {
  const s3 = await setup(); clean.push(s3.close);
  const root = await mkdtemp(join(tmpdir(), 'cv-s3-catalog-')); const databases: ReturnType<typeof createTestDb>[] = [];
  clean.push(async () => { for (const db of databases) if (db.open) db.close(); await rm(root, { recursive: true, force: true }); });
  const connect = () => { const db = createTestDb(join(root, 'catalog.sqlite')); databases.push(db); return new SqliteControlStore(db); };
  const control = connect(); const catalog = await fixture(control.database); const run = await catalog.open();
  const runScope: RunScope = { ...run.scope, runId: run.id };
  const adapter = (controlStore = control) => new S3SubmissionStore({ ...s3.options, storeId: 's3-submissions', control: controlStore, now: () => now });
  const store = adapter(); const submissionId = 'submission-s3' as UploadReceipt['submissionId'];
  await store.begin({ scope: runScope, principal, command: command('submission:create', {}, run.id), submissionId, expiresAt: '2026-11-03T13:00:00.000Z' });
  const upload = (key = 'upload', data = Buffer.from([0, 255, 13, 10])) => ({ scope: runScope, principal, submissionId, path: 'snapshot.bin', bytes: stream(data), declaredByteLength: data.length, declaredSha256: hash(data), receiptId: `receipt-${key}` as UploadReceipt['id'], command: command('submission:file', { path: 'snapshot.bin', sha256: hash(data), byteLength: data.length }, run.id, scope.workspaceId, key) });
  const selection = (receipt: UploadReceipt) => ({ manifest: { schemaVersion: 1 as const, entries: [{ path: receipt.path, kind: 'file' as const, byteLength: receipt.byteLength, sha256: receipt.sha256 }] }, receipts: [{ path: receipt.path, receiptId: receipt.id }] });
  const seal = (receipt: UploadReceipt, target = store) => { const selected = selection(receipt); return target.seal({ scope: runScope, principal, submissionId, ...selected, sealedAt: now, command: command('submission:seal', selected, run.id) }); };
  return { ...s3, control, catalog, run, runScope, store, submissionId, adapter, connect, upload, seal };
}

it('reopens durable receipts and sealed bytes through real SQLite without publishing the workspace', async () => {
  const c = await context(); const head = await c.control.getWorkspace(scope);
  const input = c.upload(); const receipt = await c.store.writeFile(input);
  expect(await c.control.getReceipt(c.runScope, c.submissionId, receipt.id)).toEqual(receipt);
  await expect(c.store.openSealedFile(c.runScope, c.submissionId, receipt.path)).rejects.toMatchObject({ code: 'SUBMISSION_SEALED' });
  const sealed = await c.seal(receipt); c.control.database.close(); const control = c.connect();
  expect(await c.adapter(control).get(c.runScope, c.submissionId)).toEqual(sealed);
  expect(await bytes(await c.adapter(control).openSealedFile(c.runScope, c.submissionId, receipt.path))).toEqual(Buffer.from([0, 255, 13, 10]));
  expect(await control.getWorkspace(scope)).toEqual(head);
});

it('retains the first receipt through lost registration responses and retries after reopening', async () => {
  const c = await context(); const input = c.upload(); const register = c.control.registerUploadReceipt.bind(c.control);
  let winning: UploadReceipt | undefined;
  vi.spyOn(c.control, 'registerUploadReceipt').mockImplementationOnce(async registration => { winning = (await register(registration)).value; throw new Error('response lost'); });
  await expect(c.store.writeFile(input)).rejects.toThrow('response lost'); c.control.database.close();
  const control = c.connect(); const retried = await c.adapter(control).writeFile({ ...input, receiptId: 'retry-attempt' as never, bytes: stream(Buffer.from([0, 255, 13, 10])) });
  expect(retried).toEqual(winning); expect((await control.getSubmission(c.runScope, c.submissionId))?.version).toBe(2);
});

it('binds failed attempts before streaming, rejects changed retry metadata, and never registers bad bytes', async () => {
  const c = await context(); const input = c.upload();
  await expect(c.store.writeFile({ ...input, bytes: stream('bad!') })).rejects.toMatchObject({ code: 'RECEIPT_MISMATCH' });
  expect(await c.control.getReceipt(c.runScope, c.submissionId, input.receiptId)).toBeNull();
  await expect(c.adapter().writeFile({ ...input, declaredSha256: hash('else'), bytes: stream('else') })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  expect(await c.store.writeFile({ ...input, bytes: stream(Buffer.from([0, 255, 13, 10])) })).toMatchObject({ id: input.receiptId });
});

it('rejects late registration after concurrent sealing without replacing selected bytes', async () => {
  const c = await context(); const receipt = await c.store.writeFile(c.upload('selected'));
  let release!: () => void; let started!: () => void; const ready = new Promise<void>(r => started = r); const gate = new Promise<void>(r => release = r);
  const input = c.upload('late', Buffer.from('late'));
  async function* held() { yield Buffer.from('l'); started(); await gate; yield Buffer.from('ate'); }
  const pending = c.store.writeFile({ ...input, bytes: held() }); void pending.catch(() => {}); await ready;
  try { await c.seal(receipt, c.adapter(c.connect())); } finally { release(); }
  await expect(pending).rejects.toMatchObject({ code: 'SUBMISSION_SEALED' });
  expect(await c.control.getReceipt(c.runScope, c.submissionId, input.receiptId)).toBeNull();
  expect(await bytes(await c.store.openSealedFile(c.runScope, c.submissionId, receipt.path))).toEqual(Buffer.from([0, 255, 13, 10]));
});

it('retries durable unregistered bytes after catalog failure and preserves the original receipt identity', async () => {
  const c = await context(); const input = c.upload();
  vi.spyOn(c.control, 'registerUploadReceipt').mockRejectedValueOnce(new Error('before registration'));
  await expect(c.store.writeFile(input)).rejects.toThrow('before registration');
  expect(await c.control.getReceipt(c.runScope, c.submissionId, input.receiptId)).toBeNull();
  c.control.database.close(); const control = c.connect();
  const receipt = await c.adapter(control).writeFile({ ...input, receiptId: 'new-retry-attempt' as never, bytes: stream('unused') });
  expect(receipt.id).toBe(input.receiptId);
  expect(await control.getReceipt(c.runScope, c.submissionId, receipt.id)).toEqual(receipt);
});

it('independently rejects corrupted stored receipt bytes before sealing and on later reads', async () => {
  const c = await context(); const receipt = await c.store.writeFile(c.upload());
  const key = (await c.keys()).find(k => k.endsWith('/bytes'))!;
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  await c.client.send(new PutObjectCommand({ Bucket: c.bucket, Key: key, Body: Buffer.from('evil'), Metadata: { 'cv-sha256': receipt.sha256 }, ServerSideEncryption: 'AES256' }));
  await expect(c.seal(receipt)).rejects.toMatchObject({ code: 'RECEIPT_MISMATCH' });
  expect((await c.store.get(c.runScope, c.submissionId))?.state).toBe('uploading');
  await expect(c.store.writeFile(c.upload())).rejects.toMatchObject({ code: 'RECEIPT_MISMATCH' });
  await c.client.send(new PutObjectCommand({ Bucket: c.bucket, Key: key, Body: Buffer.from([0, 255, 13, 10]), Metadata: { 'cv-sha256': receipt.sha256 }, ServerSideEncryption: 'AES256' }));
  await c.seal(receipt);
  await c.client.send(new PutObjectCommand({ Bucket: c.bucket, Key: key, Body: Buffer.from('evil'), Metadata: { 'cv-sha256': receipt.sha256 }, ServerSideEncryption: 'AES256' }));
  await expect(bytes(await c.store.openSealedFile(c.runScope, c.submissionId, receipt.path))).rejects.toMatchObject({ code: 'RECEIPT_MISMATCH' });
});

it('rechecks real catalog authority after bytes finish and rejects revoked receipt registration', async () => {
  const c = await context(); let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(r => release = r); const ready = new Promise<void>(r => started = r);
  const input = c.upload();
  async function* held() { yield Buffer.from([0]); started(); await gate; yield Buffer.from([255, 13, 10]); }
  const pending = c.store.writeFile({ ...input, bytes: held() }); void pending.catch(() => {}); await ready;
  const control = c.connect(); const customer = { customerId: c.runScope.customerId };
  try {
    const authority = await control.getAuthority(customer, principal);
    await control.updateAuthority({ scope: customer, principal, authorization: await c.catalog.auth('credential:manage', customer), authority: { ...authority!, credentialVersion: 2, permissionEpoch: 2, revokedAt: now }, expectedCredentialVersion: 1, expectedPermissionEpoch: 1 });
  } finally { release(); }
  await expect(pending).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' });
  expect(await control.getReceipt(c.runScope, c.submissionId, input.receiptId)).toBeNull();
  expect((await control.getRun(scope, c.run.id))?.state).toBe('active');
});

it('registers one original receipt through concurrent identical upload retries', async () => {
  const c = await context(); const input = c.upload();
  const [first, second] = await Promise.all([c.store.writeFile(input), c.adapter(c.connect()).writeFile({ ...input, receiptId: 'parallel-attempt' as never, bytes: stream(Buffer.from([0, 255, 13, 10])) })]);
  expect(second).toEqual(first);
  expect((await c.store.get(c.runScope, c.submissionId))?.version).toBe(2);
});

it('records completion time after durable bytes finish, preserving it across clock-changing retries', async () => {
  const c = await context(); const clock = { now }; let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(r => release = r); const ready = new Promise<void>(r => started = r);
  const store = new S3SubmissionStore({ ...c.options, storeId: 's3-submissions', control: c.control, now: () => clock.now });
  const input = c.upload();
  async function* held() { yield Buffer.from([0]); started(); await gate; yield Buffer.from([255, 13, 10]); }
  const pending = store.writeFile({ ...input, bytes: held() }); void pending.catch(() => {}); await ready;
  clock.now = '2026-11-03T12:01:00.000Z'; release();
  const receipt = await pending; expect(receipt.completedAt).toBe(clock.now);
  clock.now = '2026-11-03T12:02:00.000Z';
  expect(await store.writeFile({ ...input, bytes: stream('ignored retry') })).toEqual(receipt);
});

async function successfulReplay(kind: 'upload' | 'seal') {
  const c = await context(); const input = c.upload(); const receipt = await c.store.writeFile(input);
  const selection = { manifest: { schemaVersion: 1 as const, entries: [{ path: receipt.path, kind: 'file' as const, byteLength: receipt.byteLength, sha256: receipt.sha256 }] }, receipts: [{ path: receipt.path, receiptId: receipt.id }] };
  const sealInput = { scope: c.runScope, principal, submissionId: c.submissionId, ...selection, sealedAt: now, command: command('submission:seal', selection, c.run.id) };
  const original = kind === 'upload' ? receipt : await c.store.seal(sealInput);
  const submission = await c.store.get(c.runScope, c.submissionId); const workspace = await c.control.getWorkspace(scope);
  let consumed = 0;
  async function* replacement() { consumed++; throw new Error('Replay consumed replacement bytes'); yield Buffer.from('replacement'); }
  const retry = (actor = principal) => {
    const reopened = c.adapter(c.connect());
    return kind === 'upload' ? reopened.writeFile({ ...input, principal: actor, receiptId: 'replacement-attempt' as never, bytes: replacement() }) : reopened.seal({ ...sealInput, principal: actor });
  };
  const unchanged = async () => {
    expect(consumed).toBe(0); expect(await c.store.get(c.runScope, c.submissionId)).toEqual(submission);
    expect(await c.control.getReceipt(c.runScope, c.submissionId, receipt.id)).toEqual(receipt);
    expect(await c.control.getWorkspace(scope)).toEqual(workspace);
  };
  expect(await retry()).toEqual(original); await unchanged();
  return { ...c, retry, unchanged };
}

it.each(['upload', 'seal'] as const)('denies successful %s replay after current credential revocation', async kind => {
  const c = await successfulReplay(kind); const control = c.connect(); const customer = { customerId: c.runScope.customerId };
  const authority = await control.getAuthority(customer, principal);
  await control.updateAuthority({ scope: customer, principal, authorization: await c.catalog.auth('credential:manage', customer),
    authority: { ...authority!, credentialVersion: 2, permissionEpoch: 2, revokedAt: now }, expectedCredentialVersion: 1, expectedPermissionEpoch: 1 });
  await expect(c.retry()).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' });
  await c.unchanged();
});

it.each(['upload', 'seal'] as const)('denies successful %s replay after removing the current run:upload grant', async kind => {
  const c = await successfulReplay(kind); const control = c.connect(); const customer = { customerId: c.runScope.customerId };
  const authority = await control.getAuthority(customer, principal);
  const updated = await control.updateAuthority({ scope: customer, principal, authorization: await c.catalog.auth('credential:manage', customer),
    authority: { ...authority!, credentialVersion: 2, permissionEpoch: 2, grants: authority!.grants.filter(grant => grant.action !== 'run:upload') }, expectedCredentialVersion: 1, expectedPermissionEpoch: 1 });
  const current = { ...principal, credential: { ...principal.credential, version: updated.credentialVersion }, permissionEpoch: updated.permissionEpoch };
  expect(await new CatalogAccessPolicy(control).evaluate(current, 'run:upload', scope)).toMatchObject({ allowed: false, code: 'FORBIDDEN', message: 'Current authority does not grant this action and scope' });
  // Catalog replay rejects the refreshed credential identity before its grant check; current policy independently denies upload.
  await expect(c.retry(current)).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Idempotent command belongs to another credential' });
  await c.unchanged();
});
