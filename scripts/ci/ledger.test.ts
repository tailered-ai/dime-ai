/**
 * PB validation suite — P-BOOT positive and negative validation.
 *
 *   PB.TEST01  every declared blueprint ID is seeded exactly once
 *   PB.TEST02  the rendered markdown conforms exactly to the JSON
 *   PB.NEG01   a duplicate blueprint ID FAILS initialization
 *   PB.NEG02   a declared ID missing from the seed FAILS initialization
 *
 * These import and EXECUTE the real modules — they are not text assertions
 * over source, which would register as zero coverage and prove nothing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs module without type declarations
import {
  PHASES,
  allUnits,
  assertBlueprintUnique,
  assertSeedComplete,
  blueprintIds,
  unitKind,
} from "./blueprint.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import {
  LEDGER_PATH,
  MD_PATH,
  SHA_PATH,
  UNIT_STATUSES,
  acceptPhase,
  authorizedHashes,
  buildLedger,
  canonicalJson,
  collectEvidence,
  parseArgs,
  progress,
  renderMarkdown,
  resolvedGenesis,
  setStatus,
  sha256Hex,
} from "./ledger.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const GENESIS_FIXTURE = {
  record_id: "GEN-000",
  schema_version: "1.0.0",
  blueprint_version: "1.0.0",
  ledger_impl_sha256: "0".repeat(64),
  blueprint_sha256: "1".repeat(64),
  git_head_at_bootstrap: "deadbeef",
  created_at: "2026-01-01T00:00:00.000Z",
};

/** Deep clone so mutation in one test cannot leak into another. */
function clonePhases() {
  return JSON.parse(JSON.stringify(PHASES));
}

