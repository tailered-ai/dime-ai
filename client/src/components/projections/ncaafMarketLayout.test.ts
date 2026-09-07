import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import { MarketTable } from "./MarketTable";
import { ProjectionSummary } from "./ProjectionSummary";
import { rankedEdges } from "./ProjectionCard";
import { SummaryCarousel } from "./SummaryCarousel";
import type { ProjectionGame } from "./types";
import type { ProjectionMarket } from "./types";

const market = (
  bookPrice: number | null,
  modelPrice: number | null,
  comparable = true
): ProjectionMarket => ({
  key: "spread",
  label: "Spread",
  note: "Retired footer explanation",
  resultLabel: "OLD EDGE +99%",
  resultIsEdge: true,
  sides: [
    {
      marketKey: "spread",
      marketLabel: "Spread",
      sideLabel: "Miami (Ohio) +16.5",
      bookPrice,
      modelPrice,
      comparable,
      modelLineLabel: "+16",
      lineDisplay: {
        side: "Miami (Ohio)",
        book: "+16.5",
        model: "+20.9",
        priceAt: "+16",
      },
    },
  ],
});
const render = (value: ProjectionMarket) =>
  load(renderToStaticMarkup(createElement(MarketTable, { market: value })));

describe("NCAAF Book and projection columns", () => {
  it("compares the same Book line and withholds a price from another basis", () => {
    const $ = render(market(-105, 165, false));
    expect($("tbody th").text()).toBe("Miami (Ohio)");
    expect($("tbody td").eq(0).find(".market-table__line").text()).toBe(
      "+16.5"
    );
    expect($("tbody td").eq(0).find(".market-table__price").text()).toBe(
      "(-105)"
    );
    expect($("tbody td").eq(1).find(".market-table__line").text()).toBe(
      "+16.5"
    );
    expect($("tbody td").eq(1).find(".market-table__price").text()).toBe("(—)");
    expect($("tbody td").eq(1).find(".market-table__basis").text()).toBe(
      "Fair projection: +20.9Pricing unavailable at this line · Model at +16: +165"
    );
    expect($("tfoot").text()).toBe("Comparison unavailable");
  });
  it.each([
    [-110, -111, true, "EDGE +0.2%"],
    [-100, -100.1, true, "EDGE <0.1%"],
    [-110, -110, true, "NO EDGE"],
    [-115, -110, true, "NO EDGE"],
    [-110, -300, false, "Comparison unavailable"],
    [null, -300, true, "Comparison unavailable"],
    [-110, null, true, "Comparison unavailable"],
  ] as const)(
    "footer scores only positive comparable quotes (%s/%s)",
    (book, model, comparable, expected) => {
      const $ = render(market(book, model, comparable));
      expect($("tfoot").text()).toBe(expected);
      expect($(".market-table__result--edge").length).toBe(
        expected.startsWith("EDGE") ? 1 : 0
      );
      expect($(".market-table__row--signal").length).toBe(
        expected.startsWith("EDGE") ? 1 : 0
      );
    }
  );
  it("keeps the comparison at the Book line when its model quote is absent", () => {
    const $ = render(market(-110, null));
    expect($("tbody td").eq(1).find(".market-table__line").text()).toBe(
      "+16.5"
    );
    expect($("tbody td").eq(1).find(".market-table__price").text()).toBe("(—)");
    expect($(".market-table__basis").text()).toBe("Fair projection: +20.9");
  });
  it("leaves existing league result thresholds and note rendering unchanged", () => {
    const value = market(-110, -111);
    delete value.sides[0].lineDisplay;
    value.resultLabel = "NO EDGE";
    value.resultIsEdge = false;
    const $ = render(value);
    expect($("tfoot").text()).toBe("Retired footer explanationNO EDGE");
    expect($(".market-table__row--signal")).toHaveLength(0);
  });
});

