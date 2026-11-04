import Database from 'better-sqlite3';
import { isAbsolute } from 'node:path';
import { loadConfiguration } from '../src/config';
import { createRuntime } from '../src/config/runtime';
import { migrationPrincipal } from '../src/adapters/control/migration-auth';
import { StorageMigrationService } from '../src/application/migrations/storage';
import type { CustomerId, WorkspaceId } from '../src/domain';

async function main() {
  const [action, ...args] = process.argv.slice(2); const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]; if (!['--customer', '--workspace', '--target-profile', '--backup-root', '--idempotency-key', '--reason'].includes(flag) || !args[index + 1] || options[flag]) throw new Error('Unknown or duplicate migration option'); options[flag] = args[++index];
  }
  if (!['inspect', 'transfer'].includes(action) || ['--customer', '--workspace', '--target-profile', '--backup-root', '--idempotency-key', '--reason'].some(flag => !options[flag]) || !process.env.CV_MIGRATION_API_KEY || !process.env.CV_DATA_DIR || !isAbsolute(process.env.CV_DATA_DIR)) throw new Error('Use inspect or transfer with explicit customer, workspace, target-profile, backup-root, idempotency-key, reason, CV_DATA_DIR and CV_MIGRATION_API_KEY');
  const configuration = loadConfiguration(process.env); const database = new Database(configuration.databasePath, { fileMustExist: true }); let runtime;
  try {
    runtime = await createRuntime(configuration, database, { maintenance: false });
    const principal = migrationPrincipal(database, process.env.CV_MIGRATION_API_KEY, options['--customer'] as CustomerId, runtime.now(), configuration.masterKey, action === 'inspect');
    const service = new StorageMigrationService(runtime); const input = { scope: { customerId: options['--customer'] as CustomerId, workspaceId: options['--workspace'] as WorkspaceId }, principal, idempotencyKey: options['--idempotency-key'], request: { targetConfigurationRef: options['--target-profile'], backupRoot: options['--backup-root'], reason: options['--reason'] } };
    const result = action === 'inspect' ? await service.inspect(input) : await service.transfer(input); process.stdout.write(JSON.stringify(result) + '\n');
  } finally { await runtime?.stop(); database.close(); }
}
main().catch(error => { process.stderr.write(JSON.stringify(error.toJSON?.() ?? { error: { code: error.code ?? 'INVALID_REQUEST', message: error.message } }) + '\n'); process.exitCode = 1; });
