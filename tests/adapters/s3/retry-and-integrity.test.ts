import { afterEach, expect, it } from 'vitest';
import { GetObjectCommand, PutObjectCommand, ListMultipartUploadsCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { setup, identity, source, bytes, hash } from './helpers';
import type { CollectionPermit } from '../../../src/domain';
const clean: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of clean.splice(0)) await close(); });
async function context(overrides: Parameters<typeof setup>[0] = {}) { const c = await setup(overrides); clean.push(c.close); return c; }

it('binds identity and manifest before opening source bytes and rejects changed retry after interruption', async () => {
  const c = await context();
  const initial = source({ file: Buffer.from('original') });
  initial.openFile = async () => { throw new Error('interrupted source'); };
  await expect(c.store.prepare({ identity: identity(), source: initial })).rejects.toThrow('interrupted source');
  expect(await c.reopen().inspectCandidate(identity())).toBeNull();
  await expect(c.reopen().prepare({ identity: identity(), source: source({ file: Buffer.from('changed') }) })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  const p = await c.reopen().prepare({ identity: identity(), source: source({ file: Buffer.from('original') }) });
  expect(await bytes(await c.store.openFile(p, 'file'))).toEqual(Buffer.from('original'));
});

it('never completes a small immutable object before independently checking incoming bytes', async () => {
  const c = await context(); const invalid = source({ file: Buffer.from('right') });
  invalid.openFile = async () => (async function* () { yield Buffer.from('wrong'); })();
  await expect(c.store.prepare({ identity: identity(), source: invalid })).rejects.toMatchObject({ code: 'RECEIPT_MISMATCH' });
  expect((await c.keys()).filter(k => k.includes('/files/'))).toHaveLength(0);
  expect(await c.store.inspectCandidate(identity())).toBeNull();
});

it('rejects mismatched existing retry objects without replacing the winning object', async () => {
  const c = await context(); const snapshot = source({ file: Buffer.from('right') });
  const p = await c.store.prepare({ identity: identity(), source: snapshot });
  const key = (await c.keys()).find(k => k.includes('/files/'))!;
  await c.client.send(new PutObjectCommand({ Bucket: c.bucket, Key: key, Body: Buffer.from('wrong'), ServerSideEncryption: 'AES256' }));
  await expect(c.reopen().prepare({ identity: identity(), source: snapshot })).rejects.toMatchObject({ code: 'RECEIPT_MISMATCH' });
  await expect(bytes(await c.store.openFile(p, 'file'))).rejects.toMatchObject({ code: 'RECEIPT_MISMATCH' });
  expect(await (await c.client.send(new GetObjectCommand({ Bucket: c.bucket, Key: key }))).Body!.transformToString()).toBe('wrong');
});

it('keeps interrupted manifests invisible, permits exact recovery, and prevents revision identity reuse', async () => {
  const c = await context(); let fail = true;
  c.client.middlewareStack.add((next, context) => async args => {
    if (fail && context.commandName === 'PutObjectCommand' && String((args.input as any).Key).endsWith('/prepared.json')) throw new Error('manifest interruption');
    return next(args);
  }, { step: 'initialize', name: 'interruptManifest' });
  const snapshot = source({ file: Buffer.from('immutable') });
  await expect(c.store.prepare({ identity: identity(), source: snapshot })).rejects.toThrow('manifest interruption');
  expect(await c.reopen().inspectCandidate(identity())).toBeNull();
  fail = false;
  const p = await c.reopen().prepare({ identity: identity(), source: snapshot });
  expect(await c.store.inspectCandidate(identity())).toEqual(p);
  await expect(c.store.prepare({ identity: { ...identity('other'), revisionId: identity().revisionId }, source: snapshot })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});

it('uploads multipart bytes, keeps ETags separate, and aborts invalid or cancelled multipart uploads', async () => {
  const c = await context(); const content = Buffer.alloc(5 * 1024 * 1024 + 7, 61);
  const p = await c.store.prepare({ identity: identity(), source: source({ large: content }) });
  expect(await bytes(await c.reopen().openFile(p, 'large'))).toEqual(content);
  const key = (await c.keys()).find(k => k.includes('/files/'))!;
  const head = await c.client.send(new HeadObjectCommand({ Bucket: c.bucket, Key: key, ChecksumMode: 'ENABLED' }));
  expect(head.ServerSideEncryption).toBe('AES256'); expect(head.ETag?.replaceAll('"', '')).not.toBe(hash(content));
  const invalid = source({ large: content });
  invalid.openFile = async () => (async function* () { yield content.subarray(0, -1); yield Buffer.from('!'); })();
  await expect(c.store.prepare({ identity: identity('invalid'), source: invalid })).rejects.toMatchObject({ code: 'RECEIPT_MISMATCH' });
  const abort = new AbortController(); const cancelled = source({ large: content });
  cancelled.openFile = async () => (async function* () { yield content.subarray(0, 5 * 1024 * 1024 + 1); abort.abort(); yield content.subarray(5 * 1024 * 1024 + 1); })();
  await expect(c.store.prepare({ identity: identity('cancel'), source: cancelled, signal: abort.signal })).rejects.toBeDefined();
  expect(await c.store.inspectCandidate(identity('invalid'))).toBeNull(); expect(await c.store.inspectCandidate(identity('cancel'))).toBeNull();
  expect((await c.client.send(new ListMultipartUploadsCommand({ Bucket: c.bucket, Prefix: c.prefix }))).Uploads ?? []).toHaveLength(0);
});

it('requires current exact collection authority, retains a tombstone, and prevents resurrection', async () => {
  let allowed = false; const c = await context({ verifyCollectionPermit: async () => allowed });
  const p = await c.store.prepare({ identity: identity(), source: source({ file: Buffer.from('content') }) });
  const permit: CollectionPermit = { scope: p.scope, candidateId: p.candidateId, privateReference: p.privateReference, collectionFence: 1, expiresAt: '2026-11-03T13:00:00.000Z' };
  const now = '2026-11-03T12:00:00.000Z';
  await expect(c.store.deleteCollectible(permit, now)).rejects.toMatchObject({ code: 'STALE_FENCE' });
  allowed = true;
  await expect(c.store.deleteCollectible({ ...permit, candidateId: 'other' as never }, now)).rejects.toMatchObject({ code: 'STALE_FENCE' });
  await expect(c.store.deleteCollectible(permit, permit.expiresAt)).rejects.toMatchObject({ code: 'STALE_FENCE' });
  await c.store.deleteCollectible(permit, now);
  expect(await c.reopen().inspectCandidate(identity())).toBeNull();
  await expect(c.store.readManifest(p)).rejects.toMatchObject({ code: 'REVISION_NOT_FOUND' });
  await expect(c.store.prepare({ identity: identity(), source: source({ file: Buffer.from('content') }) })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});

it('shares bounded immutable metadata across concurrent file reads and checks fresh tombstones', async () => {
  const c = await context({ verifyCollectionPermit: async () => true });
  const content = Buffer.from('small'); const files = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`files/${i}`, content]));
  const p = await c.store.prepare({ identity: identity(), source: source(files) });
  let intentReads = 0;
  c.client.middlewareStack.add((next, context) => async args => {
    if (context.commandName === 'GetObjectCommand' && String((args.input as any).Key).endsWith('/intent.json')) intentReads++;
    return next(args);
  }, { step: 'initialize', name: 'countIntentReads' });
  const reader = c.reopen();
  await Promise.all(Object.keys(files).map(async path => expect(await bytes(await reader.openFile(p, path))).toEqual(content)));
  expect(intentReads).toBe(1);
  await c.store.deleteCollectible({ scope: p.scope, candidateId: p.candidateId, privateReference: p.privateReference, collectionFence: 1, expiresAt: '2026-11-03T13:00:00.000Z' }, '2026-11-03T12:00:00.000Z');
  await expect(reader.openFile(p, 'files/0')).rejects.toMatchObject({ code: 'REVISION_NOT_FOUND' });
});

