import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { documentationFixture } from './fixture';
// @ts-ignore Actual isolated CLI behavior probes.
import { verifyRuntimeProbes } from './runtime-probes.mjs';

let runtime: any;
it('preserves actual Postman assertion, script, transport, skip, empty, and timeout outcomes', async () => {
  runtime = await verifyRuntimeProbes();
  expect(runtime.cases).toHaveLength(8);
  expect(runtime.cases.every((value: any) => value.actual === value.expected)).toBe(true);
});
it('executes the published quickstarts and collection against the selected normal API', async () => {
  const fixture = await documentationFixture();
  try {
    const result = await fixture.verifyPublished();
    expect(result.quickstarts).toBe(3); expect(result.postman).toBe(1); expect(result.reports[0].requests).toBeGreaterThanOrEqual(21);
    const evidence = { kind: 'workspace-documentation', ...result, ...fixture.proof, runtimeProbes: runtime };
    if (!process.env.CV_DOCS_EVIDENCE_PATH) throw new Error('Documentation evidence destination is missing');
    await writeFile(process.env.CV_DOCS_EVIDENCE_PATH, JSON.stringify(evidence), { mode: 0o600 });
  } finally { await fixture.dispose(); }
});
