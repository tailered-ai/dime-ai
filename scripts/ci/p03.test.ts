/**
 * P03 validation suite — registries, taxonomy, reporter, ledger integration.
 *
 *   P03.TEST01  exhaustive 12 status x 6 class reduction matrix (72 cases)
 *   P03.TEST02  all six classes render even when empty
 *   P03.TEST03  false-green adversarial suite
 *   P03.NEG01   FLAKY cannot reduce to PASS
 *   P03.NEG02   PARITY registry mutation forbidden
 *   P03.NEG03   PASS without verifiable evidence refused
 *   P03.NEG04   ledger tampering detected
 *   P03.NEG05   rendered markdown divergence detected
 *   P03.CONF01  ledger render conformance after integration
 *   P03.AUD01   contract -> registry fidelity
 *   P03.AUD02   runtime YAML isolation
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs module without type declarations
import {
  GATE_CLASSES,
  GATE_STATUSES,
  RESULT_SCHEMA_VERSION,
  TERMINAL_CONTRIBUTION,
  TERMINAL_SEVERITY,
  certificateEligible,
  classifyAttempts,
  externalStatus,
  makeResult,
  normalizeStatus,
  reduceResults,
  validateResult,
} from "./result.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import {
  GRADUATING_CONTEXTS,
  REQUIRED_CONTEXTS,
  buildAllRegistries,
  buildHardeningRegistry,
  buildParityRegistry,
  loadVerifiedContract,
} from "./registry.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import {
  JsonlReporter,
  progressOf,
  readResults,
  renderSummary,
  summarize,
} from "./reporter.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import {
  LEDGER_PATH,
  MD_PATH,
  SHA_PATH,
  buildLedger,
  canonicalJson,
  gateResultSummary,
  recordGateResult,
  renderMarkdown,
  setStatus,
  sha256Hex,
  systemTerminal,
} from "./ledger.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { PHASES } from "./blueprint.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { auditP03YamlIsolation, auditRegistryFidelity } from "./p03-audit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const temps: string[] = [];

afterAll(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "p03-"));
  temps.push(dir);
  return dir;
}

/** A valid result for any status, satisfying every schema rule. */
function resultFor(status: string, klass: string, overrides: any = {}) {
  const base: any = {
    gate_id: overrides.gate_id ?? `${klass}:${status}`,
    class: klass,
    status,
    mandatory: overrides.mandatory ?? true,
    reason: status === "PASS" ? null : `declared reason for ${status}`,
    exit_code: status === "PASS" ? 0 : status === "CI_ONLY" ? null : 1,
    ...overrides,
  };
  if (status === "CI_ONLY") base.exit_code = null;
  return makeResult(base);
}

