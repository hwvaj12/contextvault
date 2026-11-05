import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/docs/*.test.mts'], maxWorkers: 1, testTimeout: 180000, hookTimeout: 180000, passWithNoTests: false } });
