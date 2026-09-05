import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  // Match the app's JSX transform (vite.config.ts uses the React automatic
  // runtime) so component tests can render real .tsx components without a
  // classic-runtime `React` import in scope — e.g. ProjectionCard.test.ts.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    // Refuses to run against a production database — several suites INSERT and
    // DELETE real app_users rows and read DATABASE_URL from the ambient shell.
    globalSetup: ["./vitest.globalSetup.ts"],
    env: {
      APP_SESSION_SECRET: "vitest-dummy-not-a-secret",
    },
    include: [
      "server/**/*.test.ts",
      "server/**/*.spec.ts",
      "perf/**/*.test.ts",
      "shared/**/*.test.ts",
      "shared/**/*.spec.ts",
      // Pure client-side units (no DOM, no DB): dime-chat reducer + [EDGE] parser
      "client/src/**/*.test.ts",
      "client/src/**/*.test.tsx",
      // Release-gate tooling (environment-failure gate, preview scanner)
      "scripts/**/*.test.ts",
    ],
    // 15s global timeout: the appRouter import in strikeoutProps.test.ts triggers a full
    // DB connection pool init which takes ~4-5s in isolation but can approach the old 5s
    // default when the full suite runs in parallel. 15s provides a safe margin without
    // masking genuinely hung tests.
    testTimeout: 15000,
  },
});
