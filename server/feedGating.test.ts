import { describe, expect, it } from "vitest";
import {
  setGatedCacheHeaders,
  stripGameModelFields,
  stripHrPropModelFields,
  stripStrikeoutPropModelFields,
  stripWcMatchupModelFields,
  applyMlbMarketGatesToGame,
  applyMlbMarketGatesToHrProp,
  applyMlbMarketGatesToStrikeoutProp,
} from "./feedGating";
import type { MlbMarketGates } from "./mlbMarketGates";

describe("stripGameModelFields", () => {
  const row = {
    // commodity — MUST survive
    id: 42,
    sport: "MLB",
    awayTeam: "NYY",
    homeTeam: "BOS",
    gameDate: "2026-08-05",
    awayBookSpread: "-1.5",
    bookTotal: "8.5",
    awayRunLine: "-1.5",
    ticketPct: "72",
    awayStartingPitcher: "Gerrit Cole",
    actualAwayScore: 5,
    // proprietary model IP — MUST be nulled
    awayModelSpread: "-1.7",
    homeModelSpread: "1.7",
    modelTotal: "8.9",
    modelAwayWinPct: "0.58",
    modelF5Total: "4.1",
    modelPNrfi: "0.42",
    modelPHr: "0.11",
    modelRunAt: 1785900000000,
    spreadEdge: "3.6",
    totalEdge: "1.2",
    spreadDiff: "0.2",
    totalDiff: "0.4",
  };

  it("nulls every model* field and the edge fields", () => {
    const out = stripGameModelFields(row);
    for (const k of [
      "awayModelSpread",
      "homeModelSpread",
      "modelTotal",
      "modelAwayWinPct",
      "modelF5Total",
      "modelPNrfi",
      "modelPHr",
      "modelRunAt",
      "spreadEdge",
      "totalEdge",
      "spreadDiff",
      "totalDiff",
    ]) {
      expect(out[k as keyof typeof out]).toBeNull();
    }
  });

  it("preserves ALL commodity fields (schedule, book lines, splits, actuals)", () => {
    const out = stripGameModelFields(row);
    expect(out.id).toBe(42);
    expect(out.awayTeam).toBe("NYY");
    expect(out.awayBookSpread).toBe("-1.5");
    expect(out.bookTotal).toBe("8.5");
    expect(out.awayRunLine).toBe("-1.5");
    expect(out.ticketPct).toBe("72");
    expect(out.awayStartingPitcher).toBe("Gerrit Cole");
    expect(out.actualAwayScore).toBe(5);
  });

  it("does not mutate the input row", () => {
    const clone = { ...row };
    stripGameModelFields(row);
    expect(row).toEqual(clone);
  });

  it("catches a hypothetical FUTURE model field via the prefix rule (leak-safe)", () => {
    const out = stripGameModelFields({
      ...row,
      modelBrandNewSignal2027: "0.99",
    } as Record<string, unknown>);
    expect(out.modelBrandNewSignal2027).toBeNull();
  });

  it("nulls the model-relative backtest residuals (nrfiBacktestResult + *BacktestRunAt) but keeps actual outcomes", () => {
    const out = stripGameModelFields({
      ...row,
      // IP: model-graded / model-pipeline metadata (latent — null in prod today)
      nrfiBacktestResult: "WIN",
      fgBacktestRunAt: 1_700_000_000,
      f5BacktestRunAt: 1_700_000_001,
      nrfiBacktestRunAt: 1_700_000_002,
      // commodity actual outcomes — MUST survive
      nrfiActualResult: "NRFI",
      fgMlResult: "HOME",
      f5TotalResult: "OVER",
      actualNrfiBinary: 0,
    } as Record<string, unknown>);
    expect(out.nrfiBacktestResult).toBeNull();
    expect(out.fgBacktestRunAt).toBeNull();
    expect(out.f5BacktestRunAt).toBeNull();
    expect(out.nrfiBacktestRunAt).toBeNull();
    // actual outcomes stay public (commodity)
    expect(out.nrfiActualResult).toBe("NRFI");
    expect(out.fgMlResult).toBe("HOME");
    expect(out.f5TotalResult).toBe("OVER");
    expect(out.actualNrfiBinary).toBe(0);
  });
});

