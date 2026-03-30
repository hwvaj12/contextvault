# Phase 12 Plan — Security Model Implementation

**Goal:** Implement tenant-level encryption, Ed25519 workspace signing, and secrets scanning.

**Start date:** 2026-03-30
**Status:** ✅ Core Implementation Complete — 2026-03-30

---

## Implementation Order

### Step 1: Signing Service (`src/services/signing.service.ts`) ✅

Ed25519 key generation and signature verification.

```typescript
interface SigningKeyPair {
  publicKey: crypto.KeyObject;  // Ed25519 public key
  privateKey: crypto.KeyObject;  // Ed25519 private key (never exposed to consumers)
}

interface SignatureResult {
  signature: string;       // base64
  algorithm: 'Ed25519';
  signedAt: string;         // ISO timestamp
  keyId: string;            // for key rotation
}

// Generate new key pair (for ContextVault service)
function generateSigningKeyPair(): SigningKeyPair;

// Sign manifest content
function signManifest(manifest: ManifestContent, privateKey: crypto.KeyObject): SignatureResult;

// Verify signature
function verifySignature(manifest: ManifestContent, signature: string, publicKey: crypto.KeyObject): boolean;
```

**Dependencies:** Node.js `crypto` module (built-in, no npm needed)

---

### Step 2: Secrets Scanner (`src/utils/secrets-scanner.ts`) ✅

Scan content for embedded secrets before workspace export.

```typescript
interface SecretFinding {
  pattern: string;
  line: number;
  match: string;
  severity: 'critical' | 'high' | 'medium';
}

interface ScanResult {
  clean: boolean;
  findings: SecretFinding[];
}

const DANGER_PATTERNS = [
  { pattern: /password\s*=/i, severity: 'critical' },
  { pattern: /api[_-]?key\s*=\s*['"]?[a-zA-Z0-9_-]{20,}/i, severity: 'critical' },
  { pattern: /BEGIN\s+(RSA|EC|DSA)?\s*PRIVATE\s+KEY/i, severity: 'critical' },
  // ... 30+ patterns total
];

function scanContent(content: string, filePath: string): SecretFinding[];
function scanWorkspace(workspacePath: string): Promise<void>;  // throws if secrets found
```

---

### Step 3: Manifest Builder (`src/services/manifest.service.ts`) ✅

Build signed workspace manifests.

```typescript
interface ManifestFile {
  path: string;
  size: number;
  hash: string;  // sha256:abc...
}

interface Manifest extends ManifestContent {
  signature: string;  // base64
}

function buildManifest(workspaceDir: string, options: BuildManifestOptions): Promise<Manifest>;
function verifyManifest(manifest: Manifest, publicKey: crypto.KeyObject): boolean;
```

---

### Step 4: Tests ✅

```typescript
// tests/security/
signing.test.ts           - 14 tests: Ed25519 sign/verify, key encode/decode
secrets-scanner.test.ts   - 19 tests: Pattern detection, sanitization
```

---

## Files Created

```
src/
├── services/
│   ├── signing.service.ts      # ✅ Ed25519 signing
│   └── manifest.service.ts     # ✅ Manifest builder
├── utils/
│   └── secrets-scanner.ts     # ✅ Secrets detection
└── ...

tests/
└── security/
    ├── signing.test.ts         # ✅ 14 tests
    └── secrets-scanner.test.ts # ✅ 19 tests
```

---

## Dependencies

- **Node.js crypto** (built-in) — Ed25519, SHA-256
- **No new npm packages** — keep it minimal

---

## Checklist

- [x] Create SECURITY_MODEL.md with architecture
- [x] Step 1: Implement signing service
- [x] Step 2: Implement secrets scanner
- [x] Step 3: Implement manifest builder
- [x] Step 4: Write tests (33 passing)
- [ ] Step 5: Update config service (pending — TMK env vars)
- [ ] Step 6: Integrate with workspace export flow
- [ ] Step 7: Integrate with workspace import flow
- [ ] Step 8: SDK types for bundle verification
- [ ] Update existing documentation

---

## Remaining Work

1. **TMK Configuration** — Add `CONTEXTVAULT_TENANT_KEY` env var handling to config service
2. **Workspace Export Integration** — Use manifest builder + secrets scanner in `workspace.service.ts`
3. **Workspace Import Integration** — Verify signatures on import
4. **SQLCipher Encryption** — Future enhancement (v1.1), requires storage layer changes

---

_Last updated: 2026-03-30_
