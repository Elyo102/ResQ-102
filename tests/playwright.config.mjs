import { defineConfig, devices } from 'playwright/test';

const runId = process.env.RESQ_E2E_RUN_ID ||= new Date().toISOString().replace(/[:.]/g, '-');
if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid evidence run ID');

// This is additive to the existing native emulator and browser suites.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 5000 },
  outputDir: './test-results/' + runId,
  reporter: [['list'], ['html', { open: 'never', outputFolder: './playwright-report/' + runId }]],
  use: {
    baseURL: 'http://127.0.0.1:41996',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'Mobile Chrome', use: { ...devices['Pixel 5'] } },
    { name: 'Desktop Chrome', use: { ...devices['Desktop Chrome'] } }
  ]
});