describe("PB.TEST01 — blueprint IDs are seeded exactly once", () => {
  it("seeds one ledger unit per declared blueprint ID", () => {
    const ledger = buildLedger(PHASES, GENESIS_FIXTURE);
    const declared = blueprintIds(PHASES);
    const seeded = Object.keys(ledger.units);

    expect(declared.length).toBeGreaterThan(0);
    expect(seeded.length).toBe(declared.length);
    expect(new Set(seeded).size).toBe(declared.length);
    expect([...seeded].sort()).toEqual([...declared].sort());
  });

  it("declares no duplicate ID anywhere in the blueprint", () => {
    expect(assertBlueprintUnique(PHASES)).toBe(true);
    const ids = blueprintIds(PHASES);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("seeds every unit at NOT_STARTED with zero attempts and no evidence", () => {
    const ledger = buildLedger(PHASES, GENESIS_FIXTURE);
    for (const unit of Object.values(ledger.units) as Array<{
      status: string;
      attempts: number;
      evidence: unknown[];
    }>) {
      expect(unit.status).toBe("NOT_STARTED");
      expect(unit.attempts).toBe(0);
      expect(unit.evidence).toEqual([]);
    }
  });

  it("derives a known kind for every declared ID", () => {
    for (const id of blueprintIds(PHASES)) {
      expect(() => unitKind(id)).not.toThrow();
    }
  });

  it("covers every phase from P-BOOT through P10", () => {
    const phaseIds = PHASES.map((phase: { id: string }) => phase.id);
    expect(phaseIds).toEqual([
      "PB",
      "P00",
      "P01",
      "P02",
      "P03",
      "P04",
      "P05",
      "P06",
      "P07",
      "P08",
      "P09",
      "P10",
    ]);
    for (const phaseId of phaseIds) {
      const units = allUnits(PHASES).filter(
        (unit: { phase: string }) => unit.phase === phaseId
      );
      expect(units.length).toBeGreaterThan(0);
    }
  });
});

describe("PB.TEST02 — rendered markdown conforms exactly to the JSON", () => {
  it("regenerates the on-disk markdown byte-for-byte from the on-disk JSON", () => {
    const ledger = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
    const onDisk = readFileSync(MD_PATH, "utf8");
    expect(renderMarkdown(ledger)).toBe(onDisk);
  });

  it("pins the on-disk JSON with a matching sha256", () => {
    const bytes = readFileSync(LEDGER_PATH);
    const pinned = readFileSync(SHA_PATH, "utf8").trim().split(/\s+/)[0];
    expect(sha256Hex(bytes)).toBe(pinned);
  });

  it("renders as a pure function of state — no clock, no environment", () => {
    const ledger = buildLedger(PHASES, GENESIS_FIXTURE);
    expect(renderMarkdown(ledger)).toBe(renderMarkdown(ledger));
  });

  it("serializes canonically and stably", () => {
    const ledger = buildLedger(PHASES, GENESIS_FIXTURE);
    const first = canonicalJson(ledger);
    const second = canonicalJson(JSON.parse(first));
    expect(second).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
  });
});

describe("PB.NEG01 — a duplicate blueprint ID FAILS initialization", () => {
  it("throws DUPLICATE_UNIT_ID and names the offending id", () => {
    const phases = clonePhases();
    const victim = phases[0].units[0];
    phases[0].units.push({ ...victim, title: "injected duplicate" });

    expect(() => assertBlueprintUnique(phases)).toThrowError(
      /DUPLICATE_UNIT_ID/
    );
    expect(() => assertBlueprintUnique(phases)).toThrowError(
      new RegExp(victim.id.replace(".", "\\."))
    );
  });

  it("refuses to build a ledger at all when a duplicate exists", () => {
    const phases = clonePhases();
    phases[1].units.push({ ...phases[1].units[0] });
    expect(() => buildLedger(phases, GENESIS_FIXTURE)).toThrowError(
      /DUPLICATE_UNIT_ID/
    );
  });

  it("detects a duplicated PHASE id, not only duplicated units", () => {
    const phases = clonePhases();
    phases.push({ ...phases[0] });
    expect(() => assertBlueprintUnique(phases)).toThrowError(
      /DUPLICATE_UNIT_ID/
    );
  });
});

describe("PB.NEG02 — a declared ID missing from the seed FAILS initialization", () => {
  it("throws SEED_INCOMPLETE naming the missing id", () => {
    const ledger = buildLedger(PHASES, GENESIS_FIXTURE);
    const missing = blueprintIds(PHASES)[3];
    delete ledger.units[missing];

    expect(() => assertSeedComplete(PHASES, ledger)).toThrowError(
      /SEED_INCOMPLETE/
    );
    expect(() => assertSeedComplete(PHASES, ledger)).toThrowError(
      new RegExp(missing.replace(".", "\\."))
    );
  });

  it("throws SEED_INCOMPLETE when the ledger carries an undeclared extra id", () => {
    const ledger = buildLedger(PHASES, GENESIS_FIXTURE);
    ledger.units["P99.T01"] = { id: "P99.T01" };
    expect(() => assertSeedComplete(PHASES, ledger)).toThrowError(
      /SEED_INCOMPLETE.*P99\.T01/s
    );
  });

  it("accepts a complete seed", () => {
    const ledger = buildLedger(PHASES, GENESIS_FIXTURE);
    expect(assertSeedComplete(PHASES, ledger)).toBe(true);
  });
});

describe("PB.T01 exit requirement — PASS is refused without verifiable evidence", () => {
  it("refuses PASS when no evidence is declared", () => {
    const ledger = buildLedger(PHASES, GENESIS_FIXTURE);
    setStatus(ledger, "PB.T01", "IN_PROGRESS");
    expect(() => setStatus(ledger, "PB.T01", "PASS")).toThrowError(
      /EVIDENCE_REQUIRED/
    );
    expect(ledger.units["PB.T01"].status).toBe("IN_PROGRESS");
  });

  it("refuses PASS when a declared evidence path does not exist", () => {
    const ledger = buildLedger(PHASES, GENESIS_FIXTURE);
    setStatus(ledger, "PB.T02", "IN_PROGRESS");
    expect(() =>
      setStatus(ledger, "PB.T02", "PASS", {
        evidence: ["docs/verification/does-not-exist.md"],
      })
    ).toThrowError(/EVIDENCE_MISSING/);
  });

  it("refuses a jump from NOT_STARTED straight to PASS", () => {
    const ledger = buildLedger(PHASES, GENESIS_FIXTURE);
    expect(() =>
      setStatus(ledger, "PB.T03", "PASS", {
        evidence: ["scripts/ci/ledger.mjs"],
      })
    ).toThrowError(/ILLEGAL_TRANSITION/);
  });

  it("refuses evidence pointing at a live control-plane artifact (DEF-001)", () => {
    const ledger = buildLedger(PHASES, GENESIS_FIXTURE);
    for (const live of [LEDGER_PATH, SHA_PATH, MD_PATH]) {
      expect(() => collectEvidence([live])).toThrowError(
        /EVIDENCE_SELF_REFERENCE/
      );
    }
  });

  it("accepts PASS with real, non-empty, hashable evidence", () => {
    const ledger = buildLedger(PHASES, GENESIS_FIXTURE);
    setStatus(ledger, "PB.T04", "IN_PROGRESS");
    setStatus(ledger, "PB.T04", "PASS", {
      evidence: ["scripts/ci/blueprint.mjs"],
      root: path.resolve(HERE, "..", ".."),
    });
    const unit = ledger.units["PB.T04"];
    expect(unit.status).toBe("PASS");
    expect(unit.evidence).toHaveLength(1);
    expect(unit.evidence[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(unit.evidence[0].bytes).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// DEF-004 remediation — the FULL frozen ACCEPT(P) predicate.
// A synthetic single-phase blueprint keeps each acceptance term isolatable, so
// every term can be proven independently load-bearing rather than merely
// co-satisfied.
// ---------------------------------------------------------------------------

const REPO = path.resolve(HERE, "..", "..");
const REAL_EVIDENCE = "scripts/ci/blueprint.mjs";

const SYNTH_PHASES = [
  {
    id: "PX",
    title: "synthetic acceptance fixture",
    assurance_property: "isolates one acceptance term at a time",
    depends_on: [],
    entry: [],
    exit: [],
    units: [
      { id: "PX.T01", class: "MANDATORY", title: "task" },
      { id: "PX.GATE01", class: "MANDATORY", title: "gate" },
      { id: "PX.AUTH01", class: "MANDATORY", title: "authorization" },
      { id: "PX.CP01", class: "MANDATORY", title: "checkpoint" },
      { id: "PX.AUD01", class: "ADVISORY", title: "advisory audit" },
    ],
  },
];

/** A phase satisfying every term of ACCEPT(P). Each test breaks exactly one. */
function acceptedFixture() {
  const ledger = buildLedger(SYNTH_PHASES, GENESIS_FIXTURE);
  for (const id of ["PX.T01", "PX.GATE01", "PX.AUTH01", "PX.CP01"]) {
    setStatus(ledger, id, "IN_PROGRESS");
    setStatus(ledger, id, "PASS", { evidence: [REAL_EVIDENCE], root: REPO });
  }
  ledger.decisions = [
    {
      id: "DEC-PX",
      title: "synthetic",
      required_by: "PX.AUTH01",
      allowed_values: ["YES"],
      status: "RECORDED",
      value: "YES",
      evidence: [],
    },
  ];
  ledger.defects = [];
  return ledger;
}

describe("PB.TEST03 — full ACCEPT(P) predicate", () => {
  it("returns true only for the complete conjunction, with all seven terms true", () => {
    const result = acceptPhase(acceptedFixture(), "PX", { root: REPO });
    expect(result.accepted).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.terms).toEqual({
      all_mandatory_closed: true,
      all_gates_pass: true,
      all_checkpoints_recorded: true,
      all_authorizations_granted: true,
      zero_blocking_open_defects: true,
      evidence_complete: true,
      zero_flaky_mandatory: true,
    });
  });

  it("keeps unit status, gate result taxonomy, and phase state as distinct vocabularies", () => {
    const ledger = acceptedFixture();
    // FLAKY is not a unit status — it is its own axis.
    expect(UNIT_STATUSES).not.toContain("FLAKY");
    expect(ledger.units["PX.T01"].flaky).toBe(false);
    // Phase state is independent of the predicate; acceptPhase never reads it.
    expect(ledger.phases[0].state).toBe("NOT_STARTED");
    expect(acceptPhase(ledger, "PX", { root: REPO }).accepted).toBe(true);
  });

  it("ignores ADVISORY units entirely", () => {
    const ledger = acceptedFixture();
    expect(ledger.units["PX.AUD01"].status).toBe("NOT_STARTED");
    expect(acceptPhase(ledger, "PX", { root: REPO }).accepted).toBe(true);
  });

  it("does not block on an OPEN defect below MEDIUM, nor on a CLOSED one", () => {
    const low = acceptedFixture();
    low.defects = [
      { id: "DEF-LOW", severity: "LOW", status: "OPEN", detected_by: "PX.T01" },
    ];
    expect(acceptPhase(low, "PX", { root: REPO }).accepted).toBe(true);

    const closed = acceptedFixture();
    closed.defects = [
      {
        id: "DEF-C",
        severity: "HIGH",
        status: "CLOSED",
        detected_by: "PX.T01",
      },
    ];
    expect(acceptPhase(closed, "PX", { root: REPO }).accepted).toBe(true);
  });

  it("progress() reports only unit closure and no longer claims acceptance (DEF-004)", () => {
    const ledger = acceptedFixture();
    const stats = progress(ledger, "PX");
    expect(stats).not.toHaveProperty("acceptance_met");
    expect(stats.units_closed_complete).toBe(true);
    // The whole defect: unit closure alone must not imply acceptance.
    ledger.defects = [
      {
        id: "DEF-X",
        severity: "HIGH",
        status: "OPEN",
        detected_by: "PX.CP01",
      },
    ];
    expect(progress(ledger, "PX").units_closed_complete).toBe(true);
    expect(acceptPhase(ledger, "PX", { root: REPO }).accepted).toBe(false);
  });
});

describe("PB.NEG03 — each acceptance term is independently load-bearing", () => {
  const cases: Array<{
    term: string;
    reason: RegExp;
    break: (l: any) => void;
  }> = [
    {
      term: "all_mandatory_closed",
      reason: /UNITS_NOT_CLOSED/,
      break: l => {
        l.units["PX.T01"].status = "IN_PROGRESS";
      },
    },
    {
      term: "all_gates_pass",
      reason: /GATE_NOT_PASS/,
      break: l => {
        l.units["PX.GATE01"].status = "SKIPPED_DECLARED";
      },
    },
    {
      term: "all_checkpoints_recorded",
      reason: /CHECKPOINT_NOT_RECORDED/,
      break: l => {
        l.units["PX.CP01"].status = "SKIPPED_DECLARED";
      },
    },
    {
      term: "all_authorizations_granted",
      reason: /AUTH_NOT_GRANTED/,
      break: l => {
        l.decisions[0].status = "PENDING";
        l.decisions[0].value = null;
      },
    },
    {
      term: "zero_blocking_open_defects",
      reason: /OPEN_DEFECTS/,
      break: l => {
        l.defects = [
          {
            id: "DEF-M",
            severity: "MEDIUM",
            status: "OPEN",
            detected_by: "PX.T01",
          },
        ];
      },
    },
    {
      term: "evidence_complete",
      reason: /EVIDENCE_INCOMPLETE/,
      break: l => {
        l.units["PX.T01"].evidence[0].sha256 = "0".repeat(64);
      },
    },
    {
      term: "zero_flaky_mandatory",
      reason: /FLAKY_MANDATORY/,
      break: l => {
        l.units["PX.T01"].flaky = true;
      },
    },
  ];

  for (const testCase of cases) {
    it(`false when ONLY ${testCase.term} is violated`, () => {
      const ledger = acceptedFixture();
      testCase.break(ledger);
      const result = acceptPhase(ledger, "PX", { root: REPO });

      expect(result.accepted).toBe(false);
      expect(result.terms[testCase.term]).toBe(false);
      expect(result.reasons.join(" ")).toMatch(testCase.reason);

      // Isolation: every OTHER term must still hold, proving this term alone
      // carried the verdict.
      for (const [name, value] of Object.entries(result.terms)) {
        if (name !== testCase.term) expect([name, value]).toEqual([name, true]);
      }
    });
  }

  it("attributes a defect to BOTH the detecting and the affected phase", () => {
    const ledger = acceptedFixture();
    ledger.defects = [
      {
        id: "DEF-ELSEWHERE",
        severity: "HIGH",
        status: "OPEN",
        detected_by: "P00.T02",
        affected_gate: "PX.GATE01",
      },
    ];
    // Affected here, detected elsewhere -> still blocks PX.
    expect(acceptPhase(ledger, "PX", { root: REPO }).accepted).toBe(false);
  });

  it("DEF-005 parser regression: a boolean flag never swallows the next token", () => {
    const parsed = parseArgs(["init", "--force", "--head", "abc123"]);
    expect(parsed.flags.force).toBe(true);
    expect(parsed.flags.head).toBe("abc123");
    expect(parsed.positional).toEqual(["init"]);
  });

  it("DEF-005 genesis regression: corrections apply append-only and GEN-000 is preserved", () => {
    const ledger = buildLedger(SYNTH_PHASES, {
      ...GENESIS_FIXTURE,
      git_head_at_bootstrap: "unknown",
    });
    ledger.amendments = [
      {
        id: "AMD-001",
        reason: "r",
        defect: "DEF-005",
        superseded_ledger_impl_sha256: "a".repeat(64),
        new_ledger_impl_sha256: "b".repeat(64),
        new_blueprint_sha256: "c".repeat(64),
        genesis_corrections: [
          {
            field: "git_head_at_bootstrap",
            from: "unknown",
            to: "d".repeat(40),
          },
        ],
      },
    ];
    // GEN-000 itself is untouched; only the RESOLVED view carries the fix.
    expect(ledger.genesis.git_head_at_bootstrap).toBe("unknown");
    expect(resolvedGenesis(ledger).git_head_at_bootstrap).toBe("d".repeat(40));
    expect(authorizedHashes(ledger)).toMatchObject({
      ledger_impl_sha256: "b".repeat(64),
      source: "AMD-001",
    });
  });
});
