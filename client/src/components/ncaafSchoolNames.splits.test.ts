import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { describe, expect, it, vi } from "vitest";
import { GameCard } from "./GameCard";
import { SearchResultRow } from "../pages/BettingSplits";

vi.mock("@/hooks/useIsMdUp", () => ({ useIsMdUp: () => false }));
vi.mock("@/hooks/useIsDesktop", () => ({ useIsDesktop: () => false }));
vi.mock("@/hooks/useVisibility", () => ({
  useVisibility: () => [null, false],
}));
vi.mock("@/_core/hooks/useAppAuth", () => ({
  useAppAuth: () => ({ appUser: null }),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({}),
    favorites: { toggle: { useMutation: () => ({}) } },
  },
}));

const game = {
  id: 4350018,
  sport: "NCAAF",
  awayTeam: "SEMO",
  homeTeam: "ISU",
  gameDate: "2026-09-05",
  startTimeEst: "13:00",
  gameStatus: "upcoming",
  awayBookSpread: "+42.5",
  homeBookSpread: "-42.5",
  bookTotal: "55.5",
  awaySpreadOdds: "-110",
  homeSpreadOdds: "-110",
  overOdds: "-110",
  underOdds: "-110",
  spreadAwayBetsPct: 20,
  spreadAwayMoneyPct: 30,
} as ComponentProps<typeof GameCard>["game"];

describe("NCAAF full school names on the splits surface", () => {
  it("keeps the entire school name in both responsive matchup rails and the priced split labels", () => {
    const $ = load(
      renderToStaticMarkup(createElement(GameCard, { game, mode: "splits" }))
    );
    const frozen = $(".gc-frozen");
    expect(frozen.text()).toContain("Southeast Missouri State");
    expect(frozen.text()).toContain("Iowa State");
    expect(frozen.find("img").first().attr("src")).toBe(
      "/brand/ncaaf-helmets/sept5-semo-v2.png"
    );
    expect(
      frozen
        .find("span")
        .filter((_, el) => $(el).text() === "Southeast Missouri State")
        .attr("style")
    ).toContain("white-space:normal");
    expect($.text()).toContain("Southeast Missouri State (+42.5) (-110)");
    expect($.text()).toContain("Iowa State (-42.5) (-110)");
  });

  it("shows full college names in mobile and desktop search results without professional-team collisions", () => {
    const $ = load(
      renderToStaticMarkup(
        createElement(SearchResultRow, {
          game: { ...game, awayTeam: "MIA", homeTeam: "STAN" },
          onClick: () => {},
        })
      )
    );
    expect(
      $("span.sm\\:hidden")
        .map((_, el) => $(el).text())
        .get()
    ).toEqual(["Miami (Florida)", "Stanford"]);
    expect($.text()).not.toContain("Marlins");
    expect(
      $("span.hidden.sm\\:block")
        .map((_, el) => $(el).text())
        .get()
    ).toEqual(["Miami (Florida)", "Stanford"]);
  });

  it("retains MLB mobile abbreviations and desktop names", () => {
    const $ = load(
      renderToStaticMarkup(
        createElement(SearchResultRow, {
          game: { ...game, sport: "MLB", awayTeam: "MIA", homeTeam: "NYY" },
          onClick: () => {},
        })
      )
    );
    expect(
      $("span.sm\\:hidden")
        .map((_, el) => $(el).text())
        .get()
    ).toEqual(["MIA", "NYY"]);
    expect($.text()).toContain("Marlins");
    expect($.text()).toContain("Yankees");
  });
});
