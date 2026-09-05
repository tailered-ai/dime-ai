/**
 * vsinAutoRefresh.ts
 *
 * Schedules a background job that runs every 30 minutes from 6am–midnight PST.
 *
 * On each tick it:
 *   1. Scrapes the VSiN NBA/NHL/MLB betting splits pages and upserts every game.
 *   2. Fetches NBA/NHL schedule for a rolling 7-day window and inserts any games
 *      not already in the DB (schedule-only games without VSiN odds).
 *
 * The last refresh result is stored in memory and exposed via
 * `trpc.games.lastRefresh` so the UI can show "Last updated HH:MM".
 */

import {
  listGamesByDate,
  updateBookOdds,
  insertGames,
  updateAnOdds,
  insertOddsHistory,
  getGameByNcaaContestId,
  updateNcaaStartTime,
} from "./db";
import { debugLog } from "./_core/debugLogger";
import { fetchActionNetworkOdds, type AnSport } from "./actionNetworkScraper";
import {
  scrapeVsinBettingSplits,
  scrapeVsinBettingSplitsBothDays,
  scrapeVsinMlbBettingSplits,
  scrapeVsinNbaBettingSplits,
  scrapeVsinNhlBettingSplits,
  type VsinSplitsGame,
} from "./vsinBettingSplitsScraper";
import {
  fetchNbaGamesForDate,
  buildNbaStartTimeMap,
  fetchNbaLiveScores,
} from "./nbaScoreboard";
import {
  fetchNhlGamesForRange,
  buildNhlStartTimeMap,
  buildNhlGameMap,
  fetchNhlLiveScores,
  type NhlScheduleGame,
} from "./nhlSchedule";
import {
  NBA_VALID_DB_SLUGS,
  NBA_BY_VSIN_SLUG,
  NBA_BY_AN_SLUG,
  getNbaTeamByVsinSlug,
  NBA_BY_DB_SLUG,
} from "../shared/nbaTeams";
import {
  NHL_VALID_DB_SLUGS,
  NHL_BY_ABBREV,
  NHL_BY_DB_SLUG,
  NHL_BY_VSIN_SLUG,
  NHL_BY_AN_SLUG,
  getNhlTeamByAnSlug,
  VSIN_NHL_HREF_ALIASES,
} from "../shared/nhlTeams";
import {
  MLB_BY_ABBREV,
  MLB_BY_VSIN_SLUG,
  MLB_VALID_ABBREVS,
  getMlbTeamByAnSlug,
  getMlbTeamByVsinSlug,
  VSIN_MLB_HREF_ALIASES,
} from "../shared/mlbTeams";
import type { InsertGame } from "../drizzle/schema";
import { refreshNcaafScoresNow } from "./ncaafScoreRefresh";

const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — all sports refresh cadence (24/7, no time gates)

// Rolling window: today through N days ahead
const RANGE_DAYS_AHEAD = 6; // fetch today + 6 more days = 7-day window

/**
 * Resolve a raw VSiN NHL href slug to an NhlTeam entry.
 * Applies VSIN_NHL_HREF_ALIASES FIRST (e.g. "ny-islanders" → "new-york-islanders")
 * before looking up in NHL_BY_VSIN_SLUG.
 *
 * This is the ONLY place NHL VSiN slug resolution should happen in this file.
 * Adding aliases to VSIN_NHL_HREF_ALIASES in shared/nhlTeams.ts is all that’s
 * ever needed to fix future VSiN slug mismatches.
 */
function resolveNhlVsinSlug(rawSlug: string) {
  const canonical = VSIN_NHL_HREF_ALIASES[rawSlug] ?? rawSlug;
  const team = NHL_BY_VSIN_SLUG.get(canonical);
  if (!team) {
    console.warn(
      `[VSiNAutoRefresh][NHL] resolveNhlVsinSlug: unknown slug "${rawSlug}"` +
        (canonical !== rawSlug
          ? ` (aliased from "${rawSlug}" → "${canonical}")`
          : "") +
        " — game will be skipped. Add to VSIN_NHL_HREF_ALIASES if this is a known alias."
    );
  } else if (canonical !== rawSlug) {
    console.log(
      `[VSiNAutoRefresh][NHL] resolveNhlVsinSlug: alias resolved "${rawSlug}" → "${canonical}" → dbSlug="${team.dbSlug}"`
    );
  }
  return team;
}

export interface RefreshResult {
  refreshedAt: string; // ISO timestamp of last VSiN odds/splits refresh
  scoresRefreshedAt: string; // ISO timestamp of last score refresh
  updated: number; // games matched + updated (VSiN)
  inserted: number; // new games inserted (VSiN stubs)
  nbaUpdated: number; // NBA games matched + updated (VSiN)
  nbaInserted: number; // new NBA games inserted (VSiN stubs)
  nbaScheduleInserted: number; // new NBA-only games inserted from schedule
  total: number; // total VSiN games processed
  nbaTotal: number; // total NBA VSiN games processed
  nhlUpdated: number; // NHL games matched + updated (VSiN)
  nhlInserted: number; // new NHL games inserted (VSiN stubs)
  nhlScheduleInserted: number; // new NHL-only games inserted from schedule
  nhlTotal: number; // total NHL VSiN games processed
  mlbUpdated: number; // MLB games matched + updated (VSiN)
  mlbInserted: number; // new MLB games inserted (VSiN stubs)
  mlbTotal: number; // total MLB VSiN games processed
  gameDate: string; // today YYYY-MM-DD (PST)
}

let lastRefreshResult: RefreshResult | null = null;
let lastScoresRefreshedAt: string = new Date().toISOString();

export function getLastRefreshResult(): RefreshResult | null {
  return lastRefreshResult;
}

/**
 * Returns true if two team slugs refer to the same team.
 * Uses the registry as the canonical source.
 */
function slugsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  // Check NBA registry for slug aliases
  const teamA = NBA_BY_DB_SLUG.get(na);
  const teamB = NBA_BY_DB_SLUG.get(nb);
  if (teamA && teamB) return teamA.dbSlug === teamB.dbSlug;
  return false;
}

/** Returns true if the current moment is inside 3am–midnight Pacific Time. */
function isWithinActiveHours(): boolean {
  // Active window: 14:01 UTC through 04:59 UTC next day (6:01 AM – 11:59 PM EST)
  // UTC hours 14–23 = 6 AM–5 PM EST (same day)
  // UTC hours 0–4   = 7 PM–11:59 PM EST (next UTC day, still same EST day)
  // Minute-level precision: starts at 14:01 UTC, ends at 04:59 UTC
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  // 14:01 UTC → utcHour=14, utcMinute>=1
  // 04:59 UTC → utcHour=4, utcMinute<=59
  const afterStart = utcHour > 14 || (utcHour === 14 && utcMinute >= 1);
  const beforeEnd = utcHour < 4 || (utcHour === 4 && utcMinute <= 59);
  return afterStart || beforeEnd;
}

/**
 * Returns true if the current wall-clock time is at or after 7:00 AM EST (12:00 UTC).
 * Used to gate same-day F5/NRFI and props scrapers that require FanDuel/AN markets
 * to be open. These markets do not post until the morning of game day.
 */
function isAfter7amEst(): boolean {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  // 7:00 AM EST = 12:00 UTC (EST is UTC-5)
  // 7:00 AM EDT = 11:00 UTC (EDT is UTC-4) — use 11:00 UTC as the safe lower bound
  // We use 12:00 UTC (noon UTC) as the gate — this is 7 AM EST / 8 AM EDT.
  // This ensures F5/NRFI/props never run before 7 AM EST regardless of DST.
  return utcHour >= 12;
}

/** Returns a date string as YYYY-MM-DD in Pacific Time. */
function datePst(offsetDays = 0): string {
  const now = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  const str = now.toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
  const [mm, dd, yyyy] = str.split("/");
  return `${yyyy}-${mm}-${dd}`;
}

/** Convert YYYYMMDD string to YYYY-MM-DD */
function yyyymmddToIso(s: string): string {
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** Generate all dates in a range [start, end] inclusive as YYYY-MM-DD strings */
function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const cur = new Date(start + "T00:00:00Z");
  const endDate = new Date(end + "T00:00:00Z");
  while (cur <= endDate) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, "0");
    const d = String(cur.getUTCDate()).padStart(2, "0");
    dates.push(`${y}-${m}-${d}`);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// VSiN is used for betting splits; AN API is used for DK NJ odds.

// ─── Tomorrow's VSiN splits pre-population ──────────────────────────────────

/**
 * Fetches tomorrow's VSiN betting splits and applies them to tomorrow's games.
 * This pre-populates splits for games that already exist in the DB for tomorrow.
 * Non-fatal — errors are caught and logged.
 */
async function runTomorrowSplitsUpdate(tomorrowStr: string): Promise<void> {
  try {
    const allSplits = await scrapeVsinBettingSplits("tomorrow");
    console.log(
      `[VSiNAutoRefresh][Tomorrow] ${allSplits.length} total splits games`
    );

    // Process NBA
    const nbaSplits = allSplits.filter(g => g.sport === "NBA");
    if (nbaSplits.length > 0) {
      const existingNba = await listGamesByDate(tomorrowStr, "NBA");
      let updated = 0;
      for (const g of nbaSplits) {
        const awayTeam = getNbaTeamByVsinSlug(g.awayVsinSlug);
        const homeTeam = getNbaTeamByVsinSlug(g.homeVsinSlug);
        if (!awayTeam || !homeTeam) continue;
        let dbGame = existingNba.find(
          e => e.awayTeam === awayTeam.dbSlug && e.homeTeam === homeTeam.dbSlug
        );
        let teamsSwapped = false;
        if (!dbGame) {
          dbGame = existingNba.find(
            e =>
              e.awayTeam === homeTeam.dbSlug && e.homeTeam === awayTeam.dbSlug
          );
          if (dbGame) teamsSwapped = true;
        }
        if (!dbGame) continue;
        const rawSpreadBets = teamsSwapped
          ? g.spreadAwayBetsPct != null
            ? 100 - g.spreadAwayBetsPct
            : null
          : g.spreadAwayBetsPct;
        const rawSpreadMoney = teamsSwapped
          ? g.spreadAwayMoneyPct != null
            ? 100 - g.spreadAwayMoneyPct
            : null
          : g.spreadAwayMoneyPct;
        // Skip spread splits when VSIN returns 0/0 — market not yet open
        const nbaSpreadAvailable = !(
          rawSpreadBets === 0 && rawSpreadMoney === 0
        );
        await updateBookOdds(dbGame.id, {
          ...(nbaSpreadAvailable
            ? {
                spreadAwayBetsPct: rawSpreadBets,
                spreadAwayMoneyPct: rawSpreadMoney,
              }
            : {}),
          totalOverBetsPct: g.totalOverBetsPct,
          totalOverMoneyPct: g.totalOverMoneyPct,
          mlAwayBetsPct: teamsSwapped
            ? g.mlAwayBetsPct != null
              ? 100 - g.mlAwayBetsPct
              : null
            : g.mlAwayBetsPct,
          mlAwayMoneyPct: teamsSwapped
            ? g.mlAwayMoneyPct != null
              ? 100 - g.mlAwayMoneyPct
              : null
            : g.mlAwayMoneyPct,
        });
        if (teamsSwapped)
          console.log(
            `[VSiNAutoRefresh][Tomorrow][NBA] Swapped teams for ${awayTeam.dbSlug}@${homeTeam.dbSlug} → matched DB ${dbGame.awayTeam}@${dbGame.homeTeam}`
          );
        if (!nbaSpreadAvailable)
          console.log(
            `[VSiNAutoRefresh][Tomorrow][NBA] SKIP_SPREAD_ZERO: ${dbGame.awayTeam}@${dbGame.homeTeam} — spread 0/0 not written`
          );
        updated++;
      }
      console.log(
        `[VSiNAutoRefresh][Tomorrow][NBA] ${updated} games updated with tomorrow's splits`
      );
    }

    // Process NHL
    const nhlSplits = allSplits.filter(g => g.sport === "NHL");
    if (nhlSplits.length > 0) {
      const existingNhl = await listGamesByDate(tomorrowStr, "NHL");
      let updated = 0;
      for (const g of nhlSplits) {
        const awayTeam = resolveNhlVsinSlug(g.awayVsinSlug);
        const homeTeam = resolveNhlVsinSlug(g.homeVsinSlug);
        if (!awayTeam || !homeTeam) continue;
        let dbGame = existingNhl.find(
          e => e.awayTeam === awayTeam.dbSlug && e.homeTeam === homeTeam.dbSlug
        );
        let teamsSwapped = false;
        if (!dbGame) {
          dbGame = existingNhl.find(
            e =>
              e.awayTeam === homeTeam.dbSlug && e.homeTeam === awayTeam.dbSlug
          );
          if (dbGame) teamsSwapped = true;
        }
        if (!dbGame) continue;
        const rawSpreadBetsNhl = teamsSwapped
          ? g.spreadAwayBetsPct != null
            ? 100 - g.spreadAwayBetsPct
            : null
          : g.spreadAwayBetsPct;
        const rawSpreadMoneyNhl = teamsSwapped
          ? g.spreadAwayMoneyPct != null
            ? 100 - g.spreadAwayMoneyPct
            : null
          : g.spreadAwayMoneyPct;
        // Skip spread splits when VSIN returns 0/0 — market not yet open
        const nhlSpreadAvailable = !(
          rawSpreadBetsNhl === 0 && rawSpreadMoneyNhl === 0
        );
        await updateBookOdds(dbGame.id, {
          ...(nhlSpreadAvailable
            ? {
                spreadAwayBetsPct: rawSpreadBetsNhl,
                spreadAwayMoneyPct: rawSpreadMoneyNhl,
              }
            : {}),
          totalOverBetsPct: g.totalOverBetsPct,
          totalOverMoneyPct: g.totalOverMoneyPct,
          mlAwayBetsPct: teamsSwapped
            ? g.mlAwayBetsPct != null
              ? 100 - g.mlAwayBetsPct
              : null
            : g.mlAwayBetsPct,
          mlAwayMoneyPct: teamsSwapped
            ? g.mlAwayMoneyPct != null
              ? 100 - g.mlAwayMoneyPct
              : null
            : g.mlAwayMoneyPct,
        });
        if (teamsSwapped)
          console.log(
            `[VSiNAutoRefresh][Tomorrow][NHL] Swapped teams for ${awayTeam.dbSlug}@${homeTeam.dbSlug} → matched DB ${dbGame.awayTeam}@${dbGame.homeTeam}`
          );
        if (!nhlSpreadAvailable)
          console.log(
            `[VSiNAutoRefresh][Tomorrow][NHL] SKIP_SPREAD_ZERO: ${dbGame.awayTeam}@${dbGame.homeTeam} — spread 0/0 not written`
          );
        updated++;
      }
      console.log(
        `[VSiNAutoRefresh][Tomorrow][NHL] ${updated} games updated with tomorrow's splits`
      );
    }

    // AN odds for tomorrow are ingested via ingestAnHtml tRPC procedure (paste AN HTML)
  } catch (err) {
    console.warn(
      "[VSiNAutoRefresh][Tomorrow] Tomorrow splits update failed (non-fatal):",
      err
    );
  }
}
// ─── NBA refresh ──────────────────────────────────────────────────────────────────────────────

