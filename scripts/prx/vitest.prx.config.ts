// PRX-only vitest scope: used by scripts/prx/stryker.prx.json so mutation
// runs never touch the DB-bound suites. The main repo suite still picks the
// PRX tests up through the root vitest.config.ts include.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/prx/**/*.test.ts"],
    testTimeout: 15000,
  },
});
