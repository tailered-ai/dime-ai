/**
 * P05 validation suite — the ASSURANCE self-test framework.
 *
 *   P05.TEST01-03  three REAL contract gates proven: poison rejects for the
 *                  declared reason, control restores and returns green
 *   P05.TEST04     determinism: repeated cycles, identical proof semantics
 *   P05.NEG01      wrong gate reddens          -> BROKEN_GATE(WRONG_TARGET)
 *   P05.NEG02      control stays red / residue -> BROKEN_GATE(NON_RESTORING)
 *   P05.NEG03      mandatory gate, no proof    -> BROKEN_GATE(UNPROVEN)
 *                  -> VERIFIER_BROKEN, and clears when a proof is supplied
 *   P05.NEG04      live poison in a scanned path -> LIVE_POISON_FIXTURE,
 *                  refused BEFORE any gate runs
 *   P05.NEG05      right gate, wrong detector  -> BROKEN_GATE(WRONG_REASON)
 *   P05.NEG06      false-assurance adversarial suite
 *   P05.NEG07      interrupted cycle emits no proof and leaks no poison
 *   P05.AUD01/02   poison containment + architectural isolation
 *
 * Real-gate cycles are slow by nature (a cycle runs the production command
 * twice inside a fresh worktree). Timeouts are generous and deliberate.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs module without type declarations
import {
  APPLICABILITIES,
  FIXTURE_SCHEMA_VERSION,
  discoverFixtures,
  loadFixture,
  parsePatchPaths,
  validateAgainstRegistry,
} from "./fixture.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import {
  APPROVED_FIXTURE_ROOTS,
  SENSITIVE_ROOTS,
  scanTreeForLivePoison,
  validateFixtureStorage,
} from "./placement.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import {
  BROKEN_SUBCODES,
  SEED_FIXTURES_ROOT,
  buildAssuranceArtifact,
  makeContext,
  matchReasons,
  proofToResult,
  runFixtureCycle,
  sweepStaleRunDirs,
  verifyAssurance,
  writeAssurance,
} from "./assurance.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { assertCoverage, buildCoverage, loadGraduated } from "./coverage.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import {
  auditArchitecturalIsolation,
  auditPoisonContainment,
} from "./p05-audit.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { reduceResults } from "../result.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const NODE = process.execPath;
const SCRATCH = mkdtempSync(path.join(tmpdir(), "p05-suite-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** Cycles are expensive; each real gate is proven exactly once and shared. */
const proofs = new Map<string, Record<string, unknown>>();
let ctx: Record<string, unknown>;

async function proveOnce(fixtureId: string) {
  if (!proofs.has(fixtureId)) {
    const fixture = loadFixture(path.join(SEED_FIXTURES_ROOT, fixtureId));
    proofs.set(fixtureId, await runFixtureCycle(fixture, ctx));
  }
  return proofs.get(fixtureId)!;
}

beforeAll(() => {
  ctx = makeContext();
});

/** A controlled in-memory fixture double — never written into the repo. */
function fixtureDouble(fixtureId: string, overrides: Record<string, unknown>) {
  const fixture = loadFixture(path.join(SEED_FIXTURES_ROOT, fixtureId));
  return {
    ...fixture,
    expect: { ...fixture.expect, ...overrides },
    reasons: (overrides.expected_reason as unknown[]) ?? fixture.reasons,
  };
}

/** A controlled PARITY registry double for pure coverage-law tests. */
function registryDouble(entries: Array<Record<string, unknown>>) {
  return { entries, contract_sha256: "0".repeat(64) };
}

