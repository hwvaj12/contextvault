import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { chmod, lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { WorkspaceError, type StorageBinding, type WorkspaceScope, type StorageBindingId, type Timestamp, type Operation } from "../domain";
import { createSafeDirectory } from "../application/files";
import { WorkspaceLifecycle, type LifecycleDependencies } from "../application/runs";
import { WorkspaceMaintenance } from "../application/maintenance";
import { SqliteControlStore, createRevisionWriterTracking } from "../adapters/control";
import { CatalogAccessPolicy } from "../adapters/access/catalog-access-policy";
import { createWebhookDelivery } from "../adapters/delivery/webhook";
import { getWebhookSigningKey } from "../services/webhook.service";
import { SecretsService } from "../services/secrets.service";
import { withDatabase } from "../db";
import type { RevisionStore, SubmissionStore } from "../ports";
import type { ServerConfiguration, StorageProfile } from ".";

export interface RuntimeOptions {
  configuration?: ServerConfiguration; database?: Database.Database; now?: () => Timestamp;
  lifecycle?: Pick<Partial<LifecycleDependencies>, "hook" | "processingRenewIntervalMs">;
  maintenance?: boolean;
}
export interface WorkspaceRuntime {
  configuration: ServerConfiguration; database: Database.Database; control: SqliteControlStore; accessPolicy: CatalogAccessPolicy;
  lifecycle: WorkspaceLifecycle; maintenance: WorkspaceMaintenance; now: () => Timestamp; ownerId: string;
  revisionStore(binding: StorageBinding): Promise<RevisionStore>; submissionStore(binding: StorageBinding): Promise<SubmissionStore>;
  createBinding(scope: WorkspaceScope, id: StorageBindingId, createdAt: Timestamp): StorageBinding;
  schedule(operation: Operation, replayed: boolean): void;
  provisionLegacyTenant(customerId: string): Promise<void>;
  stop(): Promise<void>;
}
declare module "fastify" { interface FastifyInstance { contextVault: WorkspaceRuntime } }

export async function preparePrivateDirectory(path: string): Promise<void> { await createSafeDirectory(path); await chmod(path, 0o700); }
export async function createRuntime(configuration: ServerConfiguration, database: Database.Database, options: RuntimeOptions = {}): Promise<WorkspaceRuntime> {
  const now = options.now ?? (() => new Date().toISOString()); const ownerId = `worker-${randomUUID()}`;
  const control = new SqliteControlStore(database); const accessPolicy = new CatalogAccessPolicy(control);
  const writerTracking = createRevisionWriterTracking(control, ownerId, now);
  const profiles = new Map(configuration.profiles.map(profile => [profile.configurationRef, profile]));
  const stores = new Map<string, Promise<{ revisions: RevisionStore; submissions: SubmissionStore }>>();
  const clients: S3Client[] = [];
  function profileFor(binding: StorageBinding): StorageProfile {
    const profile = profiles.get(binding.configurationRef);
    if (!profile || profile.backend !== binding.backend || profile.storeId !== binding.location.storeId || binding.location.opaqueKey !== binding.scope.workspaceId || !Number.isSafeInteger(binding.generation) || binding.generation < 1) throw new WorkspaceError("STORAGE_UNAVAILABLE", "The original private storage configuration is unavailable");
    return profile;
  }
  async function resolveStore(binding: StorageBinding) {
    const profile = profileFor(binding);
    let result = stores.get(profile.configurationRef);
    if (!result) {
      result = (async () => {
        if (profile.backend === "git") {
          const [{ GitRevisionStore }, { LocalSubmissionStore }] = await Promise.all([import("../adapters/revisions/git"), import("../adapters/submissions/local")]);
          return { revisions: new GitRevisionStore({ rootDirectory: profile.rootDirectory, storeId: profile.storeId, writerTracking, verifyCollectionPermit: control.verifyCollectionPermit.bind(control) }),
            submissions: new LocalSubmissionStore({ root: profile.submissionRoot, storeId: `${profile.storeId}-submissions`, control, now, limits: configuration.limits }) };
        }
        const [{ S3RevisionStore }, { S3SubmissionStore }] = await Promise.all([import("../adapters/revisions/s3"), import("../adapters/submissions/s3")]);
        const client = new S3Client({ region: profile.region, ...(profile.endpoint ? { endpoint: profile.endpoint } : {}), ignoreConfiguredEndpointUrls: true,
          forcePathStyle: profile.provider === "localstack", maxAttempts: 3, requestHandler: { connectionTimeout: 5000, requestTimeout: 30_000 },
          ...(profile.provider === "localstack" ? { credentials: { accessKeyId: "test", secretAccessKey: "test" } } : {}) }); clients.push(client);
        const shared = { client, bucket: profile.bucket, prefix: profile.prefix, storeId: profile.storeId, encryption: profile.encryption, limits: configuration.limits, allowInsecureEndpoint: profile.provider === "localstack" };
        return { revisions: new S3RevisionStore({ ...shared, writerTracking, verifyCollectionPermit: control.verifyCollectionPermit.bind(control) }), submissions: new S3SubmissionStore({ ...shared, control, now }) };
      })();
      stores.set(profile.configurationRef, result); result.catch(() => { if (stores.get(profile.configurationRef) === result) stores.delete(profile.configurationRef); });
    }
    return result;
  }
  const revisionStore = async (binding: StorageBinding) => (await resolveStore(binding)).revisions;
  const submissionStore = async (binding: StorageBinding) => (await resolveStore(binding)).submissions;
  async function submissionsFor(scope: { customerId: any; workspaceId: any; storageBindingId: StorageBindingId; bindingGeneration: number }) {
    const binding = await control.getBinding(scope, scope.storageBindingId);
    if (!binding || binding.generation !== scope.bindingGeneration) throw new WorkspaceError("STORAGE_BINDING_CHANGED", "Original run binding is unavailable");
    return submissionStore(binding);
  }
  const submissions: SubmissionStore = {
    begin: async input => (await submissionsFor(input.scope)).begin(input), writeFile: async input => (await submissionsFor(input.scope)).writeFile(input),
    seal: async input => (await submissionsFor(input.scope)).seal(input), get: async (scope, id) => (await submissionsFor(scope)).get(scope, id),
    openSealedFile: async (scope, id, path, streamOptions) => (await submissionsFor(scope)).openSealedFile(scope, id, path, streamOptions),
    expire: async (scope, id, version, at) => (await submissionsFor(scope)).expire(scope, id, version, at), collect: async (permit, at) => (await submissionsFor(permit.scope)).collect(permit, at),
  };
  const createBinding = (scope: WorkspaceScope, id: StorageBindingId, createdAt: Timestamp): StorageBinding => {
    const profile = profiles.get(configuration.defaultConfigurationRef);
    if (!profile) throw new WorkspaceError("INVALID_REQUEST", "Default storage configuration is unavailable");
    return { id, scope, backend: profile.backend, generation: 1, location: { storeId: profile.storeId, opaqueKey: scope.workspaceId }, configurationRef: profile.configurationRef, status: "active", createdAt };
  };
  const lifecycle = new WorkspaceLifecycle({ control, accessPolicy, submissions, revisionStore, createBinding, ownerId, now, leaseTtlMs: configuration.leaseTtlMs, processingTtlMs: configuration.processingTtlMs, ...options.lifecycle });
  const maintenance = new WorkspaceMaintenance({ lifecycle, now, revisionStore, submissionStore, intervalMs: configuration.maintenanceIntervalMs,
    deliver: createWebhookDelivery({ resolveSigningKey: (reference, customerId) => withDatabase(database, () => getWebhookSigningKey(reference, customerId)) }) });
  const jobs = new Set<Promise<unknown>>(); let closing = false;
  // The local provider writes into an already private directory and precreated 0600 file.
  const secretsPath = configuration.legacySecretsPath;
  // An explicit legacy file can live outside the data root. Do not change an existing external parent's permissions.
  await createSafeDirectory(dirname(secretsPath));
  try { const file = await open(secretsPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); try { await file.writeFile("{}"); await file.sync(); } finally { await file.close(); } }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const secretStat = await lstat(secretsPath); if (!secretStat.isFile() || secretStat.isSymbolicLink() || secretStat.nlink !== 1) throw new WorkspaceError("STORAGE_UNAVAILABLE", "Legacy secrets require a private regular file");
  await chmod(secretsPath, 0o600);
  const secrets = SecretsService.createLocal(secretsPath); let provisioning = Promise.resolve();
  return { configuration, database, control, accessPolicy, lifecycle, maintenance, now, ownerId, revisionStore, submissionStore, createBinding,
    schedule(operation, replayed) {
      if (replayed || operation.state !== "processing" || operation.claim?.ownerId !== ownerId) return;
      if (closing) throw new WorkspaceError("PUBLICATION_OUTCOME_UNKNOWN", "Processing requires reconciliation", { operationId: operation.id, retryable: true });
      const fence = operation.claim.fence;
      const job = new Promise<void>(resolve => setImmediate(resolve)).then(() => withDatabase(database, () => lifecycle.processOperation({ scope: operation.scope, operationId: operation.id, processingFence: fence })));
      jobs.add(job); void job.catch(() => { /* Durable operation remains available for fenced recovery. */ }).finally(() => jobs.delete(job));
    },
    provisionLegacyTenant(customerId) {
      const next = provisioning.then(async () => { await secrets.ensureTmk(customerId); }); provisioning = next.catch(() => {}); return next;
    },
    async stop() { closing = true; await maintenance.stop(); await Promise.allSettled([...jobs]); await provisioning; for (const client of clients) client.destroy(); },
  };
}
