/**
 * M-203 Session 4 hardening suite.
 *
 * Closes the specific verification gaps the closeout plan enumerates:
 *   §7  defect-window boundary contract, stated not inferred
 *   §8  oracle independence proven transitively, not by convention
 *   §10 eight seal-negative cases covering every mutation-relevant field
 *   §11 rollback across all three NULL transition shapes
 *   §13 transaction rollback at every failure position within a date
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isInDefectWindow, type DefectWindow } from "./buildManifest";
import {
  buildRollbackManifest,
  diffBrier,
  sealManifest,
  verifyManifestSeal,
  type BrierMap,
  type ManifestRow,
  type RepairManifest,
} from "./repairManifest";
import { applyRepairManifest, type RepairRowGateway } from "./applyManifest";
import { BRIER_MARKETS } from "./brierOracle";

// ─── §7 Defect-window boundary contract ───────────────────────────────────────

const WINDOW: DefectWindow = {
  // 358dd2670 reached main 2026-04-15 02:15 EDT
  defectStartMs: Date.parse("2026-04-15T06:15:17Z"),
  // 6a2dff850 reached main 2026-08-07 12:28 PDT
  fixDeployedAtMs: Date.parse("2026-08-07T19:28:23Z"),
};

describe("§7 defect-window predicate — explicit boundary contract", () => {
  it("EXCLUDES a row scored before the defect existed", () => {
    expect(isInDefectWindow(WINDOW.defectStartMs - 1, WINDOW)).toBe(false);
  });

  it("INCLUDES a row scored at the exact instant the defect went live", () => {
    expect(isInDefectWindow(WINDOW.defectStartMs, WINDOW)).toBe(true);
  });

  it("INCLUDES a row scored inside the window", () => {
    expect(isInDefectWindow(Date.parse("2026-06-01T00:00:00Z"), WINDOW)).toBe(
      true
    );
  });

  it("INCLUDES a row scored one millisecond before the fix deployed", () => {
    expect(isInDefectWindow(WINDOW.fixDeployedAtMs - 1, WINDOW)).toBe(true);
  });

  it("EXCLUDES a row scored at the exact instant the fix deployed", () => {
    expect(isInDefectWindow(WINDOW.fixDeployedAtMs, WINDOW)).toBe(false);
  });

  it("EXCLUDES a row scored after the fix deployed", () => {
    expect(isInDefectWindow(WINDOW.fixDeployedAtMs + 1, WINDOW)).toBe(false);
  });

  it("FAILS CLOSED on an unknown scoring time", () => {
    expect(isInDefectWindow(null, WINDOW)).toBe(false);
    expect(isInDefectWindow(undefined, WINDOW)).toBe(false);
  });

  it("FAILS CLOSED on an invalid timestamp rather than treating it as in-window", () => {
    expect(isInDefectWindow(Number.NaN, WINDOW)).toBe(false);
    expect(isInDefectWindow(Number.POSITIVE_INFINITY, WINDOW)).toBe(false);
    expect(isInDefectWindow(Number.NEGATIVE_INFINITY, WINDOW)).toBe(false);
  });

  it("still accepts the legacy single-bound form", () => {
    expect(
      isInDefectWindow(WINDOW.fixDeployedAtMs - 1, WINDOW.fixDeployedAtMs)
    ).toBe(true);
    expect(
      isInDefectWindow(WINDOW.fixDeployedAtMs, WINDOW.fixDeployedAtMs)
    ).toBe(false);
  });
});

// ─── §8 Oracle independence, proven transitively ──────────────────────────────

describe("§8 oracle independence — enforced, not conventional", () => {
  /** Collects every relative import target of a module, recursively. */
  function importGraph(entry: string, seen = new Set<string>()): Set<string> {
    if (seen.has(entry)) return seen;
    seen.add(entry);
    let src: string;
    try {
      src = readFileSync(entry, "utf8");
    } catch {
      return seen;
    }
    const re = /(?:from|import)\s+["'](\.[^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const base = join(entry, "..", m[1]);
      for (const cand of [`${base}.ts`, join(base, "index.ts")]) {
        try {
          readFileSync(cand, "utf8");
          importGraph(cand, seen);
          break;
        } catch {
          /* not this candidate */
        }
      }
    }
    return seen;
  }

  it("reaches NO production scoring module through any import path", () => {
    const graph = importGraph(join(__dirname, "brierOracle.ts"));
    const forbidden = [...graph].filter(f =>
      /mlbOutcomeIngestor|mlbModelRunner|mlbDriftDetector/.test(f)
    );
    expect(forbidden).toEqual([]);
  });

  it("imports nothing outside its own directory", () => {
    const graph = [...importGraph(join(__dirname, "brierOracle.ts"))];
    const outside = graph.filter(f => !f.startsWith(__dirname));
    expect(outside).toEqual([]);
  });

  it("has no runtime imports at all — it is pure first-principles arithmetic", () => {
    const src = readFileSync(join(__dirname, "brierOracle.ts"), "utf8");
    const runtimeImports = src
      .split("\n")
      .filter(l => /^import\s/.test(l) && !/^import\s+type\s/.test(l));
    expect(runtimeImports).toEqual([]);
  });
});

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const NULL_BRIER: BrierMap = {
  brierFgTotal: null,
  brierF5Total: null,
  brierNrfi: null,
  brierFgMl: null,
  brierF5Ml: null,
};

