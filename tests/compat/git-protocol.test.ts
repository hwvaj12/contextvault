import { it, expect } from 'vitest';
import { fixture, workspace, backend } from './helpers';
it('rejects canonical Git writes and scopes advertisements to catalog authority', async () => {
  const server = await fixture();
  try {
    const c = server.client; const w = await workspace(c);
    const refs = await fetch(`${c.baseUrl}/repos/${w.id}/info/refs?service=git-upload-pack`, { headers: { 'X-API-Key': c.keyA } });
    expect(refs.status).toBe(backend === 's3' ? 409 : 200);
    if (backend === 's3') { const error: any = await refs.json(); expect(error.error.code).toBe('UNSUPPORTED_CAPABILITY'); expect(JSON.stringify(error)).not.toMatch(/refs\/|candidate|objects\.git/); }
    if (backend === 'git') { const text = await refs.text(); expect(text).toContain('refs/heads/main'); expect(text).not.toContain('candidate'); }
    const foreign = await fetch(`${c.baseUrl}/repos/${w.id}/info/refs?service=git-upload-pack`, { headers: { 'X-API-Key': c.keyB } }); expect([403, 404]).toContain(foreign.status); expect(await foreign.text()).not.toMatch(/refs\/|candidate|objects\.git/);
    expect((await fetch(`${c.baseUrl}/repos/${w.id}/info/refs?service=git-receive-pack`, { headers: { 'X-API-Key': c.keyA } })).status).toBe(backend === 's3' ? 409 : 403);
    expect((await fetch(`${c.baseUrl}/repos/${w.id}/git-receive-pack`, { method: 'POST', headers: { 'X-API-Key': c.keyA, 'Content-Type': 'application/x-git-receive-pack-request' }, body: '0000' })).status).toBe(backend === 's3' ? 409 : 403);
  } finally { await server.dispose(); }
});

it('serves an advertised accepted Git head after publication or rejects unsupported S3 wire reads', async () => {
  const server = await fixture();
  try {
    const c = server.client; const w = await workspace(c);
    const advertisement = await fetch(`${c.baseUrl}/repos/${w.id}/info/refs?service=git-upload-pack`, { headers: { 'X-API-Key': c.keyA } });
    expect(advertisement.status).toBe(backend === 'git' ? 200 : 409);
    const text = await advertisement.text(); const head = backend === 'git' ? text.match(/([a-f0-9]{40}) HEAD\0/)![1] : w.latestCommitId;
    if (backend === 's3') expect(JSON.parse(text).error.code).toBe('UNSUPPORTED_CAPABILITY');
    const { push } = await import('./helpers'); expect((await push(c, w.id, [{ path: 'new.txt', content: 'new accepted head' }])).status).toBe(201);
    const packet = (text: string) => (Buffer.byteLength(text) + 4).toString(16).padStart(4, '0') + text;
    const response = await fetch(`${c.baseUrl}/repos/${w.id}/git-upload-pack`, { method: 'POST', headers: { 'X-API-Key': c.keyA, 'Content-Type': 'application/x-git-upload-pack-request' }, body: packet(`want ${head} no-progress\n`) + '0000' + packet('done\n') });
    expect(response.status).toBe(backend === 'git' ? 200 : 409);
    if (backend === 's3') expect((await response.json()).error.code).toBe('UNSUPPORTED_CAPABILITY');
    else await response.body?.cancel();
  } finally { await server.dispose(); }
});

it('preserves legacy Basic credentials in either username or password while enforcing tenant scope', async () => {
  const server = await fixture();
  try {
    const c = server.client; const w = await workspace(c);
    for (const credentials of [`${c.keyA}:ignored`, `ignored:${c.keyA}`]) {
      const response = await fetch(`${c.baseUrl}/repos/${w.id}/info/refs?service=git-upload-pack`, { headers: { Authorization: `Basic ${Buffer.from(credentials).toString('base64')}` } });
      expect(response.status).toBe(backend === 'git' ? 200 : 409); await response.body?.cancel();
    }
    const passwordFirst = await fetch(`${c.baseUrl}/repos/${w.id}/info/refs?service=git-upload-pack`, { headers: { Authorization: `Basic ${Buffer.from(`${c.keyB}:${c.keyA}`).toString('base64')}` } });
    expect(passwordFirst.status).toBe(backend === 'git' ? 200 : 409); await passwordFirst.body?.cancel();
    for (const headers of [
      { Authorization: `Basic ${Buffer.from(`${c.keyA}:${c.keyB}`).toString('base64')}` },
      { 'X-API-Key': c.keyB, Authorization: `Basic ${Buffer.from(`${c.keyA}:ignored`).toString('base64')}` },
    ]) {
      const oneIdentity = await fetch(`${c.baseUrl}/repos/${w.id}/info/refs?service=git-upload-pack`, { headers });
      expect([403, 404]).toContain(oneIdentity.status); await oneIdentity.body?.cancel();
    }
    const foreign = await fetch(`${c.baseUrl}/repos/${w.id}/info/refs?service=git-upload-pack`, { headers: { Authorization: `Basic ${Buffer.from(`${c.keyB}:ignored`).toString('base64')}` } }); expect([403, 404]).toContain(foreign.status); await foreign.body?.cancel();
  } finally { await server.dispose(); }
});
