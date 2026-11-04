import { describe, it, expect } from "vitest";
import { installedJourney } from "./installed-harness";
describe.each(["git", "s3"] as const)("installed TypeScript lifecycle: %s", backend => {
  it("materializes exact binary, explicit directories, deletions and abort isolation for two tenants", async () => {
    expect(await installedJourney(backend, "lifecycle")).toContain("PASS lifecycle Node18");
  }, 180000);
});
