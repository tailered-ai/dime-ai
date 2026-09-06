import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, notInArray, or, sql } from "drizzle-orm";
import {
  APP_USER_DEPENDENT_TABLES,
  AppUserHasDataError,
  describeDeletionBlock,
  type DependentCounts,
} from "./appUserDeletion";
import {
  METRIC_DEFINITION_VERSION,
  REPORTING_TIMEZONE,
  ACTIVE_USER_DEFINITION_V1,
  deriveActiveUserPoint,
  deriveAvgDurationPoint,
  dbUnavailablePoint,
  reconcileMembership,
  ok as okPoint,
  notMeasured,
  unknown as unknownPoint,
  type MetricPoint,
  type MetricState,
  type MembershipBreakdown,
} from "./analytics/metricDefinitions";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import {
  games, nbaTeams, ncaamTeams, nhlTeams, mlbTeams,
  appUsers as appUsersTable, appUsers,
  oddsHistory, mlbLineups, mlbStrikeoutProps, mlbParkFactors, mlbBullpenStats,
  mlbUmpireModifiers, mlbHrProps, securityEvents,
  userFavoriteGames, userSessions,
  type Game, type AppUser, type InsertGame,
  type InsertNbaTeam, type InsertNhlTeam, type OddsHistoryRow,
  type MlbLineupRow, type InsertMlbLineup, type MlbStrikeoutPropRow,
  type InsertMlbStrikeoutProp, type MlbParkFactorRow, type MlbBullpenStatsRow,
  type MlbUmpireModifierRow, type MlbHrPropRow, type InsertSecurityEvent, type SecurityEventRow,
  type InsertAppUser, type UserSession, type InsertUserSession,
} from "../drizzle/schema";
import { withCircuitBreaker, invalidateCachedAppUser } from './dbCircuitBreaker';
import { debugLog } from './_core/debugLogger';
import { recordFailure, type AccountLockoutConfig } from './accountLockout';
import {
  SECURITY_EVENT_LIMITS,
  truncateForColumn,
  truncateForTextColumn,
} from "./_core/securityEventLimits";
import { logSafe } from "./_core/logSafe";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _db: any = null;
let _pool: mysql.Pool | null = null;

// ─── Server-side in-memory cache ─────────────────────────────────────────────
//
// PROBLEM: games.list and getActiveSports are called on EVERY page load and
// every 60s refetch interval. With 7,730 rows in the games table, each call
// costs ~100ms of TiDB round-trip time. The tRPC batch on initial page load
// fires 5 procedures simultaneously — all hitting the DB at the same time.
//
// SOLUTION: Cache the results in Node.js process memory with a short TTL.
//   - games.list: 30s TTL (data changes only when admin publishes or VSiN refreshes)
//   - activeSports: 60s TTL (sport availability changes at most once per day)
//
// Cache is keyed by (sport, dateWindow) so different sport/date combos are
// cached independently. Cache is invalidated on any game mutation (publish,
// ingest, delete) to ensure consistency.
//
// IMPACT: Eliminates ~100ms DB round-trip for 95%+ of games.list calls.
// The first call after TTL expiry pays the DB cost; all subsequent calls
// within the TTL window are served from memory in <1ms.

type CacheEntry<T> = { data: T; expiresAt: number };

const _gamesListCache = new Map<string, CacheEntry<Game[]>>();
const _activeSportsCache: { entry: CacheEntry<{ NBA: boolean; NHL: boolean; MLB: boolean }> | null } = { entry: null };
// Available dates cache — declared here so invalidateGamesCache() can clear it.
// The getAvailableDates() function and AVAILABLE_DATES_TTL_MS constant are defined
// after listGames() but the Map itself must be declared before invalidateGamesCache().
const _availableDatesCache = new Map<string, CacheEntry<string[]>>();

const GAMES_LIST_TTL_MS = 60_000;   // 60 seconds — safe now that invalidation is debounced

/**
 * Last-known-good cache — stores the last non-empty result for each cache key.
 * When a DB query returns 0 rows for a key that previously had rows, we serve
 * the stale-but-valid result instead of caching empty and showing "No games found".
 * This is the primary defense against transient DB failures (TiDB cold start,
 * connection pool exhaustion, SSL handshake timeout) causing empty feed states.
 *
 * TTL: 30 minutes — long enough to survive a DB blip, short enough to not
 * serve genuinely stale data for too long.
 */
const _lastGoodCache = new Map<string, { data: Game[]; storedAt: number }>();
const LAST_GOOD_TTL_MS = 30 * 60_000; // 30 minutes

// ── Cache performance counters ─────────────────────────────────────────────
// Tracked globally for the /api/perf endpoint. Resets on server restart.
const _cacheCounters = {
  gamesHit: 0,
  gamesMiss: 0,
  datesHit: 0,
  datesMiss: 0,
  activeSportsHit: 0,
  activeSportsMiss: 0,
  lastInvalidatedAt: 0 as number,
};
export function getCacheHealthStats() {
  const total = _cacheCounters.gamesHit + _cacheCounters.gamesMiss;
  const hitRate = total > 0 ? (_cacheCounters.gamesHit / total * 100).toFixed(1) : 'N/A';
  return {
    games: { hit: _cacheCounters.gamesHit, miss: _cacheCounters.gamesMiss, hitRate: `${hitRate}%`, entries: _gamesListCache.size },
    dates: { hit: _cacheCounters.datesHit, miss: _cacheCounters.datesMiss, entries: _availableDatesCache.size },
    activeSports: { hit: _cacheCounters.activeSportsHit, miss: _cacheCounters.activeSportsMiss },
    lastInvalidatedAt: _cacheCounters.lastInvalidatedAt,
    lastInvalidatedAgo: _cacheCounters.lastInvalidatedAt ? `${Math.round((Date.now() - _cacheCounters.lastInvalidatedAt) / 1000)}s ago` : 'never',
  };
}
const ACTIVE_SPORTS_TTL_MS = 60_000; // 60 seconds
const AVAILABLE_DATES_TTL_MS_EARLY = 5 * 60_000; // 5 minutes (used by getAvailableDates)

/**
 * Debounced invalidation timer — ensures that a burst of writes from a single
 * refresh cycle (e.g. 15 MLB games updated in 50ms) produces exactly ONE cache
 * clear instead of 15+. The cache is cleared 500ms after the LAST write in the
 * burst. This keeps the cache warm during high-frequency refresh cycles while
 * still propagating changes promptly.
 *
 * IMPACT: Reduces 60+ invalidations/minute → 1-2 invalidations/minute.
 * The cache now stays warm for the full 30s TTL between refresh cycles.
 */
let _invalidateTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Invalidate all games.list and activeSports cache entries.
 * Debounced 500ms: multiple calls within the same refresh burst are coalesced
 * into a single clear. This eliminates the runaway invalidation loop caused by
 * per-game updateBookOdds/updateNcaaStartTime calls during VSiN refresh cycles.
 */
export function invalidateGamesCache(): void {
  if (_invalidateTimer !== null) {
    clearTimeout(_invalidateTimer);
  }
  _invalidateTimer = setTimeout(() => {
    _invalidateTimer = null;
    const count = _gamesListCache.size;
    const datesCount = _availableDatesCache.size;
    _gamesListCache.clear();
    _availableDatesCache.clear();
    _activeSportsCache.entry = null;
    console.log(`[GamesCache] Debounced invalidation: cleared ${count} games.list + ${datesCount} availableDates + activeSports`);
  }, 500);
}

/**
 * Immediate (non-debounced) cache invalidation for admin operations
 * (publish, delete, bulk-approve) where changes must be visible instantly.
 * Cancels any pending debounced invalidation and clears the cache now.
 */
export function forceInvalidateGamesCache(): void {
  if (_invalidateTimer !== null) {
    clearTimeout(_invalidateTimer);
    _invalidateTimer = null;
  }
  const count = _gamesListCache.size;
  const datesCount = _availableDatesCache.size;
  _gamesListCache.clear();
  _availableDatesCache.clear();
  _activeSportsCache.entry = null;
  _cacheCounters.lastInvalidatedAt = Date.now();
  console.log(`[GamesCache] Force invalidation: cleared ${count} games.list + ${datesCount} availableDates + activeSports`);
}

// Lazily create the drizzle instance with a proper connection pool.
// Pool settings: 10 connections max, 30s acquire timeout, 10s idle timeout.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _pool = mysql.createPool({
        uri: process.env.DATABASE_URL,
        // Increased from 10 → 20: background refresh jobs (VSiN, NHL, MLB) + user requests
        // can saturate 10 connections during peak. 20 eliminates queue wait time.
        connectionLimit: 20,
        waitForConnections: true,
        // Increased from 50 → 100: burst traffic during game-day peaks
        queueLimit: 100,
        connectTimeout: 15000,  // 15s — allows remote TiDB Serverless connections to establish
        // Increased from 10s → 30s: TiDB serverless has ~30s idle before connection reset
        idleTimeout: 30000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        // Compress wire traffic between app server and TiDB (reduces latency on large game rows)
        compress: true,
      });
      _db = drizzle(_pool);
      console.log("[Database] Connection pool created (max=20, compress=true)");
    } catch (error) {
      console.warn("[Database] Failed to create connection pool:", error);
      _db = null;
      _pool = null;
    }
  }
  return _db;
}

// ─── Games ───────────────────────────────────────────────────────────────────

/**
 * Sort game rows by start time ascending.
 * This replaces the CASE WHEN ORDER BY SQL expression which is not supported
 * by the TiDB driver. DB-level sort by sortOrder is done first, then this
 * stable sort applies start-time ordering on top.
 */
function sortGamesByStartTime<T extends { id?: number; gameDate: string; startTimeEst: string | null; sortOrder: number | null }>(rows: T[]): T[] {
  return rows.slice().sort((a, b) => {
    // Primary: gameDate ascending
    if (a.gameDate < b.gameDate) return -1;
    if (a.gameDate > b.gameDate) return 1;
    // Secondary: start time ascending (TBD/null sorts last)
    const timeA = (!a.startTimeEst || a.startTimeEst === 'TBD') ? '99:00' : a.startTimeEst;
    const timeB = (!b.startTimeEst || b.startTimeEst === 'TBD') ? '99:00' : b.startTimeEst;
    if (timeA < timeB) return -1;
    if (timeA > timeB) return 1;
    // Tertiary: sortOrder ascending (VSiN page order)
    const byOrder = (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999);
    if (byOrder !== 0) return byOrder;
    // Quaternary: row id — a stable, deterministic tie-breaker so equal-time
    // rows (e.g. doubleheader games with TBD times) never reorder between
    // requests/caches (canonical-identity contract: deterministic sorting).
    return (a.id ?? 0) - (b.id ?? 0);
  });
}

export async function insertGames(rows: InsertGame[]) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (rows.length === 0) return;
  // ON DUPLICATE KEY UPDATE: if (gameDate, awayTeam, homeTeam) already exists,
  // update the book odds and start time instead of throwing a duplicate key error.
  // This makes all inserts idempotent — safe to call multiple times.
  await db.insert(games).values(rows).onDuplicateKeyUpdate({
    set: {
      startTimeEst: sql`VALUES(startTimeEst)`,
      awayBookSpread: sql`VALUES(awayBookSpread)`,
      homeBookSpread: sql`VALUES(homeBookSpread)`,
      bookTotal: sql`VALUES(bookTotal)`,
      sortOrder: sql`VALUES(sortOrder)`,
      ncaaContestId: sql`COALESCE(ncaaContestId, VALUES(ncaaContestId))`,
    },
  });
  invalidateGamesCache();
}

export async function listGames(opts?: { sport?: string; gameDate?: string; forceRefresh?: boolean }): Promise<Game[]> {
  // ─── Cache lookup ─────────────────────────────────────────────────────────────────
  // Cache key encodes all query dimensions so different sport/date combos
  // are cached independently. forceRefresh bypasses cache (used by admin refresh).
  const cacheKey = `${opts?.sport ?? 'ALL'}:${opts?.gameDate ?? 'ROLLING'}`;
  if (!opts?.forceRefresh) {
    const cached = _gamesListCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      _cacheCounters.gamesHit++;
      // [GamesCache][HIT] — silenced in hot path (was logging on every cache hit, ~1/min per user)
      return cached.data;
    }
  } else {
    console.log(`[GamesCache][BYPASS] key=${cacheKey} forceRefresh=true`);
  }
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const conditions = [];

  if (opts?.gameDate) {
    // Specific date requested — return only that date
    conditions.push(eq(games.gameDate, opts.gameDate));
  }
  // No date filter when no specific date is requested:
  // Games are retained indefinitely (daily purge disabled as of 2026-03-25).
  // All game rows from March 25, 2026 onward remain in the DB permanently.

  if (opts?.sport) conditions.push(eq(games.sport, opts.sport));

  // For MLB: apply a 7-day rolling window (today through today+6) since the full season
  // (2,430 games) is pre-seeded and we don't want to transfer all of them on every query.
  // Other sports use VSiN-driven insertion so they only have current/upcoming games in DB.
  if (opts?.sport === 'MLB' && !opts?.gameDate) {
    // Apply the same 11:00 UTC gate used by the frontend todayUTC() function.
    // Before 11:00 UTC the feed still shows the previous day's slate, so the
    // window must start from (UTC calendar date - 1 day) to include those games.
    // This prevents the server from excluding yesterday's games when the UTC
    // calendar has rolled over but the feed has not yet transitioned.
    const FEED_CUTOFF_UTC_HOUR = 11;
    const nowMs = Date.now();
    const nowUtc = new Date(nowMs);
    const isBeforeCutoff = nowUtc.getUTCHours() < FEED_CUTOFF_UTC_HOUR;
    const windowStartMs = isBeforeCutoff ? nowMs - 24 * 60 * 60 * 1000 : nowMs;
    const windowStartDate = new Date(windowStartMs);
    const todayUtc = [
      windowStartDate.getUTCFullYear(),
      String(windowStartDate.getUTCMonth() + 1).padStart(2, '0'),
      String(windowStartDate.getUTCDate()).padStart(2, '0'),
    ].join('-');
    const plusSeven = new Date(windowStartMs + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    conditions.push(gte(games.gameDate, todayUtc));
    conditions.push(lte(games.gameDate, plusSeven));
    console.log(`[DB][listGames] MLB 7-day window: ${todayUtc} → ${plusSeven} (utcHour=${nowUtc.getUTCHours()}, beforeCutoff=${isBeforeCutoff})`);
  }

  // NCAAF keeps the complete dated slate, including paused/postponed games.
  // Keep the legacy lifecycle exclusion unchanged for every other league,
  // including mixed-sport queries where opts.sport is absent.
  conditions.push(or(
    eq(games.sport, 'NCAAF'),
    and(ne(games.gameStatus, 'postponed'), ne(games.gameStatus, 'suspended')),
  )!);

  // Public feed: show all games that have live VSiN odds (regardless of publishedToFeed)
  // MLB games are seeded from the schedule and may not have odds yet — show them regardless
  if (opts?.sport !== 'MLB') {
    conditions.push(or(isNotNull(games.awayBookSpread), isNotNull(games.bookTotal))!);
  }

  const rows = await db
    .select()
    .from(games)
    .where(and(...conditions))
    .orderBy(games.gameDate, games.sortOrder);

  // Gate model projections: only expose model fields when the owner has approved them.
  // NBA/NHL/MLB games bypass this gate — their model data is always returned as-is.
  // If publishedModel = false on an NCAAM game (legacy), null out all model-related fields.
  const MODEL_FIELDS = [
    'awayModelSpread', 'homeModelSpread', 'modelTotal',
    'modelAwayML', 'modelHomeML', 'modelAwayScore', 'modelHomeScore',
    'modelOverRate', 'modelUnderRate', 'modelAwayWinPct', 'modelHomeWinPct',
    'modelSpreadClamped', 'modelTotalClamped', 'modelCoverDirection', 'modelRunAt',
    'spreadEdge', 'spreadDiff', 'totalEdge', 'totalDiff',
    'modelAwaySpreadOdds', 'modelHomeSpreadOdds', 'modelOverOdds', 'modelUnderOdds',
  ] as const;
  const gated: Game[] = rows.map((row: Game): Game => {
    // Only gate NCAAM games
    if (row.sport !== 'NCAAM') return row;
    if (row.publishedModel) return row;
    const copy = { ...row } as Record<string, unknown>;
    for (const field of MODEL_FIELDS) copy[field] = null;
    return copy as Game;
  });

  // Sort by start time in Node.js: treat '00:00' as midnight (sort last within each date)
  const result = sortGamesByStartTime(gated) as Game[];

  // ─── Empty result guard ──────────────────────────────────────────────────────────────
  // If the DB returned 0 rows for a key that previously had rows, this is almost certainly
  // a transient DB failure (TiDB cold start, connection pool exhaustion, SSL timeout).
  // Strategy:
  //   1. Retry once after 200ms — catches transient connection issues
  //   2. If retry also returns 0, serve last-known-good result (if within 30min TTL)
  //   3. Never write an empty result to the primary cache — forces immediate retry on next request
  if (result.length === 0) {
    const lastGood = _lastGoodCache.get(cacheKey);
    const lastGoodAge = lastGood ? Date.now() - lastGood.storedAt : Infinity;

    // Retry once after 200ms to recover from transient DB connection issues
    console.warn(`[GamesCache][EMPTY] key=${cacheKey} — DB returned 0 rows. Retrying in 200ms...`);
    await new Promise(r => setTimeout(r, 200));
    let retryResult: Game[] = [];
    try {
      const retryRows = await db
        .select()
        .from(games)
        .where(and(...conditions))
        .orderBy(games.gameDate, games.sortOrder);
      const retryGated: Game[] = retryRows.map((row: Game): Game => {
        if (row.sport !== 'NCAAM') return row;
        if (row.publishedModel) return row;
        const copy = { ...row } as Record<string, unknown>;
        for (const field of ['awayModelSpread','homeModelSpread','modelTotal','modelAwayML','modelHomeML','modelAwayScore','modelHomeScore','modelOverRate','modelUnderRate','modelAwayWinPct','modelHomeWinPct','modelSpreadClamped','modelTotalClamped','modelCoverDirection','modelRunAt','spreadEdge','spreadDiff','totalEdge','totalDiff','modelAwaySpreadOdds','modelHomeSpreadOdds','modelOverOdds','modelUnderOdds'] as const)
          copy[field] = null;
        return copy as Game;
      });
      retryResult = sortGamesByStartTime(retryGated) as Game[];
      console.log(`[GamesCache][RETRY] key=${cacheKey} retry rows=${retryResult.length}`);
    } catch (retryErr) {
      console.error(`[GamesCache][RETRY_FAIL] key=${cacheKey}:`, retryErr);
    }

    if (retryResult.length > 0) {
      // Retry succeeded — cache and return the retry result
      _gamesListCache.set(cacheKey, { data: retryResult, expiresAt: Date.now() + GAMES_LIST_TTL_MS });
      _lastGoodCache.set(cacheKey, { data: retryResult, storedAt: Date.now() });
      _cacheCounters.gamesMiss++;
      console.log(`[GamesCache][RETRY_OK] key=${cacheKey} rows=${retryResult.length} — cached`);
      return retryResult;
    }

    // Both attempts returned 0. Serve last-known-good if available and fresh.
    if (lastGood && lastGoodAge < LAST_GOOD_TTL_MS) {
      console.warn(
        `[GamesCache][LAST_GOOD] key=${cacheKey} — serving stale result from ${Math.round(lastGoodAge / 1000)}s ago ` +
        `(${lastGood.data.length} rows). DB returned 0 on both attempts.`
      );
      // Cache the last-good result with a SHORT TTL (15s) so we retry DB soon
      _gamesListCache.set(cacheKey, { data: lastGood.data, expiresAt: Date.now() + 15_000 });
      _cacheCounters.gamesMiss++;
      return lastGood.data;
    }

    // No last-known-good available — return empty but DO NOT cache it.
    // The next request will immediately retry the DB.
    console.error(
      `[GamesCache][EMPTY_FINAL] key=${cacheKey} — returning empty result. ` +
      `No last-known-good available (lastGoodAge=${Math.round(lastGoodAge / 1000)}s).`
    );
    _cacheCounters.gamesMiss++;
    return result; // empty []
  }

  // ─── Cache write ─────────────────────────────────────────────────────────────────
  _gamesListCache.set(cacheKey, { data: result, expiresAt: Date.now() + GAMES_LIST_TTL_MS });
  // Update last-known-good with this fresh non-empty result
  _lastGoodCache.set(cacheKey, { data: result, storedAt: Date.now() });
  _cacheCounters.gamesMiss++;
  console.log(`[GamesCache][MISS] key=${cacheKey} rows=${result.length} ttl=${GAMES_LIST_TTL_MS / 1000}s`);

  return result;
}

