import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import { MarketTable } from "./MarketTable";
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
      "Pricing unavailable at this line · Model at +16: +165"
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
    expect($(".market-table__basis")).toHaveLength(0);
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