it('collects interrupted preparation only with an exact catalog-fenced permit', async () => {
  const c = await context({ verifyCollectionPermit: async () => true }); const snapshot = source({ file: Buffer.from('bytes') });
  snapshot.openFile = async () => { throw new Error('before bytes'); };
  await expect(c.store.prepare({ identity: identity(), source: snapshot })).rejects.toThrow('before bytes');
  const root = (await c.keys()).find(k => k.endsWith('/intent.json'))!.slice(c.prefix.length, -'/intent.json'.length);
  await c.store.deleteCollectible({ scope: identity().scope, candidateId: identity().candidateId, privateReference: { storeId: c.options.storeId, opaqueKey: root }, collectionFence: 1, expiresAt: '2026-11-03T13:00:00.000Z' }, '2026-11-03T12:00:00.000Z');
  expect(await c.store.inspectCandidate(identity())).toBeNull();
  expect((await c.keys()).filter(k => k.startsWith(c.prefix + root))).toEqual([c.prefix + root + '/collected.json']);
});

it('requires explicit encryption and rejects plaintext transport without the emulator opt-in', async () => {
  const c = await context();
  const { S3RevisionStore } = await import('../../../src/adapters/revisions/s3');
  expect(() => new S3RevisionStore({ ...c.options, encryption: undefined as never })).toThrow();
  if (process.env.CV_TEST_S3_PROVIDER === 'localstack') {
    const secure = new S3RevisionStore({ ...c.options, allowInsecureEndpoint: false });
    await expect(secure.prepare({ identity: identity(), source: source({}) })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  }
});

it('cancels while waiting for the next source chunk and leaves no prepared marker', async () => {
  const c = await context(); const abort = new AbortController(); let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(r => release = r); const ready = new Promise<void>(r => started = r);
  const snapshot = source({ file: Buffer.from('ab') });
  snapshot.openFile = async () => (async function* () { yield Buffer.from('a'); started(); await gate; yield Buffer.from('b'); })();
  const pending = c.store.prepare({ identity: identity(), source: snapshot, signal: abort.signal }); void pending.catch(() => {});
  await ready; abort.abort(); let timer: ReturnType<typeof setTimeout>;
  try {
    await expect(Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('did not cancel waiting stream')), 500); })])).rejects.toMatchObject({ name: 'AbortError' });
  } finally { clearTimeout(timer!); release(); await pending.catch(() => {}); }
  expect(await c.store.inspectCandidate(identity())).toBeNull();
});