describe("unpriced NCAAF summary", () => {
  it("leads with available Book quotes while retaining every comparison and source market order", () => {
    const comparisons: ProjectionMarket[] = [
      {
        key: "spread",
        label: "Spread",
        sides: ["Washington State", "Washington"].map((side, index) => ({
          marketKey: "spread",
          marketLabel: "Spread",
          sideLabel: side,
          bookPrice: index === 0 ? null : Number.NaN,
          modelPrice: null,
          lineDisplay: {
            side,
            book: "—",
            model: index === 0 ? "+21.1" : "-21.1",
          },
        })),
      },
      {
        key: "total",
        label: "Total",
        sides: ["Over", "Under"].map((side, index) => ({
          marketKey: "total",
          marketLabel: "Total",
          sideLabel: `${side} 51.5`,
          bookPrice: index === 0 ? -112 : -108,
          modelPrice: null,
          lineDisplay: { side, book: "51.5", model: "52.1" },
        })),
      },
    ];
    const source = JSON.stringify(comparisons);
    const $ = load(
      renderToStaticMarkup(
        createElement(SummaryCarousel, { comparisonMarkets: comparisons })
      )
    );
    expect(
      $(".summary__pick")
        .toArray()
        .map(node => $(node).text())
    ).toEqual(["Over", "Under", "Washington State", "Washington"]);
    expect($(".summary__item--book dd").first().text()).toBe("51.5 (-112)");
    expect($(".summary__item--model dd").first().text()).toBe("51.5 (—)");
    expect($(".summary-carousel__slide")).toHaveLength(4);
    expect($(".edge-indicator")).toHaveLength(0);
    expect(JSON.stringify(comparisons)).toBe(source);
  });

  it("keeps the Book threshold in the Model cell without pretending the fair projection is odds", () => {
    const $ = load(
      renderToStaticMarkup(
        createElement(ProjectionSummary, {
          insight: null,
          comparisonMarkets: [market(-110, null)],
        })
      )
    );
    expect($(".summary__item--model dt").text()).toBe("Model");
    expect($(".summary__item--model dd").text()).toBe("+16.5 (—)");
    expect($(".summary__comparison-status").text()).toBe(
      "Model pricing unavailable"
    );
    expect($(".edge-indicator")).toHaveLength(0);
  });

  it("uses a comparable supplied price instead of the independent fair projection", () => {
    const $ = load(
      renderToStaticMarkup(
        createElement(ProjectionSummary, {
          insight: null,
          comparisonMarkets: [market(null, 125)],
        })
      )
    );
    expect($(".summary__item--model dd").text()).toBe("+16.5 (+125)");
    expect($(".summary__comparison-status").text()).toBe(
      "Comparison unavailable"
    );
  });

  it("withholds prices supplied at a different line", () => {
    const $ = load(
      renderToStaticMarkup(
        createElement(ProjectionSummary, {
          insight: null,
          comparisonMarkets: [market(-110, 165, false)],
        })
      )
    );
    expect($(".summary__item--model dd").text()).toBe("+16.5 (—)");
    expect($(".summary__comparison-status").text()).toBe(
      "Model pricing unavailable"
    );
  });

  it("labels both unpriced total sides as unavailable comparisons, not two model edges", () => {
    const total: ProjectionMarket = {
      key: "total",
      label: "Total",
      sides: [
        {
          marketKey: "total",
          marketLabel: "Total",
          sideLabel: "Over 51.5",
          bookPrice: -112,
          modelPrice: null,
          lineDisplay: { side: "Over", book: "51.5", model: "52.1" },
        },
        {
          marketKey: "total",
          marketLabel: "Total",
          sideLabel: "Under 51.5",
          bookPrice: -108,
          modelPrice: null,
          lineDisplay: { side: "Under", book: "51.5", model: "52.1" },
        },
      ],
    };
    const $ = load(
      renderToStaticMarkup(
        createElement(SummaryCarousel, { comparisonMarkets: [total] })
      )
    );
    expect(
      $(".summary__item--model dd")
        .toArray()
        .map(cell => $(cell).text())
    ).toEqual(["51.5 (—)", "51.5 (—)"]);
    expect(
      $(".summary__comparison-status")
        .toArray()
        .map(cell => $(cell).text())
    ).toEqual(["Model pricing unavailable", "Model pricing unavailable"]);
    expect($(".edge-indicator")).toHaveLength(0);
  });

  it("recommends only the positive total side for complementary fair prices", () => {
    const game = {
      markets: [
        {
          key: "total",
          label: "Total",
          sides: [
            {
              marketKey: "total",
              marketLabel: "Total",
              sideLabel: "Over 51.5",
              bookPrice: -112,
              modelPrice: -150,
            },
            {
              marketKey: "total",
              marketLabel: "Total",
              sideLabel: "Under 51.5",
              bookPrice: -108,
              modelPrice: 150,
            },
          ],
        },
      ],
    } as ProjectionGame;
    expect(rankedEdges(game).map(side => side.sideLabel)).toEqual([
      "Over 51.5",
    ]);
  });
});
