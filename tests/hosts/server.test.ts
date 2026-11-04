import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fixture, run, waitForRelayOrigin, type RelayStartupInspection } from './harness';
import { storageTarget } from './server';

const relayName = 'relay-under-test'; const relayOwner = 'relay-test-owner';
function relaySnapshot(port: string): RelayStartupInspection {
  return { id: 'relay-test-id', name: '/' + relayName, owner: relayOwner, state: { Running: true, Status: 'running', ExitCode: 0, OOMKilled: false }, ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: port }] } };
}
async function withRelayListener(check: (port: string) => Promise<void>, delay = 0) {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((_request, response) => {
    if (!delay) { response.writeHead(200); response.end('healthy'); return; }
    const timer = setTimeout(() => { timers.delete(timer); response.writeHead(200); response.end('healthy'); }, delay); timers.add(timer);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await check(String((server.address() as { port: number }).port)); }
  finally { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

it('waits for a transiently missing relay mapping before probing its real listener', async () => {
  await withRelayListener(async port => {
    let calls = 0;
    const inspect = async () => { const view = relaySnapshot(port); if (++calls === 1) view.ports = {}; return view; };
    await expect(waitForRelayOrigin(relayName, relayOwner, inspect)).resolves.toBe('http://127.0.0.1:' + port);
    expect(calls).toBe(2);
  });
});

it('rejects a permanently missing relay mapping within the fixture startup bound with safe diagnostics', async () => {
  const view = relaySnapshot('8080'); view.ports = {};
  const started = Date.now();
  await expect(waitForRelayOrigin(relayName, relayOwner, async () => view)).rejects.toThrow(/did not become ready within 5000ms.*"id":"relay-test-id".*"state".*"ports":\{\}/);
  expect(Date.now() - started).toBeLessThan(6500);
});

it.each(['0.0.0.0', '127.0.0.2'])('rejects an unsafe relay mapping on %s before using its listener', async HostIp => {
  await withRelayListener(async port => {
    const view = relaySnapshot(port); view.ports['8080/tcp']![0].HostIp = HostIp;
    await expect(waitForRelayOrigin(relayName, relayOwner, async () => view)).rejects.toThrow(/unsafe published mapping.*"ports"/);
  });
});

it('rejects a malformed relay port explicitly', async () => {
  await expect(waitForRelayOrigin(relayName, relayOwner, async () => relaySnapshot('invalid'))).rejects.toThrow(/unsafe published mapping/);
});

it('rejects a stopped relay before using a reachable listener', async () => {
  await withRelayListener(async port => {
    const view = relaySnapshot(port); view.state = { Running: false, Status: 'exited', ExitCode: 1, OOMKilled: false };
    await expect(waitForRelayOrigin(relayName, relayOwner, async () => view)).rejects.toThrow(/stopped during startup.*"ExitCode":1/);
  });
});

it('accepts a healthy relay with its exact loopback mapping', async () => {
  await withRelayListener(async port => {
    await expect(waitForRelayOrigin(relayName, relayOwner, async () => relaySnapshot(port))).resolves.toBe('http://127.0.0.1:' + port);
  });
});

it('bounds relay listener readiness inside the same five-second startup deadline', async () => {
  await withRelayListener(async port => {
    const started = Date.now();
    await expect(waitForRelayOrigin(relayName, relayOwner, async () => relaySnapshot(port))).rejects.toThrow(/did not become ready within 5000ms/);
    expect(Date.now() - started).toBeLessThan(6500);
  }, 6000);
}, 13000);

async function selectedStorage(endpoint: string, bindings: { HostIp: string; HostPort: string }[]) {
  const variables = { CV_TEST_S3_PROVIDER: 'localstack', CV_TEST_S3_BUCKET: 'binding-probe', CV_TEST_S3_REGION: 'us-east-1', CV_TEST_S3_PREFIX: 'contextvault-tests/binding-probe/', CV_TEST_S3_ENDPOINT: endpoint };
  const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  Object.assign(process.env, variables);
  try {
    return await storageTarget('s3', 'binding-probe', async () => ({ State: { Running: true }, Name: '/selected-s3', NetworkSettings: { Ports: { '4566/tcp': bindings }, Networks: { dedicated: { Aliases: ['contextvault-s3'] } } } }));
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

it.each([
  ['127.0.0.2', '51744'],
  ['::', '51744'],
  ['127.0.0.1', '51745'],
])('rejects an S3 service published at disjoint binding %s:%s', async (HostIp, HostPort) => {
  await expect(selectedStorage('http://127.0.0.1:51744', [{ HostIp, HostPort }])).rejects.toThrow('Selected S3 endpoint does not identify the running owned service');
});

it.each([
  ['http://127.0.0.1:51744', '127.0.0.1'],
  ['http://127.0.0.1:51744', '0.0.0.0'],
  ['http://localhost:51744', '127.0.0.1'],
  ['http://localhost:51744', '0.0.0.0'],
])('selects the same S3 service for API and cleanup at %s through %s', async (endpoint, HostIp) => {
  await expect(selectedStorage(endpoint, [{ HostIp, HostPort: '51744' }])).resolves.toMatchObject({ endpoint: 'http://127.0.0.1:51744', containerEndpoint: 'http://selected-s3:4566', network: 'dedicated' });
});

it('serves authoritative HTTP through a private Linux API and direct Docker relay, then removes only its owned resources', async () => {
  const f = await fixture(); let proof: any;
  try {
    proof = (f as any).server;
    expect(proof?.kind).toBe('docker');
    expect(proof.runtime).toMatchObject({ platform: 'linux', sqlite: expect.any(String) });
    expect(Number(proof.runtime.node.split('.')[0])).toBeGreaterThanOrEqual(22);
    expect(proof.upstream).toBe('http://contextvault-server:3000');
    expect(proof.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    const api = JSON.parse((await run('docker', ['inspect', proof.containerName])).stdout)[0];
    const relay = JSON.parse((await run('docker', ['inspect', 'cv-host-relay-' + f.id])).stdout)[0];
    expect(api.Id).toBe(proof.containerId); expect(api.Mounts).toEqual([]);
    expect(Object.keys(api.NetworkSettings.Networks)).toContain(proof.network);
    expect(Object.keys(api.NetworkSettings.Networks)).not.toContain(f.network);
    const clientNetwork = JSON.parse((await run('docker', ['network', 'inspect', f.network])).stdout)[0];
    expect(clientNetwork.Internal).toBe(true);
    expect(Object.keys(relay.NetworkSettings.Networks).sort()).toEqual([f.network, proof.network].sort());
    expect(relay.Config.Env).toContain('UPSTREAM=' + proof.upstream);
    expect(relay.Config.Env.some((value: string) => value.startsWith('UPSTREAM=') && value.includes('host.docker.internal'))).toBe(false);
    const response = await fetch(f.origin + '/v1/workspaces', { method: 'POST', headers: { 'X-API-Key': f.client.keyA, 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId: f.client.customerA, name: 'container API authority' }) });
    expect(response.status).toBe(201); const workspace = await response.json();
    const readback = await fetch(f.client.baseUrl + '/v1/workspaces/' + workspace.id, { headers: { 'X-API-Key': f.client.keyA } });
    expect(readback.status).toBe(200); expect((await readback.json()).currentRevisionId).toBe(workspace.currentRevisionId);
    const privateFile = JSON.parse((await run('docker', ['exec', proof.containerName, 'node', '-e', 'const fs=require("node:fs");const p=process.env.CV_DATA_DIR+"/contextvault.db";console.log(JSON.stringify({exists:fs.existsSync(p),uid:process.getuid(),mode:fs.statSync(process.env.CV_DATA_DIR).mode&511}))'])).stdout);
    expect(privateFile).toMatchObject({ exists: true, uid: 1000, mode: 448 });
  } finally { await f.dispose(); }
  if (proof) {
    await expect(run('docker', ['inspect', proof.containerName])).rejects.toThrow(/No such/);
    await expect(run('docker', ['network', 'inspect', proof.network])).rejects.toThrow(/not found|No such/);
    await expect(run('docker', ['network', 'inspect', f.network])).rejects.toThrow(/not found|No such/);
  }
}, 240000);
