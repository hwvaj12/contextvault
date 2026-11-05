import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { S3Client, ListMultipartUploadsCommand, ListPartsCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { loadConfiguration } from '../../src/config';
import { cleanupHttpStorage, fixtureEnvironment, storageEnvironment } from '../http/helpers';
// @ts-ignore JavaScript fixture contract shared by the canonical backend gates.
import { requireS3 } from '../../scripts/run-workspace-tests.mjs';

export type Boundary = 'before-candidate' | 'during-transfer' | 'after-candidate' | 'before-acceptance' | 'after-acceptance';
const root = resolve(import.meta.dirname, '../..');
type Exit = { code: number | null; signal: NodeJS.Signals | null };
function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(label)), milliseconds); })]).finally(() => clearTimeout(timer));
}

export async function physicalServer() {
  const backend = process.env.CV_TEST_BACKEND ?? 'git';
  if (backend === 's3') requireS3({ ...process.env }, { s3Provider: process.env.CV_TEST_S3_PROVIDER });
  const storage = storageEnvironment(), directory = await mkdtemp(join(await realpath(tmpdir()), 'cv-physical-crash-'));
  const master = 'physical-master-' + randomUUID(), customerId = 'physical-' + randomUUID(), clock = new Date();
  const env = fixtureEnvironment(directory, 0, storage, { CONTEXTVAULT_API_KEY: master, CV_PROCESSING_TTL_MS: '5000' });
  const configuration = loadConfiguration(env);
  let child: ChildProcess | undefined, exited: Promise<Exit> | undefined, baseUrl = '', sequence = 0;
  let output = '', boundaryMessage: any, boundaryResolve: ((message: any) => void) | undefined;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  function command(command: string, parameters: Record<string, unknown> = {}) {
    const id = ++sequence;
    const result = new Promise<any>((resolve, reject) => { pending.set(id, { resolve, reject }); child!.send!({ id, command, ...parameters }); });
    return bounded(result, 10000, 'Physical fixture command timed out: ' + command).finally(() => pending.delete(id));
  }
  const f = {
    directory, master, customerId, backend,
    testPrefix: storage.CV_S3_PREFIX ?? null,
    get baseUrl() { return baseUrl; }, get pid() { return child!.pid!; },
    async start(recovery = false) {
      if (child && child.exitCode === null && child.signalCode === null) throw Error('Previous physical server still runs');
      boundaryMessage = undefined; boundaryResolve = undefined; output = '';
      child = fork(join(root, 'tests/faults/server-process.ts'), [], { cwd: directory,
        execArgv: ['-r', join(root, 'node_modules/ts-node/register/transpile-only')],
        env: { ...env, CV_FAULT_CLOCK: new Date(clock.getTime() + (recovery ? 60000 : 0)).toISOString() }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      exited = new Promise(resolve => child!.once('exit', (code, signal) => resolve({ code, signal })));
      child.stdout!.on('data', bytes => { output = (output + bytes).slice(-8192); }); child.stderr!.on('data', bytes => { output = (output + bytes).slice(-8192); });
      const ready = new Promise<void>((resolve, reject) => {
        child!.on('message', (value: any) => {
          if (value.type === 'ready') { if (value.pid !== child!.pid || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.baseUrl)) return reject(Error('Invalid owned listener')); baseUrl = value.baseUrl; resolve(); }
          else if (value.type === 'boundary') { boundaryMessage = value; boundaryResolve?.(value); }
          else if (pending.has(value.id)) { const item = pending.get(value.id)!; value.ok ? item.resolve(value) : item.reject(Error(value.code)); }
        });
        child!.once('error', reject);
        child!.once('exit', (code, signal) => { for (const item of pending.values()) item.reject(Error('Physical fixture exited')); pending.clear(); reject(Error(`Physical fixture exited before readiness: ${code}/${signal}: ${output}`)); });
      });
      await bounded(ready, 15000, 'Physical fixture readiness timed out: ' + output);
      const health = await fetch(baseUrl + '/health', { signal: AbortSignal.timeout(1000) });
      if (!health.ok) throw Error('Owned physical listener failed health'); await health.body?.cancel();
    },
    async arm(boundary: Boundary) { boundaryMessage = undefined; await command('arm', { boundary }); },
    async boundary() { return boundaryMessage ?? bounded(new Promise<any>(resolve => { boundaryResolve = resolve; }), 10000, 'Physical boundary was not reached'); },
    async kill(): Promise<Exit> { if (!child || child.exitCode !== null || child.signalCode !== null) throw Error('Physical crash requires a live server'); child.kill('SIGKILL'); return bounded(exited!, 5000, 'Physical server did not exit'); },
    async recover() { return (await command('recover')).report; },
    request(method: string, route: string, body?: unknown, key = master, extra: Record<string, string> = {}) {
      const binary = body instanceof Uint8Array;
      return fetch(baseUrl + route, { method, signal: AbortSignal.timeout(5000), headers: { 'X-API-Key': key, 'Idempotency-Key': randomUUID(),
        ...(body === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }), ...(binary ? { 'X-Content-SHA256': createHash('sha256').update(body).digest('hex') } : {}), ...extra },
        body: body === undefined ? undefined : binary ? Buffer.from(body) : JSON.stringify(body) });
    },
    partialUpload(runId: string, submissionId: string, key: string, bytes: Buffer) {
      const idempotencyKey = randomUUID();
      const request = httpRequest(baseUrl + `/v1/runs/${runId}/submissions/${submissionId}/files?path=binary.bin`, { method: 'PUT', headers: { 'X-API-Key': key, 'Idempotency-Key': idempotencyKey,
        'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'X-Content-SHA256': createHash('sha256').update(bytes).digest('hex') } });
      const closed = new Promise<{ status?: number; code?: string }>(resolve => { request.once('response', response => { response.resume(); resolve({ status: response.statusCode }); }); request.once('error', error => resolve({ code: (error as NodeJS.ErrnoException).code })); });
      request.setTimeout(10000, () => request.destroy(Error('Partial upload stalled'))); request.write(bytes.subarray(0, 6 * 1024 * 1024));
      return { idempotencyKey, closed: bounded(closed, 10000, 'Partial upload did not close'), destroy: () => request.destroy() };
    },
    async transferProof(workspaceId: string, submissionId: string, paused: any, declared: Buffer) {
      const writers = f.catalog(workspaceId).writers.filter((writer: any) => writer.submissionId === submissionId && writer.state === 'active');
      if (writers.length !== 1 || paused.adapterProgress?.writerIds?.length !== 1 || writers[0].id !== paused.adapterProgress.writerIds[0]) throw Error('Adapter writer was not independently observed');
      const writer = writers[0], profile = configuration.profiles.find(value => value.configurationRef === configuration.defaultConfigurationRef)!;
      const progress: any = { consumedByteLength: paused.adapterProgress.consumedByteLength, writerIds: writers.map((value: any) => value.id) };
      if (profile.backend === 'git') {
        const file = await readFile(join(profile.submissionRoot, 'staging', createHash('sha256').update(JSON.stringify(writer.id)).digest('hex'), 'bytes'));
        progress.localTransfer = { byteLength: file.length, matchesDeclaredPrefix: file.equals(declared.subarray(0, file.length)), sha256: createHash('sha256').update(file).digest('hex') };
      } else {
        const client = new S3Client({ region: profile.region, endpoint: profile.endpoint, forcePathStyle: profile.provider === 'localstack', ignoreConfiguredEndpointUrls: true, maxAttempts: 1,
          ...(profile.provider === 'localstack' ? { credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } : {}) });
        try {
          const key = profile.prefix + 'submissions/v1/attempts/' + writer.attemptKey + '/bytes';
          const result = await client.send(new ListMultipartUploadsCommand({ Bucket: profile.bucket, Prefix: key }), { abortSignal: AbortSignal.timeout(5000) });
          const uploads = (result.Uploads ?? []).filter(value => value.Key === key && value.UploadId);
          if (uploads.length !== 1) throw Error('The actual incomplete S3 multipart transfer was not observed');
          const parts = await client.send(new ListPartsCommand({ Bucket: profile.bucket, Key: key, UploadId: uploads[0].UploadId }), { abortSignal: AbortSignal.timeout(5000) });
          let completedObject = true;
          try { await client.send(new HeadObjectCommand({ Bucket: profile.bucket, Key: key }), { abortSignal: AbortSignal.timeout(5000) }); }
          catch (error) { if ((error as any).$metadata?.httpStatusCode !== 404) throw error; completedObject = false; }
          progress.multipartTransfer = { key, uploadId: uploads[0].UploadId, completedObject, parts: (parts.Parts ?? []).map(part => ({ partNumber: part.PartNumber, byteLength: part.Size, etag: part.ETag })) };
        } finally { client.destroy(); }
      }
      return { receivedByteLength: paused.receivedByteLength, declaredByteLength: declared.length, adapterProgress: progress };
    },
    catalog(workspaceId: string) {
      const db = new Database(join(env.CV_DATA_DIR!, 'contextvault.db'), { readonly: true, fileMustExist: true });
      try {
        const records = db.prepare('SELECT kind,data FROM catalog_records WHERE customer_id=? AND workspace_id=?').all(customerId, workspaceId) as { kind: string; data: string }[];
        const values = (kind: string) => records.filter(row => row.kind === kind).map(row => JSON.parse(row.data));
        const workspace = values('workspace')[0]; if (!workspace) throw Error('Owned catalog workspace is missing');
        return { workspace, revisions: values('revision'), operations: values('operation'), audits: values('audit'), outbox: values('outbox'), writers: values('submission-writer'), cleanups: values('cleanup') };
      } finally { db.close(); }
    },
    async operation(id: string, key: string) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await f.request('GET', '/v1/operations/' + id, undefined, key);
        if (!response.ok) throw Error('Physical operation read failed: ' + response.status);
        const value = await response.json(); if (value.state === 'succeeded' || value.state === 'failed') return value;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw Error('Physical operation did not reach a durable outcome');
    },
    async dispose() {
      try { if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await bounded(exited!, 5000, 'Owned child cleanup timed out'); } await cleanupHttpStorage(storage); }
      finally { await rm(directory, { recursive: true, force: true }); }
    },
  };
  try { await f.start(); return f; } catch (error) { await f.dispose(); throw error; }
}
