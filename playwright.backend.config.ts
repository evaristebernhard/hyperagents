import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dataDir = process.env.HYPERAGENTS_E2E_DIR || mkdtempSync(path.join(tmpdir(), "hyperagents-flow-e2e-"));
process.env.HYPERAGENTS_E2E_DIR = dataDir;
delete process.env.APP_OWNER_PASSWORD;
export default defineConfig({
  testDir: "./tests-backend",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  outputDir: "test-results/backend",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5174", viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5174 --strictPort",
    url: "http://127.0.0.1:5174",
    reuseExistingServer: false,
    timeout: 30000,
    env: { APP_DATA_DIR: dataDir, APP_PORT: "8788", APP_HOST: "127.0.0.1", APP_DEV_ORIGIN: "http://127.0.0.1:5174", APP_PUBLIC_ORIGIN: "", APP_ENV_FILE: "none" },
  },
  reporter: process.env.CI ? [["list"], ["github"], ["html", { outputFolder: "playwright-report/backend", open: "never" }]] : [["list"]],
});
