import { createServer } from 'node:http';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { faultFixture } from '../compat/fault-fixture';
import { call } from '../compat/helpers';

it('delivers signed workspace creation and deletion only to the current customer', async () => {
  const received: {path: string; raw: string; headers: any; event: any}[] = [];
  const sink = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    received.push({path: request.url!, raw, headers: request.headers, event: JSON.parse(raw)});
    response.writeHead(204); response.end();
  });
  await new Promise<void>((resolve, reject) => { sink.once('error', reject); sink.listen(0, '127.0.0.1', resolve); });
  let fixture: Awaited<ReturnType<typeof faultFixture>> | undefined;
  try {
    fixture = await faultFixture();
    const {client: c, app} = fixture;
    const secret = 'public-lifecycle-fixture-secret';
    const url = `http://127.0.0.1:${(sink.address() as {port: number}).port}`;
    const registration = (customerId: string, path: string) => ({customerId, url: url + path, events: ['workspace.created', 'workspace.deleted'], secret});
    const own = await call(c, '/webhooks', 'POST', registration(c.customerA, '/a'));
    expect(own.status).toBe(201);
    expect((await call(c, '/webhooks', 'POST', registration(c.customerB, '/b'), c.keyB)).status).toBe(201);
    expect((await call(c, '/webhooks?customerId=' + c.customerA)).body.data).toHaveLength(1);
    const created = await call(c, '/workspaces', 'POST', {customerId: c.customerA, name: 'public webhook lifecycle'}, c.keyA, randomUUID());
    expect(created.status).toBe(201);
    const creationMaintenance = await app.contextVault.maintenance.runOnce();
    expect(creationMaintenance.errors, JSON.stringify(creationMaintenance.errors)).toEqual([]);
    const deleted = await fetch(c.baseUrl + '/workspaces/' + created.body.id, {method: 'DELETE', headers: {'X-API-Key': c.keyA, 'Idempotency-Key': randomUUID()}});
    expect(deleted.status).toBe(204);
    const deletionMaintenance = await app.contextVault.maintenance.runOnce();
    expect(deletionMaintenance.errors, JSON.stringify(deletionMaintenance.errors)).toEqual([]);
    expect(received.map(item => item.event.event).sort()).toEqual(['workspace.created', 'workspace.deleted']);
    for (const item of received) {
      expect(item.path).toBe('/a');
      expect(item.event.payload.workspaceId).toBe(created.body.id);
      expect(item.headers['x-contextvault-event-id']).toBe(item.event.payload.eventId);
      expect(item.headers['x-contextvault-signature']).toBe(createHmac('sha256', createHash('sha256').update(secret).digest('hex')).update(item.raw).digest('hex'));
    }
    const removed = await fetch(c.baseUrl + '/webhooks/' + own.body.id, {method: 'DELETE', headers: {'X-API-Key': c.keyA}});
    expect(removed.status).toBe(204);
    expect((await call(c, '/webhooks?customerId=' + c.customerA)).body.data).toHaveLength(0);
    expect((await call(c, '/webhooks?customerId=' + c.customerB, 'GET', undefined, c.keyB)).body.data).toHaveLength(1);
  } finally {
    await fixture?.dispose(); sink.closeAllConnections();
    await new Promise<void>((resolve, reject) => sink.close(error => error ? reject(error) : resolve()));
  }
}, 60000);
