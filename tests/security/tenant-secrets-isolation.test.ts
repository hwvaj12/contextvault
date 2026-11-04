import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'vitest';

type ScenarioContext = {
  provider: typeof import('../../src/services/secrets.service');
  fs: typeof import('node:fs/promises');
  path: typeof import('node:path');
  assert: typeof import('node:assert/strict');
  directory: string;
};

const execute = promisify(execFile);

// Each scenario owns a process because the unfixed provider mutates built-in prototypes.
async function isolated(scenario: (context: ScenarioContext) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cv-tenant-secrets-'));
  const sourcePath = path.resolve('src/services/secrets.service.ts');
  const script = `
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const ts = require('typescript');
    (async () => {
      const sourcePath = process.argv[1];
      const source = await fs.readFile(sourcePath, 'utf8');
      const compiled = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
      }).outputText;
      const implementation = new Module(sourcePath, module);
      implementation.filename = sourcePath;
      implementation.paths = Module._nodeModulePaths(path.dirname(sourcePath));
      implementation._compile(compiled, sourcePath);
      await (${scenario.toString()})({
        provider: implementation.exports, fs, path, assert, directory: process.argv[2]
      });
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  try {
    await execute(process.execPath, ['-e', script, sourcePath, directory], { timeout: 15000 });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

describe('tenant secret dictionary isolation', () => {
  it('isolates a special tenant TMK on both missing-file path forms', async () => {
    await isolated(async ({ provider: { LocalJsonProvider, SecretsService }, path, assert, directory }) => {
      for (const location of ['new-directory', 'new-file.json']) {
        const secretsPath = path.join(directory, location);
        const secrets = new SecretsService(new LocalJsonProvider(secretsPath));
        assert.deepEqual(await secrets.listTenantIds(), []);
        await secrets.setSecret('existing-tenant', 'own', 'fixture-existing');
        const tmk = { tmk: 'synthetic-tmk-only', keyId: 'fixture-v1', createdAt: '2026-11-04T00:00:00.000Z' };
        await secrets.setSecret('__proto__', 'tmk', JSON.stringify(tmk));

        assert.deepEqual({
          prototypeIntact: !Object.hasOwn(Object.prototype, 'tmk'),
          existingTenantIsolated: await secrets.getTmk('existing-tenant') === null,
          missingTenantIsolated: await secrets.getTmk('missing-tenant') === null,
          specialTenantListed: (await secrets.listTenantIds()).includes('__proto__'),
        }, {
          prototypeIntact: true,
          existingTenantIsolated: true,
          missingTenantIsolated: true,
          specialTenantListed: true,
        });
        assert.equal(JSON.stringify(await secrets.ensureTmk('__proto__')) === JSON.stringify(tmk), true);
        const otherTmk = await secrets.ensureTmk('existing-tenant');
        assert.equal(otherTmk.tmk === tmk.tmk, false);

        const reloaded = SecretsService.createLocal(secretsPath);
        assert.equal(JSON.stringify(await reloaded.getTmk('__proto__')) === JSON.stringify(tmk), true);
        assert.equal((await reloaded.getTmk('existing-tenant'))?.tmk === otherTmk.tmk, true);
        assert.equal(await reloaded.getTmk('missing-tenant'), null);
      }
    });
  });

  it('round-trips reserved-looking tenant and secret names through reload and deletion', async () => {
    await isolated(async ({ provider: { LocalJsonProvider }, path, assert, directory }) => {
      const file = path.join(directory, 'reserved.json');
      const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '__defineGetter__', 'prototype'];
      const prototypeNames = Object.getOwnPropertyNames(Object.prototype);
      const constructorNames = Object.getOwnPropertyNames(Object);
      const provider = new LocalJsonProvider(file);
      for (const [tenantIndex, tenant] of names.entries()) {
        for (const [keyIndex, key] of names.entries()) {
          await provider.setSecret(tenant, key, `fixture-${tenantIndex}-${keyIndex}`);
        }
      }
      assert.deepEqual(Object.getOwnPropertyNames(Object.prototype), prototypeNames);
      assert.deepEqual(Object.getOwnPropertyNames(Object), constructorNames);
      const reloaded = new LocalJsonProvider(file);
      assert.deepEqual((await reloaded.listTenantIds()).sort(), [...names].sort());
      for (const [tenantIndex, tenant] of names.entries()) {
        for (const [keyIndex, key] of names.entries()) {
          assert.equal(await reloaded.getSecret(tenant, key) === `fixture-${tenantIndex}-${keyIndex}`, true);
        }
      }
      await reloaded.deleteSecret('__proto__', '__proto__');
      await reloaded.deleteSecret('missing-tenant', 'constructor');
      const afterDeletion = new LocalJsonProvider(file);
      assert.equal(await afterDeletion.getSecret('__proto__', '__proto__'), null);
      assert.equal(await afterDeletion.getSecret('constructor', '__proto__') === 'fixture-1-0', true);
      assert.deepEqual((await afterDeletion.listTenantIds()).sort(), [...names].sort());
    });
  });

  it('preserves all valid loaded fields and secret bytes without rewriting reads', async () => {
    await isolated(async ({ provider: { LocalJsonProvider, SecretsService }, fs, path, assert, directory }) => {
      const file = path.join(directory, 'existing.json');
      const tmk = JSON.stringify({ tmk: 'synthetic-existing-tmk', keyId: 'existing-v1', createdAt: '2026-11-01T00:00:00Z' }, null, 1);
      const original = JSON.parse('{"__proto__":{"__proto__":"fixture-proto","constructor":"fixture-constructor","toString":"fixture-string","metadata":{"__proto__":{"retained":true}},"list":[1,null,false],"count":3,"enabled":false,"nullable":null},"ordinary":{"byteValue":"\\u0000\\r\\n café 🔐","tmk":""},"constructor":{"toString":"fixture-tenant-constructor"},"toString":{"constructor":"fixture-tenant-string"}}');
      original.ordinary.tmk = tmk;
      const bytes = `\n${JSON.stringify(original, null, 4)}\n`;
      await fs.writeFile(file, bytes, 'utf8');
      const provider = new LocalJsonProvider(file);
      const secrets = new SecretsService(provider);
      assert.equal(await provider.getSecret('__proto__', '__proto__') === 'fixture-proto', true);
      assert.equal(await provider.getSecret('constructor', 'toString') === 'fixture-tenant-constructor', true);
      assert.equal(await provider.getSecret('toString', 'constructor') === 'fixture-tenant-string', true);
      assert.equal(Buffer.from((await provider.getSecret('ordinary', 'byteValue'))!).equals(Buffer.from(original.ordinary.byteValue)), true);
      assert.equal(JSON.stringify(await secrets.ensureTmk('ordinary')) === JSON.stringify(JSON.parse(tmk)), true);
      assert.equal(await provider.getSecret('__proto__', 'metadata'), null);
      assert.equal(await provider.getSecret('__proto__', 'nullable'), null);
      assert.equal(await fs.readFile(file, 'utf8') === bytes, true);

      await provider.setSecret('__proto__', 'new-secret', 'fixture-new');
      await provider.setSecret('__defineGetter__', '__proto__', 'fixture-new-tenant');
      await provider.deleteSecret('__proto__', 'constructor');
      original.__proto__['new-secret'] = 'fixture-new';
      delete original.__proto__.constructor;
      original.__defineGetter__ = JSON.parse('{"__proto__":"fixture-new-tenant"}');
      assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), original);
      const reloaded = new LocalJsonProvider(file);
      assert.equal(await reloaded.getSecret('ordinary', 'tmk') === tmk, true);
      assert.equal(await reloaded.getSecret('__proto__', 'constructor'), null);
      assert.equal(await reloaded.getSecret('__defineGetter__', '__proto__') === 'fixture-new-tenant', true);
      assert.equal(Object.hasOwn(Object.prototype, 'new-secret'), false);
    });
  });

  it('ignores inherited tenant and secret properties during reads and deletion', async () => {
    await isolated(async ({ provider: { LocalJsonProvider }, fs, path, assert, directory }) => {
      const file = path.join(directory, 'inherited.json');
      await fs.writeFile(file, '{"ordinary":{"own":"fixture-own"}}', 'utf8');
      // This synthetic inherited field exists only in this owned child process.
      Object.defineProperty(Object.prototype, 'cv31_inherited_secret', {
        value: 'fixture-inherited', writable: true, enumerable: true, configurable: true,
      });
      const provider = new LocalJsonProvider(file);
      for (const tenant of ['ordinary', '__proto__', 'constructor', 'toString', 'missing-tenant']) {
        assert.equal(await provider.getSecret(tenant, 'cv31_inherited_secret') === null, true);
      }
      for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
        assert.equal(await provider.getSecret('ordinary', key), null);
      }
      const bytes = await fs.readFile(file, 'utf8');
      await provider.deleteSecret('__proto__', 'cv31_inherited_secret');
      assert.equal(Object.hasOwn(Object.prototype, 'cv31_inherited_secret'), true);
      assert.equal(await fs.readFile(file, 'utf8') === bytes, true);
      assert.deepEqual(await provider.listTenantIds(), ['ordinary']);
    });
  });

  it('rejects invalid loaded dictionaries without replacing their bytes', async () => {
    await isolated(async ({ provider: { LocalJsonProvider }, fs, path, assert, directory }) => {
      const invalid = ['null', '[]', '"scalar"', '{"tenant":null}', '{"tenant":[]}', '{"tenant":"scalar"}', '{invalid'];
      for (const [index, bytes] of invalid.entries()) {
        const file = path.join(directory, `invalid-${index}.json`);
        await fs.writeFile(file, bytes, 'utf8');
        const provider = new LocalJsonProvider(file);
        await assert.rejects(() => provider.getSecret('tenant', 'key'));
        await assert.rejects(() => provider.setSecret('new-tenant', 'key', 'fixture-new'));
        assert.equal(await fs.readFile(file, 'utf8') === bytes, true);
      }
    });
  });
});
