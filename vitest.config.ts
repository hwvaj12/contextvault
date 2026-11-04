import { defineConfig } from "vitest/config";

// The public lifecycle gate stays independently runnable during staged implementation.
const s3 = process.env.CV_TEST_BACKEND === "s3" || process.env.CV_TEST_SUITE === "release";
const acceptance = process.env.CV_TEST_SUITE === "acceptance";
const sdk = process.env.CV_TEST_SUITE === "sdk";
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    // Installed consumers share Docker and packaging resources; keep explicit SDK files serial.
    maxWorkers: sdk ? 1 : 4,
    include: acceptance ? ["tests/acceptance/**/*.test.ts"] : ["tests/**/*.test.ts"],
    exclude: acceptance ? [] : ["tests/acceptance/**", ...(s3 ? [] : ["tests/adapters/s3/**"]), ...(sdk ? [] : ["tests/sdk/**"])],
    passWithNoTests: false,
  },
});