// ─── Available dates cache ───────────────────────────────────────────────────
// _availableDatesCache is declared at the top of the cache section (line ~50)
// so invalidateGamesCache() can clear it. The TTL constant is defined here.
const AVAILABLE_DATES_TTL_MS = AVAILABLE_DATES_TTL_MS_EARLY; // 5 minutes

/**
 * Return the sorted list of distinct gameDate values for a sport.
 * Uses the same 7-day MLB rolling window as listGames so the calendar
 * shows the same dates that the feed will display.
 *
 * Cached for 5 minutes. Invalidated on any game mutation.
 */
export async function getAvailableDates(sport: string): Promise<string[]> {
  const cacheKey = `DATES:${sport}`;
  const cached = _availableDatesCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    _cacheCounters.datesHit++;
    // [AvailDatesCache][HIT] — silenced in hot path
    return cached.data;
  }

  const db = await getDb();
  if (!db) throw new Error('Database not available');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conditions: any[] = [];
  conditions.push(eq(games.sport, sport));
  conditions.push(ne(games.gameStatus, 'postponed'));

  // MLB: apply the same 7-day rolling window used by listGames so the calendar
  // shows the same date range as the feed.
  if (sport === 'MLB') {
    const FEED_CUTOFF_UTC_HOUR = 11;
    const nowMs = Date.now();
    const nowUtc = new Date(nowMs);
    const isBeforeCutoff = nowUtc.getUTCHours() < FEED_CUTOFF_UTC_HOUR;
    const windowStartMs = isBeforeCutoff ? nowMs - 24 * 60 * 60 * 1000 : nowMs;
    const windowStartDate = new Date(windowStartMs);
    const todayUtc = [
      windowStartDate.getUTCFullYear(),
      String(windowStartDate.getUTCMonth() + 1).padStart(2, '0'),
      String(windowStartDate.getUTCDate()).padStart(2, '0'),
    ].join('-');
    const plusSeven = new Date(windowStartMs + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    conditions.push(gte(games.gameDate, todayUtc));
    conditions.push(lte(games.gameDate, plusSeven));
  } else {
    // Non-MLB: only include games that have live VSiN odds (same gate as listGames)
    conditions.push(or(isNotNull(games.awayBookSpread), isNotNull(games.bookTotal)));
  }

  const rows = await db
    .selectDistinct({ gameDate: games.gameDate })
    .from(games)
    .where(and(...conditions))
    .orderBy(games.gameDate);

  const dates = rows.map((r: { gameDate: string }) => r.gameDate).filter(Boolean).sort() as string[];

  _availableDatesCache.set(cacheKey, { data: dates, expiresAt: Date.now() + AVAILABLE_DATES_TTL_MS });
  _cacheCounters.datesMiss++;
  console.log(`[AvailDatesCache][MISS] sport=${sport} dates=${dates.length} (${dates.join(', ')})`);
  return dates;
}

export async function deleteGamesByFileId(fileId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(games).where(eq(games.fileId, fileId));
  forceInvalidateGamesCache(); // admin op — immediate visibility required
}

/**
 * Hard-delete a single game by its primary key ID.
 * Owner-only operation — enforced at the procedure layer.
 */
export async function deleteGameById(id: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(games).where(eq(games.id, id));
  forceInvalidateGamesCache(); // admin op — immediate visibility required
}

// deleteOldGames() REMOVED — daily purge permanently disabled as of 2026-03-25.
// All game data from March 25, 2026 onward is retained indefinitely.

// ─── App Users (custom accounts) ─────────────────────────────────────────────────

// appUsers, InsertAppUser, userFavoriteGames — imported at top of file
export async function createAppUser(data: InsertAppUser) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await withCircuitBreaker(async () => {
    await db.insert(appUsers).values(data);
  });
}

export async function listAppUsers(): Promise<AppUser[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    return await withCircuitBreaker(async () => {
      return db.select().from(appUsersTable).orderBy(appUsersTable.createdAt);
    });
  } catch {
    return [];
  }
}

// ─── AppUser by-ID cache ─────────────────────────────────────────────────────
// PROBLEM: handicapperProcedure calls getAppUserById on EVERY tRPC request.
// On initial BetTracker page load, 3 procedures fire simultaneously — each
// calling getAppUserById for the same user. That's 3 identical DB reads.
// SOLUTION: Cache by numeric ID with a 30s TTL. Same invalidation as the
// openId cache — called in invalidateAppUserCache().
const _appUserByIdCache = new Map<number, CacheEntry<AppUser | null>>();
const APP_USER_CACHE_TTL_MS = 30_000; // 30 seconds

export function invalidateAppUserByIdCache(id: number): void {
  _appUserByIdCache.delete(id);
}

export type AppUserLookupResult =
  | { status: "found"; user: AppUser }
  | { status: "not_found" }
  | { status: "unavailable"; error: unknown };

/**
 * Read an app user directly from the database and preserve the distinction
 * between a missing row and an unavailable database. Privileged authorization
 * must not use getAppUserById(), whose legacy null return intentionally merges
 * those two states for non-privileged callers.
 */
export async function lookupAppUserByIdFresh(id: number): Promise<AppUserLookupResult> {
  const db = await getDb();
  if (!db) {
    return { status: "unavailable", error: new Error("Database not available") };
  }

  try {
    const rows = await withCircuitBreaker(async () =>
      db.select().from(appUsers).where(and(eq(appUsers.id, id), isNull(appUsers.deletedAt))).limit(1)
    );
    const user = rows[0];
    if (!user) return { status: "not_found" };

    _appUserByIdCache.set(id, {
      data: user,
      expiresAt: Date.now() + APP_USER_CACHE_TTL_MS,
    });
    return { status: "found", user };
  } catch (error) {
    return { status: "unavailable", error };
  }
}

/**
 * Find ANY user — retired (soft-deleted) rows included — whose live
 * `discordId` OR pre-registered `manualDiscordId` equals this snowflake.
 * Retired rows must count: soft deletion keeps both identity columns
 * populated, both are UNIQUE-indexed across ALL rows, and dime's own owner
 * path (appUsers.setManualDiscordId CP-4) does not exclude them either.
 * Skipping them would make a retired identity look free — the write would
 * then die on the index (500) or, worse, plant a second live claim that
 * Discord login resolves to the retired row.
 * Returns null when the snowflake is free; THROWS on a genuine DB fault so a
 * caller fails loud rather than treating "unavailable" as "free".
 */
export async function lookupAppUserByDiscordSnowflake(
  snowflake: string,
): Promise<{ id: number; username: string } | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await withCircuitBreaker(async () =>
    db
      .select({ id: appUsers.id, username: appUsers.username })
      .from(appUsers)
      .where(or(eq(appUsers.discordId, snowflake), eq(appUsers.manualDiscordId, snowflake)))
      .limit(1),
  );
  return rows[0] ?? null;
}

export type ManualDiscordIdWrite = "ok" | "already_connected" | "duplicate";

/**
 * Set (snowflake) or clear (null) a user's pre-registered manualDiscordId.
 *
 * This write is the arbiter of the two identity rules; the probe callers run
 * first is only the cheap, clean error path:
 *   - A set is CONDITIONAL on `discordId IS NULL`, so a Discord link that
 *     lands between the caller's check and this statement matches zero rows
 *     → "already_connected" (a live connection is never overwritten).
 *   - Both Discord columns are UNIQUE-indexed, so a snowflake claimed by any
 *     other row (retired ones included) between probe and write is rejected
 *     by the index → "duplicate", never a 500.
 * mysql2 connects with CLIENT_FOUND_ROWS, so affectedRows counts MATCHED rows:
 * a same-value re-set still reports 1; only a failed condition reports 0.
 */
export async function setAppUserManualDiscordId(
  id: number,
  value: string | null,
): Promise<ManualDiscordIdWrite> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  try {
    const result = await withCircuitBreaker(async () =>
      db
        .update(appUsers)
        .set({ manualDiscordId: value, updatedAt: new Date() })
        .where(
          value === null
            ? eq(appUsers.id, id)
            : and(eq(appUsers.id, id), isNull(appUsers.discordId)),
        ),
    );
    const [header] = result as unknown as [{ affectedRows?: number }];
    if (value !== null && (header?.affectedRows ?? 0) === 0) return "already_connected";
  } catch (err) {
    if (isDuplicateKeyError(err)) return "duplicate";
    throw err;
  }
  // Same two caches updateAppUser clears — discord changes must propagate immediately.
  invalidateAppUserByIdCache(id);
  invalidateCachedAppUser(id);
  return "ok";
}

/**
 * MySQL/TiDB error codes that mean "the QUERY is wrong", not "the row is absent".
 *
 * [2026-07-31 login outage] app_users.planPriceId shipped in the Drizzle schema
 * before its migration ran. Drizzle enumerates every declared column, so every
 * lookup failed with ER_BAD_FIELD_ERROR — and the blanket `catch { return null }`
 * below turned that into "user not found". Logins broke platform-wide while the
 * logs said `USER_NOT_FOUND ... DB inconsistency`, pointing at the data instead
 * of at the schema. Swallowing a structural error as an empty result is how a
 * five-second fix became an outage.
 *
 * These specific codes are re-thrown so the caller fails loudly. Transient
 * faults (connection resets, timeouts, circuit-breaker trips) keep the previous
 * fail-soft behaviour — those genuinely should degrade rather than 500.
 */
const SCHEMA_ERROR_CODES = new Set([
  "ER_BAD_FIELD_ERROR",   // unknown column — schema is behind the code
  "ER_NO_SUCH_TABLE",     // missing table — migration not applied
  "ER_PARSE_ERROR",       // malformed SQL
  "ER_WRONG_FIELD_SPEC",
  "ER_BAD_TABLE_ERROR",
]);

/**
 * The driver error code behind a failure, looked up THROUGH any wrapper.
 *
 * drizzle-orm (>=0.4x) raises `DrizzleQueryError`, whose own `.code` is
 * `undefined` and whose message is `"Failed query: <sql> params: …"`. The mysql2
 * error carrying `code: "ER_…"` / `errno` hangs off `.cause`. Classifying on the
 * top-level `.code` alone therefore matches NOTHING for any query issued through
 * drizzle — verified against drizzle-orm 0.45.2:
 *
 *   duplicate key  → DrizzleQueryError { code: undefined, cause: { code: "ER_DUP_ENTRY",      errno: 1062 } }
 *   unknown column → DrizzleQueryError { code: undefined, cause: { code: "ER_BAD_FIELD_ERROR", errno: 1054 } }
 *
 * This shipped as two live defects: duplicate webhook deliveries were rethrown
 * as processing failures (answered 5xx, so Stripe redelivered, so it failed
 * again — a self-sustaining retry storm), and isSchemaError() never fired, so
 * the fail-loud drift detection could not see the very error class it was
 * written for. Walk the chain; do not read `.code` directly.
 */
