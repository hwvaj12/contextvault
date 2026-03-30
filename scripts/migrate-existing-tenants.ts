/**
 * Migration Script: Provision TMKs for Existing Tenants
 * 
 * Run this script to backfill TMKs for tenants created before Phase 13.
 * Safe to run multiple times — will skip tenants that already have TMKs.
 * 
 * Usage:
 *   npx ts-node scripts/migrate-existing-tenants.ts
 * 
 * Or from the ContextVault root:
 *   npm run migrate:tenants
 */

import { createSecretsService } from '../src/services/secrets.service';
import { getTenantIds } from '../src/services/tenant.service';  // or your tenant query

// If no tenant service, we can query the DB directly
// import { db } from '../src/db';

async function migrateTenant(tenantId: string, secrets: ReturnType<typeof createSecretsService>): Promise<boolean> {
  const hasTmk = await secrets.hasTmk(tenantId);
  if (hasTmk) {
    console.log(`  ${tenantId}: already has TMK, skipping`);
    return false;
  }

  const tmk = await secrets.generateTmk(tenantId);
  console.log(`  ${tenantId}: provisioned TMK (keyId=${tmk.keyId})`);
  return true;
}

async function main(): Promise<void> {
  console.log('ContextVault TMK Migration\n');
  console.log('This script provisions TMKs for existing tenants.\n');

  const secrets = createSecretsService();

  // Get all existing tenant IDs
  // Replace this with your actual tenant query
  // For now, we'll query the database directly
  console.log('Fetching existing tenants...');
  
  try {
    // Example: query tenants table for tenant IDs
    // const tenants = db.query('SELECT id FROM tenants');
    // const tenantIds = tenants.map((t: { id: string }) => t.id);
    
    // For now, just list what's in the secrets store
    const existingSecrets = await secrets.listTenantIds();
    console.log(`Found ${existingSecrets.length} tenant(s) in secrets store\n`);
    
    if (existingSecrets.length > 0) {
      console.log('Tenants with TMKs:');
      for (const id of existingSecrets) {
        const tmk = await secrets.getTmk(id);
        console.log(`  ${id}: ${tmk?.keyId || 'unknown'}`);
      }
    }
    
    console.log('\nMigration check complete.');
    console.log('To run migration, update this script to query your tenant table.');
    
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

// Run if executed directly
main().catch(console.error);
