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
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).max(1_000_000).optional(),
  })
  .refine(input => input.offset === undefined || input.limit !== undefined, {
    message: "offset requires limit",
    path: ["offset"],
  })
  .optional();

export type GamesListInput = z.infer<typeof gamesListInput>;

/** Raw-page cursor, calculated before registry/status filtering can shorten a page. */
export function gamesNextOffset(input: GamesListInput, rowCount: number) {
  return input?.limit !== undefined && rowCount === input.limit
    ? (input.offset ?? 0) + input.limit
    : undefined;
}
