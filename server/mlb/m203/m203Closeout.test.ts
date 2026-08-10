/**
 * M-203 closeout infrastructure test matrix.
 *
 * Covers the guarantees the closeout plan requires before any historical
 * production write: deterministic manifests, exact pre-image capture, apply-time
 * guards, rollback completeness, independent oracle agreement, exhaustive
 * candidate accounting, and the invariant that M-203 moves only two markets.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRIER_MARKETS,
  M203_AFFECTED_FIELDS,
  M203_INVARIANT_FIELDS,
  brierEquals,
  defectiveBrierForEvidence,
  isBrierInDomain,
  oracleBrier,
  readProbability,
} from "./brierOracle";
import {
  CLASSIFICATIONS,
  buildRollbackManifest,
  classifyCandidate,
  crossCheckWithOracle,
  diffBrier,
  findInvariantViolations,
  reconcileAccounting,
  rollbackIsComplete,
  sealManifest,
  stableStringify,
  verifyManifestSeal,
  type BrierMap,
  type CandidateInputs,
  type ComputedOutcomes,
  type ManifestRow,
  type RepairManifest,
} from "./repairManifest";
import {
  applyRepairManifest,
  type BrierMap as GwBrierMap,
  type RepairRowGateway,
} from "./applyManifest";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NULL_BRIER: BrierMap = {
  brierFgTotal: null,
  brierF5Total: null,
  brierNrfi: null,
  brierFgMl: null,
  brierF5Ml: null,
};

function inputs(over: Partial<CandidateInputs> = {}): CandidateInputs {
  return {
    modelOverRate: "60.00",
    modelF5OverRate: "0.5432",
    modelPNrfi: "0.5234",
    modelHomeWinPct: "52.00",
    modelF5HomeWinPct: "51.00",
    bookTotal: "8.5",
    f5Total: "4.5",
    ...over,
  };
}

function outcomes(over: Partial<ComputedOutcomes> = {}): ComputedOutcomes {
  return {
    actualFgTotal: 9,
    actualF5Total: 4,
    actualNrfiBinary: 1,
    outcomeFgOver: 1,
    outcomeF5Over: 0,
    outcomeNrfi: 1,
    outcomeHomeWin: 0,
    outcomeF5HomeWin: 0,
    ...over,
  };
}

/** Proposed values computed by the oracle, so fixtures are self-consistent. */
function proposedFrom(i: CandidateInputs, o: ComputedOutcomes): BrierMap {
  const pick = (f: string) => {
    switch (f) {
      case "brierFgTotal":
        return o.outcomeFgOver;
      case "brierF5Total":
        return o.outcomeF5Over;
      case "brierNrfi":
        return o.outcomeNrfi;
      case "brierFgMl":
        return o.outcomeHomeWin;
      default:
        return o.outcomeF5HomeWin;
    }
  };
  const out = { ...NULL_BRIER };
  for (const m of BRIER_MARKETS) {
    const r = readProbability(
      i[m.probColumn as keyof CandidateInputs],
      m.scale
    );
    out[m.field] = oracleBrier(r.value, pick(m.field));
  }
  return out;
}

/**
 * The REAL historical pre-image of an M-203-affected row: the three
 * percent-scaled markets were always scored correctly, while the two
 * unit-scaled markets carry what the defective ÷100 scorer produced.
 * Modelling this faithfully is what makes the invariant guard meaningful.
 */
function defectivePreImage(i: CandidateInputs, o: ComputedOutcomes): BrierMap {
  return {
    ...proposedFrom(i, o),
    brierNrfi: defectiveBrierForEvidence(i.modelPNrfi, o.outcomeNrfi),
    brierF5Total: defectiveBrierForEvidence(i.modelF5OverRate, o.outcomeF5Over),
  };
}

const PROPOSED = proposedFrom(inputs(), outcomes());
const PREVIOUS = defectivePreImage(inputs(), outcomes());