export function driverErrorCode(err: unknown): string | null {
  let current: unknown = err;
  // Bounded: a malformed or self-referential cause chain must not spin.
  for (let depth = 0; current != null && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** True when the failure means the query itself is invalid against this schema. */
export function isSchemaError(err: unknown): boolean {
  const code = driverErrorCode(err);
  return code !== null && SCHEMA_ERROR_CODES.has(code);
}

/**
 * True when the failure is a unique-constraint collision.
 *
 * Load-bearing for insert-first idempotency claims: a duplicate is the SUCCESS
 * signal ("someone already processed this"), not an error. Misreading it as a
 * failure turns every redelivery into a 5xx.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  if (driverErrorCode(err) === "ER_DUP_ENTRY") return true;
  // errno survives some driver/proxy layers that drop the string code.
  let current: unknown = err;
  for (let depth = 0; current != null && depth < 5; depth += 1) {
    if ((current as { errno?: unknown }).errno === 1062) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function getAppUserById(id: number) {
  // Cache hit: skip DB round-trip
  const cached = _appUserByIdCache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  const db = await getDb();
  if (!db) return null;
  try {
    const result = await withCircuitBreaker(async () => {
      const rows = await db.select().from(appUsers).where(and(eq(appUsers.id, id), isNull(appUsers.deletedAt))).limit(1);
      return rows[0] ?? null;
    });
    // Cache result (including null = user not found)
    _appUserByIdCache.set(id, { data: result, expiresAt: Date.now() + APP_USER_CACHE_TTL_MS });
    return result;
  } catch (err) {
    // A schema mismatch is NOT "no such user" — say so loudly rather than
    // silently reporting every account as missing.
    if (isSchemaError(err)) {
      console.error(
        `[DB][getAppUserById] SCHEMA ERROR — the app_users query is invalid against the live schema. ` +
        `This usually means code deployed ahead of its migration. id=${id} code=${(err as { code?: string }).code} ` +
        `message=${err instanceof Error ? err.message : String(err)}`
      );
      throw err;
    }
    return null;
  }
}

export type AppUsersSchemaVerdict = "ok" | "schema_mismatch" | "unknown";

/**
 * Classify a probe-query failure into a schema verdict.
 *
 * ONLY a missing COLUMN (`ER_BAD_FIELD_ERROR`, errno 1054) is a `schema_mismatch`
 * — that is the exact #370 / 2026-07-31 class: code SELECTs an app_users column
 * its migration has not added yet. It fails the health gate so the deploy is
 * kept off production.
 *
 * A missing TABLE (`ER_NO_SUCH_TABLE`) is deliberately NOT a mismatch → "unknown"
 * (non-blocking). This repo runs the same server image on two services; the
 * secondary `ai-sports-betting-backend` connects to a database WITHOUT the
 * app_users table, so its probe legitimately raises ER_NO_SUCH_TABLE. Failing
 * health there would (and did, 2026-08-05) block that service's deploys forever
 * for no real drift. On the primary DB app_users is the core table and is never
 * absent from a normal column-adding migration; a genuinely vanished table is a
 * catastrophic state that "run db-push" would not repair and must not freeze
 * deploys. This narrowing also makes the gate SELF-SCOPING: it can only fail a
 * service that actually owns app_users (and is missing a column) — exactly the
 * intended target. Everything else (connection reset/timeout/circuit) is
 * transient → "unknown".
 */
export function classifyAppUsersProbeError(err: unknown): AppUsersSchemaVerdict {
  return driverErrorCode(err) === "ER_BAD_FIELD_ERROR"
    ? "schema_mismatch"
    : "unknown";
}

/**
 * Boot/health probe: does the LIVE app_users schema satisfy the CURRENT code's
 * column set? Runs the real Drizzle column enumeration (`select()` names every
 * declared column) against a row that never matches (id=0), so it transfers no
 * rows but still forces the database to validate every column at plan time.
 *
 * Unlike getAppUserById (whose null return is load-bearing for callers), this
 * SURFACES the schema error as a verdict — that swallowing is exactly how the
 * #370 / 2026-07-31 outages stayed silent. Returns:
 *   - "ok"               every declared column exists on the live table
 *   - "schema_mismatch"  a missing COLUMN (ER_BAD_FIELD_ERROR) — code is ahead
 *                        of its migration (the deploy that must NOT go live)
 *   - "unknown"          missing table / DB unavailable / transient — caller
 *                        must NOT treat this as a failure (see
 *                        classifyAppUsersProbeError)
 * Never throws. No cache — always reads the live schema.
 */
export async function probeAppUsersSchema(): Promise<AppUsersSchemaVerdict> {
  const db = await getDb();
  if (!db) return "unknown";
  try {
    await db.select().from(appUsers).where(eq(appUsers.id, 0)).limit(1);
    return "ok";
  } catch (err) {
    const verdict = classifyAppUsersProbeError(err);
    if (verdict === "schema_mismatch") {
      console.error(
        `[DB][probeAppUsersSchema] SCHEMA MISMATCH — app_users is missing a column ` +
          `the code SELECTs. Code deployed ahead of its migration? ` +
          `code=${driverErrorCode(err)} message=${err instanceof Error ? err.message : String(err)}`
      );
    } else if (driverErrorCode(err) === "ER_NO_SUCH_TABLE") {
      // Expected on a service that does not own the app schema (the zombie
      // backend). Observability only — does not fail the gate.
      console.warn(
        `[DB][probeAppUsersSchema] app_users table not found (ER_NO_SUCH_TABLE) — ` +
          `this service does not own the app schema; treating as unknown (non-blocking).`
      );
    }
    // schema_mismatch only for a missing column; everything else is unknown.
    return verdict;
  }
}

/**
 * Batch identity lookup for the analytics profiling read-time join (owner-only).
 * Returns ONLY display fields (no email/password) for the given app-user ids.
 * Runs on the web instance (TiDB = app_users); never throws — a failure just
 * leaves the analytics rows pseudonymous.
 */
export async function getAppUsersByIds(
  ids: number[],
): Promise<Array<{ id: number; username: string; discordUsername: string | null; role: string }>> {
  if (!ids.length) return [];
  const db = await getDb();
  if (!db) return [];
  try {
    return await withCircuitBreaker(async () =>
      db
        .select({
          id: appUsers.id,
          username: appUsers.username,
          discordUsername: appUsers.discordUsername,
          role: appUsers.role,
        })
        .from(appUsers)
        .where(inArray(appUsers.id, ids)),
    );
  } catch {
    return [];
  }
}

export async function getAppUserByEmail(email: string) {
  const db = await getDb();
  if (!db) return null;
  try {
    return await withCircuitBreaker(async () => {
      const rows = await db.select().from(appUsers).where(and(eq(appUsers.email, email), isNull(appUsers.deletedAt))).limit(1);
      return rows[0] ?? null;
    });
  } catch {
    return null;
  }
}

export async function getAppUserByUsername(username: string) {
  const db = await getDb();
  if (!db) return null;
  try {
    return await withCircuitBreaker(async () => {
      const rows = await db.select().from(appUsers).where(and(eq(appUsers.username, username), isNull(appUsers.deletedAt))).limit(1);
      return rows[0] ?? null;
    });
  } catch {
    return null;
  }
}

/**
 * Absolute-write of the lockout counters — used ONLY to CLEAR state (set to
 * 0/null) on successful login. Clearing is idempotent, so a plain last-writer
 * -wins SET is race-safe here (unlike incrementing — see recordAccountLoginFailure).
 * FAIL-OPEN: a write failure degrades the control, never blocks/crashes login.
 */
export async function updateAccountLockoutState(
  id: number,
  state: { failedLoginCount: number; firstFailedLoginAt: number | null; lockedUntil: number | null }
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await withCircuitBreaker(async () => {
      await db.update(appUsers).set(state).where(eq(appUsers.id, id));
    });
    invalidateAppUserByIdCache(id);
    invalidateCachedAppUser(id);
  } catch (err) {
    console.error(
      `[AccountLockout] state write failed for user ${id}: ${(err as Error).message}`
    );
  }
}

/**
 * Atomically record ONE failed login against an account and return the new
 * lock decision. The count is an increment, so it MUST be atomic: reading the
 * count in JS and writing an absolute value (as a plain update would) lets N
 * concurrent failures all read the same N and each write N+1 — the exact
 * botnet/credential-stuffing case this feature exists to stop would slip the
 * cap. We serialize on the row with `SELECT … FOR UPDATE` inside a transaction
 * (the repo's double-spend pattern), run the tested pure `recordFailure`
 * decision on the freshly-locked row, and write the result.
 *
 * FAIL-OPEN: any DB failure returns `{ justLocked:false, lockedUntil:null }`
 * without throwing — the per-IP limiter remains the backstop and a login is
 * never blocked by a lockout-write fault.
 */
export async function recordAccountLoginFailure(
  id: number,
  now: number,
  config: AccountLockoutConfig
): Promise<{ justLocked: boolean; lockedUntil: number | null }> {
  if (config.disabled) return { justLocked: false, lockedUntil: null };
  const db = await getDb();
  if (!db) return { justLocked: false, lockedUntil: null };
  try {
    const result = await withCircuitBreaker(async () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db.transaction(async (tx: any) => {
        const rows = await tx
          .select({
            failedLoginCount: appUsers.failedLoginCount,
            firstFailedLoginAt: appUsers.firstFailedLoginAt,
            lockedUntil: appUsers.lockedUntil,
          })
          .from(appUsers)
          .where(eq(appUsers.id, id))
          .for("update")
          .limit(1);
        const before = rows[0];
        if (!before) return { justLocked: false, lockedUntil: null };
        const { next, justLocked } = recordFailure(
          {
            failedLoginCount: before.failedLoginCount,
            firstFailedLoginAt: before.firstFailedLoginAt,
            lockedUntil: before.lockedUntil,
          },
          now,
          config
        );
        await tx.update(appUsers).set(next).where(eq(appUsers.id, id));
        return { justLocked, lockedUntil: next.lockedUntil };
      })
    );
    invalidateAppUserByIdCache(id);
    invalidateCachedAppUser(id);
    return result;
  } catch (err) {
    console.error(
      `[AccountLockout] atomic failure-record failed for user ${id}: ${(err as Error).message}`
    );
    return { justLocked: false, lockedUntil: null };
  }
}

export async function updateAppUser(id: number, data: Partial<InsertAppUser>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await withCircuitBreaker(async () => {
    await db.update(appUsers).set({ ...data, updatedAt: new Date() }).where(eq(appUsers.id, id));
  });
  // Invalidate BOTH caches: db.ts TTL cache + dbCircuitBreaker user cache
  // Both must be cleared so role/access/discord changes propagate immediately
  invalidateAppUserByIdCache(id);
  invalidateCachedAppUser(id);
}

/**
 * Count every row across the schema that points at this app_users.id.
 * See APP_USER_DEPENDENT_TABLES for why the list is explicit rather than
 * derived from foreign keys: there are no foreign keys on app_users.
 */
export async function countAppUserDependents(id: number): Promise<DependentCounts> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const counts: DependentCounts = {};
  await withCircuitBreaker(async () => {
    for (const { table, column, label } of APP_USER_DEPENDENT_TABLES) {
      try {
        const rows = await db.execute(
          sql.raw(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${column}\` = ${Number(id)}`)
        );
        const first = (rows as unknown as Array<Array<{ n: number }>>)[0]?.[0]
          ?? (rows as unknown as Array<{ n: number }>)[0];
        const n = Number((first as { n: number } | undefined)?.n ?? 0);
        if (n > 0) counts[label] = (counts[label] ?? 0) + n;
      } catch (err) {
        // A table that does not exist in this environment is not a dependency.
        // Anything else is: fail closed rather than under-report and orphan.
        const msg = (err as Error)?.message ?? String(err);
        if (!/doesn't exist|Unknown table|no such table/i.test(msg)) throw err;
      }
    }
  });
  return counts;
}

/**
 * Retire an account without destroying anything it owns.
 *
 * THE DEFAULT, and what the admin UI should call. Sets `deletedAt`, which every
 * account-resolution path excludes, so the account can no longer authenticate,
 * cannot be found by email or username, and disappears from the app — while its
 * bets, sessions and edit requests stay intact and attributed.
 *
 * This is the operation that was missing when account 60002 was removed. A hard
 * DELETE stranded 278 verified bets; this would have been a flag flip, fully
 * reversible.
 */
export async function softDeleteAppUser(id: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await withCircuitBreaker(async () => {
    await db.update(appUsers).set({ deletedAt: Date.now() }).where(eq(appUsers.id, id));
  });
  invalidateAppUserByIdCache(id);
  invalidateCachedAppUser(id);
  console.log(`[AppAdmin] softDeleteAppUser: userId=${id} retired (data preserved)`);
}

/** Undo a soft delete. */
export async function restoreAppUser(id: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await withCircuitBreaker(async () => {
    await db.update(appUsers).set({ deletedAt: null }).where(eq(appUsers.id, id));
  });
  invalidateAppUserByIdCache(id);
  invalidateCachedAppUser(id);
  console.log(`[AppAdmin] restoreAppUser: userId=${id} restored`);
}

/**
 * Permanently remove an app_users row. Rarely what you want.
 *
 * Still REFUSES when anything references the account, because nothing would
 * clean those rows up. With soft delete available, that refusal is no longer an
 * obstacle — it just means "retire it instead", which preserves the history.
 * Reserve this for accounts that own nothing, or for a genuine erasure request
 * where the dependent rows have already been dealt with deliberately.
 */
export async function deleteAppUser(id: number) {
  const counts = await countAppUserDependents(id);
  const block = describeDeletionBlock(id, counts);
  if (block) {
    console.log(`[AppAdmin] deleteAppUser: REFUSED userId=${id} — ${JSON.stringify(counts)}`);
    throw new AppUserHasDataError(id, counts, block);
  }

  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await withCircuitBreaker(async () => {
    await db.delete(appUsers).where(eq(appUsers.id, id));
  });
  invalidateAppUserByIdCache(id);
  invalidateCachedAppUser(id);
}

export async function updateAppUserLastSignedIn(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(appUsers).set({ lastSignedIn: new Date() }).where(eq(appUsers.id, id));
}

/**
 * Increment tokenVersion for a single user, immediately invalidating all their existing JWTs.
 * Returns the new tokenVersion value.
 */
export async function incrementTokenVersion(id: number): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await withCircuitBreaker(async () => {
    await db
      .update(appUsers)
      .set({ tokenVersion: sql`${appUsers.tokenVersion} + 1`, updatedAt: new Date() })
      .where(eq(appUsers.id, id));
    const rows = await db.select({ tv: appUsers.tokenVersion }).from(appUsers).where(eq(appUsers.id, id)).limit(1);
    const newTv = rows[0]?.tv ?? 1;
    console.log(`[DB] incrementTokenVersion: userId=${id} newTokenVersion=${newTv}`);
    return newTv;
  });
  // Invalidate by-ID cache — token version change must propagate immediately
  invalidateAppUserByIdCache(id);
  return result;
}

/**
 * Increment tokenVersion for ALL users EXCEPT the excluded owner.
 * Used for "force logout all" — the owner stays logged in.
 * Returns the count of affected users.
 */
export async function incrementAllTokenVersions(excludeOwnerId: number): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return await withCircuitBreaker(async () => {
    const result = await db
      .update(appUsers)
      .set({ tokenVersion: sql`${appUsers.tokenVersion} + 1`, updatedAt: new Date() })
      .where(ne(appUsers.id, excludeOwnerId));
    // result[0] is OkPacket with affectedRows
    const count = (result[0] as any)?.affectedRows ?? 0;
    console.log(`[DB] incrementAllTokenVersions: excluded ownerId=${excludeOwnerId} — invalidated ${count} user sessions`);
    return count;
  });
}

// ─── Publish / Model Projection helpers ──────────────────────────────────────

/** List all games for a given date, optionally filtered by sport */
export async function listGamesByDate(gameDate: string, sport?: string): Promise<Game[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const conditions = [eq(games.gameDate, gameDate)];
  if (sport) conditions.push(eq(games.sport, sport));
  const rows = await db
    .select()
    .from(games)
    .where(and(...conditions))
    .orderBy(games.sortOrder);
  return sortGamesByStartTime(rows);
}

/** List all staging games for a given date (fileId = 0, unpublished), optionally filtered by sport */
export async function listStagingGames(gameDate: string, sport?: string): Promise<Game[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const conditions: ReturnType<typeof eq>[] = [eq(games.gameDate, gameDate), eq(games.fileId, 0)];
  if (sport) conditions.push(eq(games.sport, sport));
  const rows = await db
    .select()
    .from(games)
    .where(and(...conditions))
    .orderBy(games.sortOrder);
  return sortGamesByStartTime(rows);
}
/** Update model projections and edge labels for a single game */
export async function updateGameProjections(
  id: number,
  data: {
    awayModelSpread?: string | null;
    homeModelSpread?: string | null;
    modelTotal?: string | null;
    modelAwayML?: string | null;
    modelHomeML?: string | null;
    spreadEdge?: string | null;
    spreadDiff?: string | null;
    totalEdge?: string | null;
    totalDiff?: string | null;
    // v9 model extended fields
    modelAwayScore?: string | null;
    modelHomeScore?: string | null;
    modelOverRate?: string | null;
    modelUnderRate?: string | null;
    modelAwayWinPct?: string | null;
    modelHomeWinPct?: string | null;
    modelSpreadClamped?: boolean | null;
    modelTotalClamped?: boolean | null;
    modelCoverDirection?: string | null;
    modelRunAt?: number | null;
    // NHL-specific odds fields (editable in PublishProjections)
    awaySpreadOdds?: string | null;
    homeSpreadOdds?: string | null;
    overOdds?: string | null;
    underOdds?: string | null;
    // NHL model puck line spread and fair-value odds (set by model sync)
    modelAwayPuckLine?: string | null;
    modelHomePuckLine?: string | null;
    modelAwayPLOdds?: string | null;
    modelHomePLOdds?: string | null;
    modelOverOdds?: string | null;
    modelUnderOdds?: string | null;
    // Model fair odds at book's spread line
    modelAwaySpreadOdds?: string | null;
    modelHomeSpreadOdds?: string | null;
  }
) {
    const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(games).set(data).where(eq(games.id, id));
  invalidateGamesCache();
}
/** Toggle publishedToFeed for a single game */
/**
 * Update book odds (spread + total) for a single game.
 * Called by the VSiN live-refresh procedure.
 */
export async function updateBookOdds(
  id: number,
  data: {
    awayBookSpread?: number | null;
    homeBookSpread?: number | null;
    bookTotal?: number | null;
    sortOrder?: number;
    startTimeEst?: string;
    // Betting splits — shared (spread/total/ML away percentages)
    spreadAwayBetsPct?: number | null;
    spreadAwayMoneyPct?: number | null;
    totalOverBetsPct?: number | null;
    totalOverMoneyPct?: number | null;
    mlAwayBetsPct?: number | null;
    mlAwayMoneyPct?: number | null;
    awayML?: string | null;
    homeML?: string | null;
    // MLB run line splits (dedicated columns, separate from generic spreadAway*)
    rlAwayBetsPct?: number | null;
    rlAwayMoneyPct?: number | null;
    // MetaBet consensus odds (spread juice + O/U odds)
    awaySpreadOdds?: string | null;
    homeSpreadOdds?: string | null;
    overOdds?: string | null;
    underOdds?: string | null;
    // MLB pitcher fields
    awayStartingPitcher?: string | null;
    homeStartingPitcher?: string | null;
    awayPitcherConfirmed?: boolean | null;
    homePitcherConfirmed?: boolean | null;
    // MLB game PK (Stats API unique game identifier)
    mlbGamePk?: number | null;
  }
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const { eq } = await import("drizzle-orm");
  const updateData: Record<string, unknown> = {};
  if (data.awayBookSpread !== undefined) updateData.awayBookSpread = data.awayBookSpread !== null ? String(data.awayBookSpread) : null;
  if (data.homeBookSpread !== undefined) updateData.homeBookSpread = data.homeBookSpread !== null ? String(data.homeBookSpread) : null;
  if (data.bookTotal !== undefined) {
    updateData.bookTotal = data.bookTotal !== null ? String(data.bookTotal) : null;
    // CRITICAL: modelTotal must always mirror bookTotal (same line, model odds only).
    // Whenever bookTotal changes (line move from AN API refresh), modelTotal must stay in sync.
    // This prevents the feed from showing mismatched book/model lines after odds refresh.
    if (data.bookTotal !== null) updateData.modelTotal = String(data.bookTotal);
  }
  if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder;
  if (data.startTimeEst !== undefined) updateData.startTimeEst = data.startTimeEst;
  // Splits — only write non-undefined values (null = explicitly clear, undefined = skip)
  if (data.spreadAwayBetsPct !== undefined) updateData.spreadAwayBetsPct = data.spreadAwayBetsPct;
  if (data.spreadAwayMoneyPct !== undefined) updateData.spreadAwayMoneyPct = data.spreadAwayMoneyPct;
  if (data.totalOverBetsPct !== undefined) updateData.totalOverBetsPct = data.totalOverBetsPct;
  if (data.totalOverMoneyPct !== undefined) updateData.totalOverMoneyPct = data.totalOverMoneyPct;
  if (data.mlAwayBetsPct !== undefined) updateData.mlAwayBetsPct = data.mlAwayBetsPct;
  if (data.mlAwayMoneyPct !== undefined) updateData.mlAwayMoneyPct = data.mlAwayMoneyPct;
  if (data.awayML !== undefined) updateData.awayML = data.awayML;
  if (data.homeML !== undefined) updateData.homeML = data.homeML;
  // MLB run line splits
  if (data.rlAwayBetsPct !== undefined) updateData.rlAwayBetsPct = data.rlAwayBetsPct;
  if (data.rlAwayMoneyPct !== undefined) updateData.rlAwayMoneyPct = data.rlAwayMoneyPct;
  if (data.awaySpreadOdds !== undefined) updateData.awaySpreadOdds = data.awaySpreadOdds;
  if (data.homeSpreadOdds !== undefined) updateData.homeSpreadOdds = data.homeSpreadOdds;
  if (data.overOdds !== undefined) updateData.overOdds = data.overOdds;
  if (data.underOdds !== undefined) updateData.underOdds = data.underOdds;
  // MLB pitcher fields
  if (data.awayStartingPitcher !== undefined) updateData.awayStartingPitcher = data.awayStartingPitcher;
  if (data.homeStartingPitcher !== undefined) updateData.homeStartingPitcher = data.homeStartingPitcher;
  if (data.awayPitcherConfirmed !== undefined) updateData.awayPitcherConfirmed = data.awayPitcherConfirmed;
  if (data.homePitcherConfirmed !== undefined) updateData.homePitcherConfirmed = data.homePitcherConfirmed;
  if (data.mlbGamePk !== undefined) updateData.mlbGamePk = data.mlbGamePk;
    await db.update(games).set(updateData).where(eq(games.id, id));
  invalidateGamesCache();
}
/** Toggle publishedModel for a single game — owner approves/retracts model projections */
export async function setGameModelPublished(id: number, published: boolean): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(games).set({ publishedModel: published }).where(eq(games.id, id));
  forceInvalidateGamesCache(); // admin op — immediate visibility required
}

/**
 * Bulk-approve all pending model projections for a given date and sport.
 * Sets both publishedModel=true AND publishedToFeed=true for all games that have
 * model data and are not yet published.
 *
 * Model data detection is sport-aware:
 *   - NHL: modelAwayPLOdds IS NOT NULL (puck line odds written by nhl_model_engine.py)
 *   - MLB/NBA/NCAAM: awayModelSpread IS NOT NULL AND modelTotal IS NOT NULL
 *
 * Returns the number of rows updated.
 */
export async function bulkApproveModels(gameDate: string, sport?: string): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Sport-aware model data condition:
  // NHL writes modelAwayPLOdds; other sports write awayModelSpread + modelTotal
  const isNhl = sport === "NHL";
  const modelDataCondition = isNhl
    ? isNotNull(games.modelAwayPLOdds)
    : and(isNotNull(games.awayModelSpread), isNotNull(games.modelTotal));

  const conditions = [
    eq(games.gameDate, gameDate),
    eq(games.publishedModel, false),
    modelDataCondition!,
  ];
  if (sport) conditions.push(eq(games.sport, sport));

  // Set BOTH publishedModel and publishedToFeed in a single atomic update
  const result = await db.update(games)
    .set({ publishedModel: true, publishedToFeed: true })
    .where(and(...conditions));
  const affected = (result as unknown as { rowsAffected?: number }[])[0]?.rowsAffected ?? 0;
  console.log(`[DB] bulkApproveModels: gameDate=${gameDate} sport=${sport ?? "all"} isNhl=${isNhl} — approved+published ${affected} games`);
  if (affected > 0) forceInvalidateGamesCache(); // admin op — immediate visibility required
  return affected;
}
export async function setGamePublished(id: number, published: boolean) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // When publishing, verify the game has live VSiN odds
  if (published) {
    const [game] = await db.select().from(games).where(eq(games.id, id)).limit(1);
    if (!game) throw new Error("Game not found");
    const hasOdds = game.awayBookSpread !== null || game.bookTotal !== null;
    if (!hasOdds) {
      throw new Error("Cannot publish: game has no live VSiN odds yet");
    }
  }

    await db.update(games).set({ publishedToFeed: published }).where(eq(games.id, id));
  forceInvalidateGamesCache(); // admin op — immediate visibility required
}
/** List all staging games for a date range (inclusive). Owner-only. */
export async function listStagingGamesRange(fromDate: string, toDate: string, sport?: string): Promise<Game[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const conditions: ReturnType<typeof eq>[] = [
    eq(games.fileId, 0),
    gte(games.gameDate, fromDate),
    lte(games.gameDate, toDate),
  ];
  if (sport) conditions.push(eq(games.sport, sport));
  const rows = await db
    .select()
    .from(games)
    .where(and(...conditions))
    .orderBy(games.gameDate, games.sortOrder);
  return sortGamesByStartTime(rows);
}

