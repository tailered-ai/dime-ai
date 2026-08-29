// Standalone PRX-only vitest scope. NOT wired into any script or gate:
// `pnpm prx:test` runs `vitest run scripts/prx/` through the ROOT vitest
// config, and both Stryker configurations use
// vitest.prx.mutation.config.ts (same include minus the pnpm-spawning
// bootstrap suite). Kept as a convenience for isolated runs:
//   npx vitest run -c scripts/prx/vitest.prx.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/prx/**/*.test.ts"],
    testTimeout: 15000,
  },
});