function row(over: Partial<ManifestRow> = {}): ManifestRow {
  const i = over.inputs ?? inputs();
  const o = over.computedOutcomes ?? outcomes();
  const proposed = over.proposedBrier ?? proposedFrom(i, o);
  const previous = over.previousBrier ?? defectivePreImage(i, o);
  return {
    gameRowId: 1,
    mlbGamePk: 700001,
    gameDate: "2026-05-01",
    matchup: "CLE@CWS",
    matchMethod: "mlbGamePk",
    outcomeIngestedAt: 1_700_000_000_000,
    sourcePayloadHash: "abc123",
    previousBrier: previous,
    previousActualFgTotal: "9.0",
    inputs: i,
    computedOutcomes: o,
    proposedBrier: proposed,
    changeFields: diffBrier(previous, proposed),
    classification: "CORRECTION_REQUIRED",
    reason: null,
    ...over,
  };
}

function manifest(rows: ManifestRow[]): RepairManifest {
  return {
    repairRunId: "m203-test-run",
    generatedAt: 1_700_000_000_000,
    codeSha: "deadbeef",
    schemaVersion: "0134_widen_unit_probability_precision",
    defectWindowStart: "2026-04-15",
    defectWindowEnd: "2026-08-07",
    dates: Array.from(new Set(rows.map(r => r.gameDate))).sort(),
    rows,
  };
}

/** In-memory gateway mirroring the production write contract. */
function gateway(
  store: Map<number, BrierMap>,
  opts: { dropField?: string } = {}
) {
  const calls: { id: number; values: BrierMap }[] = [];
  const gw: RepairRowGateway = {
    readForUpdate: async id => (store.has(id) ? { ...store.get(id)! } : null),
    writeBrier: async (id, values) => {
      calls.push({ id, values: { ...values } });
      const cur = store.get(id);
      if (!cur) return;
      const next = { ...cur };
      for (const m of BRIER_MARKETS) {
        if (opts.dropField === m.field) continue; // simulate a lost write
        next[m.field] = values[m.field];
      }
      store.set(id, next);
    },
    readBack: async id => (store.has(id) ? { ...store.get(id)! } : null),
  };
  const runInTransaction = async <T>(
    work: (g: RepairRowGateway) => Promise<T>
  ) => {
    const snapshot = new Map(
      [...store.entries()].map(([k, v]) => [k, { ...v }])
    );
    try {
      return await work(gw);
    } catch (e) {
      store.clear();
      for (const [k, v] of snapshot) store.set(k, v);
      throw e;
    }
  };
  return { gw, calls, runInTransaction };
}

const BASE = {
  actualCodeSha: "deadbeef",
  actualSchemaVersion: "0134_widen_unit_probability_precision",
  log: () => {},
};

// ─── Oracle ───────────────────────────────────────────────────────────────────

