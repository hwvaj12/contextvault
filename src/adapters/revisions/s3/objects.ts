import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, CreateMultipartUploadCommand,
  UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, ListMultipartUploadsCommand,
  ListObjectsV2Command, DeleteObjectsCommand, type CompletedPart,
} from '@aws-sdk/client-s3';
import { WorkspaceError, canonicalJson, verifyFileStream, workspaceLimits, type FileEntry, type WorkspaceLimits } from '../../../domain';
import { checkAbort, StreamLimiter } from '../../../application/files';
import type { ByteStream, StreamOptions } from '../../../ports/streams';
export interface S3ObjectOptions {
  /** Server-owned SDK client. Credentials and endpoints never come from workspace requests. */
  client: S3Client;
  bucket: string;
  /** Dedicated private namespace, ending in /. No user-controlled S3 locations. */
  prefix: string;
  storeId: string;
  encryption: { algorithm: 'AES256' } | { algorithm: 'aws:kms'; keyId: string };
  limits?: Partial<WorkspaceLimits>;
  /** Explicit test/emulator exception. Production transport requires HTTPS by default. */
  allowInsecureEndpoint?: boolean;
}
export const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const hash = (value: unknown) => digest(canonicalJson(value));
export const missingObject = (error: unknown) => (error as any)?.$metadata?.httpStatusCode === 404 || ['NoSuchKey', 'NotFound'].includes((error as Error)?.name);
const conditionalConflict = (error: unknown) => [409, 412].includes((error as any)?.$metadata?.httpStatusCode);
export const mismatch = (): never => { throw new WorkspaceError('RECEIPT_MISMATCH', 'Immutable S3 bytes differ from their recorded digest or length'); };
const metadataLimit = 16 * 1024 * 1024;

/** Stop waiting on an uncooperative producer without holding the adapter stream permit. */
async function* abortable(source: ByteStream, signal?: AbortSignal): ByteStream {
  if (!signal) { yield* source; return; }
  const iterator = source[Symbol.asyncIterator](); let finished = false;
  try {
    while (true) {
      checkAbort(signal);
      const pending = iterator.next();
      const result = await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Aborted')); };
        signal.addEventListener('abort', abort, { once: true });
        pending.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
        if (signal.aborted) abort();
      });
      if (result.done) { finished = true; return; }
      yield result.value;
    }
  } finally {
    if (!finished) {
      try { void Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* Preserve the cancellation or source failure. */ }
    }
  }
}

