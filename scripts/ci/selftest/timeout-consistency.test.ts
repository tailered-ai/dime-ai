/**
 * Timeout-consistency meta-audit — never-regress anchor for the
 * DEF-060/DEF-061 class: a test that grants a subprocess a bigger budget
 * than its own vitest timeout is self-inconsistent — under load the test
 * dies first and the failure surfaces as nondeterministic flake instead of
 * a deterministic verdict.
 *
 * Rule (file granularity, deliberately conservative): for every tracked
 * *.test.ts, the largest `timeout: N` option found anywhere in the file
 * must be ≤ max(global testTimeout, largest explicit per-test timeout in
 * that file). Over-demanding is possible (a vitest options-object timeout
 * counts into the subprocess side too); under-demanding is not — which is
 * the direction that matters for a guard.
 *
 * Also anchors DEF-060's specific fix: strikeoutProps must keep its static
 * appRouter import (a dynamic import inside a bounded test body is the
 * defect).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

const GLOBAL_TEST_TIMEOUT = (() => {
  const config = readFileSync(path.join(REPO, "vitest.config.ts"), "utf8");
  const m = config.match(/testTimeout:\s*(\d[\d_]*)/);
  expect(m, "vitest.config.ts must declare testTimeout").toBeTruthy();
  return Number(m![1].replace(/_/g, ""));
})();

function trackedTestFiles(): string[] {
  return execFileSync("git", ["ls-files", "*.test.ts"], {
    cwd: REPO,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
}

describe("timeout-consistency meta-audit (DEF-060/061 anchor)", () => {
  it("no test file grants a subprocess more time than the file's own test bound allows", () => {
    const violations: string[] = [];
    for (const rel of trackedTestFiles()) {
      const text = readFileSync(path.join(REPO, rel), "utf8");
      const budgets = [...text.matchAll(/timeout:\s*(\d[\d_]*)/g)].map(m =>
        Number(m[1].replace(/_/g, ""))
      );
      if (!budgets.length) continue;
      const maxBudget = Math.max(...budgets);
      const explicit = [...text.matchAll(/\},\s*(\d[\d_]*)\s*\)/g)].map(m =>
        Number(m[1].replace(/_/g, ""))
      );
      const allowed = Math.max(GLOBAL_TEST_TIMEOUT, ...explicit, 0);
      if (maxBudget > allowed) {
        violations.push(
          `${rel}: subprocess budget ${maxBudget}ms exceeds the file's ` +
            `effective test bound ${allowed}ms — annotate the heavy test ` +
            `with an explicit timeout ≥ ${maxBudget} or shrink the budget`
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("strikeoutProps keeps the static appRouter import (DEF-060)", () => {
    const text = readFileSync(
      path.join(REPO, "server/strikeoutProps.test.ts"),
      "utf8"
    );
    expect(text).toMatch(/^import \{ appRouter \} from "\.\/routers";/m);
    expect(text).not.toMatch(/await import\("\.\/routers"\)/);
  });

  it("the closure tests keep their explicit budgets (DEF-061)", () => {
    const text = readFileSync(
      path.join(REPO, "scripts/dime-authentication-closure.test.ts"),
      "utf8"
    );
    const annotations = [...text.matchAll(/\},\s*(\d[\d_]*)\s*\)/g)].map(m =>
      Number(m[1].replace(/_/g, ""))
    );
    expect(annotations.filter(n => n >= 120_000).length).toBeGreaterThanOrEqual(
      2
    );
  });
});
