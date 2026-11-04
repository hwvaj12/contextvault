import { WorkspaceError, canonicalJson, type CandidateCollectionTarget, type Operation, type OutboxEvent, type StorageBinding, type SubmissionCollectionTarget, type Timestamp } from "../../domain";
import type { CatalogSubscription, ControlStore } from "../../ports/control-store";
import type { RevisionStore, SubmissionStore } from "../../ports";
import type { WorkspaceLifecycle } from "../runs";
export type DeliveryTransport = (event: OutboxEvent, recipient: CatalogSubscription) => Promise<void>;

export interface MaintenanceReport {
  recovered: number;
  expired: number;
  delivered: number;
  cleaned: number;
  collected: number;
  errors: { work: string; id: string; code: string; message: string }[];
}
export interface MaintenanceDependencies {
  lifecycle: WorkspaceLifecycle;
  now?: () => Timestamp;
  batchSize?: number;
  claimTtlMs?: number;
  retryDelayMs?: number;
  intervalMs?: number;
  deliver?: DeliveryTransport;
  revisionStore?: (binding: StorageBinding) => RevisionStore | Promise<RevisionStore>;
  submissionStore?: (binding: StorageBinding) => SubmissionStore | Promise<SubmissionStore>;
  /** Additional authoritative use cases register their own processors, not a generic agent executor. */
  recoveryProcessors?: Partial<Record<Operation["kind"], (operation: Operation) => Promise<Operation>>>;
}

