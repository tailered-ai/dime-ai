import { describe, expect, it } from "vitest";
import {
  DATE,
  SOURCES,
  ncaafSeptember5Record,
  ncaafSeptember5HistoryRecord,
  presentNcaafSeptember5,
  presentNcaafSeptember5History,
} from "./ncaafSeptember5";
import teams from "./ncaafFeedTeams.json" with { type: "json" };

const rowFor = (game: (typeof SOURCES)[number]) => ({
  id: Number(game.event),
  sport: "NCAAF",
  gameDate: DATE,
  awayTeam: game.away,
  homeTeam: game.home,
  ...ncaafSeptember5Record(game),
});

describe("September 5 owner model and sportsbook provenance", () => {
  it("uses the owner's corrected UCLA favorite and prices at the supplied Book thresholds", () => {
    const game = SOURCES.find(game => game.event === "287970")!;
    expect(game.model).toEqual({
      awaySpread: -6.7,
      homeSpread: 6.7,
      total: 50.1,
      awaySpreadOdds: "-153",
      homeSpreadOdds: "+153",
      overOdds: "+140",
      underOdds: "-140",
      awayML: null,
      homeML: null,
      basis: { awaySpread: -2.5, homeSpread: 2.5, total: 53.5 },
      bookPrices: {
        awaySpreadOdds: "-110",
        homeSpreadOdds: "-110",
        overOdds: "-110",
        underOdds: "-110",
      },
    });
    const row = rowFor(game);
    expect(row.awayModelSpread).toBe("-6.7");
    expect(row.homeModelSpread).toBe("6.7");
    expect(row.modelTotal).toBe("50.1");
    expect(presentNcaafSeptember5(row).modelPriceBasis).toEqual(
      game.model.basis
    );
    const dto = presentNcaafSeptember5(row);
    expect(dto.modelBookPrices).toEqual(game.model.bookPrices);
    expect(dto.awaySpreadOdds).toBe("-112");
    expect(dto.homeSpreadOdds).toBe("-108");
    expect(dto.overOdds).toBe("-112");
    expect(dto.underOdds).toBe("-108");
    expect(dto.awayML).toBe("-135");
    expect(dto.homeML).toBe("+114");
    expect(
      presentNcaafSeptember5({ ...row, modelOverOdds: "+999" }).modelBookPrices
    ).toBeNull();
    for (const other of SOURCES.filter(g => g.event !== "287970"))
      expect(presentNcaafSeptember5(rowFor(other)).modelBookPrices).toBeNull();
  });

  it("joins exactly 68 distinct events, 136 ESPN teams and 1,885 source observations", () => {
    expect(SOURCES).toHaveLength(68);
    expect(new Set(SOURCES.map(game => game.event)).size).toBe(68);
    expect(Object.keys(teams)).toHaveLength(136);
    expect(SOURCES.reduce((n, game) => n + game.history.length, 0)).toBe(1885);
    for (const game of SOURCES) {
      expect(teams).toHaveProperty(game.away);
      expect(teams).toHaveProperty(game.home);
      const record = ncaafSeptember5Record(game);
      expect(Number(record.awayModelSpread)).toBe(
        -Number(record.homeModelSpread)
      );
      expect(Number(record.modelTotal)).toBeGreaterThan(0);
      expect(record.modelAwayML).toBeNull();
      expect(record.modelHomeML).toBeNull();
      expect(record.modelAwayScore).toBeNull();
      expect(record.modelHomeScore).toBeNull();
      expect(record.provider_observed_at).toBeNull();
      expect(record.source_updated_at).toBeNull();
      expect(presentNcaafSeptember5(rowFor(game)).modelPriceBasis).toEqual(
        game.model.basis
      );
      expect(game.history.filter(q => q.provider === "an")).toHaveLength(1);
    }
  });

  it("preserves all Book fields and model thresholds across an independent Book refresh", () => {
    const game = SOURCES[0];
    const original = rowFor(game);
    const refreshed = {
      ...original,
      awayBookSpread: "48.5",
      homeBookSpread: "-48.5",
      awaySpreadOdds: "+101",
      oddsSource: "dk",
      ingestion_pipeline_revision: "book-refresh",
    };
    const dto = presentNcaafSeptember5(refreshed);
    expect(dto.modelPriceBasis).toEqual(game.model.basis);
    for (const key of [
      "awayBookSpread",
      "homeBookSpread",
      "bookTotal",
      "awayML",
      "homeML",
      "awaySpreadOdds",
      "homeSpreadOdds",
      "overOdds",
      "underOdds",
    ] as const)
      expect(dto[key]).toBe(refreshed[key]);
    expect(dto.bettingSplitsSnapshot).not.toHaveProperty("awayBookSpread");
    expect(dto.bettingSplitsSnapshot).not.toHaveProperty("bookTotal");
  });

  it("refuses stale model or split provenance and does not reconstruct stripped model data", () => {
    const row = rowFor(SOURCES[0]);
    expect(
      presentNcaafSeptember5({ ...row, modelAwaySpreadOdds: "-999" })
        .modelPriceBasis
    ).toBeNull();
    const stripped = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        key.startsWith("model") || key.includes("Model") ? null : value,
      ])
    );
    expect(presentNcaafSeptember5(stripped).modelPriceBasis).toBeNull();
    expect(
      presentNcaafSeptember5({ ...row, spreadAwayBetsPct: 999 })
        .bettingSplitsSnapshot
    ).toBeNull();
    const otherDate = {
      ...row,
      gameDate: "2026-09-04",
      bettingSplitsSnapshot: { sourceLabel: "prior snapshot" },
    };
    expect(presentNcaafSeptember5(otherDate)).toBe(otherDate);
    expect(
      presentNcaafSeptember5({ ...row, homeTeam: "OTHER" }).modelPriceBasis
    ).toBeUndefined();
  });

  it("binds history to its parent and preserves independently rounded 101% source pairs", () => {
    const game = SOURCES.find(g =>
      g.history.some(
        q =>
          q.spreadAwayBetsPct != null &&
          q.oppositeSplits.spreadHomeBetsPct != null &&
          q.spreadAwayBetsPct + q.oppositeSplits.spreadHomeBetsPct === 101
      )
    )!;
    const quote = game.history.find(
      q =>
        q.spreadAwayBetsPct != null &&
        q.oppositeSplits.spreadHomeBetsPct != null &&
        q.spreadAwayBetsPct + q.oppositeSplits.spreadHomeBetsPct === 101
    )!;
    const parent = rowFor(game);
    const row = { gameId: parent.id, ...ncaafSeptember5HistoryRecord(quote) };
    expect(Object.keys(ncaafSeptember5HistoryRecord(quote))).toHaveLength(19);
    const dto = presentNcaafSeptember5History(row, parent);
    expect(dto.sourceLabel).toBe("VSiN DK");
    expect(Number(dto.spreadAwayBetsPct) + Number(dto.spreadHomeBetsPct)).toBe(
      101
    );
    expect(dto.spreadHomeBetsPct).toBe(quote.oppositeSplits.spreadHomeBetsPct);
    expect(presentNcaafSeptember5History(row)).toBe(row);
    expect(
      presentNcaafSeptember5History(row, { ...parent, ncaaContestId: "other" })
    ).toBe(row);
    expect(
      presentNcaafSeptember5History({ ...row, awaySpread: "999" }, parent)
        .sourceLabel
    ).toBeUndefined();
    const api = game.history.find(q => q.provider === "an")!;
    const apiDto = presentNcaafSeptember5History(
      { gameId: parent.id, ...ncaafSeptember5HistoryRecord(api) },
      parent
    );
    expect(apiDto.sourceLabel).toBe("AN DK");
    expect(apiDto.sourceNote).toContain("capture time");
    expect(apiDto.spreadAwayBetsPct).toBeNull();
    expect(apiDto.spreadHomeBetsPct).toBeNull();
  });
});
