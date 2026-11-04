import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { canonicalizeManifest } from '../../src/domain';
import { faultFixture } from './fault-fixture';
import { call, workspace, push } from './helpers';
async function records(root: string): Promise<any[]> {
  const result: any[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name); if (entry.isDirectory()) result.push(...await records(path));
    else if (entry.name.endsWith('.json')) result.push({ value: JSON.parse(await readFile(path, 'utf8')), byteLength: (await readFile(path)).byteLength });
  }
  return result;
}
it('journals bounded source metadata for streamed sandbox capture and pinned rollback without reducing the legal 512 MiB limit', async () => {
  const server = await faultFixture();
  try {
    const c = server.client; const w = await workspace(c); const text = 'streamed-capture-'.repeat(65536);
    const seed = await push(c, w.id, [{ path: 'large.txt', content: text }]); expect(seed.status).toBe(201);
    const opened = await call(c, `/workspaces/${w.id}/sandbox`, 'POST', {}, c.keyA, 'streamed-open'); expect(opened.status).toBe(201);
    await writeFile(join(opened.body.sandboxPath, 'change.txt'), 'small mutation');
    const checkpoint = await call(c, `/workspaces/${w.id}/sandbox/commit`, 'POST', { writersStopped: true }, c.keyA, 'streamed-checkpoint'); expect(checkpoint.status).toBe(201);
    const restored = await call(c, `/workspaces/${w.id}/rollback`, 'POST', { toVersion: seed.body.commitId }, c.keyA, 'pinned-rollback'); expect(restored.status).toBe(201);
    const metadata = await records(join(server.configuration.dataDirectory, 'legacy-compat'));
    const sourceRecords = metadata.filter(record => record.value.source);
    expect(sourceRecords.length).toBeGreaterThanOrEqual(3);
    expect(sourceRecords.every(record => !Object.hasOwn(record.value.source, 'files'))).toBe(true);
    expect(metadata.every(record => record.byteLength < 100_000)).toBe(true);
    const rollback = sourceRecords.find(record => record.value.request?.toVersion === seed.body.commitId)!; expect(rollback.value.source.kind).toBe('accepted');
    expect(sourceRecords.some(record => record.value.source.kind === 'capture')).toBe(true);
    const ceiling = canonicalizeManifest({ schemaVersion: 1, entries: Array.from({ length: 8 }, (_, index) => ({ path: `chunk-${index}.bin`, kind: 'file', byteLength: 64 * 1024 * 1024, sha256: '0'.repeat(64) })) });
    expect(ceiling.entries.reduce((n, entry) => n + (entry.kind === 'file' ? entry.byteLength : 0), 0)).toBe(512 * 1024 * 1024);
    expect(JSON.stringify({ ...rollback.value.source, manifest: ceiling }).length).toBeLessThan(10_000);
    expect((await call(c, `/workspaces/${w.id}/pull`)).body.files).toEqual([{ path: 'large.txt', content: text }]);
  } finally { await server.dispose(); }
});
