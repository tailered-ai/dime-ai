/**
 * mlbSchedule.ts — tRPC router for MLB schedule history and Last 5 Games data
 *
 * Procedures:
 *   mlbSchedule.getLast5ForMatchup        — public — Last 5 completed games for both teams in a matchup
 *   mlbSchedule.getTeamSchedule           — public — Full schedule for a single team (all games)
 *   mlbSchedule.getSituationalStats       — public — Situational records (ML/RL/Total tabs)
 *   mlbSchedule.refreshScheduleForDate    — owner-only — Refresh a specific date
 *   mlbSchedule.backfillSchedule          — owner-only — Rolling window backfill (last N days)
 *   mlbSchedule.fullHistoricalBackfill    — owner-only — Full Phase 1 backfill (2023-03-30 → today)
 *
 * Data source: Action Network v1 API, DraftKings NJ (book_id=68) exclusively
 *
 * Logging: [MlbScheduleRouter][PROCEDURE] plain-English, fully traceable
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { ownerProcedure, appUserProcedure } from "./appUsers";
import {
  listRecalibrationProposals,
  decideRecalibration,
  buildApprovalRequest,
} from "../mlbRecalibrationGate";
import {
  getLast5ForMatchup,
  getFullScheduleForTeam,
  getMlbSituationalStats,
  getMlbH2HGames,
  refreshMlbScheduleForDate,
  refreshMlbScheduleLastNDays,
  backfillMlbScheduleHistory,
  type MlbScheduleRefreshResult,
} from "../mlbScheduleHistoryService";
import { runMlbNightlyTrendsRefresh } from "../mlbNightlyTrendsRefresh";
import { ingestMlbOutcomes } from "../mlbOutcomeIngestor";
import {
  checkF5ShareDrift,
  triggerRecalibration,
  migrateCalibrationConstants,
} from "../mlbDriftDetector";
import { getDb } from "../db";
import { games as gamesTable, type Game } from "../../drizzle/schema";
import { and, eq, isNotNull, asc, desc, sql } from "drizzle-orm";

const TAG = "[MlbScheduleRouter]";

// ─── Zod validators ───────────────────────────────────────────────────────────

/** AN url_slug format: lowercase letters, digits, hyphens only */
const zodAnSlug = z
  .string()
  .min(2)
  .max(64)
  .regex(
    /^[a-z0-9-]+$/,
    "Invalid team slug — must be lowercase letters, digits, and hyphens only"
  );

/** YYYYMMDD date string for the AN API */
const zodAnDate = z
  .string()
  .length(8)
  .regex(/^\d{8}$/, "Date must be in YYYYMMDD format");

// ─── Router ───────────────────────────────────────────────────────────────────

