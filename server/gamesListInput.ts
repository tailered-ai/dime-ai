import { z } from "zod";
import { zodGameDate, zodSport } from "./securityMiddleware";

/**
 * Public input contract for `games.list` — the feed hot path.
 *
 * Deliberately does NOT accept `forceRefresh`: the field was once part of this
 * schema, which let any unauthenticated caller bypass the 60s in-process games
 * cache and force a database round-trip per request (a per-request cost
 * amplifier for scrapers). Cache bypass is an internal capability of
 * `listGames()` only — it must never be wire-reachable from a public
 * procedure. z.object() strips unknown keys, so clients still sending the
 * field are silently ignored (covered by gamesListInput.test.ts).
 */
export const gamesListInput = z
  .object({
    sport: zodSport.or(z.literal("NFL")).optional(),
    gameDate: zodGameDate.optional(),
    gameStatus: z.enum(["upcoming", "live", "final"]).optional(),
  })
  .optional();

export type GamesListInput = z.infer<typeof gamesListInput>;
