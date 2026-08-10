/**
 * M-203 END-TO-END: real dry run → sealed manifest → rollback.
 *
 * This is the proof that the architecture is actually CONNECTED, not a set of
 * modules that each pass in isolation. It drives the real ingestMlbOutcomes()
 * in historical dry-run mode and feeds its ACTUAL returned results through the
 * whole chain — no hand-built DryRunRow fixture anywhere.
 *
 *   real ingestMlbOutcomes(dryRun, historical)
 *     → buildRepairManifest      (defect-window admission + classification)
 *     → reconcileAccounting      (identity must balance)
 *     → verifyManifestSeal
 *     → findInvariantViolations  (percent-scaled markets must not move)
 *     → crossCheckWithOracle     (independent recomputation)
 *     → buildRollbackManifest
 *     → validateRollback         (content, not just row IDs)
 *
 * If buildRepairManifest had to invent missing evidence, rows would land in
 * EVIDENCE_INCOMPLETE and this test would fail — which is exactly how it proves
 * the dry-run output is manifest-complete.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state: {
  rows: Record<string, unknown>[];
  updates: unknown[];
} = { rows: [], updates: [] };

const notifyOwnerSpy = vi.fn(async () => true);
const checkDriftSpy = vi.fn(async () => ({
  driftDetected: false,
  delta: 0,
  rollingF5Share: 0.5,
  baselineF5Share: 0.5,
  windowSize: 30,
  recalibrationTriggered: false,
  message: "ok",
}));

vi.mock("../../_core/notification", () => ({
  notifyOwner: (...a: unknown[]) => notifyOwnerSpy(...(a as [])),
}));
vi.mock("../../mlbDriftDetector", () => ({
  checkF5ShareDrift: (...a: unknown[]) => checkDriftSpy(...(a as [])),
}));
vi.mock("../../db", () => ({ getDb: async () => makeFakeDb() }));

import { ingestMlbOutcomes } from "../../mlbOutcomeIngestor";
import {
  buildRepairManifest,
  type DefectWindow,
  type DryRunRow,
} from "./buildManifest";
import {
  buildRollbackManifest,
  crossCheckWithOracle,
  findInvariantViolations,
  validateRollback,
  verifyManifestSeal,
} from "./repairManifest";

// ─── Fake DB (reads only; any write is a test failure) ───────────────────────

function makeFakeDb() {
  return {
    select(cols: Record<string, unknown>) {
      const keys = Object.keys(cols ?? {});
      return {
        from: () => ({
          where: async () => {
            if (keys.includes("count")) return [{ count: 0 }];
            if (keys.includes("id")) return state.rows;
            return [state.rows[0] ?? {}];
          },
        }),
      };
    },
    update() {
      return {
        set(payload: unknown) {
          return {
            where: async () => {
              state.updates.push(payload);
            },
          };
        },
      };
    },
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SCORED_AT = Date.parse("2026-05-02T08:00:00Z");

const WINDOW: DefectWindow = {
  defectStartMs: Date.parse("2026-04-15T06:15:17Z"),
  fixDeployedAtMs: Date.parse("2026-08-07T19:28:23Z"),
};

/** A game the API reports final with a complete linescore. */
function apiGame(gamePk: number, away = "CLE", home = "CWS") {
  return {
    gamePk,
    status: { abstractGameState: "Final", detailedState: "Final" },
    teams: {
      away: { team: { abbreviation: away }, score: 5 },
      home: { team: { abbreviation: home }, score: 4 },
    },
    linescore: {
      teams: { away: { runs: 5 }, home: { runs: 4 } },
      innings: [
        { num: 1, away: { runs: 0 }, home: { runs: 0 } }, // NRFI
        { num: 2, away: { runs: 2 }, home: { runs: 1 } },
        { num: 3, away: { runs: 0 }, home: { runs: 0 } },
        { num: 4, away: { runs: 1 }, home: { runs: 0 } },
        { num: 5, away: { runs: 0 }, home: { runs: 1 } },
        { num: 6, away: { runs: 2 }, home: { runs: 2 } },
      ],
    },
  };
}

/**
 * A row carrying the DEFECTIVE historical Brier values — the two unit-scaled
 * markets scored through the old ÷100 path, the three percent-scaled markets
 * already correct.
 */