function row(over: Partial<ManifestRow> = {}): ManifestRow {
  const previous = over.previousBrier ?? { ...NULL_BRIER, brierNrfi: 0.989559 };
  const proposed = over.proposedBrier ?? { ...NULL_BRIER, brierNrfi: 0.227148 };
  return {
    gameRowId: 1,
    mlbGamePk: 700001,
    gameDate: "2026-05-01",
    matchup: "CLE@CWS",
    matchMethod: "mlbGamePk",
    outcomeIngestedAt: 1_700_000_000_000,
    sourcePayloadHash: "hash-a",
    previousBrier: previous,
    previousActualFgTotal: "9.0",
    inputs: {
      modelOverRate: null,
      modelF5OverRate: null,
      modelPNrfi: "0.5234",
      modelHomeWinPct: null,
      modelF5HomeWinPct: null,
      bookTotal: null,
      f5Total: null,
    },
    computedOutcomes: {
      actualFgTotal: 9,
      actualF5Total: 4,
      actualNrfiBinary: 1,
      outcomeFgOver: null,
      outcomeF5Over: null,
      outcomeNrfi: 1,
      outcomeHomeWin: null,
      outcomeF5HomeWin: null,
    },
    proposedBrier: proposed,
    changeFields: diffBrier(previous, proposed),
    classification: "CORRECTION_REQUIRED",
    reason: null,
    ...over,
  };
}

function manifest(
  rows: ManifestRow[],
  over: Partial<RepairManifest> = {}
): RepairManifest {
  return {
    repairRunId: "m203-hardening",
    generatedAt: 1_700_000_000_000,
    codeSha: "abc1234",
    schemaVersion: "0134_widen_unit_probability_precision",
    defectWindowStart: "2026-04-15",
    defectWindowEnd: "2026-08-07",
    dates: Array.from(new Set(rows.map(r => r.gameDate))).sort(),
    rows,
    ...over,
  };
}

// ─── §10 Eight seal negatives ─────────────────────────────────────────────────