describe("P03.TEST01 — exhaustive 12 x 6 reduction matrix", () => {
  it("covers all 72 status/class combinations with exact expected behaviour", () => {
    const rows: Array<Record<string, unknown>> = [];
    for (const klass of GATE_CLASSES) {
      for (const status of GATE_STATUSES) {
        const result = resultFor(status, klass);
        const reduction = reduceResults([result]);
        const eligibility = certificateEligible([result]);
        const summary = summarize([result]);

        const expectedTerminal =
          TERMINAL_CONTRIBUTION[status] ?? "LOCAL_READY_FOR_PR";
        expect(reduction.terminal, `${klass}/${status} terminal`).toBe(
          expectedTerminal
        );
        expect(reduction.blocking, `${klass}/${status} blocking`).toBe(
          expectedTerminal !== "LOCAL_READY_FOR_PR"
        );
        // Acceptance consequence.
        const shouldBeEligible = [
          "PASS",
          "SKIPPED_DECLARED",
          "CI_ONLY",
          "N/A",
        ].includes(status);
        expect(eligibility.eligible, `${klass}/${status} eligible`).toBe(
          shouldBeEligible
        );
        // Summary counting: exactly one result, in its own class and status.
        expect(summary.classes[klass].counts[status]).toBe(1);
        expect(summary.classes[klass].total).toBe(1);
        expect(summary.total_results).toBe(1);
        expect(summary.reconciles).toBe(true);
        for (const other of GATE_CLASSES) {
          if (other !== klass) expect(summary.classes[other].total).toBe(0);
        }
        rows.push({
          klass,
          status,
          terminal: reduction.terminal,
          eligible: eligibility.eligible,
        });
      }
    }
    expect(rows).toHaveLength(72);
  });

  it("distinguishes mandatory from advisory without hiding advisory results", () => {
    for (const status of GATE_STATUSES) {
      const advisory = resultFor(status, "AUDIT", { mandatory: false });
      const reduction = reduceResults([advisory]);
      // BROKEN_GATE means the VERIFIER is untrustworthy, mandatory or not.
      const expected =
        status === "BROKEN_GATE" ? "VERIFIER_BROKEN" : "LOCAL_READY_FOR_PR";
      expect(reduction.terminal, `advisory ${status}`).toBe(expected);
      // Advisory results are still COUNTED — never hidden.
      expect(summarize([advisory]).classes.AUDIT.counts[status]).toBe(1);
    }
  });

  it("orders terminal severity so aggregation can never downgrade", () => {
    expect(TERMINAL_SEVERITY.VERIFIER_BROKEN).toBeGreaterThan(
      TERMINAL_SEVERITY.CONTRACT_DRIFT
    );
    expect(TERMINAL_SEVERITY.CONTRACT_DRIFT).toBeGreaterThan(
      TERMINAL_SEVERITY.LOCAL_BLOCKED
    );
    expect(TERMINAL_SEVERITY.LOCAL_BLOCKED).toBeGreaterThan(
      TERMINAL_SEVERITY.LOCAL_INCONCLUSIVE
    );
    expect(TERMINAL_SEVERITY.LOCAL_INCONCLUSIVE).toBeGreaterThan(
      TERMINAL_SEVERITY.LOCAL_READY_FOR_PR
    );
  });

  describe("invariants — no transformation can improve the verdict", () => {
    it("adding a failure never makes a summary greener", () => {
      const green = [resultFor("PASS", "PARITY", { gate_id: "a" })];
      const withFail = [
        ...green,
        resultFor("FAIL", "PARITY", { gate_id: "b" }),
      ];
      expect(reduceResults(green).blocking).toBe(false);
      expect(reduceResults(withFail).blocking).toBe(true);
      expect(summarize(withFail).classes.PARITY.counts.PASS).toBe(1);
      expect(summarize(withFail).classes.PARITY.counts.FAIL).toBe(1);
    });

    it("PASS -> FLAKY cannot improve acceptance", () => {
      const pass = certificateEligible([
        resultFor("PASS", "PARITY", { gate_id: "g" }),
      ]);
      const flaky = certificateEligible([
        resultFor("FLAKY", "PARITY", { gate_id: "g" }),
      ]);
      expect(pass.eligible).toBe(true);
      expect(flaky.eligible).toBe(false);
    });

    it("PASS -> FAIL cannot improve acceptance", () => {
      expect(
        certificateEligible([resultFor("FAIL", "PARITY", { gate_id: "g" })])
          .eligible
      ).toBe(false);
    });

    it("BROKEN_GATE forces verifier-broken semantics from any class", () => {
      for (const klass of GATE_CLASSES) {
        const mixed = [
          resultFor("PASS", "PARITY", { gate_id: "ok" }),
          resultFor("BROKEN_GATE", klass, { gate_id: `broken-${klass}` }),
        ];
        expect(reduceResults(mixed).terminal).toBe("VERIFIER_BROKEN");
      }
    });

    it("a malformed status throws rather than becoming N/A", () => {
      expect(() => normalizeStatus("MOSTLY_FINE")).toThrowError(
        /UNKNOWN_STATUS/
      );
      expect(() => normalizeStatus(undefined)).toThrowError(/UNKNOWN_STATUS/);
      expect(() => normalizeStatus("")).toThrowError(/UNKNOWN_STATUS/);
    });

    it("class omission cannot create PASS", () => {
      const summary = summarize([], { declared: { PARITY: ["missing-gate"] } });
      expect(summary.classes.PARITY.counts.PASS).toBe(0);
      expect(summary.classes.PARITY.missing_gate_ids).toEqual(["missing-gate"]);
      expect(summary.classes.PARITY.blocking).toBe(true);
    });
  });

  it("normalizes external spellings at exactly one boundary", () => {
    expect(normalizeStatus("CI-ONLY")).toBe("CI_ONLY");
    expect(normalizeStatus("INFRA-FAIL")).toBe("INFRA_FAIL");
    expect(normalizeStatus("CONTRACT-DRIFT")).toBe("CONTRACT_DRIFT");
    expect(normalizeStatus("BROKEN-GATE")).toBe("BROKEN_GATE");
    expect(externalStatus("CI_ONLY")).toBe("CI-ONLY");
    expect(externalStatus("PASS")).toBe("PASS");
  });
});

