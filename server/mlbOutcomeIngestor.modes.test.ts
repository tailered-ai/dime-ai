/**
 * Regression tests for the M-203 execution modes.
 *
 * These drive ingestMlbOutcomes() end-to-end against an in-memory fake DB that
 * deliberately reproduces Drizzle's real UPDATE semantics: keys whose value is
 * `undefined` are OMITTED from the write. That behaviour was verified directly
 * against drizzle-orm by rendering .toSQL() before this fake was written, so
 * the null-correction test below proves a real property and not a fake one.
 *
 * Proven here:
 *   1. dry run performs ZERO writes and reports would_write + before/after
 *   2. normal (unflagged) ingestion behaviour is unchanged
 *   3. historical mode cannot trigger recalibration or owner notification
 *   4. a null Brier CLEARS a stale stored value on a force re-ingest
 *   5. post-write verification detects a Brier field that did not land
 *   6. repeated forced ingestion is stable (idempotent)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks must be declared before importing the module under test ────────────
const state: {
  rows: Record<string, unknown>[];
  updates: { id: number | null; payload: Record<string, unknown> }[];
  /** Fields the fake DB will refuse to persist (simulates a lost write). */
  dropOnWrite: string[];
} = { rows: [], updates: [], dropOnWrite: [] };

const notifyOwnerSpy = vi.fn(async () => true);
const checkDriftSpy = vi.fn(async () => ({
  driftDetected: false,
  delta: 0.001,
  rollingF5Share: 0.45,
  baselineF5Share: 0.45,
  windowSize: 30,
  recalibrationTriggered: false,
  message: "ok",
}));

vi.mock("./_core/notification", () => ({
  notifyOwner: (...a: unknown[]) => notifyOwnerSpy(...(a as [])),
}));
vi.mock("./mlbDriftDetector", () => ({
  checkF5ShareDrift: (...a: unknown[]) => checkDriftSpy(...(a as [])),
}));
vi.mock("./db", () => ({ getDb: async () => makeFakeDb() }));

import { ingestMlbOutcomes, verifyWrittenFields } from "./mlbOutcomeIngestor";

// ── Fake DB ──────────────────────────────────────────────────────────────────

/** Pull the numeric id out of a drizzle `eq(games.id, N)` condition. */
function extractId(cond: unknown): number | null {
  const seen = new Set<unknown>();
  const walk = (o: unknown): number | null => {
    if (!o || typeof o !== "object" || seen.has(o)) return null;
    seen.add(o);
    const rec = o as Record<string, unknown>;
    if ("value" in rec && typeof rec.value === "number") return rec.value;
    for (const v of Object.values(rec)) {
      if (Array.isArray(v)) {
        for (const x of v) {
          const r = walk(x);
          if (r !== null) return r;
        }
      } else if (v && typeof v === "object") {
        const r = walk(v);
        if (r !== null) return r;
      }
    }
    return null;
  };
  return walk(cond);
}

function makeFakeDb() {
  let lastUpdatedId: number | null = null;
  return {
    select(cols: Record<string, unknown>) {
      const keys = Object.keys(cols ?? {});
      return {
        from: () => ({
          where: async (_w: unknown) => {
            if (keys.includes("count")) return [{ count: 0 }]; // coverage audit
            if (keys.includes("id")) return state.rows; // batch query
            // post-write verification read
            const row = state.rows.find(r => r.id === lastUpdatedId);
            return [row ?? {}];
          },
        }),
      };
    },
    update() {
      return {
        set(payload: Record<string, unknown>) {
          return {
            where: async (cond: unknown) => {
              const id = extractId(cond);
              lastUpdatedId = id;
              state.updates.push({ id, payload });
              const row = state.rows.find(r => r.id === id);
              if (row) {
                for (const [k, v] of Object.entries(payload)) {
                  // Drizzle OMITS undefined — verified via .toSQL()
                  if (v === undefined) continue;
                  if (state.dropOnWrite.includes(k)) continue; // simulate lost write
                  row[k] = v;
                }
              }
              return undefined;
            },
          };
        },
      };
    },
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A final game the API reports with a full linescore. */
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
        { num: 1, away: { runs: 0 }, home: { runs: 0 } }, // NRFI = 1
        { num: 2, away: { runs: 2 }, home: { runs: 1 } },
        { num: 3, away: { runs: 0 }, home: { runs: 0 } },
        { num: 4, away: { runs: 1 }, home: { runs: 0 } },
        { num: 5, away: { runs: 0 }, home: { runs: 1 } },
        { num: 6, away: { runs: 2 }, home: { runs: 2 } },
      ],
    },
  };
}

