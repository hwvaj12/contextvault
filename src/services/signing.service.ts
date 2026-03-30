/**
 * Signing Service — Ed25519 Workspace Signing
 * 
 * Provides Ed25519 key generation, signing, and verification for workspace bundles.
 * Uses Node.js built-in crypto module (no external dependencies).
 */

import * as crypto from 'crypto';
import * as fs from 'crypto';

export interface SigningKeyPair {
  publicKey: crypto.KeyObject;   // Ed25519 public key
  privateKey: crypto.KeyObject;   // Ed25519 private key
}

export interface SignatureResult {
  signature: string;       // base64 encoded
  algorithm: 'Ed25519';
  signedAt: string;        // ISO timestamp
  keyId: string;           // for key rotation
}

export interface ManifestContent {
  version: string;
  workspaceId: string;
  createdAt: string;
  schemaVersion: string;
  signatureAlgorithm: string;
  signedBy: string;
  keyId: string;
  files: Array<{
    path: string;
    size: number;
    hash: string;
  }>;
  signature?: string;  // Optional when verifying content
}

/**
 * Generate a new Ed25519 key pair for signing.
 */
export function generateSigningKeyPair(): SigningKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKey, privateKey };
}

/**
 * Sign manifest content with Ed25519 private key.
 * Returns base64-encoded signature with metadata.
 */
export function signManifest(
  manifest: ManifestContent,
  privateKey: crypto.KeyObject | Buffer,
  keyId: string
): SignatureResult {
  // Canonicalize manifest to JSON bytes (deterministic)
  const content = canonicalizeManifest(manifest);
  
  // Ensure we have a KeyObject
  const keyObj = privateKey instanceof crypto.KeyObject 
    ? privateKey 
    : createKeyObject(privateKey, 'private');
  
  // Sign using Ed25519 (null algorithm for Ed25519 in Node.js)
  const signature = crypto.sign(null, content, keyObj);
  
  return {
    signature: signature.toString('base64'),
    algorithm: 'Ed25519',
    signedAt: new Date().toISOString(),
    keyId,
  };
}

/**
 * Verify Ed25519 signature of manifest content.
 */
export function verifySignature(
  manifest: ManifestContent,
  signature: string,
  publicKey: crypto.KeyObject | Buffer
): boolean {
  try {
    const content = canonicalizeManifest(manifest);
    const signatureBytes = Buffer.from(signature, 'base64');
    
    // Ensure we have a KeyObject
    const keyObj = publicKey instanceof crypto.KeyObject 
      ? publicKey 
      : createKeyObject(publicKey, 'public');
    
    // Verify using Ed25519 (null algorithm for Ed25519 in Node.js)
    return crypto.verify(null, content, keyObj, signatureBytes);
  } catch {
    return false;
  }
}

/**
 * Create a KeyObject from DER-encoded key material.
 */
function createKeyObject(der: Buffer, type: 'public' | 'private'): crypto.KeyObject {
  if (type === 'public') {
    return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } else {
    return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  }
}

/**
 * Verify signature from a complete manifest with embedded signature.
 * The signature field is excluded from the content being verified.
 */
export function verifyManifestSignature(
  manifest: ManifestContent,
  publicKey: crypto.KeyObject | Buffer
): boolean {
  // Extract signature and create content without it
  const { signature, ...contentWithoutSig } = manifest;
  
  if (!signature) {
    return false;
  }
  
  return verifySignature(contentWithoutSig as ManifestContent, signature, publicKey);
}

/**
 * Create a SHA-256 hash of file content.
 * Returns hex-encoded hash with prefix.
 */
export function hashFileContent(content: Buffer): string {
  const hash = crypto.createHash('sha256');
  hash.update(content);
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Canonicalize manifest to deterministic JSON bytes.
 * Excludes the signature field.
 */
function canonicalizeManifest(manifest: ManifestContent): Buffer {
  // Remove signature if present (for re-signing)
  const { signature: _sig, ...unsigned } = manifest;
  
  // Sort keys for deterministic output
  const sorted = sortObjectKeys(unsigned);
  const canonical = JSON.stringify(sorted);
  
  return Buffer.from(canonical, 'utf8');
}

function sortObjectKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }
  if (obj && typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    for (const key of keys) {
      sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

// ============================================================================
// Key Management Utilities
// ============================================================================

export interface EncodedKeyPair {
  publicKey: string;  // base64 encoded DER
  privateKey: string;  // base64 encoded DER
}

/**
 * Encode signing key pair to base64 for storage/env vars.
 */
export function encodeKeyPair(keyPair: SigningKeyPair): EncodedKeyPair {
  return {
    publicKey: keyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: keyPair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

/**
 * Decode signing key pair from base64 storage.
 */
export function decodeKeyPair(encoded: EncodedKeyPair): SigningKeyPair {
  return {
    publicKey: crypto.createPublicKey({
      key: Buffer.from(encoded.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    }),
    privateKey: crypto.createPrivateKey({
      key: Buffer.from(encoded.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    }),
  };
}

/**
 * Generate a key ID for key rotation.
 * Format: v{version}_{timestamp}
 */
export function generateKeyId(version: number = 1): string {
  return `v${version}_${Date.now()}`;
}

// ============================================================================
// Convenience Exports
// ============================================================================

/**
 * Quick sign helper — generates a one-time key pair, signs, returns both.
 * For testing or one-off signing where key persistence isn't needed.
 */
export function signOnce(manifest: ManifestContent): {
  keyPair: SigningKeyPair;
  result: SignatureResult;
} {
  const keyPair = generateSigningKeyPair();
  const keyId = generateKeyId();
  const result = signManifest(manifest, keyPair.privateKey, keyId);
  return { keyPair, result };
}