export const mlbScheduleRouter = router({
  /**
   * Get the last 5 completed games for both teams in a matchup.
   * Powers the "Last 5 Games" panel on each MLB matchup card.
   * SECURITY: appUserProcedure — schedule history is authenticated-user content.
   */
  getLast5ForMatchup: appUserProcedure
    .input(
      z.object({
        awaySlug: zodAnSlug,
        homeSlug: zodAnSlug,
      })
    )
    .query(async ({ input, ctx }) => {
      console.log(
        `${TAG}[getLast5ForMatchup] AUTHED userId=${ctx.appUser.id} Fetching Last 5 for matchup:` +
          ` away="${input.awaySlug}" vs home="${input.homeSlug}"`
      );

      try {
        const { awayLast5, homeLast5 } = await getLast5ForMatchup(
          input.awaySlug,
          input.homeSlug
        );

        console.log(
          `${TAG}[getLast5ForMatchup] Returning` +
            ` away=${awayLast5.length} games, home=${homeLast5.length} games`
        );

        return { awayLast5, homeLast5 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${TAG}[getLast5ForMatchup] ERROR: ${msg}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to fetch Last 5 games: ${msg}`,
        });
      }
    }),

  /**
   * Get the full schedule for a single MLB team (all games, any status).
   * Powers the Team Schedule page when a user clicks on a team logo.
   */
  // SECURITY: appUserProcedure — team schedule data is authenticated-user content.
  getTeamSchedule: appUserProcedure
    .input(
      z.object({
        teamSlug: zodAnSlug,
      })
    )
    .query(async ({ input, ctx }) => {
      console.log(
        `${TAG}[getTeamSchedule] AUTHED userId=${ctx.appUser.id} Fetching full schedule for team="${input.teamSlug}"`
      );

      try {
        const games = await getFullScheduleForTeam(input.teamSlug);

        console.log(
          `${TAG}[getTeamSchedule] Returning ${games.length} games for team="${input.teamSlug}"`
        );

        return { games, teamSlug: input.teamSlug };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${TAG}[getTeamSchedule] ERROR: ${msg}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to fetch team schedule: ${msg}`,
        });
      }
    }),

  /**
   * Get situational records for a single MLB team.
   * Powers the "Situational Results" panel (ML/Run Line/Total tabs).
   */
  // SECURITY: appUserProcedure — situational stats are authenticated-user content.
  getSituationalStats: appUserProcedure
    .input(
      z.object({
        teamSlug: zodAnSlug,
      })
    )
    .query(async ({ input, ctx }) => {
      console.log(
        `${TAG}[getSituationalStats] AUTHED userId=${ctx.appUser.id} Computing situational stats for team="${input.teamSlug}"`
      );
      try {
        const stats = await getMlbSituationalStats(input.teamSlug);
        console.log(
          `${TAG}[getSituationalStats] Returning stats for team="${input.teamSlug}"` +
            ` gamesAnalyzed=${stats.gamesAnalyzed}`
        );
        return stats;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${TAG}[getSituationalStats] ERROR: ${msg}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to compute MLB situational stats: ${msg}`,
        });
      }
    }),

  /**
   * Get the last N head-to-head games between two specific MLB teams.
   * Powers the "Head-to-Head" tab in the Recent Schedule panel.
   */
  // SECURITY: appUserProcedure — H2H game history is authenticated-user content.
  getH2HGames: appUserProcedure
    .input(
      z.object({
        slugA: zodAnSlug,
        slugB: zodAnSlug,
        limit: z.number().int().min(1).max(20).default(10),
      })
    )
    .query(async ({ input, ctx }) => {
      console.log(
        `${TAG}[getH2HGames] AUTHED userId=${ctx.appUser.id} Fetching H2H games: "${input.slugA}" vs "${input.slugB}" limit=${input.limit}`
      );
      try {
        const games = await getMlbH2HGames(
          input.slugA,
          input.slugB,
          input.limit
        );
        console.log(
          `${TAG}[getH2HGames] Returning ${games.length} H2H games` +
            ` between "${input.slugA}" and "${input.slugB}"`
        );
        return { games };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${TAG}[getH2HGames] ERROR: ${msg}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to fetch H2H games: ${msg}`,
        });
      }
    }),

  /**
   * Owner-only: Refresh MLB schedule history for a specific date.
   * Fetches from AN DK NJ API and upserts into mlb_schedule_history.
   */
  refreshScheduleForDate: ownerProcedure
    .input(
      z.object({
        date: zodAnDate,
      })
    )
    .mutation(async ({ input }) => {
      console.log(
        `${TAG}[refreshScheduleForDate] Manual refresh triggered for date=${input.date}`
      );

      try {
        const result = await refreshMlbScheduleForDate(input.date);

        console.log(
          `${TAG}[refreshScheduleForDate] Complete:` +
            ` fetched=${result.fetched} upserted=${result.upserted}` +
            ` errors=${result.errors.length}`
        );

        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${TAG}[refreshScheduleForDate] ERROR: ${msg}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Schedule refresh failed: ${msg}`,
        });
      }
    }),

  /**
   * Owner-only: Rolling window backfill for the last N days.
   * Uses refreshMlbScheduleLastNDays (returns array of per-date results).
   *
   * Input:
   *   daysBack — Number of days to backfill (default: 30, max: 60)
   */
  backfillSchedule: ownerProcedure
    .input(
      z.object({
        daysBack: z.number().int().min(1).max(60).default(30),
      })
    )
    .mutation(async ({ input }) => {
      console.log(
        `${TAG}[backfillSchedule] Rolling window backfill triggered for last ${input.daysBack} days`
      );

      try {
        const results = await refreshMlbScheduleLastNDays(input.daysBack);

        const totalFetched = results.reduce(
          (s: number, r: MlbScheduleRefreshResult) => s + r.fetched,
          0
        );
        const totalUpserted = results.reduce(
          (s: number, r: MlbScheduleRefreshResult) => s + r.upserted,
          0
        );
        const totalErrors = results.reduce(
          (s: number, r: MlbScheduleRefreshResult) => s + r.errors.length,
          0
        );

        console.log(
          `${TAG}[backfillSchedule] Complete:` +
            ` dates=${results.length} totalFetched=${totalFetched}` +
            ` totalUpserted=${totalUpserted} totalErrors=${totalErrors}`
        );

        return { results, totalFetched, totalUpserted, totalErrors };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${TAG}[backfillSchedule] ERROR: ${msg}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Backfill failed: ${msg}`,
        });
      }
    }),

  /**
   * Owner-only: Full historical backfill from 2023-03-30 through today.
   *
   * This is the Phase 1 backfill covering all MLB seasons with DK NJ odds:
   *   - 2023: 2023-03-30 → 2023-10-01 (full regular season + postseason)
   *   - 2024: 2024-03-20 → 2024-09-29 (full regular season)
   *   - 2025: 2025-03-27 → present
   *   - 2026: 2026-03-26 → present (if applicable)
   *
   * Input:
   *   startDate — "YYYY-MM-DD" format (default: "2023-03-30")
   *   endDate   — "YYYY-MM-DD" format (default: today)
   *   delayMs   — Delay between API calls in ms (default: 400)
   */
  fullHistoricalBackfill: ownerProcedure
    .input(
      z.object({
        startDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .default("2023-03-30"),
        endDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        delayMs: z.number().int().min(200).max(2000).default(400),
      })
    )
    .mutation(async ({ input }) => {
      console.log(
        `${TAG}[fullHistoricalBackfill] Full Phase 1 backfill triggered` +
          ` | startDate=${input.startDate} endDate=${input.endDate ?? "today"} delayMs=${input.delayMs}`
      );

      try {
        const result = await backfillMlbScheduleHistory(
          input.startDate,
          input.endDate,
          input.delayMs
        );

        console.log(
          `${TAG}[fullHistoricalBackfill] COMPLETE:` +
            ` totalDates=${result.totalDates}` +
            ` totalFetched=${result.totalFetched}` +
            ` totalUpserted=${result.totalUpserted}` +
            ` totalErrors=${result.totalErrors}`
        );

        return {
          totalDates: result.totalDates,
          totalFetched: result.totalFetched,
          totalUpserted: result.totalUpserted,
          totalErrors: result.totalErrors,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${TAG}[fullHistoricalBackfill] ERROR: ${msg}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Full historical backfill failed: ${msg}`,
        });
      }
    }),

  /**
   * Owner-only: Manually trigger the nightly MLB TRENDS refresh for a specific date.
   *
   * Runs the full pipeline:
   *   1. Re-ingests yesterday + today from AN API (fallback book chain 68→15→21→30)
   *   2. Per-row validation: re-derives awayWon, ATS, O/U from raw scores
   *   3. 30-team cross-validation across all 3 markets × 6 situations
   *   4. Sends owner notification with pass/fail summary
   *
   * Input:
   *   targetDate — "YYYYMMDD" format (default: yesterday EST)
   */
  triggerNightlyTrendsRefresh: ownerProcedure
    .input(
      z.object({
        targetDate: z
          .string()
          .regex(/^\d{8}$/)
          .optional(),
      })
    )
    .mutation(async ({ input }) => {
      const tag = `${TAG}[triggerNightlyTrendsRefresh]`;
      console.log(
        `${tag} Manual trigger invoked` +
          ` | targetDate=${input.targetDate ?? "yesterday EST (default)"}`
      );
      try {
        await runMlbNightlyTrendsRefresh(input.targetDate);
        console.log(`${tag} COMPLETE`);
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${tag} ERROR: ${msg}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Nightly TRENDS refresh failed: ${msg}`,
        });
      }
    }),

  /**
   * Owner-only: Manually trigger outcome ingestion for a specific date.
   * Fetches innings-level linescore from MLB Stats API, writes actualFgTotal,
   * actualF5Total, actualNrfiBinary, and 5 Brier scores to the games table.
   *
   * Input:
   *   dateStr    — "YYYY-MM-DD" format
   *   force      — if true, re-ingest games that already have outcomeIngestedAt set
   *   dryRun     — compute and report with ZERO database mutation
   *   historical — suppress the drift detector (and the recalibration it can
   *                trigger) plus the owner notification, so replaying a past
   *                date cannot alter or react to the live-model window
   */
  triggerOutcomeIngestion: ownerProcedure
    .input(
      z.object({
        dateStr: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        force: z.boolean().optional().default(false),
        dryRun: z.boolean().optional().default(false),
        historical: z.boolean().optional().default(false),
      })
    )
    .mutation(async ({ input }) => {
      const tag = `${TAG}[triggerOutcomeIngestion]`;
      console.log(
        `${tag} Manual trigger: dateStr=${input.dateStr} force=${input.force} dryRun=${input.dryRun} historical=${input.historical}`
      );
      try {
        const summary = await ingestMlbOutcomes(input.dateStr, input.force, {
          dryRun: input.dryRun,
          historical: input.historical,
        });
        console.log(
          `${tag} COMPLETE: written=${summary.written} wouldWrite=${summary.wouldWrite} brierChanged=${summary.brierChanged} errors=${summary.errors}`
        );
        return summary;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${tag} ERROR: ${msg}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Outcome ingestion failed: ${msg}`,
        });
      }
    }),

  /**
   * Owner-only: Run the f5_share drift check and optionally trigger recalibration.
   * Returns the full DriftCheckResult with rolling f5_share, delta, and recalibration status.
   *
   * Input:
   *   triggerRecal — if true and drift detected, triggers full recalibration run
   */
  checkDrift: ownerProcedure
    .input(
      z.object({
        triggerRecal: z.boolean().optional().default(false),
      })
    )
    .query(async ({ input }) => {
      const tag = `${TAG}[checkDrift]`;
      console.log(
        `${tag} Manual drift check: triggerRecal=${input.triggerRecal}`
      );
      try {
        const result = await checkF5ShareDrift(input.triggerRecal);
        console.log(
          `${tag} COMPLETE: driftDetected=${result.driftDetected} delta=${result.delta}`
        );
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${tag} ERROR: ${msg}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Drift check failed: ${msg}`,
        });
      }
    }),

  /**
   * Owner-only: Rolling Brier score trend for the Admin Brier chart.
   *
   * Returns per-game Brier scores (FG ML, F5 ML, NRFI, FG Total, F5 Total)
   * plus rolling N-game averages, ordered chronologically by gameDate.
   *
   * Only includes games with outcomeIngestedAt IS NOT NULL.
   * Games missing a specific Brier field have null for that market.
   *
   * Output:
   *   games:   Array<{ gameIndex, gameDate, matchup, brierFgMl, brierF5Ml, brierNrfi, brierFgTotal, brierF5Total }>
   *   rolling: Array<{ gameIndex, rollFgMl, rollF5Ml, rollNrfi, rollFgTotal, rollF5Total }>
   *   summary: { totalGames, avgFgMl, avgF5Ml, avgNrfi, windowSize }
   */
  getBrierTrend: ownerProcedure
    .input(
      z.object({
        windowSize: z.number().int().min(5).max(100).optional().default(20),
        sport: z.enum(["MLB"]).optional().default("MLB"),
      })
    )
    .query(async ({ input }) => {
      const tag = `${TAG}[getBrierTrend]`;
      console.log(
        `${tag} [INPUT] windowSize=${input.windowSize} sport=${input.sport}`
      );
      const db = await getDb();

      // ── Step 1: Fetch all outcome-ingested games with Brier scores, ordered chronologically
      const rows = await db
        .select({
          id: gamesTable.id,
          gameDate: gamesTable.gameDate,
          awayTeam: gamesTable.awayTeam,
          homeTeam: gamesTable.homeTeam,
          brierFgMl: gamesTable.brierFgMl,
          brierF5Ml: gamesTable.brierF5Ml,
          brierNrfi: gamesTable.brierNrfi,
          brierFgTotal: gamesTable.brierFgTotal,
          brierF5Total: gamesTable.brierF5Total,
          outcomeIngestedAt: gamesTable.outcomeIngestedAt,
        })
        .from(gamesTable)
        .where(
          and(
            eq(gamesTable.sport, input.sport),
            isNotNull(gamesTable.outcomeIngestedAt)
          )
        )
        .orderBy(asc(gamesTable.gameDate), asc(gamesTable.id));

      console.log(`${tag} [STATE] ingested rows: ${rows.length}`);

      if (rows.length === 0) {
        console.log(`${tag} [OUTPUT] No ingested games found`);
        return {
          games: [] as Array<{
            gameIndex: number;
            gameDate: string;
            matchup: string;
            brierFgMl: number | null;
            brierF5Ml: number | null;
            brierNrfi: number | null;
            brierFgTotal: number | null;
            brierF5Total: number | null;
          }>,
          rolling: [] as Array<{
            gameIndex: number;
            rollFgMl: number | null;
            rollF5Ml: number | null;
            rollNrfi: number | null;
            rollFgTotal: number | null;
            rollF5Total: number | null;
          }>,
          summary: {
            totalGames: 0,
            avgFgMl: null as number | null,
            avgF5Ml: null as number | null,
            avgNrfi: null as number | null,
            avgFgTotal: null as number | null,
            avgF5Total: null as number | null,
            windowSize: input.windowSize,
          },
        };
      }

      // ── Step 2: Build per-game array with sequential index
      type GamePoint = {
        gameIndex: number;
        gameDate: string;
        matchup: string;
        brierFgMl: number | null;
        brierF5Ml: number | null;
        brierNrfi: number | null;
        brierFgTotal: number | null;
        brierF5Total: number | null;
      };
      type BrierRow = Pick<
        Game,
        | "id"
        | "gameDate"
        | "awayTeam"
        | "homeTeam"
        | "brierFgMl"
        | "brierF5Ml"
        | "brierNrfi"
        | "brierFgTotal"
        | "brierF5Total"
        | "outcomeIngestedAt"
      >;
      const gamePoints: GamePoint[] = (rows as BrierRow[]).map(
        (r: BrierRow, i: number) => ({
          gameIndex: i + 1,
          gameDate: r.gameDate ?? "",
          matchup: `${r.awayTeam}@${r.homeTeam}`,
          brierFgMl:
            r.brierFgMl !== null ? parseFloat(String(r.brierFgMl)) : null,
          brierF5Ml:
            r.brierF5Ml !== null ? parseFloat(String(r.brierF5Ml)) : null,
          brierNrfi:
            r.brierNrfi !== null ? parseFloat(String(r.brierNrfi)) : null,
          brierFgTotal:
            r.brierFgTotal !== null ? parseFloat(String(r.brierFgTotal)) : null,
          brierF5Total:
            r.brierF5Total !== null ? parseFloat(String(r.brierF5Total)) : null,
        })
      );

      // ── Step 3: Compute rolling averages (window = last N games including current)
      const W = input.windowSize;
      type BrierField =
        | "brierFgMl"
        | "brierF5Ml"
        | "brierNrfi"
        | "brierFgTotal"
        | "brierF5Total";
      const rolling = gamePoints.map((_: GamePoint, i: number) => {
        const window = gamePoints.slice(Math.max(0, i - W + 1), i + 1);
        const avg = (field: BrierField): number | null => {
          const vals = window
            .map((g: GamePoint) => g[field])
            .filter((v: number | null): v is number => v !== null);
          return vals.length > 0
            ? parseFloat(
                (
                  vals.reduce((s: number, v: number) => s + v, 0) / vals.length
                ).toFixed(6)
              )
            : null;
        };
        return {
          gameIndex: gamePoints[i].gameIndex,
          rollFgMl: avg("brierFgMl"),
          rollF5Ml: avg("brierF5Ml"),
          rollNrfi: avg("brierNrfi"),
          rollFgTotal: avg("brierFgTotal"),
          rollF5Total: avg("brierF5Total"),
        };
      });

      // ── Step 4: All-time averages for summary cards
      const allAvg = (field: BrierField): number | null => {
        const vals = gamePoints
          .map((g: GamePoint) => g[field])
          .filter((v: number | null): v is number => v !== null);
        return vals.length > 0
          ? parseFloat(
              (
                vals.reduce((s: number, v: number) => s + v, 0) / vals.length
              ).toFixed(6)
            )
          : null;
      };
      const summary = {
        totalGames: gamePoints.length,
        avgFgMl: allAvg("brierFgMl"),
        avgF5Ml: allAvg("brierF5Ml"),
        avgNrfi: allAvg("brierNrfi"),
        avgFgTotal: allAvg("brierFgTotal"),
        avgF5Total: allAvg("brierF5Total"),
        windowSize: W,
      };

      console.log(
        `${tag} [OUTPUT] games=${gamePoints.length} ` +
          `avgFgMl=${summary.avgFgMl ?? "null"} ` +
          `avgF5Ml=${summary.avgF5Ml ?? "null"} ` +
          `avgNrfi=${summary.avgNrfi ?? "null"} ` +
          `avgFgTotal=${summary.avgFgTotal ?? "null"} ` +
          `avgF5Total=${summary.avgF5Total ?? "null"}`
      );
      return { games: gamePoints, rolling, summary };
    }),

  /**
   * Owner-only: Manually trigger a full recalibration run.
   * Runs runMlbBacktest2.py, updates mlb_calibration_constants.json,
   * and patches EMPIRICAL_PRIORS in MLBAIModel.py.
   *
   * Input:
   *   reason — 'MANUAL' (default) | 'SCHEDULED' | 'DRIFT_DETECTED'
   */
  triggerRecalibration: ownerProcedure
    .input(
      z.object({
        reason: z
          .enum(["MANUAL", "SCHEDULED", "DRIFT_DETECTED"])
          .optional()
          .default("MANUAL"),
      })
    )
    .mutation(async ({ input }) => {
      const tag = `${TAG}[triggerRecalibration]`;
      console.log(
        `${tag} Manual recalibration trigger: reason=${input.reason}`
      );
      try {
        const result = await triggerRecalibration(input.reason);
        console.log(
          `${tag} COMPLETE: success=${result.success} constantsPatched=${result.constantsPatched}`
        );
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${tag} ERROR: ${msg}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Recalibration failed: ${msg}`,
        });
      }
    }),

  /**
   * Owner-only: 5-market Brier heatmap by date.
   *
   * Returns one row per game date (aggregated), with average Brier scores
   * for each of the 5 markets: FG ML, F5 ML, NRFI, FG Total, F5 Total.
   * Also includes game count and a per-market null count for completeness.
   *
   * Ordered chronologically (oldest first).
   * Only includes dates where at least one game has been outcome-ingested.
   */
  getBrierHeatmap: ownerProcedure
    .input(
      z.object({
        sport: z.enum(["MLB"]).optional().default("MLB"),
      })
    )
    .query(async ({ input }) => {
      const tag = `${TAG}[getBrierHeatmap]`;
      console.log(`${tag} [INPUT] sport=${input.sport}`);
      const db = await getDb();

      // Fetch all outcome-ingested games with Brier scores
      const rows = await db
        .select({
          gameDate: gamesTable.gameDate,
          brierFgMl: gamesTable.brierFgMl,
          brierF5Ml: gamesTable.brierF5Ml,
          brierNrfi: gamesTable.brierNrfi,
          brierFgTotal: gamesTable.brierFgTotal,
          brierF5Total: gamesTable.brierF5Total,
        })
        .from(gamesTable)
        .where(
          and(
            eq(gamesTable.sport, input.sport),
            isNotNull(gamesTable.outcomeIngestedAt)
          )
        )
        .orderBy(asc(gamesTable.gameDate), asc(gamesTable.id));

      console.log(`${tag} [STATE] total ingested rows: ${rows.length}`);

      // Group by date and compute per-market averages
      type BrierRow = (typeof rows)[number];
      type DateRow = {
        date: string;
        games: number;
        avgFgMl: number | null;
        avgF5Ml: number | null;
        avgNrfi: number | null;
        avgFgTotal: number | null;
        avgF5Total: number | null;
        nullFgMl: number;
        nullF5Ml: number;
        nullNrfi: number;
        nullFgTotal: number;
        nullF5Total: number;
      };

      const dateMap = new Map<string, BrierRow[]>();
      for (const r of rows) {
        const d = r.gameDate ?? "unknown";
        if (!dateMap.has(d)) dateMap.set(d, []);
        dateMap.get(d)!.push(r);
      }

      const avg = (vals: (number | null | undefined)[]): number | null => {
        const nums = vals.filter(
          (v): v is number => v != null && !isNaN(v as number)
        );
        if (nums.length === 0) return null;
        return nums.reduce((s, v) => s + v, 0) / nums.length;
      };

      const sortedEntries = Array.from(dateMap.entries()).sort(([a], [b]) =>
        a.localeCompare(b)
      );
      const heatmap: DateRow[] = [];
      for (const [date, vals] of sortedEntries) {
        heatmap.push({
          date,
          games: vals.length,
          avgFgMl: avg(vals.map((r: BrierRow) => r.brierFgMl)),
          avgF5Ml: avg(vals.map((r: BrierRow) => r.brierF5Ml)),
          avgNrfi: avg(vals.map((r: BrierRow) => r.brierNrfi)),
          avgFgTotal: avg(vals.map((r: BrierRow) => r.brierFgTotal)),
          avgF5Total: avg(vals.map((r: BrierRow) => r.brierF5Total)),
          nullFgMl: vals.filter((r: BrierRow) => r.brierFgMl == null).length,
          nullF5Ml: vals.filter((r: BrierRow) => r.brierF5Ml == null).length,
          nullNrfi: vals.filter((r: BrierRow) => r.brierNrfi == null).length,
          nullFgTotal: vals.filter((r: BrierRow) => r.brierFgTotal == null)
            .length,
          nullF5Total: vals.filter((r: BrierRow) => r.brierF5Total == null)
            .length,
        });
      }

      console.log(`${tag} [OUTPUT] heatmap rows: ${heatmap.length}`);
      return { heatmap };
    }),

  /**
   * Owner-only: F5 ML Edge Leaderboard.
   *
   * Returns all historical games with modelF5AwayWinPct and f5AwayML populated,
   * sorted by absolute edge descending.
   *
   * Edge = model win% (0–100) − no-vig implied prob (0–100)
   * No-vig implied = raw_side / (raw_away + raw_home) where
   *   raw = odds < 0 ? (-odds) / (-odds + 100) : 100 / (odds + 100)
   */
  getF5EdgeLeaderboard: ownerProcedure
    .input(
      z.object({
        minEdge: z.number().optional().default(0),
        side: z.enum(["away", "home", "both"]).optional().default("both"),
        withOutcome: z.boolean().optional().default(false),
        limit: z.number().min(1).max(500).optional().default(200),
      })
    )
    .query(async ({ input }) => {
      const tag = `${TAG}[getF5EdgeLeaderboard]`;
      console.log(
        `${tag} [INPUT] minEdge=${input.minEdge} side=${input.side} withOutcome=${input.withOutcome} limit=${input.limit}`
      );

      const db = await getDb();
      const rows = await db
        .select({
          id: gamesTable.id,
          gameDate: gamesTable.gameDate,
          awayTeam: gamesTable.awayTeam,
          homeTeam: gamesTable.homeTeam,
          f5AwayML: gamesTable.f5AwayML,
          f5HomeML: gamesTable.f5HomeML,
          modelF5AwayWinPct: gamesTable.modelF5AwayWinPct,
          modelF5HomeWinPct: gamesTable.modelF5HomeWinPct,
          f5MlResult: gamesTable.f5MlResult,
          f5MlCorrect: gamesTable.f5MlCorrect,
          actualF5AwayScore: gamesTable.actualF5AwayScore,
          actualF5HomeScore: gamesTable.actualF5HomeScore,
          brierF5Ml: gamesTable.brierF5Ml,
        })
        .from(gamesTable)
        .where(
          and(
            isNotNull(gamesTable.modelF5AwayWinPct),
            isNotNull(gamesTable.f5AwayML),
            isNotNull(gamesTable.f5HomeML)
          )
        )
        .orderBy(asc(gamesTable.gameDate));

      console.log(`${tag} [STATE] raw rows with model+odds: ${rows.length}`);

      // ─ No-vig implied probability helper ─────────────────────────────────────
      const americanToRaw = (ml: string | null): number | null => {
        if (!ml) return null;
        const n = parseFloat(ml);
        if (isNaN(n)) return null;
        return n < 0 ? -n / (-n + 100) : 100 / (n + 100);
      };

      type EdgeRow = {
        id: number;
        gameDate: string;
        awayTeam: string;
        homeTeam: string;
        side: "away" | "home";
        modelWinPct: number;
        bookImpliedPct: number;
        edgePct: number;
        f5AwayML: string | null;
        f5HomeML: string | null;
        f5MlResult: string | null;
        f5MlCorrect: number | null;
        actualF5AwayScore: number | null;
        actualF5HomeScore: number | null;
        brierF5Ml: string | null;
      };

      const edgeRows: EdgeRow[] = [];

      for (const row of rows) {
        const rawAway = americanToRaw(row.f5AwayML);
        const rawHome = americanToRaw(row.f5HomeML);
        if (rawAway == null || rawHome == null) continue;
        const total = rawAway + rawHome;
        if (total <= 0) continue;

        const noVigAway = (rawAway / total) * 100;
        const noVigHome = (rawHome / total) * 100;

        const modelAway =
          row.modelF5AwayWinPct != null
            ? parseFloat(String(row.modelF5AwayWinPct))
            : null;
        const modelHome =
          row.modelF5HomeWinPct != null
            ? parseFloat(String(row.modelF5HomeWinPct))
            : null;

        if (
          modelAway != null &&
          (input.side === "away" || input.side === "both")
        ) {
          const edge = modelAway - noVigAway;
          if (Math.abs(edge) >= input.minEdge) {
            edgeRows.push({
              id: row.id,
              gameDate: row.gameDate ?? "",
              awayTeam: row.awayTeam,
              homeTeam: row.homeTeam,
              side: "away",
              modelWinPct: modelAway,
              bookImpliedPct: noVigAway,
              edgePct: edge,
              f5AwayML: row.f5AwayML,
              f5HomeML: row.f5HomeML,
              f5MlResult: row.f5MlResult,
              f5MlCorrect: row.f5MlCorrect,
              actualF5AwayScore: row.actualF5AwayScore,
              actualF5HomeScore: row.actualF5HomeScore,
              brierF5Ml: row.brierF5Ml != null ? String(row.brierF5Ml) : null,
            });
          }
        }

        if (
          modelHome != null &&
          (input.side === "home" || input.side === "both")
        ) {
          const edge = modelHome - noVigHome;
          if (Math.abs(edge) >= input.minEdge) {
            edgeRows.push({
              id: row.id,
              gameDate: row.gameDate ?? "",
              awayTeam: row.awayTeam,
              homeTeam: row.homeTeam,
              side: "home",
              modelWinPct: modelHome,
              bookImpliedPct: noVigHome,
              edgePct: edge,
              f5AwayML: row.f5AwayML,
              f5HomeML: row.f5HomeML,
              f5MlResult: row.f5MlResult,
              f5MlCorrect: row.f5MlCorrect,
              actualF5AwayScore: row.actualF5AwayScore,
              actualF5HomeScore: row.actualF5HomeScore,
              brierF5Ml: row.brierF5Ml != null ? String(row.brierF5Ml) : null,
            });
          }
        }
      }

      // Sort by absolute edge descending
      edgeRows.sort((a, b) => Math.abs(b.edgePct) - Math.abs(a.edgePct));
      const limited = edgeRows.slice(0, input.limit);

      // ─ Summary stats ─────────────────────────────────────────────────────────
      const withOutcome = edgeRows.filter(
        r => r.f5MlResult != null && r.f5MlResult !== ""
      );
      const wins = withOutcome.filter(
        r => r.edgePct > 0 && r.f5MlCorrect === 1
      ).length;
      const losses = withOutcome.filter(
        r => r.edgePct > 0 && r.f5MlCorrect === 0
      ).length;
      const positiveEdge = edgeRows.filter(r => r.edgePct > 0);
      const negativeEdge = edgeRows.filter(r => r.edgePct < 0);
      const avgPositiveEdge =
        positiveEdge.length > 0
          ? positiveEdge.reduce((s, r) => s + r.edgePct, 0) /
            positiveEdge.length
          : 0;
      const avgNegativeEdge =
        negativeEdge.length > 0
          ? negativeEdge.reduce((s, r) => s + r.edgePct, 0) /
            negativeEdge.length
          : 0;

      const summary = {
        totalGames: rows.length,
        edgeRows: edgeRows.length,
        positiveEdge: positiveEdge.length,
        negativeEdge: negativeEdge.length,
        avgPositiveEdge: parseFloat(avgPositiveEdge.toFixed(2)),
        avgNegativeEdge: parseFloat(avgNegativeEdge.toFixed(2)),
        winsOnPositiveEdge: wins,
        lossesOnPositiveEdge: losses,
        winRateOnPositiveEdge:
          withOutcome.length > 0 && wins + losses > 0
            ? parseFloat(((wins / (wins + losses)) * 100).toFixed(1))
            : null,
      };

      console.log(
        `${tag} [OUTPUT] edgeRows=${edgeRows.length} positiveEdge=${positiveEdge.length} negativeEdge=${negativeEdge.length} wins=${wins} losses=${losses}`
      );
      console.log(
        `${tag} [VERIFY] ${summary.winRateOnPositiveEdge != null ? `PASS — win rate on positive edge: ${summary.winRateOnPositiveEdge}%` : "PENDING — no outcomes yet"}`
      );

      return { rows: limited, summary };
    }),

  /**
   * Owner-only: Full-Game ML Edge Leaderboard.
   *
   * Mirrors getF5EdgeLeaderboard but uses FG ML fields:
   * modelAwayWinPct, modelHomeWinPct, awayML, homeML, fgMlResult, fgMlCorrect, brierFgMl.
   */
  getFgEdgeLeaderboard: ownerProcedure
    .input(
      z.object({
        minEdge: z.number().optional().default(0),
        side: z.enum(["away", "home", "both"]).optional().default("both"),
        withOutcome: z.boolean().optional().default(false),
        limit: z.number().min(1).max(500).optional().default(200),
      })
    )
    .query(async ({ input }) => {
      const tag = `${TAG}[getFgEdgeLeaderboard]`;
      console.log(
        `${tag} [INPUT] minEdge=${input.minEdge} side=${input.side} withOutcome=${input.withOutcome} limit=${input.limit}`
      );
      const db = await getDb();
      const rows = await db
        .select({
          id: gamesTable.id,
          gameDate: gamesTable.gameDate,
          awayTeam: gamesTable.awayTeam,
          homeTeam: gamesTable.homeTeam,
          awayML: gamesTable.awayML,
          homeML: gamesTable.homeML,
          modelAwayWinPct: gamesTable.modelAwayWinPct,
          modelHomeWinPct: gamesTable.modelHomeWinPct,
          fgMlResult: gamesTable.fgMlResult,
          fgMlCorrect: gamesTable.fgMlCorrect,
          actualAwayScore: gamesTable.actualAwayScore,
          actualHomeScore: gamesTable.actualHomeScore,
          brierFgMl: gamesTable.brierFgMl,
        })
        .from(gamesTable)
        .where(
          and(
            isNotNull(gamesTable.modelAwayWinPct),
            isNotNull(gamesTable.awayML),
            isNotNull(gamesTable.homeML)
          )
        )
        .orderBy(asc(gamesTable.gameDate));
      console.log(`${tag} [STATE] raw rows with model+odds: ${rows.length}`);
      const americanToRaw = (ml: string | null): number | null => {
        if (!ml) return null;
        const n = parseFloat(ml);
        if (isNaN(n)) return null;
        return n < 0 ? -n / (-n + 100) : 100 / (n + 100);
      };
      type FgEdgeRow = {
        id: number;
        gameDate: string;
        awayTeam: string;
        homeTeam: string;
        side: "away" | "home";
        modelWinPct: number;
        bookImpliedPct: number;
        edgePct: number;
        awayML: string | null;
        homeML: string | null;
        fgMlResult: string | null;
        fgMlCorrect: number | null;
        actualAwayScore: number | null;
        actualHomeScore: number | null;
        brierFgMl: string | null;
      };
      const edgeRows: FgEdgeRow[] = [];
      for (const row of rows) {
        const rawAway = americanToRaw(row.awayML);
        const rawHome = americanToRaw(row.homeML);
        if (rawAway == null || rawHome == null) continue;
        const total = rawAway + rawHome;
        if (total <= 0) continue;
        const noVigAway = (rawAway / total) * 100;
        const noVigHome = (rawHome / total) * 100;
        const modelAway =
          row.modelAwayWinPct != null
            ? parseFloat(String(row.modelAwayWinPct))
            : null;
        const modelHome =
          row.modelHomeWinPct != null
            ? parseFloat(String(row.modelHomeWinPct))
            : null;
        if (
          modelAway != null &&
          (input.side === "away" || input.side === "both")
        ) {
          const edge = modelAway - noVigAway;
          if (Math.abs(edge) >= input.minEdge) {
            edgeRows.push({
              id: row.id,
              gameDate: row.gameDate ?? "",
              awayTeam: row.awayTeam,
              homeTeam: row.homeTeam,
              side: "away",
              modelWinPct: modelAway,
              bookImpliedPct: noVigAway,
              edgePct: edge,
              awayML: row.awayML,
              homeML: row.homeML,
              fgMlResult: row.fgMlResult,
              fgMlCorrect: row.fgMlCorrect,
              actualAwayScore: row.actualAwayScore,
              actualHomeScore: row.actualHomeScore,
              brierFgMl: row.brierFgMl != null ? String(row.brierFgMl) : null,
            });
          }
        }
        if (
          modelHome != null &&
          (input.side === "home" || input.side === "both")
        ) {
          const edge = modelHome - noVigHome;
          if (Math.abs(edge) >= input.minEdge) {
            edgeRows.push({
              id: row.id,
              gameDate: row.gameDate ?? "",
              awayTeam: row.awayTeam,
              homeTeam: row.homeTeam,
              side: "home",
              modelWinPct: modelHome,
              bookImpliedPct: noVigHome,
              edgePct: edge,
              awayML: row.awayML,
              homeML: row.homeML,
              fgMlResult: row.fgMlResult,
              fgMlCorrect: row.fgMlCorrect,
              actualAwayScore: row.actualAwayScore,
              actualHomeScore: row.actualHomeScore,
              brierFgMl: row.brierFgMl != null ? String(row.brierFgMl) : null,
            });
          }
        }
      }
      edgeRows.sort((a, b) => Math.abs(b.edgePct) - Math.abs(a.edgePct));
      const limited = edgeRows.slice(0, input.limit);
      const withOutcomeRows = edgeRows.filter(
        r => r.fgMlResult != null && r.fgMlResult !== ""
      );
      const wins = withOutcomeRows.filter(
        r => r.edgePct > 0 && r.fgMlCorrect === 1
      ).length;
      const losses = withOutcomeRows.filter(
        r => r.edgePct > 0 && r.fgMlCorrect === 0
      ).length;
      const positiveEdge = edgeRows.filter(r => r.edgePct > 0);
      const negativeEdge = edgeRows.filter(r => r.edgePct < 0);
      const avgPositiveEdge =
        positiveEdge.length > 0
          ? positiveEdge.reduce((s, r) => s + r.edgePct, 0) /
            positiveEdge.length
          : 0;
      const avgNegativeEdge =
        negativeEdge.length > 0
          ? negativeEdge.reduce((s, r) => s + r.edgePct, 0) /
            negativeEdge.length
          : 0;
      const summary = {
        totalGames: rows.length,
        edgeRows: edgeRows.length,
        positiveEdge: positiveEdge.length,
        negativeEdge: negativeEdge.length,
        avgPositiveEdge: parseFloat(avgPositiveEdge.toFixed(2)),
        avgNegativeEdge: parseFloat(avgNegativeEdge.toFixed(2)),
        winsOnPositiveEdge: wins,
        lossesOnPositiveEdge: losses,
        winRateOnPositiveEdge:
          withOutcomeRows.length > 0 && wins + losses > 0
            ? parseFloat(((wins / (wins + losses)) * 100).toFixed(1))
            : null,
      };
      console.log(
        `${tag} [OUTPUT] edgeRows=${edgeRows.length} positiveEdge=${positiveEdge.length} negativeEdge=${negativeEdge.length} wins=${wins} losses=${losses}`
      );
      console.log(
        `${tag} [VERIFY] ${summary.winRateOnPositiveEdge != null ? `PASS — win rate on positive edge: ${summary.winRateOnPositiveEdge}%` : "PENDING — no outcomes yet"}`
      );
      return { rows: limited, summary };
    }),

  /**
   * Owner-only: Brier Heatmap Drill-Down.
   *
   * Returns individual game rows for a specific date, with all 5 Brier fields.
   * Used when clicking a cell in the Brier Heatmap.
   */
  getBrierDrilldown: ownerProcedure
    .input(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
        market: z.enum(["fgMl", "f5Ml", "nrfi", "fgTotal", "f5Total"]),
      })
    )
    .query(async ({ input }) => {
      const tag = `${TAG}[getBrierDrilldown]`;
      console.log(`${tag} [INPUT] date=${input.date} market=${input.market}`);
      const db = await getDb();

      const rows = await db
        .select({
          id: gamesTable.id,
          gameDate: gamesTable.gameDate,
          awayTeam: gamesTable.awayTeam,
          homeTeam: gamesTable.homeTeam,
          startTimeEst: gamesTable.startTimeEst,
          brierFgMl: gamesTable.brierFgMl,
          brierF5Ml: gamesTable.brierF5Ml,
          brierNrfi: gamesTable.brierNrfi,
          brierFgTotal: gamesTable.brierFgTotal,
          brierF5Total: gamesTable.brierF5Total,
          modelAwayWinPct: gamesTable.modelAwayWinPct,
          modelHomeWinPct: gamesTable.modelHomeWinPct,
          modelF5AwayWinPct: gamesTable.modelF5AwayWinPct,
          modelF5HomeWinPct: gamesTable.modelF5HomeWinPct,
          awayML: gamesTable.awayML,
          homeML: gamesTable.homeML,
          f5AwayML: gamesTable.f5AwayML,
          f5HomeML: gamesTable.f5HomeML,
          actualAwayScore: gamesTable.actualAwayScore,
          actualHomeScore: gamesTable.actualHomeScore,
          actualF5AwayScore: gamesTable.actualF5AwayScore,
          actualF5HomeScore: gamesTable.actualF5HomeScore,
          fgMlResult: gamesTable.fgMlResult,
          f5MlResult: gamesTable.f5MlResult,
          fgMlCorrect: gamesTable.fgMlCorrect,
          f5MlCorrect: gamesTable.f5MlCorrect,
          nrfiCorrect: gamesTable.nrfiCorrect,
        })
        .from(gamesTable)
        .where(
          and(
            eq(gamesTable.gameDate, input.date),
            isNotNull(gamesTable.outcomeIngestedAt)
          )
        )
        .orderBy(asc(gamesTable.id));

      console.log(`${tag} [STATE] games on ${input.date}: ${rows.length}`);

      // Map market field name to brier column
      const marketToBrierField: Record<string, keyof (typeof rows)[0]> = {
        fgMl: "brierFgMl",
        f5Ml: "brierF5Ml",
        nrfi: "brierNrfi",
        fgTotal: "brierFgTotal",
        f5Total: "brierF5Total",
      };
      const brierField = marketToBrierField[input.market];

      type DrillRow = (typeof rows)[number];
      const result = rows.map((r: DrillRow) => ({
        id: r.id,
        awayTeam: r.awayTeam,
        homeTeam: r.homeTeam,
        startTimeEst: r.startTimeEst,
        brierFgMl: r.brierFgMl != null ? Number(r.brierFgMl) : null,
        brierF5Ml: r.brierF5Ml != null ? Number(r.brierF5Ml) : null,
        brierNrfi: r.brierNrfi != null ? Number(r.brierNrfi) : null,
        brierFgTotal: r.brierFgTotal != null ? Number(r.brierFgTotal) : null,
        brierF5Total: r.brierF5Total != null ? Number(r.brierF5Total) : null,
        focusBrier: r[brierField] != null ? Number(r[brierField]) : null,
        modelAwayWinPct:
          r.modelAwayWinPct != null ? Number(r.modelAwayWinPct) : null,
        modelHomeWinPct:
          r.modelHomeWinPct != null ? Number(r.modelHomeWinPct) : null,
        modelF5AwayWinPct:
          r.modelF5AwayWinPct != null ? Number(r.modelF5AwayWinPct) : null,
        modelF5HomeWinPct:
          r.modelF5HomeWinPct != null ? Number(r.modelF5HomeWinPct) : null,
        awayML: r.awayML,
        homeML: r.homeML,
        f5AwayML: r.f5AwayML,
        f5HomeML: r.f5HomeML,
        actualAwayScore: r.actualAwayScore,
        actualHomeScore: r.actualHomeScore,
        actualF5AwayScore: r.actualF5AwayScore,
        actualF5HomeScore: r.actualF5HomeScore,
        fgMlResult: r.fgMlResult,
        f5MlResult: r.f5MlResult,
        fgMlCorrect: r.fgMlCorrect,
        f5MlCorrect: r.f5MlCorrect,
        nrfiCorrect: r.nrfiCorrect,
      }));

      console.log(
        `${tag} [OUTPUT] drilldown rows: ${result.length} for ${input.date} / ${input.market}`
      );
      return { date: input.date, market: input.market, games: result };
    }),
  /**
   * Owner-only: the recalibration proposals awaiting a decision.
   *
   * ISSUE-012 listed this and `decideRecalibration` as "claimed as implemented
   * and never written" — and that was the gap that made the gate a queue rather
   * than a gate. A PROPOSED row nobody can see is not an approval step; it is a
   * write nobody reads.
   */
  listRecalibrationProposals: ownerProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(100).optional().default(20),
      })
    )
    .query(async ({ input }) => {
      const tag = `${TAG}[listRecalibrationProposals]`;
      try {
        const proposals = await listRecalibrationProposals(input.limit);
        const pending = proposals.filter(
          p => p.envelope?.gate.status === "PROPOSED"
        ).length;
        console.log(
          `${tag} [OUTPUT] ${proposals.length} row(s), ${pending} PROPOSED`
        );
        return { proposals, pending };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${tag} [ERROR] ${msg}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Could not list recalibration proposals: ${msg}`,
        });
      }
    }),

  /**
   * Owner-only: approve or reject a PROPOSED recalibration.
   *
   * SECURITY. The approver's identity is taken from the authenticated session
   * (`ctx.appUser`) and NEVER from the request body — `buildApprovalRequest`
   * has no input field for it. If a caller could name themselves, both the
   * self-approval check and the owner-only check would be bypassed by lying,
   * and the proposing agent could promote its own recalibration.
   *
   * APPROVED patches the engine through the single existing implementation,
   * `migrateCalibrationConstants`, which is otherwise unreachable by default.
   */
  decideRecalibration: ownerProcedure
    .input(
      z.object({
        proposalId: z.number().int().positive(),
        decision: z.enum(["APPROVED", "REJECTED"]),
        rationale: z.string().min(1).max(2000),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const tag = `${TAG}[decideRecalibration]`;
      const request = buildApprovalRequest(
        {
          id: ctx.appUser.id,
          email: ctx.appUser.email,
          role: ctx.appUser.role,
        },
        { decision: input.decision, rationale: input.rationale }
      );
      console.log(
        `${tag} [INPUT] proposal=${input.proposalId} decision=${input.decision} by=${request.decidedBy} role=${request.role}`
      );
      try {
        const result = await decideRecalibration(
          input.proposalId,
          request,
          (calibration, reason) =>
            migrateCalibrationConstants(calibration, reason)
        );
        if (!result.ok) {
          console.warn(`${tag} [VERIFY] REFUSED — ${result.reason}`);
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: result.reason ?? "Decision refused",
          });
        }
        console.log(
          `${tag} [OUTPUT] ${result.status} constantsPatched=${result.constantsPatched ?? 0}`
        );
        return result;
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${tag} [ERROR] ${msg}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Recalibration decision failed: ${msg}`,
        });
      }
    }),
});
export type MlbScheduleRouter = typeof mlbScheduleRouter;
