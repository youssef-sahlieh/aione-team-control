import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test/e2e", testMatch: "**/*.spec.js", fullyParallel: true,
  forbidOnly: !!process.env.CI, retries: process.env.CI ? 1 : 0, workers: process.env.CI ? 2 : undefined,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4173", browserName: "chromium", trace: "retain-on-failure" },
  webServer: { command: "node test/e2e/server.js", url: "http://127.0.0.1:4173", reuseExistingServer: false }
});
