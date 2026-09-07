import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  runFootballMarketCycle,
  footballRefreshDates,
} from "./ncaafMarketRefresh";
import {
  listGamesByDate,
  updateFootballMarket,
  bindFootballProvider,
} from "./db";
import { fetchActionNetworkOdds } from "./actionNetworkScraper";
import { scrapeVsinBettingSplits } from "./vsinBettingSplitsScraper";
vi.mock("./db", () => ({
  listGamesByDate: vi.fn(async () => []),
  updateNcaafMarkets: vi.fn(),
  updateFootballMarket: vi.fn(async () => true),
  reconcileFootballSchedule: vi.fn(),
  bindFootballProvider: vi.fn(),
}));
vi.mock("./footballSchedule", () => ({
  fetchFootballSchedule: vi.fn(async () => ({ rows: [], unresolved: [] })),
}));
vi.mock("./actionNetworkScraper", () => ({
  fetchActionNetworkOdds: vi.fn(async () => []),
}));
vi.mock("./vsinBettingSplitsScraper", () => ({
  scrapeVsinBettingSplits: vi.fn(async () => []),
}));
vi.mock("./_core/debugLogger", () => ({ debugLog: vi.fn() }));
vi.mock("./betGradingHealth", () => ({ gradingAlert: vi.fn() }));
beforeEach(() => {
  vi.stubEnv("FOOTBALL_MARKETS_MODE", "pilots");
  vi.useFakeTimers();
  vi.setSystemTime("2026-09-07T12:00Z");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
const binding = {
  scheduleKey: "espn:nfl:2026:401872656",
  scheduleRevision: "verified",
  kickoff: Date.parse("2026-09-10T00:20Z"),
  awayTeam: "NE",
  homeTeam: "SEA",
  awayName: "New England Patriots",
  homeName: "Seattle Seahawks",
  an: { eventId: 123, awayTeamId: 17, homeTeamId: 26 },
  vsin: {
    eventId: "20260909NFL00061",
    awaySlug: "new-england-patriots",
    homeSlug: "seattle-seahawks",
  },
};
function fixture() {
  vi.mocked(listGamesByDate).mockImplementation(async date =>
    date === "2026-09-09"
      ? ([
          {
            id: 4380001,
            sport: "NFL",
            gameDate: date,
            awayTeam: "NE",
            homeTeam: "SEA",
            gameStatus: "upcoming",
            publishedToFeed: true,
            footballBinding: binding,
            footballScheduleId: binding.scheduleKey,
          },
        ] as any)
      : []
  );
  const provenance = {
    sourceUrl: "https://provider.example",
    receivedAt: Date.now(),
    sourceUpdatedAt: null,
    responseSha256: "a".repeat(64),
  };
  vi.mocked(fetchActionNetworkOdds).mockResolvedValue([
    {
      gameId: 123,
      awayTeamId: 17,
      homeTeamId: 26,
      startTime: "2026-09-10T00:20Z",
      status: "scheduled",
      dkTotal: 44.5,
      dkOverOdds: "-110",
      dkUnderOdds: "-110",
      provenance,
    },
  ] as any);
  vi.mocked(scrapeVsinBettingSplits).mockResolvedValue([
    {
      gameId: "20260909NFL00061",
      gameDate: "2026-09-09",
      sport: "NFL",
      awayVsinSlug: "new-england-patriots",
      homeVsinSlug: "seattle-seahawks",
      spreadAwayBetsPct: 0,
      spreadHomeBetsPct: 100,
      provenance,
    },
  ] as any);
}
it("covers seven Eastern dates across DST and coalesces timer/cron/manual overlaps", async () => {
  expect(footballRefreshDates(new Date("2026-11-01T03:00Z"))).toEqual([
    "2026-10-31",
    "2026-11-01",
    "2026-11-02",
    "2026-11-03",
    "2026-11-04",
    "2026-11-05",
    "2026-11-06",
  ]);
  fixture();
  const [a, b] = await Promise.all([
    runFootballMarketCycle("auto", ["NFL"]),
    runFootballMarketCycle("manual", ["NFL"]),
  ]);
  expect(a.NFL).toEqual(b.NFL);
  expect(a.NFL).toMatchObject({ updated: 2, errors: [] });
  expect(scrapeVsinBettingSplits).toHaveBeenCalledTimes(1);
  expect(fetchActionNetworkOdds).toHaveBeenCalledTimes(1);
  expect(fetchActionNetworkOdds).toHaveBeenCalledWith(
    "nfl",
    "2026-09-09",
    expect.any(AbortSignal)
  );
  expect(updateFootballMarket).toHaveBeenCalledWith(
    expect.objectContaining({
      observation: expect.objectContaining({
        provider: "vsin_dk",
        snapshot: expect.objectContaining({
          spreadAwayBetsPct: 0,
          spreadHomeBetsPct: 100,
        }),
      }),
    })
  );
});
it("keeps VSiN independent when AN fails and stops authorization retries for the cycle", async () => {
  fixture();
  vi.mocked(fetchActionNetworkOdds).mockRejectedValueOnce(
    Object.assign(new Error("403"), { status: 403 })
  );
  const result = await runFootballMarketCycle("auto", ["NFL"]);
  expect(result.NFL).toMatchObject({
    updated: 1,
    providers: { an_dk: { ok: false }, vsin_dk: { ok: true } },
  });
  expect(updateFootballMarket).toHaveBeenCalledTimes(1);
});
it("binds the source-verified FSU spelling without fuzzy team matching", async () => {
  const b = {
    ...binding,
    scheduleKey: "espn:ncaaf:2026:401858212",
    awayTeam: "SMU",
    homeTeam: "FSU",
    awayEspnId: 2567,
    homeEspnId: 52,
    awayName: "SMU Mustangs",
    homeName: "Florida State Seminoles",
    kickoff: Date.parse("2026-09-07T23:30Z"),
    an: undefined,
    vsin: undefined,
  };
  vi.mocked(listGamesByDate).mockImplementation(async date =>
    date === "2026-09-07"
      ? ([
          {
            id: 1,
            sport: "NCAAF",
            gameDate: date,
            gameStatus: "upcoming",
            publishedToFeed: true,
            footballBinding: b,
            footballScheduleId: b.scheduleKey,
          },
        ] as any)
      : []
  );
  vi.mocked(fetchActionNetworkOdds).mockResolvedValue([]);
  vi.mocked(scrapeVsinBettingSplits).mockResolvedValue([
    {
      gameId: "20260907CFB00153",
      gameDate: "2026-09-07",
      sport: "CFB",
      awayName: "SMU Mustangs",
      homeName: "Florida ST Seminoles",
      awayVsinSlug: "smu-mustangs",
      homeVsinSlug: "florida-st-seminoles",
      provenance: {
        sourceUrl: "https://data.vsin.com/betting-splits/?source=DK&sport=CFB",
        receivedAt: Date.now(),
        sourceUpdatedAt: null,
        responseSha256: "a".repeat(64),
      },
    },
  ] as any);
  vi.mocked(bindFootballProvider).mockResolvedValue({
    ...b,
    vsin: {
      eventId: "20260907CFB00153",
      awaySlug: "smu-mustangs",
      homeSlug: "florida-st-seminoles",
    },
  });
  const result = await runFootballMarketCycle("auto", ["NCAAF"]);
  expect(result.NCAAF?.providers.vsin_dk.observations).toBe(1);
});
it("does not start any writer while disabled", async () => {
  vi.stubEnv("FOOTBALL_MARKETS_MODE", "off");
  expect(await runFootballMarketCycle("auto", ["NFL"])).toMatchObject({
    NFL: { disabled: true, updated: 0 },
  });
  expect(listGamesByDate).not.toHaveBeenCalled();
});
it("honors Retry-After across cycles while the independent provider still updates", async () => {
  fixture();
  vi.mocked(fetchActionNetworkOdds).mockRejectedValueOnce(
    Object.assign(new Error("rate limited"), { status: 429, retryAfter: "600" })
  );
  await runFootballMarketCycle("auto", ["NFL"]);
  vi.setSystemTime("2026-09-07T12:05Z");
  const limited = await runFootballMarketCycle("auto", ["NFL"]);
  expect(fetchActionNetworkOdds).toHaveBeenCalledTimes(1);
  expect(scrapeVsinBettingSplits).toHaveBeenCalledTimes(2);
  expect(limited.NFL?.providers.an_dk.ok).toBe(false);
  vi.setSystemTime("2026-09-07T12:11Z");
  await runFootballMarketCycle("auto", ["NFL"]);
  expect(fetchActionNetworkOdds).toHaveBeenCalledTimes(2);
});
it("rejects a non-writer Railway service before schedule or market collection", async () => {
  vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "production");
  vi.stubEnv("RAILWAY_SERVICE_ID", "other");
  vi.stubEnv("FOOTBALL_MARKETS_WRITER_SERVICE_ID", "application");
  expect(await runFootballMarketCycle("auto", ["NFL"])).toMatchObject({
    NFL: { disabled: true },
  });
  expect(listGamesByDate).not.toHaveBeenCalled();
});
