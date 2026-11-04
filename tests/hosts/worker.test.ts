import { afterAll, beforeAll, expect, it } from 'vitest';
import { exampleJourney, fixture, hostJourney, type HostFixture, type Language } from './harness';
let server: HostFixture;
beforeAll(async () => { server = await fixture(); }, 240000);
afterAll(async () => { await server?.dispose(); }, 60000);
for (const language of ['typescript', 'python', 'php'] as Language[]) it(`installed ${language} worker recovers a killed controller and finalizes or aborts ordinary agent files`, async () => {
  const result = await hostJourney(server, language, 'worker');
  expect(result.ok).toBe(true); expect(result.version).toBe(3);
  expect(result.isolation.kind).toBe('cooperating-host-process');
  expect(result.packageArtifact).toMatch(/^[a-f0-9]{64}$/);
  console.info('HOST_EVIDENCE ' + JSON.stringify(result));
});
for (const language of ['typescript', 'python', 'php'] as Language[]) for (const failure of [false, true]) it(`${language} foreground worker example ${failure ? 'retains a failed agent' : 'publishes and cleans up'} with lease renewal`, async () => {
  const result = await exampleJourney(server, language, failure); expect(result.foregroundLeaseRenewed).toBe(true); expect(result.retainedOnFailure).toBe(failure);
});
for (const language of ['typescript', 'python', 'php'] as Language[]) it(`${language} worker example rejects reserved credential forwarding before launching an agent`, async () => {
  const result = await exampleJourney(server, language, true, true); expect(result.reservedCredentialRejected).toBe(true); expect(result.retainedOnFailure).toBe(true);
});