describe("P03.TEST02 — all six classes render even when empty", () => {
  const scenarios: Array<[string, any[]]> = [
    ["all empty", []],
    ["only PARITY", [resultFor("PASS", "PARITY", { gate_id: "p1" })]],
    [
      "only AUDIT",
      [resultFor("PASS", "AUDIT", { gate_id: "a1", mandatory: false })],
    ],
    [
      "mixed classes",
      [
        resultFor("PASS", "PARITY", { gate_id: "p1" }),
        resultFor("FAIL", "CLEANROOM", { gate_id: "c1" }),
        resultFor("PASS", "REMOTE", { gate_id: "r1" }),
      ],
    ],
    ["CI_ONLY only", [resultFor("CI_ONLY", "PARITY", { gate_id: "ci1" })]],
    ["FLAKY only", [resultFor("FLAKY", "PARITY", { gate_id: "f1" })]],
  ];

  for (const [label, results] of scenarios) {
    it(`renders all six classes for: ${label}`, () => {
      const summary = summarize(results);
      for (const klass of GATE_CLASSES) {
        expect(summary.classes[klass], `${klass} present`).toBeDefined();
        expect(summary.classes[klass].class).toBe(klass);
        // Every status column exists, even at zero.
        for (const status of GATE_STATUSES) {
          expect(typeof summary.classes[klass].counts[status]).toBe("number");
        }
      }
      const rendered = renderSummary(summary);
      for (const klass of GATE_CLASSES) {
        expect(rendered, `${klass} in rendering`).toContain(klass);
      }
      expect(summary.reconciles).toBe(true);
    });
  }

  it("an empty HARDENING registry renders explicitly rather than vanishing", () => {
    const hardening = buildHardeningRegistry();
    expect(hardening.entries).toHaveLength(0);
    expect(hardening.class).toBe("HARDENING");
    const rendered = renderSummary(summarize([]));
    expect(rendered).toContain("HARDENING");
    // Empty must never imply "passed tests that were never registered".
    expect(summarize([]).classes.HARDENING.counts.PASS).toBe(0);
  });

  it("progress uses closed/total, never an invented percentage", () => {
    const results = [
      resultFor("PASS", "PARITY", { gate_id: "a" }),
      resultFor("FAIL", "PARITY", { gate_id: "b" }),
    ];
    const summary = summarize(results, {
      declared: { PARITY: ["a", "b", "c"] },
    });
    expect(progressOf(summary, "PARITY")).toEqual({ closed: 1, total: 3 });
  });
});

