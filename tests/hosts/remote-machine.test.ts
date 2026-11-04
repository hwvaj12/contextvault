import { afterAll, beforeAll, expect, it } from 'vitest';
import { backend, fixture, hostJourney, type HostFixture, type Language } from './harness';
let server: HostFixture;
beforeAll(async () => { server = await fixture(); }, 240000);
afterAll(async () => { await server?.dispose(); }, 60000);
for (const language of ['typescript', 'python', 'php'] as Language[]) it(`installed ${language} remote-machine boundary uses HTTP and its own private volume`, async () => {
  const result = await hostJourney(server, language, 'remote-machine');
  expect(result.ok).toBe(true); expect(result.version).toBe(3);
  expect(result.isolation).toMatchObject({ kind: 'isolated-container-network', hostFilesystemDenied: true, relayDestinationDenied: true });
  if (backend === 's3') expect(result.isolation).toMatchObject({ storageIpDenied: true, hostEndpointDenied: true });
  expect(result.imageId).toMatch(/^sha256:[a-f0-9]{64}$/);
  console.info('HOST_EVIDENCE ' + JSON.stringify({ ...result, evidence: 'isolated container/network boundary; no physical remote hardware claim' }));
});
