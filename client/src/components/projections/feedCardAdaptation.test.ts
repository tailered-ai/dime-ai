import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ProjectionCard,
  rankedEdges,
  rankedNoEdgeCandidates,
} from "./ProjectionCard";
import { MarketTable } from "./MarketTable";
import type { ProjectionGame } from "./types";

function fixture(league = "NCAAF"): ProjectionGame {
  return {
    id: `${league}-comparison`,
    league,
    status: "live",
    statusLabel: "LIVE · Q3",
    away: {
      abbr: "BRY",
      name: "Bryant",
      score: 7,
      logo: "/brand/ncaaf-helmets/sept5-bryant.png",
    },
    home: {
      abbr: "ARMY",
      name: "Army",
      score: 28,
      logo: "/brand/ncaaf-helmets/sept5-army.png",
    },
    markets: [
      {
        key: "spread",
        label: "Spread",
        sides: [
          {
            marketKey: "spread",
            marketLabel: "Spread",
            sideLabel: "Bryant +37.5",
            bookPrice: -108,
            modelPrice: -289,
            comparable: false,
            modelLineLabel: "+37",
            lineDisplay: {
              side: "Bryant",
              book: "+37.5",
              model: "+26.7",
              priceAt: "+37",
            },
          },
          {
            marketKey: "spread",
            marketLabel: "Spread",
            sideLabel: "Army -37.5",
            bookPrice: -112,
            modelPrice: 289,
            comparable: false,
            modelLineLabel: "-37",
            lineDisplay: {
              side: "Army",
              book: "-37.5",
              model: "-26.7",
              priceAt: "-37",
            },
          },
        ],
      },
    ],
  };
}
const render = (game: ProjectionGame) =>
  load(renderToStaticMarkup(createElement(ProjectionCard, { game })));

describe("compact feed card adaptation", () => {
  it.each(["NCAAF", "MLB", "NFL", "NBA", "NHL", "WC"])(
    "uses the same compact anatomy for %s without hiding Book values or mispricing the projection",
    league => {
      const game = fixture(league);
      const $ = render(game);
      expect($(".summary-carousel__slide")).toHaveLength(2);
      expect($(".summary--comparison .summary__readout")).toHaveLength(2);
      expect(
        $(".summary--comparison dd")
          .toArray()
          .map(cell => $(cell).text())
      ).toEqual([
        "Bryant",
        "+37.5 (-108)",
        "+26.7",
        "Army",
        "-37.5 (-112)",
        "-26.7",
      ]);
      expect($("table, .market-table__basis, .edge-indicator")).toHaveLength(0);
      expect($(".summary--comparison").text()).not.toMatch(/at [+-]37|289/);
      expect(rankedEdges(game)).toEqual([]);
      expect(rankedNoEdgeCandidates(game)).toEqual([]);
    }
  );

  it("retains original model odds and explicit pricing basis in the full market table", () => {
    const $ = load(
      renderToStaticMarkup(
        createElement(MarketTable, { market: fixture().markets[0] })
      )
    );
    expect($("tbody tr").first().find("td").eq(1).text()).toBe(
      "+26.7(-289)at +37"
    );
    expect($("tfoot").text()).toBe("NO EDGE");
    expect($(".market-table__row--signal")).toHaveLength(0);
  });

  it("retains supplied model prices when comparison is valid and preserves small positive raw footers", () => {
    const game = fixture();
    game.markets[0].sides[0] = {
      ...game.markets[0].sides[0],
      comparable: true,
      modelPrice: -109,
    };
    const $ = load(
      renderToStaticMarkup(
        createElement(MarketTable, { market: game.markets[0] })
      )
    );
    expect($("tfoot").text()).toBe("EDGE +0.2%");
    expect($(".market-table__row--signal")).toHaveLength(1);
  });

  it("never promotes a missing pricing basis or absent projection into a compact model price", () => {
    const game = fixture();
    delete game.markets[0].sides[0].lineDisplay;
    delete game.markets[0].sides[0].modelLineLabel;
    const $ = render(game);
    expect($(".summary__item--model dd").first().text()).toBe("—");
    expect($(".summary__comparison-status").first().text()).toBe(
      "Comparison unavailable"
    );
    expect($(".summary").text()).not.toContain("-289");
  });

  it("keeps every side keyboard reachable through the next control without tabbing into inactive slides", () => {
    const $ = render(fixture());
    expect(
      $(".summary__next")
        .toArray()
        .map(button => $(button).attr("tabindex"))
    ).toEqual(["0", "-1"]);
    expect($(".summary__next").first().attr("aria-label")).toBe(
      "View next comparison: Spread: Army (2 of 2)"
    );
    expect($(".summary__next").last().attr("aria-label")).toBe(
      "View next comparison: Spread: Bryant (1 of 2)"
    );
    expect($(".projection-card__markets-toggle").attr("aria-expanded")).toBe(
      "false"
    );
  });

  it("keeps complete names accessible alongside canonical abbreviations, correct scores and helmet identities", () => {
    const $ = render(fixture());
    const identity = $(".matchup__line[data-compact]");
    expect(identity.text()).toBe("BRY @ ARMY");
    expect($(".matchup__center").attr("aria-label")).toBe("Bryant at Army");
    expect(identity.attr("aria-hidden")).toBe("true");
    expect(identity.attr("title")).toBe("Bryant @ Army");
    expect($(".matchup__team--away .matchup__score").text()).toBe("7");
    expect($(".matchup__team--home .matchup__score").text()).toBe("28");
    expect($(".matchup__team--away img").attr("src")).toContain("bryant");
    expect($(".matchup__team--home img").attr("src")).toContain("army");
    const source = readFileSync(
      new URL("./MatchupPanel.tsx", import.meta.url),
      "utf8"
    );
    expect(source).toContain("observer.observe(center)");
    expect(source).toContain("observer.observe(fullName)");
    expect(source).toContain("observer.disconnect()");
    expect(source).not.toContain("window.innerWidth");
    const css = readFileSync(
      new URL("./ProjectionCard.css", import.meta.url),
      "utf8"
    );
    expect(css).not.toMatch(
      /\.projection-card--compact\s*\{[^}]*align-self:\s*start/
    );
  });
});