it('retains one immutable revision winner through concurrent identical retries', async () => {
  const c = await context(); const snapshot = source({ file: Buffer.from('concurrent') });
  const [first, second] = await Promise.all([c.store.prepare({ identity: identity(), source: snapshot }), c.reopen().prepare({ identity: identity(), source: snapshot })]);
  expect(second).toEqual(first); expect(await c.reopen().inspectCandidate(identity())).toEqual(first);
});

it('aborts a failed multipart upload and recovers exact bytes using its durable intent', async () => {
  const c = await context(); let fail = true;
  c.client.middlewareStack.add((next, context) => async args => {
    if (fail && context.commandName === 'UploadPartCommand') { fail = false; throw new Error('part failed'); }
    return next(args);
  }, { step: 'initialize', name: 'failOnePart' });
  const content = Buffer.alloc(5 * 1024 * 1024 + 1, 19); const snapshot = source({ large: content });
  await expect(c.store.prepare({ identity: identity(), source: snapshot })).rejects.toThrow('part failed');
  expect(await c.store.inspectCandidate(identity())).toBeNull();
  expect((await c.client.send(new ListMultipartUploadsCommand({ Bucket: c.bucket, Prefix: c.prefix }))).Uploads ?? []).toHaveLength(0);
  const prepared = await c.reopen().prepare({ identity: identity(), source: snapshot });
  expect(await bytes(await c.store.openFile(prepared, 'large'))).toEqual(content);
});

it('bounds concurrent metadata downloads for distinct immutable revision keys', async () => {
  const c = await context();
  const prepared = await Promise.all(Array.from({ length: 12 }, (_, i) => c.store.prepare({ identity: identity(`metadata-${i}`), source: source({}) })));
  let active = 0; let maximum = 0; let reads = 0;
  c.client.middlewareStack.add((next, context) => async args => {
    if (context.commandName !== 'GetObjectCommand' || !String((args.input as any).Key).endsWith('/intent.json')) return next(args);
    active++; reads++; maximum = Math.max(maximum, active);
    try { await new Promise(resolve => setImmediate(resolve)); return await next(args); } finally { active--; }
  }, { step: 'initialize', name: 'countDistinctMetadata' });
  const reader = c.reopen();
  expect(await Promise.all(prepared.map(p => reader.readManifest(p)))).toEqual(prepared.map(() => source({}).manifest));
  expect(reads).toBe(12);
  expect(maximum).toBeLessThanOrEqual(4);
});
