import { defineConfig } from "vitest/config";

// The public lifecycle gate stays independently runnable during staged implementation.
const s3 = process.env.CV_TEST_BACKEND === "s3" || process.env.CV_TEST_SUITE === "release";
const acceptance = process.env.CV_TEST_SUITE === "acceptance";
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    include: acceptance ? ["tests/acceptance/**/*.test.ts"] : ["tests/**/*.test.ts"],
    exclude: acceptance ? [] : ["tests/acceptance/**", ...(s3 ? [] : ["tests/adapters/s3/**"])],
    passWithNoTests: false,
  },
});
