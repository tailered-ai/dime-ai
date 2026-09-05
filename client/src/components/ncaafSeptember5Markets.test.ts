import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BettingSplitsPanel } from "./BettingSplitsPanel";
import { marketCells, resolveSplitPair } from "./OddsHistoryPanel";

const viewport = vi.hoisted(() => ({ wide: true }));
vi.mock("@/hooks/useIsMdUp", () => ({ useIsMdUp: () => viewport.wide }));
vi.mock("@/lib/trpc", () => ({ trpc: {} }));

const game = {
  sport: "NCAAF",
  awayTeam: "LIB",
  homeTeam: "JMU",
  awayBookSpread: "+6.5",
  homeBookSpread: "-6.5",
  bookTotal: "51.5",
  awaySpreadOdds: "+105",
  homeSpreadOdds: "-125",
  overOdds: "-115",
  underOdds: "-105",
  awayML: "+220",
  homeML: "-270",
  spreadAwayBetsPct: 51,
  spreadHomeBetsPct: 50,
  spreadAwayMoneyPct: 21,
  spreadHomeMoneyPct: 80,
  totalOverBetsPct: 37,
  totalUnderBetsPct: 64,
  totalOverMoneyPct: 48,
  totalUnderMoneyPct: 53,
  mlAwayBetsPct: 11,
  mlHomeBetsPct: 90,
  mlAwayMoneyPct: 29,
  mlHomeMoneyPct: 72,
};
const render = (overrides: Partial<typeof game> = {}) =>
  renderToStaticMarkup(
    createElement(BettingSplitsPanel, {
      game: { ...game, ...overrides },
      awayLabel: "Liberty",
      homeLabel: "James Madison",
      awayAbbr: "LIB",
      homeAbbr: "JMU",
    })
  );
const history = {
  ...game,
  id: 1,
  scrapedAt: 1788627600000,
  source: "manual",
  sourceLabel: "VSiN DK",
  lineSource: "dk",
  awaySpread: game.awayBookSpread,
  homeSpread: game.homeBookSpread,
  total: game.bookTotal,
};

beforeEach(() => {
  viewport.wide = true;
});

describe("September 5 NCAAF Book prices and independently rounded splits", () => {
  it("renders AN spread and total juice beside all three current split markets", () => {
    const $ = load(render());
    const columns = $("[data-market-col]");
    expect(columns.eq(0).text()).toContain("LIB (+6.5) (+105)");
    expect(columns.eq(0).text()).toContain("JMU (-6.5) (-125)");
    expect(columns.eq(1).text()).toContain("OVER 51.5 (-115)");
    expect(columns.eq(1).text()).toContain("UNDER 51.5 (-105)");
    for (const [index, percentages] of [
      [0, [51, 50, 21, 80]],
      [1, [37, 64, 48, 53]],
      [2, [11, 90, 29, 72]],
    ] as const) {
      for (const percentage of percentages)
        expect(columns.eq(index).text()).toContain(`${percentage}%`);
    }
  });

  it("keeps the existing non-NCAAF line labels without adding juice", () => {
    const text = load(render({ sport: "MLB" })).text();
    expect(text).not.toContain("(+105)");
    expect(text).not.toContain("(-115)");
  });

  it("keeps real 0/100 current splits on desktop and mobile, with full priced labels", () => {
    const zero = {
      spreadAwayBetsPct: 0,
      spreadAwayMoneyPct: 0,
      spreadHomeBetsPct: 100,
      spreadHomeMoneyPct: 100,
    };
    expect(load(render(zero))("[data-market-col]").first().text()).toContain(
      "100%"
    );
    viewport.wide = false;
    const $ = load(render(zero));
    expect($(".bsp-bar").first().attr("aria-label")).toBe(
      "Tickets: LIB (+6.5) (+105) 0%; JMU (-6.5) (-125) 100%"
    );
    expect($(".bsp-hdr").first().text()).toContain("JMU (-6.5) (-125)");
  });

  it("shows AN market headings even while current split percentages are unavailable", () => {
    const unavailable = {
      spreadAwayBetsPct: 0,
      spreadAwayMoneyPct: 0,
      spreadHomeBetsPct: 0,
      spreadHomeMoneyPct: 0,
    };
    viewport.wide = false;
    const text = load(render(unavailable)).text();
    expect(text).toContain("LIB (+6.5) (+105)");
    expect(text).not.toContain("100%");
  });

  it("retains source percentages for each history market instead of forcing a sum of 100", () => {
    expect(marketCells(history, "spread")).toMatchObject({
      betsA: 51,
      betsB: 50,
      moneyA: 21,
      moneyB: 80,
      pending: false,
    });
    expect(marketCells(history, "total")).toMatchObject({
      betsA: 37,
      betsB: 64,
      moneyA: 48,
      moneyB: 53,
      pending: false,
    });
    expect(marketCells(history, "ml")).toMatchObject({
      betsA: 11,
      betsB: 90,
      moneyA: 29,
      moneyB: 72,
      pending: false,
    });
    expect(
      marketCells(
        {
          ...history,
          spreadAwayBetsPct: 0,
          spreadAwayMoneyPct: 0,
          spreadHomeBetsPct: 100,
          spreadHomeMoneyPct: 100,
        },
        "spread"
      )
    ).toMatchObject({
      betsA: 0,
      betsB: 100,
      moneyA: 0,
      moneyB: 100,
      pending: false,
    });
  });

  it("keeps missing and unopened pairs unavailable while retaining legacy inverse fallback", () => {
    expect(resolveSplitPair(0, 0, false)).toEqual([null, null]);
    expect(resolveSplitPair(0, null, false)).toEqual([null, null]);
    expect(resolveSplitPair(null, 100, false)).toEqual([null, null]);
    expect(resolveSplitPair(0, 100, true)).toEqual([0, 100]);
    expect(resolveSplitPair(51, undefined, false)).toEqual([51, 49]);
    expect(
      marketCells(
        {
          ...history,
          spreadHomeBetsPct: undefined,
          spreadHomeMoneyPct: undefined,
        },
        "spread"
      )
    ).toMatchObject({ betsA: 51, betsB: 49, moneyA: 21, moneyB: 79 });
    expect(
      marketCells(
        {
          ...history,
          spreadAwayBetsPct: 0,
          spreadAwayMoneyPct: 0,
          spreadHomeBetsPct: undefined,
          spreadHomeMoneyPct: undefined,
        },
        "spread"
      )
    ).toMatchObject({ betsA: 0, betsB: 100, pending: false });
  });
});
