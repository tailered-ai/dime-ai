import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  publication,
  SLATE,
  target,
  washingtonOwnerModel,
  louisvilleOwnerModel,
  wisconsinOwnerModel,
} from "./publishNcaafSeptember6.mts";
import { ncaafHelmet } from "../shared/ncaafHelmets";

function fixture() {
  const games = SLATE.map(g => ({
    id: g.event,
    away_team_id: g.awayId,
    home_team_id: g.homeId,
    start_time: g.utc,
    teams: [{ id: g.awayId }, { id: g.homeId }],
    status: "scheduled",
    markets: {
      "68": {
        event: {
          total: [
            {
              side: "over",
              value: 51.5,
              odds: -112,
              book_id: 68,
              event_id: g.event,
              period: "event",
            },
            {
              side: "under",
              value: 51.5,
              odds: -108,
              book_id: 68,
              event_id: g.event,
              period: "event",
            },
          ],
        },
      },
    },
  }));
  const splits = SLATE.map(g => ({
    gameId: g.vsin,
    sport: "CFB" as const,
    awayVsinSlug: g.awaySlug,
    homeVsinSlug: g.homeSlug,
    awayName: g.away,
    homeName: g.home,
    spreadAwayMoneyPct: 0,
    spreadAwayBetsPct: 100,
    totalOverMoneyPct: 50,
    totalOverBetsPct: 40,
    mlAwayMoneyPct: null,
    mlAwayBetsPct: null,
  }));
  return { an: { league: { name: "ncaaf" }, games }, splits };
}
describe("bounded September 6 backend publication", () => {
  it("publishes Wisconsin prices at 21 while retaining the independent 22.7 projection and replay identity", () => {
    const row = {
      id: 4350070,
      ncaaContestId: "287973",
      awayTeam: "WIS",
      homeTeam: "ND",
      gameDate: "2026-09-06",
      sport: "NCAAF",
      publishedToFeed: 1,
      publishedModel: 0,
      awayModelSpread: null,
      homeModelSpread: null,
      modelTotal: null,
      modelRunAt: null,
      modelAwaySpreadOdds: null,
      modelHomeSpreadOdds: null,
      modelOverOdds: null,
      modelUnderOdds: null,
      modelAwayML: null,
      modelHomeML: null,
      awayBookSpread: "21.0",
      homeBookSpread: "-21.0",
      bookTotal: "46.5",
    };
    const before = structuredClone(row);
    const fields = wisconsinOwnerModel([row], 1788746000000);
    expect(fields).toEqual({
      awayModelSpread: "22.7",
      homeModelSpread: "-22.7",
      modelAwaySpreadOdds: "+125",
      modelHomeSpreadOdds: "-125",
      modelOverOdds: "+106",
      modelUnderOdds: "-106",
      modelAwayML: "+1010",
      modelHomeML: "-1010",
      publishedModel: 1,
      modelRunAt: 1788746000000,
    });
    expect(row).toEqual(before);
    expect(wisconsinOwnerModel([{ ...row, ...fields }], 1788746100000)).toEqual(
      fields
    );
    for (const change of [
      { id: 4350071 },
      { ncaaContestId: "287972" },
      { gameDate: "2026-09-05" },
      { modelHomeSpreadOdds: "-110" },
      { modelTotal: "46.6" },
    ])
      expect(() =>
        wisconsinOwnerModel([{ ...row, ...change }], 1788746000000)
      ).toThrow();
    expect(() => wisconsinOwnerModel([row, row], 1788746000000)).toThrow();
  });
  it("publishes Louisville fair lines and moneylines only, with exact identity and replay guards", () => {
    const row = {
      id: 4350071,
      ncaaContestId: "287972",
      awayTeam: "LOU",
      homeTeam: "MISS",
      gameDate: "2026-09-06",
      sport: "NCAAF",
      publishedToFeed: 1,
      publishedModel: 0,
      awayModelSpread: null,
      homeModelSpread: null,
      modelTotal: null,
      modelRunAt: null,
      modelAwaySpreadOdds: null,
      modelHomeSpreadOdds: null,
      modelOverOdds: null,
      modelUnderOdds: null,
      modelAwayML: null,
      modelHomeML: null,
      awayBookSpread: "6.5",
      homeBookSpread: "-6.5",
      bookTotal: "55.5",
      awayML: "+210",
      homeML: "-258",
    };
    const before = structuredClone(row);
    const fields = louisvilleOwnerModel([row], 1788739000000);
    expect(fields).toEqual({
      awayModelSpread: "3.9",
      homeModelSpread: "-3.9",
      modelTotal: "51.9",
      modelAwayML: "+172",
      modelHomeML: "-172",
      publishedModel: 1,
      modelRunAt: 1788739000000,
    });
    expect(row).toEqual(before);
    expect(
      louisvilleOwnerModel([{ ...row, ...fields }], 1788739100000)
    ).toEqual(fields);
    for (const change of [
      { id: 4350070 },
      { ncaaContestId: "287973" },
      { homeTeam: "ND" },
      { gameDate: "2026-09-07" },
      { modelHomeML: "-180" },
      { modelOverOdds: "-110" },
      { publishedToFeed: 0 },
    ])
      expect(() =>
        louisvilleOwnerModel([{ ...row, ...change }], 1788739000000)
      ).toThrow();
    expect(() => louisvilleOwnerModel([row, row], 1788739000000)).toThrow();
    expect(
      Object.keys(fields).some(key => /book|bets|money|edge|diff/i.test(key))
    ).toBe(false);
  });
  it("publishes only the owner's Washington thresholds, rejects stale targets and permits exact replay", () => {
    const row = {
      id: 4350069,
      ncaaContestId: "288813",
      awayTeam: "WSU",
      homeTeam: "WASH",
      gameDate: "2026-09-06",
      sport: "NCAAF",
      publishedToFeed: 1,
      publishedModel: 0,
      awayModelSpread: null,
      homeModelSpread: null,
      modelTotal: null,
      modelRunAt: null,
      modelAwaySpreadOdds: null,
      modelHomeSpreadOdds: null,
      modelOverOdds: null,
      modelUnderOdds: null,
      modelAwayML: null,
      modelHomeML: null,
    };
    const result = washingtonOwnerModel([row], 1788721800000);
    expect(result).toEqual({
      awayModelSpread: "21.1",
      homeModelSpread: "-21.1",
      modelTotal: "52.1",
      publishedModel: 1,
      modelRunAt: 1788721800000,
    });
    expect(
      washingtonOwnerModel([{ ...row, ...result }], 1788721900000)
    ).toEqual(result);
    for (const change of [
      { id: 4350070 },
      { homeTeam: "ND" },
      { gameDate: "2026-09-05" },
      { modelTotal: "53.0" },
      { modelOverOdds: "-110" },
    ])
      expect(() =>
        washingtonOwnerModel([{ ...row, ...change }], 1788721800000)
      ).toThrow();
    expect(() => washingtonOwnerModel([row, row], 1788721800000)).toThrow();
    expect(
      Object.keys(result).some(key =>
        /book|bets|money|edge|diff|Odds|ML/.test(key)
      )
    ).toBe(false);
  });
  it("keeps missing AN prices unavailable, VSiN zero values and model fields untouched", () => {
    const { an, splits } = fixture();
    const rows = publication(an, splits);
    expect(rows.map(r => r.fields.startTimeEst)).toEqual([
      "16:00",
      "19:30",
      "19:30",
    ]);
    for (const { fields, lifecycle } of rows) {
      expect(fields.awayBookSpread).toBeNull();
      expect(fields.awayML).toBeNull();
      expect(fields.bookTotal).toBe("51.5");
      expect(fields.spreadAwayMoneyPct).toBe(0);
      expect(Object.keys(fields).some(k => /model|edge|diff/i.test(k))).toBe(
        false
      );
      expect(lifecycle.gameStatus).toBe("upcoming");
    }
  });
  it("rejects wrong dates, reversed identities, duplicate events and foreign bookmakers", () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => {
        f.an.games[0].start_time = "2026-09-05T20:00:00Z" as never;
      },
      (f: ReturnType<typeof fixture>) => {
        f.an.games[0].away_team_id = 360 as never;
      },
      (f: ReturnType<typeof fixture>) => {
        f.an.games.push(f.an.games[0]);
      },
      (f: ReturnType<typeof fixture>) => {
        f.an.games[0].markets["68"].event.total[0].book_id = 30;
      },
      (f: ReturnType<typeof fixture>) => {
        f.splits[0].homeVsinSlug = "wrong" as never;
      },
      (f: ReturnType<typeof fixture>) => {
        f.splits[0].spreadAwayBetsPct = 101;
      },
    ]) {
      const f = fixture();
      change(f);
      expect(() => publication(f.an, f.splits)).toThrow();
    }
  });
  it("rejects existing destination collisions without guessing a target", () => {
    const g = SLATE[0],
      row = {
        ncaaContestId: String(g.event),
        awayTeam: g.away,
        homeTeam: g.home,
        gameDate: "2026-09-06",
        sport: "NCAAF",
      };
    expect(target([row], g)).toEqual(row);
    expect(() => target([row, row], g)).toThrow();
    expect(() => target([{ ...row, gameDate: "2026-09-04" }], g)).toThrow();
    expect(() => target([{ ...row, ncaaContestId: "different" }], g)).toThrow();
  });
  it("maps all six teams to distinct generated RGBA helmet PNGs", () => {
    const hashes = new Set();
    for (const team of SLATE.flatMap(g => [g.away, g.home])) {
      const asset = ncaafHelmet(team)!;
      expect(asset).toMatch(/\/sept6-.*\.png$/);
      const data = readFileSync(
        new URL(`../client/public${asset}`, import.meta.url)
      );
      expect(data.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(data[25]).toBe(6);
      expect(data.readUInt32BE(16) / data.readUInt32BE(20)).toBeCloseTo(
        4 / 3,
        2
      );
      hashes.add(createHash("sha256").update(data).digest("hex"));
    }
    expect(hashes.size).toBe(6);
  });
});
