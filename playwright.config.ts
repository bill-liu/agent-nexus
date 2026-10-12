import { defineConfig } from '@playwright/test';
const suite=process.env.AN_TEST_SUITE==='mac'?'mac':'electron';
export default defineConfig({
  testDir: './tests',
  testMatch: ['electron-security/**/*.spec.ts', 'macos-e2e/**/*.spec.ts'],
  workers: 1,
  fullyParallel: false,
  timeout: 45000,
  expect: { timeout: 10000 },
  outputDir:`test-results/${suite}`,
  reporter: [['list'], ['html', { open: 'never',outputFolder:`playwright-report/${suite}` }],['json',{outputFile:`playwright-report/${suite}/results.json`}]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