/** Look up a game by its NCAA contest ID (for dedup during NCAA-only insert) */
export async function getGameByNcaaContestId(contestId: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(games)
    .where(eq(games.ncaaContestId, contestId))
    .limit(1);
  return rows[0] ?? null;
}

/** Update start time, ncaaContestId, and gameStatus for a game (used when NCAA data arrives after VSiN insert) */
export async function updateNcaaStartTime(
  id: number,
  data: {
    startTimeEst: string;
    ncaaContestId?: string;
    gameStatus?: 'upcoming' | 'live' | 'final' | 'postponed' | 'suspended';
    awayScore?: number | null;
    homeScore?: number | null;
    gameClock?: string | null;
  }
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(games).set(data).where(eq(games.id, id));
  invalidateGamesCache();
}

/** Bulk publish all staging games for a date — only publishes games with live VSiN odds */
export async function publishAllStagingGames(gameDate: string, sport?: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const conditions = [
    eq(games.gameDate, gameDate),
    eq(games.fileId, 0),
    // Only publish games that have live VSiN odds
    or(isNotNull(games.awayBookSpread), isNotNull(games.bookTotal))!,
  ];
  if (sport) conditions.push(eq(games.sport, sport));
    await db
    .update(games)
    .set({ publishedToFeed: true })
    .where(and(...conditions));
  forceInvalidateGamesCache(); // admin op — immediate visibility required
}
// ─── NBA Teams ────────────────────────────────────────────────────────────────

export async function upsertNbaTeams(teams: InsertNbaTeam[]): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  for (const team of teams) {
    await db
      .insert(nbaTeams)
      .values(team)
      .onDuplicateKeyUpdate({
        set: {
          nbaSlug: team.nbaSlug,
          vsinSlug: team.vsinSlug,
          name: team.name,
          nickname: team.nickname,
          city: team.city,
          conference: team.conference,
          division: team.division,
          logoUrl: team.logoUrl,
        },
      });
  }
  return teams.length;
}

export async function listNbaTeams() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(nbaTeams).orderBy(nbaTeams.name);
}

export async function getNbaTeamByDbSlug(dbSlug: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(nbaTeams)
    .where(eq(nbaTeams.dbSlug, dbSlug))
    .limit(1);
  return rows[0] ?? null;
}

export async function getNbaTeamByNbaSlug(nbaSlug: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(nbaTeams)
    .where(eq(nbaTeams.nbaSlug, nbaSlug))
    .limit(1);
  return rows[0] ?? null;
}

// ─── Team Colors ─────────────────────────────────────────────────────────────

export interface TeamColors {
  primaryColor: string | null;
  secondaryColor: string | null;
  tertiaryColor: string | null;
  abbrev: string | null;
  logoUrl: string | null;
}

/**
 * Fetch team colors from the DB for a given team slug and sport.
 * For NBA, looks up nba_teams by dbSlug.
 * For NHL, looks up nhl_teams by dbSlug.
 * For MLB, looks up mlb_teams by abbrev.
 * Returns null if team not found or no colors stored.
 */
export async function getTeamColors(dbSlug: string, sport: string): Promise<TeamColors | null> {
  const db = await getDb();
  if (!db) return null;

  if (sport === "NBA") {
    const rows = await db
      .select({
        primaryColor: nbaTeams.primaryColor,
        secondaryColor: nbaTeams.secondaryColor,
        tertiaryColor: nbaTeams.tertiaryColor,
        abbrev: nbaTeams.abbrev,
        logoUrl: nbaTeams.logoUrl,
      })
      .from(nbaTeams)
      .where(eq(nbaTeams.dbSlug, dbSlug))
      .limit(1);
    return rows[0] ?? null;
  } else if (sport === "NHL") {
    const rows = await db
      .select({
        primaryColor: nhlTeams.primaryColor,
        secondaryColor: nhlTeams.secondaryColor,
        tertiaryColor: nhlTeams.tertiaryColor,
        abbrev: nhlTeams.abbrev,
        logoUrl: nhlTeams.logoUrl,
      })
      .from(nhlTeams)
      .where(eq(nhlTeams.dbSlug, dbSlug))
      .limit(1);
    return rows[0] ?? null;
  } else if (sport === "MLB") {
    // MLB games store teams as abbreviations (e.g. "NYY", "SEA") not dbSlugs.
    // Try abbrev lookup first; fall back to dbSlug lookup for flexibility.
    const rows = await db
      .select({
        primaryColor: mlbTeams.primaryColor,
        secondaryColor: mlbTeams.secondaryColor,
        tertiaryColor: mlbTeams.tertiaryColor,
        abbrev: mlbTeams.abbrev,
        logoUrl: mlbTeams.logoUrl,
      })
      .from(mlbTeams)
      .where(eq(mlbTeams.abbrev, dbSlug))
      .limit(1);
    if (rows[0]) return rows[0];
    // Fallback: try dbSlug (short vsinSlug like "yankees")
    const rows2 = await db
      .select({
        primaryColor: mlbTeams.primaryColor,
        secondaryColor: mlbTeams.secondaryColor,
        tertiaryColor: mlbTeams.tertiaryColor,
        abbrev: mlbTeams.abbrev,
        logoUrl: mlbTeams.logoUrl,
      })
      .from(mlbTeams)
      .where(eq(mlbTeams.dbSlug, dbSlug))
      .limit(1);
    return rows2[0] ?? null;
  } else if (sport === "NCAAM") {
    // NCAAM season ended — return null for legacy games
    return null;
  } else {
    // Unknown sport — return null
    return null;
  }
}

/**
 * Fetch colors for both teams in a game in a single call.
 * Returns { away: TeamColors | null, home: TeamColors | null }
 */
export async function getGameTeamColors(
  awayDbSlug: string,
  homeDbSlug: string,
  sport: string
): Promise<{ away: TeamColors | null; home: TeamColors | null }> {
  const [away, home] = await Promise.all([
    getTeamColors(awayDbSlug, sport),
    getTeamColors(homeDbSlug, sport),
  ]);
  return { away, home };
}

// ─── NHL Team Helpers ────────────────────────────────────────────────────────────

/**
 * Upsert all 32 NHL teams. Uses dbSlug as the conflict key.
 * On conflict, updates all mutable fields (slugs, name, colors, logo).
 * Returns the count of teams processed.
 */
export async function upsertNhlTeams(teams: InsertNhlTeam[]): Promise<number> {
  const db = await getDb();
  if (!db) {
    console.warn("[upsertNhlTeams] Database not available");
    return 0;
  }
  console.log(`[upsertNhlTeams] Upserting ${teams.length} NHL teams...`);
  let upserted = 0;
  for (const team of teams) {
    console.log(`[upsertNhlTeams]   ${team.abbrev} ${team.name} (dbSlug=${team.dbSlug})`);
    await db
      .insert(nhlTeams)
      .values(team)
      .onDuplicateKeyUpdate({
        set: {
          nhlSlug: team.nhlSlug,
          vsinSlug: team.vsinSlug,
          name: team.name,
          nickname: team.nickname,
          city: team.city,
          conference: team.conference,
          division: team.division,
          logoUrl: team.logoUrl,
          abbrev: team.abbrev,
          primaryColor: team.primaryColor,
          secondaryColor: team.secondaryColor,
          tertiaryColor: team.tertiaryColor,
        },
      });
    upserted++;
  }
  console.log(`[upsertNhlTeams] Done. Upserted: ${upserted}`);
  return upserted;
}

/** Returns all 32 NHL teams ordered by conference, division, then name. */
export async function getNhlTeams() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(nhlTeams).orderBy(nhlTeams.conference, nhlTeams.division, nhlTeams.name);
}

/** Lookup a single NHL team by its dbSlug. Returns null if not found. */
export async function getNhlTeamByDbSlug(dbSlug: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(nhlTeams)
    .where(eq(nhlTeams.dbSlug, dbSlug))
    .limit(1);
  return rows[0] ?? null;
}

/** Lookup a single NHL team by its abbreviation (e.g. "BUF"). Returns null if not found. */
export async function getNhlTeamByAbbrev(abbrev: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(nhlTeams)
    .where(eq(nhlTeams.abbrev, abbrev))
    .limit(1);
  return rows[0] ?? null;
}

// ─── User Favorite Games ─────────────────────────────────────────────────────

/** Returns favorite game IDs + their game dates (for 11:00 UTC expiry logic on the client). */
export async function getFavoriteGamesWithDates(appUserId: number): Promise<{ gameId: number; gameDate: string }[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ gameId: userFavoriteGames.gameId, gameDate: games.gameDate })
    .from(userFavoriteGames)
    .innerJoin(games, eq(games.id, userFavoriteGames.gameId))
    .where(eq(userFavoriteGames.appUserId, appUserId));
   return rows.map((r: { gameId: number; gameDate: string | null }) => ({ gameId: r.gameId, gameDate: r.gameDate ?? '' }));
}
export async function getFavoriteGameIds(appUserId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ gameId: userFavoriteGames.gameId })
    .from(userFavoriteGames)
    .where(eq(userFavoriteGames.appUserId, appUserId));
  return rows.map((r: { gameId: number }) => r.gameId);
}

export async function toggleFavoriteGame(
  appUserId: number,
  gameId: number
): Promise<{ favorited: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const existing = await db
    .select({ id: userFavoriteGames.id })
    .from(userFavoriteGames)
    .where(and(eq(userFavoriteGames.appUserId, appUserId), eq(userFavoriteGames.gameId, gameId)))
    .limit(1);
  if (existing.length > 0) {
    await db
      .delete(userFavoriteGames)
      .where(and(eq(userFavoriteGames.appUserId, appUserId), eq(userFavoriteGames.gameId, gameId)));
    return { favorited: false };
  } else {
    await db.insert(userFavoriteGames).values({ appUserId, gameId });
    return { favorited: true };
  }
}

/**
 * Update Action Network open lines and DK NJ current lines for a single game.
 * All fields are optional — only provided fields are written.
 */
export async function updateAnOdds(
  id: number,
  data: {
    // Open lines (from AN HTML open column)
    openAwaySpread?: string | null;
    openAwaySpreadOdds?: string | null;
    openHomeSpread?: string | null;
    openHomeSpreadOdds?: string | null;
    openTotal?: string | null;
    openOverOdds?: string | null;
    openUnderOdds?: string | null;
    openAwayML?: string | null;
    openHomeML?: string | null;
    // DK NJ current lines — stored in primary book columns
    awayBookSpread?: string | null;
    awaySpreadOdds?: string | null;
    homeBookSpread?: string | null;
    homeSpreadOdds?: string | null;
    bookTotal?: string | null;
    overOdds?: string | null;
    underOdds?: string | null;
    awayML?: string | null;
    homeML?: string | null;
    // MLB run line dual-write — same values as awayBookSpread/homeBookSpread
    // For MLB, AN spread market IS the run line. Write to both column sets.
    awayRunLine?: string | null;
    homeRunLine?: string | null;
    awayRunLineOdds?: string | null;
    homeRunLineOdds?: string | null;
    /**
     * Computed odds source label for the primary book columns.
     * 'dk'   = all 3 DK NJ markets complete (spread+odds, total+odds, ML)
     * 'open' = using AN Opening line (DK not yet fully posted)
     * Never null, never partial.
     */
    oddsSource?: 'open' | 'dk' | null;
  }
): Promise<{ layer3Fired: boolean; gameId: number; gameDate: string | null }> {
  const db = await getDb();
  if (!db) return { layer3Fired: false, gameId: id, gameDate: null };
  let _layer3Fired = false;
  let _layer3GameDate: string | null = null;
  const updateData: Record<string, unknown> = {};
  // Open lines
  if (data.openAwaySpread !== undefined) updateData.openAwaySpread = data.openAwaySpread;
  if (data.openAwaySpreadOdds !== undefined) updateData.openAwaySpreadOdds = data.openAwaySpreadOdds;
  if (data.openHomeSpread !== undefined) updateData.openHomeSpread = data.openHomeSpread;
  if (data.openHomeSpreadOdds !== undefined) updateData.openHomeSpreadOdds = data.openHomeSpreadOdds;
  if (data.openTotal !== undefined) updateData.openTotal = data.openTotal;
  if (data.openOverOdds !== undefined) updateData.openOverOdds = data.openOverOdds;
  if (data.openUnderOdds !== undefined) updateData.openUnderOdds = data.openUnderOdds;
  if (data.openAwayML !== undefined) updateData.openAwayML = data.openAwayML;
  if (data.openHomeML !== undefined) updateData.openHomeML = data.openHomeML;
  // DK NJ current lines — stored in primary book columns
  // awayBookSpread/homeBookSpread/bookTotal are decimal columns — parse string to number
  const parseSpread = (s: string | null | undefined): number | null | undefined => {
    if (s === undefined) return undefined;
    if (s === null) return null;
    const n = parseFloat(s); // parseFloat handles "+6.5" and "-6.5" correctly
    return isNaN(n) ? null : n;
  };
  if (data.awayBookSpread !== undefined) updateData.awayBookSpread = parseSpread(data.awayBookSpread);
  if (data.awaySpreadOdds !== undefined) updateData.awaySpreadOdds = data.awaySpreadOdds;
  if (data.homeBookSpread !== undefined) updateData.homeBookSpread = parseSpread(data.homeBookSpread);
  if (data.homeSpreadOdds !== undefined) updateData.homeSpreadOdds = data.homeSpreadOdds;
  if (data.bookTotal !== undefined) {
    const parsedTotal = parseSpread(data.bookTotal);
    updateData.bookTotal = parsedTotal;
    // CRITICAL: modelTotal must always mirror bookTotal (same line, model odds only).
    // Whenever bookTotal changes via AN API refresh (updateAnOdds), modelTotal must stay in sync.
    // This prevents the feed from showing mismatched book/model lines after odds refresh.
    // Only sync if the new bookTotal is a valid non-null number.
    if (parsedTotal !== null && parsedTotal !== undefined && !isNaN(parsedTotal)) {
      updateData.modelTotal = String(parsedTotal);
    }
  }
  if (data.overOdds !== undefined) updateData.overOdds = data.overOdds;
  if (data.underOdds !== undefined) updateData.underOdds = data.underOdds;
  if (data.awayML !== undefined) updateData.awayML = data.awayML;
  if (data.homeML !== undefined) updateData.homeML = data.homeML;
  // MLB run line dual-write
  if (data.awayRunLine !== undefined) updateData.awayRunLine = data.awayRunLine;
  if (data.homeRunLine !== undefined) updateData.homeRunLine = data.homeRunLine;
  if (data.awayRunLineOdds !== undefined) updateData.awayRunLineOdds = data.awayRunLineOdds;
  if (data.homeRunLineOdds !== undefined) updateData.homeRunLineOdds = data.homeRunLineOdds;
  if (data.oddsSource !== undefined) updateData.oddsSource = data.oddsSource;

  // ── MLB RL BOOK SPREAD SYNC GUARD (Fix 3) ─────────────────────────────────────────────
  // INVARIANT: awayBookSpread and awayRunLine MUST have the same sign for MLB (±1.5).
  // awayRunLine is the authoritative book field (set by DK/VSiN scraper).
  // awayBookSpread is the decimal column used by GameCard for display and sign enforcement.
  // ROOT CAUSE OF TB@TOR 2026-05-11 INVERSION: awayBookSpread=-1.5 but awayRunLine=+1.5.
  //   → Model ran with correct rl_home_spread (from awayRunLine) but displayed wrong label
  //     (from awayBookSpread), producing impossible P(cover -1.5) > P(win) on display.
  // CORRECTION: when both are being written in the same call and signs differ, correct
  //   awayBookSpread to match awayRunLine (authoritative source).
  {
    const incomingAwayRL = data.awayRunLine !== undefined ? parseFloat(data.awayRunLine ?? '') : NaN;
    const incomingAwayBS = updateData.awayBookSpread !== undefined ? Number(updateData.awayBookSpread) : NaN;
    if (!isNaN(incomingAwayRL) && !isNaN(incomingAwayBS) && incomingAwayRL !== 0 && incomingAwayBS !== 0) {
      if (Math.sign(incomingAwayRL) !== Math.sign(incomingAwayBS)) {
        // Sign mismatch: awayRunLine is authoritative — correct awayBookSpread to match
        const correctedBS = incomingAwayRL;  // awayBookSpread = awayRunLine (same value)
        const correctedHomeBS = -incomingAwayRL;
        console.error(
          `[updateAnOdds][RL BOOK SPREAD SYNC] id=${id} — awayRunLine=${data.awayRunLine} but awayBookSpread=${data.awayBookSpread}. ` +
          `SIGN MISMATCH (root cause of RL display inversion). ` +
          `Correcting awayBookSpread=${correctedBS} homeBookSpread=${correctedHomeBS} to match awayRunLine.`
        );
        updateData.awayBookSpread = correctedBS;
        if (data.homeBookSpread !== undefined) updateData.homeBookSpread = correctedHomeBS;
      }
    }
  }

  // ── MLB RL SIGN SYNC (Layer 2 guard) ─────────────────────────────────────────────────────────
  // ── LAYER 3: ML-direction cross-check in updateAnOdds ─────────────────────
  // PRIMARY: When awayML is being written, cross-check against existing
  // awayModelSpread. If ML direction contradicts model spread direction,
  // the model ran with wrong rl_home_spread — clear modelRunAt to force re-run.
  // SECONDARY: When awayBookSpread changes, also check awayModelSpread sign.
  // Both checks write corrected awayModelSpread/homeModelSpread as self-heal.
  if (data.awayML !== undefined && data.awayML !== null) {
    const newAwayML = parseFloat(String(data.awayML));
    if (!isNaN(newAwayML)) {
      const currentRow = await db
        .select({
          awayModelSpread: games.awayModelSpread,
          homeModelSpread: games.homeModelSpread,
          sport: games.sport,
          modelRunAt: games.modelRunAt,
        })
        .from(games)
        .where(eq(games.id, id))
        .limit(1);
      const row = currentRow[0];
      if (row?.sport === 'MLB' && row.awayModelSpread != null && row.modelRunAt != null) {
        const currentModelAway = parseFloat(String(row.awayModelSpread));
        if (!isNaN(currentModelAway) && currentModelAway !== 0) {
          // ML fav = negative odds. RL fav = negative spread (-1.5).
          // If awayML < 0, away is ML fav → away should have -1.5 (negative model spread).
          // If awayML > 0, home is ML fav → away should have +1.5 (positive model spread).
          const mlSaysAwayIsFav  = newAwayML < 0;
          const mdlSaysAwayIsFav = currentModelAway < 0;
          if (mlSaysAwayIsFav !== mdlSaysAwayIsFav) {
            // ML direction contradicts model spread direction — model ran with wrong RL sign.
            // Clear modelRunAt to force model re-run with correct ML-aligned rl_home_spread.
            updateData.modelRunAt = null;
            // Signal to caller that LAYER3 fired — caller will trigger immediate re-run.
            _layer3Fired = true;
            // Capture gameDate for immediate re-run trigger at call site (non-fatal if fails)
            try {
              const dateRow = await db.select({ gameDate: games.gameDate }).from(games).where(eq(games.id, id)).limit(1);
              _layer3GameDate = dateRow[0]?.gameDate ?? null;
            } catch { /* non-fatal — caller falls back to 5-min cycle */ }
            // Also flip awayModelSpread/homeModelSpread so display is correct immediately.
            const correctedAway = mlSaysAwayIsFav ? -Math.abs(currentModelAway) : Math.abs(currentModelAway);
            const correctedHome = -correctedAway;
            updateData.awayModelSpread = correctedAway >= 0 ? `+${correctedAway.toFixed(1)}` : `${correctedAway.toFixed(1)}`;
            updateData.homeModelSpread = correctedHome >= 0 ? `+${correctedHome.toFixed(1)}` : `${correctedHome.toFixed(1)}`;
            console.error(
              `[updateAnOdds][LAYER3_ML_GUARD] id=${id} — awayML=${newAwayML} contradicts awayModelSpread=${currentModelAway}. ` +
              `ML says away ${mlSaysAwayIsFav ? 'IS' : 'is NOT'} fav but model spread says away ${mdlSaysAwayIsFav ? 'IS' : 'is NOT'} fav. ` +
              `CLEARING modelRunAt + CORRECTING awayModelSpread=${updateData.awayModelSpread} homeModelSpread=${updateData.homeModelSpread} ` +
              `→ IMMEDIATE RE-RUN will be triggered by caller (gameDate=${_layer3GameDate ?? 'unknown'})`
            );
          }
        }
      }
    }
  }
  // SECONDARY: When awayBookSpread changes, check awayModelSpread sign (book-vs-model).
  if (data.awayBookSpread !== undefined && data.awayBookSpread !== null) {
    const newBookAway = parseFloat(data.awayBookSpread);
    if (!isNaN(newBookAway) && newBookAway !== 0) {
      // Fetch current awayModelSpread to check if sign correction is needed
      const currentRow = await db
        .select({ awayModelSpread: games.awayModelSpread, homeModelSpread: games.homeModelSpread, sport: games.sport })
        .from(games)
        .where(eq(games.id, id))
        .limit(1);
      const row = currentRow[0];
      if (row?.sport === 'MLB' && row.awayModelSpread != null) {
        const currentModelAway = parseFloat(String(row.awayModelSpread));
        if (!isNaN(currentModelAway) && currentModelAway !== 0) {
          const bookSign  = newBookAway >= 0 ? 1 : -1;
          const modelSign = currentModelAway >= 0 ? 1 : -1;
          if (bookSign !== modelSign) {
            // Signs are inverted — self-heal: flip awayModelSpread/homeModelSpread
            const correctedAway = bookSign > 0 ? Math.abs(currentModelAway) : -Math.abs(currentModelAway);
            const correctedHome = -correctedAway;
            updateData.awayModelSpread = correctedAway >= 0 ? `+${correctedAway.toFixed(1)}` : `${correctedAway.toFixed(1)}`;
            updateData.homeModelSpread = correctedHome >= 0 ? `+${correctedHome.toFixed(1)}` : `${correctedHome.toFixed(1)}`;
            console.error(
              `[updateAnOdds][RL SIGN SYNC] id=${id} — awayBookSpread=${newBookAway} but awayModelSpread=${currentModelAway} ` +
              `— CORRECTING: awayModelSpread=${updateData.awayModelSpread} homeModelSpread=${updateData.homeModelSpread}`
            );
          }
        }
      }
    }
  }

  if (Object.keys(updateData).length === 0) return { layer3Fired: _layer3Fired, gameId: id, gameDate: _layer3GameDate };
  await db.update(games).set(updateData).where(eq(games.id, id));
  return { layer3Fired: _layer3Fired, gameId: id, gameDate: _layer3GameDate };
}

