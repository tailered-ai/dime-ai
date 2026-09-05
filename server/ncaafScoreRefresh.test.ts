import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { listGamesByDate, updateNcaaStartTime } from "./db";
import {
  ncaafRefreshDates,
  parseNcaafScoreboard,
  refreshNcaafScoresNow,
} from "./ncaafScoreRefresh";

vi.mock("./db", () => ({
  listGamesByDate: vi.fn(),
  updateNcaaStartTime: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

// Minimal fields from ESPN's September 5 Rhode Island–Temple result.
const temple = {
  id: "401862698",
  date: "2026-09-05T18:00Z",
  tbd: false,
  status: { id: "3", state: "post", description: "Final", detail: "Final" },
  competitors: [
    { id: "218", abbrev: "TEM", isHome: true, score: 38 },
    { id: "227", abbrev: "URI", isHome: false, score: 14 },
  ],
};
const html = (events: unknown[]) =>
  `window['__espnfitt__']=${JSON.stringify({ page: { content: { scoreboard: { evts: events } } } })};</script>`;

it("includes NCAAF in the score refresh used by cron and the admin button", () => {
  const source = readFileSync(
    new URL("./vsinAutoRefresh.ts", import.meta.url),
    "utf8"
  );
  const body = source
    .split("export async function refreshAllScoresNow()")[1]
    ?.split("lastScoresRefreshedAt =")[0];
  expect(body).toContain("refreshNbaScores()");
  expect(body).toContain("refreshNcaafScoresNow()");
});

it("converts UTC kickoff instants to New York time across midnight and DST without using the host timezone", () => {
  expect(parseNcaafScoreboard(html([temple]), "2026-09-05")[0]).toMatchObject({
    startTimeEst: "14:00",
    gameStatus: "final",
    awayScore: 14,
    homeScore: 38,
  });
  for (const [utc, date, time] of [
    ["2026-09-06T02:30Z", "2026-09-05", "22:30"],
    ["2026-09-06T04:00Z", "2026-09-06", "00:00"],
    ["2026-11-01T05:30Z", "2026-11-01", "01:30"],
    ["2026-11-01T06:30Z", "2026-11-01", "01:30"],
    ["2026-12-05T18:00Z", "2026-12-05", "13:00"],
    ["2026-03-08T07:30Z", "2026-03-08", "03:30"],
  ]) {
    expect(
      parseNcaafScoreboard(html([{ ...temple, date: utc }]), date)[0]
        .startTimeEst
    ).toBe(time);
  }
  expect(parseNcaafScoreboard(html([temple]), "2026-09-06")).toEqual([]);
  expect(ncaafRefreshDates(new Date("2026-09-06T02:00Z"))).toEqual([
    "2026-09-04",
    "2026-09-05",
  ]);
  expect(ncaafRefreshDates(new Date("2026-03-08T07:30Z"))).toEqual([
    "2026-03-07",
    "2026-03-08",
  ]);
  expect(ncaafRefreshDates(new Date("2026-11-01T06:30Z"))).toEqual([
    "2026-10-31",
    "2026-11-01",
  ]);
});

it("rejects malformed snapshots and uses provider lifecycle, including delays and TBD", () => {
  expect(() =>
    parseNcaafScoreboard("<html>unavailable</html>", "2026-09-05")
  ).toThrow();
  expect(
    parseNcaafScoreboard(
      html([
        {
          ...temple,
          competitors: temple.competitors.map(({ score, ...team }) => team),
        },
        { ...temple, date: "invalid" },
      ]),
      "2026-09-05"
    )
  ).toEqual([]);
  for (const [state, description, expected] of [
    ["pre", "Scheduled", "upcoming"],
    ["pre", "Delayed", "upcoming"],
    ["in", "In Progress", "live"],
    ["in", "Delayed", "suspended"],
    ["post", "Postponed", "postponed"],
    ["post", "Final/OT", "final"],
  ]) {
    const [event] = parseNcaafScoreboard(
      html([
        {
          ...temple,
          status: { id: "1", state, description, detail: description },
        },
      ]),
      "2026-09-05"
    );
    expect(event.gameStatus).toBe(expected);
  }
  expect(
    parseNcaafScoreboard(html([{ ...temple, tbd: true }]), "2026-09-05")[0]
      .startTimeEst
  ).toBe("TBD");
});

it("repairs the published Temple game, preserves market/provider identity, and skips unchanged or regressive snapshots", async () => {
  const row = {
    id: 123,
    awayTeam: "URI",
    homeTeam: "TEM",
    publishedModel: true,
    startTimeEst: "14:00",
    gameStatus: "upcoming",
    awayScore: null,
    homeScore: null,
    gameClock: null,
  };
  vi.mocked(listGamesByDate).mockImplementation(async date =>
    date === "2026-09-05" ? ([row] as any) : []
  );
  vi.mocked(updateNcaaStartTime).mockImplementation(async (_id, patch) => {
    Object.assign(row, patch);
  });
  const request = vi
    .fn()
    .mockResolvedValue({ ok: true, text: async () => html([temple]) });
  vi.stubGlobal("fetch", request);
  const now = new Date("2026-09-06T02:00Z");
  await Promise.all([refreshNcaafScoresNow(now), refreshNcaafScoresNow(now)]);
  expect(request).toHaveBeenCalledTimes(1);
  expect(updateNcaaStartTime).toHaveBeenCalledExactlyOnceWith(123, {
    startTimeEst: "14:00",
    gameStatus: "final",
    awayScore: 14,
    homeScore: 38,
    gameClock: null,
  });
  await refreshNcaafScoresNow(now);
  request.mockResolvedValue({
    ok: true,
    text: async () =>
      html([
        {
          ...temple,
          status: {
            id: "1",
            state: "pre",
            description: "Scheduled",
            detail: "Scheduled",
          },
        },
      ]),
  });
  await refreshNcaafScoresNow(now);
  expect(updateNcaaStartTime).toHaveBeenCalledTimes(1);
});

it("retains last-known data on provider failure or ambiguous matchups, and ignores unpublished games", async () => {
  const row = {
    id: 123,
    awayTeam: "URI",
    homeTeam: "TEM",
    publishedToFeed: true,
    gameStatus: "upcoming",
  };
  vi.mocked(listGamesByDate).mockResolvedValue([row] as any);
  const request = vi.fn().mockRejectedValue(new Error("provider unavailable"));
  vi.stubGlobal("fetch", request);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const now = new Date("2026-09-05T23:00Z");
  await refreshNcaafScoresNow(now);
  expect(request).toHaveBeenCalledTimes(2);
  request.mockResolvedValue({
    ok: true,
    text: async () => html([temple, { ...temple, id: "999" }]),
  });
  await refreshNcaafScoresNow(now);
  vi.mocked(listGamesByDate).mockResolvedValue([
    { ...row, publishedToFeed: false },
  ] as any);
  request.mockClear();
  await refreshNcaafScoresNow(now);
  expect(request).not.toHaveBeenCalled();
  expect(updateNcaaStartTime).not.toHaveBeenCalled();
});