async function refreshNba(
  todayStr: string,
  allDates: string[]
): Promise<{
  updated: number;
  inserted: number;
  scheduleInserted: number;
  total: number;
}> {
  console.log(
    `[refreshNba] ► START — today: ${todayStr} | dates: [${allDates.join(", ")}]`
  );
  // Scrape VSiN NBA betting splits (today only)
  let vsinSplits: VsinSplitsGame[] = [];
  try {
    // NBA: view=today and view=tomorrow both serve NBA on the combined page.
    // scrapeVsinNbaBettingSplits() uses ?source=DK&sport=NBA for reliability.
    vsinSplits = await scrapeVsinNbaBettingSplits();
    console.log(
      `[refreshNba] VSiN NBA splits fetched: ${vsinSplits.length} games (sport-specific URL, today+tomorrow merged)`
    );
  } catch (err) {
    console.warn(
      "[VSiNAutoRefresh] VSiN NBA splits scrape failed (non-fatal):",
      err
    );
  }

  // Build a map: dbSlug pair → VsinSplitsGame for fast lookup (both orderings)
  // Use getNbaTeamByVsinSlug() which applies alias resolution (e.g. "la-clippers" → "los-angeles-clippers")
  const vsinSplitsMap = new Map<
    string,
    { game: VsinSplitsGame; swapped: boolean }
  >();
  for (const g of vsinSplits) {
    const awayTeam = getNbaTeamByVsinSlug(g.awayVsinSlug);
    const homeTeam = getNbaTeamByVsinSlug(g.homeVsinSlug);
    if (awayTeam && homeTeam) {
      vsinSplitsMap.set(`${awayTeam.dbSlug}@${homeTeam.dbSlug}`, {
        game: g,
        swapped: false,
      });
      vsinSplitsMap.set(`${homeTeam.dbSlug}@${awayTeam.dbSlug}`, {
        game: g,
        swapped: true,
      });
    } else {
      console.log(
        `[VSiNAutoRefresh][NBA] Unknown VSiN slug: ${g.awayVsinSlug} @ ${g.homeVsinSlug}`
      );
    }
  }

  // Fetch NBA schedule start times for each date in the rolling window
  const nbaStartTimeMaps = new Map<string, Map<string, string>>();
  const nbaGamesByDate = new Map<
    string,
    Awaited<ReturnType<typeof fetchNbaGamesForDate>>
  >();

  for (const dateStr of allDates) {
    try {
      const nbaGames = await fetchNbaGamesForDate(dateStr);
      nbaStartTimeMaps.set(dateStr, buildNbaStartTimeMap(nbaGames));
      nbaGamesByDate.set(dateStr, nbaGames);
      if (nbaGames.length > 0) {
        console.log(
          `[VSiNAutoRefresh] NBA schedule: ${nbaGames.length} games for ${dateStr}`
        );
      }
    } catch (err) {
      console.warn(
        `[VSiNAutoRefresh] NBA schedule fetch failed for ${dateStr} (non-fatal):`,
        err
      );
    }
  }

  // Apply VSiN splits to today's existing NBA games
  let totalUpdated = 0;
  let spreadPopulated = 0; // freshness monitor: games with real spread splits
  let spreadPending = 0; // freshness monitor: games with 0/0 spread (market not open)
  let spreadUnmatched = 0; // freshness monitor: DB games not found in VSIN map
  const existingToday = await listGamesByDate(todayStr, "NBA");
  for (const dbGame of existingToday) {
    const key = `${dbGame.awayTeam}@${dbGame.homeTeam}`;
    const entry = vsinSplitsMap.get(key);
    if (!entry) {
      spreadUnmatched++;
      continue;
    }
    const { game: splits, swapped } = entry;
    const rawSpreadBets = swapped
      ? splits.spreadAwayBetsPct != null
        ? 100 - splits.spreadAwayBetsPct
        : null
      : splits.spreadAwayBetsPct;
    const rawSpreadMoney = swapped
      ? splits.spreadAwayMoneyPct != null
        ? 100 - splits.spreadAwayMoneyPct
        : null
      : splits.spreadAwayMoneyPct;
    if (rawSpreadBets === 0 && rawSpreadMoney === 0) {
      spreadPending++;
    } else if (rawSpreadBets != null) {
      spreadPopulated++;
    }
    await updateBookOdds(dbGame.id, {
      spreadAwayBetsPct: rawSpreadBets,
      spreadAwayMoneyPct: rawSpreadMoney,
      totalOverBetsPct: splits.totalOverBetsPct,
      totalOverMoneyPct: splits.totalOverMoneyPct,
      mlAwayBetsPct: swapped
        ? splits.mlAwayBetsPct != null
          ? 100 - splits.mlAwayBetsPct
          : null
        : splits.mlAwayBetsPct,
      mlAwayMoneyPct: swapped
        ? splits.mlAwayMoneyPct != null
          ? 100 - splits.mlAwayMoneyPct
          : null
        : splits.mlAwayMoneyPct,
    });
    totalUpdated++;
    if (swapped)
      console.log(
        `[VSiNAutoRefresh][NBA] Swapped splits for ${dbGame.awayTeam}@${dbGame.homeTeam}`
      );
    console.log(
      `[VSiNAutoRefresh][NBA] Splits updated: ${dbGame.awayTeam} @ ${dbGame.homeTeam} ` +
        `spread=${splits.spreadAwayBetsPct}%/${splits.spreadAwayMoneyPct}% ` +
        `total=${splits.totalOverBetsPct}%/${splits.totalOverMoneyPct}% ` +
        `ml=${splits.mlAwayBetsPct}%/${splits.mlAwayMoneyPct}%`
    );
  }

  // NBA schedule-only game insertion (rolling 7-day window)
  let scheduleInserted = 0;
  let totalInserted = 0;

  for (const dateStr of allDates) {
    if (dateStr < todayStr) continue;

    const nbaGames = nbaGamesByDate.get(dateStr) ?? [];
    if (nbaGames.length === 0) continue;

    const existing = await listGamesByDate(dateStr, "NBA");
    const startTimeMap = nbaStartTimeMaps.get(dateStr);

    for (const nbaGame of nbaGames) {
      const { awayDbSlug, homeDbSlug, startTimeEst, gameId } = nbaGame;

      const bySlug = existing.find(
        e => e.awayTeam === awayDbSlug && e.homeTeam === homeDbSlug
      );
      if (bySlug) {
        // Update start time if available
        if (startTimeEst && startTimeEst !== bySlug.startTimeEst) {
          await updateBookOdds(bySlug.id, { startTimeEst });
        }
        continue;
      }

      const byGameId = await getGameByNcaaContestId(gameId);
      if (byGameId) continue;

      const resolvedStartTime =
        startTimeMap?.get(`${awayDbSlug}@${homeDbSlug}`) ??
        startTimeEst ??
        "TBD";
      const row: InsertGame = {
        fileId: 0,
        gameDate: dateStr,
        startTimeEst: resolvedStartTime,
        awayTeam: awayDbSlug,
        homeTeam: homeDbSlug,
        awayBookSpread: null,
        homeBookSpread: null,
        bookTotal: null,
        awayModelSpread: null,
        homeModelSpread: null,
        modelTotal: null,
        spreadEdge: null,
        spreadDiff: null,
        totalEdge: null,
        totalDiff: null,
        sport: "NBA",
        gameType: "regular_season",
        conference: null,
        publishedToFeed: false,
        rotNums: null,
        sortOrder: 9999,
        ncaaContestId: gameId,
      };
      await insertGames([row]);
      scheduleInserted++;
      totalInserted++;
      console.log(
        `[VSiNAutoRefresh] Inserted NBA schedule-only: ${awayDbSlug} @ ${homeDbSlug} (${dateStr})`
      );
    }
  }

  console.log(
    `[refreshNba] ✅ DONE — updated=${totalUpdated} inserted=${totalInserted} scheduleInserted=${scheduleInserted} total=${vsinSplits.length}`
  );
  // ── Splits freshness health-check ──────────────────────────────────────────
  const spreadStatus =
    spreadPopulated > 0
      ? `${spreadPopulated}/${existingToday.length} spread_populated`
      : spreadPending > 0
        ? `0/${existingToday.length} spread_populated (${spreadPending} pending — market not yet open)`
        : `0/${existingToday.length} spread_populated`;
  console.log(
    `[refreshNba][SPLITS_HEALTH] today=${todayStr} | ${spreadStatus}` +
      ` | unmatched=${spreadUnmatched} | vsin_fetched=${vsinSplits.length}` +
      (spreadPopulated === 0 && vsinSplits.length > 0
        ? " ⚠️  WARN: VSIN has games but 0 spread splits written — check team slug mapping"
        : "")
  );
  return {
    updated: totalUpdated,
    inserted: totalInserted,
    scheduleInserted,
    total: vsinSplits.length,
  };
}

// ─── NHL Refresh ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────═

async function refreshNhl(
  todayStr: string,
  allDates: string[]
): Promise<{
  updated: number;
  inserted: number;
  scheduleInserted: number;
  total: number;
}> {
  console.log(
    `[refreshNhl] ► START — today: ${todayStr} | dates: [${allDates.join(", ")}]`
  );
  // Scrape VSiN NHL betting splits (today only)
  let vsinSplits: VsinSplitsGame[] = [];
  try {
    // NHL: view=today and view=tomorrow both serve NHL on the combined page.
    // scrapeVsinNhlBettingSplits() uses ?source=DK&sport=NHL for reliability.
    vsinSplits = await scrapeVsinNhlBettingSplits();
    console.log(
      `[refreshNhl] VSiN NHL splits fetched: ${vsinSplits.length} games (sport-specific URL, today+tomorrow merged)`
    );
  } catch (err) {
    console.warn(
      "[VSiNAutoRefresh] VSiN NHL splits scrape failed (non-fatal):",
      err
    );
  }

  // Build a map: dbSlug pair → VsinSplitsGame for fast lookup (both orderings)
  const vsinSplitsMap = new Map<
    string,
    { game: VsinSplitsGame; swapped: boolean }
  >();
  for (const g of vsinSplits) {
    const awayTeam = resolveNhlVsinSlug(g.awayVsinSlug);
    const homeTeam = resolveNhlVsinSlug(g.homeVsinSlug);
    if (awayTeam && homeTeam) {
      vsinSplitsMap.set(`${awayTeam.dbSlug}@${homeTeam.dbSlug}`, {
        game: g,
        swapped: false,
      });
      vsinSplitsMap.set(`${homeTeam.dbSlug}@${awayTeam.dbSlug}`, {
        game: g,
        swapped: true,
      });
      console.log(
        `[VSiNAutoRefresh][NHL] Mapped splits: ${awayTeam.dbSlug} @ ${homeTeam.dbSlug} (awayVsinSlug="${g.awayVsinSlug}" homeVsinSlug="${g.homeVsinSlug}")`
      );
    }
  }

  // Fetch NHL schedule for the rolling 7-day window
  const rangeEnd = allDates[allDates.length - 1];
  let nhlScheduleGames: NhlScheduleGame[] = [];
  try {
    nhlScheduleGames = await fetchNhlGamesForRange(todayStr, rangeEnd);
  } catch (err) {
    console.warn(
      "[VSiNAutoRefresh] NHL schedule fetch failed (non-fatal):",
      err
    );
    nhlScheduleGames = [];
  }

  // Build per-date start time maps from the schedule
  const nhlStartTimeMaps = new Map<string, Map<string, string>>();
  for (const dateStr of allDates) {
    const gamesOnDate = nhlScheduleGames.filter(g => g.gameDateEst === dateStr);
    nhlStartTimeMaps.set(dateStr, buildNhlStartTimeMap(gamesOnDate));
  }

  const nhlGamesByDate = new Map<string, typeof nhlScheduleGames>();
  for (const g of nhlScheduleGames) {
    const list = nhlGamesByDate.get(g.gameDateEst) ?? [];
    list.push(g);
    nhlGamesByDate.set(g.gameDateEst, list);
  }

  // Apply VSiN splits to today's existing NHL games
  let totalUpdated = 0;
  let spreadPopulated = 0; // freshness monitor: games with real puck line splits
  let spreadPending = 0; // freshness monitor: games with 0/0 puck line (market not open)
  let spreadUnmatched = 0; // freshness monitor: DB games not found in VSIN map
  const existingToday = await listGamesByDate(todayStr, "NHL");
  for (const dbGame of existingToday) {
    const key = `${dbGame.awayTeam}@${dbGame.homeTeam}`;
    const entry = vsinSplitsMap.get(key);
    if (!entry) {
      spreadUnmatched++;
      continue;
    }
    const { game: splits, swapped } = entry;
    const rawSpreadBets = swapped
      ? splits.spreadAwayBetsPct != null
        ? 100 - splits.spreadAwayBetsPct
        : null
      : splits.spreadAwayBetsPct;
    const rawSpreadMoney = swapped
      ? splits.spreadAwayMoneyPct != null
        ? 100 - splits.spreadAwayMoneyPct
        : null
      : splits.spreadAwayMoneyPct;
    if (rawSpreadBets === 0 && rawSpreadMoney === 0) {
      spreadPending++;
    } else if (rawSpreadBets != null) {
      spreadPopulated++;
    }
    await updateBookOdds(dbGame.id, {
      spreadAwayBetsPct: rawSpreadBets,
      spreadAwayMoneyPct: rawSpreadMoney,
      totalOverBetsPct: splits.totalOverBetsPct,
      totalOverMoneyPct: splits.totalOverMoneyPct,
      mlAwayBetsPct: swapped
        ? splits.mlAwayBetsPct != null
          ? 100 - splits.mlAwayBetsPct
          : null
        : splits.mlAwayBetsPct,
      mlAwayMoneyPct: swapped
        ? splits.mlAwayMoneyPct != null
          ? 100 - splits.mlAwayMoneyPct
          : null
        : splits.mlAwayMoneyPct,
    });
    totalUpdated++;
    if (swapped)
      console.log(
        `[VSiNAutoRefresh][NHL] Swapped splits for ${dbGame.awayTeam}@${dbGame.homeTeam}`
      );
    console.log(
      `[VSiNAutoRefresh][NHL] Splits updated: ${dbGame.awayTeam} @ ${dbGame.homeTeam} ` +
        `spread=${splits.spreadAwayBetsPct}%/${splits.spreadAwayMoneyPct}% ` +
        `total=${splits.totalOverBetsPct}%/${splits.totalOverMoneyPct}% ` +
        `ml=${splits.mlAwayBetsPct}%/${splits.mlAwayMoneyPct}%`
    );
  }

  // NHL schedule-only game insertion (rolling 7-day window)
  let scheduleInserted = 0;
  let totalInserted = 0;

  for (const dateStr of allDates) {
    if (dateStr < todayStr) continue;
    const nhlGames = nhlGamesByDate.get(dateStr) ?? [];
    if (nhlGames.length === 0) continue;
    const existing = await listGamesByDate(dateStr, "NHL");
    const startTimeMap = nhlStartTimeMaps.get(dateStr);

    for (const nhlGame of nhlGames) {
      const { awayDbSlug, homeDbSlug, startTimeEst, gameId } = nhlGame;

      const bySlug = existing.find(
        e => e.awayTeam === awayDbSlug && e.homeTeam === homeDbSlug
      );
      if (bySlug) {
        if (startTimeEst && startTimeEst !== bySlug.startTimeEst) {
          await updateBookOdds(bySlug.id, { startTimeEst });
        }
        continue;
      }

      const byGameId = await getGameByNcaaContestId(String(gameId));
      if (byGameId) continue;

      const resolvedStartTime =
        startTimeMap?.get(`${awayDbSlug}@${homeDbSlug}`) ??
        startTimeEst ??
        "TBD";
      const row: InsertGame = {
        fileId: 0,
        gameDate: dateStr,
        startTimeEst: resolvedStartTime,
        awayTeam: awayDbSlug,
        homeTeam: homeDbSlug,
        awayBookSpread: null,
        homeBookSpread: null,
        bookTotal: null,
        awayModelSpread: null,
        homeModelSpread: null,
        modelTotal: null,
        spreadEdge: null,
        spreadDiff: null,
        totalEdge: null,
        totalDiff: null,
        sport: "NHL",
        gameType: "regular_season",
        conference: null,
        publishedToFeed: false,
        rotNums: null,
        sortOrder: 9999,
        ncaaContestId: String(gameId),
      };
      await insertGames([row]);
      scheduleInserted++;
      totalInserted++;
      console.log(
        `[VSiNAutoRefresh] Inserted NHL schedule-only: ${awayDbSlug} @ ${homeDbSlug} (${dateStr})`
      );
    }
  }

  console.log(
    `[refreshNhl] ✅ DONE — updated=${totalUpdated} inserted=${totalInserted} scheduleInserted=${scheduleInserted} total=${vsinSplits.length}`
  );
  // ── Splits freshness health-check ──────────────────────────────────────────
  const nhlSpreadStatus =
    spreadPopulated > 0
      ? `${spreadPopulated}/${existingToday.length} puck_line_populated`
      : spreadPending > 0
        ? `0/${existingToday.length} puck_line_populated (${spreadPending} pending — market not yet open)`
        : `0/${existingToday.length} puck_line_populated`;
  console.log(
    `[refreshNhl][SPLITS_HEALTH] today=${todayStr} | ${nhlSpreadStatus}` +
      ` | unmatched=${spreadUnmatched} | vsin_fetched=${vsinSplits.length}` +
      (spreadPopulated === 0 && vsinSplits.length > 0
        ? " ⚠️  WARN: VSIN has games but 0 puck line splits written — check team slug mapping"
        : "")
  );
  return {
    updated: totalUpdated,
    inserted: totalInserted,
    scheduleInserted,
    total: vsinSplits.length,
  };
}

// ─── MLB refresh ─────────────────────────────────────────────────────────────

