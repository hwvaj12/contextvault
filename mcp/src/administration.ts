import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ContextVaultClient, ContextVaultError, NetworkError, OutcomeUnknownError } from '@contextvault/sdk';
import { controller, fail, optionalJson, readJson, recoverController, safeDirectory, saveJson } from './private.js';
import type { Sessions } from './sessions.js';

interface Request { method: 'POST' | 'DELETE'; path: string; body: unknown }
interface Command { schemaVersion: 1; id: string; inputDigest: string; request: Request; key: string; operationId: string | null }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const commandPattern = /^command-[a-f0-9]{64}$/;

/** Thin authenticated administration client. Commands retain exact requests before HTTP; the server catalog owns every outcome. */
export class Administration {
  private readonly ready: Promise<void>;
  private readonly directory: string;
  constructor(private readonly client: ContextVaultClient, sessions: Sessions, private readonly options: { apiKey: string; baseUrl: string; fetch: typeof fetch; requestTimeoutMs: number }) {
    this.directory = join(sessions.directory, 'commands');
    this.ready = sessions.initialize().then(() => safeDirectory(this.directory, true));
  }
  private path(id: string) { if (!commandPattern.test(id)) fail('INVALID_REQUEST', 'Use an opaque MCP command handle'); return join(this.directory, id + '.json'); }
  initialize() { return this.ready; }
  private lock(id: string) { return this.path(id) + '.controller'; }
  async request(method: string, path: string, body?: unknown, key?: string): Promise<any> {
    if (!(path.startsWith('/v1/') || path.startsWith('/workspaces/')) || path.startsWith('//')) fail('INVALID_REQUEST', 'Administration requires a fixed relative API route');
    const headers: Record<string, string> = { 'X-API-Key': this.options.apiKey, Accept: 'application/json' };
    if (key) headers['Idempotency-Key'] = key;
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > 512 * 1024) fail('QUOTA_EXCEEDED', 'MCP direct requests are limited to 512 KiB; use workspace file chunks for larger snapshots');
    if (encoded !== undefined) headers['Content-Type'] = 'application/json';
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), this.options.requestTimeoutMs); timer.unref();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.options.fetch(this.options.baseUrl + path, { method, headers, ...(encoded === undefined ? {} : { body: encoded }), redirect: 'error', signal: abort.signal });
      if (response.status === 204) return undefined;
      if (!response.body) throw new NetworkError('Administration response was incomplete');
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.length; if (length > 2 * 1024 * 1024) throw new NetworkError('MCP response exceeds its byte limit; use workspace file chunks'); chunks.push(next.value); }
      let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new NetworkError('Administration response was not complete JSON'); }
      if (!response.ok) throw new ContextVaultError('ContextVault rejected the administration request', response.status, value);
      return value;
    } catch (error) { if (error instanceof ContextVaultError) throw error; throw new NetworkError('Administration transport did not complete'); }
    finally { clearTimeout(timer); if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } }
  }
  private async dispatch(command: Command) {
    try {
      const value = await this.request(command.request.method, command.request.path, command.request.body, command.key);
      if (value && typeof value.kind === 'string' && ['pending', 'processing', 'succeeded', 'failed'].includes(value.state)) {
        command.operationId = value.id; await saveJson(this.path(command.id), command);
        const operation = await this.client.operations.wait(value.id);
        if (operation.state === 'failed') throw new ContextVaultError('The administration operation has a recorded failure', 409, { error: operation.error });
        return operation;
      }
      return value;
    } catch (error) {
      if (error instanceof NetworkError || (error instanceof ContextVaultError && (error.statusCode ?? 0) >= 500)) throw Object.assign(new OutcomeUnknownError('Administration requires reconciliation of its original command', { idempotencyKey: command.key, operationId: command.operationId ?? undefined }), { commandHandle: command.id });
      if (error instanceof Error) Object.assign(error, { commandHandle: command.id });
      throw error;
    }
  }
  async execute(kind: string, input: Record<string, unknown>, requestId: string | undefined, prepare: () => Promise<Request>) {
    await this.ready;
    const id = 'command-' + digest(kind + ':' + (requestId ?? randomUUID())); const inputDigest = digest(canonical(input));
    return controller(this.lock(id), id, async () => {
      let command = await optionalJson<Command>(this.path(id));
      if (command && (command.schemaVersion !== 1 || command.id !== id || command.inputDigest !== inputDigest)) fail('IDEMPOTENCY_KEY_REUSED', 'This requestId belongs to another exact administration command');
      if (!command) { command = { schemaVersion: 1, id, inputDigest, request: await prepare(), key: randomUUID(), operationId: null }; await saveJson(this.path(id), command); }
      return this.dispatch(command);
    }).catch(error => { if (error instanceof Error) Object.assign(error, { commandHandle: id }); throw error; });
  }
  async reconcile(id: string) {
    await this.ready;
    return controller(this.lock(id), id, async () => {
      const command = await readJson<Command>(this.path(id));
      if (command.schemaVersion !== 1 || command.id !== id) fail('INVALID_REQUEST', 'Command ownership is invalid');
      if (command.operationId) return this.client.operations.get(command.operationId);
      return this.dispatch(command);
    });
  }
  async recover(id: string) {
    await this.ready; await this.request('GET', '/v1/workspaces?limit=1');
    let command: Command | undefined;
    try { command = await readJson<Command>(this.path(id)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (command !== undefined && (!command || command.schemaVersion !== 1 || command.id !== id)) fail('INVALID_REQUEST', 'Command ownership is invalid');
    // Every administration request is journaled before dispatch. Recovery never discards a journal or retries HTTP.
    await recoverController(this.lock(id), id); return { commandHandle: id, controllerRecovered: true, ...(command === undefined ? { initializationIncomplete: true } : {}) };
  }
}
