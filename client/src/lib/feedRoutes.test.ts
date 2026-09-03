import { describe, it, expect } from "vitest";
import {
  toFeedSlugDate,
  feedModelPath,
  bettingSplitsPath,
  canonicalBettingSplitsPath,
  parseBettingSplitsPath,
  parseSplitsSport,
  legacyFeedRedirectTarget,
} from "./feedRoutes";

const SLUG_RE = /^\/feed\/model\/(mlb|wc|ncaaf)-\d{2}-\d{2}-\d{4}$/;
const SPLITS_SLUG_RE = /^\/betting-splits\/(mlb|nhl|nba)-\d{2}-\d{2}-\d{4}$/;

describe("feedRoutes — canonical path builders", () => {
  it("toFeedSlugDate converts YYYY-MM-DD to MM-DD-YYYY", () => {
    expect(toFeedSlugDate("2026-07-11")).toBe("07-11-2026");
    expect(toFeedSlugDate("2026-01-02")).toBe("01-02-2026");
  });

  it("feedModelPath builds dated lowercase slugs", () => {
    expect(feedModelPath("MLB", "2026-07-11")).toBe(
      "/feed/model/mlb-07-11-2026"
    );
    expect(feedModelPath("WC", "2026-07-11")).toBe("/feed/model/wc-07-11-2026");
    expect(feedModelPath("NCAAF", "2026-09-03")).toBe(
      "/feed/model/ncaaf-09-03-2026"
    );
  });

  it("feedModelPath defaults to MLB + today's effective date", () => {
    expect(feedModelPath()).toMatch(SLUG_RE);
    expect(feedModelPath()).toContain("/feed/model/mlb-");
    expect(feedModelPath("WC")).toContain("/feed/model/wc-");
  });

  it("bettingSplitsPath mirrors the feed's lowercase MM-DD-YYYY slug", () => {
    expect(bettingSplitsPath("MLB", "2026-07-11")).toBe(
      "/betting-splits/mlb-07-11-2026"
    );
    expect(bettingSplitsPath("NHL", "2026-01-02")).toBe(
      "/betting-splits/nhl-01-02-2026"
    );
    expect(bettingSplitsPath("NBA", "2026-12-31")).toBe(
      "/betting-splits/nba-12-31-2026"
    );
  });

  it("bettingSplitsPath defaults to MLB + today's effective date", () => {
    expect(bettingSplitsPath()).toMatch(SPLITS_SLUG_RE);
    expect(bettingSplitsPath()).toContain("/betting-splits/mlb-");
    expect(bettingSplitsPath("NHL")).toContain("/betting-splits/nhl-");
  });

  it("parseSplitsSport validates case-insensitively and rejects junk", () => {
    expect(parseSplitsSport("MLB")).toBe("MLB");
    expect(parseSplitsSport("mlb")).toBe("MLB");
    expect(parseSplitsSport("nhl")).toBe("NHL");
    expect(parseSplitsSport("WC")).toBeNull();
    expect(parseSplitsSport("")).toBeNull();
    expect(parseSplitsSport(undefined)).toBeNull();
  });

  it("parseBettingSplitsPath accepts combined dated slugs and returns ISO", () => {
    expect(parseBettingSplitsPath("mlb-07-11-2026")).toEqual({
      sport: "MLB",
      isoDate: "2026-07-11",
    });
    expect(parseBettingSplitsPath("NHL-01-02-2026")).toEqual({
      sport: "NHL",
      isoDate: "2026-01-02",
    });
    expect(parseBettingSplitsPath("nba-12-31-2026")).toEqual({
      sport: "NBA",
      isoDate: "2026-12-31",
    });
  });

  it("parseBettingSplitsPath accepts split and bare legacy forms", () => {
    expect(parseBettingSplitsPath("mlb", "07-11-2026")).toEqual({
      sport: "MLB",
      isoDate: "2026-07-11",
    });
    expect(parseBettingSplitsPath("MLB")).toEqual({
      sport: "MLB",
      isoDate: null,
    });
    expect(parseBettingSplitsPath("nhl")).toEqual({
      sport: "NHL",
      isoDate: null,
    });
  });

  it("parseBettingSplitsPath rejects invalid sports, formats, and calendar dates", () => {
    for (const [sport, date] of [
      ["wc-07-11-2026", undefined],
      ["", undefined],
      [undefined, undefined],
      ["mlb-7-11-2026", undefined],
      ["mlb", "2026-07-11"],
      ["mlb-13-11-2026", undefined],
      ["mlb-02-30-2026", undefined],
      ["mlb", "04-31-2026"],
    ] as const) {
      expect(parseBettingSplitsPath(sport, date)).toBeNull();
    }
  });

  it("converges every required splits input to one stable dated URL in at most two hops", () => {
    const todayMlb = bettingSplitsPath("MLB");
    const cases = [
      ["/betting-splits/MLB", "MLB", undefined, todayMlb],
      ["/betting-splits/mlb", "mlb", undefined, todayMlb],
      [
        "/betting-splits/MLB/07-11-2026",
        "MLB",
        "07-11-2026",
        "/betting-splits/mlb-07-11-2026",
      ],
      ["/betting-splits/MLB/2026-07-11", "MLB", "2026-07-11", todayMlb],
      ["/betting-splits/MLB/garbage", "MLB", "garbage", todayMlb],
      ["/betting-splits/XYZ", "XYZ", undefined, todayMlb],
    ] as const;

    for (const owner of ["standalone", ">=768 shell"] as const) {
      for (const [input, sport, date, expected] of cases) {
        const firstHop = canonicalBettingSplitsPath(sport, date);
        const canonicalSlug = firstHop.split("/").pop();
        const secondHop = canonicalBettingSplitsPath(canonicalSlug);

        expect(firstHop, `${owner}: ${input}`).toBe(expected);
        expect(firstHop, `${owner}: ${input} must be dated`).toMatch(
          SPLITS_SLUG_RE
        );
        expect(secondHop, `${owner}: ${input} must stabilize`).toBe(firstHop);
      }
    }
  });
});

