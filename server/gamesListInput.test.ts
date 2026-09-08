import { describe, expect, it } from "vitest";
import { gamesListInput, gamesNextOffset } from "./gamesListInput";

describe("gamesListInput", () => {
  it("accepts the supported public filters", () => {
    const parsed = gamesListInput.parse({
      sport: "MLB",
      gameDate: "2026-08-05",
      gameStatus: "upcoming",
    });
    expect(parsed).toEqual({
      sport: "MLB",
      gameDate: "2026-08-05",
      gameStatus: "upcoming",
    });
  });

  it("accepts an omitted input (public feed default)", () => {
    expect(gamesListInput.parse(undefined)).toBeUndefined();
  });

  it("strips forceRefresh — the public cache bypass is not wire-reachable", () => {
    // Regression guard: games.list once accepted forceRefresh: boolean, letting
    // any unauthenticated caller bypass the 60s games cache and force a TiDB
    // round-trip per request (amplification lever for scrapers).
    const parsed = gamesListInput.parse({ sport: "MLB", forceRefresh: true });
    expect(parsed).not.toHaveProperty("forceRefresh");
    expect(parsed).toEqual({ sport: "MLB" });
  });
});

it("accepts bounded pages and rejects invalid pagination", () => {
  expect(gamesListInput.parse({ limit: 200, offset: 0 })).toEqual({
    limit: 200,
    offset: 0,
  });
  for (const input of [
    { limit: 0 },
    { limit: 201 },
    { limit: 1.5 },
    { limit: 10, offset: -1 },
    { limit: 10, offset: 0.5 },
    { offset: 10 },
  ]) {
    expect(gamesListInput.safeParse(input).success).toBe(false);
  }
});

it("reports the next raw page independently of later registry filtering", () => {
  expect(gamesNextOffset({ limit: 100 }, 100)).toBe(100);
  expect(gamesNextOffset({ limit: 100, offset: 100 }, 100)).toBe(200);
  expect(gamesNextOffset({ limit: 100, offset: 200 }, 99)).toBeUndefined();
  expect(gamesNextOffset({ limit: 100, offset: 300 }, 0)).toBeUndefined();
  expect(gamesNextOffset(undefined, 100)).toBeUndefined();
});
