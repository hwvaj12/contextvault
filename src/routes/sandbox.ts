import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { checkoutSandbox, getSandboxStatus, commitSandbox, destroySandbox } from '../services/sandbox.service';
import { commandKey, identity, workspaceScope } from '../compat/context';

export async function sandboxRoutes(app: FastifyInstance) {
  const context = (request: FastifyRequest) => ({ runtime: app.contextVault, principal: identity(request), scope: workspaceScope(request), key: commandKey(request) });
  app.post('/workspaces/:id/sandbox', async (request, reply) => { const ctx = context(request); return reply.code(201).header('Idempotency-Key', ctx.key).send(await checkoutSandbox(ctx)); });
  app.get('/workspaces/:id/sandbox', async request => getSandboxStatus(context(request)));
  app.post('/workspaces/:id/sandbox/commit', async (request, reply) => {
    const body = z.object({ writersStopped: z.literal(true), agentId: z.string().optional(), taskId: z.string().optional(), tags: z.array(z.string()).optional() }).parse(request.body);
    const ctx = context(request);
    try { return reply.code(201).header('Idempotency-Key', ctx.key).send(await commitSandbox(ctx, body)); }
    catch (error) { if ((error as { code?: string }).code === 'NO_CHANGES') return reply.code(400).send({ error: { code: 'NO_CHANGES', message: 'No changes to commit' } }); throw error; }
  });
  app.delete('/workspaces/:id/sandbox', async request => destroySandbox(context(request), z.object({ writersStopped: z.literal(true), abandon: z.boolean().optional() }).parse(request.body)));
}
