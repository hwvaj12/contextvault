import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WorkspaceError } from '../domain';
import { commandKey, customerScope, identity, workspaceScope } from '../compat/context';
import { deleteWorkspace, legacyWorkspace, listWorkspaceMetadata, workspaceMetadata } from '../application/workspaces/admin/metadata';
import { operationView } from './v1/views';
import { hash } from '../compat/journal';
export async function workspaceRoutes(app: FastifyInstance) {
  const runtime = app.contextVault;
  app.post('/workspaces', async (request, reply) => {
    const body = z.object({ customerId: z.string().min(1).max(255), name: z.string().min(1).max(255) }).strict().parse(request.body); const customer = customerScope(request);
    if (body.customerId !== customer.customerId) throw new WorkspaceError('FORBIDDEN', 'Customer differs from authenticated scope');
    const key = commandKey(request); const result = await runtime.lifecycle.createWorkspace({ principal: identity(request), idempotencyKey: key, request: body });
    return reply.code(result.status === 'accepted' ? 201 : 202).header('Idempotency-Key', key).send(result.status === 'accepted' ? legacyWorkspace(result.workspace) : operationView(result.operation));
  });
  app.get('/workspaces', async request => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0), customerId: z.string().optional() }).parse(request.query); const scope = customerScope(request);
    if (q.customerId && q.customerId !== scope.customerId) throw new WorkspaceError('FORBIDDEN', 'Customer selection differs from authenticated scope');
    const result = await listWorkspaceMetadata(runtime, identity(request), scope, q.offset, q.limit);
    return { data: result.workspaces.map(legacyWorkspace), pagination: { total: result.total, limit: q.limit, offset: q.offset, hasMore: q.offset + result.workspaces.length < result.total } };
  });
  app.get('/workspaces/:id', async request => legacyWorkspace(await workspaceMetadata(runtime, identity(request), workspaceScope(request))));
  app.delete('/workspaces/:id', async (request, reply) => { await deleteWorkspace(runtime, identity(request), workspaceScope(request), commandKey(request)); return reply.code(204).send(); });
  app.post('/workspaces/bulk-delete', async request => {
    const body = z.object({ workspaceIds: z.array(z.string().min(1).max(255)).min(1).max(100) }).strict().parse(request.body); const scope = customerScope(request); const key = commandKey(request); let deleted = 0; const failed = [];
    for (const id of body.workspaceIds) {
      try { await deleteWorkspace(runtime, identity(request), { ...scope, workspaceId: id as any }, hash([key, id])); deleted++; }
      catch { failed.push({ id, error: 'Workspace deletion was not authorized or could not complete' }); }
    }
    return { deleted, failed };
  });
}