describe("stripStrikeoutPropModelFields", () => {
  it("nulls projection/edge/model IP, keeps only the commodity book line", () => {
    const out = stripStrikeoutPropModelFields({
      playerId: "cole",
      bookLine: "6.5", // commodity book line — the ONLY thing that survives
      kLine: "6.5", // IP: schema says "Model recommended line"
      kProj: "7.2", // IP
      pOver: "0.61",
      edgeOver: "4.1",
      verdict: "OVER",
      distribution: "{...}",
      matchupRows: "[...]",
      inningBreakdown: "[...]",
      bestMlStr: "-140",
      modelError: "0.3", // reconstructs kProj on finals — IP
      modelRunAt: 123,
    });
    expect(out.bookLine).toBe("6.5"); // commodity — survives
    for (const k of [
      "kLine",
      "kProj",
      "pOver",
      "edgeOver",
      "verdict",
      "distribution",
      "matchupRows",
      "inningBreakdown",
      "bestMlStr",
      "modelError",
      "modelRunAt",
    ]) {
      expect(out[k as keyof typeof out]).toBeNull();
    }
  });

  it("nulls backtestRunAt (model-pipeline timing) but keeps backtestResult (OVER/UNDER/PUSH vs BOOK line = commodity) + actualKs", () => {
    const out = stripStrikeoutPropModelFields({
      bookLine: "6.5",
      actualKs: 8, // commodity box-score fact — keep
      backtestResult: "OVER", // K-props: vs the BOOK line — commodity, keep
      backtestRunAt: 1_700_000_000, // model-pipeline timing — IP, strip
    });
    expect(out.bookLine).toBe("6.5");
    expect(out.actualKs).toBe(8);
    expect(out.backtestResult).toBe("OVER");
    expect(out.backtestRunAt).toBeNull();
  });
});

describe("stripHrPropModelFields", () => {
  it("nulls the HR model fields, keeps identity/book", () => {
    const out = stripHrPropModelFields({
      playerId: "judge",
      bookOverOdds: "+280", // commodity — keep
      modelPHr: "0.14", // IP
      edgeOver: "6.0",
      evOver: "0.08",
      verdict: "OVER",
    });
    expect(out.playerId).toBe("judge");
    expect(out.bookOverOdds).toBe("+280");
    expect(out.modelPHr).toBeNull();
    expect(out.edgeOver).toBeNull();
    expect(out.evOver).toBeNull();
    expect(out.verdict).toBeNull();
  });

  it("nulls backtestResult/backtestRunAt (model-OVER-pick WIN/LOSS IP) but keeps actualHr (commodity box-score)", () => {
    // Live leak, confirmed 2026-08-06: backtestResult is WIN/LOSS only when the
    // model verdict was OVER, so it re-identifies the model's actionable picks.
    const out = stripHrPropModelFields({
      gameId: 2251604,
      playerName: "Aaron Judge", // commodity — keep
      teamAbbrev: "NYY", // commodity — keep
      bookLine: "0.5", // commodity — keep
      actualHr: 1, // commodity box-score fact — keep
      verdict: "OVER", // IP
      backtestResult: "WIN", // IP (model-verdict-relative)
      backtestRunAt: 1_700_000_000, // model-pipeline timing — IP
      modelCorrect: 1, // IP (caught by the "model" rule)
    });
    expect(out.playerName).toBe("Aaron Judge");
    expect(out.teamAbbrev).toBe("NYY");
    expect(out.bookLine).toBe("0.5");
    expect(out.actualHr).toBe(1);
    expect(out.verdict).toBeNull();
    expect(out.backtestResult).toBeNull();
    expect(out.backtestRunAt).toBeNull();
    expect(out.modelCorrect).toBeNull();
  });
});

