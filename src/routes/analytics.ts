import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { customerScope, identity } from '../compat/context';
import { workspaceUsage } from '../application/workspaces/admin/usage';
export async function analyticsRoutes(app: FastifyInstance) {
  app.get('/analytics/usage', { schema: { description: 'Recorded catalog actions and logical accepted-head bytes in an explicit customer scope', tags: ['Analytics'] } }, async request => {
    const query = z.object({ period: z.enum(['24h', '7d', '30d']).default('7d') }).strict().parse(request.query);
    return workspaceUsage(app.contextVault, identity(request), customerScope(request), query.period);
  });
}
