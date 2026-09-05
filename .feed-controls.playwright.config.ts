import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export default defineConfig({
  testDir: "e2e",
  testMatch: "feed-controls.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "../evidence/feed-controls-playwright",
  use: {
    baseURL: "http://localhost:5208",
    trace: "retain-on-failure",
    launchOptions: existsSync(chrome) ? { executablePath: chrome } : {},
  },
  webServer: {
    command:
      "node node_modules/vite/bin/vite.js preview --port 5208 --strictPort",
    port: 5208,
    reuseExistingServer: false,
  },
});
