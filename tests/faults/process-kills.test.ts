import { afterAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { create, open, submit, finalize, json } from '../http/helpers';
import { physicalServer, type Boundary } from './process-harness';
import { assertEligibleCleanup, assertTransferProgress } from './verification-guards.mjs';

const backend = process.env.CV_TEST_BACKEND ?? 'git';
if (!['git', 's3'].includes(backend)) throw Error('Physical crash gate requires git or s3');
const boundaries: Boundary[] = ['before-candidate', 'during-transfer', 'after-candidate', 'before-acceptance', 'after-acceptance'];
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const payload = Buffer.from(Array.from({ length: 16384 }, (_, index) => index % 256));
const transferPayload = Buffer.alloc(7 * 1024 * 1024, Buffer.from([0, 255, 128, 13, 10]));
const replacement = { 'binary.bin': payload, 'fresh.txt': Buffer.from('accepted after a physical server crash\n') };
const evidence: { schemaVersion: number; backend: string; cases: any[]; revocation?: any } = { schemaVersion: 1, backend, cases: [] };

afterAll(async () => {
  const file = process.env.CV_FAULT_EVIDENCE_PATH;
  if (file && !isAbsolute(file)) throw Error('CV_FAULT_EVIDENCE_PATH must be an absolute private output path');
  await writeFile(file ?? join(import.meta.dirname, `verification-${backend}-${randomUUID()}.log`), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
});

async function seeded(f: Awaited<ReturnType<typeof physicalServer>>) {
  const credential = await json(await f.request('POST', '/api-keys', { customerId: f.customerId, name: 'physical crash credential' }), 201);
  const workspace = await create(f, credential.plainKey, f.customerId);
  const seedRun = await open(f, workspace.id, credential.plainKey);
  const seed = await submit(f, seedRun, credential.plainKey, { 'binary.bin': Buffer.from('old bytes'), 'delete-me.txt': Buffer.from('must disappear on replacement') });
  expect((await finalize(f, seedRun, credential.plainKey, seed.id)).state).toBe('succeeded');
  const before = f.catalog(workspace.id);
  expect(before.revisions).toHaveLength(2);
  return { credential, workspace, before };
}

async function readback(f: Awaited<ReturnType<typeof physicalServer>>, workspaceId: string, key: string, expected: Record<string, Buffer>) {
  const run = await open(f, workspaceId, key, 'read-only');
  const manifest = await json(await f.request('GET', `/v1/runs/${run.id}/workspace/manifest`, undefined, key), 200);
  expect(manifest.entries.map((entry: any) => entry.path)).toEqual(Object.keys(expected).sort());
  let binary: Buffer | undefined;
  for (const [path, bytes] of Object.entries(expected)) {
    const response = await f.request('GET', `/v1/runs/${run.id}/workspace/files?path=${encodeURIComponent(path)}`, undefined, key);
    expect(response.status).toBe(200);
    const received = Buffer.from(await response.arrayBuffer());
    expect(received.equals(bytes)).toBe(true);
    if (path === 'binary.bin') binary = received;
  }
  await json(await f.request('POST', `/v1/runs/${run.id}/abort`, { expectedRunVersion: run.version, reason: 'physical crash readback finished' }, key), 200);
  return { manifestPaths: manifest.entries.map((entry: any) => entry.path), binarySha256: hash(binary!), binaryByteLength: binary!.length };
}

async function drainCleanup(f: Awaited<ReturnType<typeof physicalServer>>, workspaceId: string, runId: string, retainUncertain = false) {
  const errors: any[] = [];
  let state = f.catalog(workspaceId);
  for (let turn = 0; turn < 9; turn++) {
    errors.push(...(await f.recover()).errors);
    state = f.catalog(workspaceId);
    if (retainUncertain || state.cleanups.find((value: any) => value.runId === runId)?.state === 'complete') break;
    expect(errors).toEqual([]);
  }
  return { state, errors };
}

describe(`physical server crashes: ${backend}`, () => {
  for (const boundary of boundaries) {
    it(`recovers SIGKILL at ${boundary} with one authoritative publication`, async () => {
      const f = await physicalServer();
      try {
        const files = boundary === 'during-transfer' ? { ...replacement, 'binary.bin': transferPayload } : replacement;
        const binary = files['binary.bin'];
        const { credential, workspace, before } = await seeded(f);
        const key = credential.plainKey, run = await open(f, workspace.id, key);
        const finalizeKey = randomUUID();
        let submission: any, operationId: string | undefined, oldFence: number | null = null, originalIdentity: any;
        let partial: ReturnType<typeof f.partialUpload> | undefined;
        let transferProof: any;
        if (boundary === 'during-transfer') {
          submission = await json(await f.request('POST', `/v1/runs/${run.id}/submissions`, {}, key), 201);
          await f.arm(boundary);
          partial = f.partialUpload(run.id, submission.id, key, binary);
        } else {
          submission = await submit(f, run, key, files);
          await f.arm(boundary);
          const operation = await json(await f.request('POST', `/v1/runs/${run.id}/finalize`, { expectedRunVersion: run.version, submissionId: submission.id }, key, { 'Idempotency-Key': finalizeKey }), 202);
          operationId = operation.id;
        }
        const paused = await f.boundary();
        expect(paused.boundary).toBe(boundary);
        expect(paused.pid).toBe(f.pid);
        if (boundary === 'during-transfer') {
          transferProof = await f.transferProof(workspace.id, submission.id, paused, binary);
          assertTransferProgress(transferProof, backend);
        } else {
          expect(paused.operationId).toBe(operationId);
          expect(paused.candidatePresent).toBe(boundary !== 'before-candidate');
          const operation = f.catalog(workspace.id).operations.find((value: any) => value.id === operationId);
          oldFence = operation.claim.fence;
          originalIdentity = operation.intent.candidateIdentity;
        }
        const killedPid = f.pid, exit = await f.kill();
        expect(exit).toEqual({ code: null, signal: 'SIGKILL' });
        if (partial) { const result = await partial.closed; expect(result.status).not.toBe(201); partial.destroy(); }
        const afterKill = f.catalog(workspace.id);
        const killedWriters = afterKill.writers.filter((writer: any) => writer.submissionId === submission.id && writer.state === 'active');
        if (boundary === 'during-transfer') expect(killedWriters.map((writer: any) => writer.id)).toEqual(transferProof.adapterProgress.writerIds);
        else expect(killedWriters).toEqual([]);
        expect(afterKill.workspace.currentRevisionId === before.workspace.currentRevisionId).toBe(boundary !== 'after-acceptance');
        expect(afterKill.revisions).toHaveLength(before.revisions.length + (boundary === 'after-acceptance' ? 1 : 0));
        await f.start(true);
        expect(f.pid).not.toBe(killedPid);
        if (boundary === 'during-transfer') {
          const unsealed = await json(await f.request('GET', `/v1/runs/${run.id}/submissions/${submission.id}`, undefined, key), 200);
          expect(unsealed.state).toBe('uploading');
          const refused = await json(await f.request('POST', `/v1/runs/${run.id}/finalize`, { expectedRunVersion: run.version, submissionId: submission.id }, key, { 'Idempotency-Key': finalizeKey }), 422);
          expect(refused.error.code).toBe('RECEIPT_MISMATCH');
          const entries = [], receipts = [];
          for (const [path, bytes] of Object.entries(files)) {
            const receipt = await json(await f.request('PUT', `/v1/runs/${run.id}/submissions/${submission.id}/files?path=${encodeURIComponent(path)}`, bytes, key, path === 'binary.bin' ? { 'Idempotency-Key': partial!.idempotencyKey } : {}), 201);
            entries.push({ path, kind: 'file', byteLength: bytes.length, sha256: hash(bytes) }); receipts.push({ path, receiptId: receipt.id });
          }
          await json(await f.request('POST', `/v1/runs/${run.id}/submissions/${submission.id}/seal`, { manifest: { schemaVersion: 1, entries }, receipts }, key), 200);
          operationId = (await json(await f.request('POST', `/v1/runs/${run.id}/finalize`, { expectedRunVersion: run.version, submissionId: submission.id }, key, { 'Idempotency-Key': finalizeKey }), 202)).id;
        } else {
          const recovered = await f.recover();
          expect(recovered.errors).toEqual([]);
          expect(recovered.recovered).toBe(boundary === 'after-acceptance' ? 0 : 1);
        }
        const accepted = await f.operation(operationId!, key);
        expect(accepted.state).toBe('succeeded');
        expect(accepted.result).toMatchObject({ kind: 'finalize', runState: 'finalized', changed: true });
        const after = f.catalog(workspace.id);
        const operation = after.operations.find((value: any) => value.id === operationId);
        expect(after.workspace.currentRevisionId).toBe(accepted.result.revisionId);
        expect(after.workspace.version).toBe(before.workspace.version + 1);
        expect(after.revisions).toHaveLength(before.revisions.length + 1);
        expect(after.revisions.filter((value: any) => value.originatingOperationId === operationId)).toHaveLength(1);
        const audits = after.audits.filter((value: any) => value.operationId === operationId && value.type === 'run.finalized');
        const outbox = after.outbox.filter((value: any) => value.operationId === operationId && value.type === 'run.finalized');
        expect(audits).toHaveLength(1); expect(outbox).toHaveLength(1);
        if (originalIdentity) expect(operation.intent.candidateIdentity).toEqual(originalIdentity);
        if (oldFence !== null && boundary === 'after-acceptance') expect(operation.claim.fence).toBe(oldFence);
        if (oldFence !== null && boundary !== 'after-acceptance') expect(operation.claim.fence).toBeGreaterThan(oldFence);
        const replay = await json(await f.request('POST', `/v1/runs/${run.id}/finalize`, { expectedRunVersion: run.version, submissionId: submission.id }, key, { 'Idempotency-Key': finalizeKey }), 202);
        expect(replay.id).toBe(operationId); expect(replay.state).toBe('succeeded');
        const maintenance = await drainCleanup(f, workspace.id, run.id, killedWriters.length > 0);
        const repeated = maintenance.state;
        const uncertainWriters = repeated.writers.filter((writer: any) => writer.submissionId === submission.id && writer.state === 'active');
        const cleanup = repeated.cleanups.find((value: any) => value.runId === run.id);
        if (killedWriters.length) {
          expect(boundary).toBe('during-transfer');
          expect(uncertainWriters.map((writer: any) => writer.id).sort()).toEqual(killedWriters.map((writer: any) => writer.id).sort());
          expect(['pending', 'failed']).toContain(cleanup.state);
          for (const error of maintenance.errors) expect(error).toEqual({ work: 'collect-submission', id: submission.id, code: 'FORBIDDEN', message: 'Active or uncertain writers and recoverable sources retain submission bytes' });
        } else { expect(uncertainWriters).toEqual([]); assertEligibleCleanup({ state: cleanup.state, uncertainWriterCount: uncertainWriters.length, errors: maintenance.errors }); }
        expect(repeated.workspace.currentRevisionId).toBe(accepted.result.revisionId);
        expect(repeated.operations.find((value: any) => value.id === operationId).state).toBe('succeeded');
        expect(repeated.revisions).toHaveLength(after.revisions.length);
        expect(repeated.audits.filter((value: any) => value.operationId === operationId)).toHaveLength(1);
        expect(repeated.outbox.filter((value: any) => value.operationId === operationId)).toHaveLength(1);
        const read = await readback(f, workspace.id, key, files);
        expect(read.manifestPaths).not.toContain('delete-me.txt');
        evidence.cases.push({ boundary, pid: killedPid, exit, headBeforeKill: before.workspace.currentRevisionId, headAfterKill: afterKill.workspace.currentRevisionId, headAfterRecovery: after.workspace.currentRevisionId,
          revisionCountBefore: before.revisions.length, revisionCountAfter: after.revisions.length, publicationAuditCount: audits.length, publicationOutboxCount: outbox.length,
          ...read, oldFence, newFence: operation.claim.fence, operationId, replayedOperationId: replay.id, submissionId: submission.id, testPrefix: f.testPrefix,
          cleanup: { state: cleanup.state, uncertainWriterCount: uncertainWriters.length, uncertainWriterIds: uncertainWriters.map((writer: any) => writer.id), errors: maintenance.errors },
          ...(boundary === 'during-transfer' ? { ...transferProof, incompleteUploadPublished: false } : { candidatePresentAtKill: paused.candidatePresent, candidateIdentityRetained: true }) });
      } finally { await f.dispose(); }
    });
  }

  it('rejects revoked authority after SIGKILL before recovery', async () => {
    const f = await physicalServer();
    try {
      const { credential, workspace, before } = await seeded(f);
      const run = await open(f, workspace.id, credential.plainKey), submission = await submit(f, run, credential.plainKey, replacement);
      await f.arm('before-acceptance');
      const operation = await json(await f.request('POST', `/v1/runs/${run.id}/finalize`, { expectedRunVersion: run.version, submissionId: submission.id }, credential.plainKey), 202);
      const paused = await f.boundary(); expect(paused.operationId).toBe(operation.id); expect(paused.candidatePresent).toBe(true);
      const oldFence = f.catalog(workspace.id).operations.find((value: any) => value.id === operation.id).claim.fence;
      const pid = f.pid, exit = await f.kill(); expect(exit).toEqual({ code: null, signal: 'SIGKILL' });
      await f.start(true);
      expect((await f.request('DELETE', `/api-keys/${credential.id}`)).status).toBe(204);
      expect((await f.request('GET', `/v1/operations/${operation.id}`, undefined, credential.plainKey)).status).toBe(401);
      expect((await f.recover()).errors).toEqual([]);
      const outcome = await json(await f.request('GET', `/v1/operations/${operation.id}`, undefined, f.master, { 'X-ContextVault-Customer-ID': f.customerId }), 200);
      expect(outcome.state).toBe('failed'); expect(outcome.error.code).toBe('CREDENTIAL_REVOKED');
      const after = f.catalog(workspace.id), saved = after.operations.find((value: any) => value.id === operation.id);
      expect(after.workspace.currentRevisionId).toBe(before.workspace.currentRevisionId);
      expect(after.workspace.version).toBe(before.workspace.version); expect(after.revisions).toHaveLength(before.revisions.length);
      expect(after.revisions.filter((value: any) => value.originatingOperationId === operation.id)).toHaveLength(0);
      expect(saved.claim.fence).toBeGreaterThan(oldFence);
      expect(after.audits.filter((value: any) => value.operationId === operation.id && value.type === 'run.finalized')).toHaveLength(0);
      expect(after.outbox.filter((value: any) => value.operationId === operation.id && value.type === 'run.finalized')).toHaveLength(0);
      expect(after.audits.filter((value: any) => value.operationId === operation.id && value.type === 'run.failed')).toHaveLength(1);
      expect(after.outbox.filter((value: any) => value.operationId === operation.id && value.type === 'run.failed')).toHaveLength(1);
      const replacementKey = await json(await f.request('POST', '/api-keys', { customerId: f.customerId, name: 'readback after revocation' }), 201);
      await readback(f, workspace.id, replacementKey.plainKey, { 'binary.bin': Buffer.from('old bytes'), 'delete-me.txt': Buffer.from('must disappear on replacement') });
      const maintenance = await drainCleanup(f, workspace.id, run.id);
      const final = maintenance.state, cleanup = final.cleanups.find((value: any) => value.runId === run.id);
      const uncertainWriters = final.writers.filter((writer: any) => writer.submissionId === submission.id && writer.state === 'active');
      assertEligibleCleanup({ state: cleanup.state, uncertainWriterCount: uncertainWriters.length, errors: maintenance.errors });
      expect(final.revisions).toHaveLength(before.revisions.length);
      evidence.revocation = { pid, exit, headUnchanged: after.workspace.currentRevisionId === before.workspace.currentRevisionId, acceptedPublicationCount: 0,
        error: outcome.error.code, operationId: operation.id, oldFence, newFence: saved.claim.fence, publicationAuditCount: 0, publicationOutboxCount: 0, failureAuditCount: 1, failureOutboxCount: 1,
        cleanup: { state: cleanup.state, uncertainWriterCount: uncertainWriters.length, uncertainWriterIds: uncertainWriters.map((writer: any) => writer.id), errors: maintenance.errors } };
    } finally { await f.dispose(); }
  });
});
