import { expect, it } from 'vitest';
import { documentationFixture } from './fixture';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './fixture';

it('runs three installed examples and the actual API collection independently of narrative drafts', async () => {
  const fixture = await documentationFixture();
  try {
    const result = await fixture.verifyComponents();
    expect(result.quickstarts).toBe(3); expect(result.postman).toBe(1); expect(result.reports[0].requests).toBeGreaterThanOrEqual(21);
    await writeFile(join(root, 'tests/docs/components-' + fixture.proof.backend + '.log'), JSON.stringify({ kind: 'documentation-components', ...result, ...fixture.proof }, null, 2) + '\n', { mode: 0o600 });
  } finally { await fixture.dispose(); }
});
