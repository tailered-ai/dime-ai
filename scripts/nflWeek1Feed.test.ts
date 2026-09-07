import { describe, it, expect } from "vitest";
import { buildNflWeek1FeedRows, planNflWeek1Insertions } from "./nflWeek1Feed";
import games from "./data/nfl-2026/games.json";
import teams from "./data/nfl-2026/teams.json";
import venues from "./data/nfl-2026/venues.json";

describe("NFL Week 1 publication input", () => {
  it("maps exactly 16 ESPN games, 32 teams and Eastern dates without invented prices", () => {
    const rows = buildNflWeek1FeedRows(games, teams, venues);
    expect(rows).toHaveLength(16);
    expect(new Set(rows.flatMap(g => [g.awayTeam, g.homeTeam])).size).toBe(32);
    expect([...new Set(rows.map(g => g.gameDate))]).toEqual([
      "2026-09-09",
      "2026-09-10",
      "2026-09-13",
      "2026-09-14",
    ]);
    expect(rows[0]).toMatchObject({
      sport: "NFL",
      awayTeam: "NE",
      homeTeam: "SEA",
      startTimeEst: "20:20",
      fileId: 0,
      publishedToFeed: true,
      publishedModel: false,
    });
    expect(
      rows.every(
        g => !("modelTotal" in g) && !("bookTotal" in g) && !("awayScore" in g)
      )
    ).toBe(true);
    expect(rows[1].venue).toBe(
      venues.find(
        v => v.venueId === games.find(g => g.eventId === 401872657)!.venueId
      )!.name
    );
  });
  it("rejects incomplete or ambiguous identities instead of guessing joins", () => {
    expect(() => buildNflWeek1FeedRows([], teams, venues)).toThrow();
    expect(() =>
      buildNflWeek1FeedRows(games, teams.slice(1), venues)
    ).toThrow();
    expect(() =>
      buildNflWeek1FeedRows(
        [...games, games.find(g => g.seasonType === 2 && g.week === 1)!],
        teams,
        venues
      )
    ).toThrow();
  });
  it("replays without writes and rejects duplicates, hidden rows and rescheduled identities", () => {
    const rows = buildNflWeek1FeedRows(games, teams, venues);
    expect(planNflWeek1Insertions(rows, [])).toEqual(rows);
    const existing = rows.map(g => ({
      ...g,
      gameStatus: "final",
      awayScore: 31,
      modelTotal: "50.2",
    }));
    expect(planNflWeek1Insertions(rows, existing)).toEqual([]);
    expect(existing[0]).toMatchObject({ awayScore: 31, modelTotal: "50.2" });
    expect(() =>
      planNflWeek1Insertions(rows, [...existing, existing[0]])
    ).toThrow();
    expect(() =>
      planNflWeek1Insertions(rows, [{ ...existing[0], publishedToFeed: false }])
    ).toThrow();
    expect(() =>
      planNflWeek1Insertions(rows, [{ ...existing[0], gameDate: "2026-09-15" }])
    ).toThrow();
  });
});
