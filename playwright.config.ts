import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests run against the production build served by `vite preview`
 * (which also applies public/_headers, so the CSP is enforced). The Mistral
 * API is mocked inside the tests; no network access is needed.
 *
 * Set CHROMIUM_EXECUTABLE_PATH to use a pre-installed Chromium instead of the
 * one Playwright downloads.
 */
const executablePath = process.env["CHROMIUM_EXECUTABLE_PATH"];

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: true,
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? "github" : "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: "npx vite build && npx vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
  },
});