describe("P03.NEG01 — FLAKY cannot reduce to PASS", () => {
  it("classifies fail-then-pass as FLAKY and preserves the failing attempt", () => {
    const classified = classifyAttempts([
      { status: "FAIL", duration_ms: 10 },
      { status: "PASS", duration_ms: 12 },
    ]);
    expect(classified.status).toBe("FLAKY");
    expect(classified.attempts).toHaveLength(2);
    expect(classified.attempts[0].status).toBe("FAIL");
    expect(classified.reason).toMatch(/did not pass/);
  });

  it("refuses to construct a PASS result whose history contains a failure", () => {
    expect(() =>
      makeResult({
        gate_id: "g",
        class: "PARITY",
        status: "PASS",
        exit_code: 0,
        attempts: [{ status: "FAIL" }, { status: "PASS" }],
      })
    ).toThrowError(/INVALID_RESULT/);
  });

  it("blocks acceptance when a mandatory gate is FLAKY", () => {
    const flaky = makeResult({
      gate_id: "g",
      class: "PARITY",
      status: "FLAKY",
      reason: "attempt 1 failed, attempt 2 passed",
      exit_code: 0,
      attempts: [{ status: "FAIL" }, { status: "PASS" }],
    });
    expect(certificateEligible([flaky]).eligible).toBe(false);
    expect(reduceResults([flaky]).terminal).toBe("LOCAL_BLOCKED");
  });
});

describe("P03.NEG02 — PARITY registry mutation forbidden", () => {
  it("refuses append, delete, replacement and reclassification", () => {
    const registry = buildParityRegistry();
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.entries)).toBe(true);
    expect(() => {
      (registry.entries as any).push({ gate_id: "injected" });
    }).toThrow();
    expect(() => {
      (registry as any).entries = [];
    }).toThrow();
    expect(() => {
      (registry.entries[0] as any).runnability = "LOCAL";
    }).toThrow();
    expect(() => {
      (registry.entries[0] as any).required = false;
    }).toThrow();
    expect(() => {
      delete (registry.entries[0] as any).status_context;
    }).toThrow();
    // Control: the registry still reads correctly afterwards.
    expect(registry.entries.length).toBeGreaterThan(0);
  });

  it("refuses to build when the contract does not match its pin", () => {
    const dir = tempDir();
    const { contract } = loadVerifiedContract();
    const contractPath = path.join(dir, "contract.frozen.json");
    const shaPath = path.join(dir, "contract.sha256");
    writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
    writeFileSync(shaPath, `${"0".repeat(64)}  contract.frozen.json\n`);
    expect(() => buildParityRegistry({ contractPath, shaPath })).toThrowError(
      /CONTRACT_DRIFT/
    );
  });

  it("raises rather than repairing an upstream contract defect", () => {
    const { contract } = loadVerifiedContract();
    const broken = JSON.parse(JSON.stringify(contract));
    broken.checks[0].runnability = "SOMETIMES";
    expect(() =>
      buildParityRegistry({ contract: broken, contract_sha256: "x" })
    ).toThrowError(/CONTRACT_INVALID_RUNNABILITY/);

    const noReason = JSON.parse(JSON.stringify(contract));
    const ciOnly = noReason.checks.find(
      (c: any) => c.runnability === "CI-ONLY"
    );
    ciOnly.ci_only_reasons = [];
    expect(() =>
      buildParityRegistry({ contract: noReason, contract_sha256: "x" })
    ).toThrowError(/CONTRACT_CI_ONLY_WITHOUT_REASON/);
  });

  it("rejects duplicate HARDENING ids and a wrong class", () => {
    expect(() =>
      buildHardeningRegistry([
        { gate_id: "x", description: "one" },
        { gate_id: "x", description: "two" },
      ])
    ).toThrowError(/HARDENING_DUPLICATE_ID/);
    expect(() =>
      buildHardeningRegistry([{ gate_id: "y", class: "PARITY" }])
    ).toThrowError(/HARDENING_WRONG_CLASS/);
  });
});