describe("stripWcMatchupModelFields", () => {
  it("nulls model odds/edges/probs/projection, keeps schedule + teams", () => {
    const out = stripWcMatchupModelFields({
      matchId: "m1",
      home: "BRA",
      away: "ARG",
      kickoff: "2026-06-12",
      modelOdds: { home: "-120" }, // IP
      homeEdge: "3.1",
      homeWinProb: "0.52",
      projHomeScore: "1.8",
      projection: { foo: 1 },
    });
    expect(out.matchId).toBe("m1");
    expect(out.home).toBe("BRA");
    expect(out.kickoff).toBe("2026-06-12");
    expect(out.modelOdds).toBeNull();
    expect(out.homeEdge).toBeNull();
    expect(out.homeWinProb).toBeNull();
    expect(out.projHomeScore).toBeNull();
    expect(out.projection).toBeNull();
  });
});

describe("setGatedCacheHeaders — cache-leak fix (Phase 4)", () => {
  function spyRes() {
    const headers: Record<string, string> = {};
    return {
      headers,
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
    };
  }

  it("authed: private, no-store (never shared/edge-cached) + gated Vary", () => {
    const res = spyRes();
    setGatedCacheHeaders(res, true);
    expect(res.headers["Cache-Control"]).toBe("private, no-store");
    expect(res.headers["Vary"]).toBe(
      "Cookie, Authorization, x-tailered-sports-secret"
    );
  });

  it("anon: short public cache for the stripped commodity shape + gated Vary", () => {
    const res = spyRes();
    setGatedCacheHeaders(res, false);
    expect(res.headers["Cache-Control"]).toBe(
      "public, max-age=30, stale-while-revalidate=60"
    );
    expect(res.headers["Vary"]).toBe(
      "Cookie, Authorization, x-tailered-sports-secret"
    );
  });

  it("never throws on a missing/!function res (defensive)", () => {
    expect(() => setGatedCacheHeaders(undefined, true)).not.toThrow();
    expect(() =>
      setGatedCacheHeaders({} as { setHeader?: never }, false)
    ).not.toThrow();
  });
});

// ─── MLB per-market publication gate (pure policy) ────────────────────────────

