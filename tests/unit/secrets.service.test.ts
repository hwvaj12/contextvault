/**
 * Tests for Secrets Service
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { LocalJsonProvider, SecretsService, TMK } from '../../src/services/secrets.service';

describe('SecretsService', () => {
  let tmpDir: string;
  let provider: LocalJsonProvider;
  let secrets: SecretsService;

  beforeEach(async () => {
    // Create temp directory for test secrets
    tmpDir = path.join(os.tmpdir(), `contextvault-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    
    provider = new LocalJsonProvider(tmpDir);
    secrets = new SecretsService(provider);
  });

  afterEach(async () => {
    // Cleanup
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('LocalJsonProvider', () => {
    it('should store and retrieve a secret', async () => {
      await secrets.setSecret('tenant_001', 'test_key', 'test_value');
      const value = await secrets.getSecret('tenant_001', 'test_key');
      expect(value).toBe('test_value');
    });

    it('should return null for missing tenant', async () => {
      const value = await secrets.getSecret('nonexistent', 'key');
      expect(value).toBeNull();
    });

    it('should return null for missing key', async () => {
      await secrets.setSecret('tenant_001', 'other_key', 'value');
      const value = await secrets.getSecret('tenant_001', 'missing_key');
      expect(value).toBeNull();
    });

    it('should delete a secret', async () => {
      await secrets.setSecret('tenant_001', 'to_delete', 'value');
      await secrets.deleteSecret('tenant_001', 'to_delete');
      const value = await secrets.getSecret('tenant_001', 'to_delete');
      expect(value).toBeNull();
    });

    it('should list tenant IDs', async () => {
      await secrets.setSecret('tenant_001', 'key', 'value');
      await secrets.setSecret('tenant_002', 'key', 'value');
      const ids = await secrets.listTenantIds();
      expect(ids).toContain('tenant_001');
      expect(ids).toContain('tenant_002');
    });

    it('should persist secrets to disk', async () => {
      await secrets.setSecret('tenant_001', 'persistent', 'data');
      
      // Create new provider with same path
      const newProvider = new LocalJsonProvider(tmpDir);
      const newSecrets = new SecretsService(newProvider);
      
      const value = await newSecrets.getSecret('tenant_001', 'persistent');
      expect(value).toBe('data');
    });
  });

  describe('TMK Generation', () => {
    it('should generate a 256-bit TMK', async () => {
      const tmk = await secrets.generateTmk('tenant_001');
      
      expect(tmk.tmk).toBeDefined();
      expect(tmk.keyId).toMatch(/^v1_\d+$/);
      expect(tmk.createdAt).toBeDefined();
      
      // TMK should be base64-encoded 32 bytes
      const decoded = Buffer.from(tmk.tmk, 'base64');
      expect(decoded.length).toBe(32);
    });

    it('should generate unique TMKs per tenant', async () => {
      const tmk1 = await secrets.generateTmk('tenant_001');
      const tmk2 = await secrets.generateTmk('tenant_002');
      
      // TMKs should be different (random 256-bit keys)
      expect(tmk1.tmk).not.toBe(tmk2.tmk);
      // Key IDs should be different (or at least both follow format)
      expect(tmk1.keyId).toMatch(/^v1_\d+$/);
      expect(tmk2.keyId).toMatch(/^v1_\d+$/);
    });

    it('should not regenerate existing TMK', async () => {
      const tmk1 = await secrets.generateTmk('tenant_001');
      const tmk2 = await secrets.generateTmk('tenant_001');
      
      expect(tmk1.keyId).toBe(tmk2.keyId);
      expect(tmk1.tmk).toBe(tmk2.tmk);
    });

    it('should check if tenant has TMK', async () => {
      const hasBefore = await secrets.hasTmk('tenant_001');
      expect(hasBefore).toBe(false);
      
      await secrets.generateTmk('tenant_001');
      
      const hasAfter = await secrets.hasTmk('tenant_001');
      expect(hasAfter).toBe(true);
    });

    it('should get TMK after generation', async () => {
      const generated = await secrets.generateTmk('tenant_001');
      const retrieved = await secrets.getTmk('tenant_001');
      
      expect(retrieved).not.toBeNull();
      expect(retrieved!.tmk).toBe(generated.tmk);
      expect(retrieved!.keyId).toBe(generated.keyId);
    });

    it('should return null for missing TMK', async () => {
      const tmk = await secrets.getTmk('nonexistent');
      expect(tmk).toBeNull();
    });

    it('should lazy-migrate with ensureTmk', async () => {
      const hasBefore = await secrets.hasTmk('tenant_001');
      expect(hasBefore).toBe(false);
      
      const tmk = await secrets.ensureTmk('tenant_001');
      expect(tmk).toBeDefined();
      
      const hasAfter = await secrets.hasTmk('tenant_001');
      expect(hasAfter).toBe(true);
    });
  });

  describe('SecretsService.createLocal', () => {
    it('should create service with local provider', () => {
      const service = SecretsService.createLocal('/tmp/test-secrets');
      expect(service).toBeInstanceOf(SecretsService);
    });
  });
});
