import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['tests/unit/**/*.test.ts', 'tests/contract/**/*.test.ts', 'tests/recovery/**/*.test.ts'],
  environment: 'node',
  pool: 'forks',
  maxWorkers: 4,
  testTimeout: 15000
} });