/** Live git worktree registrations — a live run is always registered. */
function registeredWorktrees(): Set<string> {
  return new Set(
    execFileSync("git", ["-C", REPO_ROOT, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
      .split("\n")
      .filter(line => line.startsWith("worktree "))
      .map(line => line.slice("worktree ".length))
  );
}

// ---------------------------------------------------------------------------
// P05.TEST01-03 — three real gates proven
// ---------------------------------------------------------------------------
const SEEDS: Array<[string, string, string]> = [
  ["P05.TEST01", "typecheck-ts2322", ".github/workflows/ci.yml#typecheck"],
  [
    "P05.TEST02",
    "format-check-violation",
    ".github/workflows/01-pr-proof-contract.yml#format-check",
  ],
  [
    "P05.TEST03",
    "drizzle-meta-stray",
    ".github/workflows/08-contract-and-data-integrity.yml#contracts",
  ],
];

describe.each(SEEDS)(
  "%s real gate proof: %s",
  (unit, fixtureId, expectedGate) => {
    it("poison rejects for the declared reason; control restores and returns green", async () => {
      const record = await proveOnce(fixtureId);
      // The exact gate, identified by stable contract ID.
      expect(record.expected_gate).toBe(expectedGate);
      expect(record.verdict, JSON.stringify(record.detail ?? "")).toBe(
        "PROVEN"
      );
      // Poison leg: a real detector verdict, never infrastructure noise.
      expect(record.poison.status).toBe("FAIL");
      expect(record.poison.exit_code).toBeGreaterThan(0);
      // Every declared reason signature matched.
      expect(record.reason_match.length).toBeGreaterThan(0);
      for (const match of record.reason_match) expect(match.matched).toBe(true);
      // Poison actually changed bytes, and exactly the declared paths.
      expect(record.pre_poison_hashes).not.toEqual(record.post_poison_hashes);
      // Restoration is byte-for-byte.
      expect(record.restored_hashes).toEqual(record.pre_poison_hashes);
      // Control: the SAME gate returns to its declared healthy state.
      expect(record.control.status).toBe("PASS");
      expect(record.control.exit_code).toBe(0);
      // Candidate disposed; zero residue.
      expect(record.worktree_disposed).toBe(true);
      // The canonical P03 result for a proof is a PASS in class ASSURANCE.
      const result = proofToResult(record);
      expect(result.class).toBe("ASSURANCE");
      expect(result.status).toBe("PASS");
    }, 600_000);
  }
);

// ---------------------------------------------------------------------------
// P05.TEST04 — determinism
// ---------------------------------------------------------------------------
describe("P05.TEST04 repeated cycles produce identical proof semantics", () => {
  it("a second independent cycle of the same fixture agrees on every logical field", async () => {
    const first = await proveOnce("drizzle-meta-stray");
    const fixture = loadFixture(
      path.join(SEED_FIXTURES_ROOT, "drizzle-meta-stray")
    );
    const second = await runFixtureCycle(fixture, ctx);
    for (const field of [
      "verdict",
      "expected_gate",
      "expected_status",
      "patch_sha256",
    ]) {
      expect(second[field as keyof typeof second]).toEqual(
        first[field as keyof typeof first]
      );
    }
    expect(second.poison.status).toBe(first.poison.status);
    expect(second.poison.exit_code).toBe(first.poison.exit_code);
    expect(second.control.status).toBe(first.control.status);
    // Deterministic content identity: the same poison, the same changed set.
    expect(second.post_poison_hashes).toEqual(first.post_poison_hashes);
    // A flaky fixture could never satisfy this, so it could never be PROVEN.
    expect(second.verdict).toBe("PROVEN");
  }, 600_000);
});

// ---------------------------------------------------------------------------
// P05.NEG01 — wrong target
// ---------------------------------------------------------------------------
describe("P05.NEG01 a fixture reddening the wrong gate is not proof", () => {
  it("drizzle poison declared against the workflow-security gate yields WRONG_TARGET", async () => {
    const double = fixtureDouble("drizzle-meta-stray", {
      expected_gate: ".github/workflows/05-workflow-security.yml#zizmor",
      target_contract_id: ".github/workflows/05-workflow-security.yml#zizmor",
      command_step_indexes: [2],
      allowed_execution_artifacts: ["zizmor.sarif"],
    });
    const record = await runFixtureCycle(double, ctx);
    expect(record.verdict).toBe("BROKEN_GATE");
    expect(record.subcode).toBe("WRONG_TARGET");
    // "Something went red" is explicitly NOT accepted: the declared gate
    // stayed green because the poison was never its concern.
    expect(record.poison.status).toBe("PASS");
    expect(BROKEN_SUBCODES).toContain(record.subcode);
    // It reduces to VERIFIER_BROKEN through the frozen P03 semantics.
    expect(reduceResults([proofToResult(record)]).terminal).toBe(
      "VERIFIER_BROKEN"
    );
  }, 600_000);
});

// ---------------------------------------------------------------------------
// P05.NEG02 — non-restoring
// ---------------------------------------------------------------------------
describe("P05.NEG02 a cycle that does not restore is not proof", () => {
  it("an execution artifact left undeclared yields NON_RESTORING", async () => {
    // The zizmor gate writes zizmor.sarif. Declaring no allowed artifacts
    // means the candidate is NOT byte-identical to control after revert.
    const double = fixtureDouble("workflow-template-injection", {
      allowed_execution_artifacts: [],
    });
    const record = await runFixtureCycle(double, ctx);
    expect(record.verdict).toBe("BROKEN_GATE");
    expect(record.subcode).toBe("NON_RESTORING");
    expect(record.residue.untracked).toContain("zizmor.sarif");
    // Poison detection succeeding does not rescue it.
    expect(reduceResults([proofToResult(record)]).terminal).toBe(
      "VERIFIER_BROKEN"
    );
  }, 600_000);
});

// ---------------------------------------------------------------------------
// P05.NEG03 — the mandatory-gate coverage law (P05.GATE02)
// ---------------------------------------------------------------------------
describe("P05.NEG03 a graduated mandatory gate without proof is UNPROVEN", () => {
  const gate = "wf#mandatory-gate";
  const registry = registryDouble([
    {
      gate_id: gate,
      status_context: "mandatory-gate",
      runnability: "LOCAL",
      required: true,
      graduating: false,
      required_tools: [],
    },
  ]);

  it("graduated + no proof -> BROKEN_GATE(UNPROVEN) -> VERIFIER_BROKEN", () => {
    const coverage = buildCoverage({
      registry,
      fixtures: [],
      records: [],
      graduated: [gate],
      toolProbe: () => true,
    });
    const row = coverage.rows[0];
    expect(row.proof_state).toBe("UNPROVEN");
    expect(row.blocking).toBe(true);
    const assertion = assertCoverage(coverage);
    expect(assertion.ok).toBe(false);
    expect(assertion.results[0].status).toBe("BROKEN_GATE");
    expect(assertion.results[0].reason).toMatch(/^UNPROVEN:/);
    expect(assertion.terminal).toBe("VERIFIER_BROKEN");
  });

  it("supplying a valid proof clears it; removing the proof restores it", () => {
    const proof = {
      fixture_id: "fx",
      expected_gate: gate,
      verdict: "PROVEN",
      applicability: "seed",
    };
    const withProof = buildCoverage({
      registry,
      fixtures: [
        { id: "fx", expect: { expected_gate: gate, applicability: "seed" } },
      ],
      records: [proof],
      graduated: [gate],
      toolProbe: () => true,
    });
    expect(withProof.rows[0].proof_state).toBe("PROVEN");
    expect(assertCoverage(withProof).ok).toBe(true);
    expect(assertCoverage(withProof).terminal).toBe("LOCAL_READY_FOR_PR");

    const withoutProof = buildCoverage({
      registry,
      fixtures: [],
      records: [],
      graduated: [gate],
      toolProbe: () => true,
    });
    expect(withoutProof.rows[0].proof_state).toBe("UNPROVEN");
  });

  it("a NOT-yet-graduated gate is truthfully unproven WITHOUT being blocking", () => {
    const coverage = buildCoverage({
      registry,
      fixtures: [],
      records: [],
      graduated: [],
      toolProbe: () => true,
    });
    expect(coverage.rows[0].proof_state).toBe("NOT_YET_MANDATORY");
    expect(coverage.rows[0].proof_state).not.toBe("PROVEN");
    expect(coverage.rows[0].blocking).toBe(false);
    expect(assertCoverage(coverage).ok).toBe(true);
  });

  it("a CI-ONLY gate is never required to carry a local poison proof", () => {
    const coverage = buildCoverage({
      registry: registryDouble([
        {
          gate_id: "wf#ci-only",
          runnability: "CI-ONLY",
          required: true,
          graduating: false,
          required_tools: [],
        },
      ]),
      graduated: ["wf#ci-only"],
      toolProbe: () => true,
    });
    expect(coverage.rows[0].proof_state).toBe("CI_ONLY");
    expect(coverage.rows[0].blocking).toBe(false);
  });

  it("an unavailable tool yields NOT_LOCALLY_EXECUTABLE, never a fake proof", () => {
    const coverage = buildCoverage({
      registry: registryDouble([
        {
          gate_id: "wf#needs-tool",
          runnability: "LOCAL+TOOL",
          required: true,
          graduating: false,
          required_tools: ["a-tool-that-is-not-installed"],
        },
      ]),
      graduated: ["wf#needs-tool"],
      toolProbe: () => false,
    });
    expect(coverage.rows[0].proof_state).toBe("NOT_LOCALLY_EXECUTABLE");
    expect(coverage.rows[0].proof_state).not.toBe("PROVEN");
  });

  it("a `finding` record can NEVER satisfy the law — it marks the gate UNPROVEN", () => {
    const coverage = buildCoverage({
      registry,
      fixtures: [],
      records: [
        {
          fixture_id: "finding-fx",
          expected_gate: gate,
          verdict: "FINDING_CONFIRMED",
          applicability: "finding",
        },
      ],
      graduated: [gate],
      toolProbe: () => true,
    });
    expect(coverage.rows[0].proof_state).toBe("UNPROVEN");
    expect(coverage.rows[0].cannot_reject).toBe(true);
    expect(coverage.rows[0].blocking).toBe(true);
    expect(assertCoverage(coverage).terminal).toBe("VERIFIER_BROKEN");
  });
});

// ---------------------------------------------------------------------------
// P05.NEG04 — live poison fixture placement
// ---------------------------------------------------------------------------
describe("P05.NEG04 live poison in a scanned path refuses before any gate runs", () => {
  const root = path.join(SCRATCH, "placement");

  function plant(relDir: string, files: Record<string, string>) {
    const dir = path.join(root, relDir);
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), body);
    }
    return dir;
  }

  it("a fixture stored under .github/workflows is refused", () => {
    const dir = plant(".github/workflows/p05-live-poison", {
      "poison.patch": "diff --git a/x b/x\n",
    });
    expect(() => validateFixtureStorage(dir, { repoRoot: root })).toThrow(
      /LIVE_POISON_FIXTURE/
    );
  });

  it("a fixture stored under drizzle is refused", () => {
    const dir = plant("drizzle/p05-live-poison", {
      "poison.patch": "diff --git a/x b/x\n",
    });
    expect(() => validateFixtureStorage(dir, { repoRoot: root })).toThrow(
      /LIVE_POISON_FIXTURE/
    );
  });

  it("a LIVE-format file inside an approved fixture dir is refused", () => {
    const dir = plant("scripts/ci/selftest/fixtures/p05-live-workflow", {
      "poison.patch": "diff --git a/x b/x\n",
      // A real workflow file, not inert patch bytes.
      "p05-poison.yml": "on: issues\njobs: {}\n",
    });
    try {
      validateFixtureStorage(dir, { repoRoot: root });
      expect.unreachable("live-format fixture file must be refused");
    } catch (error) {
      expect((error as { reason: string }).reason).toBe("LIVE_POISON_FIXTURE");
      expect(
        (error as { violations: Array<{ file: string }> }).violations[0].file
      ).toContain("p05-poison.yml");
    }
  });

  it("CONTROL: the same poison stored as inert patch bytes is accepted", () => {
    const dir = plant("scripts/ci/selftest/fixtures/p05-inert", {
      "poison.patch":
        "diff --git a/.github/workflows/x.yml b/.github/workflows/x.yml\n" +
        "+++ b/.github/workflows/x.yml\n+  run: echo ${{ github.event.issue.title }}\n",
      "expect.json": "{}",
    });
    expect(validateFixtureStorage(dir, { repoRoot: root }).ok).toBe(true);
  });

  it("the runner refuses a live-poison fixture BEFORE running any gate", async () => {
    const dir = plant(".github/workflows/p05-runner-refusal", {
      "poison.patch": "diff --git a/x b/x\n",
    });
    const record = await runFixtureCycle(
      { id: "p05-runner-refusal", dir, expect: {}, reasons: [] },
      { ...ctx, repoRoot: root }
    );
    expect(record.verdict).toBe("BROKEN_GATE");
    expect(record.subcode).toBe("LIVE_POISON_FIXTURE");
    // No candidate was ever created for it.
    expect(record.candidate).toBeUndefined();
  });

  it("the tree scanner separates a live violation from inert storage", () => {
    writeFileSync(
      path.join(root, "live.yml"),
      "run: echo ${{ github.event.issue.title }}\n"
    );
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    cpSync(
      path.join(root, "live.yml"),
      path.join(root, ".github/workflows/live.yml")
    );
    const scan = scanTreeForLivePoison(
      [
        ".github/workflows/live.yml",
        "scripts/ci/selftest/fixtures/p05-inert/poison.patch",
      ],
      { repoRoot: root }
    );
    expect(scan.ok).toBe(false);
    expect(scan.findings[0].classification).toBe("LIVE_POISON_VIOLATION");
    expect(scan.classified[0].classification).toBe("INERT_FIXTURE");
  });
});

