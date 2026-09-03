/**
 * betTracker.ts — tRPC router for the Bet Tracker feature.
 *
 * Role-based access model (v5 — 2026-07-31):
 *   USER         — every authenticated subscriber. Sees and manages ONLY their own
 *                  bets. `targetUserId` is rejected for this role.
 *   HANDICAPPER  — own bets only; bets are IMMUTABLE after creation (must submit
 *                  an edit/delete request for owner/admin review).
 *   ADMIN        — own bets, plus read/edit/delete of any non-owner user's bets.
 *   OWNER        — own bets, plus read of any user's bets. Owner bets are
 *                  protected from admin edit/delete.
 *
 * v5 changed the base procedure from `handicapperProcedure` to
 * `appUserProcedure`. Before, role=user was rejected outright, so a regular
 * subscriber could not read even their OWN bets. Two properties come with the
 * swap and are load-bearing:
 *   1. `appUserProcedure` enforces account expiry; `handicapperProcedure` did not.
 *   2. Widening the door does NOT widen visibility. Every read resolves its
 *      scope through `resolveScope`, which only ever returns a different userId
 *      for owner/admin. See betTrackerCore.resolveViewUserId + its test matrix.
 *
 * Owner/admin-only procedures: listHandicappers, getLogs, reviewEditRequest,
 * autoGradeAll.
 *
 * Grading is NOT implemented here. Every settle path (interactive, scheduled,
 * cron) calls the single engine in ../betAutoGradeScheduler.
 *
 * Logging convention:
 *   [BetTracker][INPUT]  — raw input received
 *   [BetTracker][STEP]   — operation in progress
 *   [BetTracker][STATE]  — intermediate computed values
 *   [BetTracker][OUTPUT] — final result
 *   [BetTracker][VERIFY] — validation pass/fail
 *   [BetTracker][ERROR]  — failure with context
 */

import { z } from "zod";
import { router } from "../_core/trpc";
import { appUserProcedure } from "./appUsers";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { trackedBetLegs,
  trackedBets, appUsers, betEditRequests } from "../../drizzle/schema";
import { eq, and, desc, inArray, asc, gte, lte, lt, or, sql } from "drizzle-orm";
import { fetchAnSlate, resolveLogoUrl } from "../actionNetwork";
import { gradePendingForUser, gradeAllPendingForDate } from "../betAutoGradeScheduler";
import { gradeParlaysForUser } from "../parlayGrader";
import {
  buildStatsCacheKey,
  buildStatsFingerprint,
  getStatsCache,
  setStatsCache,
  invalidateStatsCacheForUser,
} from "../betTrackerStatsCache";
import {
  aggregateStats,
  downsampleEquityCurve,
  calcToWin,
  decideBetMutation,
  decidePrivilegedAccess,
  decideResultOverride,
  decideStakeDenomination,
  decodeCursor,
  derivePickLabel,
  effectiveLine,
  encodeCursor,
  marketRequiresLine,
  resolveLineForUpdate,
  resolveStakePatch,
  resolveViewUserId,
  toUnits as coreToUnits,
  type BetStats,
  type Market as CoreMarket,
  type PickSide as CorePickSide,
  type StatRow,
  type Timeframe as CoreTimeframe,
} from "../betTrackerCore";
import { checkGradingSupport } from "@shared/gradingSupport";
import {
  MIN_PARLAY_LEGS,
  MAX_PARLAY_LEGS,
  americanToDecimal,
  calcParlayToWin,
  validateParlayLegs,
} from "../parlayCore";

// Re-exported for the scheduler's historical import path and for tests that
// assert cache behaviour through the router's public surface.
export { invalidateStatsCacheForUser } from "../betTrackerStatsCache";

// ─── Shared Zod enums ─────────────────────────────────────────────────────────

const RESULTS    = ["PENDING", "WIN", "LOSS", "PUSH", "VOID"] as const;
const SPORTS     = ["NCAAF", "MLB", "NBA", "NHL", "NCAAM", "NFL", "CUSTOM"] as const;
const TIMEFRAMES = [
  "FULL_GAME",
  "FIRST_5",
  "FIRST_INNING",
  "NRFI",
  "YRFI",
  "REGULATION",
  "FIRST_PERIOD",
  "FIRST_HALF",
  "FIRST_QUARTER",
] as const;
const MARKETS    = ["ML", "RL", "TOTAL"] as const;
const PICK_SIDES = ["AWAY", "HOME", "OVER", "UNDER"] as const;
const WAGER_TYPES = ["PREGAME", "LIVE"] as const;

// ─── Shared plumbing ──────────────────────────────────────────────────────────
//
// The stats cache lives in ../betTrackerStatsCache and the domain rules
// (permissions, stake math, line invariants, cursor codec, aggregation) live in
// ../betTrackerCore. Both are pure/dependency-light so they are unit-testable
// without a database — see server/betTrackerCore.test.ts.

/** Columns the stats aggregation actually reads. See StatRow in betTrackerCore. */
const STAT_COLUMNS = {
  id:         trackedBets.id,
  gameDate:   trackedBets.gameDate,
  result:     trackedBets.result,
  sport:      trackedBets.sport,
  market:     trackedBets.market,
  betType:    trackedBets.betType,
  timeframe:  trackedBets.timeframe,
  wagerType:  trackedBets.wagerType,
  pick:       trackedBets.pick,
  odds:       trackedBets.odds,
  risk:       trackedBets.risk,
  toWin:      trackedBets.toWin,
  riskUnits:  trackedBets.riskUnits,
  toWinUnits: trackedBets.toWinUnits,
  /** Distinguishes a parlay ticket from a straight bet in the byType breakdown. */
  legCount:   trackedBets.legCount,
} as const;


/**
 * The unit-denominated payout to store alongside `riskUnits`.
 *
 * Explicit input wins. Otherwise it is derived from the unit size the caller
 * implied (risk ÷ riskUnits) so the stored pair always agrees with the price.
 * Null only when there is no unit basis at all — `aggregateStats` then falls
 * back to dollars ÷ the viewer's unit size for BOTH figures, which is
 * consistent even if it is not authoritative.
 */
function resolveToWinUnits(
  riskUnits: number | undefined,
  toWinUnits: number | undefined,
  risk: number,
  toWin: number,
): string | null {
  if (toWinUnits != null) return String(toWinUnits);
  if (riskUnits == null || riskUnits <= 0) return null;
  const unitSize = risk / riskUnits;
  if (!Number.isFinite(unitSize) || unitSize <= 0) return null;
  return (toWin / unitSize).toFixed(4);
}

/**
 * Enforce the unit-only rule at the write boundary.
 *
 * The UI hides dollar entry for subscribers, but a UI restriction is cosmetic:
 * this procedure is reachable by any authenticated subscriber. A bet that
 * arrives with no riskUnits is dollar-denominated by definition — there is no
 * unit basis to render it in — so it is refused here.
 */
function assertUnitDenomination(role: string, riskUnits: number | undefined, what: string): void {
  const rule = decideStakeDenomination(role);
  if (!rule.unitsOnly) return;
  if (riskUnits != null && riskUnits > 0) return;
  console.log(`[BetTracker][ERROR] ${what}: role=${role} submitted no riskUnits — units are required`);
  throw new TRPCError({ code: "BAD_REQUEST", message: rule.reason });
}

/** Throw the tRPC error a core decision describes, or fall through. */
function assertDecision(d: { allowed: boolean; code?: string; message?: string }): void {
  if (d.allowed) return;
  throw new TRPCError({ code: "FORBIDDEN", message: d.message ?? "Forbidden" });
}

/**
 * Resolve which user's rows a read may touch, throwing FORBIDDEN when a
 * non-privileged caller asks for someone else's. Every read procedure funnels
 * through this so the visibility rule has exactly one implementation.
 */
function resolveScope(ctx: { appUser: { id: number; role: string } }, targetUserId?: number): number {
  const res = resolveViewUserId({ role: ctx.appUser.role, viewerId: ctx.appUser.id, targetUserId });
  if (!res.ok) {
    console.log(`[BetTracker][ERROR] scope: FORBIDDEN — role=${ctx.appUser.role} viewer=${ctx.appUser.id} target=${targetUserId}`);
    throw new TRPCError({ code: "FORBIDDEN", message: res.message });
  }
  return res.userId;
}

/**
 * Same as resolveScope, but additionally proves the target account exists.
 *
 * `resolveViewUserId` answers "may this caller read that id?", not "is that id
 * real". An owner/admin could therefore query any integer and receive a
 * confident, well-formed empty tracker — indistinguishable from a real user who
 * has never placed a bet. That is a silent-wrong-answer shape: it turns a typo
 * into plausible data, and it read as "this user has no bets" for the whole
 * period account 60002 existed only as orphaned rows.
 *
 * Self-scoped reads skip the lookup entirely — the caller is authenticated, so
 * their own existence is not in question and this costs nothing on the hot path.
 */