/** Bounded direct-SDK I/O. ETags are multipart protocol tokens, never file digests. */
export class S3Objects {
  readonly limits: WorkspaceLimits;
  readonly limiter: StreamLimiter;
  private readonly writerContext = new AsyncLocalStorage<{ state: { uncertain: boolean }; mutating: boolean }>();
  constructor(readonly options: S3ObjectOptions) {
    if (!options.client || !options.bucket?.trim() || !options.storeId?.trim() || !options.prefix || !options.prefix.endsWith('/')
      || options.prefix.startsWith('/') || options.prefix.split('/').slice(0, -1).some(p => !p || p === '.' || p === '..')
      || /[\u0000-\u001f\u007f]/.test(options.prefix)
      || !options.encryption || !['AES256', 'aws:kms'].includes(options.encryption.algorithm)
      || (options.encryption.algorithm === 'aws:kms' && !options.encryption.keyId?.trim())) {
      throw new WorkspaceError('INVALID_REQUEST', 'S3 storage requires explicit private scope, client, store ID, and encryption');
    }
    this.options = { ...options, encryption: { ...options.encryption } };
    this.limits = workspaceLimits(options.limits); this.limiter = new StreamLimiter(this.limits.maxConcurrentStreams);
  }
  private command<T extends { middlewareStack: { add: (...args: any[]) => void; addRelativeTo: (...args: any[]) => void } }>(command: T): T {
    command.middlewareStack.add((next: any) => async (args: any) => {
      if (args.request.protocol !== 'https:' && !this.options.allowInsecureEndpoint) {
        throw new WorkspaceError('INVALID_REQUEST', 'S3 transport requires HTTPS; plaintext needs an explicit emulator opt-in');
      }
      return next(args);
    }, { step: 'build', name: 'contextVaultRequireTls' });
    // Observe each failed attempt inside the SDK retry middleware, even if a later retry returns success.
    command.middlewareStack.addRelativeTo((next: any) => async (args: any) => {
      try { return await next(args); } catch (error) { this.observeMutationFailure(error, this.writerContext.getStore()); throw error; }
    }, { relation: 'after', toMiddleware: 'retryMiddleware', name: 'contextVaultObserveWrites' });
    return command;
  }
  private observeMutationFailure(error: unknown, context: { state: { uncertain: boolean }; mutating: boolean } | undefined): void {
    if (!context?.mutating) return;
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (!status || status >= 500) context.state.uncertain = true;
  }
  /** A transport failure can leave a remote write in progress after its caller stops waiting. */
  private async mutation<T>(send: () => Promise<T>): Promise<T> {
    const parent = this.writerContext.getStore();
    const context = parent ? { state: parent.state, mutating: true } : undefined;
    try { return context ? await this.writerContext.run(context, send) : await send(); }
    catch (error) { this.observeMutationFailure(error, context); throw error; }
  }
  async withStoppedWriter<T>(work: () => Promise<T>, stopped: () => Promise<unknown>): Promise<T> {
    const context = { state: { uncertain: false }, mutating: false };
    return this.writerContext.run(context, async () => { try { return await work(); } finally { if (!context.state.uncertain) await stopped(); } });
  }
  key(relative: string): string {
    if (!relative || relative.startsWith('/') || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new WorkspaceError('INVALID_REQUEST', 'Invalid internal S3 key');
    return this.options.prefix + relative;
  }
  private encryption() { return { ServerSideEncryption: this.options.encryption.algorithm, ...(this.options.encryption.algorithm === 'aws:kms' ? { SSEKMSKeyId: this.options.encryption.keyId } : {}) }; }
  private assertEncryption(response: { ServerSideEncryption?: string }) {
    if (response.ServerSideEncryption !== this.options.encryption.algorithm) throw new WorkspaceError('STORAGE_UNAVAILABLE', 'S3 encryption does not match configured policy');
  }
  async exists(relative: string, signal?: AbortSignal): Promise<boolean> {
    checkAbort(signal);
    try { const result = await this.options.client.send(this.command(new HeadObjectCommand({ Bucket: this.options.bucket, Key: this.key(relative) })), { abortSignal: signal }); this.assertEncryption(result); return true; }
    catch (error) { if (missingObject(error)) return false; throw error; }
  }
  async raw(relative: string, maximum = metadataLimit, signal?: AbortSignal): Promise<Buffer | null> {
    checkAbort(signal);
    let result;
    try { result = await this.options.client.send(this.command(new GetObjectCommand({ Bucket: this.options.bucket, Key: this.key(relative), ChecksumMode: 'ENABLED' })), { abortSignal: signal }); }
    catch (error) { if (missingObject(error)) return null; throw error; }
    const body = result.Body;
    try {
      this.assertEncryption(result);
      if (!body || result.ContentLength === undefined || result.ContentLength > maximum) mismatch();
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of body as ByteStream) { checkAbort(signal); length += chunk.byteLength; if (length > maximum) mismatch(); chunks.push(Buffer.from(chunk)); }
      const bytes = Buffer.concat(chunks);
      if (length !== result.ContentLength || (result.Metadata?.['cv-sha256'] && result.Metadata['cv-sha256'] !== digest(bytes))) mismatch();
      return bytes;
    } finally { (body as any)?.destroy?.(); }
  }
  async json<T>(relative: string, signal?: AbortSignal): Promise<T | null> {
    const bytes = await this.raw(relative, metadataLimit, signal);
    if (!bytes) return null;
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T; }
    catch { throw new WorkspaceError('STORAGE_UNAVAILABLE', 'Invalid immutable S3 metadata'); }
  }
  async putJson(relative: string, value: unknown, conflict: () => never, signal?: AbortSignal): Promise<void> {
    const bytes = Buffer.from(canonicalJson(value));
    if (bytes.length > metadataLimit) throw new WorkspaceError('QUOTA_EXCEEDED', 'S3 metadata limit exceeded');
    try { await this.put(relative, bytes, signal); }
    catch (error) {
      if (!conditionalConflict(error)) throw error;
      const existing = await this.raw(relative, metadataLimit, signal);
      if (!existing || !existing.equals(bytes)) conflict();
    }
  }
  private async put(relative: string, bytes: Buffer, signal?: AbortSignal): Promise<void> {
    checkAbort(signal);
    await this.mutation(() => this.options.client.send(this.command(new PutObjectCommand({ Bucket: this.options.bucket, Key: this.key(relative), Body: bytes,
      ContentLength: bytes.length, IfNoneMatch: '*', ChecksumSHA256: Buffer.from(digest(bytes), 'hex').toString('base64'),
      Metadata: { 'cv-sha256': digest(bytes) }, ...this.encryption() })), { abortSignal: signal }));
  }
  file(relative: string, entry: FileEntry, options: StreamOptions = {}, limited = true): ByteStream {
    const self = this;
    return (async function* () {
      const release = limited ? await self.limiter.acquire(options.signal) : () => {};
      let body: any;
      try {
        checkAbort(options.signal);
        const result = await self.options.client.send(self.command(new GetObjectCommand({ Bucket: self.options.bucket, Key: self.key(relative), ChecksumMode: 'ENABLED' })), { abortSignal: options.signal });
        body = result.Body; self.assertEncryption(result);
        if (!body || result.ContentLength !== entry.byteLength || result.Metadata?.['cv-sha256'] !== entry.sha256) mismatch();
        async function* checked() { for await (const chunk of body as ByteStream) { checkAbort(options.signal); yield chunk; } checkAbort(options.signal); }
        yield* verifyFileStream(entry, checked(), self.limits);
      } finally { body?.destroy?.(); release(); }
    })();
  }
  async verify(relative: string, entry: FileEntry, signal?: AbortSignal): Promise<void> {
    for await (const _ of this.file(relative, entry, { signal }, false)) { /* Full independent SHA-256 before metadata publication. */ }
  }
  async upload(relative: string, source: ByteStream, expected: { sha256: string; byteLength?: number }, signal?: AbortSignal): Promise<{ sha256: string; byteLength: number }> {
    const release = await this.limiter.acquire(signal);
    const partSize = Math.max(5 * 1024 * 1024, Math.ceil(this.limits.maxFileBytes / 10000));
    let uploadId: string | undefined;
    let buffer = Buffer.alloc(partSize); let used = 0; let length = 0; const sha = createHash('sha256'); const parts: CompletedPart[] = [];
    const base = { Bucket: this.options.bucket, Key: this.key(relative) };
    const part = async (bytes: Buffer) => {
      if (!uploadId) {
        uploadId = (await this.mutation(() => this.options.client.send(this.command(new CreateMultipartUploadCommand({ ...base, ChecksumAlgorithm: 'SHA256', Metadata: { 'cv-sha256': expected.sha256 }, ...this.encryption() })), { abortSignal: signal }))).UploadId;
        if (!uploadId) throw new WorkspaceError('STORAGE_UNAVAILABLE', 'S3 omitted multipart upload identity');
      }
      const checksum = Buffer.from(digest(bytes), 'hex').toString('base64');
      const result = await this.mutation(() => this.options.client.send(this.command(new UploadPartCommand({ ...base, UploadId: uploadId, PartNumber: parts.length + 1,
        Body: bytes, ContentLength: bytes.length, ChecksumSHA256: checksum })), { abortSignal: signal }));
      if (!result.ETag || result.ChecksumSHA256 !== checksum) mismatch();
      parts.push({ PartNumber: parts.length + 1, ETag: result.ETag, ChecksumSHA256: checksum });
    };
    try {
      if (!/^[a-f0-9]{64}$/.test(expected.sha256) || (expected.byteLength !== undefined && (!Number.isSafeInteger(expected.byteLength) || expected.byteLength < 0))) throw new WorkspaceError('INVALID_MANIFEST', 'Invalid upload declaration');
      if (expected.byteLength !== undefined && expected.byteLength > this.limits.maxFileBytes) throw new WorkspaceError('QUOTA_EXCEEDED', 'File byte limit exceeded');
      for await (const incoming of abortable(source, signal)) {
        checkAbort(signal); if (!(incoming instanceof Uint8Array)) mismatch();
        length += incoming.byteLength;
        if (!Number.isSafeInteger(length) || length > this.limits.maxFileBytes || length > this.limits.maxTotalBytes) throw new WorkspaceError('QUOTA_EXCEEDED', 'Stream byte limit exceeded');
        if (expected.byteLength !== undefined && length > expected.byteLength) mismatch();
        for (let offset = 0; offset < incoming.byteLength;) {
          checkAbort(signal);
          if (used === partSize) { await part(buffer); buffer = Buffer.alloc(partSize); used = 0; }
          const count = Math.min(partSize - used, incoming.byteLength - offset, this.limits.maxChunkBytes);
          const chunk = Buffer.from(incoming.subarray(offset, offset + count)); sha.update(chunk); chunk.copy(buffer, used); used += count; offset += count;
        }
      }
      checkAbort(signal);
      const sha256 = sha.digest('hex');
      if (sha256 !== expected.sha256 || (expected.byteLength !== undefined && length !== expected.byteLength)) mismatch();
      // Validate the complete digest before PUT or multipart completion can expose an immutable object.
      try {
        if (!uploadId) await this.put(relative, buffer.subarray(0, used), signal);
        else {
          if (used) await part(buffer.subarray(0, used));
          await this.mutation(() => this.options.client.send(this.command(new CompleteMultipartUploadCommand({ ...base, UploadId: uploadId, IfNoneMatch: '*', MultipartUpload: { Parts: parts } })), { abortSignal: signal }));
          uploadId = undefined;
        }
      } catch (error) { if (!conditionalConflict(error)) throw error; }
      await this.verify(relative, { path: 'verified', kind: 'file', byteLength: length, sha256 }, signal);
      return { byteLength: length, sha256 };
    } finally {
      if (uploadId) {
        try { await this.mutation(() => this.options.client.send(this.command(new AbortMultipartUploadCommand({ ...base, UploadId: uploadId })))); }
        catch { /* The durable intent and deterministic key retain ownership for fenced collection. */ }
      }
      release();
    }
  }
  /** Caller must permanently fence acceptance before deleting this exact immutable candidate namespace. */
  async hasContents(relativePrefix: string): Promise<boolean> {
    const Prefix = this.key(relativePrefix) + '/';
    const objects = await this.options.client.send(this.command(new ListObjectsV2Command({ Bucket: this.options.bucket, Prefix, MaxKeys: 1 })));
    if (objects.Contents?.length) return true;
    const uploads = await this.options.client.send(this.command(new ListMultipartUploadsCommand({ Bucket: this.options.bucket, Prefix, MaxUploads: 1 })));
    return !!uploads.Uploads?.length;
  }
  /** Caller must permanently fence acceptance before deleting this exact immutable candidate namespace. */
  async collect(relativePrefix: string, preserve: string): Promise<void> {
    const prefix = this.key(relativePrefix) + '/';
    let keyMarker: string | undefined; let uploadMarker: string | undefined;
    do {
      const result = await this.options.client.send(this.command(new ListMultipartUploadsCommand({ Bucket: this.options.bucket, Prefix: prefix, KeyMarker: keyMarker, UploadIdMarker: uploadMarker })));
      for (const item of result.Uploads ?? []) if (item.Key?.startsWith(prefix)) await this.options.client.send(this.command(new AbortMultipartUploadCommand({ Bucket: this.options.bucket, Key: item.Key, UploadId: item.UploadId! })));
      keyMarker = result.IsTruncated ? result.NextKeyMarker : undefined; uploadMarker = result.IsTruncated ? result.NextUploadIdMarker : undefined;
    } while (keyMarker);
    let token: string | undefined;
    do {
      const result = await this.options.client.send(this.command(new ListObjectsV2Command({ Bucket: this.options.bucket, Prefix: prefix, ContinuationToken: token })));
      const objects = (result.Contents ?? []).filter(o => o.Key?.startsWith(prefix) && o.Key !== this.key(preserve)).map(o => ({ Key: o.Key! }));
      if (objects.length) {
        const removed = await this.options.client.send(this.command(new DeleteObjectsCommand({ Bucket: this.options.bucket, Delete: { Objects: objects } })));
        if (removed.Errors?.length) throw new WorkspaceError('STORAGE_UNAVAILABLE', 'S3 collection did not delete every scoped object');
      }
      token = result.NextContinuationToken;
    } while (token);
  }
}
