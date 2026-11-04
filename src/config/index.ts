import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalJson, WorkspaceError, workspaceLimits, type WorkspaceLimits } from "../domain";

export type GitProfile = { backend: "git"; rootDirectory: string; submissionRoot: string };
export type S3Profile = { backend: "s3"; provider: "aws" | "localstack"; bucket: string; region: string; prefix: string; endpoint?: string; encryption: { algorithm: "AES256" } | { algorithm: "aws:kms"; keyId: string } };
export type StorageProfile = (GitProfile | S3Profile) & { configurationRef: string; storeId: string };
export interface ServerConfiguration {
  dataDirectory: string; databasePath: string; legacySecretsPath: string; masterKey: string | null;
  defaultConfigurationRef: string; profiles: readonly StorageProfile[];
  limits: WorkspaceLimits; leaseTtlMs: number; processingTtlMs: number; maintenanceIntervalMs: number; requestTimeoutMs: number;
  signing?: { privateKey: string; publicKey: string; keyId: string };
}
const invalid = (message: string): never => { throw new WorkspaceError("INVALID_REQUEST", message); };
function absolute(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) return invalid(`${label} must be an absolute private path`);
  return resolve(value);
}
function positive(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) return invalid(`${label} must be a positive integer`);
  return Number(value);
}
function parse(value: string, label: string): unknown { try { return JSON.parse(value); } catch { return invalid(`${label} must contain valid JSON`); } }
export function storageProfile(input: unknown): StorageProfile {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid("Storage profiles must be objects");
  const value = input as Record<string, unknown>;
  let profile: GitProfile | S3Profile;
  if (value.backend === "git") {
    if (Object.keys(value).some(key => !["backend", "rootDirectory", "submissionRoot"].includes(key))) return invalid("Unknown Git profile field");
    profile = { backend: "git", rootDirectory: absolute(value.rootDirectory, "Git root"), submissionRoot: absolute(value.submissionRoot, "Submission root") };
    if (profile.rootDirectory === profile.submissionRoot) return invalid("Revision and submission roots must differ");
  } else if (value.backend === "s3") {
    if (Object.keys(value).some(key => !["backend", "provider", "bucket", "region", "prefix", "endpoint", "encryption"].includes(key))) return invalid("Unknown S3 profile field");
    if (!["aws", "localstack"].includes(value.provider as string) || typeof value.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value.bucket)
      || typeof value.region !== "string" || !/^[a-z0-9-]{3,64}$/.test(value.region) || typeof value.prefix !== "string" || value.prefix.length > 1024 || !value.prefix.endsWith("/")
      || value.prefix.startsWith("/") || value.prefix.split("/").slice(0, -1).some(part => !part || part === "." || part === "..") || /[\u0000-\u001f\u007f]/.test(value.prefix)) return invalid("S3 requires explicit provider, bucket, region and private prefix");
    let endpoint: string | undefined;
    if (value.endpoint !== undefined) {
      let url: URL; try { url = new URL(String(value.endpoint)); } catch { return invalid("Invalid S3 endpoint"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") return invalid("Invalid S3 endpoint");
      const aws = /(?:^|\.)amazonaws\.com(?:\.cn)?$/.test(url.hostname);
      if (value.provider === "aws" ? url.protocol !== "https:" || !aws : aws) return invalid("S3 endpoint does not match its declared provider");
      endpoint = url.origin;
    }
    if (value.provider === "localstack" && !endpoint) return invalid("LocalStack requires an explicit emulator endpoint");
    const encryption = value.encryption as S3Profile["encryption"] | undefined;
    if (!encryption || !["AES256", "aws:kms"].includes(encryption.algorithm) || Object.keys(encryption).some(key => !["algorithm", "keyId"].includes(key))
      || (encryption.algorithm === "aws:kms" && (typeof encryption.keyId !== "string" || !encryption.keyId.trim()))) return invalid("S3 requires validated encryption configuration");
    profile = { backend: "s3", provider: value.provider as S3Profile["provider"], bucket: value.bucket, region: value.region, prefix: value.prefix, ...(endpoint ? { endpoint } : {}), encryption: structuredClone(encryption) };
  } else return invalid("Unknown storage backend");
  // Changing a physical location creates a new identity. Old references require their original retained profile.
  const fingerprint = createHash("sha256").update(canonicalJson(profile)).digest("hex");
  return { ...profile, configurationRef: `configuration-${fingerprint}`, storeId: `store-${fingerprint}` };
}
export function loadConfiguration(env: NodeJS.ProcessEnv = process.env): ServerConfiguration {
  const dataDirectory = absolute(env.CV_DATA_DIR ?? resolve(process.cwd(), "data"), "Data directory");
  const databasePath = absolute(env.CV_DATABASE_PATH ?? join(dataDirectory, "contextvault.db"), "Catalog");
  if (env.CONTEXTVAULT_SECRETS_BACKEND && env.CONTEXTVAULT_SECRETS_BACKEND !== "local") return invalid("The configured legacy secrets backend is unsupported");
  const secretLocation = env.CONTEXTVAULT_SECRETS_PATH ? resolve(process.cwd(), env.CONTEXTVAULT_SECRETS_PATH) : join(dataDirectory, "secrets");
  const legacySecretsPath = absolute(secretLocation.endsWith(".json") ? secretLocation : join(secretLocation, "tenant-keys.json"), "Legacy secrets file");
  const git = storageProfile({ backend: "git", rootDirectory: env.CV_GIT_ROOT ?? join(dataDirectory, "revisions", "git"), submissionRoot: env.CV_SUBMISSION_ROOT ?? join(dataDirectory, "submissions", "git") });
  const profiles: StorageProfile[] = [git]; let s3: StorageProfile | undefined;
  if (env.CV_S3_BUCKET || env.CV_STORAGE_BACKEND === "s3") {
    s3 = storageProfile({ backend: "s3", provider: env.CV_S3_PROVIDER ?? "aws", bucket: env.CV_S3_BUCKET, region: env.CV_S3_REGION, prefix: env.CV_S3_PREFIX,
      ...(env.CV_S3_ENDPOINT ? { endpoint: env.CV_S3_ENDPOINT } : {}), encryption: env.CV_S3_KMS_KEY_ID ? { algorithm: "aws:kms", keyId: env.CV_S3_KMS_KEY_ID } : { algorithm: "AES256" } }); profiles.push(s3);
  }
  if (env.CV_STORAGE_PROFILES) {
    const extra = parse(env.CV_STORAGE_PROFILES, "CV_STORAGE_PROFILES");
    if (!Array.isArray(extra) || extra.length > 32) return invalid("At most 32 retained storage profiles are allowed");
    profiles.push(...extra.map(storageProfile));
  }
  const backend = env.CV_STORAGE_BACKEND ?? "git";
  if (!["git", "s3"].includes(backend)) return invalid("CV_STORAGE_BACKEND must be git or s3");
  const rawLimits = env.CV_WORKSPACE_LIMITS ? parse(env.CV_WORKSPACE_LIMITS, "CV_WORKSPACE_LIMITS") : {};
  if (!rawLimits || typeof rawLimits !== "object" || Array.isArray(rawLimits) || Object.keys(rawLimits).some(key => !Object.hasOwn(workspaceLimits(), key))) return invalid("Unknown workspace limit");
  const limits = workspaceLimits(rawLimits);
  if (Object.entries(limits).some(([key, value]) => value > workspaceLimits()[key as keyof WorkspaceLimits])) return invalid("Workspace limits may lower the shared v1 ceilings");
  return { dataDirectory, databasePath, legacySecretsPath, masterKey: env.CONTEXTVAULT_API_KEY?.trim() ? env.CONTEXTVAULT_API_KEY : null,
    ...(env.CONTEXTVAULT_SIGNING_PRIVATE_KEY && env.CONTEXTVAULT_SIGNING_PUBLIC_KEY && env.CONTEXTVAULT_SIGNING_KEY_ID ? { signing: { privateKey: env.CONTEXTVAULT_SIGNING_PRIVATE_KEY, publicKey: env.CONTEXTVAULT_SIGNING_PUBLIC_KEY, keyId: env.CONTEXTVAULT_SIGNING_KEY_ID } } : {}),
    profiles: [...new Map(profiles.map(profile => [profile.configurationRef, profile])).values()], defaultConfigurationRef: backend === "git" ? git.configurationRef : s3!.configurationRef,
    limits, leaseTtlMs: positive(env.CV_LEASE_TTL_MS, 300_000, "Lease TTL"), processingTtlMs: positive(env.CV_PROCESSING_TTL_MS, 300_000, "Processing TTL"),
    maintenanceIntervalMs: positive(env.CV_MAINTENANCE_INTERVAL_MS, 1000, "Maintenance interval"), requestTimeoutMs: positive(env.CV_REQUEST_TIMEOUT_MS, 120_000, "Request timeout") };
}
