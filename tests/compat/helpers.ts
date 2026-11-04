import { expect } from 'vitest';
// @ts-ignore shared normal-server controller
import { startWorkspaceServer } from '../helpers/workspace-server.mjs';
export const backend = process.env.CV_TEST_BACKEND ?? 'git';
export async function fixture() { return startWorkspaceServer({ backend }); }
export async function call(client: any, path: string, method = 'GET', body?: any, key = client.keyA, idempotencyKey?: string) {
  const response = await fetch(client.baseUrl + path, { method, headers: { 'X-API-Key': key, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
export async function workspace(c: any) { const r = await call(c, '/v1/workspaces', 'POST', { customerId: c.customerA, name: 'compat' }, c.keyA, crypto.randomUUID()); expect(r.status).toBe(201); return r.body; }
export async function push(c: any, id: string, files: any[], key = crypto.randomUUID()) { return call(c, `/workspaces/${id}/push`, 'POST', { files, metadata: { agentId: 'legacy-agent', taskId: 'task', tags: ['checkpoint'] } }, c.keyA, key); }
