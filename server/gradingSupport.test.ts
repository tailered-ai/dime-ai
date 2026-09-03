/**
 * gradingSupport.test.ts — the grader's real coverage, and the guard that keeps
 * the declared matrix honest.
 *
 * The bug this closes: the bet form offered six sports and nine timeframes and
 * checked neither against the other. Combinations with no code path did not
 * fail — they resolved to no game and sat PENDING until the 36-hour stuck
 * alarm. NFL was in that state for every bet ever placed on it.
 *
 * The most important test here is the last one: it reads scoreGrader.ts and
 * asserts every timeframe this table claims is actually built by that sport's
 * fetcher. A table that drifts from the implementation would re-create the
 * original bug while looking like a fix.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SPORT_TIMEFRAMES,
  GRADABLE_SPORTS,
  isGradableSport,
  timeframesForSport,
  checkGradingSupport,
  humanTimeframe,
  type GradableSport,
} from "@shared/gradingSupport";

const graderSrc = readFileSync(join(__dirname, "scoreGrader.ts"), "utf8");

describe("sports with a score feed", () => {
  it("REGRESSION: NFL is gradeable", () => {
    // It was offered by the form and absent from the grader's switch, so every
    // NFL bet logged "Unknown sport" once per cycle and never settled.
    expect(isGradableSport("NFL")).toBe(true);
    expect(graderSrc).toMatch(/case "NFL":\s*data = await fetchNflScores/);
    expect(graderSrc).toMatch(/async function fetchNflScores/);
  });

  it("NCAAF is gradeable through the shared football score shape", () => {
    expect(isGradableSport("NCAAF")).toBe(true);
    expect(graderSrc).toMatch(/case "NCAAF":\s*data = await fetchNcaafScores/);
    expect(graderSrc).toMatch(/fetchNflScores\(date, "NCAAF"\)/);
  });

  it("covers all six feed-backed sports", () => {
    expect(GRADABLE_SPORTS.sort()).toEqual([
      "MLB",
      "NBA",
      "NCAAF",
      "NCAAM",
      "NFL",
      "NHL",
    ]);
  });

  it("CUSTOM is deliberately not gradeable", () => {
    // It is a manual-entry escape hatch with no feed. Saying so explicitly is
    // the difference between a clear refusal and a bet that silently never
    // settles.
    expect(isGradableSport("CUSTOM")).toBe(false);
    expect(timeframesForSport("CUSTOM")).toEqual([]);
    const r = checkGradingSupport("CUSTOM", "FULL_GAME");
    expect(r).toMatchObject({ ok: false, reason: "NO_FEED" });
  });

  it("an unknown sport is refused rather than assumed", () => {
    expect(checkGradingSupport("CRICKET", "FULL_GAME")).toMatchObject({
      ok: false,
      reason: "NO_FEED",
    });
  });
});

describe("timeframe support per sport", () => {
  it("every sport can at least be graded on the full game", () => {
    for (const sport of GRADABLE_SPORTS) {
      expect(SPORT_TIMEFRAMES[sport], sport).toContain("FULL_GAME");
      expect(checkGradingSupport(sport, "FULL_GAME"), sport).toEqual({
        ok: true,
      });
    }
  });

  it("MLB carries the innings timeframes and nothing else", () => {
    expect([...SPORT_TIMEFRAMES.MLB].sort()).toEqual([
      "FIRST_5",
      "FIRST_INNING",
      "FULL_GAME",
      "NRFI",
      "YRFI",
    ]);
  });

  it("REGRESSION: MLB rejects period/quarter timeframes", () => {
    // Previously accepted by the form and ungradeable in fact.
    for (const tf of [
      "FIRST_PERIOD",
      "FIRST_HALF",
      "FIRST_QUARTER",
      "REGULATION",
    ]) {
      expect(checkGradingSupport("MLB", tf), tf).toMatchObject({
        ok: false,
        reason: "TIMEFRAME",
      });
    }
  });

  it("REGRESSION: NBA rejects baseball timeframes", () => {
    for (const tf of ["NRFI", "YRFI", "FIRST_5", "FIRST_INNING"]) {
      expect(checkGradingSupport("NBA", tf), tf).toMatchObject({
        ok: false,
        reason: "TIMEFRAME",
      });
    }
  });

  it("REGRESSION: NCAAM rejects FIRST_QUARTER — college basketball has halves", () => {
    expect(checkGradingSupport("NCAAM", "FIRST_QUARTER")).toMatchObject({
      ok: false,
    });
    expect(checkGradingSupport("NCAAM", "FIRST_HALF")).toEqual({ ok: true });
  });

  it("NHL and NFL both carry REGULATION, because overtime decides ties", () => {
    expect(SPORT_TIMEFRAMES.NHL).toContain("REGULATION");
    expect(SPORT_TIMEFRAMES.NFL).toContain("REGULATION");
  });

  it("NFL carries quarters and halves", () => {
    expect([...SPORT_TIMEFRAMES.NFL].sort()).toEqual([
      "FIRST_HALF",
      "FIRST_QUARTER",
      "FULL_GAME",
      "REGULATION",
    ]);
  });

  it("NCAAF carries the same football periods", () => {
    expect([...SPORT_TIMEFRAMES.NCAAF].sort()).toEqual([
      "FIRST_HALF",
      "FIRST_QUARTER",
      "FULL_GAME",
      "REGULATION",
    ]);
  });

  it("the refusal message names what IS available, not just what is not", () => {
    const r = checkGradingSupport("NCAAM", "FIRST_QUARTER");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/Full Game/);
      expect(r.message).toMatch(/1st Half/);
    }
  });
});

describe("NFL regulation excludes overtime", () => {
  it("sums exactly four quarters", () => {
    // Real game, 2025-11-09 ATL@IND: quarters 7/7/3/8 and 13/0/0/12, then 0
    // and 6 in OT for a 25-31 final. Regulation was 25-25 — a moneyline PUSH
    // where the full game was an IND win. If OT leaked into the regulation
    // sum, that push would settle as a loss.
    const awayQs = [7, 7, 3, 8, 0];
    const homeQs = [13, 0, 0, 12, 6];
    const sum = (qs: number[], from: number, to: number) =>
      qs.slice(from, to).reduce((a, b) => a + (b ?? 0), 0);

    expect(sum(awayQs, 0, 4)).toBe(25);
    expect(sum(homeQs, 0, 4)).toBe(25);
    expect(sum(awayQs, 0, 4)).toBe(sum(homeQs, 0, 4)); // tied in regulation
    expect(sum(homeQs, 0, homeQs.length)).toBe(31); // won in overtime
  });

  it("the fetcher slices four quarters, not all of them", () => {
    const fn = graderSrc.slice(
      graderSrc.indexOf("async function fetchNflScores")
    );
    expect(fn).toMatch(/sum\(awayQs, 0, 4\)/);
    expect(fn).toMatch(/sum\(homeQs, 0, 4\)/);
  });

  it("first half is Q1+Q2 and first quarter is Q1", () => {
    const fn = graderSrc.slice(
      graderSrc.indexOf("async function fetchNflScores")
    );
    expect(fn).toMatch(/sum\(awayQs, 0, 2\)/);
    expect(fn).toMatch(/awayQs\[0\]/);
  });
});

describe("write-time rejection", () => {
  const router = readFileSync(join(__dirname, "routers/betTracker.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("REGRESSION: create refuses an ungradeable combination", () => {
    expect(router).toMatch(
      /checkGradingSupport\(input\.sport, input\.timeframe\)/
    );
  });

  it("REGRESSION: createParlay checks EVERY leg", () => {
    // One ungradeable leg holds the whole ticket open, so this cannot be a
    // spot check.
    expect(router).toMatch(/checkGradingSupport\(leg\.sport, leg\.timeframe\)/);
    expect(router).toMatch(/for \(let i = 0; i < input\.legs\.length; i\+\+\)/);
  });

  it("the parlay check runs before anything is written", () => {
    const proc = router.slice(router.indexOf("createParlay:"));
    const check = proc.indexOf("checkGradingSupport");
    const insert = proc.indexOf("db.insert(trackedBets)");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(insert);
  });
});

describe("the declared matrix matches the grader's implementation", () => {
  /** The `scores: { ... }` map a given fetcher builds. */
  function timeframesBuiltBy(fnName: string): string[] {
    const start = graderSrc.indexOf(`async function ${fnName}`);
    expect(start, `${fnName} exists`).toBeGreaterThan(-1);
    const body = graderSrc.slice(start, graderSrc.indexOf("\n}", start));
    const scores = body.slice(body.indexOf("scores: {"));
    return Array.from(scores.matchAll(/^\s{8}([A-Z_0-9]+):\s*\{/gm)).map(
      m => m[1]
    );
  }

  const FETCHERS: Record<GradableSport, string> = {
    NCAAF: "fetchNflScores",
    MLB: "fetchMlbScores",
    NHL: "fetchNhlScores",
    NBA: "fetchNbaScores",
    NCAAM: "fetchNcaamScores",
    NFL: "fetchNflScores",
  };

  it("REGRESSION: every declared timeframe is one the fetcher actually builds", () => {
    // A table that drifts from the implementation re-creates the original bug
    // while looking like the fix for it.
    for (const [sport, fn] of Object.entries(FETCHERS) as [
      GradableSport,
      string,
    ][]) {
      const built = timeframesBuiltBy(fn);
      for (const tf of SPORT_TIMEFRAMES[sport]) {
        expect(
          built,
          `${sport} declares ${tf}; ${fn} builds [${built.join(", ")}]`
        ).toContain(tf);
      }
    }
  });

  it("and the table does not omit a timeframe the fetcher supports", () => {
    for (const [sport, fn] of Object.entries(FETCHERS) as [
      GradableSport,
      string,
    ][]) {
      const built = timeframesBuiltBy(fn);
      for (const tf of built) {
        expect(
          SPORT_TIMEFRAMES[sport],
          `${fn} builds ${tf}; table omits it`
        ).toContain(tf);
      }
    }
  });
});

describe("humanTimeframe", () => {
  it("names every timeframe the table uses", () => {
    for (const sport of GRADABLE_SPORTS) {
      for (const tf of SPORT_TIMEFRAMES[sport]) {
        expect(humanTimeframe(tf), tf).not.toBe(
          tf === "NRFI" || tf === "YRFI" ? "" : tf
        );
      }
    }
  });

  it("falls back to the raw value rather than throwing", () => {
    expect(humanTimeframe("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});
