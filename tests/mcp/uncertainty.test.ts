import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Protocol, canonicalWorkspace, fixture, root } from './protocol';

async function relay(origin: string) {
  let mode: 'open' | 'checkpoint' | 'create' | null = null; const events: { path: string; key: string | undefined; status: number; value: any }[] = []; const errors: unknown[] = [];
  const proxy = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !['host', 'connection', 'content-length', 'transfer-encoding', 'expect'].includes(name)));
      const upstream = await fetch(origin + request.url, { method: request.method, headers: headers as HeadersInit, ...(request.method === 'GET' ? {} : { body: Buffer.concat(chunks) }), redirect: 'manual' });
      const bytes = Buffer.from(await upstream.arrayBuffer()); let value; try { value = JSON.parse(bytes.toString()); } catch { value = null; }
      const path = request.url!; events.push({ path, key: request.headers['idempotency-key'] as string | undefined, status: upstream.status, value });
      if (mode === 'create' && request.method === 'POST' && path === '/v1/workspaces' && upstream.status === 201) { mode = null; response.writeHead(201, { 'content-type': 'application/json', 'content-length': '10000', connection: 'close' }); response.end('{"id":'); return; }
      if (mode === 'open' && request.method === 'POST' && /\/workspaces\/[^/]+\/runs$/.test(path) && upstream.status === 201) { mode = null; response.writeHead(201, { 'content-type': 'application/json', 'content-length': '10000', connection: 'close' }); response.end('{"id":'); return; }
      if (mode === 'checkpoint' && path.endsWith('/finalize') && upstream.status === 202) { mode = null; return; }
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'content-length': bytes.length, ...(upstream.headers.has('x-content-sha256') ? { 'x-content-sha256': upstream.headers.get('x-content-sha256')! } : {}) }); response.end(bytes);
    } catch (error) { errors.push(error); response.destroy(); }
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  return { origin: 'http://127.0.0.1:' + (proxy.address() as any).port, events, errors, arm(value: typeof mode) { mode = value; }, async close() { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); } };
}
async function until(check: () => boolean) { for (let index = 0; index < 1000; index++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Expected real accepted mutation was not observed'); }

it('reconciles lost administration responses with the same durable command key after an actual MCP restart', async () => {
  const f = await fixture(); const proxy = await relay(f.server.client.baseUrl); let peer: Protocol | undefined;
  const env = { CV_API_URL: proxy.origin, CV_API_KEY: f.server.client.keyA, CV_MCP_STATE_DIR: join(f.directory, 'private-state'), CV_MCP_REQUEST_TIMEOUT_MS: '1000' };
  try {
    peer = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: f.directory, env }).initialize();
    proxy.arm('create'); const created = await peer.tool('create_workspace', { customerId: f.server.client.customerA, name: 'Recover exact administration', requestId: 'lost-create' });
    expect(created.isError).toBe(true); expect(created.value.error.code).toBe('PUBLICATION_OUTCOME_UNKNOWN'); const commandHandle = created.value.error.commandHandle; expect(commandHandle).toMatch(/^command-[a-f0-9]{64}$/);
    await peer.close(); peer = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: f.directory, env }).initialize();
    const recovered = await peer.tool('reconcile_command', { commandHandle }); expect(recovered.isError).not.toBe(true);
    const requests = proxy.events.filter(event => event.path === '/v1/workspaces'); expect(requests).toHaveLength(2); expect(requests[0].key).toBe(requests[1].key); expect(requests[0].value.id).toBe(recovered.value.id); expect(requests[1].value.id).toBe(recovered.value.id);
    const listed = await peer.tool('list_workspaces'); expect(listed.value.map((value: any) => value.id)).toEqual([recovered.value.id]); expect(proxy.errors).toEqual([]);
  } finally { await peer?.close(); await proxy.close(); await f.dispose(); }
}, 60000);

