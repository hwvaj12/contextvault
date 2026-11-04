import { expect, it } from 'vitest';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Protocol, canonicalWorkspace, fixture, root } from './protocol';

it('resumes the same authenticated workspace after changing process directory without creating another authority', async () => {
  const f = await fixture(); let peer: Protocol | undefined;
  try {
    const workspace = await canonicalWorkspace(f.server); const first = join(f.directory, 'first-agent'); const second = join(f.directory, 'second-agent');
    await mkdir(first); await mkdir(second);
    const env = { CV_API_URL: f.server.client.baseUrl, CV_API_KEY: f.server.client.keyA, CV_MCP_STATE_DIR: join(f.directory, 'private-state') };
    peer = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: first, env }).initialize();
    const opened = await peer.tool('checkout_workspace', { workspaceId: workspace.id, access: 'remote', requestId: 'directory-independent' }); expect(opened.isError).not.toBe(true); const workspaceHandle = opened.value.workspaceHandle;
    expect((await peer.tool('write_workspace_file', { workspaceHandle, path: 'owned.bin', base64: 'AP+A', truncate: true })).isError).not.toBe(true);
    await peer.close(); peer = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: second, env }).initialize();
    expect((await peer.tool('workspace_status', { workspaceHandle })).value.runId).toBe(opened.value.runId);
    expect((await peer.tool('read_workspace_file', { workspaceHandle, path: 'owned.bin' })).value.base64).toBe('AP+A');
    expect((await peer.tool('finalize_workspace', { workspaceHandle, writersStopped: true })).value.run.state).toBe('finalized');
    expect((await peer.tool('cleanup_workspace', { workspaceHandle, writersStopped: true })).value.cleanupState).toBe('complete');
    expect((await peer.tool('get_workspace_history', { workspaceId: workspace.id })).value).toHaveLength(2);
    for (const directory of [first, second]) for (const path of ['data', '.git']) await expect(lstat(join(directory, path))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await peer?.close(); await f.dispose(); }
}, 60000);
