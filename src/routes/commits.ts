import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authorizedWorkspace, commandKey, identity } from '../compat/context';
import { acceptedReference, acceptedSnapshot, publishSnapshot, snapshot } from '../compat/publication';

const filesSchema = z.array(z.object({ path: z.string().min(1), content: z.string(), encoding: z.enum(['utf8', 'base64']).optional() }).strict());
export async function commitRoutes(app: FastifyInstance) {
  const runtime = app.contextVault;
  app.post('/workspaces/:id/push', async (request, reply) => {
    const { scope } = await authorizedWorkspace(runtime, request, 'workspace:write');
    const body = z.object({ files: filesSchema, metadata: z.record(z.string(), z.unknown()).default({}) }).parse(request.body);
    const key = commandKey(request);
    const { run, ...result } = await publishSnapshot(runtime, { kind: 'push', scope, principal: identity(request), key, request: body, agentLabel: typeof body.metadata.agentId === 'string' ? body.metadata.agentId : undefined, source: async () => snapshot(runtime, body.files) });
    return reply.code(201).header('Idempotency-Key', key).send({ ...result, metadata: body.metadata });
  });
  app.post('/workspaces/:id/rollback', async (request, reply) => {
    const { scope } = await authorizedWorkspace(runtime, request, 'workspace:restore');
    const body = z.object({ toVersion: z.string().min(1) }).parse(request.body); const key = commandKey(request);
    const { run, ...result } = await publishSnapshot(runtime, { kind: 'rollback', scope, principal: identity(request), key, request: body, source: () => acceptedReference(runtime, identity(request), scope, body.toVersion) });
    return reply.code(201).header('Idempotency-Key', key).send({ ...result, rolledBackTo: body.toVersion });
  });
  app.get('/workspaces/:id/pull', async request => {
    const { scope } = await authorizedWorkspace(runtime, request, 'workspace:read');
    const query = z.object({ version: z.string().optional(), v: z.string().optional() }).parse(request.query);
    const value = await acceptedSnapshot(runtime, identity(request), scope, query.version ?? query.v);
    return { commitId: value.revision.id, workspaceId: scope.workspaceId, parentId: value.revision.parentRevisionId, files: value.files.map(file => {
      const bytes = Buffer.from(file.base64, 'base64'); const content = bytes.toString('utf8');
      return Buffer.from(content, 'utf8').equals(bytes) ? { path: file.path, content } : { path: file.path, content: file.base64, encoding: 'base64' };
    }), metadata: {}, sizeBytes: value.manifest.entries.reduce((size, entry) => size + (entry.kind === 'file' ? entry.byteLength : 0), 0), createdAt: value.revision.createdAt };
  });
  // Accepted history reads share catalog scope. Administration and bundles remain CV-24.
  app.get('/workspaces/:id/history', async request => {
    const { scope } = await authorizedWorkspace(runtime, request, 'workspace:read');
    const query = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).default(20) }).parse(request.query);
    const page = await runtime.control.listRevisions(scope, query.cursor, query.limit);
    return { commits: page.revisions.map(r => ({ id: r.id, commitId: r.id, workspaceId: scope.workspaceId, parentId: r.parentRevisionId, createdAt: r.createdAt })), count: page.revisions.length, nextCursor: page.nextCursor };
  });
  app.get('/workspaces/:id/diff', async request => {
    const { scope } = await authorizedWorkspace(runtime, request, 'workspace:read'); const query = z.object({ from: z.string(), to: z.string() }).parse(request.query);
    const a = await acceptedSnapshot(runtime, identity(request), scope, query.from); const b = await acceptedSnapshot(runtime, identity(request), scope, query.to);
    const entries = new Map(a.manifest.entries.map(e => [e.path, e])); const next = new Map(b.manifest.entries.map(e => [e.path, e]));
    const files = [...new Set([...entries.keys(), ...next.keys()])].sort().filter(p => JSON.stringify(entries.get(p)) !== JSON.stringify(next.get(p))).map(path => ({ path, status: !entries.has(path) ? 'added' : !next.has(path) ? 'deleted' : 'modified' }));
    return { ...query, files, summary: { filesChanged: files.length } };
  });
  app.get('/workspaces/:id/search', async request => {
    const { scope } = await authorizedWorkspace(runtime, request, 'workspace:read'); const query = z.object({ q: z.string().min(1) }).parse(request.query);
    const value = await acceptedSnapshot(runtime, identity(request), scope);
    const results = value.files.flatMap(file => { const bytes = Buffer.from(file.base64, 'base64'); const content = bytes.toString('utf8'); return Buffer.from(content).equals(bytes) && content.includes(query.q) ? [{ path: file.path, matches: content.split('\n').flatMap((text, index) => text.includes(query.q) ? [{ line: index + 1, text }] : []) }] : []; });
    return { query: query.q, results, count: results.length };
  });
}
