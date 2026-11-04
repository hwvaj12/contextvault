import { expect, it } from 'vitest';
import { join } from 'node:path';
import { Protocol, canonicalWorkspace, fixture, root } from './protocol';

it('development MCP lists the authenticated canonical workspace from another working directory', async () => {
  const f = await fixture(); let peer: Protocol | undefined;
  try {
    const workspace = await canonicalWorkspace(f.server);
    peer = await new Protocol(process.execPath, [join(root, 'mcp/src/index.mjs')], { cwd: f.directory, env: { CV_API_URL: f.server.client.baseUrl, CV_API_KEY: f.server.client.keyA, CV_MCP_STATE_DIR: join(f.directory, 'private-state') } }).initialize();
    const listed = await peer.tool('list_workspaces');
    expect(listed.isError).not.toBe(true);
    expect(listed.value.map((value: any) => value.id)).toContain(workspace.id);
  } finally { await peer?.close(); await f.dispose(); }
});
