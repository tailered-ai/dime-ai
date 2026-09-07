import { beforeEach, afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  row: {} as any,
  history: [] as any[],
  patch: null as any,
  inserted: null as any,
  fail: false,
  rollbacks: 0,
}));
vi.mock("mysql2/promise", () => ({
  default: { createPool: () => ({ end: async () => {} }) },
}));
vi.mock("drizzle-orm/mysql2", () => ({
  drizzle: () => ({
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      let selected = 0;
      const chain: any = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        for: () => chain,
        then: (resolve: any) =>
          resolve(selected === 1 ? [state.row] : state.history),
      };
      try {
        return await work({
          select: () => {
            selected++;
            return chain;
          },
          update: () => ({
            set: (patch: any) => ({
              where: async () => {
                state.patch = patch;
              },
            }),
          }),
          insert: () => ({
            values: async (row: any) => {
              if (state.fail) throw new Error("history write failed");
              state.inserted = row;
            },
          }),
        });
      } catch (error) {
        state.patch = null;
        state.inserted = null;
        state.rollbacks++;
        throw error;
      }
    },
  }),
}));
import {
  updateNcaafMarkets,
  updateFootballMarket,
  reconcileFootballSchedule,
  bindFootballProvider,
} from "./db";

const input = {
  id: 4350069,
  gameDate: "2026-09-06",
  eventId: "288813",
  awayTeam: "WSU",
  homeTeam: "WASH",
  kickoff: Date.parse("2026-09-06T20:00:00Z"),
  capturedAt: Date.parse("2026-09-06T19:00:00Z"),
  source: "auto" as const,
  snapshot: {
    total: "51.5",
    overOdds: "-112",
    underOdds: "-108",
    spreadAwayBetsPct: 0,
  },
};
beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "mysql://localhost:3306/testdb");
  vi.useFakeTimers();
  vi.setSystemTime("2026-09-06T19:00:01Z");
  state.row = {
    id: input.id,
    gameDate: input.gameDate,
    sport: "NCAAF",
    ncaaContestId: input.eventId,
    awayTeam: input.awayTeam,
    homeTeam: input.homeTeam,
    gameStatus: "upcoming",
    publishedToFeed: true,
    modelTotal: "52.1",
    awayModelSpread: "21.1",
    homeModelSpread: "-21.1",
  };
  state.history = [];
  state.patch = null;
  state.inserted = null;
  state.fail = false;
  state.rollbacks = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("atomically records DK history and book/split fields without touching owner models", async () => {
  expect(await updateNcaafMarkets(input)).toBe(true);
  expect(state.patch).toMatchObject({
    bookTotal: "51.5",
    oddsSource: "dk",
    spreadAwayBetsPct: 0,
  });
  expect(Object.keys(state.patch).some(key => /model/i.test(key))).toBe(false);
  expect(state.inserted).toMatchObject({
    gameId: input.id,
    sport: "NCAAF",
    scrapedAt: input.capturedAt,
    lineSource: "dk",
    total: "51.5",
  });
});
it("rejects a changed parent, freezes started games, and skips replay/older observations", async () => {
  state.row.homeTeam = "OTHER";
  await expect(updateNcaafMarkets(input)).rejects.toThrow(/identity/);
  state.row.homeTeam = "WASH";
  state.row.gameStatus = "live";
  expect(await updateNcaafMarkets(input)).toBe(false);
  state.row.gameStatus = "upcoming";
  state.history = [{ scrapedAt: input.capturedAt }];
  expect(await updateNcaafMarkets(input)).toBe(false);
  expect(state.patch).toBeNull();
});
it.each(["an", "vsin"] as const)(
  "only changes and records observed fields when %s alone succeeded",
  async provider => {
    state.row.bookTotal = "49.5";
    state.row.totalOverBetsPct = 65;
    expect(
      await updateNcaafMarkets({
        ...input,
        providers: { an: provider === "an", vsin: provider === "vsin" },
      })
    ).toBe(true);
    if (provider === "an") {
      expect(state.patch.bookTotal).toBe("51.5");
      expect(state.patch).not.toHaveProperty("totalOverBetsPct");
      expect(state.inserted).not.toHaveProperty("spreadAwayBetsPct");
      expect(state.patch.ingestionRunId).toContain("ncaaf-an68:");
    } else {
      expect(state.patch.spreadAwayBetsPct).toBe(0);
      expect(state.patch).not.toHaveProperty("bookTotal");
      expect(state.patch).not.toHaveProperty("oddsSource");
      expect(state.inserted).not.toHaveProperty("total");
      expect(state.patch.ingestionRunId).toContain("ncaaf-vsin-dk:");
    }
    expect(Object.keys(state.patch).some(key => /model/i.test(key))).toBe(
      false
    );
  }
);
it("rejects an observation without any verified provider", async () => {
  await expect(
    updateNcaafMarkets({ ...input, providers: { an: false, vsin: false } })
  ).rejects.toThrow(/provider/);
  expect(state.patch).toBeNull();
});
it.each(["both", "an", "vsin"] as const)(
  "rolls back %s provider changes when history fails",
  async provider => {
    state.fail = true;
    await expect(
      updateNcaafMarkets({
        ...input,
        providers: { an: provider !== "vsin", vsin: provider !== "an" },
      })
    ).rejects.toThrow("history write failed");
    expect(state.rollbacks).toBe(1);
    expect(state.patch).toBeNull();
  }
);

