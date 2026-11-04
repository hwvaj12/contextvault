import { defineConfig } from "vitest/config";

// The public lifecycle gate stays independently runnable during staged implementation.
const s3 = process.env.CV_TEST_BACKEND === "s3" || process.env.CV_TEST_SUITE === "release";
const acceptance = process.env.CV_TEST_SUITE === "acceptance";
const sdk = process.env.CV_TEST_SUITE === "sdk";
const hosts = process.env.CV_TEST_SUITE === "hosts";
const mcp = process.env.CV_TEST_SUITE === "mcp";
const migration = process.env.CV_TEST_SUITE === "migration";
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    // Installed clients and S3 fixtures share external resources; keep their test files serial.
    maxWorkers: sdk || s3 || hosts ? 1 : 4,
    include: acceptance ? ["tests/acceptance/**/*.test.ts"] : ["tests/**/*.test.ts"],
    exclude: acceptance ? [] : ["tests/acceptance/**", ...(s3 ? [] : ["tests/adapters/s3/**"]), ...(sdk ? [] : ["tests/sdk/**"]), ...(hosts ? [] : ["tests/hosts/**"]), ...(mcp ? [] : ["tests/mcp/**"]), ...(migration ? [] : ["tests/migrations/**"])],
    passWithNoTests: false,
  },
});