describe("feedRoutes — legacy /feed?… eradication mapping", () => {
  it("?tab=splits routes to the canonical splits page", () => {
    expect(legacyFeedRedirectTarget("?tab=splits")).toMatch(SPLITS_SLUG_RE);
    expect(legacyFeedRedirectTarget("?tab=splits&date=2026-07-11")).toBe(
      "/betting-splits/mlb-07-11-2026"
    );
  });

  it("every other legacy tab lands on the canonical feed", () => {
    for (const q of [
      "",
      "?tab=dual",
      "?tab=lineups",
      "?tab=props",
      "?tab=f5nrfi",
      "?tab=hrprops",
    ]) {
      expect(legacyFeedRedirectTarget(q)).toMatch(SLUG_RE);
      expect(legacyFeedRedirectTarget(q)).toContain("mlb-");
    }
  });

  it("legacy ?sport=WC is preserved; unknown sports fall back to MLB", () => {
    expect(legacyFeedRedirectTarget("?sport=WC")).toContain("/feed/model/wc-");
    expect(legacyFeedRedirectTarget("?sport=NHL")).toContain(
      "/feed/model/mlb-"
    );
  });

  it("legacy ?date=YYYY-MM-DD carries into the slug; invalid dates ignored", () => {
    expect(legacyFeedRedirectTarget("?sport=MLB&date=2026-07-04")).toBe(
      "/feed/model/mlb-07-04-2026"
    );
    expect(legacyFeedRedirectTarget("?date=07/04/2026")).toMatch(SLUG_RE);
    expect(legacyFeedRedirectTarget("?date=2026-02-30")).toMatch(SLUG_RE);
    expect(legacyFeedRedirectTarget("?tab=splits&date=2026-02-30")).toMatch(
      SPLITS_SLUG_RE
    );
  });

  it("never emits a legacy slug", () => {
    for (const q of [
      "",
      "?tab=splits",
      "?tab=dual",
      "?sport=WC",
      "?tab=lineups&sport=NBA",
    ]) {
      const target = legacyFeedRedirectTarget(q);
      expect(target).not.toContain("?");
      expect(
        target.startsWith("/feed/model/") ||
          target.startsWith("/betting-splits/")
      ).toBe(true);
    }
  });
});