// ─── Odds History helpers ─────────────────────────────────────────────────────

/** NCAAF book observations never run the other sports' model-total sync. */
export async function updateNcaafMarkets(input: {
  id: number; gameDate: string; eventId: string; awayTeam: string; homeTeam: string;
  kickoff: number; capturedAt: number; source: "auto" | "manual";
  snapshot: Omit<Parameters<typeof insertOddsHistory>[3], "lineSource">;
}): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("NCAAF market database unavailable");
  if (!Number.isSafeInteger(input.capturedAt) || input.capturedAt > Date.now() ||
      !Number.isFinite(input.kickoff)) throw new Error("Invalid NCAAF capture time");
  const changed = await db.transaction(async (tx: any) => {
    const [parent] = await tx.select().from(games).where(eq(games.id, input.id)).limit(1).for("update");
    if (!parent || parent.sport !== "NCAAF" || parent.gameDate !== input.gameDate ||
        parent.ncaaContestId !== input.eventId || parent.awayTeam !== input.awayTeam ||
        parent.homeTeam !== input.homeTeam) throw new Error("NCAAF parent identity changed");
    if (!parent.publishedToFeed || parent.gameStatus !== "upcoming" || Date.now() >= input.kickoff) return false;
    const [latest] = await tx.select().from(oddsHistory).where(eq(oddsHistory.gameId, input.id))
      .orderBy(desc(oddsHistory.scrapedAt), desc(oddsHistory.id)).limit(1);
    if (latest && Number(latest.scrapedAt) >= input.capturedAt) return false;
    const s = input.snapshot;
    const splits = {
      spreadAwayBetsPct: s.spreadAwayBetsPct ?? null, spreadAwayMoneyPct: s.spreadAwayMoneyPct ?? null,
      totalOverBetsPct: s.totalOverBetsPct ?? null, totalOverMoneyPct: s.totalOverMoneyPct ?? null,
      mlAwayBetsPct: s.mlAwayBetsPct ?? null, mlAwayMoneyPct: s.mlAwayMoneyPct ?? null,
    };
    await tx.update(games).set({
      awayBookSpread: s.awaySpread ?? null, homeBookSpread: s.homeSpread ?? null, bookTotal: s.total ?? null,
      awaySpreadOdds: s.awaySpreadOdds ?? null, homeSpreadOdds: s.homeSpreadOdds ?? null,
      overOdds: s.overOdds ?? null, underOdds: s.underOdds ?? null,
      awayML: s.awayML ?? null, homeML: s.homeML ?? null, ...splits, oddsSource: "dk",
      // Retrieval is not a provider-authored update or a model execution time.
      providerObservedAt: null, sourceUpdatedAt: null,
      ingestionReceivedAt: new Date(input.capturedAt), ingestionNormalizedAt: new Date(input.capturedAt),
      ingestionPersistedAt: new Date(),
      ingestionPipelineRevision: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
      ingestionRunId: `ncaaf-an68-vsin-dk:${input.capturedAt}:${input.eventId}`,
    }).where(eq(games.id, input.id));
    await tx.insert(oddsHistory).values({
      gameId: input.id, sport: "NCAAF", source: input.source, scrapedAt: input.capturedAt, lineSource: "dk",
      awaySpread: s.awaySpread ?? null, homeSpread: s.homeSpread ?? null, total: s.total ?? null,
      awaySpreadOdds: s.awaySpreadOdds ?? null, homeSpreadOdds: s.homeSpreadOdds ?? null,
      overOdds: s.overOdds ?? null, underOdds: s.underOdds ?? null,
      awayML: s.awayML ?? null, homeML: s.homeML ?? null, ...splits,
    });
    return true;
  });
  if (changed) invalidateGamesCache();
  return changed;
}

/**
 * Insert a snapshot of DK NJ current lines for a game into the odds_history table.
 * Called after every successful AN odds update (auto cron + manual refresh).
 *
 * @param gameId  - games.id FK
 * @param sport   - 'NBA' | 'NHL' | 'MLB'
 * @param source  - 'auto' (hourly cron) | 'manual' (Refresh Now button)
 * @param snap    - the current lines to snapshot (DK NJ, Opening, or mixed)
 */
export async function insertOddsHistory(
  gameId: number,
  sport: string,
  source: "auto" | "manual",
  snap: {
    // Lines (may be DK NJ, Opening line, or a mix)
    awaySpread?: string | null;
    awaySpreadOdds?: string | null;
    homeSpread?: string | null;
    homeSpreadOdds?: string | null;
    total?: string | null;
    overOdds?: string | null;
    underOdds?: string | null;
    awayML?: string | null;
    homeML?: string | null;
    // VSIN betting splits (null = not yet available)
    spreadAwayBetsPct?: number | null;
    spreadAwayMoneyPct?: number | null;
    totalOverBetsPct?: number | null;
    totalOverMoneyPct?: number | null;
    mlAwayBetsPct?: number | null;
    mlAwayMoneyPct?: number | null;
    /**
     * Odds line source label for this snapshot.
     * 'dk'   = all lines are from DK NJ current market (all 3 markets complete)
     * 'open' = all lines are from AN Opening line (DK not yet fully posted)
     * Never null, never partial.
     */
    lineSource?: 'open' | 'dk' | null;
  }
): Promise<void> {
  const db = await getDb();
  if (!db) {
    console.warn(`[OddsHistory][INSERT] SKIP gameId=${gameId} - DB not available`);
    return;
  }
  const now = Date.now();
  const estStr = new Date(now).toLocaleString("en-US", { timeZone: "America/New_York" });

  // [INPUT] Log every field being written so the snapshot is fully traceable
  const spreadPending = (snap.spreadAwayBetsPct == null || snap.spreadAwayBetsPct === 0) &&
                        (snap.spreadAwayMoneyPct == null || snap.spreadAwayMoneyPct === 0);
  const totalPending  = (snap.totalOverBetsPct == null || snap.totalOverBetsPct === 0) &&
                        (snap.totalOverMoneyPct == null || snap.totalOverMoneyPct === 0);
  const mlPending     = (snap.mlAwayBetsPct == null || snap.mlAwayBetsPct === 0) &&
                        (snap.mlAwayMoneyPct == null || snap.mlAwayMoneyPct === 0);
  debugLog("OddsHistory", "info",
    `[OddsHistory][INSERT][INPUT] gameId=${gameId} sport=${sport} source=${source} lineSource=${snap.lineSource ?? 'null'} scrapedAt=${estStr} EST | ` +
    `spread=${snap.awaySpread ?? 'null'}(${snap.awaySpreadOdds ?? 'null'}) ` +
    `total=${snap.total ?? 'null'} over=${snap.overOdds ?? 'null'} under=${snap.underOdds ?? 'null'} ` +
    `ml=${snap.awayML ?? 'null'}/${snap.homeML ?? 'null'} | ` +
    `splits: spread=${spreadPending ? 'PENDING' : `${snap.spreadAwayBetsPct}%T/${snap.spreadAwayMoneyPct}%M`} ` +
    `total=${totalPending ? 'PENDING' : `${snap.totalOverBetsPct}%T/${snap.totalOverMoneyPct}%M`} ` +
    `ml=${mlPending ? 'PENDING' : `${snap.mlAwayBetsPct}%T/${snap.mlAwayMoneyPct}%M`}`
  );

  try {
    await db.insert(oddsHistory).values({
      gameId,
      sport,
      scrapedAt: now,
      source,
      awaySpread: snap.awaySpread ?? null,
      awaySpreadOdds: snap.awaySpreadOdds ?? null,
      homeSpread: snap.homeSpread ?? null,
      homeSpreadOdds: snap.homeSpreadOdds ?? null,
      total: snap.total ?? null,
      overOdds: snap.overOdds ?? null,
      underOdds: snap.underOdds ?? null,
      awayML: snap.awayML ?? null,
      homeML: snap.homeML ?? null,
      // VSIN splits — only write if non-null (null = market not yet open)
      spreadAwayBetsPct: snap.spreadAwayBetsPct ?? null,
      spreadAwayMoneyPct: snap.spreadAwayMoneyPct ?? null,
      totalOverBetsPct: snap.totalOverBetsPct ?? null,
      totalOverMoneyPct: snap.totalOverMoneyPct ?? null,
      mlAwayBetsPct: snap.mlAwayBetsPct ?? null,
      mlAwayMoneyPct: snap.mlAwayMoneyPct ?? null,
      lineSource: snap.lineSource ?? null,
    });
    // [OUTPUT] Confirm successful write with full context
    debugLog("OddsHistory", "info",
      `[OddsHistory][INSERT][OUTPUT] OK gameId=${gameId} sport=${sport} source=${source} lineSource=${snap.lineSource ?? 'null'} at ${estStr} EST`
    );
  } catch (err) {
    // [VERIFY] FAIL - log full error with context for immediate diagnosis
    console.error(
      `[OddsHistory][INSERT][VERIFY] FAIL gameId=${gameId} sport=${sport} source=${source}:`,
      err
    );
  }
}

/**
 * List all odds history snapshots for a game, newest first.
 * Returns at most 200 rows to avoid unbounded result sets.
 */
export async function listOddsHistory(gameId: number): Promise<OddsHistoryRow[]> {
  const db = await getDb();
  if (!db) {
    console.warn(`[OddsHistory][LIST] SKIP gameId=${gameId} - DB not available`);
    return [];
  }
  // [INPUT] Log query intent
  debugLog("OddsHistory", "info", `[OddsHistory][LIST][INPUT] gameId=${gameId} - querying history (limit=200, newest first)`);
  try {
    const rows = await db
      .select()
      .from(oddsHistory)
      .where(eq(oddsHistory.gameId, gameId))
      .orderBy(desc(oddsHistory.scrapedAt))
      .limit(200);
    // [OUTPUT] Log result summary with timestamps for traceability
    const latest = rows[0];
    const oldest = rows[rows.length - 1];
    debugLog("OddsHistory", "info",
      `[OddsHistory][LIST][OUTPUT] gameId=${gameId} rows=${rows.length}` +
      (rows.length > 0
        ? ` | latest=${new Date(latest!.scrapedAt).toLocaleString('en-US', { timeZone: 'America/New_York' })} EST` +
          ` | oldest=${new Date(oldest!.scrapedAt).toLocaleString('en-US', { timeZone: 'America/New_York' })} EST`
        : ' | no snapshots yet')
    );
    return rows;
  } catch (err) {
    // [VERIFY] FAIL - log full error with context
    console.error(`[OddsHistory][LIST][VERIFY] FAIL gameId=${gameId}:`, err);
    return [];
  }
}

/**
 * Backfill lineSource for historical oddsHistory rows that have lineSource = NULL.
 * Uses the game's oddsSource field as the ground truth.
 * Runs once at server startup; no-ops if all rows already have lineSource populated.
 */
export async function backfillOddsHistoryLineSource(): Promise<void> {
  const db = await getDb();
  if (!db) {
    console.warn('[OddsHistory][BACKFILL] SKIP — DB not available');
    return;
  }
  try {
    // [STEP] Count rows needing backfill
    const nullRows = await db
      .select({ id: oddsHistory.id, gameId: oddsHistory.gameId })
      .from(oddsHistory)
      .where(isNull(oddsHistory.lineSource))
      .limit(5000);

    if (nullRows.length === 0) {
      console.log('[OddsHistory][BACKFILL] SKIP — all rows already have lineSource populated');
      return;
    }

    debugLog("OddsHistory", "info", `[OddsHistory][BACKFILL][INPUT] Found ${nullRows.length} rows with null lineSource — resolving via game.oddsSource`);

    // [STEP] Get unique gameIds from null rows
    const gameIds = Array.from(new Set(nullRows.map((r: { id: number; gameId: number }) => r.gameId)));

    // [STEP] Fetch oddsSource for all affected games in one query
    const gameOddsSources = await db
      .select({ id: games.id, oddsSource: games.oddsSource })
      .from(games)
      .where(sql`${games.id} IN (${sql.join(gameIds.map(id => sql`${id}`), sql`, `)})`);

    const sourceMap = new Map<number, 'open' | 'dk' | null>();
    for (const g of gameOddsSources) {
      sourceMap.set(g.id, g.oddsSource as 'open' | 'dk' | null);
    }

    // [STEP] Batch update: group rows by resolved lineSource
    let updated = 0;
    let skipped = 0;
    const dkIds: number[] = [];
    const openIds: number[] = [];

    for (const row of nullRows) {
      const src = sourceMap.get(row.gameId);
      if (src === 'dk') dkIds.push(row.id);
      else if (src === 'open') openIds.push(row.id);
      else skipped++;
    }

    // Batch update DK rows
    if (dkIds.length > 0) {
      await db
        .update(oddsHistory)
        .set({ lineSource: 'dk' })
        .where(sql`${oddsHistory.id} IN (${sql.join(dkIds.map(id => sql`${id}`), sql`, `)})`);
      updated += dkIds.length;
    }

    // Batch update OPEN rows
    if (openIds.length > 0) {
      await db
        .update(oddsHistory)
        .set({ lineSource: 'open' })
        .where(sql`${oddsHistory.id} IN (${sql.join(openIds.map(id => sql`${id}`), sql`, `)})`);
      updated += openIds.length;
    }

    debugLog("OddsHistory", "info",
      `[OddsHistory][BACKFILL][OUTPUT] COMPLETE — updated=${updated} skipped=${skipped} ` +
      `(dk=${dkIds.length} open=${openIds.length}) total_null_rows=${nullRows.length}`
    );
  } catch (err) {
    console.error('[OddsHistory][BACKFILL][VERIFY] FAIL:', err);
  }
}

// ─── March Madness Bracket ────────────────────────────────────────────────────

