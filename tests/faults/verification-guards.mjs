import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

export function assertTransferProgress(proof, backend) {
  const progress = proof.adapterProgress;
  assert.ok(progress && Number.isSafeInteger(progress.consumedByteLength) && progress.consumedByteLength > 0, 'Adapter consumption must precede the crash');
  assert.equal(proof.receivedByteLength, progress.consumedByteLength);
  assert.ok(progress.consumedByteLength < proof.declaredByteLength, 'The adapter transfer must remain incomplete');
  assert.ok(Array.isArray(progress.writerIds) && progress.writerIds.length === 1 && progress.writerIds.every(id => typeof id === 'string' && id), 'One actual adapter writer must remain active');
  if (backend === 'git') {
    assert.equal(progress.localTransfer?.byteLength, progress.consumedByteLength);
    assert.equal(progress.localTransfer?.matchesDeclaredPrefix, true);
  } else {
    assert.equal(backend, 's3');
    const transfer = progress.multipartTransfer;
    assert.ok(transfer && typeof transfer.key === 'string' && transfer.key && typeof transfer.uploadId === 'string' && transfer.uploadId, 'A real multipart upload must exist');
    assert.equal(transfer.completedObject, false, 'The incomplete upload must not expose its final object');
    assert.ok(Array.isArray(transfer.parts) && transfer.parts.length > 0, 'A real multipart part must finish before the crash');
    for (const part of transfer.parts) {
      assert.ok(Number.isSafeInteger(part.partNumber) && part.partNumber > 0);
      assert.ok(Number.isSafeInteger(part.byteLength) && part.byteLength >= 5 * 1024 * 1024);
      assert.ok(typeof part.etag === 'string' && part.etag);
    }
    const uploaded = transfer.parts.reduce((total, part) => total + part.byteLength, 0);
    assert.ok(uploaded <= progress.consumedByteLength && uploaded < proof.declaredByteLength);
  }
}

export function assertEligibleCleanup(cleanup) {
  assert.equal(cleanup.state, 'complete', 'Eligible cleanup must reach complete within its bounded drain');
  assert.equal(cleanup.uncertainWriterCount, 0);
  assert.deepEqual(cleanup.errors, []);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bytes = 6 * 1024 * 1024;
  const local = { receivedByteLength: bytes, declaredByteLength: 7 * 1024 * 1024, adapterProgress: { consumedByteLength: bytes, writerIds: ['owned-writer'], localTransfer: { byteLength: bytes, matchesDeclaredPrefix: true } } };
  const remote = { ...local, adapterProgress: { consumedByteLength: bytes, writerIds: ['owned-writer'], multipartTransfer: { key: 'owned/bytes', uploadId: 'owned-upload', completedObject: false, parts: [{ partNumber: 1, byteLength: 5 * 1024 * 1024, etag: 'observed-etag' }] } } };
  test('rejects an HTTP-only transfer signal before an adapter writer starts', () => {
    assert.throws(() => assertTransferProgress({ receivedByteLength: 16, declaredByteLength: 16384 }, 'git'));
  });
  test('rejects buffered S3 bytes without an uploaded multipart part', () => {
    assert.throws(() => assertTransferProgress({ ...remote, adapterProgress: { ...remote.adapterProgress, multipartTransfer: { ...remote.adapterProgress.multipartTransfer, parts: [] } } }, 's3'));
  });
  for (const state of ['pending', 'running', 'failed']) test(`rejects eligible cleanup stuck in ${state} without reported errors`, () => {
    assert.throws(() => assertEligibleCleanup({ state, uncertainWriterCount: 0, errors: [] }));
  });
  test('accepts independent local staging progress', () => assertTransferProgress(local, 'git'));
  test('accepts an incomplete remote multipart transfer with an uploaded part', () => assertTransferProgress(remote, 's3'));
  test('accepts completed eligible cleanup', () => assertEligibleCleanup({ state: 'complete', uncertainWriterCount: 0, errors: [] }));
}