describe("§10 seal covers every mutation-relevant field", () => {
  const baseline = sealManifest(manifest([row()])).manifestSha256;

  it("1. a changed proposed value changes the hash", () => {
    expect(
      sealManifest(
        manifest([row({ proposedBrier: { ...NULL_BRIER, brierNrfi: 0.3 } })])
      ).manifestSha256
    ).not.toBe(baseline);
  });

  it("2. a changed pre-image value changes the hash", () => {
    expect(
      sealManifest(
        manifest([row({ previousBrier: { ...NULL_BRIER, brierNrfi: 0.5 } })])
      ).manifestSha256
    ).not.toBe(baseline);
  });

  it("3. a changed row identity changes the hash", () => {
    expect(
      sealManifest(manifest([row({ gameRowId: 2 })])).manifestSha256
    ).not.toBe(baseline);
    expect(
      sealManifest(manifest([row({ mlbGamePk: 999 })])).manifestSha256
    ).not.toBe(baseline);
  });

  it("4. row ORDER is part of the contract — reordering changes the hash", () => {
    const a = sealManifest(
      manifest([row({ gameRowId: 1 }), row({ gameRowId: 2 })])
    );
    const b = sealManifest(
      manifest([row({ gameRowId: 2 }), row({ gameRowId: 1 })])
    );
    // Documented contract: rows are an ordered array, not a set.
    expect(a.manifestSha256).not.toBe(b.manifestSha256);
  });

  it("5. removing a row changes the hash", () => {
    const two = sealManifest(
      manifest([row({ gameRowId: 1 }), row({ gameRowId: 2 })])
    );
    expect(
      sealManifest(manifest([row({ gameRowId: 1 })])).manifestSha256
    ).not.toBe(two.manifestSha256);
  });

  it("6. adding a row changes the hash", () => {
    expect(
      sealManifest(manifest([row({ gameRowId: 1 }), row({ gameRowId: 2 })]))
        .manifestSha256
    ).not.toBe(baseline);
  });

  it("7. code SHA is inside the seal", () => {
    expect(
      sealManifest(manifest([row()], { codeSha: "different" })).manifestSha256
    ).not.toBe(baseline);
  });

  it("8. schema identity is inside the seal", () => {
    expect(
      sealManifest(manifest([row()], { schemaVersion: "0133_account_lockout" }))
        .manifestSha256
    ).not.toBe(baseline);
  });

  it("classification and source hash are inside the seal", () => {
    expect(
      sealManifest(manifest([row({ classification: "ALREADY_CORRECT" })]))
        .manifestSha256
    ).not.toBe(baseline);
    expect(
      sealManifest(manifest([row({ sourcePayloadHash: "hash-b" })]))
        .manifestSha256
    ).not.toBe(baseline);
  });

  it("is stable under key insertion order", () => {
    const r1 = row();
    const reordered = JSON.parse(
      JSON.stringify({
        ...r1,
        classification: r1.classification,
        gameRowId: r1.gameRowId,
      })
    ) as ManifestRow;
    expect(sealManifest(manifest([reordered])).manifestSha256).toBe(baseline);
  });

  it("verifies clean and detects tampering", () => {
    const sealed = sealManifest(manifest([row()]));
    expect(verifyManifestSeal(sealed)).toBe(true);
    sealed.manifest.codeSha = "tampered";
    expect(verifyManifestSeal(sealed)).toBe(false);
  });
});

// ─── §11 Rollback across all NULL transition shapes ───────────────────────────