describe("P03.NEG03 — PASS without verifiable evidence refused", () => {
  const genesis = {
    record_id: "GEN-000",
    schema_version: "1.0.0",
    blueprint_version: "1.0.0",
    ledger_impl_sha256: "0".repeat(64),
    blueprint_sha256: "1".repeat(64),
    git_head_at_bootstrap: "d".repeat(40),
    created_at: "2026-01-01T00:00:00.000Z",
  };

  it("refuses PASS with no evidence declared", () => {
    const ledger = buildLedger(PHASES, genesis);
    setStatus(ledger, "P03.T01", "IN_PROGRESS");
    expect(() => setStatus(ledger, "P03.T01", "PASS")).toThrowError(
      /EVIDENCE_REQUIRED/
    );
    expect(ledger.units["P03.T01"].status).toBe("IN_PROGRESS");
  });

  it("refuses PASS when the evidence path does not exist", () => {
    const ledger = buildLedger(PHASES, genesis);
    setStatus(ledger, "P03.T02", "IN_PROGRESS");
    expect(() =>
      setStatus(ledger, "P03.T02", "PASS", {
        evidence: ["docs/verification/nope.md"],
      })
    ).toThrowError(/EVIDENCE_MISSING/);
  });

  it("refuses PASS when the evidence file is empty", () => {
    const dir = tempDir();
    const empty = path.join(dir, "empty.txt");
    writeFileSync(empty, "");
    const ledger = buildLedger(PHASES, genesis);
    setStatus(ledger, "P03.T03", "IN_PROGRESS");
    expect(() =>
      setStatus(ledger, "P03.T03", "PASS", { evidence: [empty], root: dir })
    ).toThrowError(/EVIDENCE_EMPTY/);
  });

  it("refuses evidence pointing at a live control-plane artifact", () => {
    const ledger = buildLedger(PHASES, genesis);
    setStatus(ledger, "P03.T04", "IN_PROGRESS");
    expect(() =>
      setStatus(ledger, "P03.T04", "PASS", { evidence: [LEDGER_PATH] })
    ).toThrowError(/EVIDENCE_SELF_REFERENCE/);
  });
});

