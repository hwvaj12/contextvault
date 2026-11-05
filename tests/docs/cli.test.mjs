import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const command = fileURLToPath(new URL('../../scripts/verify-workspace-docs.mjs', import.meta.url));
async function rejected(args, pattern, environment = {}) {
  try { await execute(process.execPath, [command, ...args], { env: { PATH: process.env.PATH, ...environment }, timeout: 5000 }); assert.fail('Invalid documentation selection succeeded'); }
  catch (error) { assert.equal(error.code, 1); assert.match(error.stderr, pattern); }
}
test('rejects unsupported documentation backends before starting fixtures', () => rejected(['--backend', 'unknown'], /--backend git or s3 is required/));
test('rejects S3 provider flags for a Git documentation run', () => rejected(['--backend', 'git', '--s3-provider', 'localstack'], /requires --backend s3/));
test('requires an actual selected S3 target before starting fixtures', () => rejected(['--backend', 's3', '--s3-provider', 'localstack'], /CV_TEST_S3_BUCKET/));
test('rejects unknown documentation arguments', () => rejected(['--unknown'], /Unknown documentation argument/));
test('rejects a missing provider flag value', () => rejected(['--backend', 'git', '--s3-provider'], /requires a value/));
test('rejects duplicate backend flags', () => rejected(['--backend', 'git', '--backend', 's3'], /Duplicate documentation argument/));
