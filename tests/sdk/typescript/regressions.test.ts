import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { installedJourney } from "./installed-harness";

const execute = promisify(execFile);
describe.each(["git", "s3"] as const)("installed TypeScript recovery regressions: %s", backend => {
  for (const scenario of ["competing-workflow", "poll-deadline", "refresh-abort", "orphan-capture", "commit-receipt",
    "early-abort-finalize", "early-abort-checkpoint", "early-abort-unknown-publication",
    "metadata-retention", "metadata-pending", "metadata-budget", "boundary-known-rejection", "boundary-uncertain-rejection", "boundary-cleaned-session",
    "reopen-known-cleanup", "reopen-unknown-cleanup"]) {
    it(scenario, async () => {
      const outcome = await installedJourney(backend, scenario, scenario === "boundary-known-rejection" ? { CV_WORKSPACE_LIMITS: '{"maxFileBytes":1}' } : {});
      expect(outcome).toContain(`PASS ${scenario} Node18`);
      if (scenario.startsWith("metadata-")) console.info(outcome.split("\n").filter(line => line.startsWith("OBS ")).join("\n"));
    }, 180000);
  }
});

it("stops only its owned unresponsive Node18 consumer within the timeout", async () => {
  const identity = randomUUID(); const name = `cv-ts-${identity}`;
  let settled = false;
  const running = installedJourney("git", "ignore-termination", {}, { consumerTimeoutMs: 700, consumerIdentity: identity })
    .then(() => { settled = true; throw new Error("Unresponsive consumer unexpectedly succeeded"); }, () => { settled = true; });
  try {
    const startupDeadline = Date.now() + 15000;
    while (Date.now() < startupDeadline) {
      const inspection = await execute("docker", ["inspect", "--format", "{{.State.Running}}", name], { timeout: 1000, killSignal: "SIGKILL" }).catch(() => ({ stdout: "" }));
      if (inspection.stdout.trim() === "true") break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const inspection = await execute("docker", ["inspect", "--format", "{{.State.Running}}", name], { timeout: 1000, killSignal: "SIGKILL" });
    expect(inspection.stdout.trim()).toBe("true");
    await new Promise(resolve => setTimeout(resolve, 1800));
    expect(settled, "CLI timeout must settle and remove the owned container").toBe(true);
    const remains = await execute("docker", ["inspect", name], { timeout: 1000, killSignal: "SIGKILL" }).then(() => true, () => false);
    expect(remains).toBe(false);
  } finally {
    // This test owns the exact generated name, including on the expected red baseline.
    await execute("docker", ["rm", "-f", name], { timeout: 3000, killSignal: "SIGKILL" }).catch(() => {});
    await running;
  }
}, 45000);