/** Bounded, non-overlapping catalog maintenance. Nothing here runs agent code or reads a backend current pointer. */
export class WorkspaceMaintenance {
  private readonly control: ControlStore;
  private readonly batchSize: number;
  private readonly claimTtlMs: number;
  private readonly intervalMs: number;
  private readonly retryDelayMs: number;
  private running?: Promise<MaintenanceReport>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  constructor(readonly dependencies: MaintenanceDependencies) {
    this.control = dependencies.lifecycle.runtime.control;
    this.batchSize = dependencies.batchSize ?? 50;
    this.claimTtlMs = dependencies.claimTtlMs ?? 300_000;
    this.intervalMs = dependencies.intervalMs ?? 1000;
    this.retryDelayMs = dependencies.retryDelayMs ?? 1000;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 1000 || !Number.isSafeInteger(this.claimTtlMs) || this.claimTtlMs < 1 || !Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1 || !Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 0) throw new WorkspaceError("INVALID_REQUEST", "Maintenance bounds must be positive and batch size at most 1000");
  }
  private now(): Timestamp {
    const value = this.dependencies.now?.() ?? this.dependencies.lifecycle.runtime.now();
    if (!Number.isFinite(Date.parse(value))) throw new WorkspaceError("INVALID_REQUEST", "Maintenance clock must be valid");
    return new Date(value).toISOString();
  }
  private until(now: Timestamp): Timestamp { return new Date(Date.parse(now) + this.claimTtlMs).toISOString(); }
  private error(report: MaintenanceReport, work: string, id: string, error: unknown): void {
    if (error instanceof WorkspaceError && ["STALE_FENCE", "VERSION_CONFLICT"].includes(error.code)) return;
    report.errors.push({ work, id, code: error instanceof WorkspaceError ? error.code : "STORAGE_UNAVAILABLE", message: error instanceof Error ? error.message : "Maintenance work failed" });
  }
  private async collectCandidate(target: CandidateCollectionTarget, eligible: () => void): Promise<void> {
    if (!target.binding || target.binding.id !== target.identity.scope.storageBindingId || target.binding.generation !== target.identity.scope.bindingGeneration) throw new WorkspaceError("STORAGE_UNAVAILABLE", "Candidate cleanup requires its original persisted binding");
    const now = this.now();
    const permit = target.collection && await this.control.verifyCollectionPermit(target.collection, now) ? target.collection : await this.control.claimCandidateCollection({ scope: target.identity.scope, candidateId: target.identity.candidateId, now, expiresAt: this.until(now) });
    eligible();
    const store = await (this.dependencies.revisionStore ?? this.dependencies.lifecycle.runtime.dependencies.revisionStore)(target.binding);
    await store.deleteCollectible(permit, this.now());
    await this.control.completeCandidateCollection(permit, this.now());
  }
  private async collectSubmission(target: SubmissionCollectionTarget, eligible: () => void): Promise<void> {
    if (!target.binding || target.binding.id !== target.submission.scope.storageBindingId || target.binding.generation !== target.submission.scope.bindingGeneration) throw new WorkspaceError("STORAGE_UNAVAILABLE", "Submission cleanup requires its original persisted binding");
    const now = this.now();
    const permit = target.collection && await this.control.verifySubmissionCollectionPermit(target.collection, now) ? target.collection : await this.control.claimSubmissionCollection({ scope: target.submission.scope, submissionId: target.submission.id, now, expiresAt: this.until(now) });
    eligible();
    const store = this.dependencies.submissionStore ? await this.dependencies.submissionStore(target.binding) : this.dependencies.lifecycle.runtime.dependencies.submissions;
    await store.collect(permit, this.now());
  }
  runOnce(): Promise<MaintenanceReport> {
    if (this.running) return this.running;
    const running = this.tick().finally(() => { if (this.running === running) this.running = undefined; });
    this.running = running;
    return running;
  }
  private async tick(): Promise<MaintenanceReport> {
    const report: MaintenanceReport = { recovered: 0, expired: 0, delivered: 0, cleaned: 0, collected: 0, errors: [] };
    const kinds = [...new Set<Operation["kind"]>(["workspace:create", "finalize", ...Object.entries(this.dependencies.recoveryProcessors ?? {}).filter(([, processor]) => typeof processor === "function").map(([kind]) => kind as Operation["kind"])])];
    for (const operation of await this.control.listRecoverableOperations({ now: this.now(), limit: this.batchSize, kinds })) {
      const processor = this.dependencies.recoveryProcessors?.[operation.kind] ?? (["workspace:create", "finalize"].includes(operation.kind) ? (claimed: Operation) => this.dependencies.lifecycle.processOperation({ scope: claimed.scope, operationId: claimed.id, processingFence: claimed.claim!.fence }) : undefined);
      if (!processor) continue;
      try {
        const now = this.now();
        const claimed = await this.control.claimRecovery({ scope: operation.scope, operationId: operation.id, expectedVersion: operation.version, ownerId: this.dependencies.lifecycle.runtime.dependencies.ownerId, now, expiresAt: this.until(now), kind: operation.kind });
        await processor(claimed);
        report.recovered++;
      } catch (error) { this.error(report, "recover", operation.id, error); }
    }
    const expired = await this.control.listExpiredActiveRuns({ now: this.now(), limit: this.batchSize });
    for (const target of expired.runs) {
      try { await this.dependencies.lifecycle.expireActiveRun(target); report.expired++; }
      catch (error) { this.error(report, "expire", target.scope.runId, error); }
    }
    let deliveries = 0;
    for (const pending of await this.control.listPendingOutbox({ now: this.now(), limit: this.batchSize })) {
      if (deliveries >= this.batchSize) break;
      try {
        const now = this.now();
        let event = await this.control.claimOutbox({ scope: pending.scope, eventId: pending.id, expectedVersion: pending.version, ownerId: this.dependencies.lifecycle.runtime.dependencies.ownerId, now, expiresAt: this.until(now) });
        if (event.deliveryState === "complete") continue;
        const recipients = await this.control.listDueOutboxRecipients({ scope: event.scope, eventId: event.id, now, limit: this.batchSize - deliveries });
        for (const { recipient, attempts } of recipients) {
          if (deliveries >= this.batchSize) break;
          deliveries++;
          let error: unknown;
          try {
            if (!this.dependencies.deliver) throw new WorkspaceError("STORAGE_UNAVAILABLE", "Webhook delivery is not configured");
            await this.dependencies.deliver(event, recipient);
          } catch (failure) { error = failure; }
          const completedAt = this.now();
          const retry = new Date(Date.parse(completedAt) + Math.min(this.retryDelayMs * 2 ** Math.min(attempts, 8), 300_000)).toISOString();
          event = await this.control.recordDelivery({ scope: event.scope, eventId: event.id, subscriptionId: recipient.id, expectedVersion: event.version, fence: event.claim!.fence, delivered: !error, now: completedAt, nextAttemptAt: error ? retry : completedAt });
          if (error) this.error(report, "deliver", event.id, error);
          else report.delivered++;
          if (event.deliveryState !== "running") break;
        }
        if (event.deliveryState === "running") {
          const finishedAt = this.now();
          await this.control.releaseOutboxClaim({ scope: event.scope, eventId: event.id, expectedVersion: event.version, fence: event.claim!.fence, now: finishedAt, nextAttemptAt: finishedAt });
        }
      } catch (error) { this.error(report, "deliver", pending.id, error); }
    }
    let budget = this.batchSize;
    let inspected = 0;
    const attempted = new Set<string>();
    const candidateKey = (target: CandidateCollectionTarget) => canonicalJson(["candidate", target.identity.scope, target.identity.candidateId]);
    const submissionKey = (target: SubmissionCollectionTarget) => canonicalJson(["submission", target.submission.scope, target.submission.id]);
    const collectCandidate = async (target: CandidateCollectionTarget) => {
      const key = candidateKey(target); if (!budget || inspected >= this.batchSize || attempted.has(key)) return;
      inspected++; attempted.add(key); await this.collectCandidate(target, () => { budget--; }); report.collected++;
    };
    const collectSubmission = async (target: SubmissionCollectionTarget) => {
      const key = submissionKey(target); if (!budget || inspected >= this.batchSize || attempted.has(key)) return;
      inspected++; attempted.add(key); await this.collectSubmission(target, () => { budget--; }); report.collected++;
    };
    const jobs = new Set<string>();
    // Catalog positions survive worker restarts. Each turn scans one row, rotating jobs and both global target kinds.
    for (let scanned = 0; scanned < this.batchSize * 3 && budget && inspected < this.batchSize; scanned++) {
      const work = await this.control.nextCollectionWork({ now: this.now() });
      if (!work) continue;
      if (work.kind === "candidate") { try { await collectCandidate(work.candidate); } catch (error) { this.error(report, "collect-candidate", work.candidate.identity.candidateId, error); } continue; }
      if (work.kind === "submission") { try { await collectSubmission(work.submission); } catch (error) { this.error(report, "collect-submission", work.submission.submission.id, error); } continue; }
      const pending = work.cleanup;
      const jobKey = canonicalJson([pending.scope, pending.id]); if (jobs.has(jobKey)) continue; jobs.add(jobKey);
      try {
        const now = this.now();
        const cleanup = await this.control.claimCleanup({ scope: pending.scope, cleanupId: pending.id, expectedVersion: pending.version, ownerId: this.dependencies.lifecycle.runtime.dependencies.ownerId, now, expiresAt: this.until(now) });
        let failure: unknown;
        const limit = Math.min(budget, this.batchSize - inspected);
        let targets = await this.control.getCleanupTargets(cleanup.scope, cleanup.id, limit, cleanup.targetCursor ?? undefined);
        if (targets && !targets.candidates.length && !targets.submissions.length && cleanup.targetCursor) targets = await this.control.getCleanupTargets(cleanup.scope, cleanup.id, limit);
        if (!targets) throw new WorkspaceError("STORAGE_UNAVAILABLE", "Cleanup targets are unavailable");
        for (const target of targets.candidates) { try { await collectCandidate(target); } catch (error) { failure ??= error; this.error(report, "collect-candidate", target.identity.candidateId, error); } }
        for (const target of targets.submissions) { try { await collectSubmission(target); } catch (error) { failure ??= error; this.error(report, "collect-submission", target.submission.id, error); } }
        const completedAt = this.now();
        const cas = { scope: cleanup.scope, cleanupId: cleanup.id, expectedVersion: cleanup.version, fence: cleanup.claim!.fence, now: completedAt, targetCursor: targets.nextCursor };
        if (failure) {
          await this.control.completeCleanup({ ...cas, error: failure instanceof Error ? failure.message : "Cleanup requires retry", nextAttemptAt: new Date(Date.parse(completedAt) + this.retryDelayMs).toISOString() });
        } else {
          const remaining = await this.control.getCleanupTargets(cleanup.scope, cleanup.id, 1);
          if (!remaining || remaining.candidates.length || remaining.submissions.length) await this.control.releaseCleanupClaim({ ...cas, nextAttemptAt: completedAt });
          else { await this.control.completeCleanup({ ...cas, error: null, nextAttemptAt: completedAt }); report.cleaned++; }
        }
      } catch (error) { this.error(report, "cleanup", pending.id, error); }
    }
    return report;
  }
  /** Start one scheduler; the next tick begins only after the current tick settles. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const schedule = (delay: number) => {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.runOnce().catch(() => { /* Durable work remains available for the next bounded tick. */ }).finally(() => { if (!this.stopped) schedule(this.intervalMs); });
      }, delay);
      this.timer.unref();
    };
    schedule(0);
  }
  /** Stop scheduling and drain current owned work; persisted intents remain authoritative throughout shutdown. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
