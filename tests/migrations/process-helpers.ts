import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { migrationPrincipal } from '../../src/adapters/control/migration-auth';
import { StorageMigrationService, type TransferInput } from '../../src/application/migrations/storage';
import type { migrationFixture } from './helpers';
const root = resolve(import.meta.dirname, '../..');
type Fixture = Awaited<ReturnType<typeof migrationFixture>>;
export function transferInput(f: Fixture, workspaceId: string, key = 'recover-transfer'): TransferInput {
  return { scope: { customerId: f.client.customerA, workspaceId } as any, principal: migrationPrincipal(f.app.contextVault.database, f.client.keyA, f.client.customerA, f.app.contextVault.now()), idempotencyKey: key,
    request: { targetConfigurationRef: f.configuration.profiles.find(value => value.backend === 's3')!.configurationRef, backupRoot: join(f.directory, 'backups'), reason: 'verify fenced process recovery' } };
}
export async function pauseTransfer(f: Fixture, workspaceId: string, stage: string, key = 'recover-transfer') {
  const input = transferInput(f, workspaceId, key);
  const child = fork(join(root, 'tests/migrations/transfer-worker.ts'), [], { cwd: root, execArgv: ['-r', join(root, 'node_modules/ts-node/register/transpile-only')], env: { PATH: process.env.PATH, TS_NODE_PROJECT: join(root, 'tsconfig.json'), ...f.storage, CV_STORAGE_BACKEND: 'git', CV_DATA_DIR: f.configuration.dataDirectory, CV_PROCESSING_TTL_MS: stage === 'after-switch' ? '10000' : '5000', CV_MIGRATION_API_KEY: f.client.keyA, CV_TRANSFER_INPUT: JSON.stringify(input), CV_TRANSFER_PAUSE: stage }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let errors = ''; child.stderr!.on('data', value => { errors += value; }); child.stdout!.resume();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const selected = await new Promise<any>((resolve, reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Migration worker did not reach ${stage}: ${errors}`)); }, 20000); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); reject(new Error(`Migration worker exited ${code}: ${errors}`)); }); child.once('message', value => { clearTimeout(timer); resolve(value); }); });
  return { input, migration: selected.migration, async kill() { child.kill('SIGKILL'); return exited; } };
}
export async function waitClaim(migration: any) { const delay = Date.parse(migration.claim.expiresAt) - Date.now() + 50; if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay)); }
export const service = (f: Fixture) => new StorageMigrationService(f.app.contextVault);
export async function resumeTransfer(f: Fixture, input: TransferInput) {
  const result = await promisify(execFile)(process.execPath, ['-r', join(root, 'node_modules/ts-node/register/transpile-only'), join(root, 'scripts/migrate-storage.ts'), 'transfer', '--customer', input.scope.customerId, '--workspace', input.scope.workspaceId, '--target-profile', input.request.targetConfigurationRef, '--backup-root', input.request.backupRoot, '--idempotency-key', input.idempotencyKey, '--reason', input.request.reason], { cwd: root, env: { PATH: process.env.PATH, TS_NODE_PROJECT: join(root, 'tsconfig.json'), ...f.storage, CV_STORAGE_BACKEND: 'git', CV_DATA_DIR: f.configuration.dataDirectory, CV_MIGRATION_API_KEY: f.client.keyA }, timeout: 30000, maxBuffer: 1024 * 1024 }); return JSON.parse(result.stdout);
}
