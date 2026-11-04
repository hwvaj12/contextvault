import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { it, expect } from 'vitest';
import { fixture, workspace, push, call } from './helpers';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(description: string, condition: (remainingMs: number) => boolean | Promise<boolean>) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await condition(Math.max(1, deadline - Date.now()))) return;
    await pause(Math.min(25, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
it('derives legacy notifications from accepted outcomes, retries stable identities, and freezes tenant recipients', async () => {
  const received: { raw: string; event: any; headers: any; url: string; status: number }[] = []; let failCommit = true;
  const sink = createServer(async (request, reply) => { const chunks = []; for await (const chunk of request) chunks.push(chunk); const raw = Buffer.concat(chunks).toString(); const event = JSON.parse(raw); const status = event.event === 'commit.created' && failCommit ? 503 : 204; received.push({ raw, event, headers: request.headers, url: request.url!, status }); reply.statusCode = status; reply.end(); });
  await new Promise<void>(resolve => sink.listen(0, '127.0.0.1', resolve)); const port = (sink.address() as any).port; const server = await fixture();
  try {
    const c = server.client; const w = await workspace(c); const secret = 'legacy-signing-secret';
    expect((await call(c, '/webhooks', 'POST', { customerId: c.customerA, url: `http://127.0.0.1:${port}/a`, events: ['run.finalized', 'run.completed', 'commit.created'], secret })).status).toBe(201);
    expect((await call(c, '/webhooks', 'POST', { customerId: c.customerB, url: `http://127.0.0.1:${port}/b`, events: ['run.completed', 'commit.created'], secret }, c.keyB)).status).toBe(201);
    const deliveries = (operationId: string, type: string) => received.filter(r => r.event.payload.operationId === operationId && r.event.event === type);
    const succeeded = (operationId: string, type: string, url = '/a') => deliveries(operationId, type).some(r => r.url === url && r.status === 204);
    const published = await push(c, w.id, [{ path: 'accepted.txt', content: 'accepted' }]); expect(published.status).toBe(201);
    const publishedOperationId = published.body.operation.id;
    await waitFor('the initial accepted representations and failed commit delivery', () =>
      succeeded(publishedOperationId, 'run.finalized') && succeeded(publishedOperationId, 'run.completed') &&
      deliveries(publishedOperationId, 'commit.created').some(r => r.url === '/a' && r.status === 503));
    const first = deliveries(publishedOperationId, 'commit.created')[0];
    expect(first.event.payload.commitId).toBe(published.body.commitId); expect(first.event.payload.workspaceId).toBe(w.id);
    expect(deliveries(publishedOperationId, 'run.completed')[0].event.payload.agentId).toBe('legacy-agent');
    expect((await call(c, '/webhooks', 'POST', { customerId: c.customerA, url: `http://127.0.0.1:${port}/late`, events: ['commit.created'], secret })).status).toBe(201);
    failCommit = false;
    await waitFor('a successful retry of the original commit delivery', () => succeeded(publishedOperationId, 'commit.created'));
    const unchanged = await push(c, w.id, [{ path: 'accepted.txt', content: 'accepted' }]); expect(unchanged.status).toBe(201);
    expect(unchanged.body.outcome.changed).toBe(false); expect(unchanged.body.commitId).toBe(published.body.commitId);
    const unchangedOperationId = unchanged.body.operation.id; expect(unchangedOperationId).not.toBe(publishedOperationId);
    await waitFor('the unchanged legacy push representations for both frozen recipients', () =>
      succeeded(unchangedOperationId, 'run.finalized') && succeeded(unchangedOperationId, 'run.completed') &&
      succeeded(unchangedOperationId, 'commit.created') && succeeded(unchangedOperationId, 'commit.created', '/late'));
    const canonicalRun = await call(c, `/v1/workspaces/${w.id}/runs`, 'POST', { mode: 'read-write', agentLabel: 'v1-agent', task: 'unchanged', reason: 'canonical unchanged snapshot' }, c.keyA, 'canonical-open');
    const submission = await call(c, `/v1/runs/${canonicalRun.body.id}/submissions`, 'POST', {}, c.keyA, 'canonical-begin');
    const bytes = Buffer.from('accepted'); const sha256 = createHash('sha256').update(bytes).digest('hex');
    const uploaded = await fetch(`${c.baseUrl}/v1/runs/${canonicalRun.body.id}/submissions/${submission.body.id}/files?path=accepted.txt`, { method: 'PUT', headers: { 'X-API-Key': c.keyA, 'Content-Type': 'application/octet-stream', 'Idempotency-Key': 'canonical-file', 'X-Content-SHA256': sha256 }, body: bytes });
    expect(uploaded.status).toBe(201); const receipt: any = await uploaded.json();
    expect((await call(c, `/v1/runs/${canonicalRun.body.id}/submissions/${submission.body.id}/seal`, 'POST', { manifest: { schemaVersion: 1, entries: [{ path: 'accepted.txt', kind: 'file', byteLength: bytes.length, sha256 }] }, receipts: [{ path: 'accepted.txt', receiptId: receipt.id }] }, c.keyA, 'canonical-seal')).status).toBe(200);
    const finalized = await call(c, `/v1/runs/${canonicalRun.body.id}/finalize`, 'POST', { expectedRunVersion: canonicalRun.body.version, submissionId: submission.body.id }, c.keyA, 'canonical-finalize'); expect(finalized.status).toBe(202);
    let outcome: any;
    await waitFor('the canonical finalize outcome', async remainingMs => {
      const response = await fetch(`${c.baseUrl}/v1/operations/${finalized.body.id}`, { headers: { 'X-API-Key': c.keyA }, signal: AbortSignal.timeout(remainingMs) });
      expect(response.status).toBe(200); outcome = await response.json(); expect(outcome.state).not.toBe('failed'); return outcome.state === 'succeeded';
    });
    expect(outcome.result.changed).toBe(false);
    await waitFor('the canonical unchanged lifecycle representations', () =>
      succeeded(finalized.body.id, 'run.finalized') && succeeded(finalized.body.id, 'run.completed'));
    // Graceful shutdown drains the active maintenance cycle before absence assertions.
    await server.stop();
    const retries = deliveries(publishedOperationId, 'commit.created'); expect(retries.length).toBeGreaterThanOrEqual(2);
    for (const retry of retries) { expect(retry.headers['x-contextvault-event-id']).toBe(first.headers['x-contextvault-event-id']); expect(retry.raw).toBe(first.raw); }
    expect(deliveries(publishedOperationId, 'commit.created').some(r => r.url === '/late')).toBe(false);
    expect([...new Set(deliveries(unchangedOperationId, 'commit.created').map(r => r.url))].sort()).toEqual(['/a', '/late']);
    expect(deliveries(finalized.body.id, 'commit.created')).toEqual([]);
    expect(received.some(r => r.url === '/b')).toBe(false);
    for (const r of received) {
      expect(r.headers['x-contextvault-event-id']).toBe(r.event.payload.eventId);
      expect(r.headers['x-contextvault-signature']).toBe(createHmac('sha256', createHash('sha256').update(secret).digest('hex')).update(r.raw).digest('hex'));
    }
  } finally { await server.dispose(); await new Promise<void>((resolve, reject) => sink.close(error => error ? reject(error) : resolve())); }
});