const binding = {
  scheduleKey: "espn:nfl:2026:401872656",
  scheduleRevision: "verified-fixture",
  kickoff: input.kickoff,
  awayTeam: "NE",
  homeTeam: "SEA",
  an: { eventId: 999, awayTeamId: 10, homeTeamId: 20 },
  vsin: {
    eventId: "20260909NFL00061",
    awaySlug: "new-england-patriots",
    homeSlug: "seattle-seahawks",
  },
};
function footballInput() {
  state.row = {
    ...state.row,
    sport: "NFL",
    awayTeam: "NE",
    homeTeam: "SEA",
    footballScheduleId: binding.scheduleKey,
    footballBinding: binding,
    footballMarketState: {},
  };
  return {
    id: input.id,
    sport: "NFL" as const,
    binding,
    observation: {
      provider: "an_dk" as const,
      eventId: "999",
      receivedAt: input.capturedAt,
      sourceUpdatedAt: null,
      sourceUrl:
        "https://api.actionnetwork.com/web/v2/scoreboard/nfl?bookIds=68&periods=event&date=20260906",
      responseSha256: "a".repeat(64),
      snapshot: { total: "51.5", overOdds: "-112", underOdds: "-108" },
    },
    source: "auto" as const,
  };
}
it("commits football provider-specific history, retains missing values and leaves unrelated provider/model data unchanged", async () => {
  const request = footballInput();
  state.row.awayML = "+150";
  state.row.footballMarketState.vsin_dk = { receivedAt: input.capturedAt + 1 };
  expect(await updateFootballMarket(request)).toBe(true);
  expect(state.patch).toMatchObject({
    bookTotal: "51.5",
    footballMarketState: { vsin_dk: { receivedAt: input.capturedAt + 1 } },
  });
  expect(state.patch).not.toHaveProperty("awayML");
  expect(state.patch).not.toHaveProperty("modelTotal");
  expect(state.inserted).toMatchObject({
    provider: "an_dk",
    total: "51.5",
    replayKey: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  state.row.footballMarketState = state.patch.footballMarketState;
  state.patch = null;
  expect(await updateFootballMarket(request)).toBe(false);
  expect(state.patch).toBeNull();
});
it("fences late football writes, rechecks provider identity under the row lock, and rolls back failed history", async () => {
  const request = footballInput();
  await expect(
    updateFootballMarket({ ...request, signal: AbortSignal.abort() })
  ).rejects.toThrow();
  state.row.footballBinding.an.eventId = 1000;
  await expect(
    updateFootballMarket({
      ...request,
      observation: { ...request.observation, eventId: "999" },
    })
  ).rejects.toThrow(/identity/);
  state.row.footballBinding.an.eventId = 999;
  state.fail = true;
  await expect(updateFootballMarket(request)).rejects.toThrow(
    "history write failed"
  );
  expect(state.patch).toBeNull();
});

it("binds the existing Patriots row without inserting a duplicate or rewriting model/score fields", async () => {
  footballInput();
  state.row.footballScheduleId = null;
  state.row.footballBinding = null;
  state.row.ingestionRunId = "espn:nfl:2026:2:1:401872656";
  const row = {
    fileId: 0,
    sport: "NFL",
    gameDate: input.gameDate,
    startTimeEst: "16:00",
    awayTeam: "NE",
    homeTeam: "SEA",
    publishedToFeed: true,
    publishedModel: false,
    gameStatus: "upcoming" as const,
    footballScheduleId: binding.scheduleKey,
    footballBinding: binding,
  };
  expect(await reconcileFootballSchedule("NFL", [row])).toMatchObject({
    inserted: 0,
    bound: 1,
  });
  expect(state.inserted).toBeNull();
  expect(state.patch).toMatchObject({
    footballScheduleId: binding.scheduleKey,
  });
  expect(state.patch).not.toHaveProperty("publishedModel");
  expect(state.patch).not.toHaveProperty("modelTotal");
  expect(state.patch).not.toHaveProperty("awayScore");
});
it("rejects changes to an established provider crosswalk", async () => {
  footballInput();
  await expect(
    bindFootballProvider(input.id, binding, "an_dk", {
      eventId: 1001,
      awayTeamId: 10,
      homeTeamId: 20,
    })
  ).rejects.toThrow(/identity/);
});
it("retains a newer schedule revision and cannot reopen a started event", async () => {
  footballInput();
  state.row.footballBinding = { ...binding, scheduleReceivedAt: 200 };
  const row = {
    fileId: 0,
    sport: "NFL",
    gameDate: input.gameDate,
    awayTeam: "NE",
    homeTeam: "SEA",
    footballScheduleId: binding.scheduleKey,
    footballBinding: { ...binding, scheduleReceivedAt: 100 },
  };
  expect(await reconcileFootballSchedule("NFL", [row])).toMatchObject({
    bound: 0,
  });
  expect(state.patch).toBeNull();
});
it("rejects contradictory split pairs at the persistence boundary", async () => {
  const request = footballInput();
  await expect(
    updateFootballMarket({
      ...request,
      observation: {
        ...request.observation,
        provider: "vsin_dk",
        eventId: binding.vsin.eventId,
        sourceUrl: "https://data.vsin.com/betting-splits/?source=DK&sport=NFL",
        snapshot: { spreadAwayBetsPct: 60, spreadHomeBetsPct: 60 },
      },
    })
  ).rejects.toThrow(/Contradictory/);
  expect(state.patch).toBeNull();
});