it('reconciles an accepted lost initial checkout using the exact original run-open key', async () => {
  const f = await fixture(); const proxy = await relay(f.server.client.baseUrl); let peer: Protocol | undefined;
  try {
    const workspace = await canonicalWorkspace(f.server);
    peer = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: f.directory, env: { CV_API_URL: proxy.origin, CV_API_KEY: f.server.client.keyA, CV_MCP_STATE_DIR: join(f.directory, 'private-state'), CV_MCP_REQUEST_TIMEOUT_MS: '1000' } }).initialize();
    proxy.arm('open'); const opened = await peer.tool('checkout_workspace', { workspaceId: workspace.id, access: 'remote', requestId: 'lost-open' }); expect(opened.isError).toBe(true);
    const handle = opened.value.error.workspaceHandle; expect(handle).toMatch(/^session-/);
    const retry = await peer.tool('checkout_workspace', { workspaceId: workspace.id, access: 'remote', requestId: 'lost-open' }); expect(retry.value.error.code).toBe('RECONCILIATION_REQUIRED'); expect(retry.value.error.workspaceHandle).toBe(handle);
    const recovered = await peer.tool('reconcile_workspace', { workspaceHandle: handle, writersStopped: true }); expect(recovered.isError).not.toBe(true);
    const requests = proxy.events.filter(event => /\/workspaces\/[^/]+\/runs$/.test(event.path)); expect(requests).toHaveLength(2); expect(requests[0].key).toBe(requests[1].key); expect(requests[0].value.id).toBe(recovered.value.runId); expect(requests[1].value.id).toBe(recovered.value.runId);
    await peer.tool('abort_workspace', { workspaceHandle: handle, writersStopped: true, reason: 'owned uncertainty verification complete' }); await peer.tool('cleanup_workspace', { workspaceHandle: handle, writersStopped: true }); expect(proxy.errors).toEqual([]);
  } finally { await peer?.close(); await proxy.close(); await f.dispose(); }
}, 60000);

it('survives real MCP SIGKILL after accepted checkpoint and reconciles one publication before cleanup', async () => {
  const f = await fixture(); const proxy = await relay(f.server.client.baseUrl); let peer: Protocol | undefined;
  const env = { CV_API_URL: proxy.origin, CV_API_KEY: f.server.client.keyA, CV_MCP_STATE_DIR: join(f.directory, 'private-state') };
  try {
    const workspace = await canonicalWorkspace(f.server);
    peer = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: f.directory, env }).initialize();
    const opened = await peer.tool('checkout_workspace', { workspaceId: workspace.id, access: 'remote', requestId: 'killed-checkpoint' }); const handle = opened.value.workspaceHandle;
    await peer.tool('write_workspace_file', { workspaceHandle: handle, path: 'retained.bin', base64: 'AP+A', offset: 0, truncate: true });
    proxy.arm('checkpoint'); const pending = peer.tool('commit_workspace', { workspaceHandle: handle, writersStopped: true }).catch(() => null);
    await until(() => proxy.events.some(event => event.path.endsWith('/finalize') && event.status === 202));
    const exited = once(peer.child, 'exit'); peer.child.kill('SIGKILL'); await exited; await pending;
    peer = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: f.directory, env }).initialize();
    expect((await peer.tool('cleanup_workspace', { workspaceHandle: handle, writersStopped: true })).value.error.code).toBe('CONTROLLER_ACTIVE');
    expect((await peer.tool('recover_workspace_controller', { workspaceHandle: handle, controllersStopped: true })).isError).not.toBe(true);
    expect((await peer.tool('cleanup_workspace', { workspaceHandle: handle, writersStopped: true })).value.error.code).toBe('RECONCILIATION_REQUIRED');
    const reconciled = await peer.tool('reconcile_workspace', { workspaceHandle: handle, writersStopped: true }); expect(reconciled.isError).not.toBe(true); expect(reconciled.value.checkpointReceipt.operation.result.changed).toBe(true);
    expect((await peer.tool('read_workspace_file', { workspaceHandle: handle, path: 'retained.bin' })).value.base64).toBe('AP+A');
    const finalize = proxy.events.filter(event => event.path.endsWith('/finalize')); expect(finalize).toHaveLength(2); expect(finalize[0].key).toBe(finalize[1].key); expect(finalize[0].value.id).toBe(finalize[1].value.id);
    const history = await peer.tool('get_workspace_history', { workspaceId: workspace.id }); expect(history.value).toHaveLength(2);
    await peer.tool('abort_workspace', { workspaceHandle: handle, writersStopped: true, reason: 'owned resumed MCP verification complete' }); await peer.tool('cleanup_workspace', { workspaceHandle: handle, writersStopped: true }); expect(proxy.errors).toEqual([]);
  } finally { await peer?.close(); await proxy.close(); await f.dispose(); }
}, 60000);
