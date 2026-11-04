import { createServer } from 'node:http';
import { it, expect } from 'vitest';
import { faultFixture } from './fault-fixture';
import { workspace, call, push } from './helpers';
it('retains an already frozen pre-compatibility recipient snapshot without adding representations', async () => {
  const received: any[] = []; const sink = createServer(async (request, reply) => { const chunks = []; for await (const chunk of request) chunks.push(chunk); received.push(JSON.parse(Buffer.concat(chunks).toString())); reply.statusCode = 204; reply.end(); });
  await new Promise<void>(resolve => sink.listen(0, '127.0.0.1', resolve)); const server = await faultFixture();
  try {
    const c = server.client; const w = await workspace(c);
    expect((await call(c, '/webhooks', 'POST', { customerId: c.customerA, url: `http://127.0.0.1:${(sink.address() as any).port}`, events: ['run.finalized', 'run.completed', 'commit.created'] })).status).toBe(201);
    const published = await push(c, w.id, [{ path: 'accepted.txt', content: 'accepted' }]); expect(published.status, JSON.stringify(published.body)).toBe(201);
    const runtime = server.app.contextVault; const scope = { customerId: c.customerA, workspaceId: w.id };
    const event = (await runtime.control.listPendingOutbox({ now: runtime.now(), limit: 100 })).find(event => event.type === 'run.finalized')!;
    const subscriptions = await runtime.control.listSubscriptions({ customerId: c.customerA }, 'run.finalized');
    // This retained fixture uses CV-17's original frozen snapshot format. Runtime delivery must not expand it.
    runtime.database.prepare("INSERT INTO catalog_records(kind,id,customer_id,workspace_id,run_id,data) VALUES('outbox-recipients',?,?,?,?,?)").run(event.id, c.customerA, w.id, event.runId, JSON.stringify({ subscriptions }));
    await runtime.maintenance.runOnce();
    expect(received.map(event => event.event)).toEqual(['run.finalized']); expect(received[0].payload.eventId).toBe(event.id);
    expect(await runtime.control.listOutboxRecipients(scope, event.id)).toEqual(subscriptions);
  } finally { await server.dispose(); await new Promise<void>((resolve, reject) => sink.close(error => error ? reject(error) : resolve())); }
});
