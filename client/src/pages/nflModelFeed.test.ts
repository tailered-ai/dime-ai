import { describe, expect, it } from "vitest";
import {
  nflRowToCard,
  buildFeedSections,
  parseFeedModelPath,
} from "./DimeModelFeed";
import { gamesListInput } from "../../../server/gamesListInput";
import { sportAdapters } from "@/lib/sport/presentation";
import { presentationToProjectionGame } from "@/components/projections/fromPresentation";

describe("NFL Model Feed", () => {
  it("accepts dated NFL navigation and the read-only games query", () => {
    expect(parseFeedModelPath("nfl-09-09-2026", undefined)).toEqual({
      sport: "NFL",
      isoDate: "2026-09-09",
    });
    expect(
      gamesListInput.parse({
        sport: "NFL",
        gameDate: "2026-09-09",
        forceRefresh: true,
      })
    ).toEqual({ sport: "NFL", gameDate: "2026-09-09" });
  });
  it("uses NFL names, helmets and three markets without inventing scores or prices", () => {
    const card = nflRowToCard({
      id: 17,
      awayTeam: "NE",
      homeTeam: "SEA",
      gameDate: "2026-09-09",
      startTimeEst: "20:20",
      gameStatus: "upcoming",
    } as never);
    expect(card.away.name).toBe("New England Patriots");
    expect(card.home.name).toBe("Seattle Seahawks");
    expect(card.away.crest.url).toBe("/brand/nfl-helmets/NE.webp");
    expect(card.markets).toHaveLength(3);
    expect(
      card.markets
        .flatMap(m => m.rows)
        .every(r => r.model === "—" && r.book === "—")
    ).toBe(true);
    expect(card.modelPublished).toBe(false);
    expect(card.away.score).toBeNull();
    const game = presentationToProjectionGame(
      sportAdapters.NFL(card, { competition: "NFL" })
    );
    expect(game.league).toBe("NFL");
    expect(game.away.logo).toBe("/brand/nfl-helmets/NE.webp");
    expect(buildFeedSections([], [], [], [card]).map(s => s.key)).toEqual([
      "NFL",
    ]);
  });
});
