/**
 * Migration Script: Provision TMKs for Existing Tenants
 * 
 * This script provisions TMKs for tenants that were created before Phase 13.
 * Safe to run multiple times — will skip tenants that already have TMKs.
 * 
 * Usage:
 *   npx ts-node scripts/migrate-existing-tenants.ts
 * 
 * Or from the ContextVault root:
 *   npm run migrate:tenants
 */

import { createSecretsService, SecretsService } from '../src/services/secrets.service';
import { getDb } from '../src/db';

/**
 * Get all customer IDs from the database.
 */
function getAllCustomerIds(): string[] {
  const db = getDb();
  
  // Get customer IDs from api_keys table (each key is tied to a customer)
  const rows = db.prepare('SELECT DISTINCT customer_id FROM api_keys').all() as { customer_id: string }[];
  
  return rows.map(r => r.customer_id);
}

/**
 * Get customer IDs that already have TMKs in the secrets store.
 */
async function getTenantsWithTMKs(secrets: SecretsService): Promise<Set<string>> {
  const tenantIds = await secrets.listTenantIds();
  return new Set(tenantIds);
}

/**
 * Migrate a single tenant by provisioning a TMK.
 */
async function migrateTenant(
  customerId: string, 
  secrets: SecretsService
): Promise<{ customerId: string; keyId: string } | null> {
  // Check if already has TMK
  const hasTmk = await secrets.hasTmk(customerId);
  if (hasTmk) {
    console.log(`  ⏭️  ${customerId}: already has TMK, skipping`);
    return null;
  }

  // Generate TMK
  const tmk = await secrets.generateTmk(customerId);
  console.log(`  ✅ ${customerId}: provisioned TMK (keyId=${tmk.keyId})`);
  return { customerId, keyId: tmk.keyId };
}

/**
 * Main migration function.
 */
async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  ContextVault — TMK Migration for Existing Tenants');
  console.log('═══════════════════════════════════════════════════════\n');

  const secrets = createSecretsService();

  // Get all customer IDs from DB
  console.log('Fetching customer IDs from database...');
  const customerIds = getAllCustomerIds();
  console.log(`Found ${customerIds.length} customer(s) in database\n`);

  if (customerIds.length === 0) {
    console.log('No customers found. Nothing to migrate.');
    return;
  }

  // Get tenants that already have TMKs
  const tenantsWithTmk = await getTenantsWithTMKs(secrets);
  console.log(`${tenantsWithTmk.size} tenant(s) already have TMKs\n`);

  // Show status of each customer
  console.log('Customer Status:');
  for (const customerId of customerIds) {
    const has = tenantsWithTmk.has(customerId);
    console.log(`  ${has ? '✅' : '❌'} ${customerId}`);
  }
  console.log();

  // Migrate tenants without TMKs
  const toMigrate = customerIds.filter(id => !tenantsWithTmk.has(id));
  
  if (toMigrate.length === 0) {
    console.log('All customers already have TMKs. Migration complete! ✅\n');
    return;
  }

  console.log(`\nMigrating ${toMigrate.length} customer(s)...\n`);
  
  const migrated: { customerId: string; keyId: string }[] = [];
  
  for (const customerId of toMigrate) {
    const result = await migrateTenant(customerId, secrets);
    if (result) {
      migrated.push(result);
    }
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  Migration Summary');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Total customers: ${customerIds.length}`);
  console.log(`  Already had TMK: ${customerIds.length - toMigrate.length}`);
  console.log(`  Newly migrated: ${migrated.length}`);
  
  if (migrated.length > 0) {
    console.log('\n  Migrated customers:');
    for (const { customerId, keyId } of migrated) {
      console.log(`    • ${customerId} (${keyId})`);
    }
  }
  
  console.log('\nMigration complete! ✅\n');
}

// Run if executed directly
main().catch((error) => {
  console.error('\n❌ Migration failed:', error);
  process.exit(1);
});
