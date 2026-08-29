// Mutation-run vitest scope: everything in the PRX suite EXCEPT
// bootstrap-install.test.ts. That suite spawns real pnpm installs to prove
// the workflow's --ignore-scripts contract (R7); it imports no mutated
// module, so it can never change a mutant's verdict — it only adds ~12s of
// subprocess time to every static-mutant run. It still runs in the real
// suite (`pnpm prx:test`, vitest.prx.config.ts) and in CI.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/prx/**/*.test.ts"],
    exclude: ["**/node_modules/**", "scripts/prx/bootstrap-install.test.ts"],
    testTimeout: 15000,
  },
});
