import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/monitor-sso-e2e', testMatch: '**/*.spec.js', workers: 1,
  timeout: 45000, reporter: 'list',
  use: { browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: { command: JSON.stringify(process.execPath) + ' test/e2e/server.js', url: 'http://127.0.0.1:4173', reuseExistingServer: false }
});