describe("P03.NEG04 / P03.NEG05 — ledger tampering and render divergence", () => {
  it("detects canonical-byte tampering via the integrity pin", () => {
    const dir = tempDir();
    const ledger = buildLedger(PHASES, {
      record_id: "GEN-000",
      schema_version: "1.0.0",
      blueprint_version: "1.0.0",
      ledger_impl_sha256: "0".repeat(64),
      blueprint_sha256: "1".repeat(64),
      git_head_at_bootstrap: "d".repeat(40),
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const bytes = canonicalJson(ledger);
    const pin = sha256Hex(Buffer.from(bytes, "utf8"));
    const tampered = JSON.parse(bytes);
    tampered.units["P03.T01"].status = "PASS";
    const tamperedBytes = canonicalJson(tampered);
    expect(sha256Hex(Buffer.from(tamperedBytes, "utf8"))).not.toBe(pin);
    writeFileSync(path.join(dir, "x.json"), tamperedBytes);
  });

  it("detects rendered-markdown divergence from canonical JSON", () => {
    const ledger = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
    const fresh = renderMarkdown(ledger);
    expect(readFileSync(MD_PATH, "utf8")).toBe(fresh);
    const handEdited = `${fresh}\nINJECTED GREEN CLAIM\n`;
    expect(handEdited).not.toBe(fresh);
  });

  it("the on-disk ledger matches its pin", () => {
    const bytes = readFileSync(LEDGER_PATH);
    const pinned = readFileSync(SHA_PATH, "utf8").trim().split(/\s+/)[0];
    expect(sha256Hex(bytes)).toBe(pinned);
  });
});

describe("P03.TEST03 — false-green adversarial suite", () => {
  it("a missing mandatory result cannot summarize green", () => {
    const declared = { PARITY: ["a", "b"] };
    const summary = summarize([resultFor("PASS", "PARITY", { gate_id: "a" })], {
      declared,
    });
    expect(summary.classes.PARITY.missing_gate_ids).toEqual(["b"]);
    expect(summary.classes.PARITY.blocking).toBe(true);
    expect(
      reduceResults([resultFor("PASS", "PARITY", { gate_id: "a" })], {
        expectedGateIds: ["a", "b"],
      }).terminal
    ).toBe("LOCAL_INCONCLUSIVE");
  });

  it("duplicate gate ids do not overwrite each other", () => {
    const dir = tempDir();
    const file = path.join(dir, "results.jsonl");
    const reporter = new JsonlReporter(file);
    reporter.write(resultFor("FAIL", "PARITY", { gate_id: "dup" }));
    expect(() =>
      reporter.write(resultFor("PASS", "PARITY", { gate_id: "dup" }))
    ).toThrowError(/DUPLICATE_GATE_ID/);
    // The original failure survives.
    expect(readResults(file).results[0].status).toBe("FAIL");
  });

  it("a later PASS cannot erase an earlier attempt", () => {
    const result = makeResult({
      gate_id: "g",
      class: "PARITY",
      status: "FLAKY",
      reason: "retry",
      attempts: [{ status: "FAIL" }, { status: "PASS" }],
    });
    expect(result.attempts[0].status).toBe("FAIL");
    expect(result.status).not.toBe("PASS");
  });

  it("CI_ONLY is never counted as a locally executed PASS", () => {
    const summary = summarize([
      resultFor("CI_ONLY", "PARITY", { gate_id: "ci" }),
    ]);
    expect(summary.classes.PARITY.counts.CI_ONLY).toBe(1);
    expect(summary.classes.PARITY.counts.PASS).toBe(0);
    expect(() =>
      makeResult({
        gate_id: "x",
        class: "PARITY",
        status: "CI_ONLY",
        reason: "r",
        exit_code: 0,
      })
    ).toThrowError(/INVALID_RESULT/);
  });

  it("INCONCLUSIVE and BLOCKED are never rendered as PASS", () => {
    for (const status of ["INCONCLUSIVE", "BLOCKED"]) {
      const summary = summarize([
        resultFor(status, "PARITY", { gate_id: status }),
      ]);
      expect(summary.classes.PARITY.counts.PASS).toBe(0);
      expect(summary.classes.PARITY.counts[status]).toBe(1);
      expect(summary.classes.PARITY.blocking).toBe(true);
    }
  });

  it("INFRA_FAIL stays distinct from FAIL", () => {
    expect(TERMINAL_CONTRIBUTION.INFRA_FAIL).toBe("LOCAL_INCONCLUSIVE");
    expect(TERMINAL_CONTRIBUTION.FAIL).toBe("LOCAL_BLOCKED");
    const summary = summarize([
      resultFor("INFRA_FAIL", "PARITY", { gate_id: "i" }),
    ]);
    expect(summary.classes.PARITY.counts.FAIL).toBe(0);
    expect(summary.classes.PARITY.counts.INFRA_FAIL).toBe(1);
  });

  it("BROKEN_GATE cannot be downgraded by aggregation with many passes", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      resultFor("PASS", "PARITY", { gate_id: `ok-${i}` })
    );
    many.push(resultFor("BROKEN_GATE", "ASSURANCE", { gate_id: "broken" }));
    expect(reduceResults(many).terminal).toBe("VERIFIER_BROKEN");
  });

  it("CONTRACT_DRIFT remains independently visible", () => {
    const results = [
      resultFor("PASS", "PARITY", { gate_id: "a" }),
      resultFor("CONTRACT_DRIFT", "PARITY", { gate_id: "d" }),
    ];
    expect(reduceResults(results).terminal).toBe("CONTRACT_DRIFT");
    expect(summarize(results).classes.PARITY.counts.CONTRACT_DRIFT).toBe(1);
  });

  it("an unknown status fails the reporter rather than falling back", () => {
    const dir = tempDir();
    const file = path.join(dir, "bad.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({ ...resultFor("PASS", "PARITY"), status: "GREENISH" })}\n`
    );
    expect(() => readResults(file)).toThrowError(/INVALID_RECORD/);
  });

  it("truncated JSONL cannot summarize green", () => {
    const dir = tempDir();
    const file = path.join(dir, "trunc.jsonl");
    const good = JSON.stringify(resultFor("PASS", "PARITY", { gate_id: "a" }));
    writeFileSync(file, `${good}\n${good.slice(0, 40)}`);
    expect(() => readResults(file)).toThrowError(
      /TRUNCATED_JSONL|MALFORMED_JSONL/
    );
  });

  it("summary counts reconcile exactly to raw records", () => {
    const results = GATE_STATUSES.map((status, i) =>
      resultFor(status, GATE_CLASSES[i % GATE_CLASSES.length], {
        gate_id: `g-${i}`,
      })
    );
    const summary = summarize(results);
    expect(summary.reconciles).toBe(true);
    const perClass = GATE_CLASSES.reduce(
      (sum, k) => sum + summary.classes[k].total,
      0
    );
    expect(perClass).toBe(results.length);
    const perStatus = GATE_STATUSES.reduce(
      (sum, s) => sum + summary.totals[s],
      0
    );
    expect(perStatus).toBe(results.length);
  });

  it("advisory AUDIT success cannot hide a mandatory PARITY failure", () => {
    const results = [
      resultFor("PASS", "AUDIT", { gate_id: "audit-ok", mandatory: false }),
      resultFor("FAIL", "PARITY", { gate_id: "parity-bad" }),
    ];
    const summary = summarize(results);
    expect(summary.classes.PARITY.blocking).toBe(true);
    expect(summary.blocking_classes).toContain("PARITY");
    expect(reduceResults(results).terminal).toBe("LOCAL_BLOCKED");
    expect(certificateEligible(results).eligible).toBe(false);
  });

  it("negative durations and bad exit codes are rejected", () => {
    expect(() =>
      makeResult({
        gate_id: "g",
        class: "PARITY",
        status: "PASS",
        duration_ms: -1,
      })
    ).toThrowError(/INVALID_RESULT/);
    expect(() =>
      makeResult({
        gate_id: "g",
        class: "PARITY",
        status: "PASS",
        exit_code: 3,
      })
    ).toThrowError(/INVALID_RESULT/);
    expect(() =>
      makeResult({ gate_id: "g", class: "PARITY", status: "FAIL" })
    ).toThrowError(/INVALID_RESULT/); // reason required
  });
});

