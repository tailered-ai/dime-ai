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
import { updateNcaafMarkets } from "./db";

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
it("propagates history failure so the transaction rolls back rather than reporting success", async () => {
  state.fail = true;
  await expect(updateNcaafMarkets(input)).rejects.toThrow(
    "history write failed"
  );
  expect(state.rollbacks).toBe(1);
  expect(state.patch).toBeNull();
});