export interface BracketGameRow {
  id: number;
  awayTeam: string;
  homeTeam: string;
  gameDate: string;
  startTimeEst: string;
  gameStatus: string;
  awayScore: number | null;
  homeScore: number | null;
  bracketGameId: number;
  bracketRound: string;
  bracketRegion: string;
  bracketSlot: number;
  nextBracketGameId: number | null;
  nextBracketSlot: string | null;
  awayBookSpread: string | null;
  homeBookSpread: string | null;
  bookTotal: string | null;
  awayML: string | null;
  homeML: string | null;
  awayModelSpread: string | null;
  homeModelSpread: string | null;
  modelTotal: string | null;
  modelAwayWinPct: string | null;
  modelHomeWinPct: string | null;
  publishedToFeed: boolean;
  publishedModel: boolean;
}

/**
 * Fetch all March Madness tournament games that have bracket data assigned.
 * Returns every game from First Four through Championship (bracketGameId IS NOT NULL).
 */
export async function getBracketGames(): Promise<BracketGameRow[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    const rows = await db
      .select({
        id: games.id,
        awayTeam: games.awayTeam,
        homeTeam: games.homeTeam,
        gameDate: games.gameDate,
        startTimeEst: games.startTimeEst,
        gameStatus: games.gameStatus,
        awayScore: games.awayScore,
        homeScore: games.homeScore,
        bracketGameId: games.bracketGameId,
        bracketRound: games.bracketRound,
        bracketRegion: games.bracketRegion,
        bracketSlot: games.bracketSlot,
        nextBracketGameId: games.nextBracketGameId,
        nextBracketSlot: games.nextBracketSlot,
        awayBookSpread: games.awayBookSpread,
        homeBookSpread: games.homeBookSpread,
        bookTotal: games.bookTotal,
        awayML: games.awayML,
        homeML: games.homeML,
        awayModelSpread: games.awayModelSpread,
        homeModelSpread: games.homeModelSpread,
        modelTotal: games.modelTotal,
        modelAwayWinPct: games.modelAwayWinPct,
        modelHomeWinPct: games.modelHomeWinPct,
        publishedToFeed: games.publishedToFeed,
        publishedModel: games.publishedModel,
      })
      .from(games)
      .where(
        and(
          eq(games.sport, "NCAAM"),
          isNotNull(games.bracketGameId)
        )
      )
      .orderBy(games.bracketGameId);
    return rows as BracketGameRow[];
  } catch (err) {
    console.error("[Bracket] Failed to fetch bracket games:", err);
    return [];
  }
}

// ─── Bracket Advancement ─────────────────────────────────────────────────────
/**
 * When a bracket game goes FINAL, determine the winner and write them into
 * the awayTeam or homeTeam of the next-round game based on nextBracketSlot.
 *
 * nextBracketSlot="top"    → winner becomes awayTeam  of nextBracketGameId
 * nextBracketSlot="bottom" → winner becomes homeTeam  of nextBracketGameId
 *
 * This is idempotent: calling it multiple times on the same final game is safe.
 */
export async function advanceBracketWinner(gameId: number): Promise<string> {
  const db = await getDb();
  if (!db) return 'error';
  try {
    const rows = await db
      .select({
        awayTeam: games.awayTeam,
        homeTeam: games.homeTeam,
        awayScore: games.awayScore,
        homeScore: games.homeScore,
        gameStatus: games.gameStatus,
        nextBracketGameId: games.nextBracketGameId,
        nextBracketSlot: games.nextBracketSlot,
        bracketGameId: games.bracketGameId,
        bracketRound: games.bracketRound,
      })
      .from(games)
      .where(eq(games.id, gameId))
      .limit(1);

    if (!rows.length) {
      console.log('[BracketAdvance] SKIP: game id=' + String(gameId) + ' not found');
      return 'error';
    }

    const g = rows[0];
    if (g.gameStatus !== 'final') return 'not_final';
    if (!g.nextBracketGameId || !g.nextBracketSlot) {
      console.log('[BracketAdvance] NO_NEXT: bracketGame=' + String(g.bracketGameId) + ' round=' + String(g.bracketRound));
      return 'no_next_game';
    }
    if (g.awayScore === null || g.homeScore === null) {
      console.log('[BracketAdvance] SKIP: game id=' + String(gameId) + ' is final but scores are null');
      return 'skipped';
    }

    const winnerSlug = g.awayScore > g.homeScore ? g.awayTeam : g.homeTeam;
    const loserSlug  = g.awayScore > g.homeScore ? g.homeTeam : g.awayTeam;
    const winScore   = Math.max(g.awayScore, g.homeScore);
    const loseScore  = Math.min(g.awayScore, g.homeScore);

    console.log('[BracketAdvance] WINNER: ' + winnerSlug + ' (' + String(winScore) + ') def. ' + loserSlug + ' (' + String(loseScore) + ') -> bracketGame ' + String(g.nextBracketGameId) + ' slot=' + g.nextBracketSlot);

    const nextRows = await db
      .select({ id: games.id, awayTeam: games.awayTeam, homeTeam: games.homeTeam })
      .from(games)
      .where(
        and(
          eq(games.bracketGameId, g.nextBracketGameId),
          eq(games.sport, 'NCAAM')
        )
      )
      .limit(1);

    if (!nextRows.length) {
      console.warn('[BracketAdvance] MISSING_NEXT_GAME: bracketGameId=' + String(g.nextBracketGameId) + ' not found in DB');
      return 'no_next_game';
    }

    const nextGame = nextRows[0];
    const currentSlotValue = g.nextBracketSlot === 'top' ? nextGame.awayTeam : nextGame.homeTeam;
    if (currentSlotValue === winnerSlug) {
      console.log('[BracketAdvance] ALREADY_SET: bracketGame ' + String(g.nextBracketGameId) + ' slot=' + g.nextBracketSlot + ' already=' + winnerSlug);
      return 'skipped';
    }

    const updatePayload = g.nextBracketSlot === 'top'
      ? { awayTeam: winnerSlug }
      : { homeTeam: winnerSlug };

    await db.update(games).set(updatePayload).where(eq(games.id, nextGame.id));

    console.log('[BracketAdvance] ADVANCED: ' + winnerSlug + ' -> bracketGame ' + String(g.nextBracketGameId) + ' (db id=' + String(nextGame.id) + ') slot=' + g.nextBracketSlot + ' OK');
    return 'advanced';
  } catch (err) {
    console.error('[BracketAdvance] ERROR for game id=' + String(gameId) + ':', err);
    return 'error';
  }
}

/**
 * Audit all bracket games (legacy NCAAM) that are FINAL and ensure their winners
 * have been advanced to the next round. Safe to call repeatedly.
 */
export async function auditAndAdvanceAllBracketWinners(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  try {
    const finalGames = await db
      .select({ id: games.id, bracketGameId: games.bracketGameId, bracketRound: games.bracketRound })
      .from(games)
      .where(
        and(
          eq(games.sport, 'NCAAM'),
          eq(games.gameStatus, 'final'),
          isNotNull(games.bracketGameId),
          isNotNull(games.nextBracketGameId)
        )
      );

    console.log('[BracketAdvance] AUDIT: found ' + String(finalGames.length) + ' final bracket games to check');
    let advanced = 0;
    for (const g of finalGames) {
      const result = await advanceBracketWinner(g.id);
      if (result === 'advanced') advanced++;
    }
    console.log('[BracketAdvance] AUDIT COMPLETE: advanced ' + String(advanced) + ' winners');
    return advanced;
  } catch (err) {
    console.error('[BracketAdvance] AUDIT ERROR:', err);
    return 0;
  }
}

/**
 * Returns which sports have at least one game with live odds on today's UTC date
 * or tomorrow's UTC date. Used by the frontend to hide sport tabs with no upcoming games.
 */
export async function getActiveSports(forceRefresh?: boolean): Promise<{ NBA: boolean; NHL: boolean; MLB: boolean }> {
  // ─── Cache lookup ─────────────────────────────────────────────────────────────────
  if (!forceRefresh && _activeSportsCache.entry && _activeSportsCache.entry.expiresAt > Date.now()) {
    const { NBA, NHL, MLB } = _activeSportsCache.entry.data;
    _cacheCounters.activeSportsHit++;
    // [ActiveSportsCache][HIT] — silenced in hot path
    return _activeSportsCache.entry.data;
  }
  const db = await getDb();
  if (!db) return { NBA: false, NHL: false, MLB: false };
   // Apply the same 11:00 UTC gate used by the frontend todayUTC() function.
  // Before 11:00 UTC the feed still shows the previous day's slate, so
  // "today" for the purposes of active-sport detection is (UTC date - 1 day).
  const FEED_CUTOFF_UTC_HOUR = 11;
  const nowMs = Date.now();
  const nowUtcObj = new Date(nowMs);
  const isBeforeCutoff = nowUtcObj.getUTCHours() < FEED_CUTOFF_UTC_HOUR;
  const effectiveMs = isBeforeCutoff ? nowMs - 24 * 60 * 60 * 1000 : nowMs;
  const effectiveDate = new Date(effectiveMs);
  const todayUTC = [
    effectiveDate.getUTCFullYear(),
    String(effectiveDate.getUTCMonth() + 1).padStart(2, '0'),
    String(effectiveDate.getUTCDate()).padStart(2, '0'),
  ].join('-');
  const tomorrowDate = new Date(effectiveMs + 24 * 60 * 60 * 1000);
  const tomorrowUTC = [
    tomorrowDate.getUTCFullYear(),
    String(tomorrowDate.getUTCMonth() + 1).padStart(2, '0'),
    String(tomorrowDate.getUTCDate()).padStart(2, '0'),
  ].join('-');
  const dateFilter = or(eq(games.gameDate, todayUTC), eq(games.gameDate, tomorrowUTC))!;
  // MLB uses a 7-day window since the full season is pre-seeded
  const plusSevenDate = new Date(effectiveMs + 7 * 24 * 60 * 60 * 1000);
  const plusSevenUTC = plusSevenDate.toISOString().slice(0, 10);
  const mlbDateFilter = and(gte(games.gameDate, todayUTC), lte(games.gameDate, plusSevenUTC))!;

  // NBA, NHL: any game on today/tomorrow; MLB: any game in next 7 days
  const proRows = await db
    .select({ sport: games.sport })
    .from(games)
    .where(or(
      and(dateFilter, or(eq(games.sport, 'NBA'), eq(games.sport, 'NHL'))!),
      and(mlbDateFilter, eq(games.sport, 'MLB'))
    )!)
    .groupBy(games.sport);
  const proActive = new Set(proRows.map((r: { sport: string }) => r.sport));

  const result = {
    NBA: proActive.has('NBA'),
    NHL: proActive.has('NHL'),
    MLB: proActive.has('MLB'),
  };
  _cacheCounters.activeSportsMiss++;
  console.log(`[activeSports][MISS] todayUTC=${todayUTC} tomorrowUTC=${tomorrowUTC} NBA=${result.NBA} NHL=${result.NHL} MLB=${result.MLB} ttl=${ACTIVE_SPORTS_TTL_MS / 1000}s`);
  // ─── Cache write ─────────────────────────────────────────────────────────────────
  _activeSportsCache.entry = { data: result, expiresAt: Date.now() + ACTIVE_SPORTS_TTL_MS };
  return result;
}

// ─── MLB Lineups ──────────────────────────────────────────────────────────────

/**
 * Upsert a Rotowire lineup record for a given game.
 * Matches on gameId (unique). Updates all fields on duplicate.
 *
 * @param data - InsertMlbLineup row (gameId required)
 */
export async function upsertMlbLineup(data: InsertMlbLineup): Promise<void> {
  const db = await getDb();
  if (!db) {
    console.warn("[upsertMlbLineup] DB not available — skipping");
    return;
  }

  const tag = `[upsertMlbLineup][gameId=${data.gameId}]`;

  try {
    await db
      .insert(mlbLineups)
      .values(data)
      .onDuplicateKeyUpdate({
        set: {
          scrapedAt: data.scrapedAt,
          awayPitcherName: data.awayPitcherName ?? null,
          awayPitcherHand: data.awayPitcherHand ?? null,
          awayPitcherEra: data.awayPitcherEra ?? null,
          awayPitcherRotowireId: data.awayPitcherRotowireId ?? null,
          awayPitcherMlbamId: data.awayPitcherMlbamId ?? null,
          awayPitcherConfirmed: data.awayPitcherConfirmed ?? false,
          homePitcherName: data.homePitcherName ?? null,
          homePitcherHand: data.homePitcherHand ?? null,
          homePitcherEra: data.homePitcherEra ?? null,
          homePitcherRotowireId: data.homePitcherRotowireId ?? null,
          homePitcherMlbamId: data.homePitcherMlbamId ?? null,
          homePitcherConfirmed: data.homePitcherConfirmed ?? false,
          awayLineup: data.awayLineup ?? null,
          homeLineup: data.homeLineup ?? null,
          awayLineupConfirmed: data.awayLineupConfirmed ?? false,
          homeLineupConfirmed: data.homeLineupConfirmed ?? false,
          weatherIcon: data.weatherIcon ?? null,
          weatherTemp: data.weatherTemp ?? null,
          weatherWind: data.weatherWind ?? null,
          weatherPrecip: data.weatherPrecip ?? null,
          weatherDome: data.weatherDome ?? false,
          umpire: data.umpire ?? null,
          updatedAt: sql`NOW()`,
        },
      });

    console.log(
      `${tag} Upserted | ` +
      `awayP="${data.awayPitcherName ?? "TBD"}" (${data.awayPitcherHand ?? "?"}) | ` +
      `homeP="${data.homePitcherName ?? "TBD"}" (${data.homePitcherHand ?? "?"}) | ` +
      `awayLineup=${data.awayLineup ? JSON.parse(data.awayLineup).length : 0}/9 | ` +
      `homeLineup=${data.homeLineup ? JSON.parse(data.homeLineup).length : 0}/9 | ` +
      `weather=${data.weatherIcon ?? "none"} ${data.weatherTemp ?? ""} | ` +
      `umpire="${data.umpire ?? "none"}"`
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${tag} DB error: ${msg}`);
    throw err;
  }
}

/**
 * Fetch MLB lineup records for a list of game IDs.
 * Returns a map of gameId → MlbLineupRow for fast O(1) lookup in the frontend.
 *
 * @param gameIds - Array of game IDs to fetch lineups for
 */
export async function getMlbLineupsByGameIds(gameIds: number[]): Promise<Map<number, MlbLineupRow>> {
  const db = await getDb();
  const result = new Map<number, MlbLineupRow>();

  if (!db || gameIds.length === 0) return result;

  const tag = `[getMlbLineupsByGameIds][count=${gameIds.length}]`;

  try {
    const rows = await db
      .select()
      .from(mlbLineups)
      .where(
        gameIds.length === 1
          ? eq(mlbLineups.gameId, gameIds[0])
          : sql`${mlbLineups.gameId} IN (${sql.join(gameIds.map((id) => sql`${id}`), sql`, `)})`
      );

    for (const row of rows) {
      result.set(row.gameId, row as MlbLineupRow);
    }

    console.log(`${tag} Fetched ${result.size}/${gameIds.length} lineup records`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${tag} DB error: ${msg}`);
  }

  return result;
}

// ─── MLB Strikeout Props ──────────────────────────────────────────────────────

/**
 * Upsert a strikeout prop row for a pitcher.
 * Keyed on (gameId, side) — one row per pitcher per game.
 */
export async function upsertStrikeoutProp(row: InsertMlbStrikeoutProp): Promise<void> {
  const tag = "[DB][upsertStrikeoutProp]";
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  try {
    await db
      .insert(mlbStrikeoutProps)
      .values(row)
      .onDuplicateKeyUpdate({
        set: {
          pitcherName: sql`VALUES(pitcherName)`,
          pitcherHand: sql`VALUES(pitcherHand)`,
          retrosheetId: sql`VALUES(retrosheetId)`,
          mlbamId: sql`VALUES(mlbamId)`,
          kProj: sql`VALUES(kProj)`,
          kLine: sql`VALUES(kLine)`,
          kPer9: sql`VALUES(kPer9)`,
          kMedian: sql`VALUES(kMedian)`,
          kP5: sql`VALUES(kP5)`,
          kP95: sql`VALUES(kP95)`,
          bookLine: sql`VALUES(bookLine)`,
          bookOverOdds: sql`VALUES(bookOverOdds)`,
          bookUnderOdds: sql`VALUES(bookUnderOdds)`,
          pOver: sql`VALUES(pOver)`,
          pUnder: sql`VALUES(pUnder)`,
          modelOverOdds: sql`VALUES(modelOverOdds)`,
          modelUnderOdds: sql`VALUES(modelUnderOdds)`,
          edgeOver: sql`VALUES(edgeOver)`,
          edgeUnder: sql`VALUES(edgeUnder)`,
          verdict: sql`VALUES(verdict)`,
          bestEdge: sql`VALUES(bestEdge)`,
          bestSide: sql`VALUES(bestSide)`,
          bestMlStr: sql`VALUES(bestMlStr)`,
          signalBreakdown: sql`VALUES(signalBreakdown)`,
          matchupRows: sql`VALUES(matchupRows)`,
          distribution: sql`VALUES(distribution)`,
          inningBreakdown: sql`VALUES(inningBreakdown)`,
          modelRunAt: sql`VALUES(modelRunAt)`,
        },
      });
    console.log(`${tag} Upserted gameId=${row.gameId} side=${row.side} pitcher="${row.pitcherName}"`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${tag} DB error: ${msg}`);
    throw err;
  }
}

/**
 * Fetch all strikeout prop rows for a game (both pitchers).
 * Returns an array of 0–2 rows ordered by side (away first).
 */
export async function getStrikeoutPropsByGame(gameId: number): Promise<MlbStrikeoutPropRow[]> {
  const tag = "[DB][getStrikeoutPropsByGame]";
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  try {
    const rows = await db
      .select()
      .from(mlbStrikeoutProps)
      .where(eq(mlbStrikeoutProps.gameId, gameId))
      .orderBy(mlbStrikeoutProps.side); // 'away' < 'home' alphabetically
    console.log(`${tag} gameId=${gameId} → ${rows.length} rows`);
    return rows as MlbStrikeoutPropRow[];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${tag} DB error: ${msg}`);
    return [];
  }
}

/**
 * Fetch strikeout props for multiple games at once.
 * Returns a Map<gameId, MlbStrikeoutPropRow[]>.
 */
