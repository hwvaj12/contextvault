import type { FastifyInstance, FastifyRequest, FastifySchema } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { WorkspaceError, type CustomerId } from '../../domain';
import { commandKey, customerScope, identity, workspaceScope } from '../../compat/context';
import { bundleId, bundleMetadata } from '../../application/workspaces/admin/bundles';
import { copyWorkspace, destinationPrincipal, legacyCopy } from '../../application/workspaces/admin/copy';
import { deleteWorkspace, listWorkspaceMetadata, workspaceMetadata } from '../../application/workspaces/admin/metadata';
import { operationView, workspaceView } from './views';

const text = z.string().min(1).max(255); const selectedId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/);
const importSchema = z.object({ bundlePath: text, customerId: text.optional(), name: text.optional(), targetWorkspaceId: selectedId.optional(), skipHashVerification: z.boolean().optional() }).strict();
const cloneSchema = z.object({ targetCustomerId: text, name: text.optional(), targetWorkspaceId: selectedId.optional() }).strict();
const empty = z.object({}).strict();
const exportSchema = z.object({ revisionId: text.optional() }).strict();
const deleteSchema = z.object({ expectedWorkspaceVersion: z.number().int().positive().optional(), reason: z.string().min(1).max(4096).default('caller requested deletion') }).strict();
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(50), offset: z.coerce.number().int().min(0).default(0) }).strict();
const bundleMediaType = 'application/vnd.contextvault.bundle';
const key = (request: FastifyRequest) => z.string().min(1).max(256).parse(request.headers['idempotency-key']);

