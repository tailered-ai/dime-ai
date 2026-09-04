import { TRPCError } from "@trpc/server";
import { presentNcaafSeptember4, presentNcaafSeptember4History } from "../shared/ncaafSeptember4";
import { gamesListInput } from "./gamesListInput";
import {
  applyMlbMarketGatesToGame,
  applyMlbMarketGatesToHrProp,
  applyMlbMarketGatesToStrikeoutProp,
  isOwnerRequest,
  isRequestAuthenticated,
  isGamesListAuthenticated,
  setGatedCacheHeaders,
  GATED_FEED_VARY,
  stripGameModelFields,
  stripHrPropModelFields,
  stripStrikeoutPropModelFields,
} from "./feedGating";
import {
  anyMarketGated,
  getMlbMarketGateSnapshot,
  mlbMarketGateMode,
  type MlbMarketGates,
} from "./mlbMarketGates";

/**
 * Resolve the MLB per-market publication gate for a PROP procedure.
 *
 * Returns null when nothing should be nulled, so callers skip the work
 * entirely. Owner requests always return null: owner backtest surfaces are
 * deliberately ungated — they are the BACKTEST-ONLY audience, and
 * /admin/model-results consumes these PUBLIC prop procedures to render
 * modelPHr / edgeOver / backtestResult.
 *
 * The owner check runs LAST so it costs nothing while the flag is off.
 */
async function resolveMlbPropGates(
  req: Parameters<typeof isRequestAuthenticated>[0]
): Promise<MlbMarketGates | null> {
  if (mlbMarketGateMode() !== "on") return null;
  const gates = await getMlbMarketGateSnapshot();
  if (!anyMarketGated(gates)) return null;
  if (await isOwnerRequest(req)) return null;
  return gates;
}
import { z } from "zod";
import {
  zodGameDate,
  zodSport,
  zodTeamId,
  zodDbSlug,
  zodFilePath,
  zodPitcherRsId,
  zodHtmlPaste,
  zodGameIdArray,
  MAX_GAME_IDS_PER_REQUEST,
} from "./securityMiddleware";
import { systemRouter } from "./_core/systemRouter";
import { wc2026Router } from "./wc2026/wc2026Router";
import { publicProcedure, router } from "./_core/trpc";
import {
  insertGames,
  listGames,
  listStagingGames,
  listStagingGamesRange,
  updateGameProjections,
  setGamePublished,
  setGameModelPublished,
  bulkApproveModels,
  publishAllStagingGames,
  getActiveSports,
  getAvailableDates,
} from "./db";
import { appUsersRouter, ownerProcedure, appUserProcedure } from "./routers/appUsers";
import { sportsReadProcedure } from "./_core/machineAuth";
import { betTrackerRouter } from "./routers/betTracker";
import { dimeChatsRouter } from "./routers/dimeChats";
import { securityRouter } from "./routers/security";
import { metricsRouter } from "./routers/metrics";
import { analyticsRouter } from "./routers/analytics";
import { mlbScheduleRouter } from "./routers/mlbSchedule";
import { nbaScheduleRouter } from "./routers/nbaSchedule";
import { nhlScheduleRouter } from "./routers/nhlSchedule";
import { stripeRouter } from "./routers/stripe";
import { subscriptionPlansRouter } from "./routers/subscriptionPlans";
import { claudeRouter } from "./claudeRouter";
import { waitlistRouter } from "./routers/waitlist";
import { dimeRuntimeRouter } from "./routers/dimeRuntime";
import { listNbaTeams, getNbaTeamByDbSlug, getGameTeamColors, deleteGameById, getFavoriteGameIds, getFavoriteGamesWithDates, toggleFavoriteGame, updateAnOdds, listGamesByDate, listOddsHistory, getBracketGames, auditAndAdvanceAllBracketWinners, getMlbLineupsByGameIds, getStrikeoutPropsByGame, getStrikeoutPropsByGames, getMlbGameEnvSignals, getHrPropsByGame, getHrPropsByGames } from "./db";
import { runStrikeoutModel, type StrikeoutRunnerInput } from "./strikeoutModelRunner";
import { getLastRefreshResult, runVsinRefreshManual, refreshAllScoresNow } from "./vsinAutoRefresh";
import { syncNhlModelForToday, getLastNhlSyncResult } from "./nhlModelSync";
import { runMlbModelForDate, validateMlbModelResults } from "./mlbModelRunner";
import { checkGoalieChanges, getLastGoalieWatchResult } from "./nhlGoalieWatcher";
import { MARCH_MADNESS_DB_SLUGS } from "@shared/marchMadnessTeams";
import { parseAnAllMarketsHtml, type AnSport } from "./anHtmlParser";
import { NBA_VALID_DB_SLUGS, NBA_TEAMS } from "@shared/nbaTeams";
import { NHL_VALID_DB_SLUGS, NHL_TEAMS } from "@shared/nhlTeams";
import { MLB_VALID_DB_SLUGS, MLB_VALID_ABBREVS } from "@shared/mlbTeams";
import CFB_TEAMS from "../scripts/data/cfb-2026/teams.json";
import { createHash } from 'node:crypto';

const NCAAF_VALID_ABBREVS = new Set(CFB_TEAMS.map((team) => team.espnAbbreviation));

/**
 * Strip fields that are always null for the given sport from the game object.
 * This reduces the JSON payload size dramatically:
 *   MLB: removes NHL goalie fields, bracket fields, NCAA-only fields → ~40% smaller
 *   NHL: removes MLB pitcher/F5/NRFI/HR fields → ~50% smaller
 *   NBA: removes MLB/NHL-specific fields → ~55% smaller
 *
 * Fields are stripped at the procedure layer (after cache) so the cache always
 * stores the full Game object — only the wire payload is reduced.
 *
 * SAFETY: Only strips fields that are structurally impossible for the sport
 * (e.g. NHL games never have F5 innings, MLB games never have goalies).
 * Fields that are null for TODAY but could be non-null in future are NOT stripped.
 */
function stripSportNullFields<T extends import('../drizzle/schema').Game>(game: T): T {
  const g = game as Record<string, unknown>;
  const sport = game.sport;

  // Fields that are NEVER used by any frontend page for any sport — always strip
  const alwaysStrip = [
    'fileId',           // internal DB reference, never shown in UI
    'ncaaContestId',    // NCAA dedup key, never shown in UI
    'bracketGameId', 'bracketRound', 'bracketRegion', 'bracketSlot',
    'nextBracketGameId', 'nextBracketSlot',  // March Madness bracket — season is over
    'rotNums',          // WagerTalk rotation numbers, not shown in public feed
    'oddsSource',       // internal odds source tracking
    'fgBacktestRunAt', 'f5BacktestRunAt', 'nrfiBacktestRunAt', 'outcomeIngestedAt',
  ] as const;

  // NHL-only fields: strip from non-NHL games
  const nhlOnlyFields = [
    'awayGoalie', 'homeGoalie', 'awayGoalieConfirmed', 'homeGoalieConfirmed',
    'modelAwayPLCoverPct', 'modelHomePLCoverPct',
    'modelAwayPuckLine', 'modelHomePuckLine',
    'modelAwayPLOdds', 'modelHomePLOdds',
  ] as const;

  // MLB-only fields: strip from non-MLB games
  const mlbOnlyFields = [
    'mlbGamePk', 'broadcaster', 'venue', 'doubleHeader', 'gameNumber',
    'awayStartingPitcher', 'homeStartingPitcher', 'awayPitcherConfirmed', 'homePitcherConfirmed',
    'awayRunLine', 'homeRunLine', 'awayRunLineOdds', 'homeRunLineOdds',
    'rlAwayBetsPct', 'rlAwayMoneyPct',
    // F5 fields
    'f5AwayRunLine', 'f5HomeRunLine', 'f5AwayRunLineOdds', 'f5HomeRunLineOdds',
    'f5Total', 'f5OverOdds', 'f5UnderOdds', 'f5AwayML', 'f5HomeML',
    'modelF5AwayScore', 'modelF5HomeScore', 'modelF5Total',
    'modelF5OverRate', 'modelF5UnderRate', 'modelF5AwayWinPct', 'modelF5HomeWinPct',
    'modelF5AwayML', 'modelF5HomeML',
    'modelF5AwayRLCoverPct', 'modelF5HomeRLCoverPct',
    'modelF5AwayRlOdds', 'modelF5HomeRlOdds',
    'modelF5OverOdds', 'modelF5UnderOdds',
    'modelF5PushPct', 'modelF5PushRaw',
    'actualF5AwayScore', 'actualF5HomeScore',
    'f5MlResult', 'f5RlResult', 'f5TotalResult',
    'f5MlCorrect', 'f5RlCorrect', 'f5TotalCorrect',
    // NRFI fields
    'nrfiOverOdds', 'yrfiUnderOdds', 'modelPNrfi', 'modelNrfiOdds', 'modelYrfiOdds',
    'nrfiActualResult', 'nrfiBacktestResult', 'nrfiCorrect',
    'nrfiCombinedSignal', 'nrfiFilterPass',
    // HR Props
    'modelAwayHrPct', 'modelHomeHrPct', 'modelBothHrPct', 'modelAwayExpHr', 'modelHomeExpHr',
    // Inning-by-inning
    'modelInningHomeExp', 'modelInningAwayExp', 'modelInningTotalExp',
    'modelInningPHomeScores', 'modelInningPAwayScores', 'modelInningPNeitherScores',
    // MLB-specific model fields
    'modelProjTotal', 'modelWeatherAdj',
    // MLB backtest
    'actualFgTotal', 'actualF5Total', 'actualNrfiBinary',
    'brierFgTotal', 'brierF5Total', 'brierNrfi', 'brierFgMl', 'brierF5Ml',
    'fgMlResult', 'fgRlResult', 'fgTotalResult',
    'fgMlCorrect', 'fgRlCorrect', 'fgTotalCorrect',
  ] as const;

  const result = { ...g };

  // Always strip internal fields
  for (const f of alwaysStrip) delete result[f];

  // Strip sport-specific fields
  if (sport !== 'NHL') for (const f of nhlOnlyFields) delete result[f];
  if (sport !== 'MLB') for (const f of mlbOnlyFields) delete result[f];

  return result as T;
}