async function resolveScopeChecked(
  ctx: { appUser: { id: number; role: string } },
  targetUserId?: number,
): Promise<number> {
  const userId = resolveScope(ctx, targetUserId);
  if (userId === ctx.appUser.id) return userId;

  const db = await getDb();
  const [target] = await db
    .select({ id: appUsers.id })
    .from(appUsers)
    .where(eq(appUsers.id, userId))
    .limit(1);
  if (!target) {
    console.log(`[BetTracker][ERROR] scope: NOT_FOUND — viewer=${ctx.appUser.id} target=${userId} does not exist`);
    throw new TRPCError({ code: "NOT_FOUND", message: `No account with id ${userId}` });
  }
  return userId;
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const betTrackerRouter = router({

  /**
   * listHandicappers — OWNER/ADMIN only: the accounts the tracker selector can
   * switch to.
   *
   * Scoped to accounts that ACTUALLY HAVE BETS, across every role.
   *
   * It used to filter `role IN (owner, admin, handicapper)`, which made sense
   * when the tracker was staff-only. Once the page opened to subscribers the
   * filter became the thing standing between an admin and the people using the
   * feature: on 2026-08-03 four `role=user` accounts held 17 bets and not one
   * was reachable, so admins could see 39% of tracked bets and none belonging to
   * a real user. The server already permitted the read (resolveViewUserId lets
   * owner/admin target anyone) — only the picker was blind.
   *
   * Driving the list off bet ownership rather than role also keeps it short and
   * self-maintaining: a new subscriber shows up the moment they log a bet, and
   * accounts that never use the tracker never clutter it.
   */
  listHandicappers: appUserProcedure
    .query(async ({ ctx }) => {
      assertDecision(decidePrivilegedAccess(ctx.appUser.role, "list other users"));
      const db = await getDb();
      const rows = await db
        .selectDistinct({ id: appUsers.id, username: appUsers.username, role: appUsers.role })
        .from(appUsers)
        .innerJoin(trackedBets, eq(trackedBets.userId, appUsers.id))
        .orderBy(appUsers.id);
      console.log(`[BetTracker][OUTPUT] listHandicappers: ${rows.length} accounts with bets returned`);
      return rows;
    }),

  /**
   * create — add a new tracked bet for the calling user.
   *
   * Always self-scoped: there is no targetUserId. `pick` is derived from
   * pickSide + market + team abbreviations, `toWin` from odds + risk.
   *
   * INVARIANT (enforced by the .superRefine below): an RL or TOTAL bet must
   * carry a line. There is no safe default — guessing -1.5 inverts every
   * underdog run line on a one-run margin, and guessing 0 grades a spread as a
   * moneyline. Rejecting at write time is the only way the grader can be
   * trusted later.
   */
  create: appUserProcedure
    .input(z.object({
      // Game identification
      anGameId:   z.number().int().positive(),
      /** Doubleheader game number: 1 = G1, 2 = G2. Defaults to 1 for non-DH games. */
      gameNumber: z.number().int().min(1).max(2).default(1),
      sport:      z.enum(SPORTS).default("MLB"),
      // [FIX] Normalize gameDate: strip any time component (iOS Safari sends ISO datetime).
      // Transform runs BEFORE regex validation, so "2026-05-16T12:00:00" → "2026-05-16" passes.
      gameDate:   z.string()
        .transform(v => (v || "").slice(0, 10))
        .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "gameDate must be YYYY-MM-DD")),
      awayTeam:   z.string().min(1).max(128),
      homeTeam:   z.string().min(1).max(128),
      // Bet structure
      timeframe:  z.enum(TIMEFRAMES).default("FULL_GAME"),
      market:     z.enum(MARKETS).default("ML"),
      pickSide:   z.enum(PICK_SIDES),
      // Stake
      odds:       z.number().int().min(-10000).max(10000),
      risk:       z.number().positive().max(1_000_000),
      toWin:      z.number().positive().optional(),
      // Optional
      line:       z.number().optional(),         // RL spread or Total line value (default)
      customLine: z.number().optional(),         // Exact custom line override (e.g. 8.0 for Over 8)
      wagerType:  z.enum(WAGER_TYPES).default("PREGAME"),
      notes:      z.string().max(2000).optional(),
      // Unit-denominated amounts for accurate analytics bucketing
      riskUnits:  z.number().positive().optional(),  // e.g. 3.0 for a 3U play
      toWinUnits: z.number().positive().optional(),  // e.g. 5.0 for a 5U to-win play
    }).superRefine((val, ctx) => {
      if (marketRequiresLine(val.market as CoreMarket) && effectiveLine(val.line, val.customLine) === null) {
        ctx.addIssue({
          code: "custom",
          path: ["line"],
          message: `${val.market} bets require a line (send line or customLine)`,
        });
      }
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.appUser.id;

      assertUnitDenomination(ctx.appUser.role, input.riskUnits, "create");

      // Refuse a combination the grader cannot settle, for the same reason the
      // RL/TOTAL line invariant is enforced here: a bet with no code path does
      // not fail loudly, it sits PENDING until the 36h stuck alarm. NFL was
      // accepted by this form and absent from the grader entirely.
      const support = checkGradingSupport(input.sport, input.timeframe);
      if (!support.ok) {
        console.log(`[BetTracker][ERROR] create: userId=${userId} ungradeable ${input.sport}/${input.timeframe} — ${support.message}`);
        throw new TRPCError({ code: "BAD_REQUEST", message: support.message });
      }

      const toWin  = input.toWin ?? calcToWin(input.odds, input.risk);
      const pick   = derivePickLabel(input.pickSide, input.market, input.awayTeam, input.homeTeam, input.timeframe);

      console.log(`[BetTracker][INPUT] create: userId=${userId} sport=${input.sport} date=${input.gameDate} anGameId=${input.anGameId} gameNumber=${input.gameNumber} timeframe=${input.timeframe} market=${input.market} pickSide=${input.pickSide} pick="${pick}" odds=${input.odds} risk=${input.risk} toWin=${toWin} wagerType=${input.wagerType} customLine=${input.customLine ?? "null"}`);
      console.log(`[BetTracker][STATE] create: awayTeam=${input.awayTeam} homeTeam=${input.homeTeam} derivedPick="${pick}"`);

      const db = await getDb();

      // ── Idempotency guard: prevent duplicate bets from double-tap / network retry ──
      // If an identical bet (same user, game, market, pickSide, odds) was inserted in
      // the last 30 seconds, return the existing bet ID instead of creating a new row.
      //
      // The 30-second bound is computed BY THE DATABASE, not in Node.
      //
      // It used to be `new Date(Date.now() - 30_000)`, which mysql2 serialises
      // using the Node process's local timezone and the server then compares
      // against a column stored in the DB's timezone. Both are "SYSTEM", so the
      // guard was only correct while those two happened to agree. Measured on a
      // PDT workstation against the UTC production DB, that same predicate
      // matched rows up to SEVEN HOURS old — a 30-second duplicate guard
      // silently becomes a multi-hour one, swallowing legitimate re-entries
      // (exactly the correction pattern seen in bets 390003/390004 and
      // 420001/420002). Nothing in the container pins TZ, so the agreement was
      // luck rather than design.
      //
      // `UTC_TIMESTAMP() - INTERVAL 30 SECOND` is evaluated server-side against
      // the same clock that wrote `createdAt`, so no timezone conversion happens
      // anywhere and the window is exactly 30 seconds regardless of where the
      // Node process runs.
      const idempotencyWindow = sql`${trackedBets.createdAt} >= UTC_TIMESTAMP() - INTERVAL 30 SECOND`;
      const [existing] = await db
        .select({ id: trackedBets.id })
        .from(trackedBets)
        .where(
          and(
            eq(trackedBets.userId,    userId),
            eq(trackedBets.anGameId,  input.anGameId),
            eq(trackedBets.gameNumber, input.gameNumber),
            eq(trackedBets.market,    input.market),
            eq(trackedBets.pickSide,  input.pickSide),
            eq(trackedBets.odds,      input.odds),
            idempotencyWindow,
          )
        )
        .limit(1);
      if (existing) {
        console.log(`[BetTracker][IDEMPOTENCY] Duplicate detected within 30s — returning full existing bet id=${existing.id}`);
        // Return the full bet row (not a partial sentinel) so the client onSuccess handler
        // can safely replace the optimistic placeholder without a broken cache entry.
        const [existingFull] = await db.select().from(trackedBets).where(eq(trackedBets.id, existing.id));
        return existingFull;
      }

      const [result] = await db.insert(trackedBets).values({
        userId,
        anGameId:   input.anGameId,
        gameNumber: input.gameNumber,
        sport:      input.sport,
        gameDate:   input.gameDate,
        awayTeam:   input.awayTeam,
        homeTeam:   input.homeTeam,
        timeframe:  input.timeframe,
        market:     input.market,
        pickSide:   input.pickSide,
        betType:    input.market === "TOTAL" ? (input.pickSide === "OVER" ? "OVER" : "UNDER") : input.market,
        pick,
        odds:       input.odds,
        risk:       String(input.risk),
        toWin:      String(toWin),
        riskUnits:  input.riskUnits !== undefined ? String(input.riskUnits) : null,
        // Derived when the client omits it, exactly as createParlay does. A row
        // with riskUnits but NULL toWinUnits reads back mixed-basis: risk in
        // stored units, toWin in dollars ÷ the viewer's CURRENT unit size.
        toWinUnits: resolveToWinUnits(input.riskUnits, input.toWinUnits, input.risk, toWin),
        book:       null,
        line:       input.line !== undefined ? String(input.line) : null,
        customLine: input.customLine !== undefined ? String(input.customLine) : null,
        wagerType:  input.wagerType,
        notes:      input.notes ?? null,
        result:     "PENDING",
      });

      const insertId = (result as { insertId: number }).insertId;
      console.log(`[BetTracker][OUTPUT] create: SUCCESS — insertId=${insertId} userId=${userId} pick="${pick}"`);
      console.log(`[BetTracker][VERIFY] create: PASS — bet inserted with id=${insertId}`);

      // ── Auto-grade-on-create ──────────────────────────────────────────────────
      // A bet logged for a past date can usually settle immediately. Delegated to
      // the shared engine rather than reimplemented here: the old inline copy had
      // already drifted from the scheduler's (it overwrote team abbreviations
      // whenever they differed, while the scheduler only filled blanks).
      const todayPt = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      if (input.gameDate < todayPt) {
        try {
          const summary = await gradePendingForUser(userId, { gameDate: input.gameDate }, "create");
          console.log(`[BetTracker][STATE] create: autoGradeOnCreate — graded=${summary.graded} stillPending=${summary.stillPending} for date=${input.gameDate}`);
        } catch (gradeErr) {
          // Never fail the create because grading failed; the scheduler retries.
          console.error(`[BetTracker][ERROR] create: autoGradeOnCreate FAILED for betId=${insertId} — ${String(gradeErr)}`);
        }
      }

      const [created] = await db.select().from(trackedBets).where(eq(trackedBets.id, insertId));
      // Reflect the new bet in the next paginated read immediately.
      invalidateStatsCacheForUser(userId);
      return created;
    }),

  /**
   * update — update an existing bet.
   *
   * Access: see betTrackerCore.decideBetMutation (owner/user self-only, admin
   * may touch any non-owner bet, handicapper must use submitEditRequest).
   *
   * INVARIANT: the stored `line` is a SIGNED spread for RL and an UNSIGNED total
   * for TOTAL. Changing pickSide flips the spread's sign; changing market
   * invalidates the stored line entirely. Both are resolved here by
   * `resolveLineForUpdate` — previously neither was, so flipping AWAY↔HOME on a
   * run line silently inverted the grade on every one-run margin, and switching
   * RL→TOTAL reused "-1.5" as a total so every OVER won.
   */
  update: appUserProcedure
    .input(z.object({
      id:         z.number().int().positive(),
      timeframe:  z.enum(TIMEFRAMES).optional(),
      market:     z.enum(MARKETS).optional(),
      pickSide:   z.enum(PICK_SIDES).optional(),
      odds:       z.number().int().min(-10000).max(10000).optional(),
      risk:       z.number().positive().max(1_000_000).optional(),
      toWin:      z.number().positive().optional(),
      // Unit restatements — the only stake denomination units-only roles may
      // send. Dollars follow at the row's held unit size (betTrackerCore).
      riskUnits:  z.number().positive().optional(),
      toWinUnits: z.number().positive().optional(),
      notes:      z.string().max(2000).optional(),
      result:     z.enum(RESULTS).optional(),
      wagerType:  z.enum(WAGER_TYPES).optional(),
      customLine: z.number().optional(),
      line:       z.number().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.appUser.id;
      const role   = ctx.appUser.role;
      console.log(`[BetTracker][INPUT] update: userId=${userId} role=${role} betId=${input.id} fields=${JSON.stringify(Object.keys(input).filter(k => k !== 'id'))}`);

      const db = await getDb();
      const [existing] = await db.select().from(trackedBets).where(eq(trackedBets.id, input.id));
      if (!existing) {
        console.log(`[BetTracker][ERROR] update: betId=${input.id} not found`);
        throw new TRPCError({ code: "NOT_FOUND", message: "Bet not found" });
      }

      // ── Access control ────────────────────────────────────────────────────────
      const [betOwner] = await db
        .select({ id: appUsers.id, role: appUsers.role })
        .from(appUsers)
        .where(eq(appUsers.id, existing.userId));
      const betOwnerRole = betOwner?.role ?? "user";

      assertDecision(decideBetMutation({
        actorRole: role,
        actorId: userId,
        betOwnerId: existing.userId,
        betOwnerRole,
        action: "update",
      }));

      // ── Build update payload ──────────────────────────────────────────────────
      const patch: Record<string, unknown> = {};
      if (input.timeframe  !== undefined) patch.timeframe  = input.timeframe;
      if (input.market     !== undefined) patch.market     = input.market;
      if (input.pickSide   !== undefined) patch.pickSide   = input.pickSide;
      if (input.notes      !== undefined) patch.notes      = input.notes;
      // Hand-written results are owner/admin only — see decideResultOverride.
      // A no-op "change" (same value resent by a form that round-trips every
      // field) is not an override and must not be rejected.
      if (input.result !== undefined && input.result !== existing.result) {
        assertDecision(decideResultOverride(role));
        // Structured, greppable audit line. The engine always persists scores
        // alongside a result, so a manual override is the only way a row ends up
        // graded with none — this is the record of who did it and when.
        console.log(
          `[BetTracker][RESULT_OVERRIDE] betId=${input.id} ownedBy=${existing.userId} ` +
          `by=${userId}(${role}) ${existing.result} -> ${input.result} ` +
          `storedScore=${existing.awayScore ?? "null"}-${existing.homeScore ?? "null"} ` +
          `at=${new Date().toISOString()}`
        );
        patch.result = input.result;
      }
      if (input.wagerType  !== undefined) patch.wagerType  = input.wagerType;

      const newMarket   = (input.market   ?? existing.market)   as typeof MARKETS[number];
      const newPickSide = (input.pickSide ?? existing.pickSide) as typeof PICK_SIDES[number];

      // ── Line resolution (the RL/TOTAL invariant) ──────────────────────────────
      const lineRes = resolveLineForUpdate({
        prevMarket:     existing.market as CoreMarket,
        nextMarket:     newMarket as CoreMarket,
        prevPickSide:   existing.pickSide as CorePickSide,
        nextPickSide:   newPickSide as CorePickSide,
        prevLine:       existing.line,
        prevCustomLine: existing.customLine,
        nextLine:       input.line,
        nextCustomLine: input.customLine,
      });
      if (!lineRes.ok) {
        console.log(`[BetTracker][ERROR] update: betId=${input.id} ${lineRes.message}`);
        throw new TRPCError({ code: "BAD_REQUEST", message: lineRes.message });
      }
      // Only patch the line columns when they actually change, so an unrelated
      // edit (a note, say) stays a no-op instead of rewriting the row.
      const nextLineStr   = lineRes.line === null ? null : String(lineRes.line);
      const nextCustomStr = lineRes.customLine === null ? null : String(lineRes.customLine);
      const sameDecimal = (a: string | null, b: string | null): boolean => {
        if (a === null || b === null) return a === b;
        return Math.abs(parseFloat(a) - parseFloat(b)) < 1e-9;
      };
      if (!sameDecimal(nextLineStr, existing.line ?? null)) patch.line = nextLineStr;
      if (!sameDecimal(nextCustomStr, existing.customLine ?? null)) patch.customLine = nextCustomStr;
      if (lineRes.flipped) {
        console.log(`[BetTracker][STATE] update: betId=${input.id} RL side flip ${existing.pickSide}→${newPickSide} — line sign inverted to ${lineRes.line}`);
      }

      // Re-derive pick label if market, pickSide or timeframe changed.
      // Timeframe matters: an NRFI/YRFI bet's label is the timeframe, not the
      // team, and the previous version dropped it so editing an NRFI bet
      // relabelled it "<TEAM> ML".
      const newTimeframe = (input.timeframe ?? existing.timeframe) as CoreTimeframe;
      if (input.market !== undefined || input.pickSide !== undefined || input.timeframe !== undefined) {
        const awayTeam = existing.awayTeam ?? "";
        const homeTeam = existing.homeTeam ?? "";
        patch.pick    = derivePickLabel(newPickSide as CorePickSide, newMarket as CoreMarket, awayTeam, homeTeam, newTimeframe);
        patch.betType = newMarket === "TOTAL"
          ? (newPickSide === "OVER" ? "OVER" : "UNDER")
          : newMarket;
        console.log(`[BetTracker][STATE] update: re-derived pick="${patch.pick}" betType="${patch.betType}"`);
      }

      // ── Stake reconciliation — ONE implementation, in betTrackerCore ────────
      // The gate (units-only roles may not state dollars), the size law (the
      // row's implied unit size holds constant) and the pair law (toWinUnits
      // tracks toWin proportionally) all live in resolveStakePatch, shared
      // with reviewEditRequest so the two write paths cannot drift.
      const newOdds = input.odds ?? existing.odds;
      const stake = resolveStakePatch({
        actorRole: role,
        existing: {
          risk:       existing.risk,
          toWin:      existing.toWin,
          riskUnits:  existing.riskUnits,
          toWinUnits: existing.toWinUnits,
        },
        odds: newOdds,
        oddsChanged: input.odds !== undefined && input.odds !== existing.odds,
        risk:       input.risk,
        toWin:      input.toWin,
        riskUnits:  input.riskUnits,
        toWinUnits: input.toWinUnits,
      });
      if (!stake.ok) {
        console.log(`[BetTracker][ERROR] update: betId=${input.id} role=${role} stake refused — ${stake.message}`);
        throw new TRPCError({ code: "BAD_REQUEST", message: stake.message });
      }
      if (Object.keys(stake.fields).length > 0) {
        Object.assign(patch, stake.fields);
        console.log(`[BetTracker][STATE] update: stake reconciled — ${JSON.stringify(stake.fields)}`);
      }
      if (input.odds !== undefined) {
        patch.odds = input.odds;
        // On a parlay, originalOdds is the basis every reprice divides from.
        // Moving `odds` alone would leave the grader dividing from the OLD
        // price, so the next sweep would silently revert the correction and
        // pay the wrong number. A user editing the ticket price is restating
        // what the book gave them, so the basis moves with it.
        if (existing.legCount > 0) patch.originalOdds = input.odds;
      }

      if (Object.keys(patch).length === 0) {
        console.log(`[BetTracker][OUTPUT] update: no-op — no fields changed for betId=${input.id}`);
        return existing;
      }

      await db.update(trackedBets).set(patch).where(eq(trackedBets.id, input.id));
      const [updated] = await db.select().from(trackedBets).where(eq(trackedBets.id, input.id));
      console.log(`[BetTracker][OUTPUT] update: SUCCESS — betId=${input.id} result=${updated?.result} pick="${updated?.pick}"`);
      // Invalidate the cache of the bet's OWNER, not the actor. An admin editing
      // a handicapper's bet used to clear its own (empty) entries and leave the
      // handicapper staring at stale W/L and ROI for the full TTL.
      invalidateStatsCacheForUser(existing.userId);
      if (existing.userId !== userId) invalidateStatsCacheForUser(userId);
      return updated;
    }),

  /**
   * delete — remove a bet by id.
   * Access: see betTrackerCore.decideBetMutation.
   */
  /**
   * createParlay — add a parlay ticket and its legs.
   *
   * Deliberately NOT folded into `create`. That mutation is built around a
   * single game: it requires one anGameId, derives one pick label from one
   * pair of teams, and guards duplicates on (user, game, market, pickSide,
   * odds). A ticket has none of those things, so overloading it would mean
   * making every one of those fields conditional on a mode flag — on the write
   * path that 205 live straight bets depend on. A separate procedure keeps
   * that path byte-for-byte unchanged.
   *
   * THE TICKET PRICE IS WHAT THE USER ENTERED. It is stored twice: `odds` is
   * the live price and moves when a leg pushes, `originalOdds` never moves.
   * Repricing always divides from `originalOdds`, so settlement is idempotent
   * under a grading loop that re-runs every 30 minutes, and a correlated (SGP)
   * or boosted price is preserved rather than rebuilt from its legs.
   */
  createParlay: appUserProcedure
    .input(z.object({
      legs: z.array(z.object({
        anGameId:   z.number().int().positive(),
        gameNumber: z.number().int().min(1).max(2).default(1),
        sport:      z.enum(SPORTS).default("MLB"),
        gameDate:   z.string()
          .transform(v => (v || "").slice(0, 10))
          .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "gameDate must be YYYY-MM-DD")),
        awayTeam:   z.string().min(1).max(128),
        homeTeam:   z.string().min(1).max(128),
        market:     z.enum(MARKETS),
        pickSide:   z.enum(PICK_SIDES),
        timeframe:  z.enum(TIMEFRAMES).default("FULL_GAME"),
        line:       z.number().nullable().optional(),
        odds:       z.number().int(),
      })).min(MIN_PARLAY_LEGS).max(MAX_PARLAY_LEGS),
      /** The ticket price as the book quoted it. */
      odds:       z.number().int(),
      risk:       z.number().positive(),
      toWin:      z.number().optional(),
      riskUnits:  z.number().positive().optional(),
      toWinUnits: z.number().positive().optional(),
      wagerType:  z.enum(WAGER_TYPES).default("PREGAME"),
      book:       z.string().max(64).optional(),
      notes:      z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.appUser.id;

      assertUnitDenomination(ctx.appUser.role, input.riskUnits, "createParlay");

      // Every leg, before anything is written. A ticket is all-or-nothing, so a
      // single ungradeable leg holds the whole thing open indefinitely.
      for (let i = 0; i < input.legs.length; i++) {
        const leg = input.legs[i];
        const legSupport = checkGradingSupport(leg.sport, leg.timeframe);
        if (!legSupport.ok) {
          console.log(`[BetTracker][ERROR] createParlay: userId=${userId} leg ${i + 1} ungradeable ${leg.sport}/${leg.timeframe}`);
          throw new TRPCError({ code: "BAD_REQUEST", message: `Leg ${i + 1}: ${legSupport.message}` });
        }
      }

      const validation = validateParlayLegs(
        input.legs.map(l => ({ odds: l.odds, market: l.market, line: l.line ?? null })),
      );
      if (!validation.ok) {
        console.log(`[BetTracker][ERROR] createParlay: userId=${userId} ${validation.message}`);
        throw new TRPCError({ code: "BAD_REQUEST", message: validation.message });
      }
      try {
        americanToDecimal(input.odds);
      } catch {
        throw new TRPCError({ code: "BAD_REQUEST", message: `${input.odds} is not a valid American price` });
      }

      const toWin = input.toWin ?? calcParlayToWin(input.risk, input.odds);

      // The ticket cannot settle before its LAST leg does. Dating the parent
      // any earlier would make the stuck-bet alarm fire on a ticket that is
      // simply waiting for a game that has not been played yet.
      const gameDate = input.legs.reduce((max, l) => (l.gameDate > max ? l.gameDate : max), input.legs[0].gameDate);

      // Sport is display/filter metadata on the parent; grading is driven by
      // each leg's own sport. A mixed-sport ticket files under its first leg.
      const sports = new Set(input.legs.map(l => l.sport));
      const sport = sports.size === 1 ? input.legs[0].sport : input.legs[0].sport;

      const pick = `${input.legs.length}-leg parlay`;

      console.log(
        `[BetTracker][INPUT] createParlay: userId=${userId} legs=${input.legs.length} odds=${input.odds} ` +
        `risk=${input.risk} toWin=${toWin} gameDate=${gameDate} sport=${sport} mixedSport=${sports.size > 1}`,
      );

      const db = await getDb();

      // Idempotency guard, same 30-second DB-side window the straight-bet path
      // uses and for the same reason (double-tap, network retry). Keyed on the
      // ticket's own shape since there is no single game to key on.
      const [dupe] = await db
        .select({ id: trackedBets.id })
        .from(trackedBets)
        .where(and(
          eq(trackedBets.userId, userId),
          eq(trackedBets.legCount, input.legs.length),
          eq(trackedBets.odds, input.odds),
          eq(trackedBets.risk, String(input.risk)),
          sql`${trackedBets.createdAt} >= UTC_TIMESTAMP() - INTERVAL 30 SECOND`,
        ))
        .limit(1);

      // Shape alone is not identity. Two genuinely different tickets can share
      // (legCount, odds, risk) — the same stake on the same price across a
      // different set of games is an ordinary thing to do, and a shape-only
      // guard would silently discard the second one and hand back the first.
      // Compare the actual selections before calling it a duplicate.
      if (dupe) {
        const existingLegs = await db
          .select({
            anGameId: trackedBetLegs.anGameId,
            market:   trackedBetLegs.market,
            pickSide: trackedBetLegs.pickSide,
            odds:     trackedBetLegs.odds,
          })
          .from(trackedBetLegs)
          .where(eq(trackedBetLegs.betId, dupe.id))
          .orderBy(asc(trackedBetLegs.legIndex));

        const fingerprint = (ls: Array<{ anGameId: number | null; market: string | null; pickSide: string | null; odds: number }>) =>
          ls.map(l => `${l.anGameId}:${l.market}:${l.pickSide}:${l.odds}`).sort().join("|");

        if (fingerprint(existingLegs) === fingerprint(input.legs)) {
          console.log(`[BetTracker][OUTPUT] createParlay: duplicate within 30s — returning existing ticket ${dupe.id}`);
          return { id: dupe.id, duplicate: true as const };
        }
        console.log(`[BetTracker][STATE] createParlay: same shape as ticket ${dupe.id} but different legs — creating a new ticket`);
      }

      const [inserted] = await db.insert(trackedBets).values({
        userId,
        sport,
        gameDate,
        betType:    "PARLAY",
        market:     "ML",       // column is NOT NULL; byType keys off legCount
        timeframe:  "FULL_GAME",
        pick,
        odds:         input.odds,
        originalOdds: input.odds,
        legCount:     input.legs.length,
        risk:       String(input.risk),
        toWin:      toWin.toFixed(2),
        riskUnits:  input.riskUnits  != null ? String(input.riskUnits)  : null,
        // Derive toWinUnits when the caller gives riskUnits but not this.
        //
        // The two are a pair: riskUnits is authoritative regardless of the
        // viewer's current unit size, so storing one without the other leaves
        // risk reading from the stored value while to-win falls back to
        // dollars ÷ today's unit size. The first real parlay landed exactly
        // that way — correct at a $100 unit, and at any other unit showing a
        // payout ratio the odds never implied.
        //
        // Fixed on the client too, but derived here as well: this procedure is
        // reachable by any subscriber, and a defect that depends on the caller
        // sending the right field will come back the moment another caller
        // appears.
        toWinUnits: resolveToWinUnits(input.riskUnits, input.toWinUnits, input.risk, toWin),
        wagerType:  input.wagerType,
        book:       input.book,
        notes:      input.notes,
        result:     "PENDING",
      }).$returningId();

      const betId = inserted.id;

      // If the legs fail to insert, the ticket must not survive. A parent with
      // legCount=N and zero leg rows can never settle: the grader finds no legs,
      // logs an error, and leaves it PENDING forever — a bet the user can see,
      // that counts as open risk, and that nothing can ever resolve.
      //
      // MySQL DDL-free inserts here are two statements rather than one
      // transaction because the surrounding code path is not transactional and
      // drizzle's mysql2 driver would need a dedicated connection; compensating
      // is equivalent for this shape and does not change the connection model.
      try {
        await db.insert(trackedBetLegs).values(
          input.legs.map((l, i) => ({
            betId,
            legIndex:   i,
            sport:      l.sport,
            gameDate:   l.gameDate,
            awayTeam:   l.awayTeam,
            homeTeam:   l.homeTeam,
            anGameId:   l.anGameId,
            gameNumber: l.gameNumber,
            market:     l.market,
            pickSide:   l.pickSide,
            timeframe:  l.timeframe,
            line:       l.line != null ? String(l.line) : null,
            odds:       l.odds,
            pick:       derivePickLabel(l.pickSide, l.market, l.awayTeam, l.homeTeam, l.timeframe),
            result:     "PENDING" as const,
          })),
        );
      } catch (err) {
        await db.delete(trackedBetLegs).where(eq(trackedBetLegs.betId, betId));
        await db.delete(trackedBets).where(eq(trackedBets.id, betId));
        console.log(`[BetTracker][ERROR] createParlay: leg insert failed for ticket ${betId} — rolled back: ${(err as Error).message}`);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not save the parlay legs. Nothing was saved." });
      }

      // ── Auto-grade-on-create ──────────────────────────────────────────────────
      // Parity with `create`, which settles a backdated bet immediately rather
      // than leaving it for the next sweep. Without this a ticket logged for
      // games already played sat PENDING until the sweep reached it — the
      // straight-bet path resolved instantly while the parlay path did not,
      // for no reason a user could see.
      //
      // Keyed on the EARLIEST leg, not the ticket's gameDate: the ticket is
      // dated by its LAST leg (so the stuck alarm does not fire early), so a
      // ticket with one played game and one tomorrow would otherwise look
      // entirely in the future and skip grading its settleable leg.
      const earliestLeg = input.legs.reduce(
        (min, l) => (l.gameDate < min ? l.gameDate : min),
        input.legs[0].gameDate,
      );
      const todayPtParlay = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      if (earliestLeg < todayPtParlay) {
        try {
          const summary = await gradeParlaysForUser(userId, "createParlay");
          console.log(
            `[BetTracker][STATE] createParlay: autoGradeOnCreate — legsSettled=${summary.legsSettled} ` +
            `ticketsSettled=${summary.ticketsSettled} earliestLeg=${earliestLeg}`,
          );
        } catch (gradeErr) {
          // Never fail the create because grading failed; the sweep retries.
          console.error(`[BetTracker][ERROR] createParlay: autoGradeOnCreate FAILED for ticket ${betId} — ${String(gradeErr)}`);
        }
      }

      invalidateStatsCacheForUser(userId);
      console.log(`[BetTracker][OUTPUT] createParlay: SUCCESS — ticket ${betId} with ${input.legs.length} legs for userId=${userId}`);
      return { id: betId, duplicate: false as const };
    }),

  delete: appUserProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.appUser.id;
      const role   = ctx.appUser.role;
      console.log(`[BetTracker][INPUT] delete: userId=${userId} role=${role} betId=${input.id}`);

      const db = await getDb();
      const [existing] = await db.select().from(trackedBets).where(eq(trackedBets.id, input.id));
      if (!existing) {
        console.log(`[BetTracker][ERROR] delete: betId=${input.id} not found`);
        throw new TRPCError({ code: "NOT_FOUND", message: "Bet not found" });
      }

      // Fetch the bet owner's role
      const [betOwner] = await db
        .select({ id: appUsers.id, role: appUsers.role })
        .from(appUsers)
        .where(eq(appUsers.id, existing.userId));
      const betOwnerRole = betOwner?.role ?? "user";

      assertDecision(decideBetMutation({
        actorRole: role,
        actorId: userId,
        betOwnerId: existing.userId,
        betOwnerRole,
        action: "delete",
      }));

      // Legs first. There is no FK between the two tables (the schema uses none
      // anywhere), so nothing at the database level would stop a deleted ticket
      // from leaving its legs behind — and an orphaned leg is still PENDING, so
      // the parlay sweep would keep grading it and re-folding a ticket that no
      // longer exists.
      if (existing.legCount > 0) {
        await db.delete(trackedBetLegs).where(eq(trackedBetLegs.betId, input.id));
        console.log(`[BetTracker][STATE] delete: removed ${existing.legCount} leg(s) for ticket ${input.id}`);
      }
      await db.delete(trackedBets).where(eq(trackedBets.id, input.id));
      console.log(`[BetTracker][OUTPUT] delete: SUCCESS — betId=${input.id} ownedBy=${existing.userId} deletedBy=${userId} role=${role} legs=${existing.legCount}`);
      // Invalidate the OWNER's cache (see the same note on update).
      invalidateStatsCacheForUser(existing.userId);
      if (existing.userId !== userId) invalidateStatsCacheForUser(userId);
      return { success: true, deletedId: input.id };
    }),

  /**
   * submitEditRequest — handicapper submits an EDIT or DELETE request for their own bet.
   * The bet itself is NOT modified. Owner/Admin reviews via reviewEditRequest.
   */
  submitEditRequest: appUserProcedure
    .input(z.object({
      betId:           z.number().int().positive(),
      requestType:     z.enum(["EDIT", "DELETE"]),
      reason:          z.string().max(2000).optional(),
      proposedChanges: z.record(z.string(), z.unknown()).optional(), // JSON object of proposed field changes
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.appUser.id;
      const role   = ctx.appUser.role;
      console.log(`[BetTracker][INPUT] submitEditRequest: userId=${userId} role=${role} betId=${input.betId} requestType=${input.requestType}`);

      const db = await getDb();
      const [existing] = await db.select().from(trackedBets).where(eq(trackedBets.id, input.betId));
      if (!existing) {
        console.log(`[BetTracker][ERROR] submitEditRequest: betId=${input.betId} not found`);
        throw new TRPCError({ code: "NOT_FOUND", message: "Bet not found" });
      }

      // Only the bet owner can submit a request for their own bet
      if (existing.userId !== userId) {
        console.log(`[BetTracker][ERROR] submitEditRequest: FORBIDDEN — betId=${input.betId} ownedBy=${existing.userId} requester=${userId}`);
        throw new TRPCError({ code: "FORBIDDEN", message: "Can only submit requests for your own bets" });
      }

      // Owner/Admin can directly edit — this endpoint is for handicappers
      // But allow it for any role (owner might use it too in edge cases)
      const proposedChangesJson = input.proposedChanges
        ? JSON.stringify(input.proposedChanges)
        : null;

      const [insertResult] = await db.insert(betEditRequests).values({
        betId:           input.betId,
        requestedBy:     userId,
        requestType:     input.requestType,
        proposedChanges: proposedChangesJson,
        reason:          input.reason ?? null,
        status:          "PENDING",
      });
      const requestId = (insertResult as { insertId: number }).insertId;

      console.log(`[BetTracker][OUTPUT] submitEditRequest: SUCCESS — requestId=${requestId} betId=${input.betId} type=${input.requestType} userId=${userId}`);
      console.log(`[BetTracker][VERIFY] submitEditRequest: PASS — request inserted with id=${requestId}`);
      return { success: true, requestId };
    }),

  /**
   * reviewEditRequest — OWNER/ADMIN only: approve or deny a pending edit request.
   * On APPROVE:
   *   - DELETE request: deletes the bet
   *   - EDIT request: applies proposedChanges to the bet
   * On DENY: marks request as DENIED with optional note.
   */
  reviewEditRequest: appUserProcedure
    .input(z.object({
      requestId:  z.number().int().positive(),
      action:     z.enum(["APPROVE", "DENY"]),
      reviewNote: z.string().max(2000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.appUser.id;
      const role   = ctx.appUser.role;
      console.log(`[BetTracker][INPUT] reviewEditRequest: reviewerId=${userId} role=${role} requestId=${input.requestId} action=${input.action}`);

      assertDecision(decidePrivilegedAccess(role, "review edit requests"));

      const db = await getDb();
      const [req] = await db.select().from(betEditRequests).where(eq(betEditRequests.id, input.requestId));
      if (!req) {
        console.log(`[BetTracker][ERROR] reviewEditRequest: requestId=${input.requestId} not found`);
        throw new TRPCError({ code: "NOT_FOUND", message: "Edit request not found" });
      }
      if (req.status !== "PENDING") {
        console.log(`[BetTracker][ERROR] reviewEditRequest: requestId=${input.requestId} already ${req.status}`);
        throw new TRPCError({ code: "BAD_REQUEST", message: `Request already ${req.status}` });
      }

      // Fetch the associated bet
      const [bet] = await db.select().from(trackedBets).where(eq(trackedBets.id, req.betId));
      if (!bet) {
        console.log(`[BetTracker][ERROR] reviewEditRequest: betId=${req.betId} not found`);
        throw new TRPCError({ code: "NOT_FOUND", message: "Associated bet not found" });
      }

      // Admin cannot approve requests on owner bets
      if (role === "admin") {
        const [betOwner] = await db
          .select({ role: appUsers.role })
          .from(appUsers)
          .where(eq(appUsers.id, bet.userId));
        if (betOwner?.role === "owner") {
          console.log(`[BetTracker][ERROR] reviewEditRequest: FORBIDDEN — admin cannot approve requests on owner bets`);
          throw new TRPCError({ code: "FORBIDDEN", message: "Admins cannot approve requests on owner bets" });
        }
      }

      const now = new Date();

      if (input.action === "APPROVE") {
        if (req.requestType === "DELETE") {
          // Cascade legs here as well. The `delete` mutation cascades, but this
          // is a SECOND path to the same outcome and it did not — a ticket
          // removed through the handicapper request queue left its legs behind,
          // still PENDING, so the sweep kept grading them and re-folding a
          // ticket that no longer existed.
          await db.delete(trackedBetLegs).where(eq(trackedBetLegs.betId, req.betId));
          await db.delete(trackedBets).where(eq(trackedBets.id, req.betId));
          console.log(`[BetTracker][STATE] reviewEditRequest: APPROVED DELETE — betId=${req.betId} deleted (legs cascaded)`);
        } else if (req.requestType === "EDIT" && req.proposedChanges) {
          // Apply proposed changes
          let changes: Record<string, unknown> = {};
          try {
            changes = JSON.parse(req.proposedChanges);
          } catch {
            console.warn(`[BetTracker][WARN] reviewEditRequest: could not parse proposedChanges for requestId=${input.requestId}`);
          }
          if (Object.keys(changes).length > 0) {
            // Sanitize: non-stake fields pass through as before. Stake fields go
            // through the SAME reconciliation as betTracker.update — an approved
            // request is still a write, and odds/risk/toWin used to be spread
            // into the SQL update untyped, unreconciled, with no gate.
            const passthrough = ["notes", "result", "wagerType", "customLine", "line", "timeframe", "market", "pickSide"];
            const safe: Record<string, unknown> = {};
            for (const k of passthrough) {
              if (k in changes) safe[k] = changes[k];
            }

            // Stake fields: parse defensively (proposedChanges is caller-supplied
            // JSON), then resolve the final quad through the core.
            const num = (v: unknown): number | undefined => {
              if (v === undefined || v === null) return undefined;
              const n = typeof v === "number" ? v : parseFloat(String(v));
              return Number.isFinite(n) && n > 0 ? n : undefined;
            };
            const reqOddsRaw = changes["odds"];
            const reqOddsNum = typeof reqOddsRaw === "number" ? reqOddsRaw : reqOddsRaw != null ? parseFloat(String(reqOddsRaw)) : NaN;
            const reqOdds = Number.isFinite(reqOddsNum) ? Math.trunc(reqOddsNum) : undefined;
            const stake = resolveStakePatch({
              actorRole: role, // the reviewer is owner/admin — dollar fields permitted
              existing: { risk: bet.risk, toWin: bet.toWin, riskUnits: bet.riskUnits, toWinUnits: bet.toWinUnits },
              odds: reqOdds ?? bet.odds,
              oddsChanged: reqOdds !== undefined && reqOdds !== bet.odds,
              risk:       num(changes["risk"]),
              toWin:      num(changes["toWin"]),
              riskUnits:  num(changes["riskUnits"]),
              toWinUnits: num(changes["toWinUnits"]),
            });
            if (!stake.ok) {
              console.log(`[BetTracker][ERROR] reviewEditRequest: stake changes refused for betId=${req.betId} — ${stake.message}`);
              throw new TRPCError({ code: "BAD_REQUEST", message: stake.message });
            }
            Object.assign(safe, stake.fields);
            if (reqOdds !== undefined && reqOdds !== bet.odds) {
              safe["odds"] = reqOdds;
              // Same basis rule as update: a parlay's reprice divides from
              // originalOdds, so a restated ticket price moves the basis too.
              if ((bet.legCount ?? 0) > 0) safe["originalOdds"] = reqOdds;
            }

            if (Object.keys(safe).length > 0) {
              await db.update(trackedBets).set(safe).where(eq(trackedBets.id, req.betId));
              console.log(`[BetTracker][STATE] reviewEditRequest: APPROVED EDIT — betId=${req.betId} fields=${Object.keys(safe).join(",")}`);
            }
          }
        }
        // APPROVED: hard-delete the request row — approved requests are removed immediately.
        // No orphaned APPROVED records ever accumulate in the table.
        // DENIED requests are kept as permanent audit trail (see else branch below).
        await db.delete(betEditRequests).where(eq(betEditRequests.id, input.requestId));
        console.log(`[BetTracker][OUTPUT] reviewEditRequest: APPROVED — requestId=${input.requestId} hard-deleted from bet_edit_requests by reviewerId=${userId}`);
      } else {
        await db.update(betEditRequests).set({
          status:     "DENIED",
          reviewedBy: userId,
          reviewedAt: now,
          reviewNote: input.reviewNote ?? null,
        }).where(eq(betEditRequests.id, input.requestId));
        console.log(`[BetTracker][OUTPUT] reviewEditRequest: DENIED — requestId=${input.requestId} by reviewerId=${userId}`);
      }

      console.log(`[BetTracker][VERIFY] reviewEditRequest: PASS — requestId=${input.requestId} action=${input.action}`);
      // Invalidate stats cache for the bet owner so approved changes are reflected immediately
      invalidateStatsCacheForUser(bet.userId);
      return { success: true, requestId: input.requestId, action: input.action };
    }),

  /**
   * getLogs — OWNER/ADMIN only: full audit log of all bets created and all edit requests.
   * Used by the LOGS tab for transparency and integrity monitoring.
   * Returns:
   *   - bets: all tracked_bets with user info (username, role)
   *   - editRequests: all bet_edit_requests with requester + reviewer info
   */
  getLogs: appUserProcedure
    .input(z.object({
      limit:  z.number().int().positive().max(500).default(200),
      offset: z.number().int().min(0).default(0),
    }).optional())
    .query(async ({ ctx, input }) => {
      const role = ctx.appUser.role;
      assertDecision(decidePrivilegedAccess(role, "view audit logs"));

      const limit  = input?.limit  ?? 200;
      const offset = input?.offset ?? 0;

      console.log(`[BetTracker][INPUT] getLogs: viewerId=${ctx.appUser.id} role=${role} limit=${limit} offset=${offset}`);

      const db = await getDb();

      // Fetch all bets with user info
      const betsRaw = await db
        .select({
          bet:  trackedBets,
          user: { id: appUsers.id, username: appUsers.username, role: appUsers.role },
        })
        .from(trackedBets)
        .leftJoin(appUsers, eq(trackedBets.userId, appUsers.id))
        .orderBy(desc(trackedBets.createdAt))
        .limit(limit)
        .offset(offset);

      // Fetch all edit requests with requester + reviewer info
      const requestsRaw = await db
        .select()
        .from(betEditRequests)
        .orderBy(desc(betEditRequests.createdAt))
        .limit(limit)
        .offset(offset);

      // Enrich edit requests with usernames
      const userIds = new Set<number>();
      for (const r of requestsRaw) {
        userIds.add(r.requestedBy);
        if (r.reviewedBy) userIds.add(r.reviewedBy);
      }
      const usersForRequests = userIds.size > 0
        ? await db
            .select({ id: appUsers.id, username: appUsers.username, role: appUsers.role })
            .from(appUsers)
            .where(inArray(appUsers.id, Array.from(userIds)))
        : [];
      const userMap = new Map<number, { id: number; username: string; role: string }>(usersForRequests.map((u: { id: number; username: string; role: string }) => [u.id, u]));

      const editRequests = requestsRaw.map((r: typeof requestsRaw[0]) => ({
        ...r,
        requesterUsername: userMap.get(r.requestedBy)?.username ?? `user#${r.requestedBy}`,
        requesterRole:     userMap.get(r.requestedBy)?.role     ?? "unknown",
        reviewerUsername:  r.reviewedBy ? (userMap.get(r.reviewedBy)?.username ?? `user#${r.reviewedBy}`) : null,
      }));

      const bets = betsRaw.map((row: typeof betsRaw[0]) => ({
        ...row.bet,
        username: row.user?.username ?? `user#${row.bet.userId}`,
        userRole: row.user?.role     ?? "unknown",
      }));

      console.log(`[BetTracker][OUTPUT] getLogs: bets=${bets.length} editRequests=${editRequests.length}`);
      return { bets, editRequests };
    }),

  /**
   * getSlate — fetch the daily game slate from Action Network v2 scoreboard API.
   * Served from in-memory cache (5-min TTL) after server pre-warm.
   * Returns normalized SlateGame[] sorted by start time ASC.
   */
  getSlate: appUserProcedure
    .input(z.object({
      sport:    z.enum(["NCAAF", "MLB", "NBA", "NHL", "NCAAM"]),
      gameDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }))
    .query(async ({ ctx, input }) => {
      console.log(`[BetTracker][INPUT] getSlate: userId=${ctx.appUser.id} sport=${input.sport} date=${input.gameDate}`);
      const start = Date.now();
      const games = await fetchAnSlate(input.sport, input.gameDate);
      const elapsed = Date.now() - start;
      console.log(`[BetTracker][OUTPUT] getSlate: ${games.length} games | sport=${input.sport} date=${input.gameDate} | elapsed=${elapsed}ms`);
      console.log(`[BetTracker][VERIFY] getSlate: ${games.length > 0 ? "PASS" : "WARN — 0 games"} | elapsed=${elapsed}ms`);
      return games.map(g => ({
        id:           g.id,
        awayTeam:     g.awayTeam,
        homeTeam:     g.homeTeam,
        awayFull:     g.awayFull,
        homeFull:     g.homeFull,
        awayNickname: g.awayNickname,
        homeNickname: g.homeNickname,
        awayLogo:     g.awayLogo,
        homeLogo:     g.homeLogo,
        awayColor:    g.awayColor,
        homeColor:    g.homeColor,
        gameTime:     g.gameTime,
        sport:        g.sport,
        gameDate:     g.gameDate,
        status:       g.status,
        odds:         g.odds,
        gameNumber:   g.gameNumber,  // 1 for single/G1, 2 for G2 of doubleheader
      }));
    }),

  /**
   * autoGrade — settle the calling user's PENDING bets.
   *
   * Thin delegate to the ONE grading engine in ../betAutoGradeScheduler. The
   * previous inline copy of the loop had drifted from the scheduler's, so the
   * same bet could settle differently depending on which path reached it first.
   *
   * Always self-scoped. Grading another user's bets is autoGradeAll (owner/admin).
   */
  autoGrade: appUserProcedure
    .input(z.object({
      sport:    z.enum(SPORTS).optional(),
      gameDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).optional())
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.appUser.id;
      const summary = await gradePendingForUser(
        userId,
        { sport: input?.sport, gameDate: input?.gameDate },
        "trpc_autoGrade",
      );
      return {
        graded:       summary.graded,
        wins:         summary.wins,
        losses:       summary.losses,
        pushes:       summary.pushes,
        voids:        summary.voids,
        stillPending: summary.stillPending,
        total:        summary.total,
        details:      summary.details,
      };
    }),

  /**
   * autoGradeAll — OWNER/ADMIN only: settle every user's PENDING bets for a date.
   * Same engine as autoGrade and as the background scheduler.
   */
  autoGradeAll: appUserProcedure
    .input(z.object({
      gameDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }))
    .mutation(async ({ ctx, input }) => {
      assertDecision(decidePrivilegedAccess(ctx.appUser.role, "grade every user's bets"));
      console.log(`[BetTracker][INPUT] autoGradeAll: triggeredBy=${ctx.appUser.username} date=${input.gameDate}`);
      const summary = await gradeAllPendingForDate(input.gameDate, "trpc_autoGradeAll");
      return {
        graded:       summary.graded,
        wins:         summary.wins,
        losses:       summary.losses,
        pushes:       summary.pushes,
        voids:        summary.voids,
        stillPending: summary.stillPending,
        total:        summary.total,
      };
    }),


  /**
   * getLinescores — fetch MLB per-inning linescore data for one or more dates.
   * Calls the official MLB Stats API: https://statsapi.mlb.com/api/v1/schedule
   * Returns a map keyed by gamePk with innings array + R/H/E totals + status.
   */
  getLinescores: appUserProcedure
    .input(z.object({
      sport:  z.literal("MLB"),
      // max(14) bounds the per-request MLB API fan-out (Promise.all below).
      // Clients spanning more dates MUST batch into ≤14-date chunks and merge
      // (see BetTracker.tsx mlbDateChunks) — an oversized array 400s.
      dates:  z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(14),
    }))
    .query(async ({ input }) => {
      console.log(`[BetTracker][INPUT] getLinescores: sport=${input.sport} dates=${input.dates.join(",")}`);

      type InningLine = { num: number; awayRuns: number | null; homeRuns: number | null };
      type LinescoreEntry = {
        gamePk:        number;
        gameDate:      string;
        awayAbbrev:    string;
        homeAbbrev:    string;
        /**
         * Doubleheader game number: 1 = G1, 2 = G2.
         * Detected by finding two games with the same gameDate+away+home, then
         * assigning gameNumber=1 to the earlier startTime and gameNumber=2 to the later.
         * NOTE: gamePk order does NOT reliably match chronological order
         * (e.g. SF@PHI 2026-04-30: gamePk=823471 starts 21:35Z but gamePk=823472 starts 16:35Z).
         */
        gameNumber:    1 | 2;
        /** ISO UTC start time — used for DH G1/G2 chronological ordering */
        startTime:     string;
        innings:       InningLine[];
        awayR:         number | null;
        awayH:         number | null;
        awayE:         number | null;
        homeR:         number | null;
        homeH:         number | null;
        homeE:         number | null;
        currentInning: number | null;
        inningState:   string | null;
        status:        string;
      };

      const result: Record<number, LinescoreEntry> = {};

      await Promise.all(input.dates.map(async (date) => {
        const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore,team`;
        if (process.env.NODE_ENV === "development") console.log(`[BetTracker][STEP] getLinescores: fetching ${url}`);
        try {
          const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
          if (!resp.ok) {
            console.warn(`[BetTracker][WARN] getLinescores: MLB API returned ${resp.status} for date=${date}`);
            return;
          }
          const json = await resp.json() as {
            dates?: Array<{
              games?: Array<{
                gamePk: number;
                gameDate: string;
                status?: { abstractGameState?: string; detailedState?: string };
                linescore?: {
                  currentInning?: number;
                  inningState?: string;
                  innings?: Array<{
                    num: number;
                    away?: { runs?: number };
                    home?: { runs?: number };
                  }>;
                  teams?: {
                    away?: { runs?: number; hits?: number; errors?: number };
                    home?: { runs?: number; hits?: number; errors?: number };
                  };
                };
                teams?: {
                  away?: { team?: { abbreviation?: string } };
                  home?: { team?: { abbreviation?: string } };
                };
              }>;
            }>;
          };

          for (const dateBlock of json.dates ?? []) {
            for (const game of dateBlock.games ?? []) {
              const ls = game.linescore;
              const innings: InningLine[] = (ls?.innings ?? []).map(inn => ({
                num:       inn.num,
                awayRuns:  inn.away?.runs ?? null,
                homeRuns:  inn.home?.runs ?? null,
              }));
              result[game.gamePk] = {
                gamePk:        game.gamePk,
                gameDate:      date,
                awayAbbrev:    game.teams?.away?.team?.abbreviation ?? "",
                homeAbbrev:    game.teams?.home?.team?.abbreviation ?? "",
                gameNumber:    1, // default; overwritten below after DH detection
                startTime:     game.gameDate ?? "",
                innings,
                awayR:         ls?.teams?.away?.runs   ?? null,
                awayH:         ls?.teams?.away?.hits   ?? null,
                awayE:         ls?.teams?.away?.errors ?? null,
                homeR:         ls?.teams?.home?.runs   ?? null,
                homeH:         ls?.teams?.home?.hits   ?? null,
                homeE:         ls?.teams?.home?.errors ?? null,
                currentInning: ls?.currentInning ?? null,
                inningState:   ls?.inningState   ?? null,
                status:        game.status?.abstractGameState ?? "Preview",
              };
            }
          }
          console.log(`[BetTracker][STATE] getLinescores: date=${date} → ${Object.keys(result).length} games accumulated`);
        } catch (e) {
          console.warn(`[BetTracker][WARN] getLinescores: fetch failed for date=${date}:`, e);
        }
      }));

      // ── Doubleheader gameNumber assignment ──────────────────────────────────────
      // Group games by gameDate:awayAbbrev:homeAbbrev. For any group with 2+ games,
      // sort by startTime ASC (chronological) and assign gameNumber=1 to the earlier,
      // gameNumber=2 to the later.
      // IMPORTANT: gamePk order does NOT reliably match chronological order.
      // Example: SF@PHI 2026-04-30 — gamePk=823471 starts 21:35Z but gamePk=823472 starts 16:35Z.
      // Sorting by gamePk would incorrectly assign G1=823471 (later game).
      const dhGroups = new Map<string, number[]>(); // key → [gamePk, ...]
      for (const entry of Object.values(result)) {
        const key = `${entry.gameDate}:${entry.awayAbbrev}:${entry.homeAbbrev}`;
        const group = dhGroups.get(key) ?? [];
        group.push(entry.gamePk);
        dhGroups.set(key, group);
      }
      let dhCount = 0;
      for (const [key, pks] of Array.from(dhGroups.entries())) {
        if (pks.length < 2) continue; // not a doubleheader
        // Sort by startTime ASC (chronological) — NOT by gamePk
        pks.sort((a, b) => (result[a].startTime ?? "").localeCompare(result[b].startTime ?? ""));
        result[pks[0]].gameNumber = 1;
        result[pks[1]].gameNumber = 2;
        dhCount++;
        console.log(`[BetTracker][STATE] getLinescores: DH detected key=${key} G1_gamePk=${pks[0]} (${result[pks[0]].startTime}) G2_gamePk=${pks[1]} (${result[pks[1]].startTime})`);
      }
      console.log(`[BetTracker][OUTPUT] getLinescores: total=${Object.keys(result).length} games returned dhCount=${dhCount}`);
      return result;
    }),

  /**
   * listWithStatsPaginated — THE Bet Tracker read. One procedure, one aggregation.
   *
   * Returns a cursor page of enriched bets plus the full stats block computed
   * over the WHOLE filtered set (not just the page). `getStats`, `list` and
   * `listWithStats` used to sit alongside this with three separate copies of the
   * aggregation; they had drifted, and the copy the UI actually called was the
   * thinnest — silently omitting dollar P&L, drawdown, ATH, current-run,
   * worst-day and the equity-point metadata the charts read. All three are gone;
   * aggregation now happens exactly once, in betTrackerCore.aggregateStats.
   *
   * Query shape:
   *   - Page query: LIMIT n+1 on (gameDate DESC, id DESC) — keyset, no OFFSET.
   *     Served by idx_tb_user_date / idx_tb_user_sport_date.
   *   - Stats query: the full filtered set, but projected to the 14 columns the
   *     aggregation reads instead of SELECT * (which dragged notes, book, scores
   *     and timestamps across the wire on every cache miss).
   *   - Stats are memoized per (resolved user × filters × unitSize), so pages
   *     2..n never re-scan.
   *
   * On why the aggregation is not a GROUP BY: the block spans seven independent
   * breakdown dimensions plus an order-dependent equity curve, drawdown and
   * streak walk. MySQL/TiDB has no GROUPING SETS, so that would be 7+ round
   * trips plus a row fetch for the curve — strictly more work than one indexed
   * narrow scan folded in a single pass. The projection is where the win is.
   *
   * Client usage:
   *   trpc.betTracker.listWithStatsPaginated.useInfiniteQuery(input, {
   *     getNextPageParam: (last) => last.nextCursor,
   *   })
   */
  listWithStatsPaginated: appUserProcedure
    .input(z.object({
      sport:        z.enum(SPORTS).optional(),
      gameDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      dateFrom:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      dateTo:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      result:       z.enum(RESULTS).optional(),
      /**
       * Restrict the LIST to settled bets (WIN/LOSS) without touching stats.
       * Backs the "Every pick tracked" drawer, which used to be fed from
       * stats.equityCurve; that array is now thinned for transport, so reading
       * a bet ledger out of it would silently under-report.
       */
      settledOnly:  z.boolean().optional(),
      targetUserId: z.number().int().positive().optional(),
      unitSize:     z.number().positive().optional(),
      limit:        z.number().int().min(1).max(200).default(50),
      /** Cursor: JSON-encoded { gameDate: string; id: number } */
      cursor:       z.string().optional(),
      /** When true, skip AN slate enrichment (fully historical pages have no live data) */
      isHistorical: z.boolean().optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const userId = await resolveScopeChecked(ctx, input?.targetUserId);
      const unitSize     = input?.unitSize ?? 100;
      const limit        = input?.limit    ?? 50;
      const isHistorical = input?.isHistorical ?? false;

      const cursor = decodeCursor(input?.cursor);

      // ── WHERE ──────────────────────────────────────────────────────────────────
      const baseConditions = [eq(trackedBets.userId, userId)];
      if (input?.sport)    baseConditions.push(eq(trackedBets.sport, input.sport));
      if (input?.gameDate) baseConditions.push(eq(trackedBets.gameDate, input.gameDate));
      if (input?.dateFrom) baseConditions.push(gte(trackedBets.gameDate, input.dateFrom));
      if (input?.dateTo)   baseConditions.push(lte(trackedBets.gameDate, input.dateTo));

      // The result filter narrows the LIST only. Stats are always computed over
      // the unfiltered set so the header does not change when the user filters
      // the table to "losses".
      const listConditions = [...baseConditions];
      if (input?.result) listConditions.push(eq(trackedBets.result, input.result));
      if (input?.settledOnly) listConditions.push(inArray(trackedBets.result, ["WIN", "LOSS"]));

      if (cursor) {
        listConditions.push(
          or(
            lt(trackedBets.gameDate, cursor.gameDate),
            and(eq(trackedBets.gameDate, cursor.gameDate), lt(trackedBets.id, cursor.id)),
          )!
        );
      }

      const db = await getDb();

      // Fingerprint the row set the stats will be computed from, so a cached
      // block written by ANOTHER replica can be detected as stale. One narrow
      // indexed aggregate; the alternative is trusting per-process invalidation,
      // which silently breaks the moment numReplicas > 1.
      const [fp] = await db
        .select({
          rowCount: sql<number>`COUNT(*)`,
          // UNIX_TIMESTAMP, not the raw column: mysql2 returns a DATETIME as a JS Date,
          // and String(Date) renders the process's locale and offset
          // ("Tue Aug 04 2026 06:11:02 GMT-0700 (Pacific Daylight Time)"). Two
          // replicas in different zones would then compute different fingerprints
          // for identical rows — every read a miss, defeating the cache in exactly
          // the multi-replica case it was built for. An epoch integer has no zone.
          maxUpdated: sql<number | null>`UNIX_TIMESTAMP(MAX(${trackedBets.updatedAt}))`,
          idChecksum: sql<number | null>`SUM(${trackedBets.id})`,
        })
        .from(trackedBets)
        .where(and(...baseConditions));
      const fingerprint = buildStatsFingerprint({
        rowCount: Number(fp?.rowCount ?? 0),
        maxUpdated: fp?.maxUpdated != null ? String(Number(fp.maxUpdated)) : null,
        idChecksum: fp?.idChecksum != null ? Number(fp.idChecksum) : null,
      });

      const statsCacheKey = buildStatsCacheKey(userId, { ...input, unitSize });
      const cachedStats = getStatsCache<BetStats>(statsCacheKey, fingerprint);

      const pageQuery = db.select().from(trackedBets)
        .where(and(...listConditions))
        .orderBy(desc(trackedBets.gameDate), desc(trackedBets.id))
        .limit(limit + 1);

      let pageRows: typeof trackedBets.$inferSelect[];
      let stats: BetStats;

      if (cachedStats) {
        pageRows = await pageQuery;
        stats = cachedStats;
      } else {
        const [page, statRows] = await Promise.all([
          pageQuery,
          db.select(STAT_COLUMNS).from(trackedBets)
            .where(and(...baseConditions))
            .orderBy(asc(trackedBets.gameDate), asc(trackedBets.id)),
        ]);
        pageRows = page;
        const full = aggregateStats(statRows as StatRow[], unitSize);

        // Bound the curve BEFORE caching, so a heavy account cannot pin a
        // multi-megabyte array in the process cache. Every headline figure was
        // already computed over the complete series inside aggregateStats.
        const curveTotal = full.equityCurve.length;
        stats = {
          ...full,
          equityCurve: downsampleEquityCurve(full.equityCurve),
          equityCurveTotal: curveTotal,
        };
        if (curveTotal > stats.equityCurve.length) {
          console.log(
            `[BetTracker][STATE] listWithStatsPaginated: equity curve thinned ` +
            `${curveTotal} -> ${stats.equityCurve.length} pts for user=${userId}`,
          );
        }
        setStatsCache(statsCacheKey, stats, isHistorical, fingerprint);
      }

      // ── Cursor for the next page ───────────────────────────────────────────────
      const hasNextPage = pageRows.length > limit;
      const rows = hasNextPage ? pageRows.slice(0, limit) : pageRows;
      const nextCursor = hasNextPage && rows.length > 0
        ? encodeCursor({ gameDate: rows[rows.length - 1].gameDate, id: rows[rows.length - 1].id })
        : null;

      // ── Attach parlay legs ─────────────────────────────────────────────────────
      // One batched query for the whole page rather than one per ticket. A
      // round trip against TiDB costs ~80ms regardless of how much it returns,
      // so N+1 here would dominate the entire read. Straight-bet pages skip it
      // entirely — legCount is 0, so there is nothing to look up.
      const parlayIds = rows.filter(r => r.legCount > 0).map(r => r.id);
      const legsByBet = new Map<number, Array<typeof trackedBetLegs.$inferSelect>>();
      if (parlayIds.length > 0) {
        const legRows = await db
          .select()
          .from(trackedBetLegs)
          .where(inArray(trackedBetLegs.betId, parlayIds))
          .orderBy(asc(trackedBetLegs.betId), asc(trackedBetLegs.legIndex));
        for (const l of legRows) {
          const list = legsByBet.get(l.betId);
          if (list) list.push(l);
          else legsByBet.set(l.betId, [l]);
        }
        console.log(`[BetTracker][STATE] listWithStatsPaginated: attached legs for ${parlayIds.length} parlay(s)`);
      }

      // ── Enrich page rows with logos / live slate data ──────────────────────────
      // Historical pages skip the Action Network round trip entirely; past dates
      // resolve logos from the in-memory team map (O(1), no HTTP).
      const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      const slateMap = new Map<number, import("../actionNetwork").SlateGame>();

      if (!isHistorical) {
        const pairs = new Map<string, { sport: string; gameDate: string }>();
        for (const row of rows) {
          const key = `${row.sport}:${row.gameDate}`;
          if (!pairs.has(key) && row.gameDate >= todayStr) {
            pairs.set(key, { sport: row.sport, gameDate: row.gameDate });
          }
        }
        if (pairs.size > 0) {
          await Promise.all(
            Array.from(pairs.values()).map(async ({ sport, gameDate }) => {
              try {
                const games = await fetchAnSlate(sport, gameDate);
                for (const g of games) slateMap.set(g.id, g);
              } catch (e) {
                console.warn(`[BetTracker][WARN] listWithStatsPaginated: fetchAnSlate failed for ${sport}/${gameDate}:`, e);
              }
            })
          );
        }
      }

      const enriched = rows.map((row) => {
        const slate = row.anGameId ? slateMap.get(row.anGameId) : undefined;
        return {
          ...row,
          awayLogo: slate?.awayLogo ?? (row.awayTeam ? resolveLogoUrl(row.sport, row.awayTeam, "") || null : null),
          homeLogo: slate?.homeLogo ?? (row.homeTeam ? resolveLogoUrl(row.sport, row.homeTeam, "") || null : null),
          awayFull:     slate?.awayFull     ?? null,
          homeFull:     slate?.homeFull     ?? null,
          awayNickname: slate?.awayNickname ?? null,
          homeNickname: slate?.homeNickname ?? null,
          awayColor:    slate?.awayColor    ?? null,
          homeColor:    slate?.homeColor    ?? null,
          gameTime:     slate?.gameTime     ?? null,
          startUtc:     slate?.startUtc     ?? null,
          gameStatus:   slate?.status       ?? null,
          /** Selections on a parlay ticket, in display order. Empty for a straight bet. */
          legs: legsByBet.get(row.id) ?? [],
        };
      });

      return {
        bets: enriched,
        stats,
        nextCursor,
        hasNextPage,
        pageSize: rows.length,
        totalBets: stats.totalBets,
      };
    }),


  /**
   * getCalendarData — returns per-day unit P/L for a given year-month and user.
   * Used by the Pikkit-style calendar recap component.
   *
   * Returns:
   *   days: Array<{ date: string; units: number; wins: number; losses: number; pushes: number; pending: number }>
   *   monthRecord: { wins: number; losses: number; pushes: number; netUnits: number }
   */
  getCalendarData: appUserProcedure
    .input(z.object({
      /** YYYY-MM — the month to compute calendar data for */
      yearMonth:    z.string().regex(/^\d{4}-\d{2}$/),
      targetUserId: z.number().int().positive().optional(),
      unitSize:     z.number().positive().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const userId = await resolveScopeChecked(ctx, input.targetUserId);
      const unitSize = input.unitSize ?? 100;
      const dateFrom = `${input.yearMonth}-01`;
      // Last day of month: go to first day of next month then subtract 1 day
      const [y, m] = input.yearMonth.split("-").map(Number);
      const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
      const dateTo = (() => {
        const d = new Date(`${nextMonth}-01T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0, 10);
      })();

      console.log(`[BetTracker][INPUT] getCalendarData: userId=${userId} yearMonth=${input.yearMonth} dateFrom=${dateFrom} dateTo=${dateTo}`);

      const db = await getDb();
      const rows = await db
        .select({
          id:          trackedBets.id,
          gameDate:    trackedBets.gameDate,
          result:      trackedBets.result,
          risk:        trackedBets.risk,
          toWin:       trackedBets.toWin,
          riskUnits:   trackedBets.riskUnits,
          toWinUnits:  trackedBets.toWinUnits,
        })
        .from(trackedBets)
        .where(
          and(
            eq(trackedBets.userId, userId),
            gte(trackedBets.gameDate, dateFrom),
            lte(trackedBets.gameDate, dateTo),
          )
        )
        .orderBy(asc(trackedBets.gameDate), asc(trackedBets.id));

      console.log(`[BetTracker][STATE] getCalendarData: ${rows.length} bets found for ${input.yearMonth}`);

      // Unit normalization comes from betTrackerCore so the calendar can never
      // disagree with the stats block about what a bet is worth in units.
      const toUnits = (dollarAmt: number, storedUnits: string | null | undefined): number =>
        coreToUnits(dollarAmt, storedUnits, unitSize);

      // Per-day aggregation
      type DayEntry = { units: number; wins: number; losses: number; pushes: number; pending: number; betCount: number; totalRisk: number };
      const dayMap = new Map<string, DayEntry>();

      let monthWins = 0, monthLosses = 0, monthPushes = 0, monthNetUnits = 0, monthTotalRisk = 0;

      for (const bet of rows) {
        const riskU  = toUnits(parseFloat(bet.risk),  bet.riskUnits);
        const toWinU = toUnits(parseFloat(bet.toWin), bet.toWinUnits);
        const res    = bet.result as string;
        const date   = bet.gameDate;

        if (!dayMap.has(date)) dayMap.set(date, { units: 0, wins: 0, losses: 0, pushes: 0, pending: 0, betCount: 0, totalRisk: 0 });
        const day = dayMap.get(date)!;
        day.betCount++;

        if (res === "WIN") {
          day.units += toWinU;
          day.wins++;
          day.totalRisk += riskU;
          monthWins++;
          monthNetUnits += toWinU;
          monthTotalRisk += riskU;
        } else if (res === "LOSS") {
          day.units -= riskU;
          day.losses++;
          day.totalRisk += riskU;
          monthLosses++;
          monthNetUnits -= riskU;
          monthTotalRisk += riskU;
        } else if (res === "PUSH") {
          day.pushes++;
          monthPushes++;
        } else if (res === "PENDING") {
          day.pending++;
        }
      }

      const sortedDays = Array.from(dayMap.entries())
        .map(([date, d]) => ({
          date,
          units:     parseFloat(d.units.toFixed(2)),
          wins:      d.wins,
          losses:    d.losses,
          pushes:    d.pushes,
          pending:   d.pending,
          betCount:  d.betCount,
          totalRisk: parseFloat(d.totalRisk.toFixed(2)),
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

      // Equity curve: cumulative units per day (only graded days)
      let cumulative = 0;
      const equityCurve: { date: string; cumUnits: number }[] = [];
      for (const d of sortedDays) {
        if (d.wins > 0 || d.losses > 0) {
          cumulative += d.units;
          equityCurve.push({ date: d.date, cumUnits: parseFloat(cumulative.toFixed(2)) });
        }
      }

      // Best / worst day
      let bestDay: string | null = null, bestDayUnits = -Infinity;
      let worstDay: string | null = null, worstDayUnits = Infinity;
      for (const d of sortedDays) {
        if (d.wins > 0 || d.losses > 0) {
          if (d.units > bestDayUnits)  { bestDayUnits  = d.units; bestDay  = d.date; }
          if (d.units < worstDayUnits) { worstDayUnits = d.units; worstDay = d.date; }
        }
      }

      // Streaks: computed over graded bets in chronological order
      const gradedBets = rows.filter((b: typeof rows[number]) => b.result === "WIN" || b.result === "LOSS");
      let longestWinStreak = 0, longestLossStreak = 0;
      let curWin = 0, curLoss = 0;
      let currentStreakType: "W" | "L" | null = null;
      let currentStreakCount = 0;
      for (const bet of gradedBets) {
        if (bet.result === "WIN") {
          curWin++; curLoss = 0;
          if (curWin > longestWinStreak) longestWinStreak = curWin;
          currentStreakType = "W"; currentStreakCount = curWin;
        } else {
          curLoss++; curWin = 0;
          if (curLoss > longestLossStreak) longestLossStreak = curLoss;
          currentStreakType = "L"; currentStreakCount = curLoss;
        }
      }
      const currentStreak = currentStreakType ? `${currentStreakType}${currentStreakCount}` : null;

      const gradedCount = monthWins + monthLosses;
      const winPct = gradedCount > 0 ? parseFloat(((monthWins / gradedCount) * 100).toFixed(1)) : 0;
      const roi    = monthTotalRisk > 0 ? parseFloat(((monthNetUnits / monthTotalRisk) * 100).toFixed(1)) : 0;

      const monthRecord = {
        wins:              monthWins,
        losses:            monthLosses,
        pushes:            monthPushes,
        netUnits:          parseFloat(monthNetUnits.toFixed(2)),
        winPct,
        roi,
        longestWinStreak,
        longestLossStreak,
        currentStreak,
        bestDay,
        bestDayUnits:      bestDay  ? parseFloat(bestDayUnits.toFixed(2))  : null,
        worstDay,
        worstDayUnits:     worstDay ? parseFloat(worstDayUnits.toFixed(2)) : null,
      };

      console.log(`[BetTracker][OUTPUT] getCalendarData: ${sortedDays.length} active days monthRecord=${JSON.stringify(monthRecord)} equityCurve=${equityCurve.length} points`);
      return { days: sortedDays, monthRecord, equityCurve };
    }),
});

export type BetTrackerRouter = typeof betTrackerRouter;
