import type { FastifyInstance, FastifySchema } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { identity, workspaceScope } from '../../compat/context';
import { acceptedRevision, diff, history, revisionFile, search } from '../../application/revisions/read';
import { operationView } from './views';
import { StreamLimiter } from '../../application/files';
const id = z.string().min(1).max(255);
const historyQuery = z.object({ cursor: id.optional(), limit: z.coerce.number().int().min(1).max(1000).default(50) });
const fileQuery = z.object({ path: z.string() }).strict();
const diffQuery = z.object({ from: id, to: id }).strict();
const searchQuery = z.object({ q: z.string().min(1).max(255), revisionId: id.optional(), limit: z.coerce.number().int().min(1).max(1000).default(100) }).strict();
const restoreSchema = z.object({ revisionId: id, expectedRevisionId: id, expectedWorkspaceVersion: z.number().int().positive(), reason: z.string().min(1).max(4096) }).strict();

/** Convert the same handler schemas for documentation without validating streams as JSON. */
export function documentRevisionSchema(schema: FastifySchema, url: string, methods: string | string[]): FastifySchema {
  const method = Array.isArray(methods) ? methods[0] : methods;
  const queries: Record<string, z.ZodType> = { 'GET /v1/workspaces/:id/revisions': historyQuery, 'GET /v1/workspaces/:id/revisions/:rid/files': fileQuery, 'GET /v1/workspaces/:id/diff': diffQuery, 'GET /v1/workspaces/:id/search': searchQuery };
  const query = queries[`${method} ${url}`]; const restore = method === 'POST' && url === '/v1/workspaces/:id/restore';
  if (!query && !restore && url !== '/v1/workspaces/:id/revisions/:rid/manifest') return schema;
  const result = { ...schema, tags: ['Accepted revisions'] };
  const json = (value: z.ZodType) => { const { $schema, ...body } = z.toJSONSchema(value, { target: 'draft-7', io: 'input' }); return body; };
  if (query) result.querystring = json(query);
  if (restore) result.body = json(restoreSchema);
  return result;
}
export async function revisionRoutes(app: FastifyInstance) {
  const runtime = app.contextVault;
  const downloads = new StreamLimiter(runtime.configuration.limits.maxConcurrentStreams);
  app.get('/workspaces/:id/revisions', async request => { const q = historyQuery.parse(request.query); return history(runtime, identity(request), workspaceScope(request), q.cursor, q.limit); });
  app.get('/workspaces/:id/revisions/:rid/manifest', async request => (await acceptedRevision(runtime, identity(request), workspaceScope(request), id.parse((request.params as any).rid))).manifest);
  app.get('/workspaces/:id/revisions/:rid/files', async (request, reply) => {
    const q = fileQuery.parse(request.query); const abort = new AbortController(); let release = () => {}; const close = () => { if (!reply.raw.writableFinished) abort.abort(); }; reply.raw.once('close', close);
    try { release = await downloads.acquire(abort.signal); const source = await revisionFile(runtime, identity(request), workspaceScope(request), id.parse((request.params as any).rid), q.path, abort.signal); const stream = Readable.from(source.bytes, { objectMode: false }); stream.once('close', () => { release(); reply.raw.removeListener('close', close); }); return reply.type('application/octet-stream').header('Content-Length', source.entry.byteLength).header('X-Content-SHA256', source.entry.sha256).send(stream); }
    catch (error) { release(); reply.raw.removeListener('close', close); throw error; }
  });
  app.get('/workspaces/:id/diff', async request => { const q = diffQuery.parse(request.query); return diff(runtime, identity(request), workspaceScope(request), q.from, q.to); });
  app.get('/workspaces/:id/search', async request => { const q = searchQuery.parse(request.query); return search(runtime, identity(request), workspaceScope(request), q.q, q.revisionId, q.limit); });
  app.post('/workspaces/:id/restore', async (request, reply) => {
    const body = restoreSchema.parse(request.body);
    const claimed = await runtime.restore.claim({ principal: identity(request), scope: workspaceScope(request), idempotencyKey: z.string().min(1).max(256).parse(request.headers['idempotency-key']), request: body }); runtime.schedule(claimed.operation, claimed.replayed);
    return reply.code(202).send(operationView(claimed.operation));
  });
}
