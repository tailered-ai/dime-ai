import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import { ncaafRowToCard } from "@/pages/DimeModelFeed";
import { sportAdapters } from "@/lib/sport/presentation";
import { scoreMarketSide } from "@/lib/gameInsight";
import { presentationToProjectionGame } from "./fromPresentation";
import { MarketTable } from "./MarketTable";
import {
  ProjectionCard,
  rankedEdges,
  rankedNoEdgeCandidates,
} from "./ProjectionCard";

const row = {
  id: 1,
  sport: "NCAAF",
  gameDate: "2026-09-05",
  gameStatus: "scheduled",
  startTimeEst: "12:00",
  awayTeam: "LIB",
  homeTeam: "JMU",
  modelRunAt: 1,
  awayBookSpread: "8.5",
  homeBookSpread: "-8.5",
  bookTotal: "55.5",
  awaySpreadOdds: "-110",
  homeSpreadOdds: "-110",
  overOdds: "-110",
  underOdds: "-110",
  awayModelSpread: "5.123",
  homeModelSpread: "-5.123",
  modelTotal: "49.456",
  modelAwaySpreadOdds: "-220",
  modelHomeSpreadOdds: "+220",
  modelOverOdds: "-220",
  modelUnderOdds: "+220",
  awayML: "+260",
  homeML: "-325",
  modelAwayML: null,
  modelHomeML: null,
  modelPriceBasis: { awaySpread: 6.5, homeSpread: -6.5, total: 51.5 },
};
const uclaRow = {
  ...row,
  awayTeam: "UCLA",
  homeTeam: "CAL",
  awayBookSpread: "-2.5",
  homeBookSpread: "2.5",
  bookTotal: "53.5",
  awayModelSpread: "-6.7",
  homeModelSpread: "6.7",
  modelTotal: "50.1",
  modelAwaySpreadOdds: "-153",
  modelHomeSpreadOdds: "+153",
  modelOverOdds: "+140",
  modelUnderOdds: "-140",
  modelPriceBasis: { awaySpread: -2.5, homeSpread: 2.5, total: 53.5 },
  modelBookPrices: {
    awaySpreadOdds: "-110",
    homeSpreadOdds: "-110",
    overOdds: "-110",
    underOdds: "-110",
  },
  awaySpreadOdds: "-112",
  homeSpreadOdds: "-108",
  overOdds: "-112",
  underOdds: "-108",
};
function adapted(overrides: Partial<typeof row> = {}) {
  const card = ncaafRowToCard({ ...row, ...overrides } as never);
  const model = sportAdapters.NCAAF(card);
  return {
    card,
    model,
    game: {
      ...presentationToProjectionGame(model),
      modelPublished: card.modelPublished,
    },
  };
}