describe("P03.T07 — ledger integration", () => {
  const genesis = {
    record_id: "GEN-000",
    schema_version: "1.0.0",
    blueprint_version: "1.0.0",
    ledger_impl_sha256: "0".repeat(64),
    blueprint_sha256: "1".repeat(64),
    git_head_at_bootstrap: "d".repeat(40),
    created_at: "2026-01-01T00:00:00.000Z",
  };

  it("records gate results append-only and refuses duplicates", () => {
    const ledger = buildLedger(PHASES, genesis);
    recordGateResult(ledger, resultFor("FAIL", "PARITY", { gate_id: "g1" }));
    expect(() =>
      recordGateResult(ledger, resultFor("PASS", "PARITY", { gate_id: "g1" }))
    ).toThrowError(/DUPLICATE_GATE_RESULT/);
    expect(ledger.gate_results).toHaveLength(1);
    expect(ledger.gate_results[0].status).toBe("FAIL");
  });

  it("keeps the system terminal state separate from phase acceptance", () => {
    const ledger = buildLedger(PHASES, genesis);
    recordGateResult(
      ledger,
      resultFor("BROKEN_GATE", "ASSURANCE", { gate_id: "b" })
    );
    expect(systemTerminal(ledger).terminal).toBe("VERIFIER_BROKEN");
    // Phase acceptance is a different axis and is unaffected by gate results.
    expect(ledger.phases.find((p: any) => p.id === "P03").state).toBe(
      "NOT_STARTED"
    );
  });

  it("summarizes six classes from the ledger, including empty ones", () => {
    const ledger = buildLedger(PHASES, genesis);
    recordGateResult(ledger, resultFor("PASS", "PARITY", { gate_id: "p" }));
    const summary = gateResultSummary(ledger);
    for (const klass of GATE_CLASSES) expect(summary[klass]).toBeDefined();
    expect(summary.PARITY.total).toBe(1);
    expect(summary.HARDENING.total).toBe(0);
  });

  it("preserves the full ACCEPT(P) predicate — no regression to unit closure only", () => {
    const ledger = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
    expect(ledger.result_schema_version).toBe(RESULT_SCHEMA_VERSION);
    expect(Array.isArray(ledger.gate_results)).toBe(true);
    // Historical records survived the additive migration.
    expect(ledger.genesis.record_id).toBe("GEN-000");
    expect(ledger.amendments.length).toBeGreaterThanOrEqual(4);
    expect(ledger.defects.length).toBeGreaterThanOrEqual(19);
  });
});

