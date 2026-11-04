import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createAuthMiddleware } from '../middleware/auth';
import { authorizedWorkspace, identity } from '../compat/context';
import { gitProjection } from '../compat/git-projection';
import { WorkspaceError } from '../domain';

export async function gitRemoteRoutes(app: FastifyInstance) {
  const runtime = app.contextVault;
  app.addHook('onRequest', createAuthMiddleware({ database: runtime.database, masterKey: runtime.configuration.masterKey, now: runtime.now }));
  for (const contentType of ['application/x-git-upload-pack-request', 'application/x-git-receive-pack-request']) app.addContentTypeParser(contentType, { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  const authorized = async (request: FastifyRequest) => {
    const { scope, workspace } = await authorizedWorkspace(runtime, request, 'workspace:read');
    const binding = await runtime.control.getBinding(scope, workspace.storageBindingId);
    if (binding?.backend !== 'git') throw new WorkspaceError('UNSUPPORTED_CAPABILITY', 'Git wire protocol is unavailable for this workspace backend');
    return scope;
  };
  app.get('/repos/:id/info/refs', async (request, reply) => {
    const scope = await authorized(request); const service = (request.query as { service?: string }).service;
    if (service === 'git-receive-pack') throw new WorkspaceError('FORBIDDEN', 'Canonical Git push is disabled; submit through an authorized run');
    if (service !== 'git-upload-pack') throw new WorkspaceError('INVALID_REQUEST', 'git-upload-pack service is required');
    const body = await gitProjection(runtime, identity(request), scope, async (_directory, git) => git(['upload-pack', '--stateless-rpc', '--advertise-refs', '.']));
    const line = '# service=git-upload-pack\n'; const header = Buffer.from((Buffer.byteLength(line) + 4).toString(16).padStart(4, '0') + line + '0000');
    return reply.type('application/x-git-upload-pack-advertisement').header('Cache-Control', 'no-store').send(Buffer.concat([header, body]));
  });
  app.post('/repos/:id/git-upload-pack', async (request, reply) => {
    const scope = await authorized(request);
    if (!Buffer.isBuffer(request.body)) throw new WorkspaceError('INVALID_REQUEST', 'Git request body is required');
    const body = await gitProjection(runtime, identity(request), scope, async (_directory, git) => git(['upload-pack', '--stateless-rpc', '.'], request.body as Buffer));
    return reply.type('application/x-git-upload-pack-result').header('Cache-Control', 'no-store').send(body);
  });
  app.post('/repos/:id/git-receive-pack', async request => { await authorized(request); throw new WorkspaceError('FORBIDDEN', 'Canonical Git push is disabled; submit through an authorized run'); });
}