export async function getStrikeoutPropsByGames(gameIds: number[]): Promise<Map<number, MlbStrikeoutPropRow[]>> {
  const tag = "[DB][getStrikeoutPropsByGames]";
  const result = new Map<number, MlbStrikeoutPropRow[]>();
  if (gameIds.length === 0) return result;

  const db = await getDb();
  if (!db) throw new Error("Database not available");

  try {
    const rows = await db
      .select()
      .from(mlbStrikeoutProps)
      .where(
        gameIds.length === 1
          ? eq(mlbStrikeoutProps.gameId, gameIds[0])
          : sql`${mlbStrikeoutProps.gameId} IN (${sql.join(gameIds.map((id) => sql`${id}`), sql`, `)})`
      )
      .orderBy(mlbStrikeoutProps.side);

    for (const row of rows as MlbStrikeoutPropRow[]) {
      const arr = result.get(row.gameId) ?? [];
      arr.push(row);
      result.set(row.gameId, arr);
    }
    console.log(`${tag} Fetched props for ${result.size}/${gameIds.length} games`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${tag} DB error: ${msg}`);
  }

  return result;
}

// ─── MLB Environment Signal Helpers ──────────────────────────────────────────
// Fetch park factor, bullpen, and umpire data for game card detail display.

/**
 * Fetch park factor row for a home team abbreviation.
 * Returns null if no data exists yet (seeder hasn't run).
 */
export async function getMlbParkFactor(homeTeamAbbrev: string): Promise<MlbParkFactorRow | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const rows = await db
      .select()
      .from(mlbParkFactors)
      .where(eq(mlbParkFactors.teamAbbrev, homeTeamAbbrev))
      .limit(1);
    return (rows[0] as MlbParkFactorRow) ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch bullpen stats for a team abbreviation (current season).
 * Returns null if no data exists yet.
 */
export async function getMlbBullpenStats(teamAbbrev: string): Promise<MlbBullpenStatsRow | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const rows = await db
      .select()
      .from(mlbBullpenStats)
      .where(eq(mlbBullpenStats.teamAbbrev, teamAbbrev))
      .limit(1);
    return (rows[0] as MlbBullpenStatsRow) ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch umpire modifier row by umpire name (exact match first, then last-name partial).
 * Returns null if umpire not found in DB.
 */
export async function getMlbUmpireModifier(umpireName: string): Promise<MlbUmpireModifierRow | null> {
  if (!umpireName) return null;
  const db = await getDb();
  if (!db) return null;
  try {
    const exact = await db
      .select()
      .from(mlbUmpireModifiers)
      .where(eq(mlbUmpireModifiers.umpireName, umpireName))
      .limit(1);
    if (exact.length > 0) return (exact[0] as MlbUmpireModifierRow);
    const lastName = umpireName.split(' ').pop() ?? umpireName;
    const partial = await db
      .select()
      .from(mlbUmpireModifiers)
      .where(sql`LOWER(${mlbUmpireModifiers.umpireName}) LIKE LOWER(${`%${lastName}%`})`)
      .limit(1);
    return (partial[0] as MlbUmpireModifierRow) ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch all three environment signals for a single MLB game in one parallel call.
 */
export async function getMlbGameEnvSignals(params: {
  homeTeam: string;
  awayTeam: string;
  umpireName: string | null;
}): Promise<{
  parkFactor: MlbParkFactorRow | null;
  awayBullpen: MlbBullpenStatsRow | null;
  homeBullpen: MlbBullpenStatsRow | null;
  umpire: MlbUmpireModifierRow | null;
}> {
  const [parkFactor, awayBullpen, homeBullpen, umpire] = await Promise.all([
    getMlbParkFactor(params.homeTeam),
    getMlbBullpenStats(params.awayTeam),
    getMlbBullpenStats(params.homeTeam),
    params.umpireName ? getMlbUmpireModifier(params.umpireName) : Promise.resolve(null),
  ]);
  return { parkFactor, awayBullpen, homeBullpen, umpire };
}

// ─── MLB HR Props ─────────────────────────────────────────────────────────────

/**
 * Fetch HR prop rows for a single game.
 * Returns all player rows ordered by side (away first), then playerName.
 */
export async function getHrPropsByGame(gameId: number): Promise<MlbHrPropRow[]> {
  const tag = "[DB][getHrPropsByGame]";
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  try {
    const rows = await db
      .select()
      .from(mlbHrProps)
      .where(eq(mlbHrProps.gameId, gameId))
      .orderBy(mlbHrProps.side, mlbHrProps.playerName);
    console.log(`${tag} gameId=${gameId} → ${rows.length} rows`);
    return rows as MlbHrPropRow[];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${tag} DB error: ${msg}`);
    return [];
  }
}

/**
 * Fetch HR props for multiple games at once.
 * Returns a Map<gameId, MlbHrPropRow[]>.
 */
export async function getHrPropsByGames(gameIds: number[]): Promise<Map<number, MlbHrPropRow[]>> {
  const tag = "[DB][getHrPropsByGames]";
  const result = new Map<number, MlbHrPropRow[]>();
  if (gameIds.length === 0) return result;
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  try {
    const rows = await db
      .select()
      .from(mlbHrProps)
      .where(
        gameIds.length === 1
          ? eq(mlbHrProps.gameId, gameIds[0])
          : sql`${mlbHrProps.gameId} IN (${sql.join(gameIds.map((id) => sql`${id}`), sql`, `)})`
      )
      .orderBy(mlbHrProps.side, mlbHrProps.playerName);
    for (const row of rows as MlbHrPropRow[]) {
      const arr = result.get(row.gameId) ?? [];
      arr.push(row);
      result.set(row.gameId, arr);
    }
    console.log(`${tag} Fetched HR props for ${result.size}/${gameIds.length} games`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${tag} DB error: ${msg}`);
  }
  return result;
}

// ─── Security Events DB helpers ───────────────────────────────────────────────

/**
 * Reserved `eventType` values for the digest schedulers' restart-safety
 * sentinel (Task 4.10 / B2). NOT a real security event — a housekeeping
 * marker row (`ip: "system"`, `context: "YYYY-MM-DD"` of the day it fired)
 * that lets securityDigest.ts / weeklySecurityDigest.ts recover "did today's
 * digest already fire?" across a container restart with NO schema
 * migration: repo law requires schema changes to ride db-push.yml before
 * dependent code deploys, and this task must stay code-only, so a new
 * settings/kv table or column was not an option (none already exists — see
 * this task's report for the survey of `drizzle/schema.ts`).
 *
 * Both aggregation functions below EXCLUDE these event types so a marker
 * row can never inflate a reported event count — without that exclusion a
 * marker would quietly add up to 1 (daily) or 7 (weekly, one per day in a
 * 7-day window) to `security.events.counts` and this file's own digest
 * totals, exactly the kind of miscount this task exists to remove.
 */
export const DIGEST_MARKER_DAILY_EVENT_TYPE = "DIGEST_MARKER_DAILY";
export const DIGEST_MARKER_WEEKLY_EVENT_TYPE = "DIGEST_MARKER_WEEKLY";
const DIGEST_MARKER_EVENT_TYPES: string[] = [
  DIGEST_MARKER_DAILY_EVENT_TYPE,
  DIGEST_MARKER_WEEKLY_EVENT_TYPE,
];

/**
 * Insert one security event row.
 *
 * [INPUT]  event  — InsertSecurityEvent (eventType, ip, occurredAt required)
 * [STEP]   Validate required fields
 * [STEP]   Insert into security_events table
 * [OUTPUT] void — fire-and-forget, errors are logged but never thrown
 * [VERIFY] Log insert result with structured tag
 */
export async function insertSecurityEvent(event: InsertSecurityEvent): Promise<void> {
  const tag = "[DB][insertSecurityEvent]";
  const db = await getDb();
  if (!db) {
    console.warn(`${tag} DB not available — event not persisted | type=${logSafe(event.eventType)} ip=${logSafe(event.ip)}`);
    return;
  }
  try {
    await db.insert(securityEvents).values({
      eventType: event.eventType,
      // Every varchar column is clamped. Previously only userAgent was, so a
      // >256-char trpcPath raised ER_DATA_TOO_LONG and the row was LOST —
      // letting an attacker erase their own event with one long URL.
      ip: truncateForColumn(event.ip, SECURITY_EVENT_LIMITS.ip) ?? "unknown",
      blockedOrigin: truncateForColumn(
        event.blockedOrigin,
        SECURITY_EVENT_LIMITS.blockedOrigin
      ),
      trpcPath: truncateForColumn(
        event.trpcPath,
        SECURITY_EVENT_LIMITS.trpcPath
      ),
      httpMethod: truncateForColumn(
        event.httpMethod,
        SECURITY_EVENT_LIMITS.httpMethod
      ),
      userAgent: truncateForColumn(
        event.userAgent,
        SECURITY_EVENT_LIMITS.userAgent
      ),
      // context is text("context") — a MySQL TEXT column whose 65,535 limit
      // is in BYTES, not characters. It needs the byte-aware clamp, not the
      // varchar one used above.
      context: truncateForTextColumn(
        event.context,
        SECURITY_EVENT_LIMITS.context
      ),
      occurredAt: event.occurredAt,
    });
    console.log(
      `${tag} Inserted | type=${logSafe(event.eventType)} ip=${logSafe(event.ip)}` +
      ` path=${logSafe(event.trpcPath ?? "N/A")} origin=${logSafe(event.blockedOrigin ?? "N/A")}`
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${tag} Insert failed (non-critical) | type=${logSafe(event.eventType)} ip=${logSafe(event.ip)} | error="${logSafe(msg)}"`);
  }
}

/**
 * Hard ceiling on one security-event read.
 *
 * Was 500, which silently truncated the WEEKLY digest: it asks for
 * RAW_EVENT_FETCH_LIMIT = 2000 over a 7-day window, received at most the newest
 * 500, and logged "limit=2000" while analysing a quarter of that. A security
 * report that under-reports while claiming full scope is worse than no report.
 * Raised to cover the largest legitimate caller; anything above it is now
 * reported rather than silently clipped (see the two warnings below).
 */
export const MAX_SECURITY_EVENTS_FETCH = 2000;

/**
 * Fetch the most recent security events, newest first.
 *
 * [INPUT]  limit      — max rows to return (default 200, max MAX_SECURITY_EVENTS_FETCH)
 * [INPUT]  eventType  — optional filter: 'CSRF_BLOCK' | 'RATE_LIMIT' | 'AUTH_FAIL'
 * [INPUT]  sinceMs    — optional: only return events with occurredAt >= sinceMs
 * [OUTPUT] SecurityEventRow[]
 *
 * DIGEST MARKERS: rows of type DIGEST_MARKER_* are restart-safety sentinels
 * this module writes itself, not security events. They are excluded UNLESS the
 * caller explicitly asks for that eventType — which is exactly how the digests
 * look their own markers up, so those lookups keep working. Without this, the
 * sentinels surface in the owner-facing security console as if a marker were
 * an attack.
 */
export async function getSecurityEvents(opts: {
  limit?: number;
  eventType?: string;
  sinceMs?: number;
  /**
   * This read is an EXISTENCE PROBE, not a window survey — the caller wants to
   * know whether a matching row exists, and `limit` is the answer's shape, not
   * a ceiling it regrets. Suppresses the truncation warning only.
   *
   * Without it, a probe that asks for 1 row and receives 1 row satisfies
   * `rows.length === limit` and emits "older events in this window were
   * TRUNCATED ... a LOWER BOUND" at ERROR severity. That is false — nothing
   * was dropped — and it fired twice per digest run in production
   * (deployment ff472662, 2026-08-09T13:00:43Z). A security stream that cries
   * truncation on a successful lookup is the same lying-observability defect
   * this function was changed to remove.
   */
  existenceProbe?: boolean;
}): Promise<SecurityEventRow[]> {
  const tag = "[DB][getSecurityEvents]";
  const db = await getDb();
  if (!db) {
    console.warn(`${tag} DB not available — returning empty list`);
    return [];
  }
  const limit = Math.min(opts.limit ?? 200, MAX_SECURITY_EVENTS_FETCH);
  if (opts.limit !== undefined && opts.limit > MAX_SECURITY_EVENTS_FETCH) {
    // Never clip in silence — that is the defect this replaced.
    console.warn(
      `${tag} Requested limit=${opts.limit} exceeds MAX_SECURITY_EVENTS_FETCH=${MAX_SECURITY_EVENTS_FETCH} — CLIPPED. ` +
        `The caller's result is incomplete and any total derived from it is a LOWER BOUND.`
    );
  }
  try {
    const conditions = [];
    if (opts.eventType) conditions.push(eq(securityEvents.eventType, opts.eventType));
    else conditions.push(notInArray(securityEvents.eventType, DIGEST_MARKER_EVENT_TYPES));
    if (opts.sinceMs) conditions.push(gte(securityEvents.occurredAt, opts.sinceMs));

    const rows = await db
      .select()
      .from(securityEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(securityEvents.occurredAt))
      .limit(limit) as SecurityEventRow[];

    console.log(`${tag} Fetched ${rows.length} rows | limit=${limit} type=${opts.eventType ?? "ALL"}`);
    if (rows.length === limit && !opts.existenceProbe) {
      // Hit the ceiling exactly: newest-first ordering means older events in the
      // window were dropped. Callers summarising a time range must say so.
      // Existence probes are exempt — see `existenceProbe` above; for them a
      // full result is the successful answer, not evidence of loss.
      console.warn(
        `${tag} Result hit the limit (${limit}) — older events in this window were TRUNCATED. ` +
          `Counts derived from this read are a LOWER BOUND, not a total.`
      );
    }
    return rows;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${tag} Query failed | error="${msg}"`);
    return [];
  }
}

/**
 * Count security events grouped by eventType for the 24h rolling window.
 *
 * [INPUT]  sinceMs  — UTC ms lower bound (default: now - 24h)
 * [OUTPUT] { CSRF_BLOCK: number, RATE_LIMIT: number, AUTH_FAIL: number, total: number }
 */
export async function getSecurityEventCounts(sinceMs?: number): Promise<{
  CSRF_BLOCK: number;
  RATE_LIMIT: number;
  AUTH_FAIL: number;
  total: number;
}> {
  const tag = "[DB][getSecurityEventCounts]";
  const db = await getDb();
  const defaultResult = { CSRF_BLOCK: 0, RATE_LIMIT: 0, AUTH_FAIL: 0, total: 0 };
  if (!db) {
    console.warn(`${tag} DB not available — returning zero counts`);
    return defaultResult;
  }
  const since = sinceMs ?? (Date.now() - 24 * 60 * 60 * 1000);
  try {
    const rows = await db
      .select({
        eventType: securityEvents.eventType,
        count: sql<number>`COUNT(*)`,
      })
      .from(securityEvents)
      .where(and(
        gte(securityEvents.occurredAt, since),
        notInArray(securityEvents.eventType, DIGEST_MARKER_EVENT_TYPES),
      ))
      .groupBy(securityEvents.eventType) as { eventType: string; count: number }[];

    const result = { ...defaultResult };
    let total = 0;
    for (const row of rows) {
      const count = Number(row.count);
      total += count;
      if (row.eventType === "CSRF_BLOCK") result.CSRF_BLOCK = count;
      else if (row.eventType === "RATE_LIMIT") result.RATE_LIMIT = count;
      else if (row.eventType === "AUTH_FAIL") result.AUTH_FAIL = count;
    }
    result.total = total;
    console.log(`${tag} Counts since ${new Date(since).toISOString()} | ${JSON.stringify(result)}`);
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${tag} Query failed | error="${msg}"`);
    return defaultResult;
  }
}

/**
 * Count security events grouped by (eventType, context) for a rolling
 * window — Task 4.9 / A1.
 *
 * getSecurityEventCounts() above collapses all eight RATE_LIMIT `context`
 * (limitType) slugs — global, auth, trpc_auth, stripe_checkout,
 * waitlist_submit, public_feed, xff_canary, edge_origin_ingress_anomaly —
 * into one number, which is how a digest dominated by our own CI's
 * edge_origin_ingress_anomaly canary got reported as "Rate Limit Triggers:
 * 111 — often automated scraping or a brute-force attempt" with no way to
 * tell CI noise from a real attacker. This is the accurate, UNLIMITED
 * (unlike getSecurityEvents(), which is capped at 500 rows) aggregation the
 * daily/weekly digests bucket on to break that number apart.
 *
 * DIGEST_MARKER_* rows are excluded for the same reason as above — a
 * bookkeeping row must never show up as a "bucket" in the report.
 *
 * [INPUT]  sinceMs  — UTC ms lower bound (default: now - 24h)
 * [OUTPUT] Array<{ eventType, context, count }> — one row per observed
 *          (eventType, context) pair in the window; context is null for
 *          event types/rows that don't set it (e.g. most CSRF_BLOCK rows).
 */
export async function getSecurityEventCountsByBucket(
  sinceMs?: number
): Promise<Array<{ eventType: string; context: string | null; count: number }>> {
  const tag = "[DB][getSecurityEventCountsByBucket]";
  const db = await getDb();
  if (!db) {
    console.warn(`${tag} DB not available — returning empty buckets`);
    return [];
  }
  const since = sinceMs ?? (Date.now() - 24 * 60 * 60 * 1000);
  try {
    const rows = await db
      .select({
        eventType: securityEvents.eventType,
        context: securityEvents.context,
        count: sql<number>`COUNT(*)`,
      })
      .from(securityEvents)
      .where(and(
        gte(securityEvents.occurredAt, since),
        notInArray(securityEvents.eventType, DIGEST_MARKER_EVENT_TYPES),
      ))
      .groupBy(securityEvents.eventType, securityEvents.context) as {
        eventType: string;
        context: string | null;
        count: number;
      }[];

    const result = rows.map(r => ({
      eventType: r.eventType,
      context: r.context,
      count: Number(r.count),
    }));
    const total = result.reduce((s, r) => s + r.count, 0);
    console.log(
      `${tag} ${result.length} (eventType,context) buckets since ${new Date(since).toISOString()} | total=${total}`
    );
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${tag} Query failed | error="${msg}"`);
    return [];
  }
}

/**
 * Delete security events older than retentionDays (default 90).
 * Called by a scheduled cleanup job.
 *
 * [INPUT]  retentionDays  — rows older than this many days are deleted
 * [OUTPUT] number         — rows deleted
 */
export async function pruneSecurityEvents(retentionDays = 90): Promise<number> {
  const tag = "[DB][pruneSecurityEvents]";
  const db = await getDb();
  if (!db) {
    console.warn(`${tag} DB not available — prune skipped`);
    return 0;
  }
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  try {
    const result = await db
      .delete(securityEvents)
      .where(sql`${securityEvents.occurredAt} < ${cutoffMs}`);
    const [header] = result as unknown as [{ affectedRows?: number }];
    const deleted = header?.affectedRows ?? 0;
    console.log(`${tag} Pruned ${deleted} rows older than ${retentionDays} days (cutoff=${new Date(cutoffMs).toISOString()})`);
    return deleted;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${tag} Prune failed | error="${msg}"`);
    return 0;
  }
}

// ─── User Session Tracking (DAU / MAU / WAU / avg session duration) ──────────
// userSessions, UserSession, InsertUserSession — imported at top of file

// Idle threshold: sessions with no heartbeat for > 30 min are considered closed
const SESSION_IDLE_MS = 30 * 60 * 1000;

/**
 * Create a new session row on login.
 *
 * [INPUT]  userId    — app_users.id of the logging-in user
 * [OUTPUT] sessionId — id of the newly created row
 */