describe("§11 rollback restores every transition shape", () => {
  const shapes: Array<{
    name: string;
    prev: number | null;
    next: number | null;
  }> = [
    { name: "NULL -> value -> NULL", prev: null, next: 0.227148 },
    { name: "value -> NULL -> value", prev: 0.989559, next: null },
    { name: "valueA -> valueB -> valueA", prev: 0.989559, next: 0.227148 },
  ];

  for (const s of shapes) {
    it(s.name, async () => {
      const previous = { ...NULL_BRIER, brierNrfi: s.prev };
      const proposed = { ...NULL_BRIER, brierNrfi: s.next };
      const store = new Map<number, BrierMap>([[1, { ...previous }]]);
      const original = JSON.parse(JSON.stringify(store.get(1))) as BrierMap;

      // The proposed value must be justified by the inputs, or the oracle
      // cross-check correctly refuses the manifest. A proposed NULL therefore
      // requires the probability to be genuinely absent.
      const base = row({ previousBrier: previous, proposedBrier: proposed });
      const consistent: ManifestRow =
        s.next === null
          ? { ...base, inputs: { ...base.inputs, modelPNrfi: null } }
          : base;
      const sealed = sealManifest(manifest([consistent]));
      const rb = buildRollbackManifest(sealed, 1);
      const { runInTransaction } = gateway(store);

      const res = await applyRepairManifest({
        sealed,
        rollback: rb,
        actualCodeSha: "abc1234",
        actualSchemaVersion: "0134_widen_unit_probability_precision",
        runInTransaction,
        log: () => {},
      });
      expect(res.aborted).toBeNull();
      expect(res.applied).toBe(1);
      expect(store.get(1)!.brierNrfi).toBe(s.next);

      // Rollback asserts current state, then restores the recorded pre-image.
      const target = rb.rows[0];
      expect(store.get(1)!.brierNrfi).toBe(target.expectedCurrent.brierNrfi);
      store.set(1, { ...target.restoreTo });
      expect(store.get(1)).toEqual(original);
    });
  }

  it("a rollback artifact refuses a row whose current state is unexpected", () => {
    const previous = { ...NULL_BRIER, brierNrfi: 0.989559 };
    const proposed = { ...NULL_BRIER, brierNrfi: 0.227148 };
    const sealed = sealManifest(
      manifest([row({ previousBrier: previous, proposedBrier: proposed })])
    );
    const rb = buildRollbackManifest(sealed, 1);
    const drifted: BrierMap = { ...NULL_BRIER, brierNrfi: 0.4 };
    // The guard a rollback executor must apply before restoring.
    const safe = BRIER_MARKETS.every(
      m => drifted[m.field] === rb.rows[0].expectedCurrent[m.field]
    );
    expect(safe).toBe(false);
  });
});

// ─── §13 Transaction rollback at every failure position ───────────────────────

interface GatewayOpts {
  /** Row index (0-based) at which to fail. */
  failAtIndex?: number;
  /** Which phase of that row fails. */
  failPhase?: "read" | "write" | "verify";
}

function gateway(store: Map<number, BrierMap>, opts: GatewayOpts = {}) {
  let seen = 0;
  const gw: RepairRowGateway = {
    readForUpdate: async id => {
      const idx = seen;
      if (opts.failPhase === "read" && idx === opts.failAtIndex) return null;
      return store.has(id) ? { ...store.get(id)! } : null;
    },
    writeBrier: async (id, values) => {
      const idx = seen;
      if (opts.failPhase === "write" && idx === opts.failAtIndex) {
        throw new Error("simulated write failure");
      }
      const cur = store.get(id);
      if (cur) store.set(id, { ...cur, ...values });
    },
    readBack: async id => {
      const idx = seen;
      seen++;
      if (opts.failPhase === "verify" && idx === opts.failAtIndex) {
        // Return the pre-write state to simulate a write that did not persist.
        return { ...NULL_BRIER, brierNrfi: 0.989559 };
      }
      return store.has(id) ? { ...store.get(id)! } : null;
    },
  };
  const runInTransaction = async <T>(
    work: (g: RepairRowGateway) => Promise<T>
  ) => {
    const snapshot = new Map(
      Array.from(store.entries()).map(
        ([k, v]) => [k, { ...v }] as [number, BrierMap]
      )
    );
    try {
      return await work(gw);
    } catch (e) {
      store.clear();
      for (const [k, v] of snapshot) store.set(k, v);
      throw e;
    }
  };
  return { gw, runInTransaction };
}