function dbRow(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    gameDate: "2026-08-01",
    awayTeam: "CLE",
    homeTeam: "CWS",
    gameStatus: "final",
    mlbGamePk: 700001,
    outcomeIngestedAt: null,
    bookTotal: "8.5",
    modelOverRate: "60.00", // percent scale
    f5Total: "4.5",
    modelF5OverRate: "0.5432", // unit scale
    modelPNrfi: "0.5234", // unit scale
    modelHomeWinPct: "52.00",
    modelF5HomeWinPct: "51.00",
    actualAwayScore: null,
    actualHomeScore: null,
    actualF5AwayScore: null,
    actualF5HomeScore: null,
    prevBrierFgTotal: null,
    prevBrierF5Total: null,
    prevBrierNrfi: null,
    prevBrierFgMl: null,
    prevBrierF5Ml: null,
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
  state.dropOnWrite = [];
  notifyOwnerSpy.mockClear();
  checkDriftSpy.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

// ── 1. Dry run performs zero writes ──────────────────────────────────────────

describe("dryRun", () => {
  it("performs ZERO database writes and reports would_write", async () => {
    state.rows = [dbRow()];
    mockApi([apiGame(700001)]);

    const s = await ingestMlbOutcomes("2026-08-01", false, { dryRun: true });

    expect(state.updates).toHaveLength(0); // the load-bearing assertion
    expect(s.written).toBe(0);
    expect(s.wouldWrite).toBe(1);
    expect(s.dryRun).toBe(true);
    expect(s.results[0].status).toBe("would_write");
    // Row is untouched.
    expect(state.rows[0].outcomeIngestedAt).toBeNull();
    expect(state.rows[0].brierNrfi).toBeUndefined();
  });

  it("reports before/after Brier so scope is measurable without writing", async () => {
    state.rows = [dbRow({ prevBrierNrfi: "0.990000" })]; // M-203 garbage
    mockApi([apiGame(700001)]);

    const s = await ingestMlbOutcomes("2026-08-01", true, { dryRun: true });
    const r = s.results[0];

    expect(r.previousBrier?.brierNrfi).toBeCloseTo(0.99, 6);
    // NRFI happened (o=1), p=0.5234 -> (0.5234-1)^2 = 0.227148
    expect(r.brierNrfi).toBeCloseTo(0.227148, 6);
    expect(r.brierChanged).toBe(true);
    expect(s.brierChanged).toBe(1);
    expect(state.updates).toHaveLength(0);
  });

  it("suppresses drift detector and owner notification", async () => {
    state.rows = [dbRow()];
    mockApi([apiGame(700001)]);

    await ingestMlbOutcomes("2026-08-01", false, { dryRun: true });

    expect(checkDriftSpy).not.toHaveBeenCalled();
    expect(notifyOwnerSpy).not.toHaveBeenCalled();
  });
});

// ── 2. Normal behaviour unchanged ────────────────────────────────────────────

describe("normal ingestion (no options)", () => {
  it("writes, runs the drift detector and notifies the owner exactly as before", async () => {
    state.rows = [dbRow()];
    mockApi([apiGame(700001)]);

    const s = await ingestMlbOutcomes("2026-08-01");

    expect(s.written).toBe(1);
    expect(s.wouldWrite).toBe(0);
    expect(s.dryRun).toBe(false);
    expect(s.historical).toBe(false);
    expect(state.updates).toHaveLength(1);
    expect(checkDriftSpy).toHaveBeenCalledTimes(1);
    expect(notifyOwnerSpy).toHaveBeenCalledTimes(1);
    expect(s.results[0].status).toBe("written");
  });

  it("still honours the outcomeIngestedAt idempotency gate without force", async () => {
    state.rows = [dbRow({ outcomeIngestedAt: 1_700_000_000_000 })];
    mockApi([apiGame(700001)]);

    const s = await ingestMlbOutcomes("2026-08-01");

    expect(s.written).toBe(0);
    expect(s.skippedAlreadyIngested).toBe(1);
    expect(state.updates).toHaveLength(0);
  });
});

// ── 3. Historical mode ───────────────────────────────────────────────────────

describe("historical mode", () => {
  it("writes but CANNOT trigger recalibration or notify the owner", async () => {
    state.rows = [dbRow()];
    mockApi([apiGame(700001)]);

    const s = await ingestMlbOutcomes("2026-08-01", true, {
      historical: true,
    });

    expect(s.written).toBe(1); // still a real write
    expect(s.historical).toBe(true);
    expect(checkDriftSpy).not.toHaveBeenCalled(); // no recalibration path
    expect(notifyOwnerSpy).not.toHaveBeenCalled();
  });
});

// ── 4. NULL corrections persist ──────────────────────────────────────────────

describe("null Brier correction", () => {
  it("CLEARS a stale stored Brier when the corrected value is null", async () => {
    // modelPNrfi absent -> brierNrfi computes to null.
    // The row already holds M-203 garbage that MUST be cleared.
    state.rows = [
      dbRow({
        modelPNrfi: null,
        prevBrierNrfi: "0.990000",
        brierNrfi: "0.990000",
        outcomeIngestedAt: 1_700_000_000_000,
      }),
    ];
    mockApi([apiGame(700001)]);

    const s = await ingestMlbOutcomes("2026-08-01", true, {
      historical: true,
    });

    expect(s.written).toBe(1);
    const payload = state.updates[0].payload;
    // Explicit null, NOT undefined — undefined would be omitted by Drizzle
    // and the stale 0.99 would survive.
    expect(payload.brierNrfi).toBeNull();
    expect(state.rows[0].brierNrfi).toBeNull();
  });

  it("leaves actual* omitted when null so drift-window inputs are not cleared", async () => {
    state.rows = [dbRow()];
    // No linescore runs AND no team scores -> actualFgTotal computes to null.
    mockApi([
      {
        ...apiGame(700001),
        teams: {
          away: { team: { abbreviation: "CLE" } },
          home: { team: { abbreviation: "CWS" } },
        },
        linescore: { teams: {}, innings: [] },
      },
    ]);

    await ingestMlbOutcomes("2026-08-01", true, { historical: true });

    const payload = state.updates[0].payload;
    expect(payload.actualFgTotal).toBeUndefined();
    expect(payload.actualF5Total).toBeUndefined();
  });
});

// ── 5. Verification detects a bad Brier write ────────────────────────────────

describe("post-write verification", () => {
  it("returns a mismatch when a Brier field did not land", () => {
    const m = verifyWrittenFields(
      {
        actualFgTotal: 9,
        brierFgTotal: 0.25,
        brierF5Total: 0.1,
        brierNrfi: 0.227148,
        brierFgMl: 0.2,
        brierF5Ml: null,
      },
      {
        actualFgTotal: "9.0",
        brierFgTotal: "0.250000",
        brierF5Total: "0.100000",
        brierNrfi: "0.990000", // stale value survived
        brierFgMl: "0.200000",
        brierF5Ml: null,
      }
    );
    expect(m).toHaveLength(1);
    expect(m[0]).toContain("brierNrfi");
  });

  it("flags a Brier that should be null but is not", () => {
    const m = verifyWrittenFields(
      {
        actualFgTotal: null,
        brierFgTotal: null,
        brierF5Total: null,
        brierNrfi: null,
        brierFgMl: null,
        brierF5Ml: null,
      },
      {
        actualFgTotal: null,
        brierFgTotal: null,
        brierF5Total: null,
        brierNrfi: "0.990000",
        brierFgMl: null,
        brierF5Ml: null,
      }
    );
    expect(m).toHaveLength(1);
    expect(m[0]).toContain("brierNrfi");
  });

  it("passes clean and does not assert on an unwritten actualFgTotal", () => {
    const m = verifyWrittenFields(
      {
        actualFgTotal: null, // not written -> must not be asserted
        brierFgTotal: 0.25,
        brierF5Total: null,
        brierNrfi: 0.227148,
        brierFgMl: null,
        brierF5Ml: null,
      },
      {
        actualFgTotal: "12.0", // pre-existing value, deliberately untouched
        brierFgTotal: "0.250000",
        brierF5Total: null,
        brierNrfi: "0.227148",
        brierFgMl: null,
        brierF5Ml: null,
      }
    );
    expect(m).toEqual([]);
  });

  it("detects the lost write end-to-end via the ingestor", async () => {
    state.rows = [dbRow()];
    state.dropOnWrite = ["brierNrfi"]; // DB silently refuses this column
    mockApi([apiGame(700001)]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await ingestMlbOutcomes("2026-08-01", true, { historical: true });

    const failLogged = errSpy.mock.calls
      .map(c => String(c[0]))
      .some(m => m.includes("[VERIFY] FAIL") && m.includes("brierNrfi"));
    expect(failLogged).toBe(true);
    errSpy.mockRestore();
  });
});

// ── 6. Repeated forced ingestion is stable ───────────────────────────────────

describe("repeated forced ingestion", () => {
  it("is idempotent — a second force run changes nothing", async () => {
    state.rows = [dbRow({ prevBrierNrfi: "0.990000" })];
    mockApi([apiGame(700001)]);

    const first = await ingestMlbOutcomes("2026-08-01", true, {
      historical: true,
    });
    expect(first.written).toBe(1);
    expect(first.brierChanged).toBe(1);

    // Feed the post-write state back in, exactly as a fresh SELECT would.
    const row = state.rows[0];
    state.rows = [
      dbRow({
        outcomeIngestedAt: row.outcomeIngestedAt,
        prevBrierFgTotal: row.brierFgTotal,
        prevBrierF5Total: row.brierF5Total,
        prevBrierNrfi: row.brierNrfi,
        prevBrierFgMl: row.brierFgMl,
        prevBrierF5Ml: row.brierF5Ml,
      }),
    ];
    state.updates = [];

    const second = await ingestMlbOutcomes("2026-08-01", true, {
      historical: true,
    });

    expect(second.written).toBe(1);
    expect(second.brierChanged).toBe(0); // nothing moved the second time
    expect(second.results[0].brierNrfi).toBeCloseTo(
      first.results[0].brierNrfi!,
      6
    );
  });
});
