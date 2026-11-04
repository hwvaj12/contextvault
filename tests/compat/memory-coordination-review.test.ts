import { expect, it } from 'vitest';
import { createTestDb } from '../../src/db';
import { SqliteControlStore } from '../../src/adapters/control/sqlite-control-store';
it('shares guards within one in-memory catalog and keeps independent in-memory catalogs separate', async () => {
  const a = createTestDb(); const b = createTestDb(); const scope = { customerId: 'memory-a' as never, workspaceId: 'workspace-a' as never };
  try {
    const first = new SqliteControlStore(a); const same = new SqliteControlStore(a); const independent = new SqliteControlStore(b);
    const held = await first.acquireCompatibilityLock(scope, 'same-session');
    await expect(same.acquireCompatibilityLock(scope, 'same-session')).rejects.toMatchObject({ code: 'FINALIZATION_IN_PROGRESS' });
    const separate = await independent.acquireCompatibilityLock(scope, 'same-session'); await separate.release(); await held.release();
    const resumed = await same.acquireCompatibilityLock(scope, 'same-session'); await resumed.release();
  } finally { a.close(); b.close(); }
});