describe("§13 one-date transaction reverts on failure at any position", () => {
  const PREV: BrierMap = { ...NULL_BRIER, brierNrfi: 0.989559 };
  const NEXT: BrierMap = { ...NULL_BRIER, brierNrfi: 0.227148 };

  function threeRowDate() {
    return [1, 2, 3].map(id =>
      row({
        gameRowId: id,
        previousBrier: { ...PREV },
        proposedBrier: { ...NEXT },
      })
    );
  }

  const positions: Array<{
    name: string;
    idx: number;
    phase: GatewayOpts["failPhase"];
  }> = [
    { name: "before the first row (read)", idx: 0, phase: "read" },
    { name: "on the first row (write)", idx: 0, phase: "write" },
    { name: "in the middle of the date (write)", idx: 1, phase: "write" },
    { name: "on the final row (write)", idx: 2, phase: "write" },
    { name: "during verification of the middle row", idx: 1, phase: "verify" },
  ];

  for (const p of positions) {
    it(`reverts the entire date when failure occurs ${p.name}`, async () => {
      const store = new Map<number, BrierMap>([
        [1, { ...PREV }],
        [2, { ...PREV }],
        [3, { ...PREV }],
      ]);
      const sealed = sealManifest(manifest(threeRowDate()));
      const rb = buildRollbackManifest(sealed, 1);
      const { runInTransaction } = gateway(store, {
        failAtIndex: p.idx,
        failPhase: p.phase,
      });

      const res = await applyRepairManifest({
        sealed,
        rollback: rb,
        actualCodeSha: "abc1234",
        actualSchemaVersion: "0134_widen_unit_probability_precision",
        runInTransaction,
        log: () => {},
      });

      expect(res.applied).toBe(0);
      // Every row in the date is back to its pre-image — no partial application.
      for (const id of [1, 2, 3]) {
        expect(store.get(id)!.brierNrfi).toBe(PREV.brierNrfi);
      }
    });
  }

  it("never reports a REVERTED date as completed, even with failFast off", async () => {
    // Clean-room review finding: with failFast disabled, a rolled-back date had
    // no WRITE_ERROR row and no halt, so it was pushed to datesCompleted. A
    // resume driven off that list would silently skip work that never landed.
    const store = new Map<number, BrierMap>([
      [1, { ...PREV }],
      [2, { ...PREV }],
      [3, { ...PREV }],
    ]);
    const sealed = sealManifest(manifest(threeRowDate()));
    const rb = buildRollbackManifest(sealed, 1);
    const { runInTransaction } = gateway(store, {
      failAtIndex: 1,
      failPhase: "verify",
    });

    const res = await applyRepairManifest({
      sealed,
      rollback: rb,
      actualCodeSha: "abc1234",
      actualSchemaVersion: "0134_widen_unit_probability_precision",
      runInTransaction,
      failFast: false,
      log: () => {},
    });

    expect(res.datesCompleted).toEqual([]);
    expect(res.applied).toBe(0);
    // A reverted write is REVERTED, not "skipped" — the totals must not imply
    // the row was deliberately passed over.
    expect(res.rows.some(r => r.outcome === "REVERTED")).toBe(true);
    expect(res.skipped).toBe(0);
    for (const id of [1, 2, 3]) {
      expect(store.get(id)!.brierNrfi).toBe(PREV.brierNrfi);
    }
  });

  it("reports a clean date as completed", async () => {
    const store = new Map<number, BrierMap>([
      [1, { ...PREV }],
      [2, { ...PREV }],
      [3, { ...PREV }],
    ]);
    const sealed = sealManifest(manifest(threeRowDate()));
    const rb = buildRollbackManifest(sealed, 1);
    const { runInTransaction } = gateway(store);

    const res = await applyRepairManifest({
      sealed,
      rollback: rb,
      actualCodeSha: "abc1234",
      actualSchemaVersion: "0134_widen_unit_probability_precision",
      runInTransaction,
      log: () => {},
    });

    expect(res.datesCompleted).toEqual(["2026-05-01"]);
  });

  it("applies all three rows when nothing fails", async () => {
    const store = new Map<number, BrierMap>([
      [1, { ...PREV }],
      [2, { ...PREV }],
      [3, { ...PREV }],
    ]);
    const sealed = sealManifest(manifest(threeRowDate()));
    const rb = buildRollbackManifest(sealed, 1);
    const { runInTransaction } = gateway(store);

    const res = await applyRepairManifest({
      sealed,
      rollback: rb,
      actualCodeSha: "abc1234",
      actualSchemaVersion: "0134_widen_unit_probability_precision",
      runInTransaction,
      log: () => {},
    });

    expect(res.applied).toBe(3);
    for (const id of [1, 2, 3]) {
      expect(store.get(id)!.brierNrfi).toBe(NEXT.brierNrfi);
    }
  });
});
