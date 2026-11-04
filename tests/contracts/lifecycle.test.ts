import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { canTransitionRun, canTransitionCleanup, RUN_STATES, TERMINAL_RUN_STATES } from "../../src/domain/lifecycle";
import { canonicalRequestDigest, canonicalJson } from "../../src/domain/idempotency";
import { WorkspaceError, ERROR_STATUS } from "../../src/domain/errors";

describe("versioned lifecycle and errors", () => {
  it("matches the versioned transition matrix, including finalizer recovery and independent cleanup", async () => {
    const fixture = JSON.parse(await readFile(new URL("../../contracts/lifecycle.v1.json", import.meta.url), "utf8"));
    expect(RUN_STATES).toEqual(Object.keys(fixture.runTransitions));
    for (const from of RUN_STATES) for (const to of RUN_STATES) expect(canTransitionRun(from, to)).toBe(fixture.runTransitions[from].includes(to));
    expect(TERMINAL_RUN_STATES).toEqual(["finalized", "aborted", "conflicted", "failed", "expired"]);
    expect(canTransitionCleanup("failed", "running")).toBe(true);
    expect(canTransitionCleanup("complete", "running")).toBe(false);
    expect(canTransitionRun("finalizing", "expired")).toBe(false);
    expect(canTransitionRun("finalized", "aborted")).toBe(false);
  });

  it("matches machine error status fixtures and preserves uncertainty", async () => {
    const fixture = JSON.parse(await readFile(new URL("../../contracts/errors.v1.json", import.meta.url), "utf8"));
    expect(ERROR_STATUS).toEqual(fixture.statusByCode);
    const error = new WorkspaceError("PUBLICATION_OUTCOME_UNKNOWN", "Reconcile the recorded operation", { operationId: "op-1", retryable: true });
    expect(error.statusCode).toBe(503);
    expect(error.toJSON()).toEqual({ error: { code: "PUBLICATION_OUTCOME_UNKNOWN", message: "Reconcile the recorded operation", operationId: "op-1", retryable: true } });
  });
});

describe("stable idempotency digests", () => {
  const input = { schemaVersion: 1 as const, customerId: "customer-a", actorId: "actor-a", credentialId: "key-a", kind: "finalize", resource: { workspaceId: "workspace-a", runId: "run-a" }, payload: { submissionId: "submission-a", expectedRunVersion: 2 } };
  it("matches independent versioned canonical request bytes and digest", async () => {
    const fixture = JSON.parse(await readFile(new URL("../fixtures/workspaces/request-digest.v1.json", import.meta.url), "utf8"));
    expect(canonicalJson(input)).toBe(fixture.canonical);
    expect(canonicalRequestDigest(input)).toBe(fixture.sha256);
  });
  it("ignores object insertion order while binding scope, actor, kind, and exact input", () => {
    const reordered = { ...input, payload: { expectedRunVersion: 2, submissionId: "submission-a" } };
    expect(canonicalRequestDigest(input)).toBe(canonicalRequestDigest(reordered));
    for (const change of [{ customerId: "customer-b" }, { actorId: "actor-b" }, { credentialId: "key-b" }, { kind: "abort" }, { payload: { submissionId: "submission-b", expectedRunVersion: 2 } }]) {
      expect(canonicalRequestDigest({ ...input, ...change })).not.toBe(canonicalRequestDigest(input));
    }
    expect(canonicalJson({ "2": "two", "10": "ten" })).toBe('{"10":"ten","2":"two"}');
  });
  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, { missing: undefined }, () => 1, 1n, "bad\ud800", { "bad\ud800": 1 }, new Date(), Array(1)])("rejects non-JSON request values", (value) => {
    expect(() => canonicalJson(value)).toThrow();
  });
});