describe("independent oracle", () => {
  it("does NOT import the production scorer — common-mode failure guard", () => {
    const src = readFileSync(join(__dirname, "brierOracle.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["'].*mlbOutcomeIngestor/);
    expect(src).not.toMatch(/require\(.*mlbOutcomeIngestor/);
  });

  it("computes (p-o)^2 at storage resolution", () => {
    expect(oracleBrier(0.5234, 1)).toBeCloseTo(0.227148, 6);
    expect(oracleBrier(0.5432, 0)).toBeCloseTo(0.295066, 6);
    expect(oracleBrier(null, 1)).toBeNull();
    expect(oracleBrier(0.5, null)).toBeNull();
  });

  it("enforces the scale contract that M-203 got wrong", () => {
    expect(readProbability("66", "percent").value).toBeCloseTo(0.66, 8);
    expect(readProbability("0.66", "unit").value).toBeCloseTo(0.66, 8);
    // The defect: a unit value read as percent.
    expect(readProbability("66", "unit").rejection).toBe("OUT_OF_DOMAIN");
    expect(readProbability("0.66", "percent").value).toBeCloseTo(0.0066, 8);
  });

  it("refuses out-of-domain input instead of clamping it", () => {
    expect(readProbability("101", "percent").rejection).toBe("OUT_OF_DOMAIN");
    expect(readProbability("-0.1", "unit").rejection).toBe("OUT_OF_DOMAIN");
    expect(readProbability("abc", "unit").rejection).toBe("NOT_NUMERIC");
    expect(readProbability(null, "unit").rejection).toBe("ABSENT");
  });

  it("reproduces the historical defect for evidence only", () => {
    // A genuine 0.66 unit probability was scored as if it were 0.0066.
    expect(defectiveBrierForEvidence("0.66", 1)).toBeCloseTo(0.986844, 6);
    expect(oracleBrier(0.66, 1)).toBeCloseTo(0.1156, 6);
  });

  it("keeps every Brier score inside [0,1]", () => {
    expect(isBrierInDomain(0)).toBe(true);
    expect(isBrierInDomain(1)).toBe(true);
    expect(isBrierInDomain(null)).toBe(true);
    expect(isBrierInDomain(1.0001)).toBe(false);
    expect(isBrierInDomain(-0.0001)).toBe(false);
  });

  it("names exactly two affected and three invariant markets", () => {
    expect([...M203_AFFECTED_FIELDS].sort()).toEqual([
      "brierF5Total",
      "brierNrfi",
    ]);
    expect([...M203_INVARIANT_FIELDS].sort()).toEqual([
      "brierF5Ml",
      "brierFgMl",
      "brierFgTotal",
    ]);
  });
});

// ─── Manifest determinism ─────────────────────────────────────────────────────

describe("manifest determinism and sealing", () => {
  it("serializes identically regardless of key insertion order", () => {
    const a = stableStringify({ b: 1, a: { d: 2, c: 3 } });
    const b = stableStringify({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  it("produces an identical checksum for identical content", () => {
    expect(sealManifest(manifest([row()])).manifestSha256).toBe(
      sealManifest(manifest([row()])).manifestSha256
    );
  });

  it("changes the checksum when ANY row value changes", () => {
    const base = sealManifest(manifest([row()])).manifestSha256;
    const tampered = sealManifest(
      manifest([
        row({
          proposedBrier: {
            ...proposedFrom(inputs(), outcomes()),
            brierNrfi: 0.5,
          },
        }),
      ])
    ).manifestSha256;
    expect(tampered).not.toBe(base);
  });

  it("detects post-seal tampering", () => {
    const sealed = sealManifest(manifest([row()]));
    expect(verifyManifestSeal(sealed)).toBe(true);
    sealed.manifest.rows[0].proposedBrier.brierNrfi = 0.123456;
    expect(verifyManifestSeal(sealed)).toBe(false);
  });

  it("records the exact pre-image and proposed image", () => {
    const r = row();
    expect(r.previousBrier.brierNrfi).toBeCloseTo(0.989559, 6);
    expect(r.proposedBrier.brierNrfi).toBeCloseTo(0.227148, 6);
    expect(r.changeFields).toContain("brierNrfi");
  });
});

// ─── Classification + accounting ──────────────────────────────────────────────

describe("candidate classification", () => {
  const base = {
    previousBrier: NULL_BRIER,
    proposedBrier: NULL_BRIER,
    inputs: inputs(),
    matchMethod: "mlbGamePk" as const,
    sourceError: null,
    ambiguous: false,
    doubleheader: false,
  };

  it("flags a real correction", () => {
    const proposed = proposedFrom(inputs(), outcomes());
    const r = classifyCandidate({
      ...base,
      previousBrier: defectivePreImage(inputs(), outcomes()),
      proposedBrier: proposed,
    });
    expect(r.classification).toBe("CORRECTION_REQUIRED");
    expect(r.changeFields).toContain("brierNrfi");
  });

  it("flags an already-correct row", () => {
    const proposed = proposedFrom(inputs(), outcomes());
    const r = classifyCandidate({
      ...base,
      previousBrier: proposed,
      proposedBrier: proposed,
    });
    expect(r.classification).toBe("ALREADY_CORRECT");
    expect(r.changeFields).toEqual([]);
  });

  it("flags an out-of-domain probability rather than repairing it", () => {
    const r = classifyCandidate({
      ...base,
      inputs: inputs({ modelPNrfi: "66" }),
    });
    expect(r.classification).toBe("INVALID_PROBABILITY");
    expect(r.reason).toMatch(/modelPNrfi/);
  });

  it("distinguishes a missing match from a doubleheader", () => {
    expect(
      classifyCandidate({ ...base, matchMethod: "none" }).classification
    ).toBe("MISSING_MLB_MATCH");
    expect(
      classifyCandidate({ ...base, matchMethod: "none", doubleheader: true })
        .classification
    ).toBe("DOUBLEHEADER_REVIEW");
  });

  it("flags ambiguity and source errors before value comparison", () => {
    expect(classifyCandidate({ ...base, ambiguous: true }).classification).toBe(
      "AMBIGUOUS_MATCH"
    );
    expect(
      classifyCandidate({ ...base, sourceError: "HTTP 500" }).classification
    ).toBe("SOURCE_ERROR");
  });

  it("flags a valid null result and a missing required input", () => {
    expect(classifyCandidate({ ...base }).classification).toBe(
      "VALID_NULL_RESULT"
    );
    expect(
      classifyCandidate({ ...base, inputs: inputs({ modelPNrfi: null }) })
        .classification
    ).toBe("MISSING_REQUIRED_INPUT");
  });

  it("refuses to write an impossible Brier value", () => {
    const r = classifyCandidate({
      ...base,
      proposedBrier: { ...NULL_BRIER, brierNrfi: 1.5 },
    });
    expect(r.classification).toBe("INVESTIGATION_REQUIRED");
  });

  it("balances the accounting identity — every row classified exactly once", () => {
    const rows = [
      row({ gameRowId: 1, classification: "CORRECTION_REQUIRED" }),
      row({ gameRowId: 2, classification: "ALREADY_CORRECT" }),
      row({ gameRowId: 3, classification: "MISSING_MLB_MATCH" }),
      row({ gameRowId: 4, classification: "VALID_NULL_RESULT" }),
    ];
    const acc = reconcileAccounting(rows);
    expect(acc.total).toBe(4);
    expect(acc.balanced).toBe(true);
    expect(acc.writable).toBe(1);
    expect(acc.closureBlocking).toBe(0);
    const summed = CLASSIFICATIONS.reduce((s, c) => s + acc.counts[c], 0);
    expect(summed).toBe(acc.total);
  });

  it("counts closure-blocking classifications", () => {
    const acc = reconcileAccounting([
      row({ gameRowId: 1, classification: "SOURCE_ERROR" }),
      row({ gameRowId: 2, classification: "INVESTIGATION_REQUIRED" }),
    ]);
    expect(acc.closureBlocking).toBe(2);
  });
});

// ─── Invariant + oracle cross-check ───────────────────────────────────────────

describe("invariant and oracle guards", () => {
  it("detects a percent-scaled market being moved", () => {
    const p = proposedFrom(inputs(), outcomes());
    const v = findInvariantViolations([
      row({ previousBrier: { ...p, brierFgMl: 0.1 }, proposedBrier: p }),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("brierFgMl");
  });

  it("passes when only the two affected markets move", () => {
    const p = proposedFrom(inputs(), outcomes());
    expect(
      findInvariantViolations([
        row({
          previousBrier: defectivePreImage(inputs(), outcomes()),
          proposedBrier: p,
        }),
      ])
    ).toEqual([]);
  });

  it("detects a manifest value the oracle disagrees with", () => {
    const p = proposedFrom(inputs(), outcomes());
    const d = crossCheckWithOracle([
      row({ proposedBrier: { ...p, brierNrfi: 0.123456 } }),
    ]);
    expect(d).toHaveLength(1);
    expect(d[0].field).toBe("brierNrfi");
  });

  it("agrees with a correctly built manifest", () => {
    expect(crossCheckWithOracle([row()])).toEqual([]);
  });
});

// ─── Rollback ─────────────────────────────────────────────────────────────────

describe("rollback manifest", () => {
  it("covers every writable row and restores the exact pre-image", () => {
    const sealed = sealManifest(manifest([row()]));
    const rb = buildRollbackManifest(sealed, 1_700_000_001_000);
    expect(rollbackIsComplete(sealed, rb)).toBe(true);
    expect(rb.rows[0].restoreTo.brierNrfi).toBeCloseTo(0.989559, 6);
    expect(rb.rows[0].expectedCurrent.brierNrfi).toBeCloseTo(0.227148, 6);
  });

  it("excludes non-writable rows", () => {
    const sealed = sealManifest(
      manifest([
        row({ gameRowId: 1 }),
        row({ gameRowId: 2, classification: "ALREADY_CORRECT" }),
      ])
    );
    const rb = buildRollbackManifest(sealed, 1);
    expect(rb.rows.map(r => r.gameRowId)).toEqual([1]);
    expect(rollbackIsComplete(sealed, rb)).toBe(true);
  });

  it("rejects a rollback built from a different manifest", () => {
    const sealed = sealManifest(manifest([row()]));
    const other = buildRollbackManifest(
      sealManifest(manifest([row({ gameRowId: 9 })])),
      1
    );
    expect(rollbackIsComplete(sealed, other)).toBe(false);
  });

  it("round-trips: repair then rollback restores the original state", async () => {
    const store = new Map<number, BrierMap>([[1, { ...PREVIOUS }]]);
    const original = { ...store.get(1)! };
    const sealed = sealManifest(manifest([row()]));
    const rb = buildRollbackManifest(sealed, 1);
    const { runInTransaction } = gateway(store);

    await applyRepairManifest({
      ...BASE,
      sealed,
      rollback: rb,
      runInTransaction,
    });
    expect(store.get(1)!.brierNrfi).toBeCloseTo(0.227148, 6);

    // Apply the rollback by its own contract: assert current, restore previous.
    const target = rb.rows[0];
    expect(
      brierEquals(store.get(1)!.brierNrfi, target.expectedCurrent.brierNrfi)
    ).toBe(true);
    store.set(1, { ...target.restoreTo });
    expect(store.get(1)).toEqual(original);
  });
});

// ─── Apply guards ─────────────────────────────────────────────────────────────

describe("applyRepairManifest guards", () => {
  function setup(overrides: Partial<ManifestRow> = {}) {
    const store = new Map<number, BrierMap>([[1, { ...PREVIOUS }]]);
    const sealed = sealManifest(manifest([row(overrides)]));
    const rollback = buildRollbackManifest(sealed, 1);
    const g = gateway(store);
    return { store, sealed, rollback, ...g };
  }

  it("applies the exact manifest values and verifies them", async () => {
    const { sealed, rollback, runInTransaction, store, calls } = setup();
    const res = await applyRepairManifest({
      ...BASE,
      sealed,
      rollback,
      runInTransaction,
    });
    expect(res.aborted).toBeNull();
    expect(res.applied).toBe(1);
    expect(res.rows[0].outcome).toBe("APPLIED");
    expect(store.get(1)!.brierNrfi).toBeCloseTo(0.227148, 6);
    // No recomputation: written values are byte-equal to the manifest.
    expect(calls[0].values).toEqual(sealed.manifest.rows[0].proposedBrier);
  });

  it("aborts on a tampered manifest", async () => {
    const { sealed, rollback, runInTransaction, calls } = setup();
    sealed.manifest.rows[0].proposedBrier.brierNrfi = 0.5;
    const res = await applyRepairManifest({
      ...BASE,
      sealed,
      rollback,
      runInTransaction,
    });
    expect(res.aborted).toBe("MANIFEST_SEAL_MISMATCH");
    expect(calls).toHaveLength(0);
  });

  it("aborts on a code SHA mismatch", async () => {
    const { sealed, rollback, runInTransaction, calls } = setup();
    const res = await applyRepairManifest({
      ...BASE,
      sealed,
      rollback,
      runInTransaction,
      actualCodeSha: "different",
    });
    expect(res.aborted).toBe("CODE_SHA_MISMATCH");
    expect(calls).toHaveLength(0);
  });

  it("aborts on a schema version mismatch", async () => {
    const { sealed, rollback, runInTransaction, calls } = setup();
    const res = await applyRepairManifest({
      ...BASE,
      sealed,
      rollback,
      runInTransaction,
      actualSchemaVersion: "0133_account_lockout",
    });
    expect(res.aborted).toBe("SCHEMA_VERSION_MISMATCH");
    expect(calls).toHaveLength(0);
  });

  it("aborts when the rollback artifact is incomplete", async () => {
    const { sealed, runInTransaction, calls } = setup();
    const empty = {
      repairRunId: "x",
      generatedAt: 1,
      sourceManifestSha256: "nope",
      rows: [],
    };
    const res = await applyRepairManifest({
      ...BASE,
      sealed,
      rollback: empty,
      runInTransaction,
    });
    expect(res.aborted).toBe("ROLLBACK_INCOMPLETE");
    expect(calls).toHaveLength(0);
  });

  it("aborts when an invariant market would move", async () => {
    const p = proposedFrom(inputs(), outcomes());
    const { sealed, rollback, runInTransaction, calls } = setup({
      previousBrier: { ...p, brierFgMl: 0.4 },
      proposedBrier: p,
    });
    const res = await applyRepairManifest({
      ...BASE,
      sealed,
      rollback,
      runInTransaction,
    });
    expect(res.aborted).toBe("INVARIANT_VIOLATION");
    expect(calls).toHaveLength(0);
  });

  it("aborts when the independent oracle disagrees", async () => {
    const p = proposedFrom(inputs(), outcomes());
    const { sealed, rollback, runInTransaction, calls } = setup({
      proposedBrier: { ...p, brierNrfi: 0.111111 },
    });
    const res = await applyRepairManifest({
      ...BASE,
      sealed,
      rollback,
      runInTransaction,
    });
    expect(res.aborted).toBe("ORACLE_DISAGREEMENT");
    expect(calls).toHaveLength(0);
  });

  it("refuses a row that changed since review (PREIMAGE_MISMATCH)", async () => {
    const { sealed, rollback, runInTransaction, store } = setup();
    store.set(1, { ...PREVIOUS, brierNrfi: 0.42 }); // drifted after review
    const res = await applyRepairManifest({
      ...BASE,
      sealed,
      rollback,
      runInTransaction,
    });
    expect(res.rows.some(r => r.outcome === "PREIMAGE_MISMATCH")).toBe(true);
    expect(res.applied).toBe(0);
    expect(store.get(1)!.brierNrfi).toBe(0.42); // untouched
  });

  it("fails and rolls the date back when a write does not persist", async () => {
    const store = new Map<number, BrierMap>([[1, { ...PREVIOUS }]]);
    const sealed = sealManifest(manifest([row()]));
    const rollback = buildRollbackManifest(sealed, 1);
    const { runInTransaction } = gateway(store, { dropField: "brierNrfi" });
    const res = await applyRepairManifest({
      ...BASE,
      sealed,
      rollback,
      runInTransaction,
    });
    expect(res.rows.some(r => r.outcome === "VERIFY_FAILED")).toBe(true);
    expect(res.applied).toBe(0);
    expect(store.get(1)!.brierNrfi).toBeCloseTo(0.989559, 6); // transaction reverted
  });

  it("skips non-writable rows without touching them", async () => {
    const { sealed, rollback, runInTransaction, calls } = setup({
      classification: "ALREADY_CORRECT",
    });
    const res = await applyRepairManifest({
      ...BASE,
      sealed,
      rollback,
      runInTransaction,
    });
    expect(res.applied).toBe(0);
    expect(res.skipped).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("performs zero writes when the manifest has no writable rows", async () => {
    const { sealed, rollback, runInTransaction, calls } = setup({
      classification: "MISSING_MLB_MATCH",
    });
    await applyRepairManifest({ ...BASE, sealed, rollback, runInTransaction });
    expect(calls).toHaveLength(0);
  });
});

// ─── Idempotency ──────────────────────────────────────────────────────────────

describe("idempotency", () => {
  it("a second identical manifest proposes no change", async () => {
    const store = new Map<number, BrierMap>([[1, { ...PREVIOUS }]]);
    const sealed = sealManifest(manifest([row()]));
    const rollback = buildRollbackManifest(sealed, 1);
    const { runInTransaction } = gateway(store);
    await applyRepairManifest({ ...BASE, sealed, rollback, runInTransaction });

    // Rebuild against the NEW state — this is what a second dry run would see.
    const after = store.get(1)!;
    const second = row({ previousBrier: after });
    expect(second.changeFields).toEqual([]);
    expect(
      classifyCandidate({
        previousBrier: after,
        proposedBrier: second.proposedBrier,
        inputs: second.inputs,
        matchMethod: "mlbGamePk",
        sourceError: null,
        ambiguous: false,
        doubleheader: false,
      }).classification
    ).toBe("ALREADY_CORRECT");
  });
});
