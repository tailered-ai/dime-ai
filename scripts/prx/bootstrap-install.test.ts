// Remediation R7: the bootstrap install must never execute repository
// lifecycle scripts. The workflow runs
//   pnpm -C "$POLICY" install --frozen-lockfile --ignore-scripts
// and this regression proves, with a package fixture whose postinstall
// writes a marker file, that --ignore-scripts suppresses execution — and
// that the control run WITHOUT the flag creates the marker, so the test
// can fail (prove-the-check-can-fail).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const MARKER = "lifecycle-executed.marker";

describe("bootstrap install suppresses lifecycle scripts (R7)", () => {
  const dir = mkdtempSync(join(tmpdir(), "prx-bootstrap-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const runPnpm = (args: string[]) => {
    // Strip the parent pnpm-run/corepack environment so the child pnpm is
    // not bound to the repo's packageManager pin (known trap: children
    // spawned under `pnpm run` fail on pin mismatch otherwise).
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (/^(npm_|PNPM_|COREPACK_)/i.test(k)) continue;
      env[k] = v;
    }
    return spawnSync("pnpm", args, { cwd: dir, env, encoding: "utf8" });
  };

  it("--ignore-scripts blocks postinstall; the control run proves the marker CAN appear", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "prx-bootstrap-fixture",
          version: "1.0.0",
          private: true,
          scripts: {
            postinstall: `node -e "require('fs').writeFileSync('${MARKER}','executed')"`,
          },
        },
        null,
        2
      )
    );
    // Mirror the workflow's frozen-lockfile flow: author the lockfile
    // first (no install, no scripts), then install frozen.
    const lock = runPnpm(["install", "--lockfile-only"]);
    expect(lock.status).toBe(0);
    expect(existsSync(join(dir, MARKER))).toBe(false);

    const guarded = runPnpm([
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ]);
    expect(guarded.status).toBe(0);
    expect(existsSync(join(dir, MARKER))).toBe(false);

    // Negative control: without --ignore-scripts the marker IS created,
    // so a silent regression in the flag's effect cannot pass this test.
    // node_modules is removed first — a no-op install runs no lifecycle
    // scripts either, which would make this control vacuous.
    rmSync(join(dir, "node_modules"), { recursive: true, force: true });
    const control = runPnpm(["install", "--frozen-lockfile"]);
    expect(control.status).toBe(0);
    expect(existsSync(join(dir, MARKER))).toBe(true);
  }, 120000);
});
