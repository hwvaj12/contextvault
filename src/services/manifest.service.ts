/**
 * Manifest Service — Workspace Bundle Manifest Management
 * 
 * Builds signed manifests for workspace bundles.
 * Manifests contain file hashes for integrity verification
 * and Ed25519 signatures for authenticity.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  ManifestContent,
  SignatureResult,
  signManifest,
  verifyManifestSignature,
  hashFileContent,
  SigningKeyPair,
} from './signing.service';

export interface ManifestFile {
  path: string;
  size: number;
  hash: string;
}

export interface Manifest extends ManifestContent {
  signature: string;
}

export interface WorkspaceBundle {
  manifest: Manifest;
  files: Map<string, Buffer>;
}

export interface BuildManifestOptions {
  workspaceId: string;
  schemaVersion?: string;
  signingKey: Buffer;
  keyId: string;
}

/**
 * Build a signed manifest for a workspace.
 * Computes SHA-256 hashes of all files and signs the manifest.
 */
export async function buildManifest(
  workspaceDir: string,
  options: BuildManifestOptions
): Promise<Manifest> {
  const { workspaceId, schemaVersion = '1.0', signingKey, keyId } = options;

  // Collect and hash all files
  const files: ManifestFile[] = [];
  
  await addFilesRecursively(workspaceDir, '', files);

  // Create manifest content
  const manifestContent: ManifestContent = {
    version: '1.0',
    workspaceId,
    createdAt: new Date().toISOString(),
    schemaVersion,
    signatureAlgorithm: 'Ed25519',
    signedBy: 'contextvault',
    keyId,
    files,
  };

  // Sign the manifest
  const signatureResult: SignatureResult = signManifest(
    manifestContent,
    signingKey,
    keyId
  );

  // Combine into final manifest
  return {
    ...manifestContent,
    signature: signatureResult.signature,
  };
}

/**
 * Recursively add files to the manifest.
 */
async function addFilesRecursively(
  dir: string,
  basePath: string,
  files: ManifestFile[]
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await addFilesRecursively(fullPath, relativePath, files);
    } else if (entry.isFile()) {
      const stat = await fs.stat(fullPath);
      const content = await fs.readFile(fullPath);
      const hash = hashFileContent(content);

      files.push({
        path: relativePath,
        size: stat.size,
        hash,
      });
    }
  }
}

/**
 * Verify a manifest's signature.
 */
export function verifyManifest(
  manifest: Manifest,
  publicKey: Buffer
): boolean {
  return verifyManifestSignature(manifest, publicKey);
}

/**
 * Verify all file hashes in a manifest match the actual files.
 */
export async function verifyFileHashes(
  manifest: Manifest,
  workspaceDir: string
): Promise<{ valid: boolean; mismatches: string[] }> {
  const mismatches: string[] = [];

  for (const manifestFile of manifest.files) {
    const fullPath = path.join(workspaceDir, manifestFile.path);
    
    try {
      const content = await fs.readFile(fullPath);
      const hash = hashFileContent(content);
      
      if (hash !== manifestFile.hash) {
        mismatches.push(manifestFile.path);
      }
    } catch {
      // File missing
      mismatches.push(manifestFile.path);
    }
  }

  return {
    valid: mismatches.length === 0,
    mismatches,
  };
}

/**
 * Load manifest from a bundle directory.
 */
export async function loadManifest(bundleDir: string): Promise<Manifest> {
  const manifestPath = path.join(bundleDir, 'manifest.json');
  const content = await fs.readFile(manifestPath, 'utf8');
  return JSON.parse(content) as Manifest;
}

/**
 * Save manifest to a bundle directory.
 */
export async function saveManifest(
  bundleDir: string,
  manifest: Manifest
): Promise<void> {
  const manifestPath = path.join(bundleDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

/**
 * Create a workspace bundle directory structure.
 */
export async function createBundleDirectory(
  baseDir: string,
  workspaceId: string
): Promise<string> {
  const bundleDir = path.join(baseDir, `${workspaceId}.bundle`);
  await fs.mkdir(bundleDir, { recursive: true });
  return bundleDir;
}

/**
 * Extract a workspace bundle to a directory.
 */
export async function extractBundle(
  bundleSource: string,
  targetDir: string
): Promise<Manifest> {
  // Load manifest first
  const manifest = await loadManifest(bundleSource);

  // Extract all files
  for (const file of manifest.files) {
    const sourcePath = path.join(bundleSource, file.path);
    const targetPath = path.join(targetDir, file.path);
    
    // Create parent directory if needed
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    
    // Copy file
    await fs.copyFile(sourcePath, targetPath);
  }

  return manifest;
}

/**
 * Get the list of files in a bundle.
 */
export async function listBundleFiles(bundleDir: string): Promise<string[]> {
  const manifest = await loadManifest(bundleDir);
  return manifest.files.map(f => f.path);
}

/**
 * Calculate total size of bundle.
 */
export async function getBundleSize(bundleDir: string): Promise<number> {
  const manifest = await loadManifest(bundleDir);
  return manifest.files.reduce((sum, f) => sum + f.size, 0);
}

/**
 * Validate manifest structure without verifying signature.
 */
export function validateManifestStructure(manifest: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['Manifest must be an object'] };
  }

  const m = manifest as Record<string, unknown>;

  // Required fields
  const requiredFields = [
    'version',
    'workspaceId',
    'createdAt',
    'schemaVersion',
    'signatureAlgorithm',
    'signedBy',
    'keyId',
    'files',
    'signature',
  ];

  for (const field of requiredFields) {
    if (!(field in m)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Validate types
  if (m.files && !Array.isArray(m.files)) {
    errors.push('files must be an array');
  }

  if (m.signatureAlgorithm !== 'Ed25519') {
    errors.push('signatureAlgorithm must be Ed25519');
  }

  if (m.version !== '1.0') {
    errors.push(`Unsupported manifest version: ${m.version}`);
  }

  // Validate files array
  if (Array.isArray(m.files)) {
    for (let i = 0; i < m.files.length; i++) {
      const file = m.files[i] as Record<string, unknown>;
      if (!file.path || typeof file.path !== 'string') {
        errors.push(`files[${i}]: missing or invalid path`);
      }
      if (!file.hash || typeof file.hash !== 'string') {
        errors.push(`files[${i}]: missing or invalid hash`);
      }
      if (typeof file.size !== 'number') {
        errors.push(`files[${i}]: missing or invalid size`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