describe("NCAAF model odds priced at the supplied attachment lines", () => {
  it("preserves the current Book and original model prices while retaining each model threshold", () => {
    const { card, model, game } = adapted();
    expect(card.venueLine).toBe("Model: JMU -5.123 · Total 49.456");
    expect(
      card.markets[0].rows.map(side => [
        side.label,
        side.book,
        side.model,
        side.modelLineLabel,
        side.comparable,
      ])
    ).toEqual([
      ["LIB +8.5", "-110", "-220", "+6.5", false],
      ["JMU -8.5", "-110", "+220", "-6.5", false],
    ]);
    expect(
      game.markets[1].sides.map(side => [
        side.sideLabel,
        side.bookPrice,
        side.modelPrice,
        side.modelLineLabel,
        side.comparable,
      ])
    ).toEqual([
      ["Over 55.5", -110, -220, "O 51.5", false],
      ["Under 55.5", -110, 220, "U 51.5", false],
    ]);
    expect(card.verdict.pass).toBe(true);
    expect(model.projection.primary).toBeNull();
    expect(model.projection.ranked).toEqual([]);
    expect(rankedEdges(game)).toEqual([]);
    expect(rankedNoEdgeCandidates(game)).toEqual([]);
    expect(game.markets[2].sides.every(side => side.modelPrice === null)).toBe(
      true
    );
  });

  it("shows complete basis lines and odds in Model cells without mint or misleading comparison claims", () => {
    const { game } = adapted();
    const $ = load(
      renderToStaticMarkup(
        createElement(MarketTable, { market: game.markets[0] })
      )
    );
    const first = $("tbody tr").first();
    expect(first.find("th").text()).toBe("LIB +8.5");
    expect(first.find("td").eq(0).text()).toBe("-110");
    expect(first.find("td").eq(1).text()).toBe("+6.5(-220)");
    expect(first.find("td").eq(1).find(".block").text()).toBe("+6.5");
    expect($(".market-table__row--signal")).toHaveLength(0);
    expect($("tfoot").text()).toContain(
      "Book and model lines differ; comparison unavailable."
    );
    const summary = renderToStaticMarkup(
      createElement(ProjectionCard, { game })
    );
    expect(summary).toContain("Book/model comparison unavailable.");
    expect(summary).not.toContain("Every market is efficiently priced");
    expect(summary).not.toContain("projection-card--pass");
  });

  it("continues scoring a matching market independently of another market's changed line", () => {
    const { game, model } = adapted({ bookTotal: "51.5" });
    expect(game.markets[0].sides.every(side => side.comparable === false)).toBe(
      true
    );
    expect(game.markets[1].sides.every(side => side.comparable === true)).toBe(
      true
    );
    expect(rankedEdges(game).map(insight => insight.marketKey)).toEqual([
      "total",
    ]);
    expect(
      model.projection.ranked.every(insight => insight.marketKey === "total")
    ).toBe(true);
    expect(scoreMarketSide(game.markets[0].sides[0])).toBeNull();
    expect(scoreMarketSide(game.markets[1].sides[0])).not.toBeNull();
  });

  it("preserves legacy scoring and labels when no price basis is attached", () => {
    const { game } = adapted({ modelPriceBasis: undefined });
    expect(
      game.markets.every(market =>
        market.sides.every(side => side.modelLineLabel === undefined)
      )
    ).toBe(true);
    expect(
      rankedEdges(game)
        .map(insight => insight.marketKey)
        .sort()
    ).toEqual(["spread", "total"]);
  });

  it("does not compare a recognized import when changed model fields invalidate its pricing line", () => {
    const { game } = adapted({
      awayTeam: "BRY",
      homeTeam: "ARMY",
      awayBookSpread: "38.5",
      homeBookSpread: "-38.5",
      modelAwaySpreadOdds: "-999",
      modelPriceBasis: null,
    });
    expect(rankedEdges(game)).toEqual([]);
    expect(rankedNoEdgeCandidates(game)).toEqual([]);
    for (const market of game.markets.slice(0, 2)) {
      expect(market.sides.every(side => side.comparable === false)).toBe(true);
      expect(
        market.sides.every(side => side.modelLineLabel === undefined)
      ).toBe(true);
      expect(market.note).toBe(
        "Model pricing line unavailable; comparison unavailable."
      );
    }
  });

  it("uses an owner-bound Book display override without changing the original API fields", () => {
    const override = { ...uclaRow };
    const card = ncaafRowToCard(override as never);
    expect(
      card.markets
        .slice(0, 2)
        .flatMap(market => market.rows.map(side => side.book))
    ).toEqual(["-110", "-110", "-110", "-110"]);
    expect(
      card.markets
        .slice(0, 2)
        .every(market =>
          market.note?.includes("Book prices supplied by owner.")
        )
    ).toBe(true);
    expect(override.awaySpreadOdds).toBe("-112");
    expect(override.underOdds).toBe("-108");
  });

  it.each([
    ["-3", "3", "53.5", false, true],
    ["-2.5", "2.5", "54.5", true, false],
    ["-3", "3", "54.5", false, false],
  ] as const)(
    "keeps refreshed API prices when UCLA thresholds move to %s / %s and %s",
    (
      awayBookSpread,
      homeBookSpread,
      bookTotal,
      spreadMatches,
      totalMatches
    ) => {
      const card = ncaafRowToCard({
        ...uclaRow,
        awayBookSpread,
        homeBookSpread,
        bookTotal,
        awaySpreadOdds: "-115",
        homeSpreadOdds: "-105",
        overOdds: "-117",
        underOdds: "-103",
      } as never);
      expect(card.markets[0].rows.map(side => side.book)).toEqual(
        spreadMatches ? ["-110", "-110"] : ["-115", "-105"]
      );
      expect(card.markets[1].rows.map(side => side.book)).toEqual(
        totalMatches ? ["-110", "-110"] : ["-117", "-103"]
      );
      for (const [market, matches] of [
        [card.markets[0], spreadMatches],
        [card.markets[1], totalMatches],
      ] as const) {
        expect(market.rows.every(side => side.comparable === matches)).toBe(
          true
        );
        expect(market.note?.includes("Book prices supplied by owner.")).toBe(
          matches
        );
        if (!matches) expect(market.foot.edge).toBe(false);
      }
    }
  );

  it("keeps the actual live model projection accessible separately from the model price threshold", () => {
    const { game } = adapted({
      awayTeam: "BRY",
      homeTeam: "ARMY",
      gameStatus: "live",
      awayModelSpread: "26.7",
      homeModelSpread: "-26.7",
      modelTotal: "54.4",
      modelPriceBasis: { awaySpread: 37, homeSpread: -37, total: 50.5 },
    });
    const spread = renderToStaticMarkup(
      createElement(MarketTable, { market: game.markets[0] })
    );
    const total = renderToStaticMarkup(
      createElement(MarketTable, { market: game.markets[1] })
    );
    expect(spread).toContain("Model spread: BRY +26.7 / ARMY -26.7.");
    expect(spread).toContain(
      "Model odds apply to the line in the Model column."
    );
    expect(total).toContain("Model total: 54.4.");
    expect(game.markets[0].sides[0].modelLineLabel).toBe("+37");
    expect(game.markets[1].sides[0].modelLineLabel).toBe("O 50.5");
  });

  it("does not expose unpublished model values or threshold labels", () => {
    const { game } = adapted({ modelRunAt: null });
    expect(
      game.markets.every(market =>
        market.sides.every(
          side => side.modelLineLabel === undefined && side.modelPrice === null
        )
      )
    ).toBe(true);
    expect(
      renderToStaticMarkup(createElement(ProjectionCard, { game }))
    ).toContain("No model projection published for this game.");
  });
});