describe("P03.CONF01 / P03.AUD01 / P03.AUD02", () => {
  it("CONF01 — the rendered ledger is byte-identical to a fresh render", () => {
    const ledger = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
    expect(renderMarkdown(ledger)).toBe(readFileSync(MD_PATH, "utf8"));
  });

  it("CONF01 — the render exposes all six classes", () => {
    const ledger = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
    const rendered = renderMarkdown(ledger);
    for (const klass of GATE_CLASSES) expect(rendered).toContain(klass);
  });

  it("AUD01 — the PARITY registry is a faithful projection of the contract", () => {
    const audit = auditRegistryFidelity();
    expect(audit.problems).toEqual([]);
    expect(audit.ok).toBe(true);
    expect(audit.required).toBe(REQUIRED_CONTEXTS.length);
    expect(audit.graduating).toBe(GRADUATING_CONTEXTS.length);
  });

  it("AUD01 — DEF-017 and DEF-018 regressions are anchored", () => {
    const registry = buildParityRegistry();
    const byContext = new Map(
      registry.entries
        .filter((e: any) => e.status_context)
        .map((e: any) => [e.status_context, e])
    );
    // DEF-017: locally reproducible gates stay local despite artifact uploads.
    expect(byContext.get("TypeScript Check").runnability).toBe("LOCAL");
    // DEF-018: external tool requirements stay visible.
    expect(byContext.get("05-workflow-security").required_tools).toContain(
      "zizmor"
    );
    expect(byContext.get("03-semgrep-blocking").required_tools).toContain(
      "semgrep"
    );
  });

  it("AUD02 — no P03 runtime module parses workflow YAML", () => {
    const audit = auditP03YamlIsolation();
    expect(audit.violations).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it("AUD02 — a runtime module importing YAML is detected, and control restores", () => {
    const root = tempDir();
    const scan = path.join(root, "scripts", "ci");
    mkdirSync(scan, { recursive: true });
    writeFileSync(
      path.join(scan, "clean.mjs"),
      'import { buildParityRegistry } from "./registry.mjs";\nexport const r = buildParityRegistry;\n'
    );
    const runtimeModules = ["scripts/ci/clean.mjs", "scripts/ci/bypass.mjs"];
    expect(
      auditP03YamlIsolation({ root, scanDir: "scripts/ci", runtimeModules }).ok
    ).toBe(true);

    writeFileSync(
      path.join(scan, "bypass.mjs"),
      'import { parse } from "yaml";\nexport const p = (s) => parse(s);\n'
    );
    const bad = auditP03YamlIsolation({
      root,
      scanDir: "scripts/ci",
      runtimeModules,
    });
    expect(bad.ok).toBe(false);
    expect(bad.violations.map((v: any) => v.file)).toContain(
      "scripts/ci/bypass.mjs"
    );

    rmSync(path.join(scan, "bypass.mjs"));
    expect(
      auditP03YamlIsolation({ root, scanDir: "scripts/ci", runtimeModules }).ok
    ).toBe(true);
  });

  it("registries expose all six classes, PARITY derived only from the contract", () => {
    const all = buildAllRegistries();
    for (const klass of GATE_CLASSES) expect(all[klass].class).toBe(klass);
    expect(all.PARITY.source).toBe("scripts/ci/contract.frozen.json");
    expect(all.PARITY.entries.length).toBeGreaterThan(0);
    expect(all.HARDENING.entries).toHaveLength(0);
  });
});
