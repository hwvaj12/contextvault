/**
 * Config Service — Tenant Configuration and Environment Variables
 * 
 * Centralizes all environment variable access for ContextVault.
 * Provides type-safe access to:
 * - Tenant Master Key (TMK) for SQLCipher encryption
 * - Signing keys for workspace manifests
 * - API authentication
 * - Storage configuration
 */

/**
 * Tenant Master Key configuration.
 * Used for SQLCipher database encryption (future enhancement).
 */
export interface TenantKeyConfig {
  /** Base64-encoded 256-bit key for SQLCipher encryption */
  tenantKey: string | null;
  /** Whether TMK is required for this deployment */
  required: boolean;
}

/**
 * Signing key configuration for workspace manifests.
 */
export interface SigningKeyConfig {
  /** Base64-encoded Ed25519 private key (DER PKCS8) */
  privateKey: string | null;
  /** Base64-encoded Ed25519 public key (DER SPKI) */
  publicKey: string | null;
  /** Key ID for signature manifests (e.g., "v1_1743450000000") */
  keyId: string | null;
  /** Whether signing is required for exports */
  required: boolean;
}

/**
 * Main config interface.
 */
export interface AppConfig {
  /** Port to listen on */
  port: number;
  /** Environment (development, production) */
  env: "development" | "production" | "test";
  /** Tenant Master Key for SQLCipher */
  tenantKey: TenantKeyConfig;
  /** Workspace signing keys */
  signing: SigningKeyConfig;
  /** Data directory path */
  dataDir: string;
  /** Workspaces directory path */
  workspacesDir: string;
  /** Bundles directory for export/import */
  bundlesDir: string;
}

// ─── Environment Variable Access ─────────────────────────────────────────────

/**
 * Get Tenant Master Key from environment.
 * Returns null if not set (dev mode) or if key is invalid.
 */
export function getTenantKey(): TenantKeyConfig {
  const raw = process.env.CONTEXTVAULT_TENANT_KEY;

  if (!raw) {
    return {
      tenantKey: null,
      required: false,
    };
  }

  // Validate: should be base64-encoded 32 bytes (256-bit)
  try {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length !== 32) {
      console.warn(
        `[config] CONTEXTVAULT_TENANT_KEY: expected 32 bytes (got ${decoded.length}). ` +
        "Key will be ignored. Set a valid 32-byte base64 key."
      );
      return { tenantKey: null, required: false };
    }
    return {
      tenantKey: raw, // Store base64 as-is for SQLCipher
      required: true,
    };
  } catch {
    console.warn(
      "[config] CONTEXTVAULT_TENANT_KEY: invalid base64 encoding. Key will be ignored."
    );
    return { tenantKey: null, required: false };
  }
}

/**
 * Get signing key configuration from environment.
 * Keys should be DER-encoded base64 strings.
 */
export function getSigningKeyConfig(): SigningKeyConfig {
  const privateKey = process.env.CONTEXTVAULT_SIGNING_PRIVATE_KEY ?? null;
  const publicKey = process.env.CONTEXTVAULT_SIGNING_PUBLIC_KEY ?? null;
  const keyId = process.env.CONTEXTVAULT_SIGNING_KEY_ID ?? null;

  // If any signing key is configured, require all to be present
  const hasPartialConfig = privateKey || publicKey || keyId;
  const hasFullConfig = privateKey && publicKey && keyId;

  if (hasPartialConfig && !hasFullConfig) {
    console.warn(
      "[config] CONTEXTVAULT_SIGNING_* keys are partially configured. " +
      "All three (PRIVATE_KEY, PUBLIC_KEY, KEY_ID) must be set for signing to work."
    );
  }

  return {
    privateKey: hasFullConfig ? privateKey : null,
    publicKey: hasFullConfig ? publicKey : null,
    keyId: hasFullConfig ? keyId : null,
    required: false, // Signing is optional for dev, required for production
  };
}

// ─── Full App Config ─────────────────────────────────────────────────────────

let cachedConfig: AppConfig | null = null;

/**
 * Get the full application configuration.
 * Caches the result for subsequent calls.
 */
export function getConfig(): AppConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const tenantKey = getTenantKey();
  const signing = getSigningKeyConfig();

  const env = (process.env.NODE_ENV as AppConfig["env"]) || "development";

  cachedConfig = {
    port: parseInt(process.env.PORT || "3000", 10),
    env,
    tenantKey,
    signing,
    dataDir: process.env.CONTEXTVAULT_DATA_DIR || "./data",
    workspacesDir:
      process.env.CONTEXTVAULT_WORKSPACES_DIR || "./data/workspaces",
    bundlesDir:
      process.env.CONTEXTVAULT_BUNDLES_DIR || "./data/bundles",
  };

  return cachedConfig;
}

/**
 * Invalidate the config cache.
 * Useful for testing or hot-reload scenarios.
 */
export function invalidateConfigCache(): void {
  cachedConfig = null;
}

/**
 * Check if TMK is available for encryption.
 */
export function hasTenantKey(): boolean {
  return getConfig().tenantKey.tenantKey !== null;
}

/**
 * Check if signing keys are available.
 */
export function hasSigningKey(): boolean {
  const cfg = getConfig().signing;
  return cfg.privateKey !== null && cfg.publicKey !== null && cfg.keyId !== null;
}