// ---------------------------------------------------------------------------
// P05.NEG05 — wrong reason
// ---------------------------------------------------------------------------
describe("P05.NEG05 the right gate failing for the wrong reason is not proof", () => {
  it("a detector signature that does not match yields WRONG_REASON", async () => {
    const double = fixtureDouble("drizzle-meta-stray", {
      expected_reason: [
        {
          source: "stdout",
          // Specific, and deliberately not what this detector emits.
          regex: "p05-nonexistent-detector-signature-marker",
        },
      ],
    });
    const record = await runFixtureCycle(double, ctx);
    expect(record.verdict).toBe("BROKEN_GATE");
    expect(record.subcode).toBe("WRONG_REASON");
    // The gate DID go red — that is precisely what is not sufficient.
    expect(record.poison.status).toBe("FAIL");
    // Both the expected and the actual reason are preserved as evidence.
    expect(record.stdout_tail ?? record.stderr_tail).toBeDefined();
    expect(reduceResults([proofToResult(record)]).terminal).toBe(
      "VERIFIER_BROKEN"
    );
  }, 600_000);

  it("reason matching reads the declared stream, not any stream", () => {
    const sources = {
      stdout: "nothing here",
      stderr: "[warn] the real detector spoke here",
      result_reason: "EXIT_1",
      worktree: SCRATCH,
    };
    expect(
      matchReasons([{ source: "stdout", regex: "the real detector" }], sources)
        .matched
    ).toBe(false);
    expect(
      matchReasons([{ source: "stderr", regex: "the real detector" }], sources)
        .matched
    ).toBe(true);
  });

  it("EVERY declared signature must match, not merely one", () => {
    const sources = {
      stdout: "first-signature present",
      stderr: "",
      result_reason: "",
      worktree: SCRATCH,
    };
    const outcome = matchReasons(
      [
        { source: "stdout", regex: "first-signature" },
        { source: "stdout", regex: "second-signature" },
      ],
      sources
    );
    expect(outcome.matched).toBe(false);
    expect(
      outcome.outcomes.map((o: { matched: boolean }) => o.matched)
    ).toEqual([true, false]);
  });
});