/** Returns true if both teams are in the appropriate registry for the given sport */
export function isValidGame(awayTeam: string, homeTeam: string, sport?: string | null): boolean {
  if (sport === "NBA") {
    return NBA_VALID_DB_SLUGS.has(awayTeam) && NBA_VALID_DB_SLUGS.has(homeTeam);
  }
  if (sport === "NHL") {
    return NHL_VALID_DB_SLUGS.has(awayTeam) && NHL_VALID_DB_SLUGS.has(homeTeam);
  }
  if (sport === "MLB") {
    // Teams may be stored as abbreviations (e.g. "NYY") from the schedule seeder
    // or as dbSlugs (e.g. "yankees") from VSiN. Accept both.
    const awayOk = MLB_VALID_ABBREVS.has(awayTeam) || MLB_VALID_DB_SLUGS.has(awayTeam);
    const homeOk = MLB_VALID_ABBREVS.has(homeTeam) || MLB_VALID_DB_SLUGS.has(homeTeam);
    return awayOk && homeOk;
  }
  if (sport === "NCAAF") {
    return NCAAF_VALID_ABBREVS.has(awayTeam) && NCAAF_VALID_ABBREVS.has(homeTeam);
  }
  // Unknown sport: fall back to MARCH_MADNESS registry
  return MARCH_MADNESS_DB_SLUGS.has(awayTeam) && MARCH_MADNESS_DB_SLUGS.has(homeTeam);
}

/**
 * The single pinned game the public landing-page odds sample may show:
 * a COMPLETED MLB matchup, resolved by date + teams rather than a hardcoded
 * row id so it survives re-ingests. Nothing about this is caller-controlled.
 */
const DEMO_GAME = {
  gameDate: "2026-07-24",
  sport: "MLB",
  teams: ["CHC", "PIT"],
} as const;

async function findDemoGame() {
  try {
    const slate = await listGamesByDate(DEMO_GAME.gameDate, DEMO_GAME.sport);
    const isDemoTeam = (name: string) =>
      (DEMO_GAME.teams as readonly string[]).includes(name);
    const match = slate.find(
      g => isDemoTeam(g.awayTeam) && isDemoTeam(g.homeTeam)
    );
    return match ?? null;
  } catch (err) {
    console.warn(`[oddsHistory.listForDemoGame] demo lookup failed:`, err);
    return null;
  }
}

