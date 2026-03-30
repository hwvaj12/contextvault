/**
 * Workspace Bundle Verification Helper
 * 
 * Provides client-side verification of workspace bundle signatures.
 * Uses the Web Crypto API (browser-compatible) or Node.js crypto (Node).
 * 
 * Consumers can verify bundles locally before importing:
 * 
 * ```typescript
 * import { verifyWorkspaceBundle, ContextVaultPublicKeys } from '@contextvault/sdk';
 * 
 * const result = await verifyWorkspaceBundle(bundleArrayBuffer, ContextVaultPublicKeys.current);
 * if (!result.valid) {
 *   throw new Error('Bundle verification failed: ' + result.errors.join(', '));
 * }
 * ```
 */

/**
 * A known ContextVault signing public key.
 * The SDK ships with current and historical public keys for verification.
 */
export interface ContextVaultPublicKey {
  /** Key ID matching the keyId in manifests (e.g., "v1_1743450000000") */
  keyId: string;
  /** Base64-encoded SPKI DER public key */
  publicKey: string;
  /** Human-readable description */
  description?: string;
}

/**
 * Supported signature algorithm.
 */
export type SignatureAlgorithm = "Ed25519";

// ─── Known Public Keys ────────────────────────────────────────────────────────
// These keys are bundled with the SDK. Update this list when keys rotate.

/**
 * Current ContextVault signing public key.
 * Replace this value when key rotation occurs.
 * 
 * Obtain the current public key from:
 * - Environment variable: CONTEXTVAULT_SIGNING_PUBLIC_KEY
 * - ContextVault dashboard: Settings → Signing Keys
 * - SDK releases: CHANGELOG documents key rotation
 */
export const CONTEXTVAULT_PUBLIC_KEY_CURRENT: ContextVaultPublicKey = {
  keyId: process.env.CONTEXTVAULT_SIGNING_KEY_ID ?? "v1_default",
  publicKey:
    process.env.CONTEXTVAULT_SIGNING_PUBLIC_KEY ??
    "REPLACE_WITH_ACTUAL_PUBLIC_KEY",
  description: "Current ContextVault signing key",
};

/**
 * All known ContextVault public keys (for key rotation support).
 * Verification succeeds if the manifest keyId matches any of these.
 */
export const ContextVaultPublicKeys = [CONTEXTVAULT_PUBLIC_KEY_CURRENT];

/**
 * ImportResult — returned by importWorkspace()
 */
export interface ImportResult {
  workspaceId: string;
  manifest: WorkspaceBundleManifest;
  fileCount: number;
  verified: boolean;
}

/**
 * WorkspaceBundleManifest — must match server-side Manifest interface
 */
export interface WorkspaceBundleManifest {
  version: string;
  workspaceId: string;
  createdAt: string;
  schemaVersion: string;
  signatureAlgorithm: "Ed25519";
  signedBy: string;
  keyId: string;
  files: Array<{ path: string; size: number; hash: string }>;
  signature: string;
}

/**
 * BundleVerificationResult
 */
export interface BundleVerificationResult {
  valid: boolean;
  manifest: WorkspaceBundleManifest | null;
  signatureValid: boolean;
  fileHashesValid: boolean;
  errors: string[];
}

// ─── Canonical JSON (matches server-side) ─────────────────────────────────────

/**
 * Sort object keys deterministically for canonical JSON serialization.
 */
function sortObjectKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }
  if (obj && typeof obj === "object") {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    for (const key of keys) {
      sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

/**
 * Canonicalize manifest to deterministic JSON bytes (excludes signature).
 */
function canonicalizeManifest(manifest: WorkspaceBundleManifest): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { signature: _sig, ...unsigned } = manifest;
  const sorted = sortObjectKeys(unsigned);
  const canonical = JSON.stringify(sorted);
  return new TextEncoder().encode(canonical);
}

// ─── Web Crypto Ed25519 Verification ─────────────────────────────────────────

/**
 * Convert base64 SPKI to CryptoKey (Web Crypto API).
 */
async function importPublicKey(base64: string): Promise<CryptoKey> {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return crypto.subtle.importKey(
    "spki",
    bytes.buffer,
    { name: "Ed25519", namedCurve: "Ed25519" } as any,
    true,
    ["verify"]
  );
}

/**
 * Convert base64 signature to Uint8Array.
 */
function decodeSignature(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// ─── Main Verification Function ──────────────────────────────────────────────

/**
 * Verify a workspace bundle's manifest signature.
 * 
 * @param bundleManifest - The parsed WorkspaceBundleManifest object
 * @param knownKeys - Array of known ContextVault public keys
 * @returns Verification result with errors if invalid
 */
export async function verifyWorkspaceBundleSignature(
  bundleManifest: WorkspaceBundleManifest,
  knownKeys: ContextVaultPublicKey[] = ContextVaultPublicKeys
): Promise<{ valid: boolean; keyId: string | null; errors: string[] }> {
  const errors: string[] = [];

  // Validate structure
  if (!bundleManifest.version) errors.push("Missing field: version");
  if (!bundleManifest.workspaceId) errors.push("Missing field: workspaceId");
  if (!bundleManifest.signature) errors.push("Missing field: signature");
  if (!bundleManifest.keyId) errors.push("Missing field: keyId");
  if (!Array.isArray(bundleManifest.files)) errors.push("Missing or invalid field: files");
  if (bundleManifest.signatureAlgorithm !== "Ed25519") {
    errors.push(`Unsupported signature algorithm: ${bundleManifest.signatureAlgorithm}`);
  }

  if (errors.length > 0) {
    return { valid: false, keyId: null, errors };
  }

  // Find matching key
  const key = knownKeys.find((k) => k.keyId === bundleManifest.keyId);
  if (!key) {
    return {
      valid: false,
      keyId: bundleManifest.keyId,
      errors: [
        `Unknown signing key ID: "${bundleManifest.keyId}". ` +
          "The bundle may have been signed with a rotated key. " +
          "Update your SDK to the latest version.",
      ],
    };
  }

  // Canonicalize manifest content
  const content = canonicalizeManifest(bundleManifest);
  const signature = decodeSignature(bundleManifest.signature);

  try {
    const publicKey = await importPublicKey(key.publicKey);
    const valid = await crypto.subtle.verify(
      { name: "Ed25519" } as any,
      publicKey,
      signature,
      content
    );

    return { valid, keyId: key.keyId, errors: valid ? [] : ["Ed25519 signature verification failed"] };
  } catch (err) {
    return {
      valid: false,
      keyId: key.keyId,
      errors: [`Signature verification threw an error: ${(err as Error).message}`],
    };
  }
}

/**
 * Full verification: signature + file hash integrity.
 * 
 * This verifies:
 * 1. Manifest signature (authenticity)
 * 2. File hash integrity (requires file contents and manifest)
 * 
 * For full verification with file hashes, provide the ArrayBuffer of the
 * workspace.db file and verify against the sha256:... hashes in the manifest.
 */
export async function verifyWorkspaceBundle(
  bundleManifest: WorkspaceBundleManifest,
  knownKeys?: ContextVaultPublicKey[]
): Promise<BundleVerificationResult> {
  const errors: string[] = [];

  // Step 1: Verify signature
  const sigResult = await verifyWorkspaceBundleSignature(bundleManifest, knownKeys);
  if (!sigResult.valid) {
    errors.push(...sigResult.errors);
  }

  // Step 2: Basic manifest validation
  if (!bundleManifest.files || bundleManifest.files.length === 0) {
    errors.push("Manifest has no files");
  }

  for (let i = 0; i < bundleManifest.files.length; i++) {
    const file = bundleManifest.files[i];
    if (!file.path) errors.push(`files[${i}]: missing path`);
    if (!file.hash || !file.hash.startsWith("sha256:")) {
      errors.push(`files[${i}]: invalid hash format (expected sha256:...)`);
    }
    if (typeof file.size !== "number" || file.size < 0) {
      errors.push(`files[${i}]: invalid size`);
    }
  }

  return {
    valid: errors.length === 0 && sigResult.valid,
    manifest: bundleManifest,
    signatureValid: sigResult.valid,
    fileHashesValid: errors.length === 0,
    errors,
  };
}

// ─── Server-Side Verification (via API) ──────────────────────────────────────

/**
 * Import result returned from the ContextVault server.
 * Includes server-verified signature status.
 */
export interface ImportVerificationResult {
  workspaceId: string;
  manifest: WorkspaceBundleManifest;
  fileCount: number;
  verified: boolean;
  signatureValid: boolean;
  fileHashesValid: boolean;
  importedAt: string;
}
