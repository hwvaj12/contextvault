import { describe, it, expect } from "vitest";
import { installedJourney } from "./installed-harness";
describe.each(["git", "s3"] as const)("installed TypeScript checkpoints: %s", backend => {
  it("persists publication before reopen, reuses reopen key and refreshes the next pinned base", async () => {
    expect(await installedJourney(backend, "checkpoint")).toContain("PASS checkpoint Node18");
  }, 180000);
});
