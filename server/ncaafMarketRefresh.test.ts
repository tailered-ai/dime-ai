import { afterEach, expect, it, vi } from "vitest";
import * as refresh from "./vsinAutoRefresh";
import { listGamesByDate, updateNcaafMarkets } from "./db";
import { refreshNcaafMarkets } from "./ncaafMarketRefresh";
import { fetchActionNetworkOdds } from "./actionNetworkScraper";
import { scrapeVsinBettingSplits } from "./vsinBettingSplitsScraper";
import { DATE, SLATE } from "../shared/ncaafSeptember6";

vi.mock("./db", () => ({
  listGamesByDate: vi.fn(async () => []),
  updateBookOdds: vi.fn(),
  insertGames: vi.fn(),
  updateAnOdds: vi.fn(),
  insertOddsHistory: vi.fn(),
  getGameByNcaaContestId: vi.fn(),
  updateNcaaStartTime: vi.fn(),
  updateNcaafMarkets: vi.fn(async () => true),
}));
vi.mock("./actionNetworkScraper", () => ({ fetchActionNetworkOdds: vi.fn() }));
vi.mock("./vsinBettingSplitsScraper", () => ({
  scrapeVsinBettingSplits: vi.fn(),
}));
vi.mock("./_core/debugLogger", () => ({ debugLog: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-06T19:00:00Z"));
  const m = SLATE[0];
  const parent = {
    id: 4350069,
    sport: "NCAAF",
    gameDate: DATE,
    awayTeam: m.away,
    homeTeam: m.home,
    ncaaContestId: String(m.event),
    publishedToFeed: true,
    gameStatus: "upcoming",
  };
  const an = {
    gameId: m.event,
    awayTeamId: m.awayId,
    homeTeamId: m.homeId,
    startTime: m.utc,
    status: "scheduled",
    dkTotal: 51.5,
    dkOverOdds: "-112",
    dkUnderOdds: "-108",
  };
  const vsin = {
    gameId: m.vsin,
    sport: "CFB",
    awayVsinSlug: m.awaySlug,
    homeVsinSlug: m.homeSlug,
    spreadAwayBetsPct: 0,
    spreadAwayMoneyPct: 57,
    totalOverBetsPct: 77,
    totalOverMoneyPct: 72,
    mlAwayBetsPct: 13,
    mlAwayMoneyPct: 22,
  };
  vi.mocked(listGamesByDate).mockResolvedValue([parent] as any);
  vi.mocked(fetchActionNetworkOdds).mockResolvedValue([an] as any);
  vi.mocked(scrapeVsinBettingSplits).mockResolvedValue([vsin] as any);
  return { parent, an, vsin };
}

it("keeps NCAAF diagnostic IDs and provider errors out of public refresh status", async () => {
  const { parent } = fixture();
  vi.mocked(listGamesByDate).mockResolvedValue([
    { ...parent, ncaaContestId: "unknown" },
    { ...parent, id: 4350070 },
  ] as any);
  vi.mocked(fetchActionNetworkOdds).mockRejectedValue(
    new Error("private provider detail")
  );
  const result = await refresh.runVsinRefreshManual("NCAAF");
  expect(result?.ncaaf?.unmapped).toContain(parent.id);
  expect(result?.ncaaf?.errors).toContain("private provider detail");
  const status = refresh.getLastRefreshResult();
  expect(status).toMatchObject({ refreshedAt: expect.any(String), updated: 0 });
  expect(status).not.toHaveProperty("ncaaf");
  expect(status).not.toHaveProperty("ncaafTomorrow");
  expect(JSON.stringify(status)).not.toContain("private provider detail");
});

it("routes a NCAAF-only manual refresh to NCAAF rows without refreshing other leagues", async () => {
  vi.mocked(listGamesByDate).mockResolvedValue([]);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const request = vi.fn(async () => {
    throw new Error("No provider read needed for empty NCAAF date");
  });
  vi.stubGlobal("fetch", request);
  const result = await refresh.runVsinRefreshManual("NCAAF");
  expect(result).toMatchObject({
    ncaaf: { updated: 0, skipped: 0, errors: [] },
  });
  expect(listGamesByDate).toHaveBeenCalledWith(expect.any(String), "NCAAF");
  expect(
    vi
      .mocked(listGamesByDate)
      .mock.calls.every(([, sport]) => sport === "NCAAF")
  ).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

it("joins exact AN/VSiN events once, preserving missing markets and valid zero splits", async () => {
  fixture();
  const results = await Promise.all([
    refreshNcaafMarkets(DATE, "today", "auto"),
    refreshNcaafMarkets(DATE, "today", "auto"),
  ]);
  expect(results[0]).toMatchObject({ updated: 1, errors: [] });
  expect(fetchActionNetworkOdds).toHaveBeenCalledTimes(1);
  expect(scrapeVsinBettingSplits).toHaveBeenCalledWith("today", "CFB");
  expect(updateNcaafMarkets).toHaveBeenCalledTimes(1);
  expect(updateNcaafMarkets).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 4350069,
      eventId: "288813",
      snapshot: expect.objectContaining({
        total: "51.5",
        awaySpread: null,
        awayML: null,
        spreadAwayBetsPct: 0,
      }),
    })
  );
});

it("rejects wrong or duplicate provider identities and changed kickoffs", async () => {
  for (const mutation of [
    "team",
    "event",
    "duplicate",
    "kickoff",
    "vsin",
    "split",
  ]) {
    const { an, vsin } = fixture();
    if (mutation === "team") an.awayTeamId = 999 as any;
    if (mutation === "event") an.gameId = 999 as any;
    if (mutation === "duplicate")
      vi.mocked(fetchActionNetworkOdds).mockResolvedValue([an, an] as any);
    if (mutation === "kickoff") an.startTime = "2026-09-06T21:00:00Z" as any;
    if (mutation === "vsin") vsin.homeVsinSlug = "other" as any;
    if (mutation === "split") vsin.totalOverBetsPct = 101;
    const result = await refreshNcaafMarkets(DATE, "today", "auto");
    expect(result.updated, mutation).toBe(0);
    expect(result.errors.length, mutation).toBeGreaterThan(0);
  }
  expect(updateNcaafMarkets).not.toHaveBeenCalled();
});

it("retains prior data on provider failure and freezes live or unmapped games", async () => {
  fixture();
  vi.mocked(scrapeVsinBettingSplits).mockRejectedValueOnce(
    new Error("provider outage")
  );
  expect((await refreshNcaafMarkets(DATE, "today", "auto")).errors).toContain(
    "provider outage"
  );
  const { parent } = fixture();
  parent.gameStatus = "live";
  expect(await refreshNcaafMarkets(DATE, "today", "auto")).toMatchObject({
    updated: 0,
    frozen: 1,
  });
  parent.gameStatus = "upcoming";
  parent.ncaaContestId = "unknown";
  expect(await refreshNcaafMarkets(DATE, "today", "auto")).toMatchObject({
    updated: 0,
    skipped: 1,
    unmapped: [4350069],
  });
  expect(updateNcaafMarkets).not.toHaveBeenCalled();
});