function dbRow(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    gameDate: "2026-05-01",
    awayTeam: "CLE",
    homeTeam: "CWS",
    gameStatus: "final",
    mlbGamePk: 700001,
    outcomeIngestedAt: SCORED_AT,
    bookTotal: "8.5",
    modelOverRate: "60.00",
    f5Total: "4.5",
    modelF5OverRate: "0.5432",
    modelPNrfi: "0.5234",
    modelHomeWinPct: "52.00",
    modelF5HomeWinPct: "51.00",
    actualAwayScore: null,
    actualHomeScore: null,
    actualF5AwayScore: null,
    actualF5HomeScore: null,
    prevActualFgTotal: "9.0",
    // FG total: actual 9 > line 8.5 -> over=1, p=0.60 -> (0.6-1)^2 = 0.16
    prevBrierFgTotal: "0.160000",
    // F5 total: innings 1-5 give away 3 + home 2 = 5 > 4.5 -> over=1.
    // defective p = 0.5432/100 -> (0.005432-1)^2 = 0.989166
    prevBrierF5Total: "0.989166",
    // NRFI happened -> 1. defective p=0.005234 -> ~0.989559
    prevBrierNrfi: "0.989559",
    // FG ML: home 4 < away 5 -> homeWin=0, p=0.52 -> 0.2704
    prevBrierFgMl: "0.270400",
    // F5 ML: home 1 < away 3 -> homeWin=0, p=0.51 -> 0.2601
    prevBrierF5Ml: "0.260100",
    ...over,
  };
}

function mockApi(games: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ dates: [{ games }] }),
    }))
  );
}

