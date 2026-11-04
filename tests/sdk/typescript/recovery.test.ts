import { describe, it, expect } from "vitest";
import { installedJourney } from "./installed-harness";
describe.each(["git", "s3"] as const)("installed TypeScript recovery: %s", backend => {
  it("recovers pre-ID response loss and immutable publication after process restart", async () => {
    expect(await installedJourney(backend, "recovery")).toContain("PASS recovery Node18");
  }, 180000);
  it("reports stale conflict, expiry and failed cleanup independently", async () => {
    expect(await installedJourney(backend, "terminal", { CV_LEASE_TTL_MS: "5000", CV_MAINTENANCE_INTERVAL_MS: "100" })).toContain("PASS terminal Node18");
  }, 180000);
});
