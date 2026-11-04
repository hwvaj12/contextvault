import { expect, it, vi } from 'vitest';
import { configuredFixture, faultFixture, publish, workspace } from '../revisions/helpers';
it('documents administration requests and streaming bundles without HTTP header manifests', async () => {
  const server = await configuredFixture();
  try {
    const response = await fetch(`${server.client.baseUrl}/docs/json`); expect(response.status).toBe(200); const document = await response.json() as any;
    const body = (path: string, method = 'post') => document.paths[path][method].requestBody.content['application/json'].schema;
    expect(body('/v1/workspaces/{id}/restore').required).toEqual(['revisionId', 'expectedRevisionId', 'expectedWorkspaceVersion', 'reason']);
    expect(body('/v1/workspaces/{id}/clone').required).toEqual(['targetCustomerId']);
    expect(body('/v1/workspaces/import').required).toEqual(['bundlePath']);
    expect(body('/v1/workspaces/{id}/export').properties.revisionId.type).toBe('string');
    expect(body('/v1/bundles').additionalProperties).toBe(false);
    const upload = document.paths['/v1/bundles/{bid}'].put;
    expect(upload.requestBody.content['application/vnd.contextvault.bundle'].schema.format).toBe('binary');
    expect(upload.parameters.some((value: any) => value.in === 'header' && value.name === 'idempotency-key' && value.required)).toBe(true);
    expect(upload.parameters.some((value: any) => /manifest/i.test(value.name))).toBe(false);
    expect(document.paths['/v1/workspaces/{id}'].delete.parameters.some((value: any) => value.in === 'header' && value.name === 'idempotency-key' && value.required)).toBe(true);
    expect(document.paths['/v1/workspaces/{id}/diff'].get.parameters.filter((value: any) => value.in === 'query' && value.required).map((value: any) => value.name)).toEqual(['from', 'to']);
    expect(document.paths['/v1/workspaces/{id}/search'].get.parameters.some((value: any) => value.name === 'q' && value.required)).toBe(true);
  } finally { await server.dispose(); }
});
it('preserves browser reads with opaque revisions and clears customer selection when credentials change', async () => {
  const server = await faultFixture(); const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal('window', { location: { origin: server.client.baseUrl } });
  try {
    const c = server.client; const w = await workspace(c); const first = await publish(c, w.id, { 'readme.txt': Buffer.from('first\nneedle\n') }); const second = await publish(c, w.id, { 'readme.txt': Buffer.from('second\nneedle\n') });
    const api = await import('../../src/vault-browser/src/api/contextvault'); api.setApiKey(c.keyA);
    expect((await api.listWorkspaces()).map(value => value.id)).toContain(w.id); expect((await api.getWorkspace(w.id)).latestCommitId).toBe(second);
    const history = await api.getHistory(w.id); expect(history.map(value => value.id)).toEqual([second, first, w.currentRevisionId]); expect(second).not.toMatch(/^[a-f0-9]{40}$/);
    expect(await api.getFiles(w.id, first)).toEqual([{ path: 'readme.txt', content: 'first\nneedle\n' }]);
    const diff = await api.getDiff(w.id, first, second); expect(diff.summary.additions).toBe(1); expect(diff.summary.deletions).toBe(1); expect(diff.files[0].hunks?.[0].content).toBe('-first\n+second');
    expect((await api.searchFiles(w.id, 'needle')).results).toEqual([{ path: 'readme.txt', lineNumber: 2, snippet: 'needle' }]);
    api.setApiKey(server.master); expect(api.getSelectedCustomerId()).toBe(''); await expect(api.listWorkspaces()).rejects.toThrow();
    api.setSelectedCustomerId(c.customerA); expect((await api.listWorkspaces()).map(value => value.id)).toContain(w.id);
    api.setSelectedCustomerId(c.customerB); expect(await api.listWorkspaces()).toEqual([]);
    api.setApiKey(c.keyB); expect(api.getSelectedCustomerId()).toBe(''); expect(values.has('cv-selected-customer-id')).toBe(false); expect(await api.listWorkspaces()).toEqual([]);
    await expect(api.getWorkspace(w.id)).rejects.toThrow('404'); api.setSelectedCustomerId(c.customerA); await expect(api.listWorkspaces()).rejects.toThrow('403');
    api.setApiKey(''); expect(api.getSelectedCustomerId()).toBe('');
  } finally { vi.unstubAllGlobals(); await server.dispose(); }
}, 60000);
