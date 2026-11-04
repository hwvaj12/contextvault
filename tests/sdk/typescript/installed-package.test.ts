import { describe, it, expect } from "vitest";
import { installedJourney } from "./installed-harness";
describe.each(["git", "s3"] as const)("installed TypeScript package: %s", backend => {
  it("runs secure capture, bounded verification and caller-managed resources on Node18", async () => {
    expect(await installedJourney(backend, "secure")).toContain("PASS secure Node18");
  }, 180000);
});
