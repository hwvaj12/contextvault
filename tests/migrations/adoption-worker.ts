import Database from 'better-sqlite3';
import { loadConfiguration } from '../../src/config';
import { createRuntime } from '../../src/config/runtime';
import { migrationPrincipal } from '../../src/adapters/control/migration-auth';
import { FilesystemLegacyInventory } from '../../src/adapters/control/legacy-inventory';
import { LegacyAdoptionService } from '../../src/application/migrations/adoption';
async function main() {
  const configuration = loadConfiguration(process.env); const db = new Database(configuration.databasePath, { fileMustExist: true }); const runtime = await createRuntime(configuration, db, { maintenance: false });
  try { const input = JSON.parse(process.env.CV_ADOPT_INPUT!); input.principal = migrationPrincipal(db, process.env.CV_MIGRATION_API_KEY!, input.scope.customerId, runtime.now());
    const source = new FilesystemLegacyInventory({ sourceRoot: process.env.CV_ADOPT_SOURCE!, databasePath: process.env.CV_ADOPT_DATABASE! });
    const result = await new LegacyAdoptionService(runtime, source, async (stage, adoption) => { if (stage === 'candidate-prepared') { process.send!({ stage, adoption }); await new Promise(() => {}); } }).adopt(input); process.stdout.write(JSON.stringify(result) + '\n');
  } finally { await runtime.stop(); db.close(); }
}
main().catch(error => { process.stderr.write(JSON.stringify(error.toJSON?.() ?? { message: error.message }) + '\n'); process.exitCode = 1; });