/** Documentation-only schemas preserve the bounded binary parser used by normal HTTP uploads. */
export function documentAdminSchema(schema: FastifySchema, url: string, methods: string | string[]): FastifySchema {
  const method = Array.isArray(methods) ? methods[0] : methods;
  const bodies: Record<string, z.ZodType> = { 'POST /v1/workspaces/:id/clone': cloneSchema, 'POST /v1/workspaces/import': importSchema, 'POST /v1/workspaces/:id/export': exportSchema, 'POST /v1/bundles': empty, 'DELETE /v1/workspaces/:id': deleteSchema,
    'POST /workspaces/:id/clone': cloneSchema, 'POST /workspaces/import': importSchema, 'POST /workspaces/:id/export': exportSchema };
  const body = bodies[`${method} ${url}`]; const bundle = url === '/v1/bundles/:bid'; const list = method === 'GET' && url === '/v1/workspaces';
  if (!body && !bundle && !list) return schema;
  const result = { ...schema, tags: ['Workspace administration'] };
  const json = (value: z.ZodType) => { const { $schema, ...body } = z.toJSONSchema(value, { target: 'draft-7', io: 'input' }); return body; };
  if (body) result.body = json(body);
  if (list) result.querystring = json(listQuery);
  if (method === 'DELETE') result.headers = { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 256 } } };
  if (bundle && method === 'PUT') { result.body = { type: 'string', format: 'binary' }; result.consumes = [bundleMediaType]; result.description = 'Upload the length-prefixed signed manifest and exact file bytes in the request body. Create the customer-scoped opaque bundle handle first.'; }
  if (bundle && method === 'GET') { result.response = { 200: { type: 'string', format: 'binary' } }; result.produces = [bundleMediaType]; }
  return result;
}
export async function cloneRequest(app: FastifyInstance, request: FastifyRequest) {
  const runtime = app.contextVault; const scope = workspaceScope(request); const body = cloneSchema.parse(request.body); const principal = identity(request);
  const destination = await destinationPrincipal(runtime, principal, scope, body.targetCustomerId);
  const workspace = await workspaceMetadata(runtime, principal, scope); const revision = await runtime.control.getRevision(scope, workspace.currentRevisionId);
  if (!revision) throw new WorkspaceError('REVISION_NOT_FOUND', 'Clone source is unavailable');
  const binding = await runtime.control.getBinding(scope, revision.scope.storageBindingId); if (!binding) throw new WorkspaceError('STORAGE_BINDING_CHANGED', 'Clone source binding is unavailable');
  return copyWorkspace(runtime, { kind: 'clone', principal, destination, sourceScope: scope, targetCustomerId: body.targetCustomerId as CustomerId, key: request.url.startsWith('/v1/') ? key(request) : commandKey(request), request: body, name: body.name ?? (workspace.name.length <= 247 ? `${workspace.name} (clone)` : 'Cloned workspace'), targetWorkspaceId: body.targetWorkspaceId,
    source: async () => ({ kind: 'revision', revision, binding, principal }) });
}
export async function importRequest(app: FastifyInstance, request: FastifyRequest) {
  const runtime = app.contextVault; const scope = customerScope(request); const principal = identity(request); const body = importSchema.parse(request.body);
  if (body.skipHashVerification) throw new WorkspaceError('INVALID_REQUEST', 'Bundle hash verification cannot be disabled');
  bundleId(body.bundlePath); const targetCustomerId = body.customerId ?? scope.customerId;
  // Bundle handles are scoped to the authenticated source customer, never interpreted as paths.
  const bundle = await runtime.bundles.get(scope, principal, body.bundlePath); if (bundle.state !== 'ready') throw new WorkspaceError('INVALID_TRANSITION', 'Bundle is incomplete');
  const destination = await destinationPrincipal(runtime, principal, scope, targetCustomerId);
  if (targetCustomerId !== scope.customerId) throw new WorkspaceError('FORBIDDEN', 'Import handles require the destination customer scope');
  const value = await copyWorkspace(runtime, { kind: 'import', principal, destination, sourceScope: { ...scope, workspaceId: 'bundle-import' as any }, targetCustomerId: targetCustomerId as CustomerId, key: request.url.startsWith('/v1/') ? key(request) : commandKey(request), request: body, name: body.name ?? 'Imported workspace', targetWorkspaceId: body.targetWorkspaceId, source: async () => ({ kind: 'bundle', bundle }) });
  return { ...value, manifest: bundle.header, fileCount: bundle.header!.files.length, verified: !value.operation || value.operation.state === 'succeeded' };
}
export async function adminRoutes(app: FastifyInstance) {
  const runtime = app.contextVault;
  app.addContentTypeParser(bundleMediaType, (_request, payload, done) => done(null, payload));
  app.get('/workspaces', async request => { const q = listQuery.parse(request.query); const result = await listWorkspaceMetadata(runtime, identity(request), customerScope(request), q.offset, q.limit); return { workspaces: result.workspaces.map(workspaceView), total: result.total, offset: q.offset, limit: q.limit }; });
  app.delete('/workspaces/:id', async (request, reply) => { const q = deleteSchema.parse(request.body ?? {}); await deleteWorkspace(runtime, identity(request), workspaceScope(request), key(request), q.expectedWorkspaceVersion, q.reason); return reply.code(204).send(); });
  app.post('/workspaces/:id/clone', async (request, reply) => { const result = await cloneRequest(app, request); return result.operation && result.operation.state !== 'succeeded' ? reply.code(202).send(operationView(result.operation)) : reply.code(201).send(workspaceView(result.workspace)); });
  app.post('/workspaces/import', async (request, reply) => { const result = await importRequest(app, request); return result.operation && result.operation.state !== 'succeeded' ? reply.code(202).send(operationView(result.operation)) : reply.code(201).send({ workspaceId: result.workspace.id, manifest: result.manifest, fileCount: result.fileCount, verified: result.verified }); });
  app.post('/workspaces/:id/export', async (request, reply) => { const body = exportSchema.parse(request.body ?? {}); const bundle = await runtime.bundles.export(runtime, identity(request), workspaceScope(request), key(request), body.revisionId); return reply.code(201).send(bundleMetadata(bundle)); });
  app.post('/bundles', async (request, reply) => { empty.parse(request.body); return reply.code(201).send(bundleMetadata(await runtime.bundles.createUpload(identity(request), customerScope(request), key(request)))); });
  app.get('/bundles/:bid', async (request, reply) => { const bytes = await runtime.bundles.download(identity(request), customerScope(request), text.parse((request.params as any).bid)); return reply.type(bundleMediaType).send(Readable.from(bytes, { objectMode: false })); });
  app.put('/bundles/:bid', async request => { key(request); return bundleMetadata(await runtime.bundles.upload(identity(request), customerScope(request), text.parse((request.params as any).bid), request.body as any)); });
}
export async function legacyAdminRoutes(app: FastifyInstance) {
  const runtime = app.contextVault;
  app.post('/workspaces/:id/clone', async (request, reply) => { const result = await cloneRequest(app, request); return result.operation && result.operation.state !== 'succeeded' ? reply.code(202).send(operationView(result.operation)) : reply.code(201).send(legacyCopy(result)); });
  app.post('/workspaces/:id/export', async (request, reply) => { const body = exportSchema.parse(request.body ?? {}); return reply.code(201).send(bundleMetadata(await runtime.bundles.export(runtime, identity(request), workspaceScope(request), commandKey(request), body.revisionId))); });
  app.post('/workspaces/import', async (request, reply) => { const result = await importRequest(app, request); return result.operation && result.operation.state !== 'succeeded' ? reply.code(202).send(operationView(result.operation)) : reply.code(201).send({ workspaceId: result.workspace.id, manifest: result.manifest, fileCount: result.fileCount, verified: result.verified }); });
}