beforeEach(() => {
  state.rows = [];
  state.updates = [];
  notifyOwnerSpy.mockClear();
  checkDriftSpy.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

const MANIFEST_OPTS = {
  repairRunId: "m203-e2e-2026-05-01",
  generatedAt: 1_700_000_000_000,
  codeSha: "e2e-code-sha",
  schemaVersion: "0134_widen_unit_probability_precision",
  window: WINDOW,
};

// ─── The chain ───────────────────────────────────────────────────────────────

describe("M-203 end-to-end: real dry run drives the whole architecture", () => {
  it("produces a complete, balanced, oracle-verified, rollback-covered manifest with ZERO writes", async () => {
    state.rows = [dbRow()];
    mockApi([apiGame(700001)]);

    // ── 1. The REAL ingestor, historical dry run ──────────────────────────
    const summary = await ingestMlbOutcomes("2026-05-01", true, {
      dryRun: true,
      historical: true,
    });

    expect(state.updates).toHaveLength(0); // zero DB writes
    expect(checkDriftSpy).not.toHaveBeenCalled(); // zero drift
    expect(notifyOwnerSpy).not.toHaveBeenCalled(); // zero notification
    expect(summary.written).toBe(0);
    expect(summary.wouldWrite).toBe(1);

    // ── 2. Manifest from the ACTUAL results, no synthetic fixture ─────────
    const { sealed, accounting } = buildRepairManifest({
      ...MANIFEST_OPTS,
      rows: summary.results as unknown as DryRunRow[],
    });

    // Evidence completeness: had the dry run omitted anything the manifest
    // needs, the row would be EVIDENCE_INCOMPLETE instead.
    const row = sealed.manifest.rows[0];
    expect(row.classification).toBe("CORRECTION_REQUIRED");
    expect(row.matchMethod).toBe("mlbGamePk");
    expect(row.outcomeIngestedAt).toBe(SCORED_AT);
    expect(row.inputs.modelPNrfi).toBe("0.5234");
    expect(row.computedOutcomes.outcomeNrfi).toBe(1);
    expect(row.computedOutcomes.outcomeF5Over).toBe(1);
    expect(row.previousActualFgTotal).toBe("9.0");

    // ── 3. Accounting identity ────────────────────────────────────────────
    expect(accounting.total).toBe(1);
    expect(accounting.balanced).toBe(true);
    expect(accounting.writable).toBe(1);
    expect(accounting.applyBlocking).toBe(0);
    expect(accounting.closureBlocking).toBe(0);

    // ── 4. Seal ───────────────────────────────────────────────────────────
    expect(verifyManifestSeal(sealed)).toBe(true);

    // ── 5. Invariants: only the two unit-scaled markets move ──────────────
    expect(findInvariantViolations(sealed.manifest.rows)).toEqual([]);
    expect([...row.changeFields].sort()).toEqual(["brierF5Total", "brierNrfi"]);

    // ── 6. Independent oracle agrees with every proposed value ────────────
    expect(crossCheckWithOracle(sealed.manifest.rows)).toEqual([]);

    // ── 7. Rollback covers it, content-validated ──────────────────────────
    const rollback = buildRollbackManifest(sealed, MANIFEST_OPTS.generatedAt);
    expect(validateRollback(sealed, rollback)).toEqual([]);
    expect(rollback.rows[0].restoreTo.brierNrfi).toBeCloseTo(0.989559, 6);
    expect(rollback.rows[0].expectedCurrent.brierNrfi).toBeCloseTo(0.227148, 6);

    // Still zero writes at the end of the entire chain.
    expect(state.updates).toHaveLength(0);
  });

  it("is deterministic — the same dry run yields the same checksum", async () => {
    state.rows = [dbRow()];
    mockApi([apiGame(700001)]);
    const a = await ingestMlbOutcomes("2026-05-01", true, {
      dryRun: true,
      historical: true,
    });
    const m1 = buildRepairManifest({
      ...MANIFEST_OPTS,
      rows: a.results as unknown as DryRunRow[],
    });

    state.rows = [dbRow()];
    mockApi([apiGame(700001)]);
    const b = await ingestMlbOutcomes("2026-05-01", true, {
      dryRun: true,
      historical: true,
    });
    const m2 = buildRepairManifest({
      ...MANIFEST_OPTS,
      rows: b.results as unknown as DryRunRow[],
    });

    expect(m1.sealed.manifestSha256).toBe(m2.sealed.manifestSha256);
  });

  it("excludes a row scored AFTER the fix deployed — game date is irrelevant", async () => {
    // Same May game, but re-ingested in August: already correctly scored.
    state.rows = [
      dbRow({ outcomeIngestedAt: Date.parse("2026-08-08T08:00:00Z") }),
    ];
    mockApi([apiGame(700001)]);

    const summary = await ingestMlbOutcomes("2026-05-01", true, {
      dryRun: true,
      historical: true,
    });
    const { sealed, accounting } = buildRepairManifest({
      ...MANIFEST_OPTS,
      rows: summary.results as unknown as DryRunRow[],
    });

    expect(sealed.manifest.rows[0].classification).toBe(
      "OUTSIDE_DEFECT_WINDOW"
    );
    expect(accounting.writable).toBe(0);
    expect(accounting.applyBlocking).toBe(0);
    expect(accounting.balanced).toBe(true);
  });

  it("refuses to repair a row whose scoring time is unknown", async () => {
    state.rows = [dbRow({ outcomeIngestedAt: null })];
    mockApi([apiGame(700001)]);

    const summary = await ingestMlbOutcomes("2026-05-01", true, {
      dryRun: true,
      historical: true,
    });
    const { sealed, accounting } = buildRepairManifest({
      ...MANIFEST_OPTS,
      rows: summary.results as unknown as DryRunRow[],
    });

    expect(sealed.manifest.rows[0].classification).toBe(
      "INVESTIGATION_REQUIRED"
    );
    expect(accounting.writable).toBe(0);
    expect(accounting.applyBlocking).toBe(1); // blocks the date
  });

  it("an ambiguous doubleheader blocks the date instead of being skipped", async () => {
    state.rows = [dbRow({ mlbGamePk: null })];
    // Two same-matchup outcomes and no mlbGamePk to disambiguate.
    mockApi([apiGame(700001), apiGame(700002)]);

    const summary = await ingestMlbOutcomes("2026-05-01", true, {
      dryRun: true,
      historical: true,
    });
    const { sealed, accounting } = buildRepairManifest({
      ...MANIFEST_OPTS,
      rows: summary.results as unknown as DryRunRow[],
    });

    const cls = sealed.manifest.rows[0].classification;
    expect([
      "AMBIGUOUS_MATCH",
      "DOUBLEHEADER_REVIEW",
      "MISSING_MLB_MATCH",
    ]).toContain(cls);
    expect(accounting.writable).toBe(0);
    expect(accounting.applyBlocking).toBe(1);
    expect(state.updates).toHaveLength(0);
  });
});