describe("applyMlbMarketGatesToGame", () => {
  const ALL: MlbMarketGates = {
    fg_ml: true,
    fg_rl: true,
    fg_total: true,
    f5_ml: true,
    f5_rl: true,
    f5_total: true,
    nrfi_yrfi: true,
    k_props: true,
    hr_props: true,
  };
  const gate = (...keys: (keyof MlbMarketGates)[]): MlbMarketGates => {
    const g = { ...ALL };
    for (const k of keys) g[k] = false;
    return g;
  };

  const row = {
    id: 1,
    sport: "MLB",
    awayTeam: "NYY",
    homeTeam: "BOS",
    modelRunAt: 1_700_000_000_000,
    // fg_ml
    modelAwayML: -120,
    modelHomeML: 105,
    modelAwayWinPct: "0.55",
    modelHomeWinPct: "0.45",
    brierFgMl: "0.21",
    fgMlCorrect: 1,
    // fg_rl
    awayModelSpread: "-1.5",
    homeModelSpread: "1.5",
    spreadEdge: "0.03",
    spreadDiff: "0.4",
    fgRlCorrect: 0,
    // fg_total
    modelTotal: "8.5",
    totalEdge: "0.02",
    totalDiff: "0.3",
    modelProjTotal: "8.6",
    brierFgTotal: "0.24",
    fgTotalCorrect: 1,
    // nrfi
    modelPNrfi: "0.53",
    brierNrfi: "0.25",
    nrfiCorrect: 1,
    modelInningPNeitherScores: "[]",
    // cross-market
    modelAwayScore: "4.2",
    modelHomeScore: "4.4",
    modelF5AwayScore: "2.1",
    modelF5HomeScore: "2.2",
    modelInningHomeExp: "[]",
    modelInningAwayExp: "[]",
    modelInningTotalExp: "[]",
    modelInningPHomeScores: "[]",
    modelInningPAwayScores: "[]",
    modelWeatherAdj: "1.02",
    // commodity — must always survive
    bookTotal: "8.5",
    awayML: -115,
    gameStatus: "upcoming",
  };

  it("returns the SAME object when nothing is gated (byte-identical response)", () => {
    expect(applyMlbMarketGatesToGame(row, ALL)).toBe(row);
  });

  it("nulls only the gated market's own fields", () => {
    const out = applyMlbMarketGatesToGame(row, gate("fg_ml"));
    expect(out.modelAwayML).toBeNull();
    expect(out.modelHomeWinPct).toBeNull();
    expect(out.brierFgMl).toBeNull();
    expect(out.fgMlCorrect).toBeNull();
    // other markets untouched
    expect(out.modelTotal).toBe("8.5");
    expect(out.awayModelSpread).toBe("-1.5");
    expect(out.modelPNrfi).toBe("0.53");
  });

  it("never nulls commodity fields", () => {
    const out = applyMlbMarketGatesToGame(
      row,
      gate("fg_ml", "fg_rl", "fg_total")
    );
    expect(out.bookTotal).toBe("8.5");
    expect(out.awayML).toBe(-115);
    expect(out.gameStatus).toBe("upcoming");
    expect(out.awayTeam).toBe("NYY");
  });

  it("NEVER nulls modelRunAt — it drives the all-market '—' state", () => {
    const everything = gate(...(Object.keys(ALL) as (keyof MlbMarketGates)[]));
    const out = applyMlbMarketGatesToGame(row, everything);
    expect(out.modelRunAt).toBe(1_700_000_000_000);
  });

  // REGRESSION: the projected score pair leaks the moneyline lean through the
  // SIGN of its difference, not just the run line (difference) and total (sum).
  // Omitting fg_ml here would publish the model's ML pick for a gated market.
  it("nulls the projected score pair when fg_ml alone is gated", () => {
    const out = applyMlbMarketGatesToGame(row, gate("fg_ml"));
    expect(out.modelAwayScore).toBeNull();
    expect(out.modelHomeScore).toBeNull();
  });

  it("nulls the projected score pair when fg_rl or fg_total is gated", () => {
    expect(
      applyMlbMarketGatesToGame(row, gate("fg_rl")).modelAwayScore
    ).toBeNull();
    expect(
      applyMlbMarketGatesToGame(row, gate("fg_total")).modelHomeScore
    ).toBeNull();
  });

  it("nulls the F5 score pair when any F5 market is gated", () => {
    for (const k of ["f5_ml", "f5_rl", "f5_total"] as const) {
      const out = applyMlbMarketGatesToGame(row, gate(k));
      expect(out.modelF5AwayScore).toBeNull();
      expect(out.modelF5HomeScore).toBeNull();
    }
  });

  // REGRESSION: the inning arrays sum to the full-game scores and total, so a
  // full-game gate must null them too.
  it("nulls the per-inning arrays when fg_ml is gated", () => {
    const out = applyMlbMarketGatesToGame(row, gate("fg_ml"));
    expect(out.modelInningHomeExp).toBeNull();
    expect(out.modelInningAwayExp).toBeNull();
    expect(out.modelInningTotalExp).toBeNull();
    expect(out.modelInningPHomeScores).toBeNull();
    expect(out.modelInningPAwayScores).toBeNull();
  });

  it("nulls the per-inning arrays when NRFI is gated (index 0 restores it)", () => {
    const out = applyMlbMarketGatesToGame(row, gate("nrfi_yrfi"));
    expect(out.modelInningPHomeScores).toBeNull();
    expect(out.modelInningPNeitherScores).toBeNull();
  });

  it("leaves the inning arrays alone when only a prop market is gated", () => {
    const out = applyMlbMarketGatesToGame(row, gate("k_props"));
    expect(out.modelInningHomeExp).toBe("[]");
    expect(out.modelAwayScore).toBe("4.2");
  });

  it("nulls the team HR block when hr_props is gated", () => {
    const withHr = { ...row, modelAwayHrPct: "0.4", modelHomeExpHr: "1.1" };
    const out = applyMlbMarketGatesToGame(withHr, gate("hr_props"));
    expect(out.modelAwayHrPct).toBeNull();
    expect(out.modelHomeExpHr).toBeNull();
    expect(out.modelWeatherAdj).toBeNull();
  });

  it("tolerates rows missing the gated columns entirely", () => {
    expect(() =>
      applyMlbMarketGatesToGame({ id: 9 }, gate("fg_ml"))
    ).not.toThrow();
  });
});

