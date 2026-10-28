import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4178',
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHROME === '1' ? 'chrome' : undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm start',
    url: 'http://127.0.0.1:4178',
    env: { PORT: '4178' },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
