import Database from 'better-sqlite3';
import { loadConfiguration } from '../../src/config';
import { createRuntime } from '../../src/config/runtime';
import { migrationPrincipal } from '../../src/adapters/control/migration-auth';
import { StorageMigrationService } from '../../src/application/migrations/storage';
async function main() {
  const configuration = loadConfiguration(process.env); const db = new Database(configuration.databasePath, { fileMustExist: true });
  const runtime = await createRuntime(configuration, db, { maintenance: false });
  try {
    const input = JSON.parse(process.env.CV_TRANSFER_INPUT!); input.principal = migrationPrincipal(db, process.env.CV_MIGRATION_API_KEY!, input.scope.customerId, runtime.now());
    if (process.env.CV_TRANSFER_PAUSE === 'backup-linked') {
      const files = require('node:fs/promises'); const original = files.link;
      files.link = async (source: string, target: string) => { await original(source, target); if (target.endsWith('/catalog.sqlite')) { const row = db.prepare("SELECT data FROM catalog_records WHERE kind='migration' AND customer_id=? AND workspace_id=?").get(input.scope.customerId, input.scope.workspaceId) as { data: string }; process.send!({ stage: 'backup-linked', migration: JSON.parse(row.data) }); await new Promise(() => {}); } };
    }
    if (process.env.CV_TRANSFER_PAUSE === 'writer-open') {
      const original = runtime.revisionStore.bind(runtime);
      runtime.revisionStore = async binding => {
        const store = await original(binding); if (binding.backend !== 's3') return store;
        return new Proxy(store, { get(target, property) {
          if (property === 'prepare') return async (request: any) => target.prepare({ ...request, source: { ...request.source, openFile: async (...args: any[]) => {
            const bytes = await request.source.openFile(...args); return (async function* () {
              for await (const chunk of bytes) { const records = db.prepare("SELECT data FROM catalog_records WHERE kind='migration' AND customer_id=? AND workspace_id=?").all(input.scope.customerId, input.scope.workspaceId) as { data: string }[]; process.send!({ stage: 'writer-open', migration: JSON.parse(records[0].data) }); await new Promise(() => {}); yield chunk; }
            })();
          } } });
          const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
        } });
      };
    }
    const service = new StorageMigrationService(runtime, async (stage, migration) => {
      if (stage === process.env.CV_TRANSFER_PAUSE) { process.send!({ stage, migration }); await new Promise(() => {}); }
    });
    process.stdout.write(JSON.stringify(await service.transfer(input)) + '\n');
  } finally { await runtime.stop(); db.close(); }
}
main().catch(error => { process.stderr.write(JSON.stringify(error.toJSON?.() ?? { code: error.code, message: error.message }) + '\n'); process.exitCode = 1; });
