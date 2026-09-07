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
  it("shows the Book threshold in both columns and keeps the projection separate", () => {
    const input = {
      ...uclaRow,
      awayTeam: "LOU",
      homeTeam: "MISS",
      awayBookSpread: "6.5",
      homeBookSpread: "-6.5",
      bookTotal: "55.5",
      awayModelSpread: "3.9",
      homeModelSpread: "-3.9",
      modelTotal: "51.9",
      modelAwaySpreadOdds: null,
      modelHomeSpreadOdds: null,
      modelOverOdds: null,
      modelUnderOdds: null,
      modelPriceBasis: undefined,
      modelBookPrices: undefined,
    };
    const before = structuredClone(input);
    const card = ncaafRowToCard(input as never);
    const game = presentationToProjectionGame(sportAdapters.NCAAF(card));
    expect(card.venueLine).toBe("Model: Mississippi -3.9 · Total 51.9");
    for (const [index, lines] of [
      [0, ["+6.5", "-6.5"]],
      [1, ["55.5", "55.5"]],
    ] as const) {
      const $ = load(
        renderToStaticMarkup(
          createElement(MarketTable, { market: game.markets[index] })
        )
      );
      $("tbody tr").each((i, tr) => {
        expect($(tr).find("td").eq(0).find(".market-table__line").text()).toBe(
          lines[i]
        );
        expect($(tr).find("td").eq(1).find(".market-table__line").text()).toBe(
          lines[i]
        );
        expect($(tr).find("td").eq(1).find(".market-table__price").text()).toBe(
          "(—)"
        );
      });
      expect($("tfoot").text()).toBe("Comparison unavailable");
    }
    expect(input).toEqual(before);
    const priced = presentationToProjectionGame(
      sportAdapters.NCAAF(ncaafRowToCard(uclaRow as never))
    );
    const $ = load(
      renderToStaticMarkup(
        createElement(MarketTable, { market: priced.markets[0] })
      )
    );
    expect($("tbody tr").first().find("td").eq(1).text()).toBe("-2.5(-153)");
  });

  it("preserves the current Book and original model prices while retaining each model threshold", () => {
    const { card, model, game } = adapted();
    expect(card.venueLine).toBe("Model: James Madison -5.123 · Total 49.456");
    expect(
      card.markets[0].rows.map(side => [
        side.label,
        side.book,
        side.model,
        side.modelLineLabel,
        side.comparable,
      ])
    ).toEqual([
      ["Liberty +8.5", "-110", "-220", "+6.5", false],
      ["James Madison -8.5", "-110", "+220", "-6.5", false],
    ]);
    expect(game.markets[0].sides.map(side => side.lineDisplay)).toEqual([
      { side: "Liberty", book: "+8.5", model: "+5.123", priceAt: "+6.5" },
      { side: "James Madison", book: "-8.5", model: "-5.123", priceAt: "-6.5" },
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
    expect(game.markets[1].sides.map(side => side.lineDisplay)).toEqual([
      { side: "Over", book: "55.5", model: "49.456", priceAt: "51.5" },
      { side: "Under", book: "55.5", model: "49.456", priceAt: "51.5" },
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

  it("separates school names, Book lines, Model projections and price bases without a false edge", () => {
    const { game } = adapted();
    const $ = load(
      renderToStaticMarkup(
        createElement(MarketTable, { market: game.markets[0] })
      )
    );
    const first = $("tbody tr").first();
    expect(first.find("th").text()).toBe("Liberty");
    expect(first.find("td").eq(0).text()).toBe("+8.5(-110)");
    expect(first.find("td").eq(1).text()).toBe(
      "+8.5(—)Pricing unavailable at this line"
    );
    expect(first.find("td").eq(1).find(".market-table__line").text()).toBe(
      "+8.5"
    );
    expect(first.find("td").eq(1).find(".market-table__basis").text()).toBe(
      "Pricing unavailable at this line"
    );
    expect($(".market-table__row--signal")).toHaveLength(0);
    expect($("tfoot").text()).toBe("Comparison unavailable");
    const summary = renderToStaticMarkup(
      createElement(ProjectionCard, { game })
    );
    expect(summary).not.toContain("Book/model comparison unavailable.");
    expect(summary).toContain("summary--comparison");
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
      expect(
        market.sides.every(
          side => side.lineDisplay?.priceAt === "line unavailable"
        )
      ).toBe(true);
    }
    const $ = load(
      renderToStaticMarkup(createElement(ProjectionCard, { game }))
    );
    expect($(".summary-carousel--comparison").attr("aria-label")).toBe(
      "6 Book and Model comparisons"
    );
    expect($(".summary-carousel__slide").first().attr("aria-label")).toBe(
      "Comparison 1 of 6: Spread: Bryant; Book and Model values"
    );
    expect($(".summary--comparison table")).toHaveLength(0);
    expect($(".summary--comparison .market-table__basis")).toHaveLength(0);
    expect(
      $(".summary--comparison .summary__item--model dd").first().text()
    ).toBe("+5.123");
    expect($(".summary--comparison .edge-indicator")).toHaveLength(0);
    expect($.html()).not.toContain("priced at their shown lines");
    expect($.html()).not.toContain("Book and Model pricing lines");
  });

  it("uses an owner-bound Book display override without changing the original API fields", () => {
    const override = { ...uclaRow };
    const card = ncaafRowToCard(override as never);
    expect(
      card.markets
        .slice(0, 2)
        .flatMap(market => market.rows.map(side => side.book))
    ).toEqual(["-110", "-110", "-110", "-110"]);
    const game = presentationToProjectionGame(sportAdapters.NCAAF(card));
    for (const market of game.markets.slice(0, 2)) {
      const $ = load(
        renderToStaticMarkup(createElement(MarketTable, { market }))
      );
      expect(
        $("tbody tr td:first-of-type .market-table__price")
          .toArray()
          .map(cell => $(cell).text())
      ).toEqual(["(-110)", "(-110)"]);
      expect($("tfoot").text()).toMatch(/^EDGE \+\d+\.\d+%$/);
    }
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
        if (!matches) expect(market.foot.edge).toBe(false);
      }
      const game = presentationToProjectionGame(sportAdapters.NCAAF(card));
      for (const [index, matches] of [spreadMatches, totalMatches].entries()) {
        const $ = load(
          renderToStaticMarkup(
            createElement(MarketTable, { market: game.markets[index] })
          )
        );
        if (!matches) {
          expect($("tfoot").text()).toBe("Comparison unavailable");
          expect($(".market-table__row--signal")).toHaveLength(0);
        } else expect($("tfoot").text()).toMatch(/^EDGE \+\d+\.\d+%$/);
      }
    }
  );

  it("keeps the actual live model projection accessible separately from the model price threshold", () => {
    const { game, card } = adapted({
      awayTeam: "BRY",
      homeTeam: "ARMY",
      gameStatus: "live",
      awayModelSpread: "26.7",
      homeModelSpread: "-26.7",
      modelTotal: "54.4",
      modelPriceBasis: { awaySpread: 37, homeSpread: -37, total: 50.5 },
    });
    const spread = load(
      renderToStaticMarkup(
        createElement(MarketTable, { market: game.markets[0] })
      )
    );
    const total = load(
      renderToStaticMarkup(
        createElement(MarketTable, { market: game.markets[1] })
      )
    );
    expect(spread("tbody tr").first().find("th").text()).toBe("Bryant");
    expect(spread("tbody tr").first().find("td").eq(1).text()).toBe(
      "+8.5(—)Pricing unavailable at this line"
    );
    expect(spread("tbody tr").last().find("td").eq(1).text()).toBe(
      "-8.5(—)Pricing unavailable at this line"
    );
    expect(total("tbody tr").first().find("td").eq(1).text()).toBe(
      "55.5(—)Pricing unavailable at this line"
    );
    expect(spread("tfoot").text()).toBe("Comparison unavailable");
    expect(total("tfoot").text()).toBe("Comparison unavailable");
    expect(card.venueLine).toBe("Model: Army -26.7 · Total 54.4");
    expect(game.markets[0].sides[0].modelLineLabel).toBe("+37");
    expect(game.markets[1].sides[0].modelLineLabel).toBe("O 50.5");
  });

  it("shows BRY–ARMY Book and Model quotes when every supplied pricing line differs", () => {
    const { game } = adapted({
      awayTeam: "BRY",
      homeTeam: "ARMY",
      gameStatus: "live",
      awayBookSpread: "37.5",
      homeBookSpread: "-37.5",
      bookTotal: "51.5",
      awaySpreadOdds: "-108",
      homeSpreadOdds: "-112",
      awayModelSpread: "26.7",
      homeModelSpread: "-26.7",
      modelTotal: "54.4",
      modelAwaySpreadOdds: "-289",
      modelHomeSpreadOdds: "+289",
      modelOverOdds: "-147",
      modelUnderOdds: "+147",
      awayML: null,
      homeML: null,
      modelPriceBasis: { awaySpread: 37, homeSpread: -37, total: 50.5 },
    });
    const $ = load(
      renderToStaticMarkup(createElement(ProjectionCard, { game }))
    );
    const summary = $(".summary--comparison");
    expect(summary.find("table")).toHaveLength(0);
    const slides = $(".summary-carousel--comparison .summary-carousel__slide");
    expect(slides).toHaveLength(4);
    expect(slides.first().find("button").attr("aria-label")).toBe(
      "View next comparison: Spread: Army (2 of 4)"
    );
    expect(slides.last().find("button").attr("aria-label")).toBe(
      "View next comparison: Spread: Bryant (1 of 4)"
    );
    expect(
      slides.toArray().map(slide => $(slide).find("button").attr("tabindex"))
    ).toEqual(["0", "-1", "-1", "-1"]);
    expect(
      slides.toArray().map(slide =>
        $(slide)
          .find("dd")
          .toArray()
          .map(cell => $(cell).text())
      )
    ).toEqual([
      ["Bryant", "+37.5 (-108)", "+26.7"],
      ["Army", "-37.5 (-112)", "-26.7"],
      ["Over", "51.5 (-110)", "54.4"],
      ["Under", "51.5 (-110)", "54.4"],
    ]);
    expect(summary.text()).not.toContain("at +37");
    expect(summary.text()).not.toContain("-289");
    expect(summary.text()).not.toContain("comparison unavailable");
    expect(summary.text()).not.toContain("Moneyline");
    expect(
      summary.find(".edge-indicator, .market-table__row--signal")
    ).toHaveLength(0);
    expect(rankedEdges(game)).toEqual([]);
    expect(rankedNoEdgeCandidates(game)).toEqual([]);
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

  it("populates the summary for owner-supplied lines without inventing fair odds", () => {
    const { game } = adapted({
      awayTeam: "WSU",
      homeTeam: "WASH",
      awayBookSpread: null,
      homeBookSpread: null,
      awaySpreadOdds: null,
      homeSpreadOdds: null,
      bookTotal: "51.5",
      overOdds: "-112",
      underOdds: "-108",
      awayModelSpread: "21.1",
      homeModelSpread: "-21.1",
      modelTotal: "52.1",
      modelAwaySpreadOdds: null,
      modelHomeSpreadOdds: null,
      modelOverOdds: null,
      modelUnderOdds: null,
      modelPriceBasis: undefined,
      awayML: null,
      homeML: null,
    });
    const $ = load(
      renderToStaticMarkup(createElement(ProjectionCard, { game }))
    );
    const slides = $(".summary-carousel__slide");
    expect(
      slides.toArray().map(slide =>
        $(slide)
          .find("dd")
          .toArray()
          .map(cell => $(cell).text())
      )
    ).toEqual([
      ["Washington State", "— (—)", "+21.1"],
      ["Washington", "— (—)", "-21.1"],
      ["Over", "51.5 (-112)", "52.1"],
      ["Under", "51.5 (-108)", "52.1"],
    ]);
    expect($(".edge-indicator")).toHaveLength(0);
    expect($("article").hasClass("projection-card--pass")).toBe(false);
    expect($.text()).not.toContain("Every market is efficiently priced");
  });

  it("keeps Book in the summary when no model has been published", () => {
    const { game } = adapted({ modelRunAt: null });
    const $ = load(
      renderToStaticMarkup(createElement(ProjectionCard, { game }))
    );
    expect($(".summary-carousel__slide")).toHaveLength(6);
    expect(
      $(".summary__item--book dd")
        .toArray()
        .map(cell => $(cell).text())
    ).toEqual([
      "+8.5 (-110)",
      "-8.5 (-110)",
      "55.5 (-110)",
      "55.5 (-110)",
      "+260",
      "-325",
    ]);
    expect(
      $(".summary__item--model dd")
        .toArray()
        .map(cell => $(cell).text())
    ).toEqual(Array(6).fill("—"));
    expect($(".summary__comparison-status").first().text()).toBe(
      "Model unavailable"
    );
    expect($(".edge-indicator")).toHaveLength(0);
    expect($("article").hasClass("projection-card--nomodel")).toBe(true);
  });
});
