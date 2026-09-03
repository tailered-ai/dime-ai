import { describe, expect, it } from "vitest";
import {
  SPLITS_LEAGUES,
  inSeasonLeagues,
  isLeagueInSeason,
  resolveInSeasonSport,
} from "./leagueSeasons";

describe("leagueSeasons", () => {
  it("offers only MLB in midsummer (NBA/NHL off-season)", () => {
    expect(inSeasonLeagues("2026-07-12")).toEqual(["MLB"]);
    expect(isLeagueInSeason("NHL", "2026-07-12")).toBe(false);
    expect(isLeagueInSeason("NBA", "2026-07-12")).toBe(false);
  });

  it("offers NCAAF, NHL, and NBA through the winter, without MLB", () => {
    expect(inSeasonLeagues("2026-01-15")).toEqual(["NCAAF", "NHL", "NBA"]);
    expect(inSeasonLeagues("2025-12-25")).toEqual(["NCAAF", "NHL", "NBA"]);
  });

  it("overlaps all four leagues in late October (World Series window)", () => {
    expect(inSeasonLeagues("2026-10-20")).toEqual([
      "NCAAF",
      "MLB",
      "NHL",
      "NBA",
    ]);
  });

  it("handles the wrap boundaries of winter leagues inclusively", () => {
    expect(isLeagueInSeason("NHL", "2026-10-01")).toBe(true);
    expect(isLeagueInSeason("NHL", "2026-06-30")).toBe(true);
    expect(isLeagueInSeason("NHL", "2026-07-01")).toBe(false);
    expect(isLeagueInSeason("NBA", "2026-10-15")).toBe(true);
    expect(isLeagueInSeason("NBA", "2026-10-14")).toBe(false);
  });

  it("handles MLB season boundaries inclusively", () => {
    expect(isLeagueInSeason("MLB", "2026-03-15")).toBe(true);
    expect(isLeagueInSeason("MLB", "2026-03-14")).toBe(false);
    expect(isLeagueInSeason("MLB", "2026-11-10")).toBe(true);
    expect(isLeagueInSeason("MLB", "2026-11-11")).toBe(false);
  });

  it("handles the wrap boundaries of the NCAAF season inclusively", () => {
    expect(isLeagueInSeason("NCAAF", "2026-08-15")).toBe(true);
    expect(isLeagueInSeason("NCAAF", "2026-08-14")).toBe(false);
    expect(isLeagueInSeason("NCAAF", "2027-01-31")).toBe(true);
    expect(isLeagueInSeason("NCAAF", "2027-02-01")).toBe(false);
  });

  it("resolves an out-of-season deep link to the first in-season league", () => {
    expect(resolveInSeasonSport("NBA", "2026-07-12")).toBe("MLB");
    expect(resolveInSeasonSport("MLB", "2026-01-15")).toBe("NCAAF");
    expect(resolveInSeasonSport("MLB", "2026-07-12")).toBe("MLB");
  });

  it("fails open on malformed dates — never blanks the league row", () => {
    expect(inSeasonLeagues("not-a-date")).toEqual([...SPLITS_LEAGUES]);
    expect(isLeagueInSeason("NHL", "")).toBe(true);
    expect(resolveInSeasonSport("NBA", "garbage")).toBe("NBA");
  });
});
