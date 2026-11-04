import { expect, it } from 'vitest';
import { join } from 'node:path';
import { Protocol, fixture, root } from './protocol';

it('retained MCP administration uses authenticated canonical creation, replacement, history, diff, restore and tombstones', async () => {
  const f = await fixture(); let peer: Protocol | undefined;
  try {
    const c = f.server.client;
    peer = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: f.directory, env: { CV_API_URL: c.baseUrl, CV_API_KEY: c.keyA, CV_MCP_STATE_DIR: join(f.directory, 'private-state') } }).initialize();
    expect((await peer.call('tools/list')).tools.map((tool: any) => tool.name)).toContain('create_workspace');
    const created = await peer.tool('create_workspace', { customerId: c.customerA, name: 'MCP administration', requestId: 'create-a' }); expect(created.isError).not.toBe(true); const id = created.value.id;
    expect((await peer.tool('create_workspace', { customerId: c.customerA, name: 'MCP administration', requestId: 'create-a' })).value.id).toBe(id);
    expect((await peer.tool('create_workspace', { customerId: c.customerA, name: 'changed request', requestId: 'create-a' })).value.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const first = await peer.tool('push_to_workspace', { workspaceId: id, files: [{ path: 'changed.txt', content: 'first' }, { path: 'removed.txt', content: 'remove' }], requestId: 'push-a' }); expect(first.isError).not.toBe(true);
    const second = await peer.tool('push_to_workspace', { workspaceId: id, files: [{ path: 'changed.txt', content: 'second' }, { path: 'binary.bin', content: 'AP+A', encoding: 'base64' }], requestId: 'push-b' }); expect(second.isError).not.toBe(true);
    const pulled = await peer.tool('pull_from_workspace', { workspaceId: id }); expect(pulled.value.files).toEqual([{ path: 'binary.bin', content: 'AP+A', encoding: 'base64' }, { path: 'changed.txt', content: 'second' }]);
    const history = await peer.tool('get_workspace_history', { workspaceId: id }); expect(history.value.map((entry: any) => entry.id)).toEqual([second.value.commitId, first.value.commitId, created.value.currentRevisionId]);
    const diff = await peer.tool('diff_workspace', { workspaceId: id, from: first.value.commitId, to: second.value.commitId }); expect(diff.value.added).toEqual(['binary.bin']); expect(diff.value.removed).toEqual(['removed.txt']); expect(diff.value.modified).toEqual(['changed.txt']);
    const restored = await peer.tool('rollback_workspace', { workspaceId: id, toVersion: first.value.commitId, requestId: 'restore-a' }); expect(restored.isError).not.toBe(true);
    expect((await peer.tool('pull_from_workspace', { workspaceId: id })).value.files).toEqual([{ path: 'changed.txt', content: 'first' }, { path: 'removed.txt', content: 'remove' }]);
    const deleted = await peer.tool('delete_workspace', { workspaceId: id, requestId: 'delete-a' }); expect(deleted.isError).not.toBe(true); expect(deleted.value.deleted).toBe(true);
    expect((await peer.tool('list_workspaces')).value).toEqual([]);
    const unauthorized = await peer.tool('create_workspace', { customerId: c.customerB, name: 'foreign', requestId: 'foreign' }); expect(unauthorized.isError).toBe(true);
  } finally { await peer?.close(); await f.dispose(); }
}, 60000);