// ---------------------------------------------------------------------------
// P05.NEG06 — false-assurance adversarial suite
// ---------------------------------------------------------------------------
describe("P05.NEG06 nothing but a complete, exact cycle counts as proof", () => {
  const fixtureDir = path.join(SEED_FIXTURES_ROOT, "drizzle-meta-stray");

  function tempFixture(mutate: (expectJson: Record<string, unknown>) => void) {
    const dir = path.join(
      SCRATCH,
      "scripts/ci/selftest/fixtures",
      `fx-${Math.abs(Date.now() % 1e6)}-${Math.random().toString(36).slice(2, 8)}`
    );
    mkdirSync(dir, { recursive: true });
    cpSync(
      path.join(fixtureDir, "poison.patch"),
      path.join(dir, "poison.patch")
    );
    const expectJson = JSON.parse(
      readFileSync(path.join(fixtureDir, "expect.json"), "utf8")
    );
    expectJson.fixture_id = path.basename(dir);
    mutate(expectJson);
    writeFileSync(
      path.join(dir, "expect.json"),
      JSON.stringify(expectJson, null, 2)
    );
    return dir;
  }

  it("a poison patch that changes nothing cannot be a fixture", () => {
    expect(() => parsePatchPaths("")).toThrow(/PATCH_EMPTY/);
    expect(() => parsePatchPaths("no file headers here\n")).toThrow(
      /PATCH_EMPTY/
    );
  });

  it("absolute, traversing, unprefixed, and .git patch paths are refused", () => {
    expect(() => parsePatchPaths("--- a/x\n+++ /etc/passwd\n")).toThrow(
      /PATCH_PATH_UNPREFIXED/
    );
    expect(() => parsePatchPaths("--- a/x\n+++ b/../../escape.txt\n")).toThrow(
      /PATCH_PATH_TRAVERSAL/
    );
    expect(() => parsePatchPaths("--- a/x\n+++ b/.git/config\n")).toThrow(
      /PATCH_PATH_GIT_ADMIN/
    );
    expect(() => parsePatchPaths("--- a/x\n+++ C:\\\\windows\\\\x\n")).toThrow(
      /PATCH_PATH_UNPREFIXED/
    );
  });

  it("a tampered poison patch invalidates the fixture hash", () => {
    const dir = tempFixture(() => {});
    writeFileSync(
      path.join(dir, "poison.patch"),
      readFileSync(path.join(dir, "poison.patch"), "utf8") + "\n# tampered\n"
    );
    expect(() => loadFixture(dir)).toThrow(/FIXTURE_HASH_MISMATCH/);
  });

  it("a declared changed-path set that disagrees with the patch is refused", () => {
    const dir = tempFixture(e => {
      e.expected_changed_paths = ["some/other/file.ts"];
    });
    expect(() => loadFixture(dir)).toThrow(/CHANGED_PATHS_MISMATCH/);
  });

  it("an unsupported schema version is refused", () => {
    const dir = tempFixture(e => {
      e.schema_version = "9.9.9";
    });
    expect(() => loadFixture(dir)).toThrow(/SCHEMA_UNSUPPORTED/);
    expect(FIXTURE_SCHEMA_VERSION).toBe("1.0.0");
  });

  it("an ambiguous target (expected_gate != target_contract_id) is refused", () => {
    const dir = tempFixture(e => {
      e.target_contract_id = ".github/workflows/ci.yml#typecheck";
    });
    expect(() => loadFixture(dir)).toThrow(/TARGET_ID_AMBIGUOUS/);
  });

  it("a fixture id that disagrees with its directory is refused", () => {
    const dir = tempFixture(e => {
      e.fixture_id = "not-the-directory-name";
    });
    expect(() => loadFixture(dir)).toThrow(/FIXTURE_ID_MISMATCH/);
  });

  it("an overly broad or invalid reason signature is refused", () => {
    for (const bad of [
      { source: "stdout", regex: "." },
      { source: "stdout", regex: "" },
      { source: "stdout", regex: ".*" },
      { source: "nowhere", regex: "specific-enough-signature" },
      { source: "stdout", regex: "((unclosed" },
      { source: "artifact", regex: "specific-enough-signature" },
    ]) {
      const dir = tempFixture(e => {
        e.expected_reason = [bad];
      });
      expect(() => loadFixture(dir), JSON.stringify(bad)).toThrow();
    }
  });

  it("an undefined control expectation is refused", () => {
    const dir = tempFixture(e => {
      delete (e as Record<string, unknown>).control_expectation;
    });
    expect(() => loadFixture(dir)).toThrow(/EXPECT_FIELD_MISSING/);
  });

  it("an unknown applicability is refused; the vocabulary is closed", () => {
    const dir = tempFixture(e => {
      e.applicability = "definitely-proven";
    });
    expect(() => loadFixture(dir)).toThrow(/APPLICABILITY_UNKNOWN/);
    expect(APPLICABILITIES).toEqual(["seed", "negative-control", "finding"]);
  });

  it("a target gate outside the registry, or CI-ONLY, is refused", () => {
    const fixture = loadFixture(fixtureDir);
    const registry = registryDouble([]);
    expect(() =>
      validateAgainstRegistry(fixture, registry, (ctx as any).contract)
    ).toThrow(/TARGET_GATE_UNKNOWN/);
    const ciOnly = registryDouble([
      { gate_id: fixture.expect.expected_gate, runnability: "CI-ONLY" },
    ]);
    expect(() =>
      validateAgainstRegistry(fixture, ciOnly, (ctx as any).contract)
    ).toThrow(/TARGET_CI_ONLY/);
    const duplicated = registryDouble([
      { gate_id: fixture.expect.expected_gate, runnability: "LOCAL" },
      { gate_id: fixture.expect.expected_gate, runnability: "LOCAL" },
    ]);
    expect(() =>
      validateAgainstRegistry(fixture, duplicated, (ctx as any).contract)
    ).toThrow(/TARGET_ID_AMBIGUOUS/);
  });

  it("a non-runnable declared command step is refused", () => {
    const dir = tempFixture(e => {
      e.command_step_indexes = [0]; // a `uses:` step, not a `run:` step
    });
    const fixture = loadFixture(dir);
    expect(() =>
      validateAgainstRegistry(
        fixture,
        (ctx as any).registry,
        (ctx as any).contract
      )
    ).toThrow(/COMMAND_STEP_NOT_RUNNABLE/);
    const empty = tempFixture(e => {
      e.command_step_indexes = [];
    });
    expect(() => loadFixture(empty)).toThrow(/COMMAND_STEPS_INVALID/);
  });

  it("duplicate fixture ids are structurally impossible under one root", () => {
    // Identity is the directory name, so two fixtures cannot share an id.
    const dirs = discoverFixtures(SEED_FIXTURES_ROOT).map((d: string) =>
      path.basename(d)
    );
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it("a non-detector status (TIMEOUT) can never be accepted as a rejection", async () => {
    // Force the poison leg to TIMEOUT. The gate never reached a verdict, so
    // its red-ness is infrastructure noise — the fixture must not be proof
    // merely because something was not green.
    const double = fixtureDouble("drizzle-meta-stray", { timeout_ms: 1 });
    const record = await runFixtureCycle(double, ctx);
    expect(record.verdict).toBe("BROKEN_GATE");
    expect(record.subcode).toBe("NOT_A_DETECTOR_RESULT");
    expect(record.poison.status).toBe("TIMEOUT");
    expect(record.detail).toContain("TIMEOUT");
    expect(reduceResults([proofToResult(record)]).terminal).toBe(
      "VERIFIER_BROKEN"
    );
  }, 600_000);

  it("a tampered or truncated assurance artifact refuses to verify", () => {
    const dir = path.join(SCRATCH, "artifact");
    const artifact = buildAssuranceArtifact({
      candidate: { head_sha: "a", base_sha: "b", merge_tree_sha: "c" },
      contract_sha256: "x",
      registry: { entries: [], contract_sha256: "x" },
      executor_sha256: "y",
      records: [
        {
          fixture_id: "fx",
          expected_gate: "g",
          verdict: "PROVEN",
          applicability: "seed",
        },
      ],
      coverage: null,
      execution_mode: "host",
      hermeticity: "HERMETIC:UNENFORCED",
      cleanup_state: "clean",
    });
    const { artifactPath } = writeAssurance(dir, artifact);
    expect(verifyAssurance(artifactPath).logical.fixtures_proven).toBe(1);

    const original = readFileSync(artifactPath, "utf8");
    // Hand-edit a verdict: the sidecar hash no longer matches.
    writeFileSync(artifactPath, original.replace('"PROVEN"', '"BROKEN"'));
    expect(() => verifyAssurance(artifactPath)).toThrow(/ASSURANCE_TAMPERED/);
    // Truncation is equally fatal.
    writeFileSync(artifactPath, original.slice(0, original.length - 20));
    expect(() => verifyAssurance(artifactPath)).toThrow();
    writeFileSync(artifactPath, original);
    expect(verifyAssurance(artifactPath).logical.fixtures_proven).toBe(1);
  });

  it("the artifact's logical section excludes wall-clock identity", () => {
    const build = () =>
      buildAssuranceArtifact({
        candidate: { head_sha: "a", base_sha: "b", merge_tree_sha: "c" },
        contract_sha256: "x",
        registry: { entries: [], contract_sha256: "x" },
        executor_sha256: "y",
        records: [
          {
            fixture_id: "fx",
            expected_gate: "g",
            verdict: "PROVEN",
            applicability: "seed",
          },
        ],
        coverage: null,
        execution_mode: "host",
        hermeticity: "HERMETIC:UNENFORCED",
        cleanup_state: "clean",
      });
    const a = build();
    const b = build();
    expect(a.logical_sha256).toBe(b.logical_sha256);
    expect(JSON.stringify(a.logical)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(a.observational.generated_at).toBeDefined();
  });

  it("a BROKEN_GATE proof result always reduces to VERIFIER_BROKEN", () => {
    for (const subcode of BROKEN_SUBCODES) {
      const result = proofToResult({
        fixture_id: "fx",
        expected_gate: "g",
        verdict: "BROKEN_GATE",
        subcode,
        detail: "controlled",
      });
      expect(result.status).toBe("BROKEN_GATE");
      expect(result.reason.startsWith(subcode)).toBe(true);
      expect(reduceResults([result]).terminal).toBe("VERIFIER_BROKEN");
    }
  });
});

// ---------------------------------------------------------------------------
// P05.NEG07 — interruption
// ---------------------------------------------------------------------------
describe("P05.NEG07 an interrupted cycle emits no proof and leaks no poison", () => {
  it("SIGINT mid-cycle: non-zero exit, no artifact, candidate discarded, repo untouched", async () => {
    const outDir = path.join(SCRATCH, "interrupt-out");
    const before = readdirSync(path.join(REPO_ROOT, "server")).filter(f =>
      f.startsWith("p05-poison")
    );
    expect(before).toEqual([]);

    const outcome = await new Promise<{ code: number | null; out: string }>(
      (resolve, reject) => {
        const child = spawn(
          NODE,
          [path.join(HERE, "fixtures-driver.mjs"), "typecheck-ts2322", outDir],
          { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] }
        );
        let out = "";
        let killed = false;
        const guard = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`driver never started: ${out}`));
        }, 60_000);
        child.stdout.on("data", chunk => {
          out += chunk.toString();
          if (!killed && out.includes("CYCLE_STARTED")) {
            killed = true;
            // Interrupt while the poisoned candidate is live and the real
            // gate is executing inside it.
            setTimeout(() => child.kill("SIGINT"), 6_000);
          }
        });
        child.stderr.on("data", chunk => {
          out += chunk.toString();
        });
        child.on("exit", code => {
          clearTimeout(guard);
          resolve({ code, out });
        });
      }
    );

    expect(outcome.code).not.toBe(0);
    expect(outcome.out).toContain("CYCLE_STARTED");
    // A partially completed cycle can never become a proof.
    expect(outcome.out).not.toContain('"DONE"');
    expect(existsSync(path.join(outDir, "assurance.json"))).toBe(false);
    // Poison never reached the developer tree.
    const after = readdirSync(path.join(REPO_ROOT, "server")).filter(f =>
      f.startsWith("p05-poison")
    );
    expect(after).toEqual([]);
    expect(
      existsSync(
        path.join(
          REPO_ROOT,
          ".github/workflows/p05-poison-template-injection.yml"
        )
      )
    ).toBe(false);
    expect(
      existsSync(path.join(REPO_ROOT, "drizzle/meta/p05-poison-stray.json"))
    ).toBe(false);

    // DEF-026: the interrupt can preempt in-process teardown, so the
    // candidate directory may survive with its worktree already unregistered.
    // Next-invocation discovery is the recovery boundary, and it must leave
    // ZERO orphans — while never touching a live run.
    const runsRoot = path.join(REPO_ROOT, ".ci-verify", "runs");
    const sweep = sweepStaleRunDirs(runsRoot);
    expect(
      sweep.skipped.every((s: { reason: string }) =>
        s.reason.includes("registered git worktree")
      ),
      JSON.stringify(sweep.skipped)
    ).toBe(true);
    const orphans = existsSync(runsRoot)
      ? readdirSync(runsRoot).filter(
          name =>
            existsSync(path.join(runsRoot, name, "worktree")) &&
            !registeredWorktrees().has(path.join(runsRoot, name, "worktree"))
        )
      : [];
    expect(orphans).toEqual([]);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// P05.AUD01 / P05.AUD02
// ---------------------------------------------------------------------------
describe("P05 audits", () => {
  it("AUD01: zero live poison in the tree; all fixture poison inert", () => {
    const audit = auditPoisonContainment();
    expect(audit.violations).toEqual([]);
    expect(audit.ok).toBe(true);
    const inert = audit.classified.filter(
      (c: { classification: string }) => c.classification === "INERT_FIXTURE"
    );
    // Every fixture's patch AND expectation file accounted for as inert.
    expect(inert.length).toBeGreaterThanOrEqual(
      discoverFixtures(SEED_FIXTURES_ROOT).length
    );
    for (const root of APPROVED_FIXTURE_ROOTS) {
      expect(SENSITIVE_ROOTS).not.toContain(root);
    }
  }, 120_000);

  it("AUD01 can still FAIL: a live poison file under a scanned root is caught", () => {
    const root = path.join(SCRATCH, "aud01-neg");
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    const rel = ".github/workflows/p05-poison-live.yml";
    writeFileSync(
      path.join(root, rel),
      "run: echo ${{ github.event.issue.title }}\n"
    );
    const scan = scanTreeForLivePoison([rel], { repoRoot: root });
    expect(scan.ok).toBe(false);
    expect(scan.findings[0].classification).toBe("LIVE_POISON_VIOLATION");
  });

  it("AUD02: P05 duplicates no P01-P04 mechanism and imports all of them", () => {
    const audit = auditArchitecturalIsolation();
    expect(audit.findings).toEqual([]);
    expect(audit.ok).toBe(true);
    for (const integration of audit.integrations) {
      expect(integration.present, integration.integration).toBe(true);
    }
  });

  it("the graduated declaration ships empty and is machine-readable", () => {
    expect(loadGraduated()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DEF-028 — append-only evidence supersession is deliberately expensive
// ---------------------------------------------------------------------------
describe("DEF-028 evidence supersession refuses casual use", () => {
  const LEDGER = path.join(REPO_ROOT, "scripts/ci/ledger.mjs");

  function run(args: string[]) {
    try {
      execFileSync(NODE, [LEDGER, ...args], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, stderr: "" };
    } catch (error) {
      const err = error as { stderr?: string; message: string };
      return { ok: false, stderr: String(err.stderr ?? err.message) };
    }
  }

  it("requires a reason, a defect, and replacement evidence", () => {
    // Each refusal happens BEFORE any write, so the real ledger is untouched.
    expect(run(["supersede-evidence", "P05.EV01"]).stderr).toMatch(
      /SUPERSESSION_REASON_REQUIRED/
    );
    expect(
      run(["supersede-evidence", "P05.EV01", "--reason", "r"]).stderr
    ).toMatch(/SUPERSESSION_DEFECT_REQUIRED/);
    expect(
      run([
        "supersede-evidence",
        "P05.EV01",
        "--reason",
        "r",
        "--defect",
        "DEF-028",
      ]).stderr
    ).toMatch(/SUPERSESSION_EVIDENCE_REQUIRED/);
  });

  it("refuses an unknown unit", () => {
    expect(
      run([
        "supersede-evidence",
        "P05.NOT-A-UNIT",
        "--reason",
        "r",
        "--defect",
        "DEF-028",
        "--evidence",
        "docs/verification/evidence/p05/assurance.json",
      ]).stderr
    ).toMatch(/UNKNOWN_UNIT_ID/);
  });

  it("every supersession on record retains the superseded hashes", () => {
    const ledger = JSON.parse(
      readFileSync(
        path.join(REPO_ROOT, "docs/verification/ci-verify-ledger.json"),
        "utf8"
      )
    );
    const superseded = Object.values(ledger.units).filter(
      (u: any) => (u.superseded_evidence ?? []).length > 0
    );
    expect(superseded.length).toBeGreaterThan(0);
    for (const unit of superseded as any[]) {
      for (const record of unit.superseded_evidence) {
        expect(record.reason?.length).toBeGreaterThan(0);
        expect(record.defect).toMatch(/^DEF-\d+$/);
        expect(record.previous.length).toBeGreaterThan(0);
        for (const prior of record.previous) {
          expect(prior.sha256).toMatch(/^[0-9a-f]{64}$/);
        }
      }
      // Status is terminal and untouched by supersession.
      expect(unit.status).toBe("PASS");
    }
  });
});
