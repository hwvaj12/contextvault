/**
 * Secrets Scanner — Detect embedded secrets in workspace content
 * 
 * Scans file content for patterns that indicate embedded secrets
 * (API keys, passwords, private keys, .env references, etc.)
 * 
 * Used before workspace export to prevent secrets from being
 * bundled into portable workspace artifacts.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface SecretFinding {
  pattern: string;           // The regex pattern that matched
  description: string;       // Human-readable description
  line: number;              // Line number where found
  match: string;             // The actual matched text (sanitized)
  severity: 'critical' | 'high' | 'medium';
  file: string;              // File path where found
}

export interface ScanResult {
  clean: boolean;           // true if no secrets found
  findings: SecretFinding[];
  scannedFiles: number;
  scannedBytes: number;
}

export interface ScanOptions {
  /** Files/directories to exclude from scanning */
  excludePatterns?: RegExp[];
  /** Maximum file size to scan (default: 10MB) */
  maxFileSize?: number;
  /** Severity threshold — findings below this are ignored */
  severityThreshold?: 'critical' | 'high' | 'medium';
}

// Pattern definitions — order matters (more specific first)
const SECRET_PATTERNS: Array<{
  pattern: RegExp;
  severity: 'critical' | 'high' | 'medium';
  description: string;
}> = [
  // Critical — Private keys and credentials
  {
    pattern: /-----BEGIN\s+(RSA|EC|DSA|OPENSSH|GPG)?\s*PRIVATE\s+KEY-----/i,
    severity: 'critical',
    description: 'Private key embedded in file',
  },
  {
    pattern: /-----BEGIN\s+(EC|PGP)?\s*SIGNATURE-----/i,
    severity: 'critical',
    description: 'Cryptographic signature embedded',
  },
  {
    pattern: /password\s*[:=]\s*['"]?[a-zA-Z0-9_!@#$%^&*?]{8,}/i,
    severity: 'critical',
    description: 'Hardcoded password detected',
  },
  {
    pattern: /passwd\s*[:=]\s*['"]?[a-zA-Z0-9_!@#$%^&*?]{8,}/i,
    severity: 'critical',
    description: 'Hardcoded password detected (passwd)',
  },
  
  // API Keys — generic patterns
  {
    pattern: /api[_-]?key\s*[:=]\s*['"]?[a-zA-Z0-9_-]{20,}/i,
    severity: 'critical',
    description: 'API key embedded in file',
  },
  {
    pattern: /api[_-]?secret\s*[:=]\s*['"]?[a-zA-Z0-9_-]{20,}/i,
    severity: 'critical',
    description: 'API secret embedded in file',
  },
  {
    pattern: /access[_-]?token\s*[:=]\s*['"]?[a-zA-Z0-9_.-]{20,}/i,
    severity: 'critical',
    description: 'Access token embedded in file',
  },
  {
    pattern: /refresh[_-]?token\s*[:=]\s*['"]?[a-zA-Z0-9_.-]{20,}/i,
    severity: 'critical',
    description: 'Refresh token embedded in file',
  },
  {
    pattern: /bearer\s+[a-zA-Z0-9_.-]{20,}/i,
    severity: 'critical',
    description: 'Bearer token embedded in file',
  },
  {
    pattern: /authorization\s*[:=]\s*['"]?(basic|bearer)\s+[a-zA-Z0-9_.-]+/i,
    severity: 'critical',
    description: 'Authorization header embedded',
  },
  
  // Cloud provider credentials
  {
    pattern: /AKIA[0-9A-Z]{16}/i,
    severity: 'critical',
    description: 'AWS Access Key ID detected',
  },
  {
    pattern: /AWS[_-]?SECRET[_-]?ACCESS[_-]?KEY\s*[:=]\s*['"]?[a-zA-Z0-9/+=]{40}/i,
    severity: 'critical',
    description: 'AWS Secret Access Key detected',
  },
  {
    pattern: /google[_-]?api[_-]?key\s*[:=]\s*['"]?AIza[0-9A-Za-z_-]{35}/i,
    severity: 'critical',
    description: 'Google API Key detected',
  },
  {
    pattern: /gcp[_-]?service[_-]?account\s*[:=]/i,
    severity: 'critical',
    description: 'GCP service account reference',
  },
  
  // Payment/Sensitive service keys
  {
    pattern: /sk_live_[0-9a-zA-Z]{24,}/i,
    severity: 'critical',
    description: 'Stripe live secret key',
  },
  {
    pattern: /sk_test_[0-9a-zA-Z]{24,}/i,
    severity: 'critical',
    description: 'Stripe test secret key',
  },
  {
    pattern: /pk_live_[0-9a-zA-Z]{24,}/i,
    severity: 'high',
    description: 'Stripe live public key',
  },
  {
    pattern: /sq0[a-z]{3}-[0-9A-Za-z_-]{22}/i,
    severity: 'critical',
    description: 'Square API credentials',
  },
  {
    pattern: /twilio[_-]?(account[_-]?sid|auth[_-]?token)\s*[:=]\s*['"]?[A-Z0-9]{32}/i,
    severity: 'critical',
    description: 'Twilio credentials',
  },
  
  // Database connection strings
  {
    pattern: /(mongodb|postgres|mysql|redis):\/\/[a-zA-Z0-9]+:[^@]+@/i,
    severity: 'critical',
    description: 'Database connection string with credentials',
  },
  {
    pattern: /postgres(?:ql)?:\/\/[^:]+:[^@]+@/i,
    severity: 'critical',
    description: 'PostgreSQL connection string with credentials',
  },
  
  // Environment file references
  {
    pattern: /\.env(?:\.[a-zA-Z0-9_]+)?(?:\s|$|[,;])/i,
    severity: 'high',
    description: '.env file reference detected',
  },
  {
    pattern: /ENV(?:IRONMENT)?[_-]?(?:FILE|VAR)?\s*[:=]/i,
    severity: 'high',
    description: 'Environment variable reference',
  },
  
  // Generic secret patterns
  {
    pattern: /secret[_-]?(?:key|token|phrase)\s*[:=]\s*['"]?[a-zA-Z0-9_.-]{8,}/i,
    severity: 'high',
    description: 'Generic secret key/token detected',
  },
  {
    pattern: /token\s*[:=]\s*['"]?[a-zA-Z0-9_.-]{16,}/i,
    severity: 'medium',
    description: 'Generic token detected',
  },
  
  // OAuth
  {
    pattern: /oauth[_-]?(?:client[_-]?id|client[_-]?secret)\s*[:=]/i,
    severity: 'critical',
    description: 'OAuth credentials embedded',
  },
  {
    pattern: /client[_-]?id\s*[:=]\s*['"]?[0-9a-f]{32,}/i,
    severity: 'medium',
    description: 'OAuth client ID embedded',
  },
  {
    pattern: /client[_-]?secret\s*[:=]\s*['"]?[a-zA-Z0-9_.-]{20,}/i,
    severity: 'critical',
    description: 'OAuth client secret embedded',
  },
  
  // JWT
  {
    pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/i,
    severity: 'medium',
    description: 'JWT token detected (may be a false positive)',
  },
  
  // Git tokens
  {
    pattern: /gh[ops]_[0-9a-zA-Z]{36,}/i,
    severity: 'critical',
    description: 'GitHub personal access token',
  },
  {
    pattern: /git[_-]?token\s*[:=]\s*['"]?[a-zA-Z0-9_.-]{20,}/i,
    severity: 'high',
    description: 'Git token embedded',
  },
];

// Files that should be excluded from scanning
const DEFAULT_EXCLUDE_PATTERNS: RegExp[] = [
  /\.git\//,
  /node_modules\//,
  /\.DS_Store/,
  /\.swp/,
  /~$/,
  /\.o$/,
  /\.so$/,
  /\.dylib$/,
  /\.exe$/,
  /\.dll$/,
  /\.bin$/,
  /\.png$/,
  /\.jpg$/,
  /\.jpeg$/,
  /\.gif$/,
  /\.webp$/,
  /\.mp4$/,
  /\.mp3$/,
  /\.wav$/,
  /\.pdf$/,
  /\.zip$/,
  /\.tar$/,
  /\.gz$/,
  /\.tgz$/,
];

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Scan a single file for secrets.
 */
export async function scanFile(
  filePath: string,
  options: ScanOptions = {}
): Promise<SecretFinding[]> {
  const excludePatterns = options.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS;
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;

  // Check if file should be excluded
  for (const pattern of excludePatterns) {
    if (pattern.test(filePath)) {
      return [];
    }
  }

  // Check file size
  const stats = await fs.stat(filePath);
  if (stats.size > maxFileSize) {
    return [];
  }

  // Read file content
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    // Binary or unreadable file
    return [];
  }

  return scanContent(content, filePath);
}

/**
 * Scan string content for secrets.
 */
export function scanContent(content: string, filePath: string = 'unknown'): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split('\n');

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];

    for (const { pattern, severity, description } of SECRET_PATTERNS) {
      // Reset regex lastIndex
      pattern.lastIndex = 0;
      
      if (pattern.test(line)) {
        // Sanitize the match — replace most chars with *
        const match = sanitizeMatch(line.match(pattern)?.[0] ?? '');
        
        findings.push({
          pattern: pattern.source,
          description,
          line: lineNum + 1, // 1-indexed
          match,
          severity,
          file: filePath,
        });
      }
    }
  }

  return findings;
}

/**
 * Scan a directory recursively for secrets.
 */
export async function scanDirectory(
  dirPath: string,
  options: ScanOptions = {}
): Promise<ScanResult> {
  const findings: SecretFinding[] = [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  const severityThreshold = options.severityThreshold ?? 'medium';

  const severityOrder: Record<string, number> = {
    critical: 3,
    high: 2,
    medium: 1,
  };

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip excluded directories
        const shouldSkip = (options.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS)
          .some(pattern => pattern.test(fullPath));
        if (!shouldSkip) {
          await walk(fullPath);
        }
      } else if (entry.isFile()) {
        const fileFindings = await scanFile(fullPath, options);
        
        // Filter by severity threshold
        const relevantFindings = fileFindings.filter(
          f => severityOrder[f.severity] >= severityOrder[severityThreshold]
        );
        
        findings.push(...relevantFindings);
        
        try {
          const stats = await fs.stat(fullPath);
          scannedFiles++;
          scannedBytes += stats.size;
        } catch {
          // Ignore stat errors
        }
      }
    }
  }

  await walk(dirPath);

  return {
    clean: findings.length === 0,
    findings,
    scannedFiles,
    scannedBytes,
  };
}

/**
 * Scan workspace files and reject if secrets found.
 * Throws an error with detailed findings if secrets are detected.
 */
export async function scanWorkspace(
  workspacePath: string,
  options: ScanOptions = {}
): Promise<void> {
  const result = await scanDirectory(workspacePath, options);

  if (!result.clean) {
    const summary = result.findings
      .map(f => `  [${f.severity.toUpperCase()}] ${f.file}:${f.line} — ${f.description}`)
      .join('\n');

    const error = new Error(
      `Secrets detected in workspace:\n${summary}\n\n` +
      `Workspace export rejected. Remove secrets from files or use environment variables instead.\n` +
      `Scanned ${result.scannedFiles} files (${result.scannedBytes} bytes).`
    );
    
    (error as any).findings = result.findings;
    (error as any).scanResult = result;
    throw error;
  }
}

/**
 * Sanitize a matched secret for display.
 * Replaces most characters with * but keeps first and last few.
 */
function sanitizeMatch(match: string): string {
  if (match.length <= 8) {
    return '*'.repeat(match.length);
  }
  
  const start = match.slice(0, 3);
  const end = match.slice(-3);
  const middle = '*'.repeat(Math.min(match.length - 6, 20));
  
  return `${start}${middle}${end}`;
}

/**
 * Get a summary report of scan results.
 */
export function formatScanReport(result: ScanResult): string {
  if (result.clean) {
    return `✓ No secrets detected (scanned ${result.scannedFiles} files)`;
  }

  const bySeverity = {
    critical: result.findings.filter(f => f.severity === 'critical'),
    high: result.findings.filter(f => f.severity === 'high'),
    medium: result.findings.filter(f => f.severity === 'medium'),
  };

  let report = `⚠ Secrets detected:\n`;
  report += `Scanned ${result.scannedFiles} files (${result.scannedBytes} bytes)\n\n`;

  for (const [severity, findings] of Object.entries(bySeverity)) {
    if (findings.length > 0) {
      report += `[${severity.toUpperCase()}] (${findings.length} findings)\n`;
      for (const f of findings) {
        report += `  ${f.file}:${f.line} — ${f.match} (${f.description})\n`;
      }
      report += '\n';
    }
  }

  return report;
}
