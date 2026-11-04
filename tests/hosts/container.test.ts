import { afterAll, beforeAll, expect, it } from 'vitest';
import { backend, containerExample, fixture, hostJourney, type HostFixture, type Language } from './harness';
let server: HostFixture;
beforeAll(async () => { server = await fixture(); }, 240000);
afterAll(async () => { await server?.dispose(); }, 60000);
for (const language of ['typescript', 'python', 'php'] as Language[]) it(`installed ${language} client and independent container agent share only client-local files`, async () => {
  const result = await hostJourney(server, language, 'container');
  expect(result.ok).toBe(true); expect(result.version).toBe(3);
  expect(result.isolation).toMatchObject({ kind: 'isolated-container-network', hostFilesystemDenied: true, relayDestinationDenied: true });
  if (backend === 's3') expect(result.isolation).toMatchObject({ storageIpDenied: true, hostEndpointDenied: true });
  expect(result.imageId).toMatch(/^sha256:[a-f0-9]{64}$/);
  if (language === 'typescript') expect(result.minimumCliProof).toMatchObject({ runtime: expect.stringMatching(/^18\./), installed: true, separateSubmit: true, finalized: true, aborted: true });
  console.info('HOST_EVIDENCE ' + JSON.stringify(result));
});
it('the supplied container launcher publishes an independently launched agent without sharing credentials or private state', async () => {
  const result = await containerExample(server); expect(result.cleaned).toBe(true); expect(result.workspaceOnlyAgentMount).toBe(true);
  console.info('HOST_EXAMPLE_EVIDENCE ' + JSON.stringify(result));
}, 60000);
