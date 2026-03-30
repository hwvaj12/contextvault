/**
 * Tests for Signing Service
 */

import { describe, it, expect } from 'vitest';
import {
  generateSigningKeyPair,
  signManifest,
  verifySignature,
  verifyManifestSignature,
  hashFileContent,
  encodeKeyPair,
  decodeKeyPair,
  generateKeyId,
  ManifestContent,
  SigningKeyPair,
} from '../../src/services/signing.service';

describe('Signing Service', () => {
  describe('generateSigningKeyPair', () => {
    it('should generate a valid Ed25519 key pair', () => {
      const keyPair = generateSigningKeyPair();
      
      expect(keyPair.publicKey).toBeDefined();
      expect(keyPair.privateKey).toBeDefined();
      expect(keyPair.publicKey.type).toBe('public');
      expect(keyPair.privateKey.type).toBe('private');
    });

    it('should generate unique keys each time', () => {
      const keyPair1 = generateSigningKeyPair();
      const keyPair2 = generateSigningKeyPair();
      
      expect(keyPair1.publicKey.equals(keyPair2.publicKey)).toBe(false);
      expect(keyPair1.privateKey.equals(keyPair2.privateKey)).toBe(false);
    });
  });

  describe('signManifest and verifySignature', () => {
    it('should sign and verify a manifest', () => {
      const keyPair = generateSigningKeyPair();
      const keyId = generateKeyId(1);

      const manifest: ManifestContent = {
        version: '1.0',
        workspaceId: 'ws_test123',
        createdAt: '2026-03-30T12:00:00Z',
        schemaVersion: '1.0',
        signatureAlgorithm: 'Ed25519',
        signedBy: 'contextvault',
        keyId,
        files: [
          { path: 'file1.txt', size: 100, hash: 'sha256:abc123' },
          { path: 'file2.txt', size: 200, hash: 'sha256:def456' },
        ],
      };

      const result = signManifest(manifest, keyPair.privateKey, keyId);

      expect(result.algorithm).toBe('Ed25519');
      expect(result.keyId).toBe(keyId);
      expect(result.signature).toBeTruthy();
      expect(result.signedAt).toBeTruthy();

      const isValid = verifySignature(manifest, result.signature, keyPair.publicKey);
      expect(isValid).toBe(true);
    });

    it('should reject tampered content', () => {
      const keyPair = generateSigningKeyPair();
      const keyId = generateKeyId(1);

      const manifest: ManifestContent = {
        version: '1.0',
        workspaceId: 'ws_test123',
        createdAt: '2026-03-30T12:00:00Z',
        schemaVersion: '1.0',
        signatureAlgorithm: 'Ed25519',
        signedBy: 'contextvault',
        keyId,
        files: [
          { path: 'file1.txt', size: 100, hash: 'sha256:abc123' },
        ],
      };

      const result = signManifest(manifest, keyPair.privateKey, keyId);

      // Tamper with the content
      const tamperedManifest: ManifestContent = {
        ...manifest,
        workspaceId: 'ws_hacked',
      };

      const isValid = verifySignature(tamperedManifest, result.signature, keyPair.publicKey);
      expect(isValid).toBe(false);
    });

    it('should reject invalid signatures', () => {
      const keyPair = generateSigningKeyPair();

      const manifest: ManifestContent = {
        version: '1.0',
        workspaceId: 'ws_test123',
        createdAt: '2026-03-30T12:00:00Z',
        schemaVersion: '1.0',
        signatureAlgorithm: 'Ed25519',
        signedBy: 'contextvault',
        keyId: 'v1_test',
        files: [],
      };

      // Use a different key pair to sign
      const otherKeyPair = generateSigningKeyPair();
      const result = signManifest(manifest, otherKeyPair.privateKey, 'other');

      // Try to verify with original key
      const isValid = verifySignature(manifest, result.signature, keyPair.publicKey);
      expect(isValid).toBe(false);
    });
  });

  describe('verifyManifestSignature', () => {
    it('should verify manifest with embedded signature', () => {
      const keyPair = generateSigningKeyPair();
      const keyId = generateKeyId(1);

      const manifestContent: ManifestContent = {
        version: '1.0',
        workspaceId: 'ws_test123',
        createdAt: '2026-03-30T12:00:00Z',
        schemaVersion: '1.0',
        signatureAlgorithm: 'Ed25519',
        signedBy: 'contextvault',
        keyId,
        files: [],
      };

      const signatureResult = signManifest(manifestContent, keyPair.privateKey, keyId);

      const manifestWithSignature = {
        ...manifestContent,
        signature: signatureResult.signature,
      };

      const isValid = verifyManifestSignature(manifestWithSignature as any, keyPair.publicKey);
      expect(isValid).toBe(true);
    });

    it('should reject manifest without signature', () => {
      const keyPair = generateSigningKeyPair();

      const manifestWithoutSignature = {
        version: '1.0',
        workspaceId: 'ws_test123',
        createdAt: '2026-03-30T12:00:00Z',
        schemaVersion: '1.0',
        signatureAlgorithm: 'Ed25519',
        signedBy: 'contextvault',
        keyId: 'v1_test',
        files: [],
      };

      const isValid = verifyManifestSignature(manifestWithoutSignature as any, keyPair.publicKey);
      expect(isValid).toBe(false);
    });
  });

  describe('hashFileContent', () => {
    it('should generate consistent SHA-256 hashes', () => {
      const content = Buffer.from('Hello, World!');
      const hash1 = hashFileContent(content);
      const hash2 = hashFileContent(content);

      expect(hash1).toBe(hash2);
      expect(hash1.startsWith('sha256:')).toBe(true);
    });

    it('should generate different hashes for different content', () => {
      const hash1 = hashFileContent(Buffer.from('Hello'));
      const hash2 = hashFileContent(Buffer.from('World'));

      expect(hash1).not.toBe(hash2);
    });

    it('should produce 71-char hex string after prefix', () => {
      const hash = hashFileContent(Buffer.from('test'));
      const hex = hash.replace('sha256:', '');
      
      expect(hex.length).toBe(64);
      expect(/^[a-f0-9]+$/.test(hex)).toBe(true);
    });
  });

  describe('encodeKeyPair and decodeKeyPair', () => {
    it('should encode and decode a key pair', () => {
      const original = generateSigningKeyPair();
      const encoded = encodeKeyPair(original);
      const decoded: SigningKeyPair = decodeKeyPair(encoded);

      expect(decoded.publicKey.equals(original.publicKey)).toBe(true);
      expect(decoded.privateKey.equals(original.privateKey)).toBe(true);
    });

    it('should produce base64 strings', () => {
      const keyPair = generateSigningKeyPair();
      const encoded = encodeKeyPair(keyPair);

      expect(typeof encoded.publicKey).toBe('string');
      expect(typeof encoded.privateKey).toBe('string');
      expect(encoded.publicKey.length).toBeGreaterThan(0);
      expect(encoded.privateKey.length).toBeGreaterThan(0);
    });
  });

  describe('generateKeyId', () => {
    it('should generate key IDs with version', () => {
      const keyId = generateKeyId(1);
      expect(keyId.startsWith('v1_')).toBe(true);
    });

    it('should generate key IDs with timestamps', () => {
      // Key IDs include timestamps, they should be unique-ish
      const keyId1 = generateKeyId(1);
      const keyId2 = generateKeyId(1);
      
      // They might be the same if generated within same ms
      expect(keyId1).toMatch(/^v1_\d+$/);
      expect(keyId2).toMatch(/^v1_\d+$/);
    });
  });
});
