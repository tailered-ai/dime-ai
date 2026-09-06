import { afterEach, expect, it, vi } from "vitest";
import { fetchActionNetworkOdds } from "./actionNetworkScraper";

vi.mock("./_core/debugLogger", () => ({ debugLog: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const quote = (extra = {}) => ({
  book_id: 68,
  event_id: 288813,
  team_id: 356,
  side: "away",
  value: 21,
  odds: -110,
  period: "event",
  type: "spread",
  is_live: false,
  is_alt_market: false,
  ...extra,
});
const event = (spread: unknown[]) => ({
  id: 288813,
  status: "scheduled",
  start_time: "2026-09-06T20:00:00Z",
  away_team_id: 356,
  home_team_id: 360,
  teams: [
    {
      id: 356,
      full_name: "Washington State Cougars",
      abbr: "WSU",
      url_slug: "washington-state-cougars",
    },
    {
      id: 360,
      full_name: "Washington Huskies",
      abbr: "WASH",
      url_slug: "washington-huskies",
    },
  ],
  markets: {
    "68": { event: { spread } },
    "30": { event: { spread: [quote({ book_id: 30, value: 17 })] } },
  },
});
async function read(spread: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ league: { name: "ncaaf" }, games: [event(spread)] })
        )
    )
  );
  return (await fetchActionNetworkOdds("ncaaf" as any, "2026-09-06"))[0];
}

it("keeps missing NCAAF DraftKings prices unavailable instead of selecting live/alternate/foreign outcomes", async () => {
  for (const invalid of [
    { is_live: true },
    { is_alt_market: true },
    { book_id: 30 },
    { event_id: 999 },
    { team_id: 360 },
    { period: "first_half" },
    { odds: 0 },
  ]) {
    expect((await read([quote(invalid)])).dkAwaySpread).toBeNull();
  }
});

it("rejects ambiguous NCAAF outcomes rather than choosing the first price", async () => {
  expect((await read([quote(), quote({ value: 22 })])).dkAwaySpread).toBeNull();
});

it("preserves exact NCAAF thresholds, zero, and immutable source team identities", async () => {
  expect(await read([quote({ value: 21.1 })])).toMatchObject({
    gameId: 288813,
    awayTeamId: 356,
    homeTeamId: 360,
    dkAwaySpread: 21.1,
    dkAwaySpreadOdds: "-110",
  });
  expect((await read([quote({ value: 0 })])).dkAwaySpread).toBe(0);
});
