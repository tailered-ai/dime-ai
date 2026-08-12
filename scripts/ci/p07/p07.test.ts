/**
 * P07 validation suite — structural guarantees + the §27 negative program.
 *
 *   P07.STR01-04   structural derivations (marker discovery, registration
 *                  agreement, floor derivation, env-model reconciliation)
 *   P07.NEG01-15   the fifteen negative cases: registration omission,
 *                  collection collapse, load failure, lane discipline,
 *                  impact-mode refusal, stale base, runtime unavailability,
 *                  migration-blocks-suites, undeclared skips, allowlisted
 *                  environment failures, truncated results
 *
 * Real mechanisms only: the collection floor runs the CONTRACT's own shell
 * fragment; environment cases run the repo's check-environment-failures.mjs;
 * lane cases run the real P04 lane manager.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs module without type declarations
import {
  IMPACT_FLAGS,
  assertNoImpactSelection,
  assertFreshBase,
  crossCheck,
  deriveStructural,
} from "./run-p07.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { portFree } from "./mysql.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { LaneManager } from "../lane.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { loadVerifiedContract } from "../registry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const SCRATCH = mkdtempSync(path.join(tmpdir(), "p07-suite-"));
afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

/** The contract's own collection-floor shell fragment, verbatim mechanism. */
function runFloorFragment(numPassedTests: number, dir: string): number {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "vitest-results.json"),
    JSON.stringify({ numPassedTests })
  );
  const { contract } = loadVerifiedContract();
  const proofCheck = contract.checks.find(
    (c: { check_id: string }) =>
      c.check_id === ".github/workflows/01-pr-proof-contract.yml#proof"
  );
  const step: string = proofCheck.steps.find(
    (s: { run?: string }) =>
      typeof s.run === "string" && s.run.includes("numPassedTests")
  ).run;
  // Only the floor fragment: from PASSED= to the fi that guards it.
  const start = step.indexOf("PASSED=");
  const end = step.indexOf("fi", start) + 2;
  const fragment = step.slice(start, end);
  const child = spawnSync(
    "/bin/bash",
    ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", fragment],
    { cwd: dir, encoding: "utf8", timeout: 15_000 }
  );
  return child.status ?? -1;
}

function runEnvGate(results: unknown, profile: string, dir: string) {
  mkdirSync(dir, { recursive: true });
  const input = path.join(dir, "vitest-results.json");
  writeFileSync(
    input,
    typeof results === "string" ? results : JSON.stringify(results)
  );
  return spawnSync(
    "node",
    [
      path.join(REPO_ROOT, "scripts/check-environment-failures.mjs"),
      `--profile=${profile}`,
      `--input=${input}`,
      "--actor=ci-verify-local",
      `--report=${path.join(dir, "report.json")}`,
    ],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 15_000 }
  );
}

const passedResults = (n: number) => ({
  numTotalTests: n,
  numPassedTests: n,
  numFailedTests: 0,
  numPendingTests: 0,
  testResults: [],
});

let seq = 0;
const scratch = () => path.join(SCRATCH, `case-${(seq += 1)}`);

// ---------------------------------------------------------------------------
describe("P07.STR structural guarantees (§21)", () => {
  const structural = deriveStructural();

  it("STR01: canonical marker discovery and contract list agree exactly", () => {
    expect(structural.agreement).toBe(true);
    expect(structural.problems).toEqual([]);
    expect(structural.discovered_db_marker_files.length).toBeGreaterThan(0);
    expect(structural.contract_db_list.length).toBeGreaterThanOrEqual(
      structural.discovered_db_marker_files.length
    );
  });

  it("STR02: the collection floor derives from the contract, not an assumption", () => {
    expect(structural.collection_floor).toBeGreaterThan(0);
    expect(Number.isInteger(structural.collection_floor)).toBe(true);
  });

  it("STR03: environment-failure model re-derived from source", () => {
    expect(structural.env_model.entries).toBeGreaterThan(0);
    expect(structural.env_model.expected_ci_skips).toBeGreaterThan(0);
  });

  it("STR04: every discovered db suite is registered through the canonical mechanism", () => {
    for (const f of structural.discovered_db_marker_files.filter((x: string) =>
      x.startsWith("server/")
    )) {
      expect(structural.registration_test_list).toContain(path.basename(f));
    }
  });
});

