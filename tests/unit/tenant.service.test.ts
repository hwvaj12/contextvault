/**
 * Tests for Tenant Service
 * 
 * Tests TMK auto-provisioning via the SecretsService integration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Create a test version that directly uses SecretsService
import { SecretsService, LocalJsonProvider, TMK } from '../../src/services/secrets.service';

describe('Tenant Service', () => {
  let tmpDir: string;
  let secrets: SecretsService;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `contextvault-tenant-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    
    const provider = new LocalJsonProvider(tmpDir);
    secrets = new SecretsService(provider);
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // Simulates tenant service behavior with test secrets
  async function ensureTenantTMK(customerId: string, secretsSvc: SecretsService): Promise<TMK> {
    const existing = await secretsSvc.getTmk(customerId);
    if (existing) return existing;
    return secretsSvc.generateTmk(customerId);
  }

  async function hasTenantTMK(customerId: string, secretsSvc: SecretsService): Promise<boolean> {
    return secretsSvc.hasTmk(customerId);
  }

  async function getTenantTMK(customerId: string, secretsSvc: SecretsService): Promise<TMK | null> {
    return secretsSvc.getTmk(customerId);
  }

  describe('ensureTenantTMK', () => {
    it('should generate TMK for new tenant', async () => {
      const customerId = 'customer_001';
      
      const tmk = await ensureTenantTMK(customerId, secrets);
      
      expect(tmk).toBeDefined();
      expect(tmk.tmk).toBeDefined();
      expect(tmk.keyId).toMatch(/^v1_\d+$/);
      expect(tmk.createdAt).toBeDefined();
      
      // Verify TMK is valid base64 32 bytes
      const decoded = Buffer.from(tmk.tmk, 'base64');
      expect(decoded.length).toBe(32);
    });

    it('should return existing TMK if tenant already has one', async () => {
      const customerId = 'customer_002';
      
      const first = await ensureTenantTMK(customerId, secrets);
      const second = await ensureTenantTMK(customerId, secrets);
      
      expect(first.keyId).toBe(second.keyId);
      expect(first.tmk).toBe(second.tmk);
    });

    it('should provision unique TMKs for different tenants', async () => {
      const tmk1 = await ensureTenantTMK('tenant_001', secrets);
      const tmk2 = await ensureTenantTMK('tenant_002', secrets);
      
      expect(tmk1.tmk).not.toBe(tmk2.tmk);
    });

    it('should persist TMK across service restarts', async () => {
      const customerId = 'customer_003';
      
      // First session
      await ensureTenantTMK(customerId, secrets);
      
      // New service instance with same path
      const newProvider = new LocalJsonProvider(tmpDir);
      const newSecrets = new SecretsService(newProvider);
      
      const has = await hasTenantTMK(customerId, newSecrets);
      expect(has).toBe(true);
      
      const retrieved = await getTenantTMK(customerId, newSecrets);
      expect(retrieved).not.toBeNull();
    });
  });

  describe('hasTenantTMK', () => {
    it('should return false for tenant without TMK', async () => {
      const has = await hasTenantTMK('nonexistent', secrets);
      expect(has).toBe(false);
    });

    it('should return true for tenant with TMK', async () => {
      const customerId = 'customer_004';
      await ensureTenantTMK(customerId, secrets);
      
      const has = await hasTenantTMK(customerId, secrets);
      expect(has).toBe(true);
    });
  });

  describe('getTenantTMK', () => {
    it('should return TMK if tenant has one', async () => {
      const customerId = 'customer_005';
      const generated = await ensureTenantTMK(customerId, secrets);
      
      const retrieved = await getTenantTMK(customerId, secrets);
      
      expect(retrieved).not.toBeNull();
      expect(retrieved!.keyId).toBe(generated.keyId);
      expect(retrieved!.tmk).toBe(generated.tmk);
    });

    it('should return null if tenant has no TMK', async () => {
      const retrieved = await getTenantTMK('nonexistent_customer', secrets);
      expect(retrieved).toBeNull();
    });
  });

  describe('lazy migration', () => {
    it('should auto-generate TMK on first workspace access', async () => {
      const customerId = 'migrated_customer';
      
      // Simulate: first workspace access (no TMK)
      let hasBefore = await hasTenantTMK(customerId, secrets);
      expect(hasBefore).toBe(false);
      
      // First workspace operation triggers TMK generation
      const tmk = await ensureTenantTMK(customerId, secrets);
      expect(tmk).toBeDefined();
      
      // Now has TMK
      let hasAfter = await hasTenantTMK(customerId, secrets);
      expect(hasAfter).toBe(true);
      
      // Subsequent accesses use existing TMK
      const same = await ensureTenantTMK(customerId, secrets);
      expect(same.keyId).toBe(tmk.keyId);
    });
  });
});