describe("applyMlbMarketGatesToStrikeoutProp", () => {
  const ALL: MlbMarketGates = {
    fg_ml: true,
    fg_rl: true,
    fg_total: true,
    f5_ml: true,
    f5_rl: true,
    f5_total: true,
    nrfi_yrfi: true,
    k_props: true,
    hr_props: true,
  };
  const prop = {
    id: 1,
    playerName: "Imanaga",
    bookLine: "5.5",
    consensusOverOdds: -110,
    backtestResult: "OVER",
    kProj: "6.1",
    kLine: "5.9",
    pOver: "0.58",
    edgeOver: "0.04",
    verdict: "OVER",
    modelRunAt: 1,
    backtestRunAt: 2,
  };

  it("is a no-op when k_props publishes", () => {
    expect(applyMlbMarketGatesToStrikeoutProp(prop, ALL)).toBe(prop);
  });

  it("nulls model output but keeps the book line and commodity grade", () => {
    const out = applyMlbMarketGatesToStrikeoutProp(prop, {
      ...ALL,
      k_props: false,
    });
    expect(out.kProj).toBeNull();
    expect(out.kLine).toBeNull();
    expect(out.edgeOver).toBeNull();
    expect(out.verdict).toBeNull();
    expect(out.bookLine).toBe("5.5");
    expect(out.consensusOverOdds).toBe(-110);
    // K-prop backtestResult grades against the BOOK line — commodity, not IP.
    expect(out.backtestResult).toBe("OVER");
  });

  it("is unaffected by other markets being gated", () => {
    expect(
      applyMlbMarketGatesToStrikeoutProp(prop, { ...ALL, hr_props: false })
    ).toBe(prop);
  });
});

describe("applyMlbMarketGatesToHrProp", () => {
  const ALL: MlbMarketGates = {
    fg_ml: true,
    fg_rl: true,
    fg_total: true,
    f5_ml: true,
    f5_rl: true,
    f5_total: true,
    nrfi_yrfi: true,
    k_props: true,
    hr_props: true,
  };
  const prop = {
    id: 1,
    playerName: "Judge",
    bookOverOdds: 250,
    actualHr: 1,
    modelPHr: "0.31",
    edgeOver: "0.05",
    evOver: "0.12",
    verdict: "OVER",
    backtestResult: "WIN",
    modelRunAt: 1,
  };

  it("is a no-op when hr_props publishes", () => {
    expect(applyMlbMarketGatesToHrProp(prop, ALL)).toBe(prop);
  });

  it("nulls the model verdict chain including the model-relative backtestResult", () => {
    const out = applyMlbMarketGatesToHrProp(prop, { ...ALL, hr_props: false });
    expect(out.modelPHr).toBeNull();
    expect(out.edgeOver).toBeNull();
    expect(out.verdict).toBeNull();
    // HR backtestResult is WIN/LOSS vs the MODEL's verdict — it re-identifies
    // the pick list, unlike the K-prop one.
    expect(out.backtestResult).toBeNull();
    // commodity box-score fact survives
    expect(out.actualHr).toBe(1);
    expect(out.bookOverOdds).toBe(250);
  });
});