/**
 * Refreshes MLB betting splits from VSiN for today's games.
 *
 * MLB teams are stored in the DB as abbreviations ("NYY", "SF") — NOT dbSlugs.
 * VSiN uses single-word slugs ("yankees", "giants").
 * Matching chain: VSiN slug → getMlbTeamByVsinSlug() → abbrev → DB lookup.
 *
 * Returns { updated, total } — non-fatal, errors are logged.
 */
async function refreshMlb(todayStr: string): Promise<{
  updated: number;
  inserted: number; // always 0 — MLB schedule insertion is via MLB Stats API, not VSiN
  total: number;
}> {
  const tag = "[refreshMlb]";
  console.log(`${tag} ► START — today: ${todayStr}`);

  // ── Step 1: Scrape VSiN MLB betting splits (dedicated MLB page) ───────────
  // MLB uses a separate URL (data.vsin.com/mlb/betting-splits/) with different
  // column order: Moneyline(1-3) → Total(4-6) → Run Line(7-9).
  // The combined betting-splits page does NOT include MLB games.
  let vsinSplits: VsinSplitsGame[] = [];
  try {
    vsinSplits = await scrapeVsinMlbBettingSplits();
    console.log(
      `${tag} VSiN MLB splits fetched: ${vsinSplits.length} games from MLB-specific page`
    );
    if (vsinSplits.length === 0) {
      console.log(`${tag} No MLB games on VSiN today — splits update skipped`);
    } else {
      for (const g of vsinSplits) {
        console.log(
          `${tag} VSiN game: ${g.awayVsinSlug} @ ${g.homeVsinSlug} ` +
            `| spread: ${g.spreadAwayBetsPct}%/${g.spreadAwayMoneyPct}% ` +
            `| total: ${g.totalOverBetsPct}%/${g.totalOverMoneyPct}% ` +
            `| ml: ${g.mlAwayBetsPct}%/${g.mlAwayMoneyPct}%`
        );
      }
    }
  } catch (err) {
    console.warn(`${tag} VSiN MLB splits scrape failed (non-fatal):`, err);
  }

  // ── Step 2: Build date-aware VSiN slug → abbrev lookup maps ──────────────────────
  // MLB teams stored as abbreviations in DB; VSiN uses single-word slugs.
  // Both orderings stored so swapped home/away is handled transparently.
  //
  // CRITICAL BUG FIX: vsinSplits contains BOTH today's AND tomorrow's games.
  // The map key is ABBREV@ABBREV — not gameId. Many teams play BOTH today AND tomorrow
  // (e.g., BAL@NYY, TOR@MIN). Using a single map with .set() causes tomorrow's splits
  // to overwrite today's splits for the same matchup.
  //
  // FIX: Build TWO separate maps — one for today's splits, one for tomorrow's splits.
  // When applying to DB games, use the map that matches the DB game's date.
  // This ensures today's DB games always get today's VSIN splits, and tomorrow's DB
  // games always get tomorrow's VSIN splits.
  type SplitsEntry = { game: VsinSplitsGame; swapped: boolean };
  const todaySplitsMap = new Map<string, SplitsEntry>();
  const tomorrowSplitsMap = new Map<string, SplitsEntry>();

  // Compute tomorrowStr early so we can use it for map partitioning
  const tomorrowStr = (() => {
    const d = new Date(todayStr + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })();

  for (const g of vsinSplits) {
    const awayTeam = getMlbTeamByVsinSlug(g.awayVsinSlug);
    const homeTeam = getMlbTeamByVsinSlug(g.homeVsinSlug);
    if (awayTeam && homeTeam) {
      // Determine which date this VSIN game belongs to
      const gameDate =
        g.gameId.length >= 8
          ? `${g.gameId.slice(0, 4)}-${g.gameId.slice(4, 6)}-${g.gameId.slice(6, 8)}`
          : "unknown";
      const targetMap =
        gameDate === tomorrowStr ? tomorrowSplitsMap : todaySplitsMap;
      const normalKey = `${awayTeam.abbrev}@${homeTeam.abbrev}`;
      const swappedKey = `${homeTeam.abbrev}@${awayTeam.abbrev}`;
      if (!targetMap.has(normalKey)) {
        targetMap.set(normalKey, { game: g, swapped: false });
        targetMap.set(swappedKey, { game: g, swapped: true });
        console.log(
          `${tag} Mapped VSiN splits [${gameDate}]: ${awayTeam.abbrev} @ ${homeTeam.abbrev} ` +
            `(awaySlug="${g.awayVsinSlug}" homeSlug="${g.homeVsinSlug}")`
        );
      } else {
        console.log(
          `${tag} SKIP_DUPLICATE [${gameDate}]: ${awayTeam.abbrev} @ ${homeTeam.abbrev} — already mapped`
        );
      }
    } else {
      console.warn(
        `${tag} UNRESOLVED VSiN slug: "${g.awayVsinSlug}" @ "${g.homeVsinSlug}" ` +
          `— awayResolved=${!!awayTeam} homeResolved=${!!homeTeam} ` +
          `— add to VSIN_MLB_HREF_ALIASES if this is a known alias`
      );
    }
  }
  console.log(
    `${tag} Split maps: today=${todaySplitsMap.size / 2} games, tomorrow=${tomorrowSplitsMap.size / 2} games`
  );

  // Backward-compat alias: for today's DB games, fall back to tomorrowSplitsMap if not in todaySplitsMap
  // (handles edge case where a game is only on VSIN's tomorrow view but the DB has it as today)
  const getEntry = (
    key: string,
    dbGameDate: string
  ): SplitsEntry | undefined => {
    if (dbGameDate === tomorrowStr) {
      return tomorrowSplitsMap.get(key) ?? todaySplitsMap.get(key);
    }
    return todaySplitsMap.get(key) ?? tomorrowSplitsMap.get(key);
  };

  // -- Step 3: Apply VSiN splits to today + tomorrow's DB games --
  // VSiN's MLB page shows games for the next 1-2 days, so we query both
  // today and tomorrow to ensure we catch games on either side of midnight.
  let totalUpdated = 0;
  let rlPopulated = 0; // freshness monitor: today's games with real run-line splits
  let rlPending = 0; // freshness monitor: today's games with 0/0 RL (market not open)
  let rlUnmatched = 0; // freshness monitor: DB games not found in VSIN map
  // tomorrowStr already computed above for map partitioning
  const [todayGames, tomorrowGames] = await Promise.all([
    listGamesByDate(todayStr, "MLB"),
    listGamesByDate(tomorrowStr, "MLB"),
  ]);
  const existingToday = [...todayGames, ...tomorrowGames];
  console.log(
    `${tag} DB has ${todayGames.length} MLB games for ${todayStr}` +
      ` + ${tomorrowGames.length} games for ${tomorrowStr}` +
      ` = ${existingToday.length} total`
  );

  for (const dbGame of existingToday) {
    const key = `${dbGame.awayTeam}@${dbGame.homeTeam}`;
    const entry = getEntry(key, dbGame.gameDate);
    if (!entry) {
      console.log(
        `${tag} NO_VSIN_MATCH: ${dbGame.awayTeam} @ ${dbGame.homeTeam} ` +
          `(gameId=${dbGame.id} date=${dbGame.gameDate}) — not in VSiN splits`
      );
      rlUnmatched++;
      continue;
    }
    const { game: splits, swapped } = entry;

    // Flip away/home percentages when VSiN and DB have teams in opposite order
    const spreadAwayBetsPct = swapped
      ? splits.spreadAwayBetsPct != null
        ? 100 - splits.spreadAwayBetsPct
        : null
      : splits.spreadAwayBetsPct;
    const spreadAwayMoneyPct = swapped
      ? splits.spreadAwayMoneyPct != null
        ? 100 - splits.spreadAwayMoneyPct
        : null
      : splits.spreadAwayMoneyPct;
    const mlAwayBetsPct = swapped
      ? splits.mlAwayBetsPct != null
        ? 100 - splits.mlAwayBetsPct
        : null
      : splits.mlAwayBetsPct;
    const mlAwayMoneyPct = swapped
      ? splits.mlAwayMoneyPct != null
        ? 100 - splits.mlAwayMoneyPct
        : null
      : splits.mlAwayMoneyPct;

    // For MLB: VSiN's "spread" column is the run line.
    // Write to BOTH spreadAway* (generic display) AND rlAway* (dedicated MLB run line columns).
    //
    // GUARD: VSIN returns 0%/0% for run-line splits on tomorrow's games when the market
    // hasn't opened yet. Writing integer 0 to the DB causes the frontend to render a
    // misleading 100% home bar (home = 100 - 0 = 100). Skip run-line writes when both
    // bets AND money are 0 — treat as "not yet available" and preserve any existing DB value.
    const rlSplitsAvailable = !(
      spreadAwayBetsPct === 0 && spreadAwayMoneyPct === 0
    );
    // Track freshness for today's games only
    if (dbGame.gameDate === todayStr) {
      if (!rlSplitsAvailable) {
        rlPending++;
      } else if (spreadAwayBetsPct != null) {
        rlPopulated++;
      }
    }
    if (!rlSplitsAvailable) {
      console.log(
        `${tag} SKIP_RL_ZERO: ${dbGame.awayTeam} @ ${dbGame.homeTeam} (gameId=${dbGame.id}) ` +
          `— run-line splits are 0%/0% (market not yet open), preserving existing DB value`
      );
    }
    await updateBookOdds(dbGame.id, {
      // Only write run-line splits when VSIN has real non-zero data
      ...(rlSplitsAvailable
        ? {
            spreadAwayBetsPct, // generic spread column (used by GameCard display)
            spreadAwayMoneyPct,
            rlAwayBetsPct: spreadAwayBetsPct, // dedicated MLB run line column
            rlAwayMoneyPct: spreadAwayMoneyPct,
          }
        : {}),
      totalOverBetsPct: splits.totalOverBetsPct,
      totalOverMoneyPct: splits.totalOverMoneyPct,
      mlAwayBetsPct,
      mlAwayMoneyPct,
    });
    totalUpdated++;

    if (swapped) {
      console.log(
        `${tag} SWAPPED: VSiN has ${splits.awayVsinSlug}@${splits.homeVsinSlug} but DB has ${dbGame.awayTeam}@${dbGame.homeTeam} — flipped percentages`
      );
    }
    console.log(
      `${tag} Splits updated: ${dbGame.awayTeam} @ ${dbGame.homeTeam} ` +
        `(gameId=${dbGame.id}) ` +
        `| runLine: ${rlSplitsAvailable ? spreadAwayBetsPct + "%B/" + spreadAwayMoneyPct + "%H" : "SKIPPED(0/0)"} (→ rlAway* + spreadAway*)` +
        `| total: ${splits.totalOverBetsPct}%B/${splits.totalOverMoneyPct}%H` +
        `| ml: ${mlAwayBetsPct}%B/${mlAwayMoneyPct}%H`
    );
  }

  console.log(
    `${tag} ✅ DONE — splits_updated=${totalUpdated} db_games=${existingToday.length} vsin_games=${vsinSplits.length}`
  );
  // ── Splits freshness health-check ──────────────────────────────────────────
  const mlbRlStatus =
    rlPopulated > 0
      ? `${rlPopulated}/${todayGames.length} run_line_populated`
      : rlPending > 0
        ? `0/${todayGames.length} run_line_populated (${rlPending} pending — market not yet open)`
        : `0/${todayGames.length} run_line_populated`;
  console.log(
    `${tag}[SPLITS_HEALTH] today=${todayStr} | ${mlbRlStatus}` +
      ` | tomorrow_skipped=${rlPending} | unmatched=${rlUnmatched} | vsin_fetched=${vsinSplits.length}` +
      (rlPopulated === 0 && todayGames.length > 0 && vsinSplits.length > 0
        ? " ⚠️  WARN: VSIN has games but 0 run-line splits written for today — check team slug mapping"
        : "")
  );
  return { updated: totalUpdated, inserted: 0, total: vsinSplits.length };
}

// ─── AN API DK Odds Auto-Population ──────────────────────────────────────────

/**
 * Fetches DraftKings odds from the Action Network public API for a given date
 * and populates the awayBookSpread/homeBookSpread/bookTotal/ML columns for all
 * matched games in the DB. This replaces the manual HTML paste workflow for
 * current DK NJ lines.
 *
 * Matching strategy:
 *   - NBA:  awayUrlSlug / homeUrlSlug → NBA_BY_AN_SLUG (e.g. "portland-trail-blazers")
 *   - NHL:  awayUrlSlug / homeUrlSlug → NHL_BY_AN_SLUG (e.g. "boston-bruins")
 *   - NBA/NHL: awayUrlSlug / homeUrlSlug → team registry
 *
 * Non-fatal: errors are caught and logged.
 */
export async function refreshAnApiOdds(
  dateStr: string,
  sports: AnSport[] = ["ncaab", "nba", "nhl"],
  source: "auto" | "manual" = "auto"
): Promise<{
  updated: number;
  skipped: number;
  frozen: number;
  errors: string[];
}> {
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalFrozen = 0;
  const allErrors: string[] = [];

  for (const sport of sports) {
    try {
      const dbSport =
        sport === "nba"
          ? "NBA"
          : sport === "nhl"
            ? "NHL"
            : sport === "mlb"
              ? "MLB"
              : "NBA";
      const anGames = await fetchActionNetworkOdds(sport, dateStr);

      if (anGames.length === 0) {
        debugLog(
          "ANApiOdds",
          "info",
          `[ANApiOdds][${dbSport}] No games with DK odds for ${dateStr}`
        );
        continue;
      }

      const existingGames = await listGamesByDate(dateStr, dbSport);
      let updated = 0;
      let skipped = 0;

      // DOUBLEHEADER SAFETY: a DB row may receive odds from at most ONE AN game
      // per refresh. Without this, both games of an MLB doubleheader matched the
      // same (first-found) row and the later game's odds overwrote the earlier
      // game's (2026-07-17 TB@BOS incident class).
      const claimedGameIds = new Set<number>();
      /** Minutes-since-midnight ET for an ISO instant (null when unparseable). */
      const anStartToEstMinutes = (iso: string): number | null => {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return null;
        const s = d.toLocaleTimeString("en-US", {
          timeZone: "America/New_York",
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
        });
        const m = /^(\d{1,2}):(\d{2})/.exec(s);
        return m ? (parseInt(m[1], 10) % 24) * 60 + parseInt(m[2], 10) : null;
      };
      const estStrToMinutes = (t: string): number | null => {
        const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(t.trim());
        if (!m) return null;
        let h = parseInt(m[1], 10) % 12;
        if (/pm/i.test(m[3])) h += 12;
        return h * 60 + parseInt(m[2], 10);
      };

      for (const anGame of anGames) {
        // Resolve away team dbSlug via AN url_slug
        let awayDbSlug: string | undefined;
        let homeDbSlug: string | undefined;

        if (sport === "nba") {
          awayDbSlug = NBA_BY_AN_SLUG.get(anGame.awayUrlSlug)?.dbSlug;
          homeDbSlug = NBA_BY_AN_SLUG.get(anGame.homeUrlSlug)?.dbSlug;
        } else if (sport === "nhl") {
          awayDbSlug = getNhlTeamByAnSlug(anGame.awayUrlSlug)?.dbSlug;
          homeDbSlug = getNhlTeamByAnSlug(anGame.homeUrlSlug)?.dbSlug;
        } else if (sport === "mlb") {
          // MLB teams are stored in DB as abbreviations ("NYY", "SF"), not dbSlugs.
          // getMlbTeamByAnSlug resolves AN url_slug ("new-york-yankees") → MlbTeam → abbrev.
          const awayMlb = getMlbTeamByAnSlug(anGame.awayUrlSlug);
          const homeMlb = getMlbTeamByAnSlug(anGame.homeUrlSlug);
          awayDbSlug = awayMlb?.abbrev;
          homeDbSlug = homeMlb?.abbrev;
          if (!awayMlb || !homeMlb) {
            console.warn(
              `[ANApiOdds][MLB] UNRESOLVED AN slug: "${anGame.awayUrlSlug}" @ "${anGame.homeUrlSlug}" ` +
                `— awayResolved=${!!awayMlb} homeResolved=${!!homeMlb} ` +
                `— add to MLB_AN_SLUG_ALIASES in mlbTeams.ts if this is a known alias`
            );
          } else {
            debugLog(
              "ANApiOdds",
              "info",
              `[ANApiOdds][MLB] Resolved: "${anGame.awayUrlSlug}" → ${awayMlb.abbrev} | ` +
                `"${anGame.homeUrlSlug}" → ${homeMlb.abbrev} | ` +
                `runLine=${anGame.dkAwaySpread}/${anGame.dkHomeSpread} ` +
                `total=${anGame.dkTotal} ml=${anGame.dkAwayML}/${anGame.dkHomeML}`
            );
          }
        } else {
          // Unknown sport — skip
          debugLog(
            "ANApiOdds",
            "warn",
            `[ANApiOdds] Unknown sport "${dbSport}" — skipping game ${anGame.awayUrlSlug} @ ${anGame.homeUrlSlug}`
          );
          skipped++;
          continue;
        }

        if (!awayDbSlug || !homeDbSlug) {
          const msg = `[ANApiOdds][${dbSport}] NO_SLUG: ${anGame.awayUrlSlug} @ ${anGame.homeUrlSlug} (anId=${anGame.gameId})`;
          console.warn(msg);
          allErrors.push(msg);
          skipped++;
          continue;
        }

        // Try both orderings: AN may list teams as away@home while DB has them reversed.
        // DOUBLEHEADER-SAFE: consider ALL unclaimed team-matching rows and pick
        // the one whose start time is closest to this AN game's start time
        // (identical for single games; disambiguates G1 vs G2 for doubleheaders).
        const directMatches = existingGames.filter(
          e =>
            !claimedGameIds.has(e.id) &&
            e.awayTeam === awayDbSlug &&
            e.homeTeam === homeDbSlug
        );
        const swappedMatches =
          directMatches.length === 0
            ? existingGames.filter(
                e =>
                  !claimedGameIds.has(e.id) &&
                  e.awayTeam === homeDbSlug &&
                  e.homeTeam === awayDbSlug
              )
            : [];
        const pool = directMatches.length > 0 ? directMatches : swappedMatches;
        let dbGame: (typeof existingGames)[number] | undefined;
        if (pool.length === 1) {
          dbGame = pool[0];
        } else if (pool.length > 1) {
          const anMin = anStartToEstMinutes(anGame.startTime);
          dbGame = [...pool].sort((a, b) => {
            const da =
              anMin != null && estStrToMinutes(a.startTimeEst) != null
                ? Math.abs(anMin - estStrToMinutes(a.startTimeEst)!)
                : 24 * 60;
            const dbb =
              anMin != null && estStrToMinutes(b.startTimeEst) != null
                ? Math.abs(anMin - estStrToMinutes(b.startTimeEst)!)
                : 24 * 60;
            return da - dbb || a.id - b.id;
          })[0];
          console.log(
            `[ANApiOdds][${dbSport}] [DH] ${pool.length} candidate rows for ${awayDbSlug}@${homeDbSlug} on ${dateStr} ` +
              `(anId=${anGame.gameId}, anStart=${anGame.startTime}) — matched id=${dbGame.id} G${dbGame.gameNumber ?? 1} ` +
              `startTimeEst=${dbGame.startTimeEst} by closest start time`
          );
        }
        if (dbGame) claimedGameIds.add(dbGame.id);
        const teamsSwapped = !!dbGame && directMatches.length === 0;

        if (!dbGame) {
          const msg = `[ANApiOdds][${dbSport}] NO_MATCH: ${awayDbSlug} @ ${homeDbSlug} on ${dateStr} (anId=${anGame.gameId})`;
          console.warn(msg);
          allErrors.push(msg);
          skipped++;
          continue;
        }

        if (teamsSwapped) {
          debugLog(
            "ANApiOdds",
            "info",
            `[ANApiOdds][${dbSport}] SWAPPED: AN has ${awayDbSlug}@${homeDbSlug} but DB has ${dbGame.awayTeam}@${dbGame.homeTeam} — flipping spreads/ML`
          );
        }

        // ── ODDS FREEZE: skip games that have already started or finished ──────
        // Once a game goes live, the AN API starts returning live in-game lines.
        // We lock in the pre-game line by refusing to overwrite it.
        if (dbGame.gameStatus === "live" || dbGame.gameStatus === "final") {
          debugLog(
            "ANApiOdds",
            "info",
            `[ANApiOdds][${dbSport}] FROZEN: ${awayDbSlug} @ ${homeDbSlug} (${dateStr}) ` +
              `— gameStatus=${dbGame.gameStatus}, odds locked in, skipping update`
          );
          totalFrozen++;
          continue;
        }

        // When teams are swapped, flip away/home spread and ML so they align with DB ordering
        const dkAwaySpread = teamsSwapped
          ? anGame.dkHomeSpread
          : anGame.dkAwaySpread;
        const dkAwaySpreadOdds = teamsSwapped
          ? anGame.dkHomeSpreadOdds
          : anGame.dkAwaySpreadOdds;
        const dkHomeSpread = teamsSwapped
          ? anGame.dkAwaySpread
          : anGame.dkHomeSpread;
        const dkHomeSpreadOdds = teamsSwapped
          ? anGame.dkAwaySpreadOdds
          : anGame.dkHomeSpreadOdds;
        const dkAwayML = teamsSwapped ? anGame.dkHomeML : anGame.dkAwayML;
        const dkHomeML = teamsSwapped ? anGame.dkAwayML : anGame.dkHomeML;
        const openAwaySpread = teamsSwapped
          ? anGame.openHomeSpread
          : anGame.openAwaySpread;
        const openAwaySpreadOdds = teamsSwapped
          ? anGame.openHomeSpreadOdds
          : anGame.openAwaySpreadOdds;
        const openHomeSpread = teamsSwapped
          ? anGame.openAwaySpread
          : anGame.openHomeSpread;
        const openHomeSpreadOdds = teamsSwapped
          ? anGame.openAwaySpreadOdds
          : anGame.openHomeSpreadOdds;
        const openAwayML = teamsSwapped ? anGame.openHomeML : anGame.openAwayML;
        const openHomeML = teamsSwapped ? anGame.openAwayML : anGame.openHomeML;

        // ── FORMAT HELPERS ──────────────────────────────────────────────────────
        // fmtSpread: converts numeric spread to signed string (+1.5, -1.5, 0)
        // fmtTotal:  converts numeric total to plain string (no sign — always positive)
        const fmtSpread = (v: number | null): string | null =>
          v === null ? null : v > 0 ? `+${v}` : `${v}`;
        const fmtTotal = (v: number | null): string | null =>
          v === null ? null : `${v}`;

        // ── ATOMIC DK-VS-OPEN SWITCH ────────────────────────────────────────────
        // Rule: Use DK NJ for ALL 9 fields ONLY IF DK has ALL 3 markets complete:
        //   - Spread: dkAwaySpread + dkAwaySpreadOdds both non-null
        //   - Total:  dkTotal + dkOverOdds + dkUnderOdds all non-null
        //   - ML:     dkAwayML + dkHomeML both non-null
        // If ANY market is incomplete → use Opening line for ALL 9 fields.
        // There is NEVER a partial/null state. Every game always has either DK or Open.
        //
        // [STEP] Evaluate DK NJ completeness across all 3 markets
        const dkSpreadComplete =
          dkAwaySpread !== null &&
          dkAwaySpreadOdds !== null &&
          dkHomeSpread !== null &&
          dkHomeSpreadOdds !== null;
        const dkTotalComplete =
          anGame.dkTotal !== null &&
          anGame.dkOverOdds !== null &&
          anGame.dkUnderOdds !== null;
        const dkMlComplete = dkAwayML !== null && dkHomeML !== null;
        const dkAllComplete =
          dkSpreadComplete && dkTotalComplete && dkMlComplete;

        // [STATE] Log DK completeness check — redirected to DB to avoid stdout noise
        debugLog(
          "ANApiOdds",
          "info",
          `[ANApiOdds][${dbSport}][DK_CHECK] ${dbGame.awayTeam}@${dbGame.homeTeam} (${dateStr}) ` +
            `dkSpread=${dkSpreadComplete ? "✓" : "✗"} ` +
            `dkTotal=${dkTotalComplete ? "✓" : "✗"} ` +
            `dkML=${dkMlComplete ? "✓" : "✗"} ` +
            `→ source=${dkAllComplete ? "DK" : "OPEN"} | ` +
            `DK: spread=${dkAwaySpread ?? "null"}(${dkAwaySpreadOdds ?? "null"}) ` +
            `total=${anGame.dkTotal ?? "null"}(${anGame.dkOverOdds ?? "null"}/${anGame.dkUnderOdds ?? "null"}) ` +
            `ml=${dkAwayML ?? "null"}/${dkHomeML ?? "null"} | ` +
            `OPEN: spread=${openAwaySpread ?? "null"}(${openAwaySpreadOdds ?? "null"}) ` +
            `total=${anGame.openTotal ?? "null"}(${anGame.openOverOdds ?? "null"}/${anGame.openUnderOdds ?? "null"}) ` +
            `ml=${openAwayML ?? "null"}/${openHomeML ?? "null"}`
        );

        // [STEP] Select source atomically — DK if all 3 markets complete, else Opening line
        const oddsSource: "dk" | "open" = dkAllComplete ? "dk" : "open";
        const useAwaySpread = dkAllComplete
          ? fmtSpread(dkAwaySpread)
          : fmtSpread(openAwaySpread);
        const useAwaySpreadOdds = dkAllComplete
          ? dkAwaySpreadOdds
          : openAwaySpreadOdds;
        const useHomeSpread = dkAllComplete
          ? fmtSpread(dkHomeSpread)
          : fmtSpread(openHomeSpread);
        const useHomeSpreadOdds = dkAllComplete
          ? dkHomeSpreadOdds
          : openHomeSpreadOdds;
        const useTotal = dkAllComplete
          ? fmtTotal(anGame.dkTotal)
          : fmtTotal(anGame.openTotal);
        const useOverOdds = dkAllComplete
          ? anGame.dkOverOdds
          : anGame.openOverOdds;
        const useUnderOdds = dkAllComplete
          ? anGame.dkUnderOdds
          : anGame.openUnderOdds;
        const useAwayML = dkAllComplete ? dkAwayML : openAwayML;
        const useHomeML = dkAllComplete ? dkHomeML : openHomeML;

        // [STATE] Log final resolved values — redirected to DB to avoid stdout noise
        debugLog(
          "ANApiOdds",
          "info",
          `[ANApiOdds][${dbSport}][RESOLVED] ${dbGame.awayTeam}@${dbGame.homeTeam} (${dateStr}) ` +
            `oddsSource=${oddsSource} | ` +
            `spread=${useAwaySpread ?? "-"}(${useAwaySpreadOdds ?? "-"}) / ${useHomeSpread ?? "-"}(${useHomeSpreadOdds ?? "-"}) ` +
            `total=${useTotal ?? "-"} over=${useOverOdds ?? "-"} under=${useUnderOdds ?? "-"} ` +
            `ml=${useAwayML ?? "-"}/${useHomeML ?? "-"}`
        );

        // Alias for backwards compat with snapshot/history block below
        const rAwaySpread = { value: useAwaySpread };
        const rAwaySpreadOdds = { value: useAwaySpreadOdds };
        const rHomeSpread = { value: useHomeSpread };
        const rHomeSpreadOdds = { value: useHomeSpreadOdds };
        const rTotal = { value: useTotal };
        const rOverOdds = { value: useOverOdds };
        const rUnderOdds = { value: useUnderOdds };
        const rAwayML = { value: useAwayML };
        const rHomeML = { value: useHomeML };

        // ── DB WRITE: primary book columns + open lines + oddsSource ─────────────────────
        // ── MLB DUAL-WRITE: spread → awayRunLine + awayBookSpread ─────────────────────
        // For MLB, the AN spread market IS the run line (+1.5/-1.5).
        // The model reads awayRunLine/homeRunLine (varchar) for its run line input.
        // awayBookSpread/homeBookSpread (decimal) are used for display.
        // We write BOTH so the model and display always have the same data.
        //
        // ── LAYER 2: ML-direction cross-check before DUAL_WRITE ─────────────────────
        // INVARIANT: ML favorite is ALWAYS the RL favorite (-1.5).
        // If the scraped awayRunLine contradicts the ML direction, it is a scraper
        // artifact (e.g. odds arrived before the line was confirmed). Correct it
        // before writing so the model never receives a wrong rl_home_spread.
        let _finalAwayRunLine = rAwaySpread.value;
        let _finalHomeRunLine = rHomeSpread.value;
        // Track whether LAYER2 flipped the run line direction — if so, odds must also be swapped.
        // INVARIANT: the team on -1.5 (fav) must have the more-negative (fav) odds.
        // When the scraper delivers the line inverted, it delivers the odds in the same
        // inverted order. Flipping the line without flipping the odds produces the
        // impossible display: SD -203 on -1.5 but only -125 ML (PHI@SD bug).
        let _layer2OddsSwapped = false;
        if (
          sport === "mlb" &&
          rAwaySpread.value !== null &&
          useAwayML !== null
        ) {
          const _awayMLNum = parseFloat(String(useAwayML));
          const _awayRLNum = parseFloat(String(rAwaySpread.value));
          if (!isNaN(_awayMLNum) && !isNaN(_awayRLNum)) {
            // ML fav = negative odds. RL fav = negative spread (-1.5).
            // If awayML < 0, away is fav → away should be -1.5.
            // If awayML > 0, home is fav → away should be +1.5.
            const mlSaysAwayIsFav = _awayMLNum < 0;
            const rlSaysAwayIsFav = _awayRLNum < 0;
            if (mlSaysAwayIsFav !== rlSaysAwayIsFav) {
              // Contradiction — flip the run line to match ML direction
              const correctedAwayRL = mlSaysAwayIsFav ? -1.5 : 1.5;
              const correctedHomeRL = -correctedAwayRL;
              _finalAwayRunLine =
                correctedAwayRL > 0
                  ? `+${correctedAwayRL.toFixed(1)}`
                  : `${correctedAwayRL.toFixed(1)}`;
              _finalHomeRunLine =
                correctedHomeRL > 0
                  ? `+${correctedHomeRL.toFixed(1)}`
                  : `${correctedHomeRL.toFixed(1)}`;
              // CRITICAL: odds must also be swapped — the scraped awaySpreadOdds were for the
              // ORIGINAL (wrong) direction. After flipping the line, the away team is now the
              // dog (+1.5) so it gets the dog odds (previously homeSpreadOdds), and vice versa.
              _layer2OddsSwapped = true;
              console.warn(
                `[ANApiOdds][MLB][LAYER2_ML_GUARD] ${dbGame.awayTeam}@${dbGame.homeTeam} — ` +
                  `scraped awayRunLine=${rAwaySpread.value} contradicts awayML=${useAwayML}. ` +
                  `Corrected to awayRunLine=${_finalAwayRunLine} homeRunLine=${_finalHomeRunLine}. ` +
                  `[ODDS_SWAP] awayRunLineOdds: ${rAwaySpreadOdds.value} → ${rHomeSpreadOdds.value} ` +
                  `homeRunLineOdds: ${rHomeSpreadOdds.value} → ${rAwaySpreadOdds.value}`
              );
            }
          }
        }
        // When LAYER2 swaps the run line direction, the odds must also be swapped:
        // the fav odds (more negative) belong to the team now on -1.5, and the dog
        // odds (more positive) belong to the team now on +1.5.
        const _finalAwayRunLineOdds = _layer2OddsSwapped
          ? rHomeSpreadOdds.value
          : rAwaySpreadOdds.value;
        const _finalHomeRunLineOdds = _layer2OddsSwapped
          ? rAwaySpreadOdds.value
          : rHomeSpreadOdds.value;
        const mlbRunLineFields =
          sport === "mlb"
            ? {
                awayRunLine: _finalAwayRunLine,
                homeRunLine: _finalHomeRunLine,
                awayRunLineOdds: _finalAwayRunLineOdds,
                homeRunLineOdds: _finalHomeRunLineOdds,
              }
            : {};
        if (sport === "mlb" && _finalAwayRunLine !== null) {
          debugLog(
            "ANApiOdds",
            "info",
            `[ANApiOdds][MLB][DUAL_WRITE] ${dbGame.awayTeam}@${dbGame.homeTeam} ` +
              `awayRunLine=${_finalAwayRunLine}(${rAwaySpreadOdds.value ?? "-"}) ` +
              `homeRunLine=${_finalHomeRunLine}(${rHomeSpreadOdds.value ?? "-"}) ` +
              `→ writing to BOTH awayBookSpread AND awayRunLine columns`
          );
        }

        // ── LAYER2 GUARD PROPAGATION FIX ────────────────────────────────────────────
        // CRITICAL BUG (root cause of Rangers -123 ML / -195 RL contradiction):
        // LAYER2_ML_GUARD above corrects _finalAwayRunLine/_finalHomeRunLine when the
        // scraped run line contradicts the ML direction. However, awayBookSpread is the
        // column used for DISPLAY — it MUST use the corrected value, not the raw
        // rAwaySpread.value. Before this fix, the guard corrected awayRunLine but left
        // awayBookSpread with the inverted sign, causing the display contradiction.
        //
        // Fix: for MLB, use _finalAwayRunLine/_finalHomeRunLine as awayBookSpread/homeBookSpread.
        // For all other sports, use rAwaySpread.value as before (no run line guard applies).
        const _finalAwayBookSpread =
          sport === "mlb" && _finalAwayRunLine !== null
            ? _finalAwayRunLine
            : rAwaySpread.value;
        const _finalHomeBookSpread =
          sport === "mlb" && _finalHomeRunLine !== null
            ? _finalHomeRunLine
            : rHomeSpread.value;

        const _anOddsResult = await updateAnOdds(dbGame.id, {
          // Resolved primary book columns (DK NJ or Open-line — atomic switch)
          // For MLB: use LAYER2-corrected run line values so awayBookSpread always
          // matches the ML direction (invariant: ML fav = RL fav).
          awayBookSpread: _finalAwayBookSpread,
          // LAYER2 odds swap: when the run line direction is corrected, the display odds
          // (awaySpreadOdds/homeSpreadOdds) must also be swapped so the fav odds (-203)
          // are shown next to the fav's -1.5 line, not the dog's +1.5 line.
          awaySpreadOdds: _layer2OddsSwapped
            ? rHomeSpreadOdds.value
            : rAwaySpreadOdds.value,
          homeBookSpread: _finalHomeBookSpread,
          homeSpreadOdds: _layer2OddsSwapped
            ? rAwaySpreadOdds.value
            : rHomeSpreadOdds.value,
          bookTotal: rTotal.value,
          overOdds: rOverOdds.value,
          underOdds: rUnderOdds.value,
          awayML: rAwayML.value,
          homeML: rHomeML.value,
          // Computed odds source label — always 'dk' or 'open', never null or partial
          oddsSource,
          // MLB run line dual-write — same values as awayBookSpread/homeBookSpread
          ...mlbRunLineFields,
          // Open line reference columns (always write when AN has open data)
          ...(openAwaySpread !== null
            ? {
                openAwaySpread: fmtSpread(openAwaySpread),
                openAwaySpreadOdds: openAwaySpreadOdds,
                openHomeSpread: fmtSpread(openHomeSpread),
                openHomeSpreadOdds: openHomeSpreadOdds,
                openTotal: fmtTotal(anGame.openTotal),
                openAwayML: openAwayML,
                openHomeML: openHomeML,
              }
            : {}),
        });

        // ── LAYER3 IMMEDIATE RE-RUN ──────────────────────────────────────────────────────────────────
        // When ML direction flipped and LAYER3_ML_GUARD fired, trigger an immediate
        // model re-run for this specific game. Without this, stale model data (wrong
        // RL direction) stays on screen for up to 5 minutes until the next scheduled
        // MLB model sync cycle picks it up. This reduces the stale window to ~15-30s.
        if (_anOddsResult.layer3Fired && _anOddsResult.gameDate) {
          const _l3GameId = _anOddsResult.gameId;
          const _l3GameDate = _anOddsResult.gameDate;
          debugLog(
            "ANApiOdds",
            "info",
            `[ANApiOdds][LAYER3_IMMEDIATE_RERUN] id=${_l3GameId} gameDate=${_l3GameDate} — ` +
              `ML direction flipped → triggering immediate model re-run to eliminate stale RL display.`
          );
          // Fire-and-forget: do NOT await — this is a background re-run.
          // forceRerun=true: bypass the modelRunAt IS NULL guard (it was just cleared).
          import("./mlbModelRunner")
            .then(({ runMlbModelForDate }) =>
              runMlbModelForDate(_l3GameDate, {
                targetGameIds: [_l3GameId],
                forceRerun: true,
              })
            )
            .then(result => {
              debugLog(
                "ANApiOdds",
                "info",
                `[ANApiOdds][LAYER3_IMMEDIATE_RERUN] id=${_l3GameId} COMPLETE — ` +
                  `written=${result.written} errors=${result.errors} ` +
                  `validation=${result.validation.passed ? "✅ PASSED" : "❌ FAILED"}`
              );
            })
            .catch(err => {
              console.error(
                `[ANApiOdds][LAYER3_IMMEDIATE_RERUN] id=${_l3GameId} FAILED (non-fatal, 5-min cycle will retry):`,
                err
              );
            });
        }

        // ── ODDS HISTORY SNAPSHOT ───────────────────────────────────────────────
        // Snapshot the resolved lines (DK or Open fallback) + current VSIN splits.
        // Splits are read from the DB game row (written by the VSIN refresh step
        // that runs in the same cycle, before refreshAnApiOdds is called).
        // Apply the 0/0 guard: treat both-zero as "not yet available" (null).
        const _spreadBothZero =
          (dbGame.spreadAwayBetsPct === 0 ||
            dbGame.spreadAwayBetsPct === null) &&
          (dbGame.spreadAwayMoneyPct === 0 ||
            dbGame.spreadAwayMoneyPct === null);
        const _totalBothZero =
          (dbGame.totalOverBetsPct === 0 || dbGame.totalOverBetsPct === null) &&
          (dbGame.totalOverMoneyPct === 0 || dbGame.totalOverMoneyPct === null);
        const _mlBothZero =
          (dbGame.mlAwayBetsPct === 0 || dbGame.mlAwayBetsPct === null) &&
          (dbGame.mlAwayMoneyPct === 0 || dbGame.mlAwayMoneyPct === null);

        // lineSource for the snapshot mirrors the computed oddsSource — always 'dk' or 'open'
        const lineSource: "dk" | "open" = oddsSource;

        await insertOddsHistory(dbGame.id, dbSport, source, {
          awaySpread: rAwaySpread.value,
          awaySpreadOdds: rAwaySpreadOdds.value,
          homeSpread: rHomeSpread.value,
          homeSpreadOdds: rHomeSpreadOdds.value,
          total: rTotal.value,
          overOdds: rOverOdds.value,
          underOdds: rUnderOdds.value,
          awayML: rAwayML.value,
          homeML: rHomeML.value,
          lineSource,
          // VSIN splits — null if market not yet open (0/0 guard)
          spreadAwayBetsPct: _spreadBothZero
            ? null
            : (dbGame.spreadAwayBetsPct ?? null),
          spreadAwayMoneyPct: _spreadBothZero
            ? null
            : (dbGame.spreadAwayMoneyPct ?? null),
          totalOverBetsPct: _totalBothZero
            ? null
            : (dbGame.totalOverBetsPct ?? null),
          totalOverMoneyPct: _totalBothZero
            ? null
            : (dbGame.totalOverMoneyPct ?? null),
          mlAwayBetsPct: _mlBothZero ? null : (dbGame.mlAwayBetsPct ?? null),
          mlAwayMoneyPct: _mlBothZero ? null : (dbGame.mlAwayMoneyPct ?? null),
        });

        // [OUTPUT] Confirm update with full resolved values — redirected to DB
        updated++;
        debugLog(
          "ANApiOdds",
          "info",
          `[ANApiOdds][${dbSport}][UPDATED] ${dbGame.awayTeam}@${dbGame.homeTeam} (${dateStr}) ` +
            `source=${source} oddsSource=${oddsSource ?? "null"}${teamsSwapped ? " [SWAPPED]" : ""} | ` +
            `spread=${rAwaySpread.value ?? "-"}/${rHomeSpread.value ?? "-"} ` +
            `total=${rTotal.value ?? "-"} ` +
            `ml=${rAwayML.value ?? "-"}/${rHomeML.value ?? "-"} | ` +
            `splits: spread=${_spreadBothZero ? "PENDING" : `${dbGame.spreadAwayBetsPct}%B/${dbGame.spreadAwayMoneyPct}%M`} ` +
            `total=${_totalBothZero ? "PENDING" : `${dbGame.totalOverBetsPct}%B/${dbGame.totalOverMoneyPct}%M`} ` +
            `ml=${_mlBothZero ? "PENDING" : `${dbGame.mlAwayBetsPct}%B/${dbGame.mlAwayMoneyPct}%M`}`
        );
      }

      debugLog(
        "ANApiOdds",
        "info",
        `[ANApiOdds][${dbSport}] ${dateStr}: updated=${updated} skipped=${skipped} frozen=${totalFrozen} total=${anGames.length}`
      );
      totalUpdated += updated;
      totalSkipped += skipped;

      // ── POST-CYCLE COMPLETENESS VALIDATION GATE ──────────────────────────────
      // After every AN odds cycle, re-query the DB and report every game that still
      // has any null primary field. This is the single source of truth for data gaps.
      // [VERIFY] Run completeness check for all games on this date
      try {
        const afterGames = await listGamesByDate(dateStr, dbSport);
        const incomplete = afterGames.filter(
          g =>
            g.awayBookSpread == null ||
            g.homeBookSpread == null ||
            g.bookTotal == null ||
            g.awayML == null ||
            g.homeML == null ||
            g.awaySpreadOdds == null ||
            g.homeSpreadOdds == null ||
            g.overOdds == null ||
            g.underOdds == null
        );
        if (incomplete.length === 0) {
          debugLog(
            "ANApiOdds",
            "info",
            `[ANApiOdds][${dbSport}][COMPLETENESS] ✅ PASS — all ${afterGames.length} games on ${dateStr} have full primary odds`
          );
        } else {
          debugLog(
            "ANApiOdds",
            "warn",
            `[ANApiOdds][${dbSport}][COMPLETENESS] ⚠️  ${incomplete.length}/${afterGames.length} games on ${dateStr} have MISSING primary fields`
          );
          for (const g of incomplete) {
            const missing: string[] = [];
            if (g.awayBookSpread == null) missing.push("awayBookSpread");
            if (g.homeBookSpread == null) missing.push("homeBookSpread");
            if (g.bookTotal == null) missing.push("bookTotal");
            if (g.awayML == null) missing.push("awayML");
            if (g.homeML == null) missing.push("homeML");
            if (g.awaySpreadOdds == null) missing.push("awaySpreadOdds");
            if (g.homeSpreadOdds == null) missing.push("homeSpreadOdds");
            if (g.overOdds == null) missing.push("overOdds");
            if (g.underOdds == null) missing.push("underOdds");
            debugLog(
              "ANApiOdds",
              "warn",
              `[ANApiOdds][${dbSport}][COMPLETENESS]   INCOMPLETE gameId=${g.id} ` +
                `${g.awayTeam}@${g.homeTeam} oddsSource=${(g as any).oddsSource ?? "null"} ` +
                `MISSING=[${missing.join(", ")}]`
            );
          }
        }
      } catch (completenessErr) {
        debugLog(
          "ANApiOdds",
          "warn",
          `[ANApiOdds][${dbSport}][COMPLETENESS] WARN: completeness check failed: ${completenessErr instanceof Error ? completenessErr.message : String(completenessErr)}`
        );
      }
    } catch (err) {
      const msg = `[ANApiOdds][${sport.toUpperCase()}] Failed for ${dateStr}: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(msg);
      allErrors.push(msg);
    }
  }

  return {
    updated: totalUpdated,
    skipped: totalSkipped,
    frozen: totalFrozen,
    errors: allErrors,
  };
}

// ─── Main refresh orchestrator ─────────────────────────────────────────────────

/**
 * Core refresh logic — fully idempotent upsert of all VSiN games (NBA + NHL + MLB),
 * plus insertion of all schedule-only games for a rolling 7-day window.
 * Safe to call at any time; errors are caught and logged.
 */
export async function runVsinRefresh(): Promise<RefreshResult | null> {
  const todayStr = datePst();

  console.log(`[VSiNAutoRefresh] Starting refresh — today: ${todayStr}`);

  try {
    const rangeEnd = datePst(RANGE_DAYS_AHEAD);
    const allDates = dateRange(todayStr, rangeEnd);

    // Run NBA, NHL, and MLB VSiN refreshes in parallel — each uses independent fetch() sessions
    // with no shared state, so concurrent execution is safe and reduces wall-clock time by ~2/3.
    const [nbaResult, nhlResult, mlbResult] = await Promise.all([
      refreshNba(todayStr, allDates),
      refreshNhl(todayStr, allDates),
      refreshMlb(todayStr),
    ]);
    console.log(
      `[VSiNAutoRefresh] NBA refresh complete: updated=${nbaResult.updated} ` +
        `inserted=${nbaResult.inserted} scheduleInserted=${nbaResult.scheduleInserted} ` +
        `total=${nbaResult.total}`
    );
    console.log(
      `[VSiNAutoRefresh] NHL refresh complete: updated=${nhlResult.updated} ` +
        `inserted=${nhlResult.inserted} scheduleInserted=${nhlResult.scheduleInserted} ` +
        `total=${nhlResult.total}`
    );
    console.log(
      `[VSiNAutoRefresh] MLB VSiN splits: updated=${mlbResult.updated} total=${mlbResult.total}`
    );

    // Auto-populate DK NJ current lines from Action Network API for today
    // (non-fatal — errors are logged but do not block the refresh)
    // MLB included: run line (spread), total, moneyline from AN DK NJ
    const anOddsResult = await refreshAnApiOdds(
      todayStr,
      ["nba", "nhl", "mlb"],
      "auto"
    );
    console.log(
      `[VSiNAutoRefresh] AN API DK odds: updated=${anOddsResult.updated} ` +
        `skipped=${anOddsResult.skipped} frozen=${anOddsResult.frozen} errors=${anOddsResult.errors.length}`
    );

    // Pre-populate tomorrow's splits and DK odds (non-fatal)
    const tomorrowStr = datePst(1);
    await runTomorrowSplitsUpdate(tomorrowStr);
    // Also populate tomorrow's DK odds from AN API (tomorrow games are never live, no freeze needed)
    // MLB included for tomorrow
    const anOddsTomorrow = await refreshAnApiOdds(
      tomorrowStr,
      ["nba", "nhl", "mlb"],
      "auto"
    );
    console.log(
      `[VSiNAutoRefresh] AN API DK odds (tomorrow): updated=${anOddsTomorrow.updated} ` +
        `skipped=${anOddsTomorrow.skipped} frozen=${anOddsTomorrow.frozen} errors=${anOddsTomorrow.errors.length}`
    );

    const result: RefreshResult = {
      refreshedAt: new Date().toISOString(),
      scoresRefreshedAt: lastScoresRefreshedAt,
      updated: 0,
      inserted: 0,
      nbaUpdated: nbaResult.updated,
      nbaInserted: nbaResult.inserted,
      nbaScheduleInserted: nbaResult.scheduleInserted,
      total: 0,
      nbaTotal: nbaResult.total,
      nhlUpdated: nhlResult.updated,
      nhlInserted: nhlResult.inserted,
      nhlScheduleInserted: nhlResult.scheduleInserted,
      nhlTotal: nhlResult.total,
      mlbUpdated: mlbResult.updated,
      mlbInserted: mlbResult.inserted,
      mlbTotal: mlbResult.total,
      gameDate: todayStr,
    };

    lastRefreshResult = result;
    console.log(
      `[VSiNAutoRefresh] Done — ` +
        `NBA: ${nbaResult.updated} updated, ${nbaResult.inserted} inserted, ${nbaResult.scheduleInserted} schedule-only | ` +
        `NHL: ${nhlResult.updated} updated, ${nhlResult.inserted} inserted, ${nhlResult.scheduleInserted} schedule-only | ` +
        `MLB: ${mlbResult.updated} updated, ${mlbResult.inserted} inserted, ${mlbResult.total} total`
    );
    return result;
  } catch (err) {
    console.error("[VSiNAutoRefresh] Refresh failed:", err);
    return null;
  }
}

const SCORE_INTERVAL_MS = 15 * 1000; // 15 seconds
const MLB_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — MLB scores + splits + AN odds (24/7, no time gates)

/**
 * Refreshes NBA live/final scores and game status from the NBA live scoreboard API.
 * Runs every 15 seconds so live scores stay current.
 */
async function refreshNbaScores(): Promise<void> {
  const todayStr = datePst();
  try {
    const liveGames = await fetchNbaLiveScores();
    const existing = await listGamesByDate(todayStr, "NBA");

    let updated = 0;
    for (const liveGame of liveGames) {
      // Match by away+home DB slugs
      const dbGame = existing.find(
        g =>
          g.awayTeam === liveGame.awayDbSlug &&
          g.homeTeam === liveGame.homeDbSlug
      );
      if (!dbGame) continue;

      // Only update if status or scores have changed
      const statusChanged = dbGame.gameStatus !== liveGame.gameStatus;
      const scoresChanged =
        dbGame.awayScore !== liveGame.awayScore ||
        dbGame.homeScore !== liveGame.homeScore ||
        dbGame.gameClock !== liveGame.gameClock;

      if (!statusChanged && !scoresChanged) continue;

      await updateNcaaStartTime(dbGame.id, {
        startTimeEst: dbGame.startTimeEst,
        ncaaContestId: dbGame.ncaaContestId ?? "",
        gameStatus: liveGame.gameStatus,
        awayScore: liveGame.awayScore,
        homeScore: liveGame.homeScore,
        gameClock: liveGame.gameClock,
      });
      updated++;
    }
    console.log(
      `[ScoreRefresh] Updated scores for ${updated} NBA games (${todayStr})`
    );
  } catch (err) {
    console.warn("[ScoreRefresh] NBA score refresh failed (non-fatal):", err);
  }
}

async function refreshNhlScores(): Promise<void> {
  const todayStr = datePst();
  try {
    const liveGames = await fetchNhlLiveScores();
    const existing = await listGamesByDate(todayStr, "NHL");
    let updated = 0;
    for (const liveGame of liveGames) {
      // Match by away+home DB slugs
      const dbGame = existing.find(
        g =>
          g.awayTeam === liveGame.awayDbSlug &&
          g.homeTeam === liveGame.homeDbSlug
      );
      if (!dbGame) continue;
      // Only update if status or scores have changed
      const statusChanged = dbGame.gameStatus !== liveGame.gameState;
      const scoresChanged =
        dbGame.awayScore !== liveGame.awayScore ||
        dbGame.homeScore !== liveGame.homeScore ||
        dbGame.gameClock !== liveGame.gameClock;
      if (!statusChanged && !scoresChanged) continue;
      await updateNcaaStartTime(dbGame.id, {
        startTimeEst: dbGame.startTimeEst,
        ncaaContestId: dbGame.ncaaContestId ?? "",
        gameStatus: liveGame.gameState,
        awayScore: liveGame.awayScore,
        homeScore: liveGame.homeScore,
        gameClock: liveGame.gameClock,
      });
      updated++;
    }
    console.log(
      `[ScoreRefresh] Updated scores for ${updated} NHL games (${todayStr})`
    );
  } catch (err) {
    console.warn("[ScoreRefresh] NHL score refresh failed (non-fatal):", err);
  }
}

/**
 * MLB score refresh — fetches live scores from MLB Stats API for today.
 * Runs every 10 minutes (same interval as MLB odds/splits refresh).
 */
async function refreshMlbScoresNow(): Promise<{ newlyFinalGamePks: number[] }> {
  const todayStr = datePst();
  try {
    const { refreshMlbScores } = await import("./mlbScoreRefresh");
    const result = await refreshMlbScores(todayStr);
    const finalMsg =
      result.newlyFinalGamePks.length > 0
        ? ` | 🏁 newlyFinal=${result.newlyFinalGamePks.length} gamePks=[${result.newlyFinalGamePks.join(",")}]`
        : "";
    console.log(
      `[ScoreRefresh][MLB] ✅ ${todayStr}: updated=${result.updated} unchanged=${result.unchanged} ` +
        `noMatch=${result.noMatch} errors=${result.errors.length}${finalMsg}`
    );
    if (result.errors.length > 0) {
      console.warn(`[ScoreRefresh][MLB] Errors:`, result.errors);
    }
    return { newlyFinalGamePks: result.newlyFinalGamePks };
  } catch (err) {
    console.warn(
      "[ScoreRefresh][MLB] MLB score refresh failed (non-fatal):",
      err
    );
    return { newlyFinalGamePks: [] };
  }
}

/**
 * Runs NBA, NHL, MLB, and NCAAF score refreshes immediately.
 * Exported so it can be triggered manually from the admin panel.
 */
export async function refreshAllScoresNow(): Promise<void> {
  await Promise.allSettled([
    refreshNbaScores(),
    refreshNhlScores(),
    refreshMlbScoresNow(),
    refreshNcaafScoresNow(),
  ]);
  lastScoresRefreshedAt = new Date().toISOString();
  // Patch scoresRefreshedAt into the last refresh result so the UI can show it
  if (lastRefreshResult) {
    lastRefreshResult = {
      ...lastRefreshResult,
      scoresRefreshedAt: lastScoresRefreshedAt,
    };
  }
}

/**
 * Manual refresh variant — same as runVsinRefresh() but passes source='manual'
 * to refreshAnApiOdds so every odds snapshot is tagged as a manual trigger.
 * Called by the owner's "Refresh Now" button in Publish Projections.
 *
 * @param sport - Optional sport scope: 'NBA' | 'NHL' | 'MLB'. When provided, only that
 *                sport's VSiN data and AN odds are refreshed. When omitted, all sports
 *                are refreshed.
 */
export async function runVsinRefreshManual(
  sport?: "NBA" | "NHL" | "MLB"
): Promise<RefreshResult | null> {
  const todayStr = datePst();
  const sportLabel = sport ?? "ALL";

  console.log(
    `[VSiNAutoRefresh][MANUAL][${sportLabel}] ════════════════════════════════════════`
  );
  console.log(
    `[VSiNAutoRefresh][MANUAL][${sportLabel}] Starting manual refresh — today: ${todayStr} | scope: ${sportLabel}`
  );
  console.log(
    `[VSiNAutoRefresh][MANUAL][${sportLabel}] ════════════════════════════════════════`
  );

  try {
    const rangeEnd = datePst(RANGE_DAYS_AHEAD);
    const allDates = dateRange(todayStr, rangeEnd);

    // ── Per-sport VSiN splits + schedule refresh ──────────────────────────────────────────
    const doNba = !sport || sport === "NBA";
    const doNhl = !sport || sport === "NHL";
    const doMlb = !sport || sport === "MLB";

    let nbaResult = { updated: 0, inserted: 0, scheduleInserted: 0, total: 0 };
    let nhlResult = { updated: 0, inserted: 0, scheduleInserted: 0, total: 0 };
    let mlbResult = { updated: 0, inserted: 0, total: 0 };

    if (doNba) {
      console.log(
        `[VSiNAutoRefresh][MANUAL][NBA] ── Refreshing NBA VSiN splits + schedule…`
      );
      nbaResult = await refreshNba(todayStr, allDates);
      console.log(
        `[VSiNAutoRefresh][MANUAL][NBA] ✓ VSiN done — ` +
          `updated=${nbaResult.updated} inserted=${nbaResult.inserted} ` +
          `scheduleInserted=${nbaResult.scheduleInserted} total=${nbaResult.total}`
      );
    } else {
      console.log(
        `[VSiNAutoRefresh][MANUAL][${sportLabel}] Skipping NBA VSiN refresh (not in scope)`
      );
    }

    if (doNhl) {
      console.log(
        `[VSiNAutoRefresh][MANUAL][NHL] ── Refreshing NHL VSiN splits + schedule…`
      );
      nhlResult = await refreshNhl(todayStr, allDates);
      console.log(
        `[VSiNAutoRefresh][MANUAL][NHL] ✓ VSiN done — ` +
          `updated=${nhlResult.updated} inserted=${nhlResult.inserted} ` +
          `scheduleInserted=${nhlResult.scheduleInserted} total=${nhlResult.total}`
      );
    } else {
      console.log(
        `[VSiNAutoRefresh][MANUAL][${sportLabel}] Skipping NHL VSiN refresh (not in scope)`
      );
    }

    // ── AN API DK odds refresh (scoped to active sport) ───────────────────────
    const anSports: AnSport[] = [];
    if (doNba) anSports.push("nba");
    if (doNhl) anSports.push("nhl");
    if (doMlb) anSports.push("mlb");

    // MLB VSiN splits refresh (manual)
    if (doMlb) {
      console.log(
        `[VSiNAutoRefresh][MANUAL][MLB] —— Refreshing MLB VSiN splits…`
      );
      mlbResult = await refreshMlb(todayStr);
      console.log(
        `[VSiNAutoRefresh][MANUAL][MLB] ✓ MLB VSiN splits done — ` +
          `updated=${mlbResult.updated} total=${mlbResult.total}`
      );
    } else {
      console.log(
        `[VSiNAutoRefresh][MANUAL][${sportLabel}] Skipping MLB VSiN refresh (not in scope)`
      );
    }

    console.log(
      `[VSiNAutoRefresh][MANUAL][${sportLabel}] ── AN API DK odds refresh for sports: [${anSports.join(", ")}]…`
    );
    const anOddsResult = await refreshAnApiOdds(todayStr, anSports, "manual");
    console.log(
      `[VSiNAutoRefresh][MANUAL][${sportLabel}] ✓ AN API DK odds (today) — ` +
        `updated=${anOddsResult.updated} skipped=${anOddsResult.skipped} ` +
        `frozen=${anOddsResult.frozen} errors=${anOddsResult.errors.length}`
    );
    if (anOddsResult.errors.length > 0) {
      console.warn(
        `[VSiNAutoRefresh][MANUAL][${sportLabel}] AN API errors:`,
        anOddsResult.errors
      );
    }

    // ── NHL model sync (runs after odds refresh so book lines are fresh) ────────
    if (doNhl) {
      console.log(
        `[VSiNAutoRefresh][MANUAL][NHL] ── Running NHL model sync (manual trigger)…`
      );
      try {
        const { syncNhlModelForToday } = await import("./nhlModelSync");
        const nhlModelResult = await syncNhlModelForToday("manual");
        console.log(
          `[VSiNAutoRefresh][MANUAL][NHL] ✓ NHL model sync done — ` +
            `synced=${nhlModelResult.synced} skipped=${nhlModelResult.skipped} errors=${nhlModelResult.errors.length}`
        );
      } catch (nhlModelErr) {
        const msg =
          nhlModelErr instanceof Error
            ? nhlModelErr.message
            : String(nhlModelErr);
        console.error(
          `[VSiNAutoRefresh][MANUAL][NHL] ⚠ NHL model sync failed (non-fatal): ${msg}`
        );
      }
    }

    // ── Tomorrow's splits + DK odds (scoped) ─────────────────────────────────
    const tomorrowStr = datePst(1);
    console.log(
      `[VSiNAutoRefresh][MANUAL][${sportLabel}] ── Pre-populating tomorrow (${tomorrowStr}) splits + DK odds…`
    );
    await runTomorrowSplitsUpdate(tomorrowStr);
    const anOddsTomorrow = await refreshAnApiOdds(
      tomorrowStr,
      anSports,
      "manual"
    );
    console.log(
      `[VSiNAutoRefresh][MANUAL][${sportLabel}] ✓ AN API DK odds (tomorrow) — ` +
        `updated=${anOddsTomorrow.updated} frozen=${anOddsTomorrow.frozen}`
    );

    const result: RefreshResult = {
      refreshedAt: new Date().toISOString(),
      scoresRefreshedAt: lastScoresRefreshedAt,
      updated: 0,
      inserted: 0,
      nbaUpdated: nbaResult.updated,
      nbaInserted: nbaResult.inserted,
      nbaScheduleInserted: nbaResult.scheduleInserted,
      total: 0,
      nbaTotal: nbaResult.total,
      nhlUpdated: nhlResult.updated,
      nhlInserted: nhlResult.inserted,
      nhlScheduleInserted: nhlResult.scheduleInserted,
      nhlTotal: nhlResult.total,
      mlbUpdated: mlbResult.updated,
      mlbInserted: mlbResult.inserted,
      mlbTotal: mlbResult.total,
      gameDate: todayStr,
    };

    lastRefreshResult = result;
    console.log(
      `[VSiNAutoRefresh][MANUAL][${sportLabel}] ════════════════════════════════════════`
    );
    console.log(
      `[VSiNAutoRefresh][MANUAL][${sportLabel}] ✅ COMPLETE — ` +
        `NBA: ${nbaResult.updated} updated | ` +
        `NHL: ${nhlResult.updated} updated | ` +
        `AN odds: ${anOddsResult.updated} updated, ${anOddsResult.frozen} frozen`
    );
    console.log(
      `[VSiNAutoRefresh][MANUAL][${sportLabel}] ════════════════════════════════════════`
    );
    return result;
  } catch (err) {
    console.error(
      `[VSiNAutoRefresh][MANUAL][${sportLabel}] ❌ Refresh failed:`,
      err
    );
    return null;
  }
}

/**
 * Start the hourly auto-refresh scheduler.
 * Active window: 3am–midnight PST (covers early morning line releases through end of night).
 * Fires immediately if inside the active window, then every 60 minutes.
 * Also starts a separate 15-second score-only refresh for live/final scores.
 * Score refresh fires immediately on startup so scores are never stale after a restart.
 *
 * Odds freeze: games with gameStatus='live' or 'final' are skipped by refreshAnApiOdds
 * so the pre-game DK NJ line is permanently locked in the DB once the game starts.
 */
// ─── MLB refresh cycle (module-scope, HTTP-triggerable) ───────────────────────
// One full MLB data cycle: MLB Stats API scores, VSiN splits, AN DK odds, Rotowire
// lineups + LineupWatcher, model fallback, K-Props/HR-Props pipelines and backtests.
// Writes mlb_lineups, mlb_strikeout_props, mlb_game_backtest (among others).
//
// Hoisted to module scope and exported so GitHub Actions can drive exactly one cycle
// via POST /api/cron/mlb-cycle when the in-process schedulers are disabled on Railway
// (DISABLE_BACKGROUND_JOBS). Overlap protection is enforced by the CronJobRunner at the
// route layer — identical to the other /api/cron/* jobs. The in-process startup +
// 10-minute interval callers in startVsinAutoRefresh() invoke this same function.
async function runMlbCycleWork(): Promise<void> {
  // 24/7 — no active hours gate
  const todayStr = datePst();
  console.log(
    `[MLBCycle] ► START — ${new Date().toISOString()} | date: ${todayStr}`
  );

  // Step 0: Postponed/Suspended game lifecycle tracking
  // — Rescheduled game detection: scans MLB Stats API schedule for next 14 days
  //   to detect when a postponed game has been assigned a new gamePk/date.
  // — Suspended game resume detection: checks if any suspended games are now final.
  // Non-fatal — errors are swallowed so the main cycle continues.
  try {
    const { detectRescheduledGames, detectResumedSuspendedGames } =
      await import("./mlbPostponedTracker.js");
    const [reschedResult, resumeResult] = await Promise.allSettled([
      detectRescheduledGames(),
      detectResumedSuspendedGames(),
    ]);
    if (reschedResult.status === "fulfilled") {
      console.log(
        `[MLBCycle] PostponedTracker: rescheduled=${reschedResult.value.detected}` +
          ` | checked postponed/suspended games for reschedule in next 14 days`
      );
    } else {
      console.warn(
        "[MLBCycle] PostponedTracker rescheduled detection failed (non-fatal):",
        reschedResult.reason
      );
    }
    if (resumeResult.status === "fulfilled") {
      console.log(
        `[MLBCycle] PostponedTracker: resumed=${resumeResult.value.resumed}` +
          ` errors=${resumeResult.value.errors.length}`
      );
    } else {
      console.warn(
        "[MLBCycle] PostponedTracker resume detection failed (non-fatal):",
        resumeResult.reason
      );
    }
  } catch (err) {
    console.warn("[MLBCycle] PostponedTracker failed (non-fatal):", err);
  }

  // Step 0.5: Schedule reconciliation (statsapi → games table)
  // Root-cause repair for the 2026-07-17 doubleheader incident: inserts any
  // provider game missing from the DB (makeup games, split doubleheaders,
  // late schedule additions), stamps mlbGamePk/gameNumber/doubleHeader
  // identity onto legacy rows, and alerts on any cardinality loss.
  // Idempotent — safe every cycle. Must run BEFORE the score refresh so
  // newly-materialized rows receive scores in the same cycle.
  try {
    const { syncMlbSchedule } = await import("./mlbScheduleSync.js");
    const syncResult = await syncMlbSchedule({ source: "mlb-cycle" });
    if (syncResult) {
      console.log(
        `[MLBCycle] ScheduleSync ${syncResult.ok ? "✅" : "❌"} runId=${syncResult.runId}: ` +
          `inserted=${syncResult.inserted} updated=${syncResult.updated} unchanged=${syncResult.unchanged} ` +
          `dhGroups=${syncResult.doubleheaders.length} missing=${syncResult.reconcile.missingGamePks.length}`
      );
    }
  } catch (err) {
    console.warn("[MLBCycle] ScheduleSync failed (non-fatal):", err);
  }

  // Step 1: Live scores from MLB Stats API
  // newlyFinalGamePks captures games that transitioned to 'final' this cycle
  // — used to trigger an immediate K-Props backtest without waiting for the next tick
  let newlyFinalGamePks: number[] = [];
  try {
    const scoreResult = await refreshMlbScoresNow();
    newlyFinalGamePks = scoreResult.newlyFinalGamePks;
  } catch (err) {
    console.warn("[MLBCycle] Score refresh failed (non-fatal):", err);
  }

  // Step 2: VSiN betting splits (run line, total, ML percentages)
  try {
    const mlbSplitsResult = await refreshMlb(todayStr);
    console.log(
      `[MLBCycle] VSiN splits: updated=${mlbSplitsResult.updated} total=${mlbSplitsResult.total}`
    );
  } catch (err) {
    console.warn("[MLBCycle] VSiN splits refresh failed (non-fatal):", err);
  }

  // Step 3: AN DK NJ odds (run line spread, total, moneyline)
  // Fetch both today AND tomorrow — MLB games are often seeded a day ahead
  // (e.g. today=March 24 but the game is on March 25).
  // Freeze is respected: live/final games are skipped so pre-game lines are locked.
  const mlbTomorrowStr = (() => {
    const d = new Date(todayStr + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })();
  try {
    const [anToday, anTomorrow] = await Promise.all([
      refreshAnApiOdds(todayStr, ["mlb"], "auto"),
      refreshAnApiOdds(mlbTomorrowStr, ["mlb"], "auto"),
    ]);
    const totalUpdated = anToday.updated + anTomorrow.updated;
    const totalSkipped = anToday.skipped + anTomorrow.skipped;
    const totalFrozen = anToday.frozen + anTomorrow.frozen;
    const allErrors = [...anToday.errors, ...anTomorrow.errors];
    console.log(
      `[MLBCycle] AN DK odds: updated=${totalUpdated} skipped=${totalSkipped} ` +
        `frozen=${totalFrozen} errors=${allErrors.length}` +
        ` (today=${anToday.updated} tomorrow=${anTomorrow.updated})`
    );
    if (allErrors.length > 0) {
      console.warn("[MLBCycle] AN odds errors:", allErrors);
    }
  } catch (err) {
    console.warn("[MLBCycle] AN odds refresh failed (non-fatal):", err);
  }

  // Step 4: Rotowire daily lineups (pitchers, batting orders, weather, umpire)
  // Scrapes both today and tomorrow to catch games seeded a day ahead.
  // After upsert, the LineupWatcher detects changes and triggers the model
  // only for games where the lineup changed since the last model run.
  let todayLineupGames: import("./rotowireLineupScraper").RotoLineupGame[] = [];
  let tomorrowLineupGames: import("./rotowireLineupScraper").RotoLineupGame[] =
    [];
  let todayGameIdMap = new Map<
    import("./rotowireLineupScraper").RotoLineupGame,
    number
  >();
  let tomorrowGameIdMap = new Map<
    import("./rotowireLineupScraper").RotoLineupGame,
    number
  >();
  let rotowireTodayStr = "";
  let rotowireTomorrowStr = "";
  try {
    const {
      rotowireDateInEastern,
      scrapeRotowireLineupsBoth,
      upsertLineupsToDB,
    } = await import("./rotowireLineupScraper");
    const rotowireNow = new Date();
    rotowireTodayStr = rotowireDateInEastern(rotowireNow);
    rotowireTomorrowStr = rotowireDateInEastern(rotowireNow, 1);
    const lineupResult = await scrapeRotowireLineupsBoth();
    const totalParsed =
      lineupResult.today.cardsParsed + lineupResult.tomorrow.cardsParsed;
    const totalErrors =
      lineupResult.today.parseErrors + lineupResult.tomorrow.parseErrors;
    console.log(
      `[MLBCycle] Rotowire lineups: parsed=${totalParsed} ` +
        `(today=${lineupResult.today.cardsParsed} tomorrow=${lineupResult.tomorrow.cardsParsed}) ` +
        `parseErrors=${totalErrors}`
    );
    // ── Per-game pitcher/lineup detail log (structured Rotowire watcher output) ────────────────────────────────────
    // Emits one line per game with: matchup, pitcher names+hand, lineup status
    const logRotowireGames = (
      gamesArr: import("./rotowireLineupScraper").RotoLineupGame[],
      scope: string
    ) => {
      for (const g of gamesArr) {
        const awayP = g.awayPitcher
          ? `${g.awayPitcher.name} (${g.awayPitcher.hand ?? "?"})${g.awayPitcher.confirmed ? " [CONFIRMED]" : " [EXPECTED]"}`
          : "TBD";
        const homeP = g.homePitcher
          ? `${g.homePitcher.name} (${g.homePitcher.hand ?? "?"})${g.homePitcher.confirmed ? " [CONFIRMED]" : " [EXPECTED]"}`
          : "TBD";
        const awayLO = g.awayLineupConfirmed
          ? "CONFIRMED"
          : g.awayLineup.length > 0
            ? "EXPECTED"
            : "NONE";
        const homeLO = g.homeLineupConfirmed
          ? "CONFIRMED"
          : g.homeLineup.length > 0
            ? "EXPECTED"
            : "NONE";
        console.log(
          `[MLBCycle][Roto][${scope}] ${g.awayAbbrev}@${g.homeAbbrev} | ` +
            `away_p=${awayP} home_p=${homeP} | ` +
            `away_lo=${awayLO} home_lo=${homeLO}`
        );
      }
    };
    logRotowireGames(lineupResult.today.games, "TODAY");
    logRotowireGames(lineupResult.tomorrow.games, "TOMORROW");
    // Upsert today games (separate from tomorrow for watcher scoping)
    // Rotowire defines today/tomorrow in Eastern Time. These scopes may be a
    // calendar day ahead of the cycle's Pacific date after 9 PM PT.
    if (lineupResult.today.games.length > 0) {
      const upsertToday = await upsertLineupsToDB(
        lineupResult.today.games,
        rotowireTodayStr
      );
      todayGameIdMap = upsertToday.gameIdMap;
      todayLineupGames = lineupResult.today.games;
      console.log(
        `[MLBCycle] Lineup DB upsert (today): saved=${upsertToday.saved} skipped=${upsertToday.skipped} errors=${upsertToday.errors}`
      );
    }
    // Upsert tomorrow's Eastern-date scope separately.
    if (lineupResult.tomorrow.games.length > 0) {
      const upsertTomorrow = await upsertLineupsToDB(
        lineupResult.tomorrow.games,
        rotowireTomorrowStr
      );
      tomorrowGameIdMap = upsertTomorrow.gameIdMap;
      tomorrowLineupGames = lineupResult.tomorrow.games;
      console.log(
        `[MLBCycle] Lineup DB upsert (tomorrow): saved=${upsertTomorrow.saved} skipped=${upsertTomorrow.skipped} errors=${upsertTomorrow.errors}`
      );
    }
  } catch (err) {
    console.warn("[MLBCycle] Rotowire lineup scrape failed (non-fatal):", err);
  }

  // Step 5: MLB Lineups Watcher — detects lineup changes and triggers model
  // ─── Trigger rules ────────────────────────────────────────────────────────
  //  CASE A — First lineup seen for a game → model triggered immediately
  //  CASE B — Lineup changed (hash differs) AND not yet confirmed → re-model
  //  CASE C — Lineup unchanged (hash matches) → no action
  //  CASE D — Both lineups confirmed → stop guard, no further re-models
  try {
    const { runLineupWatcher } = await import("./mlbLineupsWatcher");
    // Run watcher for today
    if (todayLineupGames.length > 0) {
      const watcherToday = await runLineupWatcher(
        todayLineupGames,
        todayGameIdMap,
        rotowireTodayStr
      );
      console.log(
        `[MLBCycle] LineupWatcher (today): ` +
          `total=${watcherToday.total} ` +
          `firstLineup=${watcherToday.firstLineup} ` +
          `changed=${watcherToday.changed} ` +
          `unchanged=${watcherToday.unchanged} ` +
          `confirmed=${watcherToday.confirmed} ` +
          `insufficientData=${watcherToday.insufficientData} ` +
          `modelErrors=${watcherToday.modelErrors}`
      );
    }
    // Run watcher for tomorrow
    if (tomorrowLineupGames.length > 0) {
      const watcherTomorrow = await runLineupWatcher(
        tomorrowLineupGames,
        tomorrowGameIdMap,
        rotowireTomorrowStr
      );
      console.log(
        `[MLBCycle] LineupWatcher (tomorrow): ` +
          `total=${watcherTomorrow.total} ` +
          `firstLineup=${watcherTomorrow.firstLineup} ` +
          `changed=${watcherTomorrow.changed} ` +
          `unchanged=${watcherTomorrow.unchanged} ` +
          `confirmed=${watcherTomorrow.confirmed} ` +
          `insufficientData=${watcherTomorrow.insufficientData} ` +
          `modelErrors=${watcherTomorrow.modelErrors}`
      );
    }
  } catch (err) {
    console.warn("[MLBCycle] LineupWatcher failed (non-fatal):", err);
  }

  // Step 6: MLB model run — today + tomorrow, through the ONE job that owns it.
  //
  // Until 2026-08-10 this step called runMlbModelForDate(today) and
  // runMlbModelForDate(tomorrow) directly, and mlbModelRunner ALSO ran its own
  // independent 5-minute setInterval (startMlbModelSyncScheduler) doing the
  // identical pair. Two schedulers, one workload, same cadence, separate and
  // mutually blind in-flight flags — so both spawned their own CPU-bound Monte
  // Carlo subprocess over the same rows. Production evidence (Railway
  // deployment ff472662, 2026-08-09): "[MLBModelRunner][2026-08-10] Spawning
  // Python engine for N games..." logged in pairs seconds apart, e.g.
  // 18:05:42.875/18:05:50.119 and 23:50:42.493/23:50:52.290.
  //
  // That registration is retired; the workload is now a job with a single
  // acquisition path, so this cycle's re-entrancy guard, its 20-minute
  // watchdog, and /api/cron/mlb-cycle cover the model too.
  //
  // The job picks its own dates in EASTERN — games.gameDate is the venue-local
  // schedule date that mlbScheduleSync writes and queries in Eastern. The
  // cycle's `todayStr` above is Pacific and stays Pacific on purpose: it holds
  // the slate open through the end of west-coast games for score refresh and
  // prop grading, a different question from which calendar day a game is filed
  // under.
  try {
    const { runMlbModelSyncJob } = await import("./mlbModelRunner");
    const modelJob = await runMlbModelSyncJob();
    if (!modelJob.ran) {
      console.warn(
        "[MLBCycle] Model job [SKIP] — a previous model job is still running"
      );
    } else {
      for (const outcome of modelJob.dates) {
        console.log(
          `[MLBCycle] Model ${outcome.date}: ok=${outcome.ok} written=${outcome.written} ` +
            `not_yet_modelable=${outcome.notYetModelable} errors=${outcome.errors} ` +
            `validation=${outcome.validationPassed ? "✅ PASSED" : "❌ FAILED"}` +
            (outcome.failure ? ` failure=${outcome.failure}` : "")
        );
      }
    }
  } catch (err) {
    console.warn("[MLBCycle] MLB model job failed (non-fatal):", err);
  }
  // ── K-Props: fetch live AN lines + run backtest for completed games ────────
  try {
    const { fetchANKProps, formatANDate } = await import("./anKPropsService");
    const { runKPropsBacktest } = await import("./kPropsBacktestService");

    // 1. Fetch today's AN K-prop lines
    const anDateStr = formatANDate(new Date());
    const anResult = await fetchANKProps(anDateStr);
    console.log(
      `[MLBCycle] AN K-Props: fetched ${anResult.props.length} lines for ${anDateStr}`
    );

    // 2. Update bookLine, bookOverOdds, bookUnderOdds, anNoVigOverPct, anPlayerId
    //    in mlb_strikeout_props rows that match by pitcherName + gameDate
    if (anResult.props.length > 0) {
      const { upsertKPropsFromAN } = await import("./kPropsDbHelpers");
      const upsertResult = await upsertKPropsFromAN(anResult, todayStr);
      console.log(
        `[MLBCycle] K-Props upsert: inserted=${upsertResult.inserted} updated=${upsertResult.updated} skipped=${upsertResult.skipped} errors=${upsertResult.errors}`
      );
    } else {
      console.log(`[MLBCycle] K-Props upsert: skipped (0 AN props fetched)`);
    }
    // Run K-Props model EV unconditionally every cycle — not gated on AN scrape success.
    // This ensures EV is recalculated even when AN returns 0 props (network error, empty slate).
    // modelKPropsForDate is idempotent: it re-scores existing mlb_strikeout_props rows.
    const { modelKPropsForDate, resolveKPropsMlbamIdsForDate } =
      await import("./mlbKPropsModelService");
    const kModelResult = await modelKPropsForDate(todayStr);
    console.log(
      `[MLBCycle] K-Props model EV: modeled=${kModelResult.modeled} edges=${kModelResult.edges} skipped=${kModelResult.skipped} errors=${kModelResult.errors}`
    );
    // Auto-resolve MLBAM IDs for pitcher headshots — fires every cycle, no-ops if all IDs present
    try {
      const mlbamResult = await resolveKPropsMlbamIdsForDate(todayStr);
      console.log(
        `[MLBCycle] [MLBAM_BACKFILL] resolved=${mlbamResult.resolved} alreadyHad=${mlbamResult.alreadyHad} unresolved=${mlbamResult.unresolved} errors=${mlbamResult.errors}`
      );
    } catch (mlbamErr) {
      console.warn(
        "[MLBCycle] [MLBAM_BACKFILL] MLBAM ID resolution failed (non-fatal):",
        mlbamErr
      );
    }

    // 3. Run backtest for today's completed games
    // If games just went final this cycle, log for traceability (backtest runs regardless)
    if (newlyFinalGamePks.length > 0) {
      console.log(
        `[MLBCycle] 🏁 IMMEDIATE BACKTEST TRIGGER: ${newlyFinalGamePks.length} game(s) just went FINAL` +
          ` | gamePks=[${newlyFinalGamePks.join(",")}] | running backtest now`
      );
    }
    await runKPropsBacktest(todayStr);
    // 4. Fetch actual HR results for completed games (populates actualHr in mlb_hr_props)
    try {
      const { fetchAndStoreActualHrResults } =
        await import("./mlbHrPropsBacktestService");
      const hrBacktestResult = await fetchAndStoreActualHrResults(todayStr);
      console.log(
        `[MLBCycle] HR Props backtest: gamesProcessed=${hrBacktestResult.gamesProcessed} propsUpdated=${hrBacktestResult.propsUpdated} skipped=${hrBacktestResult.propsSkipped} errors=${hrBacktestResult.errors}`
      );
    } catch (hrErr) {
      console.warn("[MLBCycle] HR Props backtest failed (non-fatal):", hrErr);
    }
  } catch (err) {
    console.warn("[MLBCycle] K-Props pipeline failed (non-fatal):", err);
  }

  // ── Multi-Market Backtest: fires on FINAL transition for all markets ──────
  // Markets: FG ML/RL/Total, F5 ML/RL/Total, NRFI/YRFI, HR Props
  // Only runs when at least one game just transitioned to FINAL this cycle.
  if (newlyFinalGamePks.length > 0) {
    try {
      const { runMultiMarketBacktest } =
        await import("./mlbMultiMarketBacktest");
      const { getDb } = await import("./db");
      const { games } = await import("../drizzle/schema");
      const { inArray } = await import("drizzle-orm");
      const db = await getDb();
      const finalGameRows = await db
        .select({
          id: games.id,
          awayTeam: games.awayTeam,
          homeTeam: games.homeTeam,
          mlbGamePk: games.mlbGamePk,
        })
        .from(games)
        .where(inArray(games.mlbGamePk as any, newlyFinalGamePks.map(String)));
      console.log(
        `[MLBCycle] 🏁 MULTI-MARKET BACKTEST: ${newlyFinalGamePks.length} game(s) FINAL` +
          ` | resolved ${finalGameRows.length} DB rows | markets: FG+F5+NRFI+HR`
      );
      for (const g of finalGameRows) {
        try {
          console.log(
            `[MLBCycle]   ↳ Running backtest: ${g.awayTeam}@${g.homeTeam} (id=${g.id})`
          );
          const summary = await runMultiMarketBacktest(g.id, false);
          const wins = summary.markets.filter(m => m.result === "WIN").length;
          const losses = summary.markets.filter(
            m => m.result === "LOSS"
          ).length;
          const acc =
            wins + losses > 0
              ? ((wins / (wins + losses)) * 100).toFixed(1)
              : "N/A";
          console.log(
            `[MLBCycle]   ✅ ${g.awayTeam}@${g.homeTeam}: ${summary.markets.length} markets | ` +
              `WIN=${wins} LOSS=${losses} ACC=${acc}% | driftFlags=${summary.driftFlags.length}`
          );
          if (summary.driftFlags.length > 0) {
            for (const flag of summary.driftFlags) {
              console.warn(
                `[MLBCycle]   ⚠️  DRIFT DETECTED: market=${flag.market} ` +
                  `acc7d=${(flag.rolling7Acc * 100).toFixed(1)}% acc30d=${(flag.rolling30Acc * 100).toFixed(1)}% ` +
                  `z=${flag.zScore.toFixed(2)} | ${flag.message}`
              );
            }
          }
        } catch (gameErr) {
          console.error(
            `[MLBCycle]   ❌ Multi-market backtest failed for game ${g.id}: ${gameErr}`
          );
        }
      }
    } catch (err) {
      console.warn(
        "[MLBCycle] Multi-market backtest pipeline failed (non-fatal):",
        err
      );
    }
  }

  // ── Step 7: F5/NRFI odds scrape (FanDuel NJ) ────────────────────────────────
  // Runs every 10-minute cycle BUT only after 7:00 AM EST (12:00 UTC).
  // FanDuel NJ does not post F5/NRFI markets until morning of game day.
  // Day-prior seeding is intentionally excluded — these markets are same-day only.
  if (!isAfter7amEst()) {
    console.log(
      `[MLBCycle] F5/NRFI SKIPPED — before 7:00 AM EST (UTC hour=${new Date().getUTCHours()}) ` +
        `— FanDuel NJ F5/NRFI markets not yet posted`
    );
  } else {
    try {
      const { scrapeAndStoreF5Nrfi } = await import("./mlbF5NrfiScraper");
      const f5Result = await scrapeAndStoreF5Nrfi(todayStr);
      console.log(
        `[MLBCycle] F5/NRFI (FanDuel NJ): processed=${f5Result.processed} ` +
          `matched=${f5Result.matched} unmatched=${f5Result.unmatched.length} ` +
          `errors=${f5Result.errors.length}`
      );
      if (f5Result.errors.length > 0) {
        console.warn(
          "[MLBCycle] F5/NRFI scrape errors:",
          f5Result.errors.slice(0, 3)
        );
      }
    } catch (err) {
      console.warn("[MLBCycle] F5/NRFI scrape failed (non-fatal):", err);
    }
  }

  // ── Step 8: HR Props scrape (Consensus) + model EV computation ───────────────────────
  // Runs every 10-minute cycle BUT only after 7:00 AM EST (12:00 UTC).
  // AN/consensus HR prop markets do not post until morning of game day.
  // Day-prior seeding is intentionally excluded — these markets are same-day only.
  if (!isAfter7amEst()) {
    console.log(
      `[MLBCycle] HR Props SKIPPED — before 7:00 AM EST (UTC hour=${new Date().getUTCHours()}) ` +
        `— AN/consensus HR prop markets not yet posted`
    );
  } else {
    // Upserts consensus HR prop odds from Action Network,
    // then resolves mlbamId for each player and computes modelPHr, modelOverOdds,
    // edgeOver, evOver, verdict using the HR Props model service.
    try {
      const { scrapeHrPropsForDate } = await import("./mlbHrPropsScraper");
      const hrResult = await scrapeHrPropsForDate(todayStr);
      console.log(
        `[MLBCycle] HR Props (Consensus): inserted=${hrResult.inserted} ` +
          `updated=${hrResult.updated} skipped=${hrResult.skipped} errors=${hrResult.errors}`
      );
      if (hrResult.errors > 0) {
        console.warn(`[MLBCycle] HR Props scrape: ${hrResult.errors} errors`);
      }
      // Run model EV computation for all HR props on today's date
      try {
        const { resolveAndModelHrProps } =
          await import("./mlbHrPropsModelService");
        const modelResult = await resolveAndModelHrProps(todayStr);
        console.log(
          `[MLBCycle] HR Props model EV: resolved=${modelResult.resolved} ` +
            `alreadyHad=${modelResult.alreadyHad} modeled=${modelResult.modeled} ` +
            `edges=${modelResult.edges} errors=${modelResult.errors}`
        );
        if (modelResult.errors > 0) {
          console.warn(
            `[MLBCycle] HR Props model: ${modelResult.errors} computation errors`
          );
        }
      } catch (modelErr) {
        console.warn(
          "[MLBCycle] HR Props model EV computation failed (non-fatal):",
          modelErr
        );
      }
    } catch (err) {
      console.warn("[MLBCycle] HR Props scrape failed (non-fatal):", err);
    }
  } // end isAfter7amEst() gate for HR Props

  console.log(`[MLBCycle] ✅ DONE — ${new Date().toISOString()}`);
}

/**
 * Single-flight guard for the MLB cycle.
 *
 * Why this lives on the FUNCTION and not at a call site (2026-08-06 audit):
 * CronJobRunner.isRunning is a per-INSTANCE private field that only guards
 * calls routed through that instance's .trigger(). The in-process setInterval
 * called runMlbCycleOnce() directly, so the lock never saw it. With the cycle
 * drifting to 4-9 minutes against a 300s interval, THREE cycles ran
 * concurrently in production (12 STARTs vs 10 DONEs in 56 minutes), doubling
 * load on Rotowire / Action Network / MLB Stats API.
 *
 * Guarding here covers every caller — interval, HTTP cron route, and any
 * future one — without importing cronRoutes (which already imports us).
 */
let mlbCycleInFlight = false;

/** Test seam: swap the cycle body. Production never calls this. */
let mlbCycleWork: () => Promise<void> = runMlbCycleWork;
export function __setMlbCycleWorkForTest(fn: () => Promise<void>): void {
  mlbCycleWork = fn;
}

/**
 * Watchdog deadline for a single MLB cycle body (2026-08-06 CRITICAL
 * remediation, layer 1 — see runMlbCycleOnce below).
 *
 * The `finally` above only fires once mlbCycleWork() SETTLES. Six fetch()
 * calls in the unconditional every-cycle path (mlbScoreRefresh,
 * vsinBettingSplitsScraper, actionNetworkScraper, anKPropsService,
 * kPropsBacktestService x2) carry no AbortSignal — if any hangs at the
 * TCP/HTTP layer, the promise never settles, `finally` never runs, and
 * mlbCycleInFlight stays true for the process lifetime: every later call
 * (the 300s setInterval AND the HTTP /api/cron/mlb-cycle route) hits [SKIP]
 * forever. A wedge is a silent, permanent MLB ingestion outage.
 *
 * MLB_INTERVAL_MS (above) is 5 minutes and observed real cycles run 3-9
 * minutes. 4x the interval (20 minutes) is generous enough to never fire on
 * ordinary slowness, while still bounding how long any future unbounded
 * fetch — audited or not — can wedge the guard shut to one deadline's worth
 * of time instead of forever. Letting a hung cycle overlap the next one
 * degrades to the pre-fix overlapping-cycle behaviour (survivable — it was
 * the actual production state for weeks); a wedge is a total outage. The
 * watchdog strictly dominates.
 */
export const MLB_CYCLE_WATCHDOG_MS = MLB_INTERVAL_MS * 4; // 20 minutes

/** Test seam: shrink the watchdog deadline so wedge tests don't take 20 minutes. */
let mlbCycleWatchdogMsOverride: number | null = null;
export function __setMlbCycleWatchdogMsForTest(ms: number | null): void {
  mlbCycleWatchdogMsOverride = ms;
}

export async function runMlbCycleOnce(): Promise<void> {
  if (mlbCycleInFlight) {
    console.warn(
      "[MLBCycle] [SKIP] previous cycle still in flight — overlap prevented"
    );
    return;
  }
  // These must be declared OUTSIDE the try — `finally` needs `watchdogTimer` in
  // scope to clear it. They are computed BEFORE the flag is set so that nothing
  // whatsoever sits between `mlbCycleInFlight = true` and `try {`: any statement
  // in that gap that could ever throw would set the flag and skip the `finally`
  // that releases it, wedging the guard closed and stopping MLB ingestion for
  // the life of the process (2026-08-07 review, Minor 2).
  const watchdogMs = mlbCycleWatchdogMsOverride ?? MLB_CYCLE_WATCHDOG_MS;
  let deadlineFired = false;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;

  mlbCycleInFlight = true;
  try {
    const work = mlbCycleWork();

    // Attach a rejection handler to `work` NOW, before racing it — Promise.race
    // does not cancel the loser, so if the watchdog wins, `work` keeps running
    // in the background and could reject long after this function has already
    // returned. Without a handler that would surface as an unhandled promise
    // rejection; this attaches one up front so an orphaned rejection is only
    // ever logged, never thrown into the void.
    work.catch(err => {
      if (deadlineFired) {
        console.error(
          "[MLBCycle] [WATCHDOG] orphaned cycle settled (rejected) after its " +
            `deadline had already released the guard: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      // else: this rejection is also being observed by the Promise.race below
      // and will propagate from there — nothing further to do here.
    });

    const deadline = new Promise<"watchdog-timeout">(resolve => {
      watchdogTimer = setTimeout(() => {
        deadlineFired = true;
        resolve("watchdog-timeout");
      }, watchdogMs);
    });

    // The deadline promise RESOLVES (never rejects) on timeout: runMlbCycleOnce
    // is called as `void runMlbCycleOnce()` from the setInterval, so a reject
    // here would produce an unhandled rejection every time the watchdog fires.
    // A genuine error from `work` still rejects this race (and this function)
    // unchanged — an existing test depends on that.
    const winner = await Promise.race([work, deadline]);
    if (winner === "watchdog-timeout") {
      console.error(
        `[MLBCycle] [WATCHDOG] cycle exceeded ${watchdogMs}ms — releasing the ` +
          "re-entrancy guard so future cycles are not skipped forever. This " +
          "means an upstream fetch is hung (no AbortSignal); the abandoned " +
          "cycle keeps running in the background and its result is discarded."
      );
    }
  } finally {
    // MUST be finally: a throwing upstream feed would otherwise wedge the
    // guard closed and stop the cycle permanently. Also clears the watchdog
    // timer on normal completion so the process doesn't hold a pending timer
    // for up to watchdogMs after every cycle (vitest would hang waiting for it).
    if (watchdogTimer) clearTimeout(watchdogTimer);
    mlbCycleInFlight = false;
  }
}

export function startVsinAutoRefresh() {
  // 24/7 — no active hours gate
  void runVsinRefresh();

  // Fire score refresh immediately on startup (don't wait for first 15-sec tick)
  void refreshAllScoresNow();

  // 24/7 — runs every 5 minutes with no time gate
  setInterval(() => {
    void runVsinRefresh();
  }, INTERVAL_MS);

  // 15-second score refresh (runs independently of the main refresh) — 24/7, no gate
  // NBA, NHL only — MLB has its own 5-minute cycle below
  setInterval(() => {
    void refreshNbaScores();
    void refreshNhlScores();
  }, SCORE_INTERVAL_MS);

  // ─── MLB 5-minute refresh cycle ──────────────────────────────────────────────
  // Runs every 5 minutes 24/7 (no time gates):
  //   1. MLB Stats API live scores (runs, hits, errors, inning, status, pitchers)
  //   2. VSiN MLB betting splits (run line, total, ML percentages)
  //   3. Action Network DK NJ odds (run line, total, ML lines)
  //
  // Fires immediately on startup so MLB data is never stale after a restart.
  // Non-fatal: each step is isolated; errors in one do not block the others.
  // Fire MLB cycle immediately on startup
  void runMlbCycleOnce();

  // Then repeat every 5 minutes
  setInterval(() => {
    void runMlbCycleOnce();
  }, MLB_INTERVAL_MS);

  // ─── Daily MLB data seeders ───────────────────────────────────────────────
  // Schedule:
  //   • Pitcher stats (MLB Stats API)  — every 24h
  //   • Bullpen stats (MLB Stats API)  — every 24h
  //   • Pitcher rolling-5 blend        — every 24h
  //   • Team batting splits            — every 24h
  //   • Park factors (3yr rolling)     — every 7 days (slow-moving data)
  //   • Umpire modifiers (historical)  — every 7 days (slow-moving data)
  //
  // All fire immediately on startup so data is never stale after a restart.
  // Non-fatal: errors in one seeder do not block the others.

  // ── Pitcher stats (24h) ──────────────────────────────────────────────────
  const runPitcherStatsRefresh = async () => {
    try {
      const { seedPitcherStats } = await import("./seedPitcherStats");
      const result = await seedPitcherStats();
      console.log(
        `[PitcherStats] Daily refresh: total=${result.total} inserted=${result.inserted} ` +
          `updated=${result.updated} errors=${result.errors}`
      );
    } catch (err) {
      console.warn("[PitcherStats] Daily refresh failed (non-fatal):", err);
    }
  };
  void runPitcherStatsRefresh();
  setInterval(() => void runPitcherStatsRefresh(), 24 * 60 * 60 * 1000);

  // ── Bullpen stats (24h) ──────────────────────────────────────────────────
  const runBullpenStatsRefresh = async () => {
    try {
      const { seedBullpenStats } = await import("./seedBullpenStats");
      const result = await seedBullpenStats();
      console.log(
        `[BullpenStats] Daily refresh: inserted=${result.inserted} updated=${result.updated} errors=${result.errors}`
      );
    } catch (err) {
      console.warn("[BullpenStats] Daily refresh failed (non-fatal):", err);
    }
  };
  void runBullpenStatsRefresh();
  setInterval(() => void runBullpenStatsRefresh(), 24 * 60 * 60 * 1000);

  // ── Pitcher rolling-5 blend (24h) ────────────────────────────────────────
  const runPitcherRolling5Refresh = async () => {
    try {
      const { seedPitcherRolling5 } = await import("./seedPitcherRolling5");
      const result = await seedPitcherRolling5();
      console.log(
        `[PitcherRolling5] Daily refresh: total=${result.total} upserted=${result.upserted} noStarts=${result.noStarts} errors=${result.errors}`
      );
    } catch (err) {
      console.warn("[PitcherRolling5] Daily refresh failed (non-fatal):", err);
    }
  };
  void runPitcherRolling5Refresh();
  setInterval(() => void runPitcherRolling5Refresh(), 24 * 60 * 60 * 1000);

  // ── Team batting splits (24h) ────────────────────────────────────────────
  const runTeamBattingSplitsRefresh = async () => {
    try {
      const { seedTeamBattingSplits } = await import("./seedTeamBattingSplits");
      const result = await seedTeamBattingSplits();
      console.log(
        `[TeamBattingSplits] Daily refresh: total=${result.total} upserted=${result.upserted} errors=${result.errors}`
      );
    } catch (err) {
      console.warn(
        "[TeamBattingSplits] Daily refresh failed (non-fatal):",
        err
      );
    }
  };
  void runTeamBattingSplitsRefresh();
  setInterval(() => void runTeamBattingSplitsRefresh(), 24 * 60 * 60 * 1000);

  // ── Park factors — 3yr rolling (7 days) ─────────────────────────────────
  // Park factors change slowly (season-level data). Weekly refresh is sufficient.
  const runParkFactorsRefresh = async () => {
    try {
      const { seedParkFactors } = await import("./seedParkFactors");
      const result = await seedParkFactors();
      console.log(
        `[ParkFactors] Weekly refresh: inserted=${result.inserted} updated=${result.updated} errors=${result.errors}`
      );
    } catch (err) {
      console.warn("[ParkFactors] Weekly refresh failed (non-fatal):", err);
    }
  };
  void runParkFactorsRefresh();
  setInterval(() => void runParkFactorsRefresh(), 7 * 24 * 60 * 60 * 1000);

  // ── Umpire modifiers — historical (7 days) ───────────────────────────────
  // Umpire data is historical and changes only when new games are completed.
  // Weekly refresh keeps it current without hammering the MLB Stats API.
  const runUmpireModifiersRefresh = async () => {
    try {
      const { seedUmpireModifiers } = await import("./seedUmpireModifiers");
      const result = await seedUmpireModifiers();
      console.log(
        `[UmpireModifiers] Weekly refresh: inserted=${result.inserted} updated=${result.updated} errors=${result.errors}`
      );
    } catch (err) {
      console.warn("[UmpireModifiers] Weekly refresh failed (non-fatal):", err);
    }
  };
  void runUmpireModifiersRefresh();
  setInterval(() => void runUmpireModifiersRefresh(), 7 * 24 * 60 * 60 * 1000);

  console.log(
    "[VSiNAutoRefresh] Scheduler started \u2014 " +
      "ALL SPORTS (NBA/NHL/MLB): every 10 min (14:01–04:59 UTC / 6:01 AM–11:59 PM EST) | " +
      "Score refresh: every 15 sec (NBA/NHL) | MLB: every 10 min (scores + splits + AN odds) | " +
      "MLB seeders: pitcher/bullpen/rolling5/batting-splits=24h | park-factors/umpires=7d"
  );
}