export const appRouter = router({
  system: systemRouter,
  appUsers: appUsersRouter,
  betTracker: betTrackerRouter,
  dimeChats: dimeChatsRouter,
  security: securityRouter,
  metrics: metricsRouter,
  analytics: analyticsRouter,
  mlbSchedule: mlbScheduleRouter,
  nbaSchedule: nbaScheduleRouter,
  nhlSchedule: nhlScheduleRouter,
  stripe: stripeRouter,
  subscriptionPlans: subscriptionPlansRouter,
  wc2026: wc2026Router,
  claude: claudeRouter,
  waitlist: waitlistRouter,
  dimeRuntime: dimeRuntimeRouter,

  // ─── NBA Teams ─────────────────────────────────────────────────────
  nbaTeams: router({
    /** List all 30 NBA teams from DB. */
    list: publicProcedure.query(async () => {
      return listNbaTeams();
    }),

    /** Get a single NBA team by its DB slug (e.g. "boston_celtics"). */
    byDbSlug: publicProcedure
      .input(z.object({ dbSlug: zodDbSlug }))
      .query(async ({ input }) => {
        return getNbaTeamByDbSlug(input.dbSlug);
      }),
  }),

  // ─── Games ─────────────────────────────────────────────────────────────────
  games: router({
    /**
     * List all games, optionally filtered by sport and/or date.
     * PUBLIC — feed is now fully public; unauthenticated users can view projections.
     */
    list: publicProcedure
      // SEC: input contract lives in gamesListInput — it deliberately has no
      // forceRefresh field (public cache-bypass amplification lever, removed).
      .input(gamesListInput)
      .query(async ({ input, ctx }) => {
        // [tRPC][games.list] — hot path log silenced (fires every 60s per user)
        const games = await listGames(input ?? {});
        // Filter by the appropriate registry based on sport
        let filtered = games.filter(g => isValidGame(g.awayTeam, g.homeTeam, g.sport));
        // Filter by game status if provided
        if (input?.gameStatus) {
          filtered = filtered.filter(g => g.gameStatus === input.gameStatus);
        }
        // Performance: strip sport-specific null fields before serialization.
        // This reduces the JSON payload by 40-55% depending on sport:
        //   MLB (111 games × 175 fields): 425KB → ~250KB
        //   NHL/NBA (fewer games, fewer fields): proportionally smaller
        // Cache stores full Game objects; stripping happens at the wire layer only.
        const stripped = filtered.map(g => stripSportNullFields(presentNcaafSeptember4(g)));

        // IP gating (Phase 3): the model projections/edges are the paid product.
        // Anonymous callers get commodity fields only (schedule, book lines,
        // splits) — the model fields are nulled at the wire layer. Authenticated
        // callers get the full payload. The feed SURFACE is already RequireAuth
        // -gated, so logged-in UX is unchanged; this closes the anonymous API
        // scrape of the model IP.
        // MLB per-market publication gate. The 2026 audit ruled markets
        // BACKTEST-ONLY and wrote publish_* verdict rows; this enforces them.
        // Inert unless MLB_MARKET_GATE_MODE=on — in "off"/"log" the snapshot is
        // the all-published identity, so `published` IS `stripped` (same array
        // reference, same bytes). See server/mlbMarketGates.ts.
        //
        // Deliberately NO owner exemption here: TheModelResults consumes this
        // procedure only for game ids and team names, and exempting owners
        // would create a verification blind spot — the owner loading /feed with
        // the gate enforced must see what a subscriber sees.
        const marketGates = await getMlbMarketGateSnapshot();
        const enforceMarketGates =
          mlbMarketGateMode() === "on" && anyMarketGated(marketGates);
        const published = enforceMarketGates
          ? stripped.map(g =>
              g.sport === "MLB" ? applyMlbMarketGatesToGame(g, marketGates) : g
            )
          : stripped;

        const authed = await isGamesListAuthenticated(ctx.req);
        const gated = authed ? published : published.map(g => stripGameModelFields(g));

        // Cache-Control + ETag. Authed responses carry the model IP and MUST NOT
        // be shared-cached (a CDN/edge could serve them to an anon); anon
        // responses are commodity and may be shared-cached. ETag over the
        // GATED shape so authed/anon never collide on the same validator.
        //
        // Authed = `private, no-store` (NOT max-age): (1) closes this endpoint's
        // own edge-cache exposure of MLB model IP under a Cloudflare
        // "Override-TTL / Cache Everything" rule that ignores `private`+`Vary`;
        // (2) games.list and wc2026.matchesByDate co-batch into ONE tRPC HTTP
        // response sharing one `ctx.res` — last-writer-wins on Cache-Control.
        // Making BOTH authed model endpoints emit `no-store` makes that race
        // benign (uniform no-store) regardless of which procedure resolves last.
        // Fast-follow: a responseMeta hook that emits the most-restrictive
        // Cache-Control across an arbitrary batch removes the race entirely.
        try {
          // The fingerprint deliberately includes the gate state ONLY when
          // enforcing: modelRunAt is never nulled by a market gate, so without
          // this a gated response would share a validator with the ungated one
          // and a cache could serve pre-gate bytes after a flip. When not
          // enforcing, the input is byte-identical to before this change.
          const etag = createHash('md5')
            .update(JSON.stringify(gated.map(g => ({ id: g.id, modelRunAt: g.modelRunAt, gameStatus: g.gameStatus }))))
            .update(enforceMarketGates ? JSON.stringify(marketGates) : '')
            .digest('hex')
            .slice(0, 16);
          ctx.res.setHeader(
            'Cache-Control',
            authed ? 'private, no-store' : 'public, max-age=30, stale-while-revalidate=60'
          );
          ctx.res.setHeader('Vary', GATED_FEED_VARY);
          ctx.res.setHeader('ETag', `"${etag}"`);
          ctx.res.setHeader('X-Games-Count', String(gated.length));
          ctx.res.setHeader('X-Cache-Status', 'MISS'); // overridden by cache layer if HIT
        } catch {
          // Non-fatal: header setting can fail in some edge cases
        }
        return gated;
      }),

    /**
     * Return the sorted list of distinct gameDates for a sport.
     * Used by the client calendar picker to show which dates have games.
     * PUBLIC — same access as games.list.
     *
     * Returns dates in the same 7-day MLB rolling window as games.list,
     * so the calendar always shows exactly the dates the feed will display.
     * This query is separate from games.list so the feed can use an exact
     * gameDate filter (no boundary mismatch) while the calendar still shows
     * the full range of available dates.
     */
    getAvailableDates: publicProcedure
      .input(z.object({ sport: zodSport }))
      .query(async ({ input }) => {
        // [tRPC][games.getAvailableDates] — hot path log silenced (fires every 5min per user)
        const dates = await getAvailableDates(input.sport);
        // Compute the server-authoritative window start date (same logic as getCurrentDate)
        // so the client can guard the auto-advance correctly.
        const FEED_CUTOFF_UTC_HOUR = 11;
        const nowMs = Date.now();
        const nowUtc = new Date(nowMs);
        const isBeforeCutoff = nowUtc.getUTCHours() < FEED_CUTOFF_UTC_HOUR;
        const windowStartMs = isBeforeCutoff ? nowMs - 24 * 60 * 60 * 1000 : nowMs;
        const windowStartDate = new Date(windowStartMs);
        const effectiveDate = [
          windowStartDate.getUTCFullYear(),
          String(windowStartDate.getUTCMonth() + 1).padStart(2, '0'),
          String(windowStartDate.getUTCDate()).padStart(2, '0'),
        ].join('-');
        // CRITICAL: effectiveDate injection is MLB-ONLY.
        // For MLB: inject effectiveDate so the calendar always shows today even if
        // no games have been ingested yet (prevents auto-advance past today on opening day).
        // For NHL/NBA: do NOT inject effectiveDate if there are no games on that date.
        // If effectiveDate is not in the DB dates list, the client auto-advance will
        // correctly advance to the first real game date (e.g. June 5 → June 6 for NHL).
        // [FIX] Bug: NHL effectiveDate injection caused the client to see June 5 as a
        // valid date with 0 games, blocking auto-advance to June 6 (CAR@VGK).
        const isMlb = input.sport === 'MLB';
        const datesWithEffective = (isMlb && !dates.includes(effectiveDate))
          ? [effectiveDate, ...dates].sort()
          : dates;
        console.log(
          `[DIAG][getAvailableDates] sport=${input.sport} effectiveDate=${effectiveDate} ` +
          `injected=${isMlb && !dates.includes(effectiveDate)} ` +
          `dates=${datesWithEffective.length} (${datesWithEffective.slice(0,3).join(', ')}...) ` +
          `utcHour=${nowUtc.getUTCHours()} beforeCutoff=${isBeforeCutoff}`
        );
        return { dates: datesWithEffective, effectiveDate, isBeforeCutoff };
      }),

    /**
     * Returns the server-authoritative effective feed date.
     * Uses the same isBeforeCutoff logic as todayUTC() on the client.
     * The client should use this as the default selectedDate to eliminate
     * any possibility of client/server date disagreement.
     * Cached for 60s — the date only changes at 11:00 UTC once per day.
     */
    getCurrentDate: publicProcedure.query(() => {
      const FEED_CUTOFF_UTC_HOUR = 11;
      const nowMs = Date.now();
      const nowUtc = new Date(nowMs);
      const isBeforeCutoff = nowUtc.getUTCHours() < FEED_CUTOFF_UTC_HOUR;
      const effectiveMs = isBeforeCutoff ? nowMs - 24 * 60 * 60 * 1000 : nowMs;
      const d = new Date(effectiveMs);
      const effectiveDate = [
        d.getUTCFullYear(),
        String(d.getUTCMonth() + 1).padStart(2, '0'),
        String(d.getUTCDate()).padStart(2, '0'),
      ].join('-');
      // [tRPC][games.getCurrentDate] — hot path log silenced (fires every 5min per user)
      return { effectiveDate, utcHour: nowUtc.getUTCHours(), isBeforeCutoff };
    }),

    /**
     * List all staging games for a given date.
     * Owner-only — used by the Publish Model Projections page.
     */
    listStaging: ownerProcedure
      .input(z.object({ gameDate: zodGameDate, sport: zodSport.optional() }))
      .query(async ({ input }) => {
        const games = await listStagingGames(input.gameDate, input.sport);
        return games.filter(g => isValidGame(g.awayTeam, g.homeTeam, g.sport));
      }),

    /**
     * Update model projections (spreads, total, edge labels) for a single game.
     * Owner-only.
     */
    updateProjections: ownerProcedure
      .input(
        z.object({
          id: z.number().int().positive(),
          awayModelSpread: z.string().max(50).nullable().optional(),
          homeModelSpread: z.string().max(50).nullable().optional(),
          modelTotal: z.string().max(50).nullable().optional(),
          modelAwayML: z.string().max(50).nullable().optional(),
          modelHomeML: z.string().max(50).nullable().optional(),
          spreadEdge: z.string().max(50).nullable().optional(),
          spreadDiff: z.string().max(50).nullable().optional(),
          totalEdge: z.string().max(50).nullable().optional(),
          totalDiff: z.string().max(50).nullable().optional(),
          // NHL-specific odds fields
          awaySpreadOdds: z.string().max(50).nullable().optional(),
          homeSpreadOdds: z.string().max(50).nullable().optional(),
          overOdds: z.string().max(50).nullable().optional(),
          underOdds: z.string().max(50).nullable().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await updateGameProjections(id, data);
        return { success: true };
      }),

    /**
     * Toggle publishedToFeed for a single game.
     * Owner-only.
     */
    setPublished: ownerProcedure
      .input(z.object({ id: z.number().int().positive(), published: z.boolean() }))
      .mutation(async ({ input }) => {
        await setGamePublished(input.id, input.published);
        return { success: true };
      }),

    /**
     * Approve or retract model projections for a single game.
     * Owner-only. When approved (published=true), model fields become visible on the public feed.
     */
    setModelPublished: ownerProcedure
      .input(z.object({ id: z.number().int().positive(), published: z.boolean() }))
      .mutation(async ({ input }) => {
        await setGameModelPublished(input.id, input.published);
        return { success: true };
      }),

    /**
     * Bulk-approve all pending model projections for a date.
     * Only approves games that have model data (awayModelSpread + modelTotal not null)
     * and are not yet approved (publishedModel = false).
     * Owner-only.
     */
    bulkApproveModels: ownerProcedure
      .input(z.object({ gameDate: zodGameDate, sport: zodSport.optional() }))
      .mutation(async ({ input }) => {
        const count = await bulkApproveModels(input.gameDate, input.sport);
        console.log(`[tRPC] games.bulkApproveModels: gameDate=${input.gameDate} sport=${input.sport ?? 'all'} — approved ${count} games`);
        return { success: true, approved: count };
      }),

    /**
     * Publish all staging games for a date at once.
     * Owner-only.
     */
    publishAll: ownerProcedure
      .input(z.object({ gameDate: zodGameDate, sport: zodSport.optional() }))
      .mutation(async ({ input }) => {
        const sportLabel = input.sport ?? "ALL";
        console.log(
          `[tRPC][publishAll] ► Owner triggered Publish All — scope: ${sportLabel} | ` +
          `date: ${input.gameDate} | timestamp: ${new Date().toISOString()}`
        );
        await publishAllStagingGames(input.gameDate, input.sport);
        console.log(
          `[tRPC][publishAll] ✅ Complete — all ${sportLabel} games for ${input.gameDate} published to feed`
        );
        return { success: true };
      }),

    /**
     * List all staging games for a date range (inclusive).
     * Owner-only — used by Publish Projections for multi-day view.
     */
    listStagingRange: ownerProcedure
      .input(z.object({ fromDate: zodGameDate, toDate: zodGameDate, sport: zodSport.optional() }))
      .query(async ({ input }) => {
        const games = await listStagingGamesRange(input.fromDate, input.toDate, input.sport);
        return games.filter(g => isValidGame(g.awayTeam, g.homeTeam, g.sport));
      }),

    /**
     * Returns which sports have at least one game on today's UTC date or tomorrow's UTC date.
     * Used by the frontend to hide sport tabs when there are no upcoming games.
     */
    activeSports: publicProcedure.query(async () => {
      // OK: returns only sport name strings — no model data
      return getActiveSports();
    }),

    /** Returns the result of the last auto-refresh run (null if never run). */
    // OK: returns only a timestamp — no model data
    lastRefresh: publicProcedure.query(() => {
      return getLastRefreshResult();
    }),

    /**
     * Live VSiN MLB betting splits, straight from the scraper (5-min cache).
     * Does NOT depend on the vsinAutoRefresh DB pipeline — book lines are
     * joined from the games table best-effort. Used by the mobile Splits tab.
     */
    // OK: returns only public VSiN splits + book lines — no model data
    liveSplits: publicProcedure.query(async () => {
      const { getLiveMlbSplits } = await import("./liveSplits");
      return getLiveMlbSplits();
    }),

    /**
     * Owner-only: list all postponed and suspended games across all sports.
     * Used by the admin postponed-game audit view.
     */
    listPostponed: ownerProcedure
      .query(async () => {
        const { listPostponedGames } = await import('./mlbPostponedTracker.js');
        const rows = await listPostponedGames();
        console.log(`[tRPC][games.listPostponed] Returned ${rows.length} postponed/suspended games`);
        return rows;
      }),

    /**
     * Owner-only: manually override a game's status.
     * Useful for correcting postponed/suspended games that the API hasn't updated yet.
     */
    markGameStatus: ownerProcedure
      .input(z.object({
        id: z.number().int().positive(),
        status: z.enum(["upcoming", "live", "final", "postponed", "suspended"]),
      }))
      .mutation(async ({ input }) => {
        const { getDb } = await import('./db.js');
        const { games: gamesTable } = await import('../drizzle/schema.js');
        const { eq } = await import('drizzle-orm');
        const db = await getDb();
        if (!db) throw new Error('DB unavailable');
        await db
          .update(gamesTable)
          .set({ gameStatus: input.status })
          .where(eq(gamesTable.id, input.id));
        console.log(`[tRPC][games.markGameStatus] id=${input.id} → status=${input.status}`);
        return { success: true, id: input.id, status: input.status };
      }),

    /**
     * Hard-delete a single game by ID. Owner-only. Irreversible.
     */
    deleteGame: ownerProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ input }) => {
        await deleteGameById(input.id);
        return { success: true, deletedId: input.id };
      }),

    /**
     * Ingest Action Network "All Markets" HTML paste.
     * Parses Open lines + DK NJ lines for all games and writes them to the DB.
     * Owner-only.
     */
    ingestAnHtml: ownerProcedure
      .input(z.object({
        html: zodHtmlPaste,
        gameDate: zodGameDate,
        sport: z.enum(["NBA", "NHL"]).default("NBA"),
      }))
      .mutation(async ({ input }) => {
        const { html, gameDate, sport } = input;

        // Map sport string to AnSport type
        const anSport: AnSport = sport === "NHL" ? "nhl" : "nba";

        // ── Parse HTML ──
        const parseResult = parseAnAllMarketsHtml(html, anSport);
        if (!parseResult.games.length) {
          return { updated: 0, skipped: 0, warnings: parseResult.warnings, errors: ["No games found in HTML"] };
        }

        // ── Build URL-slug → dbSlug lookup ──
        // The AN game URL uses shortened combined slugs (e.g. "saint-josephs-vcu").
        // We need to split them into individual team slugs and match to dbSlug.
        const byNormSlug = new Map<string, string>();

        if (sport === "NBA") {
          // NBA URL-slug aliases (short nicknames used in AN game URLs)
          const NBA_URL_ALIASES: Record<string, string> = {
            "wizards": "washington_wizards",
            "celtics": "boston_celtics",
            "magic": "orlando_magic",
            "heat": "miami_heat",
            "nuggets": "denver_nuggets",
            "lakers": "los_angeles_lakers",
            "kings": "sacramento_kings",
            "clippers": "los_angeles_clippers",
            "bucks": "milwaukee_bucks",
            "hawks": "atlanta_hawks",
            "hornets": "charlotte_hornets",
            "spurs": "san_antonio_spurs",
            "nets": "brooklyn_nets",
            "76ers": "philadelphia_76ers",
            "knicks": "new_york_knicks",
            "raptors": "toronto_raptors",
            "bulls": "chicago_bulls",
            "cavaliers": "cleveland_cavaliers",
            "pistons": "detroit_pistons",
            "pacers": "indiana_pacers",
            "timberwolves": "minnesota_timberwolves",
            "thunder": "oklahoma_city_thunder",
            "jazz": "utah_jazz",
            "trail-blazers": "portland_trail_blazers",
            "warriors": "golden_state_warriors",
            "suns": "phoenix_suns",
            "mavericks": "dallas_mavericks",
            "rockets": "houston_rockets",
            "grizzlies": "memphis_grizzlies",
            "pelicans": "new_orleans_pelicans",
          };
          for (const [alias, dbSlug] of Object.entries(NBA_URL_ALIASES)) {
            byNormSlug.set(alias, dbSlug);
          }
          for (const t of NBA_TEAMS) {
            byNormSlug.set(t.dbSlug.replace(/_/g, "-"), t.dbSlug);
            byNormSlug.set(t.anSlug, t.dbSlug);
            byNormSlug.set(t.nbaSlug, t.dbSlug);
            byNormSlug.set(t.vsinSlug, t.dbSlug);
          }
        } else if (sport === "NHL") {
          // NHL URL-slug aliases (short nicknames used in AN game URLs)
          const NHL_URL_ALIASES: Record<string, string> = {
            "rangers": "new_york_rangers",
            "wild": "minnesota_wild",
            "kings": "los_angeles_kings",
            "devils": "new_jersey_devils",
            "sharks": "san_jose_sharks",
            "canadiens": "montreal_canadiens",
            "hurricanes": "carolina_hurricanes",
            "lightning": "tampa_bay_lightning",
            "maple-leafs": "toronto_maple_leafs",
            "sabres": "buffalo_sabres",
            "flames": "calgary_flames",
            "islanders": "new_york_islanders",
            "blue-jackets": "columbus_blue_jackets",
            "flyers": "philadelphia_flyers",
            "red-wings": "detroit_red_wings",
            "stars": "dallas_stars",
            "penguins": "pittsburgh_penguins",
            "mammoth": "utah_mammoth",
            "utah-hockey-club": "utah_mammoth",
            "blackhawks": "chicago_blackhawks",
            "golden-knights": "vegas_golden_knights",
            "kraken": "seattle_kraken",
            "canucks": "vancouver_canucks",
            "bruins": "boston_bruins",
            "capitals": "washington_capitals",
            "avalanche": "colorado_avalanche",
            "jets": "winnipeg_jets",
            "ducks": "anaheim_ducks",
            "senators": "ottawa_senators",
            "oilers": "edmonton_oilers",
            "predators": "nashville_predators",
            "blues": "st_louis_blues",
            "panthers": "florida_panthers",
          };
          for (const [alias, dbSlug] of Object.entries(NHL_URL_ALIASES)) {
            byNormSlug.set(alias, dbSlug);
          }
          for (const t of NHL_TEAMS) {
            byNormSlug.set(t.dbSlug.replace(/_/g, "-"), t.dbSlug);
            byNormSlug.set(t.anSlug, t.dbSlug);
            byNormSlug.set(t.vsinSlug, t.dbSlug);
            byNormSlug.set(t.nhlSlug, t.dbSlug);
          }
        }

        function splitCombinedSlug(combined: string): [string, string] | null {
          const parts = combined.split("-");
          for (let i = 1; i < parts.length; i++) {
            const awayPart = parts.slice(0, i).join("-");
            const homePart = parts.slice(i).join("-");
            if (byNormSlug.has(awayPart) && byNormSlug.has(homePart)) {
              return [byNormSlug.get(awayPart)!, byNormSlug.get(homePart)!];
            }
          }
          return null;
        }

        // ── Load existing DB games for the date ──
        const existingGames = await listGamesByDate(gameDate, sport);

        let updated = 0;
        let skipped = 0;
        const errors: string[] = [];

        for (const g of parseResult.games) {
          // Extract combined slug from game URL
          const urlParts = g.gameUrl.split("/");
          const gamePart = urlParts[2] || "";
          const combined = gamePart.replace(/-score-odds-.*$/, "");
          const slugMatch = splitCombinedSlug(combined);

          if (!slugMatch) {
            const msg = `NO_SLUG: cannot split "${combined}" (game ${g.anGameId}: ${g.awayName} @ ${g.homeName})`;
            errors.push(msg);
            console.warn(`[ingestAnHtml] ${msg}`);
            skipped++;
            continue;
          }

          const [awayDbSlug, homeDbSlug] = slugMatch;
          const dbGame = existingGames.find(
            (e) => e.awayTeam === awayDbSlug && e.homeTeam === homeDbSlug
          );

          if (!dbGame) {
            const msg = `NO_MATCH: ${awayDbSlug} @ ${homeDbSlug} on ${gameDate} (game ${g.anGameId})`;
            errors.push(msg);
            console.warn(`[ingestAnHtml] ${msg}`);
            skipped++;
            continue;
          }

          // Write open lines (AN HTML open column) AND DK NJ current lines
          // DK lines are stored in the primary book columns (awayBookSpread IS the DK line)
          const _ingestResult = await updateAnOdds(dbGame.id, {
            // Open lines
            openAwaySpread: g.openAwaySpread?.line ?? null,
            openAwaySpreadOdds: g.openAwaySpread?.juice ?? null,
            openHomeSpread: g.openHomeSpread?.line ?? null,
            openHomeSpreadOdds: g.openHomeSpread?.juice ?? null,
            openTotal: g.openOver?.line?.replace(/^[ou]/i, "") ?? null,
            openOverOdds: g.openOver?.juice ?? null,
            openUnderOdds: g.openUnder?.juice ?? null,
            openAwayML: g.openAwayML?.line ?? null,
            openHomeML: g.openHomeML?.line ?? null,
            // DK NJ current lines — stored in primary book columns
            awayBookSpread: g.dkAwaySpread?.line ?? null,
            awaySpreadOdds: g.dkAwaySpread?.juice ?? null,
            homeBookSpread: g.dkHomeSpread?.line ?? null,
            homeSpreadOdds: g.dkHomeSpread?.juice ?? null,
            bookTotal: g.dkOver?.line?.replace(/^[ou]/i, "") ?? null,
            overOdds: g.dkOver?.juice ?? null,
            underOdds: g.dkUnder?.juice ?? null,
            awayML: g.dkAwayML?.line ?? null,
            homeML: g.dkHomeML?.line ?? null,
          });
          // LAYER3 IMMEDIATE RE-RUN: when ML direction flipped, trigger model re-run immediately
          if (_ingestResult.layer3Fired && _ingestResult.gameDate) {
            const _l3Id   = _ingestResult.gameId;
            const _l3Date = _ingestResult.gameDate;
            console.log(`[ingestAnHtml][LAYER3_IMMEDIATE_RERUN] id=${_l3Id} gameDate=${_l3Date} — ML direction flipped → immediate re-run triggered.`);
            import('./mlbModelRunner').then(({ runMlbModelForDate }) =>
              runMlbModelForDate(_l3Date, { targetGameIds: [_l3Id], forceRerun: true })
            ).then(r => {
              console.log(`[ingestAnHtml][LAYER3_IMMEDIATE_RERUN] id=${_l3Id} COMPLETE — written=${r.written} errors=${r.errors}`);
            }).catch(err => {
              console.error(`[ingestAnHtml][LAYER3_IMMEDIATE_RERUN] id=${_l3Id} FAILED (non-fatal):`, err);
            });
          }

          updated++;
          console.log(
            `[ingestAnHtml] Updated: ${awayDbSlug} @ ${homeDbSlug} (${gameDate}) | ` +
            `spread=${g.dkAwaySpread?.line}/${g.dkHomeSpread?.line} ` +
            `total=${g.dkOver?.line} ml=${g.dkAwayML?.line}/${g.dkHomeML?.line}`
          );
        }

        console.log(`[ingestAnHtml] Done: updated=${updated} skipped=${skipped} errors=${errors.length}`);
        return { updated, skipped, warnings: parseResult.warnings, errors };
      }),

    /**
     * Manually trigger an immediate VSiN + AN odds refresh.
     * Owner-only.
     *
     * @param sport - Optional scope. When provided, only that sport is refreshed.
     *                When omitted, all sports (NBA, NHL, MLB) are refreshed.
     */
    triggerRefresh: ownerProcedure
      .input(
        z.object({
          sport: z.enum(["NBA", "NHL", "MLB"]).optional(),
        }).optional()
      )
      .mutation(async ({ input }) => {
        const sport = input?.sport;
        const sportLabel = sport ?? "ALL";
        console.log(
          `[tRPC][triggerRefresh] Owner triggered manual refresh — scope: ${sportLabel} | ` +
          `timestamp: ${new Date().toISOString()}`
        );

        // Run VSiN odds/lines refresh first (manual variant tags history rows as source='manual'),
        // then immediately refresh all scores
        const [result] = await Promise.allSettled([runVsinRefreshManual(sport)]);

        // Always refresh scores regardless of whether VSiN succeeded
        console.log(`[tRPC][triggerRefresh] Refreshing scores (all sports, always)…`);
        await refreshAllScoresNow();
        console.log(`[tRPC][triggerRefresh] Score refresh complete.`);

        const now = new Date().toISOString();
        const oddsResult = result.status === 'fulfilled' ? result.value : null;

        if (result.status === 'rejected') {
          console.error(`[tRPC][triggerRefresh] runVsinRefreshManual failed:`, result.reason);
        } else {
          console.log(
            `[tRPC][triggerRefresh] ✅ Manual refresh complete — scope: ${sportLabel} | ` +
            `NBA updated: ${oddsResult?.nbaUpdated ?? 0} | ` +
            `NHL updated: ${oddsResult?.nhlUpdated ?? 0}`
          );
        }

        return oddsResult ?? {
          refreshedAt: now,
          scoresRefreshedAt: now,
          updated: 0,
          inserted: 0,
          nbaUpdated: 0,
          nbaInserted: 0,
          nbaScheduleInserted: 0,
          total: 0,
          nbaTotal: 0,
          nhlUpdated: 0,
          nhlInserted: 0,
          nhlScheduleInserted: 0,
          nhlTotal: 0,
          mlbUpdated: 0,
          mlbInserted: 0,
          mlbTotal: 0,
          gameDate: "",
        };
      }),

    /**
     * Fetch MLB lineups for a list of game IDs.
     * Returns a map of gameId → lineup row (pitcher, batting order, weather, umpire).
     * Public — lineups are visible to all users.
     */
    // PUBLIC — lineups are visible to all users on the public feed.
    mlbLineups: publicProcedure
      .input(z.object({ gameIds: z.array(z.number().int().positive()) }))
      .query(async ({ input }) => {
        console.log(`[tRPC][games.mlbLineups] PUBLIC gameIds=[${input.gameIds.join(',')}]`);
        if (input.gameIds.length === 0) return {};
        const map = await getMlbLineupsByGameIds(input.gameIds);
        // Convert Map to plain object for JSON serialization
        const result: Record<number, unknown> = {};
        for (const [gameId, row] of Array.from(map.entries())) {
          result[gameId] = row;
        }
        return result;
      }),
    /**
     * Fetch MLB environment signals (park factor, bullpen ERA/FIP, umpire K/BB modifiers)
     * for a single game. Used by the MlbLineupCard detail view.
     * Returns nulls for any signal not yet seeded.
     * PUBLIC — env signals are visible to all users on the public feed.
     */
    mlbEnvSignals: publicProcedure
      .input(z.object({
        homeTeam: z.string().min(2).max(8),
        awayTeam: z.string().min(2).max(8),
        umpireName: z.string().max(100).regex(/^[A-Za-z\s\-\.]+$/, "Invalid umpire name").nullable().optional(),
      }))
      .query(async ({ input }) => {
        console.log(`[tRPC][games.mlbEnvSignals] PUBLIC homeTeam=${input.homeTeam} awayTeam=${input.awayTeam}`);
        return getMlbGameEnvSignals({
          homeTeam: input.homeTeam,
          awayTeam: input.awayTeam,
          umpireName: input.umpireName ?? null,
        });
      }),
  }),

  // ─── Favorites ──────────────────────────────────────────────────────────────
  // Uses appUserProcedure (the real app_session cookie auth).
  favorites: router({
    /** Get all favorited game IDs for the current user. */
    getMyFavorites: appUserProcedure.query(async ({ ctx }) => {
      const ids = await getFavoriteGameIds(ctx.appUser.id);
      return { favoriteGameIds: ids };
    }),
    /** Get favorited game IDs with their game dates (for 11:00 UTC expiry). */
    getMyFavoritesWithDates: appUserProcedure.query(async ({ ctx }) => {
      const rows = await getFavoriteGamesWithDates(ctx.appUser.id);
      return { favorites: rows };
    }),
    /** Toggle a game as favorited/unfavorited for the current user. */
    toggle: appUserProcedure
      .input(z.object({ gameId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        return toggleFavoriteGame(ctx.appUser.id, input.gameId);
      }),
  }),

  // ─── Team Colors ─────────────────────────────────────────────────────────────
  teamColors: router({
    /**
     * Fetch primary/secondary/tertiary hex colors for both teams in a game.
     * Used by BettingSplitsPanel to color the split bars with real team branding.
     */
    getForGame: publicProcedure
      .input(z.object({
        awayTeam: zodTeamId,
        homeTeam: zodTeamId,
        sport: zodSport,
      }))
      .query(async ({ input }) => {
        return getGameTeamColors(input.awayTeam, input.homeTeam, input.sport);
      }),
  }),


  // ─── MLB Model Sync ─────────────────────────────────────────────────────────
  mlbModel: router({
    /**
     * Force re-run the MLB model for a specific date (or today if not specified).
     * Owner-only — clears modelRunAt for all upcoming games on that date and re-runs.
     */
    forceRerun: ownerProcedure
      .input(z.object({ date: zodGameDate.optional() }))
      .mutation(async ({ input }) => {
        // Compute today in ET if no date provided
        const dateStr = input.date ?? (() => {
          const etStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
          const [m, d, y] = etStr.split('/');
          return `${y}-${m}-${d}`;
        })();
        console.log(`[tRPC][mlbModel.forceRerun] ► Forcing MLB model rerun for ${dateStr}`);
        const result = await runMlbModelForDate(dateStr, { forceRerun: true });
        console.log(`[tRPC][mlbModel.forceRerun] ✅ Complete: written=${result.written} skipped=${result.skipped} errors=${result.errors}`);
        return result;
      }),
    /**
     * Get the MLB model run status for a specific date.
     * Owner-only.
     */
    getStatus: ownerProcedure
      .input(z.object({ date: zodGameDate.optional() }))
      .query(async ({ input }) => {
        const dateStr = input.date ?? (() => {
          const etStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
          const [m, d, y] = etStr.split('/');
          return `${y}-${m}-${d}`;
        })();
        const games = await listGamesByDate(dateStr, 'MLB');
        return {
          date: dateStr,
          total: games.length,
          modeled: games.filter(g => g.modelRunAt !== null).length,
          published: games.filter(g => g.publishedToFeed).length,
          games: games.map(g => ({
            id: g.id,
            matchup: `${g.awayTeam}@${g.homeTeam}`,
            modelRunAt: g.modelRunAt,
            awayModelSpread: g.awayModelSpread,
            modelTotal: g.modelTotal,
            modelAwayML: g.modelAwayML,
            publishedToFeed: g.publishedToFeed,
          })),
        };
      }),
    /**
     * Run the post-write validation gate on demand for a specific date.
     * Owner-only — returns issues (errors) and warnings from validateMlbModelResults.
     * Use this to audit stale data, RL sign mismatches, and missing spreadDiff/spreadEdge
     * without needing to check server logs.
     *
     * Response shape:
     *   passed: boolean  — true if zero issues (warnings do not affect pass/fail)
     *   issues: string[] — hard errors (totalMismatch, RL inversion, missing odds, etc.)
     *   warnings: string[] — soft alerts (whole-number totals, missing spreadDiff, etc.)
     *   date: string     — the date audited (YYYY-MM-DD)
     *   summary: { total, modeled, issues, warnings }
     */
    audit: ownerProcedure
      .input(z.object({ date: zodGameDate.optional() }))
      .query(async ({ input }) => {
        const dateStr = input.date ?? (() => {
          const etStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
          const [m, d, y] = etStr.split('/');
          return `${y}-${m}-${d}`;
        })();
        console.log(`[tRPC][mlbModel.audit] ► Running validation gate for ${dateStr}`);
        const result = await validateMlbModelResults(dateStr);
        const games = await listGamesByDate(dateStr, 'MLB');
        const modeled = games.filter(g => g.modelRunAt !== null).length;
        const summary = {
          total: games.length,
          modeled,
          issues: result.issues.length,
          warnings: result.warnings.length,
        };
        if (result.passed) {
          console.log(`[tRPC][mlbModel.audit] ✅ PASSED — ${modeled}/${games.length} modeled, 0 issues, ${result.warnings.length} warnings`);
        } else {
          console.error(`[tRPC][mlbModel.audit] ❌ FAILED — ${result.issues.length} issues, ${result.warnings.length} warnings`);
          for (const issue of result.issues) console.error(`  ✗ ${issue}`);
        }
        return { passed: result.passed, issues: result.issues, warnings: result.warnings, date: dateStr, summary };
      }),
  }),
  // ─── NHL Model Sync ─────────────────────────────────────────────────────────────────────
  nhlModel: router({
    /**
     * Manually trigger the NHL model sync for today's games.
     * Owner-only — re-runs the model for all unmodeled games.
     */
    triggerSync: ownerProcedure
      .mutation(async () => {
        const result = await syncNhlModelForToday("manual");
        return result;
      }),
    /**
     * Get the last NHL model sync result.
     */
    getLastSyncResult: ownerProcedure
      .query(() => {
        return getLastNhlSyncResult();
      }),
    /**
     * Manually trigger the goalie change watcher.
     * Owner-only — checks RotoWire for goalie changes and re-runs model if needed.
     */
    checkGoalies: ownerProcedure
      .mutation(async () => {
        const result = await checkGoalieChanges("manual");
        return result;
      }),
    /**
     * Get the last goalie watch result.
     */
    getLastGoalieCheck: ownerProcedure
      .query(() => {
        return getLastGoalieWatchResult();
      }),
    /**
     * Force re-run the NHL model for today's games, even if already modeled.
     * Owner-only — clears modelRunAt and re-runs the model for all upcoming games.
     * Use this after schema changes or model engine updates.
     */
    forceRerun: ownerProcedure
      .mutation(async () => {
        const result = await syncNhlModelForToday("manual", true);
        return result;
      }),
    /**
     * Force re-run the NHL model for ALL today's games regardless of status.
     * Owner-only — runs model for upcoming + live + final games.
     * Use this to backfill correct model values after engine fixes.
     */
    forceRerunAll: ownerProcedure
      .mutation(async () => {
        const result = await syncNhlModelForToday("manual", true, true);
        return result;
      }),
  }),
  // ─── Odds History ────────────────────────────────────────────────────────────────────────────
  oddsHistory: router({
    /**
     * List all odds snapshots for a specific game, newest first.
     * SECURITY: sportsReadProcedure — subscriber cookie OR Tailered OS machine principal.
     * Machine path does not impersonate a human user.
     */
    listForGame: sportsReadProcedure
      .input(z.object({ gameId: z.number().int().positive() }))
      .query(async ({ input, ctx }) => {
        console.log(
          `[tRPC][oddsHistory.listForGame] AUTHED principal=${ctx.sportsPrincipal} gameId=${input.gameId}`
        );
        const rows = await listOddsHistory(input.gameId);
        return { history: rows.map(presentNcaafSeptember4History) };
      }),

    /**
     * Landing-page marketing sample (owner directive 2026-07-31).
     *
     * SECURITY NOTE: odds movement is premium content and `listForGame`
     * above stays gated. This procedure is a deliberately narrow carve-out:
     * it takes NO caller input and can only ever resolve ONE pinned,
     * already-completed game (DEMO_GAME below) — a visitor cannot pivot it
     * to today's slate or to any other matchup. That is the whole product
     * sample the public landing page is allowed to show.
     */
    listForDemoGame: publicProcedure.query(async () => {
      const game = await findDemoGame();
      if (!game) {
        console.log(`[tRPC][oddsHistory.listForDemoGame] PUBLIC — demo game not found; serving empty`);
        return { history: [], game: null };
      }
      const rows = await listOddsHistory(game.id);
      console.log(
        `[tRPC][oddsHistory.listForDemoGame] PUBLIC gameId=${game.id} rows=${rows.length}`
      );
      return {
        history: rows,
        game: { id: game.id, awayTeam: game.awayTeam, homeTeam: game.homeTeam },
      };
    }),
  }),
  // ─── MLB Strikeout Props ──────────────────────────────────────────────────────────────────────
  strikeoutProps: router({
    /**
     * Fetch strikeout prop projections for a single game.
     * Returns 0–2 rows (away pitcher, home pitcher).
     * PUBLIC — K-prop projections are visible to all users on the public feed.
     */
    getByGame: publicProcedure
      .input(z.object({ gameId: z.number().int().positive() }))
      .query(async ({ input, ctx }) => {
        console.log(`[tRPC][strikeoutProps.getByGame] gameId=${input.gameId}`);
        const rows = await getStrikeoutPropsByGame(input.gameId);
        // IP gating: anon gets book lines only, model projections/edges nulled.
        const authed = await isRequestAuthenticated(ctx.req);
        setGatedCacheHeaders(ctx.res, authed);
        // Publication gate (publish_k_props). Null for everyone except owners.
        const propGates = await resolveMlbPropGates(ctx.req);
        const published = propGates
          ? rows.map(r => applyMlbMarketGatesToStrikeoutProp(r, propGates))
          : rows;
        return { props: authed ? published : published.map(r => stripStrikeoutPropModelFields(r)) };
      }),

    /**
     * Fetch strikeout props for multiple games at once.
     * Returns a record of gameId → rows[].
     * PUBLIC — K-prop projections are visible to all users on the public feed.
     */
    getByGames: publicProcedure
      .input(z.object({ gameIds: z.array(z.number().int().positive()) }))
      .query(async ({ input, ctx }) => {
        console.log(`[tRPC][strikeoutProps.getByGames] gameIds=[${input.gameIds.join(',')}]`);
        const map = await getStrikeoutPropsByGames(input.gameIds);
        const authed = await isRequestAuthenticated(ctx.req);
        setGatedCacheHeaders(ctx.res, authed);
        // Publication gate (publish_k_props). Null for everyone except owners.
        const propGates = await resolveMlbPropGates(ctx.req);
        // Convert Map to plain object for serialization; gate rows for anon.
        const result: Record<number, typeof map extends Map<number, infer V> ? V : never> = {};
        Array.from(map.entries()).forEach(([k, v]) => {
          const gatedRows = (propGates
            ? (v as unknown[]).map(r =>
                applyMlbMarketGatesToStrikeoutProp(r as Record<string, unknown>, propGates))
            : v) as typeof v;
          result[k] = (authed
            ? gatedRows
            : (gatedRows as unknown[]).map(r => stripStrikeoutPropModelFields(r as Record<string, unknown>))) as typeof v;
        });
        return { propsByGame: result };
      }),

    /**
     * Fetch rolling calibration metrics across all completed K-props.
     * Returns accuracy, MAE, mean error, calibration factor, and tier breakdown.
     */
    getCalibrationMetrics: ownerProcedure
      .query(async () => {
        const { getRollingCalibrationMetrics } = await import("./kPropsBacktestService");
        const metrics = await getRollingCalibrationMetrics();
        return { metrics };
      }),

    /**
     * Fetch daily backtest results for a specific date.
     * Returns all K-prop rows with actualKs, backtestResult, modelCorrect, modelError.
     */
    getDailyBacktest: ownerProcedure
      .input(z.object({ gameDate: zodGameDate }))
      .query(async ({ input }) => {
        const { getDailyBacktestResults } = await import("./kPropsBacktestService");
        const results = await getDailyBacktestResults(input.gameDate);
        return { results };
      }),
    /**
     * Owner-only: fetch rich daily backtest results with team names, headshots, and edge data.
     * Used exclusively by the Model Results backend page.
     */
    getRichDailyBacktest: ownerProcedure
      .input(z.object({ gameDate: zodGameDate }))
      .query(async ({ input }) => {
        const { getRichDailyBacktestResults } = await import("./kPropsBacktestService");
        const results = await getRichDailyBacktestResults(input.gameDate);
        return { results };
      }),

    /**
     * Owner-only: fetch aggregate K-Props backtest metrics for the last 7 days.
     * Returns per-day breakdown + aggregate accuracy, OVER/UNDER bias, and MAE.
     */
    getLast7DaysBacktest: ownerProcedure
      .input(z.object({ days: z.number().int().min(1).max(30).optional() }))
      .query(async ({ input }) => {
        const { getLast7DaysBacktest } = await import("./kPropsBacktestService");
        const data = await getLast7DaysBacktest(input.days ?? 7);
        return data;
      }),
    /**
     * Owner-only: run the StrikeoutModel.py for a specific game.
     * Requires file paths to Retrosheet plays, Statcast JSON, and crosswalk CSV.
     */
    runModel: ownerProcedure
      .input(
        z.object({
          gameId: z.number().int().positive(),
          gameDate: zodGameDate,
          awayTeam: zodTeamId,
          homeTeam: zodTeamId,
          awayPitcherRsId: zodPitcherRsId,
          homePitcherRsId: zodPitcherRsId,
          playsPath: zodFilePath,
          statcastPath: zodFilePath,
          crosswalkPath: zodFilePath,
          awayMarketLine: z.number().optional(),
          awayMarketOverOdds: z.string().max(20).optional(),
          awayMarketUnderOdds: z.string().max(20).optional(),
          homeMarketLine: z.number().optional(),
          homeMarketOverOdds: z.string().max(20).optional(),
          homeMarketUnderOdds: z.string().max(20).optional(),
        })
      )
      .mutation(async ({ input }) => {
        const result = await runStrikeoutModel(input as StrikeoutRunnerInput);
        return result;
      }),
  }),

  // ─── Admin Model Status ─────────────────────────────────────────────────────────────────────────────────────────
  adminModelStatus: router({
    /**
     * Owner-only: real-time MLB model pipeline status for today + tomorrow.
     * Returns per-game modelRunAt, pitchers, model scores, lineup status, and odds.
     * Use this to diagnose automation gaps without querying the DB manually.
     */
    mlb: ownerProcedure
      .input(z.object({ date: zodGameDate.optional() }))
      .query(async ({ input }) => {
        const { getDb } = await import('./db.js');
        const { games: gamesTable, mlbLineups } = await import('../drizzle/schema.js');
        const { and, eq, or } = await import('drizzle-orm');
        const db = await getDb();
        const etStr = new Date().toLocaleDateString('en-US', {
          timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
        });
        const [m, d, y] = etStr.split('/');
        const todayStr = `${y}-${m}-${d}`;
        const tomorrowDate = new Date(Number(y), Number(m) - 1, Number(d) + 1);
        const tomorrowStr = `${tomorrowDate.getFullYear()}-${String(tomorrowDate.getMonth() + 1).padStart(2, '0')}-${String(tomorrowDate.getDate()).padStart(2, '0')}`;
        const targetDate = input.date ?? todayStr;
        const dates = targetDate === todayStr ? [todayStr, tomorrowStr] : [targetDate];
        const allRows: unknown[] = [];
        for (const gameDate of dates) {
          const rows = await db
            .select({
              id: gamesTable.id,
              gameDate: gamesTable.gameDate,
              awayTeam: gamesTable.awayTeam,
              homeTeam: gamesTable.homeTeam,
              gameStatus: gamesTable.gameStatus,
              awayStartingPitcher: gamesTable.awayStartingPitcher,
              homeStartingPitcher: gamesTable.homeStartingPitcher,
              awayML: gamesTable.awayML,
              homeML: gamesTable.homeML,
              bookTotal: gamesTable.bookTotal,
              modelRunAt: gamesTable.modelRunAt,
              modelAwayScore: gamesTable.modelAwayScore,
              modelHomeScore: gamesTable.modelHomeScore,
              modelAwayML: gamesTable.modelAwayML,
              modelHomeML: gamesTable.modelHomeML,
              modelTotal: gamesTable.modelTotal,
              publishedModel: gamesTable.publishedModel,
            })
            .from(gamesTable)
            .where(and(eq(gamesTable.gameDate, gameDate), eq(gamesTable.sport, 'MLB')))
            .orderBy(gamesTable.awayTeam);
          // Attach lineup status from mlb_lineups for each game
          const gameIds = rows.map((r: { id: number }) => r.id);
          const lineupMap = new Map<number, { awayPitcherName: string | null; homePitcherName: string | null; awayLineupConfirmed: boolean | null; homeLineupConfirmed: boolean | null; lineupModeledAt: Date | null }>();
          if (gameIds.length > 0) {
            const lineupRows = await db
              .select({
                gameId: mlbLineups.gameId,
                awayPitcherName: mlbLineups.awayPitcherName,
                homePitcherName: mlbLineups.homePitcherName,
                awayLineupConfirmed: mlbLineups.awayLineupConfirmed,
                homeLineupConfirmed: mlbLineups.homeLineupConfirmed,
                lineupModeledAt: mlbLineups.lineupModeledAt,
              })
              .from(mlbLineups)
              .where(or(...gameIds.map((id: number) => eq(mlbLineups.gameId, id))));
            for (const lr of lineupRows) {
              lineupMap.set(lr.gameId, lr);
            }
          }
          const enriched = rows.map((r: typeof rows[0]) => ({
            ...r,
            lineup: lineupMap.get(r.id) ?? null,
            modeled: r.modelRunAt !== null,
            published: r.publishedModel,
          }));
          allRows.push(...enriched);
        }
        const total     = allRows.length;
        const modeled   = (allRows as any[]).filter(r => r.modeled).length;
        const unmodeled = total - modeled;
        console.log(
          `[tRPC][adminModelStatus.mlb] dates=${dates.join(',')} total=${total}` +
          ` modeled=${modeled} unmodeled=${unmodeled}`
        );
        return { dates, total, modeled, unmodeled, games: allRows };
      }),
    /**
     * Owner-only: real-time NHL model pipeline status for today + tomorrow.
     * Returns per-game modelRunAt, goalies, model scores, and odds.
     */
    nhl: ownerProcedure
      .input(z.object({ date: zodGameDate.optional() }))
      .query(async ({ input }) => {
        const { getDb } = await import('./db.js');
        const { games: gamesTable } = await import('../drizzle/schema.js');
        const { and, eq } = await import('drizzle-orm');
        const db = await getDb();
        const etStr = new Date().toLocaleDateString('en-US', {
          timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
        });
        const [m, d, y] = etStr.split('/');
        const todayStr = `${y}-${m}-${d}`;
        const tomorrowDate = new Date(Number(y), Number(m) - 1, Number(d) + 1);
        const tomorrowStr = `${tomorrowDate.getFullYear()}-${String(tomorrowDate.getMonth() + 1).padStart(2, '0')}-${String(tomorrowDate.getDate()).padStart(2, '0')}`;
        const targetDate = input.date ?? todayStr;
        const dates = targetDate === todayStr ? [todayStr, tomorrowStr] : [targetDate];
        const allRows: unknown[] = [];
        for (const gameDate of dates) {
          const rows = await db
            .select({
              id: gamesTable.id,
              gameDate: gamesTable.gameDate,
              awayTeam: gamesTable.awayTeam,
              homeTeam: gamesTable.homeTeam,
              gameStatus: gamesTable.gameStatus,
              awayGoalie: gamesTable.awayGoalie,
              homeGoalie: gamesTable.homeGoalie,
              awayML: gamesTable.awayML,
              homeML: gamesTable.homeML,
              bookTotal: gamesTable.bookTotal,
              modelRunAt: gamesTable.modelRunAt,
              modelAwayScore: gamesTable.modelAwayScore,
              modelHomeScore: gamesTable.modelHomeScore,
              modelAwayML: gamesTable.modelAwayML,
              modelHomeML: gamesTable.modelHomeML,
              modelTotal: gamesTable.modelTotal,
              publishedModel: gamesTable.publishedModel,
            })
            .from(gamesTable)
            .where(and(eq(gamesTable.gameDate, gameDate), eq(gamesTable.sport, 'NHL')))
            .orderBy(gamesTable.awayTeam);
          const enriched = rows.map((r: typeof rows[0]) => ({
            ...r,
            modeled: r.modelRunAt !== null,
            bothGoalies: !!r.awayGoalie && !!r.homeGoalie,
            published: r.publishedModel,
          }));
          allRows.push(...enriched);
        }
        const total     = allRows.length;
        const modeled   = (allRows as any[]).filter(r => r.modeled).length;
        const unmodeled = total - modeled;
        console.log(
          `[tRPC][adminModelStatus.nhl] dates=${dates.join(',')} total=${total}` +
          ` modeled=${modeled} unmodeled=${unmodeled}`
        );
        return { dates, total, modeled, unmodeled, games: allRows };
      }),
  }),

  // ─── MLB HR Props ─────────────────────────────────────────────────────────────────────────────────────────────────
  hrProps: router({
    /**
     * Fetch HR prop projections for a single game.
     * Returns all player rows ordered by side (away first), then playerName.
     * PUBLIC — HR prop projections are visible to all users on the public feed.
     */
    getByGame: publicProcedure
      .input(z.object({ gameId: z.number().int().positive() }))
      .query(async ({ input, ctx }) => {
        console.log(`[tRPC][hrProps.getByGame] gameId=${input.gameId}`);
        const rows = await getHrPropsByGame(input.gameId);
        const authed = await isRequestAuthenticated(ctx.req);
        setGatedCacheHeaders(ctx.res, authed);
        // Publication gate (publish_hr_props). Null for everyone except owners.
        const propGates = await resolveMlbPropGates(ctx.req);
        const published = propGates
          ? rows.map(r => applyMlbMarketGatesToHrProp(r, propGates))
          : rows;
        return { props: authed ? published : published.map(r => stripHrPropModelFields(r)) };
      }),

    /**
     * Fetch HR props for multiple games at once.
     * Returns a record of gameId → rows[].
     * PUBLIC — HR prop projections are visible to all users on the public feed.
     */
    getByGames: publicProcedure
      .input(z.object({ gameIds: zodGameIdArray }))
      .query(async ({ input, ctx }) => {
        console.log(`[tRPC][hrProps.getByGames] gameIds=[${input.gameIds.join(',')}]`);
        const map = await getHrPropsByGames(input.gameIds);
        const authed = await isRequestAuthenticated(ctx.req);
        setGatedCacheHeaders(ctx.res, authed);
        // Publication gate (publish_hr_props). Null for everyone except owners.
        const propGates = await resolveMlbPropGates(ctx.req);
        const result: Record<number, Awaited<ReturnType<typeof getHrPropsByGame>>> = {};
        Array.from(map.entries()).forEach(([k, v]) => {
          const gatedRows = (propGates
            ? (v as unknown[]).map(r =>
                applyMlbMarketGatesToHrProp(r as Record<string, unknown>, propGates))
            : v) as typeof v;
          result[k] = (authed
            ? gatedRows
            : (gatedRows as unknown[]).map(r => stripHrPropModelFields(r as Record<string, unknown>))) as typeof v;
        });
        return { propsByGame: result };
      }),
  }),

  // ─── MLB Multi-Market Backtest ─────────────────────────────────────────────────────────────────────────────────────────────────
  mlbBacktest: router({
    /**
     * Owner-only: run multi-market backtest for a specific game by DB id.
     * Markets: FG ML/RL/Total, F5 ML/RL/Total, NRFI/YRFI, HR Props.
     */
    runForGame: ownerProcedure
      .input(z.object({
        gameId:        z.number().int().positive(),
        includeKProps: z.boolean().default(false),
      }))
      .mutation(async ({ input }) => {
        const { runMultiMarketBacktest } = await import('./mlbMultiMarketBacktest');
        return runMultiMarketBacktest(input.gameId, input.includeKProps);
      }),

    /**
     * Owner-only: run multi-market backtest for all completed games on a date.
     */
    runForDate: ownerProcedure
      .input(z.object({ gameDate: zodGameDate }))
      .mutation(async ({ input }) => {
        const { runMultiMarketBacktestForDate } = await import('./mlbMultiMarketBacktest');
        return runMultiMarketBacktestForDate(input.gameDate);
      }),

    /**
     * Get rolling backtest accuracy per market for the last N days.
     */
    getRollingAccuracy: ownerProcedure
      .input(z.object({ days: z.number().int().min(1).max(90).default(30) }))
      .query(async ({ input }) => {
        const { getMultiMarketRollingAccuracy } = await import('./mlbMultiMarketBacktest');
        return getMultiMarketRollingAccuracy(input.days);
      }),

    /**
     * Get drift log entries (model learning events) for the last N days.
     */
    getDriftLog: ownerProcedure
      .input(z.object({ days: z.number().int().min(1).max(90).default(30) }))
      .query(async ({ input }) => {
        const { getDb }              = await import('./db');
        const { mlbModelLearningLog } = await import('../drizzle/schema');
        const { desc }               = await import('drizzle-orm');
        const { sql }                = await import('drizzle-orm');
        const db = await getDb();
        const cutoff = Date.now() - input.days * 24 * 60 * 60 * 1000;
        const rows = await db
          .select()
          .from(mlbModelLearningLog)
          .where(sql`${mlbModelLearningLog.runAt} >= ${cutoff}`)
          .orderBy(desc(mlbModelLearningLog.runAt))
          .limit(200);
        return rows;
      }),
    /**
     * Owner-only: backfill mlbamId for all K-Props rows where it is null.
     * Calls MLB Stats API to resolve pitcher IDs for headshot display.
     */
    backfillKPropsMlbamIds: ownerProcedure
      .mutation(async () => {
        const { backfillAllKPropsMlbamIds } = await import('./mlbKPropsModelService');
        return backfillAllKPropsMlbamIds();
      }),
    /**
     * Owner-only: run full historical backtest across all completed games in a date range.
     * Returns per-market accuracy, ROI, edge distribution, calibration metrics.
     */
    runHistoricalBacktest: ownerProcedure
      .input(z.object({
        startDate: zodGameDate,
        endDate:   zodGameDate,
      }))
      .mutation(async ({ input }) => {
        const { runHistoricalBacktestRange } = await import('./mlbFullBacktestEngine');
        return runHistoricalBacktestRange(input.startDate, input.endDate);
      }),
    /**
     * Get full backtest report: per-market stats, ROI curve, calibration, edge distribution.
     * Used by the Backtest UI page.
     */
    getFullReport: ownerProcedure
      .input(z.object({
        days:        z.number().int().min(1).max(365).default(60),
        minEdge:     z.number().min(0).max(1).default(0),
        minSample:   z.number().int().min(1).default(5),
      }))
      .query(async ({ input }) => {
        const { getFullBacktestReport } = await import('./mlbFullBacktestEngine');
        return getFullBacktestReport(input.days, input.minEdge, input.minSample);
      }),
    /**
     * Get per-day accuracy time series for ROI curve chart.
     */
    getDailyTimeSeries: ownerProcedure
      .input(z.object({
        days:   z.number().int().min(1).max(365).default(60),
        market: z.string().default('all'),
      }))
      .query(async ({ input }) => {
        const { getDailyBacktestTimeSeries } = await import('./mlbFullBacktestEngine');
        return getDailyBacktestTimeSeries(input.days, input.market);
      }),
    /**
     * Get edge-bucket accuracy breakdown (calibration chart data).
     */
    getEdgeBuckets: ownerProcedure
      .input(z.object({
        days:   z.number().int().min(1).max(365).default(60),
        market: z.string().default('all'),
      }))
      .query(async ({ input }) => {
        const { getEdgeBucketAccuracy } = await import('./mlbFullBacktestEngine');
        return getEdgeBucketAccuracy(input.days, input.market);
      }),
    /**
     * Get K-Props detailed backtest: MAE, bias, RMSE, per-line accuracy.
     */
    getKPropsReport: ownerProcedure
      .input(z.object({ days: z.number().int().min(1).max(365).default(60) }))
      .query(async ({ input }) => {
        const { getKPropsBacktestReport } = await import('./mlbFullBacktestEngine');
        return getKPropsBacktestReport(input.days);
      }),
    /**
     * Get HR Props detailed backtest: calibration, P(HR) distribution, accuracy by odds tier.
     */
    getHrPropsReport: ownerProcedure
      .input(z.object({ days: z.number().int().min(1).max(365).default(60) }))
      .query(async ({ input }) => {
        const { getHrPropsBacktestReport } = await import('./mlbFullBacktestEngine');
        return getHrPropsBacktestReport(input.days);
      }),
  }),

  // ─── March Madness Bracket ───────────────────────────────────────────────────────────────────────────────────────
  bracket: router({ /**
     * Fetch all tournament games with bracket metadata.
     * Returns every game from First Four through Championship.
     * SECURITY: appUserProcedure — bracket data is authenticated-user content.
     */
    getGames: appUserProcedure
      .query(async ({ ctx }) => {
        console.log(`[tRPC][bracket.getGames] AUTHED userId=${ctx.appUser.id}`);
        const rows = await getBracketGames();
        return { games: rows };
      }),
    /**
     * Owner-only: audit all final bracket games and advance winners to next round.
     * Idempotent — safe to call multiple times.
     */
    auditAdvancement: ownerProcedure
      .mutation(async () => {
        const advanced = await auditAndAdvanceAllBracketWinners();
        return { advanced };
      }),
  }),
});
export type AppRouter = typeof appRouter;