export async function createUserSession(userId: number): Promise<number | null> {
  const tag = "[DB][createUserSession]";
  const db = await getDb();
  if (!db) { console.warn(`${tag} DB not available — session not created`); return null; }
  const now = Date.now();
  try {
    const result = await db.insert(userSessions).values({
      userId,
      startedAt: now,
      lastHeartbeat: now,
    } satisfies InsertUserSession);
    const [header] = result as unknown as [{ insertId?: number }];
    const sessionId = header?.insertId ?? null;
    console.log(`${tag} [OUTPUT] Created session | userId=${userId} sessionId=${sessionId} startedAt=${new Date(now).toISOString()}`);
    return sessionId;
  } catch (err: unknown) {
    console.error(`${tag} Failed | userId=${userId} error=${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Update lastHeartbeat on the most recent open session for a user.
 * Called every 5 minutes by the frontend heartbeat ping.
 *
 * [INPUT]  userId — app_users.id
 * [OUTPUT] void
 */
export async function heartbeatUserSession(userId: number): Promise<void> {
  const tag = "[DB][heartbeatUserSession]";
  const db = await getDb();
  if (!db) { console.warn(`${tag} DB not available — heartbeat skipped`); return; }
  const now = Date.now();
  try {
    await db
      .update(userSessions)
      .set({ lastHeartbeat: now })
      .where(and(eq(userSessions.userId, userId), isNull(userSessions.endedAt)));
    console.log(`${tag} [OUTPUT] Heartbeat updated | userId=${userId} at=${new Date(now).toISOString()}`);
  } catch (err: unknown) {
    console.error(`${tag} Failed | userId=${userId} error=${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Close all open sessions for a user on logout.
 * Sets endedAt = now, durationMs = endedAt - startedAt.
 *
 * [INPUT]  userId — app_users.id
 * [OUTPUT] void
 */
export async function closeUserSessions(userId: number): Promise<void> {
  const tag = "[DB][closeUserSessions]";
  const db = await getDb();
  if (!db) { console.warn(`${tag} DB not available — sessions not closed`); return; }
  const now = Date.now();
  try {
    // Fetch open sessions — include lastHeartbeat to compute accurate active duration.
    // [STEP] durationMs = lastHeartbeat - startedAt (not now - startedAt).
    // Using lastHeartbeat prevents inflated durations when a session is closed long
    // after the user's last confirmed activity (e.g. force-logout, idle cleanup).
    const open = await db
      .select({ id: userSessions.id, startedAt: userSessions.startedAt, lastHeartbeat: userSessions.lastHeartbeat })
      .from(userSessions)
      .where(and(eq(userSessions.userId, userId), isNull(userSessions.endedAt)));
    for (const s of open) {
      // [STATE] activeEnd = lastHeartbeat if available, else now (first-session case)
      const activeEnd = s.lastHeartbeat ?? now;
      const dur = Math.max(0, activeEnd - s.startedAt);
      await db
        .update(userSessions)
        .set({ endedAt: now, durationMs: dur })
        .where(eq(userSessions.id, s.id));
      debugLog("STATE", "info", `${tag} [OUTPUT] Closed session | sessionId=${s.id} userId=${userId} durationMs=${dur} (${Math.round(dur/60000)} min) lastHeartbeat=${s.lastHeartbeat ? new Date(s.lastHeartbeat).toISOString() : 'null'}`);
    }
    if (open.length === 0) {
      debugLog("STATE", "info", `${tag} [STATE] No open sessions found for userId=${userId}`);
    }
  } catch (err: unknown) {
    console.error(`${tag} Failed | userId=${userId} error=${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Close idle sessions that have not received a heartbeat for > SESSION_IDLE_MS.
 * Called by a scheduled job every 30 minutes.
 *
 * [OUTPUT] number — rows closed
 */
export async function closeIdleSessions(): Promise<number> {
  const tag = "[DB][closeIdleSessions]";
  const db = await getDb();
  if (!db) { console.warn(`${tag} DB not available — idle cleanup skipped`); return 0; }
  const idleCutoff = Date.now() - SESSION_IDLE_MS;
  try {
    const idle = await db
      .select({ id: userSessions.id, startedAt: userSessions.startedAt, lastHeartbeat: userSessions.lastHeartbeat })
      .from(userSessions)
      .where(and(isNull(userSessions.endedAt), sql`${userSessions.lastHeartbeat} < ${idleCutoff}`));
    const now = Date.now();
    for (const s of idle) {
      // [STEP] Use lastHeartbeat as active-end to avoid inflated durations
      const activeEnd = s.lastHeartbeat ?? now;
      const dur = Math.max(0, activeEnd - s.startedAt);
      await db.update(userSessions).set({ endedAt: now, durationMs: dur }).where(eq(userSessions.id, s.id));
      console.log(`${tag} [STEP] Closed idle session | sessionId=${s.id} durationMs=${dur} (${Math.round(dur/60000)} min)`);
    }
    console.log(`${tag} [OUTPUT] Closed ${idle.length} idle sessions (idleCutoff=${new Date(idleCutoff).toISOString()})`);
    return idle.length;
  } catch (err: unknown) {
    console.error(`${tag} Failed | error=${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/**
 * Compute DAU / MAU / WAU and average session duration.
 *
 * DAU = distinct users with a session that started in the last 24 hours
 * WAU = distinct users with a session that started in the last 7 days
 * MAU = distinct users with a session that started in the last 30 days
 * avgSessionDurationMs = mean of all closed session durationMs values in the last 30 days
 *
 * [OUTPUT] { dau, wau, mau, avgSessionDurationMs }
 */
export async function getSessionMetrics(): Promise<{
  dau: MetricPoint;
  wau: MetricPoint;
  mau: MetricPoint;
  avgSessionDurationMs: MetricPoint;
  meta: { definitionVersion: string; timezone: string; refreshedAtUtc: number; activeUserDefinition: string };
}> {
  const tag = "[DB][getSessionMetrics]";
  const now = Date.now();
  const meta = {
    definitionVersion: METRIC_DEFINITION_VERSION,
    timezone: REPORTING_TIMEZONE,
    refreshedAtUtc: now,
    activeUserDefinition: ACTIVE_USER_DEFINITION_V1,
  };
  const db = await getDb();
  if (!db) {
    console.warn(`${tag} DB not available`);
    const p = dbUnavailablePoint();
    return { dau: p, wau: p, mau: p, avgSessionDurationMs: p, meta };
  }
  // Opportunistically finalize sessions abandoned past the idle cutoff (no cron
  // in this monolith) so their engaged durations get recorded before we
  // aggregate. Best-effort: a failure here must never break the read.
  await closeIdleSessions().catch(() => { /* non-fatal — metrics still compute */ });
  const DAY_MS = 24 * 60 * 60 * 1000;
  const since24h = now - DAY_MS;
  const since7d  = now - 7  * DAY_MS;
  const since30d = now - 30 * DAY_MS;
  // [STEP] Cap at 4 hours to exclude outlier rows created before the
  // lastHeartbeat-based duration fix (wall-clock instead of active time).
  const MAX_REALISTIC_SESSION_MS = 4 * 60 * 60 * 1000;
  // Eligible-user contract: exclude staff (owner/admin) from engagement metrics.
  const notStaff = and(ne(appUsersTable.role, "owner"), ne(appUsersTable.role, "admin"));
  try {
    // Active user = distinct ELIGIBLE user with a FOREGROUND (heartbeat-bearing)
    // session whose most-recent heartbeat lands in the rolling window. Windowing
    // on lastHeartbeat (not startedAt) counts genuine in-window activity, and the
    // join to app_users drops staff. This is engagement, not login-alone.
    const activeInWindow = async (since: number): Promise<number> => {
      const [row] = await db
        .select({ count: sql<number>`COUNT(DISTINCT ${userSessions.userId})` })
        .from(userSessions)
        .innerJoin(appUsersTable, eq(userSessions.userId, appUsersTable.id))
        .where(and(isNotNull(userSessions.lastHeartbeat), gte(userSessions.lastHeartbeat, since), notStaff));
      return Number(row?.count ?? 0);
    };
    const [dauC, wauC, mauC] = await Promise.all([
      activeInWindow(since24h),
      activeInWindow(since7d),
      activeInWindow(since30d),
    ]);
    // Have we EVER recorded an engaged (heartbeat-bearing) non-staff session? If
    // not, a windowed 0 is "not measured" (nothing instrumented), never a real 0.
    const [everRow] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(userSessions)
      .innerJoin(appUsersTable, eq(userSessions.userId, appUsersTable.id))
      .where(and(isNotNull(userSessions.lastHeartbeat), notStaff));
    const totalEngagedEver = Number(everRow?.count ?? 0);
    // Average engaged duration over valid closed non-staff sessions in last 30d.
    const [avgRow] = await db
      .select({ avg: sql<number>`AVG(${userSessions.durationMs})`, n: sql<number>`COUNT(*)` })
      .from(userSessions)
      .innerJoin(appUsersTable, eq(userSessions.userId, appUsersTable.id))
      .where(and(
        isNotNull(userSessions.durationMs),
        gte(userSessions.startedAt, since30d),
        sql`${userSessions.durationMs} <= ${MAX_REALISTIC_SESSION_MS}`,
        sql`${userSessions.durationMs} > 0`,
        notStaff,
      ));
    const closedCount = Number(avgRow?.n ?? 0);
    const avgMs = Number(avgRow?.avg ?? 0);
    const result = {
      dau: deriveActiveUserPoint(dauC, totalEngagedEver),
      wau: deriveActiveUserPoint(wauC, totalEngagedEver),
      mau: deriveActiveUserPoint(mauC, totalEngagedEver),
      avgSessionDurationMs: deriveAvgDurationPoint(avgMs, closedCount),
      meta,
    };
    console.log(`${tag} [OUTPUT] dauState=${result.dau.state} dau=${result.dau.value} engagedEver=${totalEngagedEver} closed=${closedCount}`);
    return result;
  } catch (err: unknown) {
    console.error(`${tag} Failed | error=${err instanceof Error ? err.message : String(err)}`);
    const p = unknownPoint("Session metric query failed — see server logs.");
    return { dau: p, wau: p, mau: p, avgSessionDurationMs: p, meta };
  }
}

/**
 * Compute a RECONCILED membership breakdown (never overlapping totals).
 *
 * Raw queries: payingActive = hasAccess && (expiry NULL OR expiry>now); this is
 * a SUPERSET of lifetime (hasAccess && expiry NULL). reconcileMembership() then
 * splits into mutually-exclusive buckets — lifetime + recurringPaid + noAccess =
 * totalMembers — plus a cross-cutting discordConnected that is NEVER summed in.
 *
 * Returns a `state` so the UI can render "Not measured" instead of a fabricated
 * 0 when the DB is unavailable or the query fails.
 * [OUTPUT] { totalMembers, lifetime, recurringPaid, noAccess, discordConnected, overlapNote, state, reason, meta }
 */
export async function getMemberMetrics(): Promise<
  MembershipBreakdown & { state: MetricState; reason: string | null; meta: { definitionVersion: string; timezone: string; refreshedAtUtc: number } }
> {
  const tag = "[DB][getMemberMetrics]";
  const now = Date.now();
  const meta = { definitionVersion: METRIC_DEFINITION_VERSION, timezone: REPORTING_TIMEZONE, refreshedAtUtc: now };
  const db = await getDb();
  if (!db) {
    console.warn(`${tag} DB not available`);
    const p = dbUnavailablePoint();
    return { ...reconcileMembership(0, 0, 0, 0), state: p.state, reason: p.reason, meta };
  }
  try {
    const [totalRow] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(appUsersTable);
    // payingActive ⊇ lifetime (both require hasAccess); reconcileMembership below
    // splits them into mutually-exclusive buckets so nothing double-counts.
    const [payingRow] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(appUsersTable)
      .where(and(
        eq(appUsersTable.hasAccess, true),
        or(isNull(appUsersTable.expiryDate), sql`${appUsersTable.expiryDate} > ${now}`)
      ));
    const [lifetimeRow] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(appUsersTable)
      .where(and(eq(appUsersTable.hasAccess, true), isNull(appUsersTable.expiryDate)));
    const [discordRow] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(appUsersTable)
      .where(isNotNull(appUsersTable.discordId));
    const breakdown = reconcileMembership(
      Number(totalRow?.count ?? 0),
      Number(payingRow?.count ?? 0),
      Number(lifetimeRow?.count ?? 0),
      Number(discordRow?.count ?? 0),
    );
    console.log(`${tag} [OUTPUT] total=${breakdown.totalMembers} lifetime=${breakdown.lifetime} recurring=${breakdown.recurringPaid} noAccess=${breakdown.noAccess} discord=${breakdown.discordConnected}`);
    return { ...breakdown, state: "ok", reason: null, meta };
  } catch (err: unknown) {
    console.error(`${tag} Failed | error=${err instanceof Error ? err.message : String(err)}`);
    const p = unknownPoint("Member metric query failed — see server logs.");
    return { ...reconcileMembership(0, 0, 0, 0), state: p.state, reason: p.reason, meta };
  }
}

/**
 * Compute session duration distribution histogram for the last 30 days.
 *
 * Buckets (all in ms, matching the frontend labels):
 *   under5m   = durationMs < 5 * 60 * 1000
 *   m5to30    = 5 min ≤ durationMs < 30 min
 *   m30to120  = 30 min ≤ durationMs < 120 min
 *   h2to4     = 2 h ≤ durationMs ≤ 4 h
 *
 * Only includes closed sessions (durationMs IS NOT NULL AND durationMs > 0)
 * capped at 4 h to exclude pre-fix outlier rows.
 *
 * [OUTPUT] { under5m, m5to30, m30to120, h2to4, total }
 */
export async function getDurationHistogram(): Promise<{
  under5m: number;
  m5to30: number;
  m30to120: number;
  h2to4: number;
  total: number;
  state: MetricState;
  reason: string | null;
}> {
  const tag = "[DB][getDurationHistogram]";
  const db = await getDb();
  const empty = { under5m: 0, m5to30: 0, m30to120: 0, h2to4: 0, total: 0 };
  if (!db) {
    console.warn(`${tag} DB not available`);
    const p = dbUnavailablePoint();
    return { ...empty, state: p.state, reason: p.reason };
  }

  const now = Date.now();
  const since30d = now - 30 * 24 * 60 * 60 * 1000;

  // Bucket boundaries in milliseconds
  const B_5M   =   5 * 60 * 1000;   //   5 minutes
  const B_30M  =  30 * 60 * 1000;   //  30 minutes
  const B_120M = 120 * 60 * 1000;   // 120 minutes (2 hours)
  const B_4H   = 240 * 60 * 1000;   // 240 minutes (4 hours) — cap

  // Exclude staff (owner/admin) so the distribution reflects real users only.
  const notStaff = and(ne(appUsersTable.role, "owner"), ne(appUsersTable.role, "admin"));

  try {
    // Fetch all qualifying non-staff session durations in last 30 days.
    // Application-level bucketing (vs SQL CASE WHEN) keeps this portable across
    // MySQL / TiDB dialects and auditable.
    const rows = await db
      .select({ dur: userSessions.durationMs })
      .from(userSessions)
      .innerJoin(appUsersTable, eq(userSessions.userId, appUsersTable.id))
      .where(and(
        isNotNull(userSessions.durationMs),
        gte(userSessions.startedAt, since30d),
        sql`${userSessions.durationMs} > 0`,
        sql`${userSessions.durationMs} <= ${B_4H}`,
        notStaff,
      ));

    let under5m = 0, m5to30 = 0, m30to120 = 0, h2to4 = 0;

    for (const { dur } of rows) {
      const d = Number(dur ?? 0);
      if      (d < B_5M)   under5m++;
      else if (d < B_30M)  m5to30++;
      else if (d < B_120M) m30to120++;
      else                  h2to4++;
    }

    const total = under5m + m5to30 + m30to120 + h2to4;
    // Zero closed sessions ⇒ not measured (nothing to distribute), never a
    // fabricated all-zero chart.
    const point = total > 0
      ? okPoint(total)
      : notMeasured("No valid closed foreground sessions in the last 30 days — distribution cannot be measured.");
    console.log(`${tag} [OUTPUT] under5m=${under5m} m5to30=${m5to30} m30to120=${m30to120} h2to4=${h2to4} total=${total} state=${point.state}`);
    return { under5m, m5to30, m30to120, h2to4, total, state: point.state, reason: point.reason };
  } catch (err: unknown) {
    console.error(`${tag} Failed | error=${err instanceof Error ? err.message : String(err)}`);
    const p = unknownPoint("Session duration histogram query failed — see server logs.");
    return { ...empty, state: p.state, reason: p.reason };
  }
}

// ─── Stripe-specific lookup helpers ─────────────────────────────────────────

/**
 * Look up an app_user by their pending Stripe Checkout Session ID.
 * Used by the SubscribeSuccess page to find the account created by the webhook.
 */
export async function getAppUserByStripeSessionId(sessionId: string): Promise<AppUser | null> {
  const tag = "[DB][getAppUserByStripeSessionId]";
  const db = await getDb();
  if (!db) { console.warn(`${tag} DB not available`); return null; }
  try {
    const rows = await db.select().from(appUsers).where(eq(appUsers.pendingStripeSessionId, sessionId)).limit(1);
    const user = rows[0] ?? null;
    console.log(`${tag} [OUTPUT] sessionId=${sessionId} found=${user !== null}` + (user ? ` userId=${user.id} pendingSetup=${user.pendingSetup}` : ""));
    return user;
  } catch (err) {
    console.error(`${tag} [VERIFY] FAIL error=${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Look up an app_user by their Stripe Customer ID.
 *
 * Callers (notably the Stripe webhook's grant-access paths) must be able to
 * distinguish "no such customer" from "we couldn't ask the database" — a
 * silent `null` for both would let a DB outage look identical to a
 * legitimately-unknown customer, which the webhook is otherwise allowed to
 * ack with 200. So: infrastructure failure THROWS; only a successful query
 * with zero rows returns `null`.
 */
export async function getAppUserByStripeCustomerId(stripeCustomerId: string): Promise<AppUser | null> {
  const tag = "[DB][getAppUserByStripeCustomerId]";
  const db = await getDb();
  if (!db) {
    console.warn(`${tag} DB not available`);
    throw new Error(`${tag} database not available — cannot look up stripeCustomerId=${stripeCustomerId}`);
  }
  try {
    const rows = await db.select().from(appUsers).where(eq(appUsers.stripeCustomerId, stripeCustomerId)).limit(1);
    const user = rows[0] ?? null;
    console.log(`${tag} [OUTPUT] stripeCustomerId=${stripeCustomerId} found=${user !== null}` + (user ? ` userId=${user.id}` : ""));
    return user;
  } catch (err) {
    const causeMsg = err instanceof Error ? err.message : String(err);
    console.error(`${tag} [VERIFY] FAIL error=${causeMsg}`);
    throw new Error(`${tag} query failed for stripeCustomerId=${stripeCustomerId} | cause: ${causeMsg}`);
  }
}
