/**
 * Tenant Service — TMK Auto-Provisioning and Tenant Management
 * 
 * Handles TMK lifecycle for tenants/customers.
 * Integrated with auth via customerId.
 */

import { getSecretsService } from './secrets.service';

export interface TenantTMK {
  tmk: string;
  keyId: string;
  createdAt: string;
}

/**
 * Ensure TMK exists for a tenant, auto-provisioning if missing.
 * This is called on first API key verification for a new tenant.
 */
export async function ensureTenantTMK(customerId: string): Promise<TenantTMK> {
  const secrets = getSecretsService();
  
  // Check if TMK already exists
  const existing = await secrets.getTmk(customerId);
  if (existing) {
    return existing;
  }
  
  // Generate new TMK
  const tmk = await secrets.generateTmk(customerId);
  
  // Log the provisioning
  console.log(`[TENANT] TMK provisioned for ${customerId} (keyId=${tmk.keyId})`);
  
  return tmk;
}

/**
 * Get TMK for a tenant if it exists.
 */
export async function getTenantTMK(customerId: string): Promise<TenantTMK | null> {
  const secrets = getSecretsService();
  return secrets.getTmk(customerId);
}

/**
 * Check if tenant has TMK provisioned.
 */
export async function hasTenantTMK(customerId: string): Promise<boolean> {
  const secrets = getSecretsService();
  return secrets.hasTmk(customerId);
}

/**
 * List all tenants with provisioned TMKs.
 */
export async function listTenantsWithTMKs(): Promise<string[]> {
  const secrets = getSecretsService();
  return secrets.listTenantIds();
}
