/**
 * Secrets Service — TMK Auto-Provisioning via Pluggable Providers
 * 
 * Provides a secrets abstraction with local JSON backend.
 * Can be swapped for Doppler/Vault/AWS in production.
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface TMK {
  tmk: string;          // base64-encoded 256-bit key
  keyId: string;        // v1_timestamp format
  createdAt: string;    // ISO timestamp
}

export interface TenantSecrets {
  tmk?: TMK;
  [key: string]: unknown;
}

export interface SecretsProvider {
  getSecret(tenantId: string, key: string): Promise<string | null>;
  setSecret(tenantId: string, key: string, value: string): Promise<void>;
  deleteSecret(tenantId: string, key: string): Promise<void>;
  listTenantIds(): Promise<string[]>;
}

/**
 * Local JSON file-based secrets provider.
 * Stores secrets in a single JSON file for simplicity.
 */
export class LocalJsonProvider implements SecretsProvider {
  private filePath: string;
  private data: Record<string, TenantSecrets> = {};
  private loaded = false;

  constructor(secretsPath: string) {
    // If secretsPath is a directory, use default filename
    this.filePath = secretsPath.endsWith('.json') 
      ? secretsPath 
      : path.join(secretsPath, 'tenant-keys.json');
  }

  /**
   * Lazily load secrets from disk.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      this.data = JSON.parse(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist yet — start empty
        this.data = {};
      } else {
        throw error;
      }
    }
    this.loaded = true;
  }

  /**
   * Persist secrets to disk.
   */
  private async persist(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  async getSecret(tenantId: string, key: string): Promise<string | null> {
    await this.ensureLoaded();
    const tenant = this.data[tenantId];
    if (!tenant) return null;
    const value = (tenant as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : null;
  }

  async setSecret(tenantId: string, key: string, value: string): Promise<void> {
    await this.ensureLoaded();
    if (!this.data[tenantId]) {
      this.data[tenantId] = {};
    }
    (this.data[tenantId] as Record<string, unknown>)[key] = value;
    await this.persist();
  }

  async deleteSecret(tenantId: string, key: string): Promise<void> {
    await this.ensureLoaded();
    if (this.data[tenantId]) {
      delete (this.data[tenantId] as Record<string, unknown>)[key];
      await this.persist();
    }
  }

  async listTenantIds(): Promise<string[]> {
    await this.ensureLoaded();
    return Object.keys(this.data);
  }
}

/**
 * SecretsService — manages tenant secrets with TMK auto-provisioning.
 */
export class SecretsService {
  private provider: SecretsProvider;

  constructor(provider: SecretsProvider) {
    this.provider = provider;
  }

  /**
   * Create a SecretsService with local JSON backend.
   */
  static createLocal(secretsPath: string): SecretsService {
    const provider = new LocalJsonProvider(secretsPath);
    return new SecretsService(provider);
  }

  /**
   * Generate a new Tenant Master Key for a tenant.
   */
  async generateTmk(tenantId: string): Promise<TMK> {
    // Check if TMK already exists
    const existing = await this.getTmk(tenantId);
    if (existing) {
      return existing;
    }

    // Generate new 256-bit key
    const keyBytes = crypto.randomBytes(32);
    const tmk: TMK = {
      tmk: keyBytes.toString('base64'),
      keyId: `v1_${Date.now()}`,
      createdAt: new Date().toISOString(),
    };

    // Store via provider
    await this.provider.setSecret(tenantId, 'tmk', JSON.stringify(tmk));

    return tmk;
  }

  /**
   * Get TMK for a tenant.
   */
  async getTmk(tenantId: string): Promise<TMK | null> {
    const stored = await this.provider.getSecret(tenantId, 'tmk');
    if (!stored) return null;
    
    try {
      return JSON.parse(stored) as TMK;
    } catch {
      return null;
    }
  }

  /**
   * Check if tenant has TMK provisioned.
   */
  async hasTmk(tenantId: string): Promise<boolean> {
    const tmk = await this.getTmk(tenantId);
    return tmk !== null;
  }

  /**
   * Ensure tenant has TMK, generating if missing (lazy migration).
   */
  async ensureTmk(tenantId: string): Promise<TMK> {
    const existing = await this.getTmk(tenantId);
    if (existing) return existing;
    return this.generateTmk(tenantId);
  }

  /**
   * Generic secret operations.
   */
  async getSecret(tenantId: string, key: string): Promise<string | null> {
    return this.provider.getSecret(tenantId, key);
  }

  async setSecret(tenantId: string, key: string, value: string): Promise<void> {
    return this.provider.setSecret(tenantId, key, value);
  }

  async deleteSecret(tenantId: string, key: string): Promise<void> {
    return this.provider.deleteSecret(tenantId, key);
  }

  /**
   * List all tenant IDs with secrets.
   */
  async listTenantIds(): Promise<string[]> {
    return this.provider.listTenantIds();
  }
}

// ============================================================================
// Configuration
// ============================================================================

import { getConfig } from './config.service';

/**
 * Create SecretsService based on environment configuration.
 */
export function createSecretsService(): SecretsService {
  const backend = process.env.CONTEXTVAULT_SECRETS_BACKEND || 'local';
  const secretsPath = process.env.CONTEXTVAULT_SECRETS_PATH || './data/secrets';

  switch (backend) {
    case 'local':
      return SecretsService.createLocal(secretsPath);
    // Future: case 'doppler': return SecretsService.createDoppler(token);
    // Future: case 'aws': return SecretsService.createAws();
    default:
      console.warn(`Unknown secrets backend "${backend}", falling back to local`);
      return SecretsService.createLocal(secretsPath);
  }
}

// Singleton instance
let _instance: SecretsService | null = null;

export function getSecretsService(): SecretsService {
  if (!_instance) {
    _instance = createSecretsService();
  }
  return _instance;
}
