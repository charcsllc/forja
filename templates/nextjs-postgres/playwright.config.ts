import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against a running app. By default Playwright starts `npm run start`
 * (build first); set E2E_BASE_URL to test an app that is already running.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const external = Boolean(process.env.E2E_BASE_URL);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: external
    ? undefined
    : { command: "npm run start", url: `${baseURL}/api/health`, reuseExistingServer: true, timeout: 120_000 },
});
