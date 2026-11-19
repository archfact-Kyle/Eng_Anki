import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.js/,
  timeout: 60_000,
  fullyParallel: true,
  reporter: 'list',
  use: {
    ...devices['iPhone 13'], browserName: 'chromium', baseURL: 'http://localhost:4173/',
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }, // fake mic for the recorder test
  },
  webServer: { command: 'node scripts/serve.mjs dist/pwa 4173', url: 'http://localhost:4173/', reuseExistingServer: true },
});