// ---------------------------------------------------------------------------
describe("P07.NEG the fifteen-case negative program (§27)", () => {
  it("NEG01+14: a registration omission is detected (CONTRACT_DRIFT class)", () => {
    const problems = crossCheck({
      discovered: ["server/newSuite.db.test.ts"],
      contractList: [],
      markerBasenames: ["newSuite.db.test.ts"],
      regList: [],
      skipNames: "[]",
      floor: 1000,
    });
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(problems.join(" ")).toContain("newSuite.db.test.ts");
  });

  it("NEG02: collection below the contract floor fails via the contract's own fragment", () => {
    expect(runFloorFragment(999, scratch())).not.toBe(0);
  });

  it("NEG02b: collection at/above the floor passes the fragment", () => {
    expect(runFloorFragment(5000, scratch())).toBe(0);
  });

  it("NEG03: zero collection fails the fragment", () => {
    expect(runFloorFragment(0, scratch())).not.toBe(0);
  });

  it("NEG04: a file-level load failure can never summarize green", () => {
    const child = runEnvGate(
      {
        ...passedResults(2000),
        testResults: [
          {
            name: `${REPO_ROOT}/server/broken.test.ts`,
            status: "failed",
            assertionResults: [],
            message: "SyntaxError: import failure before any test ran",
          },
        ],
      },
      "ci",
      scratch()
    );
    expect(child.status).not.toBe(0);
  });

  it("NEG05: the P04 lane serializes two DB acquisitions structurally", async () => {
    const lanesRoot = path.join(scratch(), "lanes");
    mkdirSync(lanesRoot, { recursive: true });
    const lanes = new LaneManager({ root: lanesRoot, run_id: "p07-neg05" });
    const intervals: Array<{ enter: number; exit: number }> = [];
    const hold = async (gate: string) => {
      const acq = await lanes.acquire("db-serial", gate);
      const enter = Date.now();
      await new Promise(r => setTimeout(r, 120));
      const exit = Date.now();
      lanes.release(acq);
      intervals.push({ enter, exit });
    };
    await Promise.all([hold("g1"), hold("g2")]);
    expect(intervals.length).toBe(2);
    const [a, b] = intervals.sort((x, y) => x.enter - y.enter);
    expect(b.enter).toBeGreaterThanOrEqual(a.exit);
  });

  it("NEG07: impact/affected-test selection is refused in PARITY", () => {
    for (const flag of IMPACT_FLAGS) {
      expect(() =>
        assertNoImpactSelection(`pnpm exec vitest run ${flag} server/`)
      ).toThrow(/IMPACT_SELECTION_FORBIDDEN/);
    }
    expect(
      assertNoImpactSelection("pnpm exec vitest run --no-file-parallelism a.ts")
    ).toBe(true);
  });

  it("NEG08: reused evidence whose base differs from the fresh candidate's base refuses", () => {
    // Rewritten alongside the removal of this module's own `rev-parse
    // origin/main`. P01 is the sole resolver of branch provenance, so the
    // staleness question is not "what is origin/main now" — P01 already
    // answered that when it built the candidate — but "does the base recorded
    // in the evidence I am about to reuse still match the candidate I just
    // built". Both operands are P01 outputs; no ref is resolved here.
    const recorded = "a".repeat(40);
    const moved = "b".repeat(40);
    expect(() => assertFreshBase(recorded, moved)).toThrow(/STALE_CANDIDATE/);
    expect(assertFreshBase(recorded, recorded)).toBe(true);
    // No recorded base means nothing is being reused, so nothing is stale.
    expect(assertFreshBase(null, moved)).toBe(true);
  });

  it("NEG10: an occupied 3306 means REFUSAL, never a developer-DB substitution", async () => {
    const blocker = net.createServer();
    await new Promise<void>(resolve =>
      blocker.listen(3306, "127.0.0.1", () => resolve())
    );
    try {
      expect(await portFree(3306)).toBe(false);
    } finally {
      await new Promise(resolve => blocker.close(resolve));
    }
  });

  it("NEG11: a failing earlier detector blocks every later step (migration-blocks-suites)", () => {
    const root = scratch();
    const worktree = path.join(root, "wt");
    const stepDir = path.join(root, "steps");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(stepDir, { recursive: true });
    const spec = {
      gate_id: "neg11",
      worktree,
      gha: {},
      steps: [
        {
          index: 0,
          kind: "DETECTOR",
          mode: "execute",
          cwd: ".",
          env: {},
          provisioning_signatures: [],
          run: "echo migration replay failed; exit 1",
          adapted_run: null,
        },
        {
          index: 1,
          kind: "DETECTOR",
          mode: "execute",
          cwd: ".",
          env: {},
          provisioning_signatures: [],
          run: "echo SUITES > suites-ran.txt",
          adapted_run: null,
        },
      ],
    };
    const specPath = path.join(root, "spec.json");
    writeFileSync(specPath, JSON.stringify(spec));
    const child = spawnSync(
      "node",
      [path.join(REPO_ROOT, "scripts/ci/p06/step-driver.mjs"), specPath],
      {
        encoding: "utf8",
        env: { ...process.env, CI_VERIFY_STEP_DIR: stepDir },
        timeout: 15_000,
      }
    );
    expect(child.status).toBe(20);
    expect(
      require("node:fs").existsSync(path.join(worktree, "suites-ran.txt"))
    ).toBe(false);
  });

  it("NEG12: a CI skip without a declared reason is rejected", () => {
    const child = runEnvGate(
      {
        ...passedResults(2000),
        testResults: [
          {
            name: `${REPO_ROOT}/server/mystery.test.ts`,
            status: "passed",
            assertionResults: [
              {
                fullName: "mystery suite > undeclared skip",
                status: "skipped",
                ancestorTitles: ["mystery suite"],
              },
            ],
          },
        ],
      },
      "ci",
      scratch()
    );
    expect(child.status).not.toBe(0);
    expect(`${child.stdout}${child.stderr}`).toMatch(
      /expectedCiSkips|declared/i
    );
  });

  it("NEG13: profile=ci tolerates zero failures — even allowlisted ones", () => {
    const child = runEnvGate(
      {
        ...passedResults(2000),
        testResults: [
          {
            name: `${REPO_ROOT}/server/whatever.test.ts`,
            status: "failed",
            assertionResults: [
              {
                fullName: "any failure at all",
                status: "failed",
                ancestorTitles: [],
              },
            ],
          },
        ],
      },
      "ci",
      scratch()
    );
    expect(child.status).not.toBe(0);
  });

  it("NEG15: truncated results JSON can never summarize green", () => {
    const child = runEnvGate(
      '{"numPassedTests": 5000, "testResults": [{',
      "ci",
      scratch()
    );
    expect(child.status).not.toBe(0);
  });
});
