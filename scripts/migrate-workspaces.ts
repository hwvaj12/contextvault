import { isAbsolute, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { FilesystemLegacyInventory } from '../src/adapters/control/legacy-inventory';
import { inventoryLegacy } from '../src/application/migrations/inventory';
import { loadConfiguration } from '../src/config';
import { createRuntime } from '../src/config/runtime';
import { migrationPrincipal } from '../src/adapters/control/migration-auth';
import { LegacyAdoptionService } from '../src/application/migrations/adoption';

async function main() {
  const [action, ...args] = process.argv.slice(2); const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (['--json', '--source-offline'].includes(value)) { if (options[value]) throw new Error('Duplicate option'); options[value] = 'true'; continue; }
    if (!['--source-root', '--database', '--limits-json', '--customer', '--workspace', '--source-fingerprint', '--target-profile', '--backup-root', '--idempotency-key', '--reason'].includes(value) || !args[index + 1] || options[value]) throw new Error('Unknown or duplicate legacy migration option');
    options[value] = args[++index];
  }
  if (!['inventory', 'dry-run', 'adopt'].includes(action) || !options['--source-root'] || !options['--database'] || !isAbsolute(options['--source-root']) || !isAbsolute(options['--database'])) throw new Error('An explicit action, absolute source root and absolute database are required');
  const source = new FilesystemLegacyInventory({ sourceRoot: options['--source-root'], databasePath: options['--database'] });
  if (action !== 'adopt') { process.stdout.write(JSON.stringify(await inventoryLegacy(source, options['--limits-json'] ? JSON.parse(options['--limits-json']) : {})) + '\n'); return; }
  if (['--customer', '--workspace', '--source-fingerprint', '--target-profile', '--backup-root', '--idempotency-key', '--reason', '--source-offline'].some(flag => !options[flag]) || options['--limits-json'] || !process.env.CV_MIGRATION_API_KEY || !process.env.CV_DATA_DIR || !isAbsolute(process.env.CV_DATA_DIR)) throw new Error('Adopt requires explicit customer, workspace, reviewed source fingerprint, target profile, backup root, idempotency key, reason, source-offline, CV_DATA_DIR and CV_MIGRATION_API_KEY');
  const configuration = loadConfiguration(process.env); const sourceRoot = resolve(options['--source-root']); const separate = (path: string) => { const value = relative(sourceRoot, resolve(path)); return value === '..' || value.startsWith('../'); };
  if (!separate(configuration.dataDirectory) || !separate(configuration.databasePath) || !separate(configuration.legacySecretsPath) || configuration.profiles.some(profile => profile.backend === 'git' && (!separate(profile.rootDirectory) || !separate(profile.submissionRoot)))) throw new Error('Adoption target catalog, files and secrets must be outside the original legacy source');
  const database = new Database(configuration.databasePath, { fileMustExist: true }); let runtime;
  try { runtime = await createRuntime(configuration, database, { maintenance: false }); const principal = migrationPrincipal(database, process.env.CV_MIGRATION_API_KEY, options['--customer'] as any, runtime.now(), configuration.masterKey);
    const value = await new LegacyAdoptionService(runtime, source).adopt({ scope: { customerId: options['--customer'], workspaceId: options['--workspace'] } as any, principal, idempotencyKey: options['--idempotency-key'], request: { sourceFingerprint: options['--source-fingerprint'], targetConfigurationRef: options['--target-profile'], backupRoot: options['--backup-root'], reason: options['--reason'], sourceOffline: true } });
    process.stdout.write(JSON.stringify({ adoptionId: value.id, state: value.state, workspaceId: value.workspace.id, currentRevisionId: value.workspace.currentRevisionId, revisions: value.copies.length, backupDirectory: value.backup.directory }) + '\n');
  } finally { await runtime?.stop(); database.close(); }
}
main().catch(error => { process.stderr.write(JSON.stringify({ error: error.code ?? 'INVALID_REQUEST', message: error.message }) + '\n'); process.exitCode = 1; });
