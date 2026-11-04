import { createServer } from 'node:http';
import { it, expect } from 'vitest';
import { faultFixture } from './fault-fixture';
import { workspace, call, push } from './helpers';
import { WorkspaceError } from '../../src/domain';

it('delivers supported start and failure payloads from durable lifecycle state without aliasing conflicts', async () => {
  const received: any[] = []; const sink = createServer(async (request, reply) => { const chunks = []; for await (const chunk of request) chunks.push(chunk); received.push(JSON.parse(Buffer.concat(chunks).toString())); reply.statusCode = 204; reply.end(); });
  await new Promise<void>(resolve => sink.listen(0, '127.0.0.1', resolve));
  const server = await faultFixture({ lifecycle: { hook: async (stage, operation) => { if (stage === 'before-prepare' && operation.kind === 'finalize') throw new WorkspaceError('INVALID_REQUEST', 'Recorded failure reason'); } } });
  try {
    const c = server.client; const w = await workspace(c);
    expect((await call(c, '/webhooks', 'POST', { customerId: c.customerA, url: `http://127.0.0.1:${(sink.address() as any).port}`, events: ['run.started', 'run.failed', 'run.completed', 'commit.created'] })).status).toBe(201);
    const run = await call(c, `/workspaces/${w.id}/runs`, 'POST', { agentId: 'started-agent' }, c.keyA, 'start'); expect(run.status).toBe(201);
    expect((await call(c, `/workspaces/${w.id}/runs`, 'POST', { agentId: 'started-agent' }, c.keyA, 'start')).body.id).toBe(run.body.id);
    const failed = await push(c, w.id, [{ path: 'never-published', content: 'private' }]); expect(failed.status).toBe(400);
    await server.app.contextVault.maintenance.runOnce();
    expect(received.some(event => event.event === 'run.started' && event.payload.runId === run.body.id && event.payload.agentId === 'started-agent')).toBe(true);
    const failure = received.find(event => event.event === 'run.failed'); expect(failure).toBeTruthy(); expect(failure.payload.agentId).toBe('legacy-agent'); expect(failure.payload.reason).toBe('Recorded failure reason');
    expect(received.some(event => ['run.completed', 'commit.created'].includes(event.event))).toBe(false);
    const scope = { customerId: c.customerA, workspaceId: w.id };
    const events = await server.app.contextVault.control.listAudit(scope); expect(events.events.filter(event => event.type === 'run.failed')).toHaveLength(1); expect(events.events.filter(event => event.type === 'run.started')).toHaveLength(2);
  } finally { await server.dispose(); await new Promise<void>((resolve, reject) => sink.close(error => error ? reject(error) : resolve())); }
});
