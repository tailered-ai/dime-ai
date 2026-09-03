/**
 * actionNetwork.ts — Action Network v2 Scoreboard Slate Fetcher
 *
 * Fetches the daily game slate for a given sport + date from:
 *   https://api.actionnetwork.com/web/v2/scoreboard/{sport}?bookIds=...&date=YYYYMMDD&periods=event
 *
 * Each SlateGame includes:
 *   - Team abbreviations, full names, logo URLs (MLB.com SVG / ESPN CDN)
 *   - Live ML / RL (spread) / Total odds from book 123 (Caesars) → fallback 15 (DK) → 30 (FD)
 *
 * Performance strategy:
 *   1. In-memory cache keyed by "SPORT:YYYY-MM-DD" — 5-minute TTL
 *   2. In-flight deduplication: concurrent requests for the same key share one fetch
 *   3. Pre-warm: server startup calls prewarmSlateCache() for today's date across all sports
 *
 * Logging convention:
 *   [AN][INPUT]  — raw parameters received
 *   [AN][STEP]   — operation in progress
 *   [AN][STATE]  — intermediate computed values
 *   [AN][OUTPUT] — final result
 *   [AN][VERIFY] — validation pass/fail
 *   [AN][CACHE]  — cache hit / miss / evict
 *   [AN][ERROR]  — failure with context
 */

import { MLB_BY_ABBREV, MLB_BY_ID } from "@shared/mlbTeams";
import { NHL_TEAMS } from "@shared/nhlTeams";
import { NBA_TEAMS } from "@shared/nbaTeams";
import { getTeamColors } from "@shared/teamColors";

// ─── Constants ────────────────────────────────────────────────────────────────

/** AN sport slug map — BetTracker sport → AN URL slug */
const AN_SPORT_SLUG: Record<string, string> = {
  NCAAF: "ncaaf",
  MLB: "mlb",
  NHL: "nhl",
  NBA: "nba",
  NCAAM: "ncaab",
  NFL: "nfl",
};

/** All sports we pre-warm on startup */
const PREWARM_SPORTS = ["NCAAF", "MLB", "NHL", "NBA", "NCAAM"] as const;

/**
 * Book IDs priority order for odds extraction.
 * We request all three; pick the first one that has data.
 *   123 = Caesars (most complete)
 *    15 = DraftKings NJ
 *    30 = FanDuel
 */
const BOOK_IDS = "15,30,123";
const BOOK_PRIORITY = [123, 15, 30];

const AN_BASE = "https://api.actionnetwork.com/web/v2/scoreboard";

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json",
  Referer: "https://www.actionnetwork.com/",
};

/** Cache TTL: 5 minutes in ms */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Fetch timeout: 8 seconds */
const FETCH_TIMEOUT_MS = 8_000;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Odds for a single side (ML, spread side, or total side) */
export interface OddsEntry {
  odds: number; // American odds, e.g. -155, +130
  value: number; // Line value: spread amount or total; 0 for ML
}

/** Full odds snapshot for one game (consensus from best available book) */
export interface GameOdds {
  /** Away team moneyline, e.g. { odds: +130, value: 0 } */
  awayMl: OddsEntry | null;
  /** Home team moneyline, e.g. { odds: -155, value: 0 } */
  homeMl: OddsEntry | null;
  /** Away team run line / puck line / spread, e.g. { odds: -170, value: +1.5 } */
  awayRl: OddsEntry | null;
  /** Home team run line / puck line / spread, e.g. { odds: +143, value: -1.5 } */
  homeRl: OddsEntry | null;
  /** Over total, e.g. { odds: -110, value: 8.5 } */
  over: OddsEntry | null;
  /** Under total, e.g. { odds: -110, value: 8.5 } */
  under: OddsEntry | null;
  /** Which book_id the odds came from */
  bookId: number;
}

export interface SlateGame {
  id: number; // AN game id
  awayTeam: string; // e.g. "ARI"
  homeTeam: string; // e.g. "BAL"
  awayFull: string; // e.g. "Arizona Diamondbacks"
  homeFull: string; // e.g. "Baltimore Orioles"
  awayNickname: string; // e.g. "Diamondbacks"
  homeNickname: string; // e.g. "Orioles"
  awayLogo: string; // Logo URL (MLB.com SVG or ESPN CDN)
  homeLogo: string; // Logo URL
  awayColor: string; // Primary brand hex, e.g. "#A71930"
  homeColor: string; // Primary brand hex, e.g. "#DF4601"
  gameTime: string; // e.g. "6:35 PM" (EST)
  startUtc: string; // ISO UTC string
  sport: string; // "MLB" | "NHL" | "NBA" | "NCAAM"
  gameDate: string; // "YYYY-MM-DD" (EST date)
  status: string; // "scheduled" | "in_progress" | "complete" | etc.
  odds: GameOdds; // Live ML/RL/Total odds
  /**
   * Game number within a doubleheader: 1 for all single games and G1 of a DH,
   * 2 for G2 of a doubleheader. Assigned post-parse by comparing start times
   * for games sharing the same away+home matchup on the same date.
   */
  gameNumber: 1 | 2;
}

interface CacheEntry {
  games: SlateGame[];
  fetchedAt: number; // Date.now() when cached
}

// ─── In-memory cache ──────────────────────────────────────────────────────────

/** Primary cache: "SPORT:YYYY-MM-DD" → CacheEntry */
const slateCache = new Map<string, CacheEntry>();

/** In-flight deduplication: "SPORT:YYYY-MM-DD" → Promise<SlateGame[]> */
const inFlight = new Map<string, Promise<SlateGame[]>>();

function cacheKey(sport: string, dateStr: string): string {
  return `${sport.toUpperCase()}:${dateStr}`;
}

function isCacheValid(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

/** Evict all expired entries (called before each cache write) */
function evictExpired(): void {
  let evicted = 0;
  for (const [k, v] of Array.from(slateCache.entries())) {
    if (!isCacheValid(v)) {
      slateCache.delete(k);
      evicted++;
    }
  }
  if (evicted > 0) {
    console.log(
      `[AN][CACHE] Evicted ${evicted} expired entries | remaining=${slateCache.size}`
    );
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a UTC ISO string to EST time string "H:MM AM/PM"
 */
function utcToEstTime(utcStr: string): string {
  try {
    const dt = new Date(utcStr);
    return dt.toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return utcStr;
  }
}

/**
 * Convert a UTC ISO string to EST date string "YYYY-MM-DD"
 */
function utcToEstDate(utcStr: string): string {
  try {
    const dt = new Date(utcStr);
    return dt.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  } catch {
    return utcStr.slice(0, 10);
  }
}

/**
 * Today's date in EST as "YYYY-MM-DD"
 */
export function todayEstDate(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

/**
 * Resolve logo URL for a team.
 * For MLB: use MLB.com SVG via mlbId from MLB_BY_ABBREV.
 * For other sports: use the AN-provided logo URL as fallback.
 */
/**
 * MLB abbreviation aliases: some sources (MLB Stats API) use different abbreviations
 * than Action Network / MLB_BY_ABBREV. Normalize before lookup.
 */
const MLB_ABBREV_ALIASES: Record<string, string> = {
  AZ: "ARI", // Arizona Diamondbacks: MLB API uses "AZ", AN/MLB_BY_ABBREV uses "ARI"
  CWS: "CWS", // Chicago White Sox: consistent
  KC: "KC", // Kansas City Royals: consistent
  SD: "SD", // San Diego Padres: consistent
  SF: "SF", // San Francisco Giants: consistent
  TB: "TB", // Tampa Bay Rays: consistent
  WSH: "WSH", // Washington Nationals: consistent
  ATH: "ATH", // Athletics: consistent
};

/**
 * NBA team lookup by official abbreviation (e.g. "BOS", "LAL", "GSW").
 * Declared here (above resolveLogoUrl) so it is initialized before use.
 * The full fetchEspnSlate section below also references this map.
 */
const _NBA_BY_ABBREV_EARLY = new Map(NBA_TEAMS.map(t => [t.abbrev, t]));

/**
 * NHL team lookup by official abbreviation (e.g. "BOS", "MTL", "TOR").
 * Declared here (above resolveLogoUrl) so it is initialized before use.
 * The full fetchNhlStatsSlate section below also references this map.
 */
const _NHL_BY_ABBREV_EARLY = new Map(NHL_TEAMS.map(t => [t.abbrev, t]));

export function resolveLogoUrl(
  sport: string,
  abbrev: string,
  anLogoUrl: string
): string {
  if (sport === "MLB") {
    // Normalize abbreviation via alias map before lookup
    const normalized = MLB_ABBREV_ALIASES[abbrev] ?? abbrev;
    const team = MLB_BY_ABBREV.get(normalized) ?? MLB_BY_ABBREV.get(abbrev);
    if (team?.logoUrl) {
      console.log(
        `[AN][STEP]  Logo resolved: sport=MLB abbrev=${abbrev} (normalized=${normalized}) → mlbId=${team.mlbId} url=${team.logoUrl}`
      );
      return team.logoUrl;
    }
    console.warn(
      `[AN][STATE] Logo fallback: sport=MLB abbrev=${abbrev} (normalized=${normalized}) not in MLB_BY_ABBREV — using AN logo`
    );
  }

  if (sport === "NBA") {
    // Try exact abbrev match first, then case-insensitive
    const abbrevUpper = abbrev.toUpperCase();
    const team =
      _NBA_BY_ABBREV_EARLY.get(abbrevUpper) ?? _NBA_BY_ABBREV_EARLY.get(abbrev);
    if (team?.logoUrl) {
      console.log(
        `[AN][STEP]  Logo resolved: sport=NBA abbrev=${abbrev} (upper=${abbrevUpper}) → url=${team.logoUrl}`
      );
      return team.logoUrl;
    }
    // Fallback: try matching by anSlug (Action Network uses slug-based team IDs)
    const byAnSlug = NBA_TEAMS.find(
      t => t.anSlug === abbrev || t.anSlug === abbrev.toLowerCase()
    );
    if (byAnSlug?.logoUrl) {
      console.log(
        `[AN][STEP]  Logo resolved via anSlug: sport=NBA abbrev=${abbrev} → url=${byAnSlug.logoUrl}`
      );
      return byAnSlug.logoUrl;
    }
    if (anLogoUrl) return anLogoUrl; // AN CDN fallback
    console.warn(
      `[AN][STATE] Logo fallback: sport=NBA abbrev=${abbrev} not in NBA_BY_ABBREV or anSlug map — no logo`
    );
  }

  if (sport === "NHL") {
    // Try exact abbrev match first, then case-insensitive
    const abbrevUpper = abbrev.toUpperCase();
    const team =
      _NHL_BY_ABBREV_EARLY.get(abbrevUpper) ?? _NHL_BY_ABBREV_EARLY.get(abbrev);
    if (team?.logoUrl) {
      console.log(
        `[AN][STEP]  Logo resolved: sport=NHL abbrev=${abbrev} (upper=${abbrevUpper}) → url=${team.logoUrl}`
      );
      return team.logoUrl;
    }
    // Fallback: try matching by anSlug
    const byAnSlug = NHL_TEAMS.find(
      t => t.anSlug === abbrev || t.anSlug === abbrev.toLowerCase()
    );
    if (byAnSlug?.logoUrl) {
      console.log(
        `[AN][STEP]  Logo resolved via anSlug: sport=NHL abbrev=${abbrev} → url=${byAnSlug.logoUrl}`
      );
      return byAnSlug.logoUrl;
    }
    if (anLogoUrl) return anLogoUrl; // AN CDN fallback
    console.warn(
      `[AN][STATE] Logo fallback: sport=NHL abbrev=${abbrev} not in NHL_BY_ABBREV or anSlug map — no logo`
    );
  }

  return anLogoUrl;
}

/**
 * Resolve team nickname from MLB_BY_ABBREV.
 * Returns the team's nickname (e.g. "Diamondbacks") or falls back to display_name.
 */
function resolveNickname(
  sport: string,
  abbrev: string,
  anDisplayName: string
): string {
  if (sport === "MLB") {
    const team = MLB_BY_ABBREV.get(abbrev);
    if (team?.nickname) return team.nickname;
  }
  return anDisplayName;
}

/**
 * Resolve primary brand color from MLB_BY_ABBREV.
 * Falls back to AN primary_color hex.
 */
function resolveColor(sport: string, abbrev: string, anColor: string): string {
  if (sport === "MLB") {
    const team = MLB_BY_ABBREV.get(abbrev);
    if (team?.primaryColor) return team.primaryColor;
  }
  return anColor ? `#${anColor}` : "#888888";
}

/**
 * Extract ML / RL / Total odds from the AN markets object.
 * markets = { [bookId]: { event: { moneyline: [...], spread: [...], total: [...] } } }
 *
 * Priority: BOOK_PRIORITY[0] → BOOK_PRIORITY[1] → BOOK_PRIORITY[2]
 * For each market type, pick the first book that has entries.
 */
function extractOdds(
  markets: Record<string, Record<string, Record<string, unknown[]>>>,
  awayTeamId: number,
  homeTeamId: number,
  gameId: number
): GameOdds {
  const emptyOdds: GameOdds = {
    awayMl: null,
    homeMl: null,
    awayRl: null,
    homeRl: null,
    over: null,
    under: null,
    bookId: 0,
  };

  if (!markets || typeof markets !== "object") {
    console.warn(
      `[AN][STATE] game=${gameId}: markets field missing or invalid`
    );
    return emptyOdds;
  }

  // Find the best book that has at least moneyline data
  let bestBookId = 0;
  let bestEvent: Record<string, unknown[]> | null = null;

  for (const bookId of BOOK_PRIORITY) {
    const bookData = markets[String(bookId)];
    if (!bookData) continue;
    const eventData = bookData["event"] as
      Record<string, unknown[]> | undefined;
    if (!eventData) continue;
    const ml = eventData["moneyline"];
    if (Array.isArray(ml) && ml.length > 0) {
      bestBookId = bookId;
      bestEvent = eventData;
      console.log(
        `[AN][STATE] game=${gameId}: using book_id=${bookId} for odds`
      );
      break;
    }
  }

  if (!bestEvent) {
    console.warn(
      `[AN][STATE] game=${gameId}: no book with moneyline data found in books=${Object.keys(markets).join(",")}`
    );
    return emptyOdds;
  }

  type RawOutcome = {
    side: string;
    team_id?: number;
    odds: number;
    value: number;
  };

  const mlList = (bestEvent["moneyline"] ?? []) as RawOutcome[];
  const rlList = (bestEvent["spread"] ?? []) as RawOutcome[];
  const totList = (bestEvent["total"] ?? []) as RawOutcome[];

  // ── Moneyline ──────────────────────────────────────────────────────────────
  const awayMlRaw = mlList.find(
    m => m.side === "away" || m.team_id === awayTeamId
  );
  const homeMlRaw = mlList.find(
    m => m.side === "home" || m.team_id === homeTeamId
  );

  // ── Run Line / Spread ──────────────────────────────────────────────────────
  // AN spread: away side has positive value (e.g. +1.5), home has negative (e.g. -1.5)
  const awayRlRaw = rlList.find(
    m => m.side === "away" || m.team_id === awayTeamId
  );
  const homeRlRaw = rlList.find(
    m => m.side === "home" || m.team_id === homeTeamId
  );

  // ── Total ──────────────────────────────────────────────────────────────────
  const overRaw = totList.find(m => m.side === "over");
  const underRaw = totList.find(m => m.side === "under");

  const result: GameOdds = {
    awayMl: awayMlRaw ? { odds: awayMlRaw.odds, value: 0 } : null,
    homeMl: homeMlRaw ? { odds: homeMlRaw.odds, value: 0 } : null,
    awayRl: awayRlRaw ? { odds: awayRlRaw.odds, value: awayRlRaw.value } : null,
    homeRl: homeRlRaw ? { odds: homeRlRaw.odds, value: homeRlRaw.value } : null,
    over: overRaw ? { odds: overRaw.odds, value: overRaw.value } : null,
    under: underRaw ? { odds: underRaw.odds, value: underRaw.value } : null,
    bookId: bestBookId,
  };

  console.log(
    `[AN][STATE] game=${gameId} odds: ` +
      `ML away=${result.awayMl?.odds ?? "N/A"} home=${result.homeMl?.odds ?? "N/A"} | ` +
      `RL away=${result.awayRl?.value ?? "N/A"}(${result.awayRl?.odds ?? "N/A"}) home=${result.homeRl?.value ?? "N/A"}(${result.homeRl?.odds ?? "N/A"}) | ` +
      `Total O${result.over?.value ?? "N/A"}(${result.over?.odds ?? "N/A"}) U${result.under?.value ?? "N/A"}(${result.under?.odds ?? "N/A"})`
  );

  return result;
}

// ─── Core fetch (no cache) ────────────────────────────────────────────────────

async function fetchAnSlateRaw(
  sport: string,
  dateStr: string
): Promise<SlateGame[]> {
  const slug = AN_SPORT_SLUG[sport.toUpperCase()];
  if (!slug) {
    console.error(`[AN][ERROR] Unknown sport="${sport}" — no AN slug mapping`);
    return [];
  }

  const anDate = dateStr.replace(/-/g, "");
  const url = `${AN_BASE}/${slug}?bookIds=${BOOK_IDS}&date=${anDate}&periods=event`;

  console.log(`[AN][INPUT] fetchAnSlateRaw: sport=${sport} date=${dateStr}`);
  console.log(`[AN][STEP]  Fetching: ${url}`);

  let raw: Record<string, unknown>;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const resp = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: controller.signal,
    });
    clearTimeout(timer);

    console.log(
      `[AN][STATE] HTTP status=${resp.status} sport=${sport} date=${dateStr}`
    );

    if (!resp.ok) {
      const body = await resp.text();
      console.error(
        `[AN][ERROR] Non-OK: status=${resp.status} body=${body.slice(0, 200)}`
      );
      return [];
    }

    raw = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      console.error(
        `[AN][ERROR] Fetch timeout after ${FETCH_TIMEOUT_MS}ms for sport=${sport} date=${dateStr}`
      );
    } else {
      console.error(`[AN][ERROR] Fetch failed: ${err}`);
    }
    return [];
  }

  const games = (raw.games as Record<string, unknown>[]) ?? [];
  console.log(
    `[AN][STATE] Raw games count=${games.length} sport=${sport} date=${dateStr}`
  );

  if (games.length === 0) {
    console.log(`[AN][OUTPUT] No games for sport=${sport} date=${dateStr}`);
    return [];
  }

  // ── Parse ─────────────────────────────────────────────────────────────────
  const result: SlateGame[] = [];
  let parseErrors = 0;
  let oddsFound = 0;

  for (const g of games) {
    try {
      const id = g.id as number;
      const startUtc = g.start_time as string;
      const status = (g.status as string) ?? "scheduled";
      const awayTeamId = g.away_team_id as number;
      const homeTeamId = g.home_team_id as number;

      const teams = (g.teams as Record<string, unknown>[]) ?? [];
      const teamMap = new Map<number, Record<string, unknown>>();
      for (const t of teams) teamMap.set(t.id as number, t);

      const away = teamMap.get(awayTeamId);
      const home = teamMap.get(homeTeamId);

      if (!away || !home) {
        console.warn(
          `[AN][STATE] game id=${id}: missing team — awayId=${awayTeamId} homeId=${homeTeamId}`
        );
        parseErrors++;
        continue;
      }

      const awayAbbr =
        (away.abbr as string) || (away.short_name as string) || "?";
      const homeAbbr =
        (home.abbr as string) || (home.short_name as string) || "?";
      const awayAnLogo = (away.logo as string) || "";
      const homeAnLogo = (home.logo as string) || "";
      const awayAnColor = (away.primary_color as string) || "";
      const homeAnColor = (home.primary_color as string) || "";

      // Extract odds from markets
      const markets = g.markets as Record<
        string,
        Record<string, Record<string, unknown[]>>
      >;
      const odds = extractOdds(markets, awayTeamId, homeTeamId, id);
      if (odds.awayMl) oddsFound++;

      result.push({
        id,
        awayTeam: awayAbbr,
        homeTeam: homeAbbr,
        awayFull: (away.full_name as string) || awayAbbr,
        homeFull: (home.full_name as string) || homeAbbr,
        awayNickname: resolveNickname(
          sport,
          awayAbbr,
          (away.display_name as string) || awayAbbr
        ),
        homeNickname: resolveNickname(
          sport,
          homeAbbr,
          (home.display_name as string) || homeAbbr
        ),
        awayLogo: resolveLogoUrl(sport, awayAbbr, awayAnLogo),
        homeLogo: resolveLogoUrl(sport, homeAbbr, homeAnLogo),
        awayColor: resolveColor(sport, awayAbbr, awayAnColor),
        homeColor: resolveColor(sport, homeAbbr, homeAnColor),
        gameTime: utcToEstTime(startUtc),
        startUtc,
        sport: sport.toUpperCase(),
        gameDate: utcToEstDate(startUtc),
        status,
        odds,
        gameNumber: 1, // default; overwritten below for doubleheaders
      });
    } catch (err) {
      console.error(`[AN][ERROR] Parse error on game: ${err}`);
      parseErrors++;
    }
  }

  result.sort((a, b) => a.startUtc.localeCompare(b.startUtc));

  // ── Doubleheader detection ─────────────────────────────────────────────────
  // AN does not include a game_number field. We detect doubleheaders by finding
  // games that share the same awayTeam + homeTeam on the same gameDate.
  // After sorting by startUtc ASC, the first occurrence = G1, second = G2.
  // All other games keep gameNumber = 1 (their default).
  const matchupCount = new Map<string, number>(); // matchup key → count of games seen so far
  let dhDetected = 0;
  for (const g of result) {
    const key = `${g.gameDate}:${g.awayTeam}:${g.homeTeam}`;
    const seen = matchupCount.get(key) ?? 0;
    if (seen === 0) {
      matchupCount.set(key, 1);
      // gameNumber stays 1 (already set)
    } else {
      // Second (or more) game with same matchup on same date → G2
      g.gameNumber = 2;
      matchupCount.set(key, seen + 1);
      dhDetected++;
      console.log(
        `[AN][DH] Doubleheader detected: ${g.awayTeam}@${g.homeTeam} on ${g.gameDate} ` +
          `— id=${g.id} assigned gameNumber=2 (G2, starts ${g.gameTime} ET)`
      );
    }
  }
  if (dhDetected > 0) {
    console.log(`[AN][DH] Total doubleheader G2 games assigned: ${dhDetected}`);
  }

  console.log(
    `[AN][OUTPUT] Parsed ${result.length} games | sport=${sport} date=${dateStr} | oddsFound=${oddsFound}/${result.length} | errors=${parseErrors}`
  );
  console.log(
    `[AN][VERIFY] ${parseErrors === 0 ? "PASS" : "WARN"} — ${parseErrors} parse errors`
  );

  result.forEach((g, i) => {
    console.log(
      `[AN][OUTPUT]   [${i + 1}] id=${g.id} ${g.awayTeam} @ ${g.homeTeam} G${g.gameNumber} | ${g.gameTime} ET | ` +
        `ML: ${g.odds.awayMl?.odds ?? "N/A"}/${g.odds.homeMl?.odds ?? "N/A"} | ` +
        `RL: ${g.odds.awayRl?.value ?? "N/A"}(${g.odds.awayRl?.odds ?? "N/A"}) | ` +
        `Total: ${g.odds.over?.value ?? "N/A"}`
    );
  });

  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch the daily slate from Action Network — with in-memory cache + in-flight dedup.
 *
 * @param sport   - "MLB" | "NHL" | "NBA" | "NCAAM"
 * @param dateStr - "YYYY-MM-DD" (EST date)
 * @returns       - Sorted SlateGame[] (by start time ASC), served from cache when fresh
 */
export async function fetchAnSlate(
  sport: string,
  dateStr: string
): Promise<SlateGame[]> {
  const key = cacheKey(sport, dateStr);

  console.log(
    `[AN][INPUT] fetchAnSlate: sport=${sport} date=${dateStr} key=${key}`
  );

  // ── Cache hit ──────────────────────────────────────────────────────────────
  const cached = slateCache.get(key);
  if (cached && isCacheValid(cached)) {
    const ageMs = Date.now() - cached.fetchedAt;
    console.log(
      `[AN][CACHE] HIT key=${key} | age=${ageMs}ms | games=${cached.games.length}`
    );
    return cached.games;
  }

  // ── In-flight dedup ────────────────────────────────────────────────────────
  const existing = inFlight.get(key);
  if (existing) {
    console.log(
      `[AN][CACHE] IN-FLIGHT dedup key=${key} — awaiting existing request`
    );
    return existing;
  }

  // ── Cache miss — fetch ─────────────────────────────────────────────────────
  console.log(`[AN][CACHE] MISS key=${key} — initiating fetch`);

  const promise = fetchAnSlateRaw(sport, dateStr)
    .then(async games => {
      // ── Per-sport fallback for past dates ────────────────────────────────────────────────────────────────────────────
      // AN returns 0 games for past dates (HTTP 403).
      // Each sport has a dedicated public API fallback for historical schedules.
      let finalGames = games;
      if (games.length === 0) {
        const sportUpper = sport.toUpperCase();
        if (sportUpper === "MLB") {
          console.log(
            `[AN][FALLBACK][STEP] AN returned 0 MLB games for date=${dateStr} — trying MLB Stats API fallback`
          );
          finalGames = await fetchMlbStatsSlate(dateStr);
          console.log(
            `[AN][FALLBACK][OUTPUT] MLB Stats API fallback: date=${dateStr} games=${finalGames.length}`
          );
        } else if (sportUpper === "NHL") {
          console.log(
            `[AN][FALLBACK][STEP] AN returned 0 NHL games for date=${dateStr} — trying NHL API fallback`
          );
          finalGames = await fetchNhlStatsSlate(dateStr);
          console.log(
            `[AN][FALLBACK][OUTPUT] NHL API fallback: date=${dateStr} games=${finalGames.length}`
          );
        } else if (sportUpper === "NBA") {
          console.log(
            `[AN][FALLBACK][STEP] AN returned 0 NBA games for date=${dateStr} — trying ESPN NBA fallback`
          );
          finalGames = await fetchEspnSlate("NBA", dateStr);
          console.log(
            `[AN][FALLBACK][OUTPUT] ESPN NBA fallback: date=${dateStr} games=${finalGames.length}`
          );
        } else if (sportUpper === "NCAAF") {
          console.log(
            `[AN][FALLBACK][STEP] AN returned 0 NCAAF games for date=${dateStr} — trying ESPN NCAAF fallback`
          );
          finalGames = await fetchEspnSlate("NCAAF", dateStr);
          console.log(
            `[AN][FALLBACK][OUTPUT] ESPN NCAAF fallback: date=${dateStr} games=${finalGames.length}`
          );
        } else if (sportUpper === "NCAAM") {
          console.log(
            `[AN][FALLBACK][STEP] AN returned 0 NCAAM games for date=${dateStr} — trying ESPN NCAAM fallback`
          );
          finalGames = await fetchEspnSlate("NCAAM", dateStr);
          console.log(
            `[AN][FALLBACK][OUTPUT] ESPN NCAAM fallback: date=${dateStr} games=${finalGames.length}`
          );
        }
      }
      evictExpired();
      slateCache.set(key, { games: finalGames, fetchedAt: Date.now() });
      inFlight.delete(key);
      console.log(
        `[AN][CACHE] STORED key=${key} | games=${finalGames.length} | TTL=${CACHE_TTL_MS / 1000}s`
      );
      return finalGames;
    })
    .catch(err => {
      inFlight.delete(key);
      console.error(`[AN][ERROR] fetchAnSlateRaw threw: ${err}`);
      return [] as SlateGame[];
    });

  inFlight.set(key, promise);
  return promise;
}

/**
 * Pre-warm the slate cache for today's date across all 4 sports in parallel.
 * Called once on server startup to eliminate cold-start latency for the first user.
 */
export async function prewarmSlateCache(): Promise<void> {
  const today = todayEstDate();
  console.log(
    `[AN][CACHE] Pre-warming slate cache for date=${today} sports=${PREWARM_SPORTS.join(",")}`
  );

  const start = Date.now();
  const results = await Promise.allSettled(
    PREWARM_SPORTS.map(sport => fetchAnSlate(sport, today))
  );

  let totalGames = 0;
  results.forEach((r, i) => {
    const sport = PREWARM_SPORTS[i];
    if (r.status === "fulfilled") {
      totalGames += r.value.length;
      console.log(
        `[AN][CACHE] Pre-warm OK: sport=${sport} games=${r.value.length}`
      );
    } else {
      console.error(
        `[AN][CACHE] Pre-warm FAIL: sport=${sport} reason=${r.reason}`
      );
    }
  });

  const elapsed = Date.now() - start;
  console.log(
    `[AN][CACHE] Pre-warm complete | elapsed=${elapsed}ms | totalGames=${totalGames} | cacheSize=${slateCache.size}`
  );
}

// ─── MLB Stats API Fallback ───────────────────────────────────────────────────

/**
 * MLB abbreviation normalization for MLB Stats API responses.
 * Stats API uses "AZ" for Diamondbacks and "OAK" for Athletics (legacy).
 */
const MLB_STATS_ABBREV_ALIASES: Record<string, string> = {
  AZ: "ARI", // Diamondbacks
  OAK: "ATH", // Athletics (relocated to Sacramento)
};

/**
 * Fetch MLB game slate from MLB Stats API (statsapi.mlb.com) as a fallback
 * when Action Network returns 0 games (e.g., HTTP 403 for past dates).
 * Returns SlateGame[] with empty odds — sufficient for bet entry and history display.
 *
 * [AN][FALLBACK] log prefix distinguishes these entries from AN-sourced data.
 */
async function fetchMlbStatsSlate(dateStr: string): Promise<SlateGame[]> {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${dateStr}&hydrate=team&language=en`;
  console.log(`[AN][FALLBACK][INPUT] fetchMlbStatsSlate: date=${dateStr}`);
  console.log(`[AN][FALLBACK][STEP]  URL=${url}`);
  const fetchStart = Date.now();
  let resp: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "application/json",
        Referer: "https://www.mlb.com/",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    console.error(
      `[AN][FALLBACK][ERROR] fetchMlbStatsSlate: fetch failed date=${dateStr} err=${err}`
    );
    return [];
  }
  const elapsed = Date.now() - fetchStart;
  console.log(
    `[AN][FALLBACK][STATE] HTTP ${resp.status} date=${dateStr} elapsed=${elapsed}ms`
  );
  if (!resp.ok) {
    console.error(
      `[AN][FALLBACK][ERROR] fetchMlbStatsSlate: non-OK status=${resp.status} date=${dateStr}`
    );
    return [];
  }
  let data: Record<string, unknown>;
  try {
    data = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    console.error(
      `[AN][FALLBACK][ERROR] fetchMlbStatsSlate: JSON parse failed date=${dateStr} err=${err}`
    );
    return [];
  }
  const dates = (data.dates as Array<Record<string, unknown>>) ?? [];
  // Stats API returns date in "YYYY-MM-DD" format matching our dateStr
  const dateEntry = dates.find(d => (d.date as string) === dateStr);
  const apiGames = (dateEntry?.games as Array<Record<string, unknown>>) ?? [];
  console.log(
    `[AN][FALLBACK][STATE] ${apiGames.length} raw games for date=${dateStr}`
  );
  if (apiGames.length === 0) {
    console.log(
      `[AN][FALLBACK][OUTPUT] 0 games for date=${dateStr} — no MLB games scheduled`
    );
    return [];
  }
  const result: SlateGame[] = [];
  let skipped = 0;
  for (const g of apiGames) {
    try {
      const gamePk = g.gamePk as number;
      const startTime = g.gameDate as string; // ISO UTC string
      const statusObj = g.status as Record<string, string>;
      const teamsObj = g.teams as Record<string, Record<string, unknown>>;
      const awayTeamObj = (teamsObj.away?.team ?? {}) as Record<
        string,
        unknown
      >;
      const homeTeamObj = (teamsObj.home?.team ?? {}) as Record<
        string,
        unknown
      >;
      const awayId = awayTeamObj.id as number;
      const homeId = homeTeamObj.id as number;
      // Resolve via MLB_BY_ID first (most reliable), then abbreviation field
      const awayEntry = MLB_BY_ID.get(awayId);
      const homeEntry = MLB_BY_ID.get(homeId);
      const rawAwayAbbrev =
        (awayTeamObj.abbreviation as string) ?? awayEntry?.abbrev ?? "";
      const rawHomeAbbrev =
        (homeTeamObj.abbreviation as string) ?? homeEntry?.abbrev ?? "";
      const awayAbbrev =
        awayEntry?.abbrev ??
        MLB_STATS_ABBREV_ALIASES[rawAwayAbbrev] ??
        rawAwayAbbrev;
      const homeAbbrev =
        homeEntry?.abbrev ??
        MLB_STATS_ABBREV_ALIASES[rawHomeAbbrev] ??
        rawHomeAbbrev;
      const awayTeam = awayEntry ?? MLB_BY_ABBREV.get(awayAbbrev);
      const homeTeam = homeEntry ?? MLB_BY_ABBREV.get(homeAbbrev);
      if (!awayTeam || !homeTeam) {
        console.warn(
          `[AN][FALLBACK][STATE] SKIP gamePk=${gamePk}: unknown team away=${awayAbbrev}(id=${awayId}) home=${homeAbbrev}(id=${homeId})`
        );
        skipped++;
        continue;
      }
      // Map Stats API abstractGameState → AN-compatible status string
      const abstractState = statusObj.abstractGameState ?? "Preview";
      const detailedState = statusObj.detailedState ?? "";
      let status: string;
      if (abstractState === "Final") status = "complete";
      else if (abstractState === "Live") status = "in_progress";
      else if (detailedState === "Postponed") status = "postponed";
      else status = "scheduled";
      const emptyOdds: GameOdds = {
        awayMl: null,
        homeMl: null,
        awayRl: null,
        homeRl: null,
        over: null,
        under: null,
        bookId: 0,
      };
      result.push({
        id: gamePk,
        awayTeam: awayTeam.abbrev,
        homeTeam: homeTeam.abbrev,
        awayFull: awayTeam.name,
        homeFull: homeTeam.name,
        awayNickname: awayTeam.nickname,
        homeNickname: homeTeam.nickname,
        awayLogo: awayTeam.logoUrl,
        homeLogo: homeTeam.logoUrl,
        awayColor: awayTeam.primaryColor,
        homeColor: homeTeam.primaryColor,
        gameTime: utcToEstTime(startTime),
        startUtc: startTime,
        sport: "MLB",
        gameDate: utcToEstDate(startTime),
        status,
        odds: emptyOdds,
        gameNumber: 1, // default; overwritten below for doubleheaders
      });
      console.log(
        `[AN][FALLBACK][STATE] Mapped gamePk=${gamePk} ${awayTeam.abbrev}@${homeTeam.abbrev} status=${status} time=${utcToEstTime(startTime)}`
      );
    } catch (err) {
      console.error(
        `[AN][FALLBACK][ERROR] fetchMlbStatsSlate: parse error on game: ${err}`
      );
      skipped++;
    }
  }
  result.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  // Doubleheader detection for fallback slate (same logic as primary)
  const fbMatchupCount = new Map<string, number>();
  for (const g of result) {
    const key = `${g.gameDate}:${g.awayTeam}:${g.homeTeam}`;
    const seen = fbMatchupCount.get(key) ?? 0;
    if (seen === 0) {
      fbMatchupCount.set(key, 1);
    } else {
      g.gameNumber = 2;
      fbMatchupCount.set(key, seen + 1);
      console.log(
        `[AN][FALLBACK][DH] Doubleheader G2: ${g.awayTeam}@${g.homeTeam} id=${g.id} time=${g.gameTime} ET`
      );
    }
  }
  console.log(
    `[AN][FALLBACK][OUTPUT] fetchMlbStatsSlate DONE: date=${dateStr} games=${result.length} skipped=${skipped} elapsed=${elapsed}ms`
  );
  console.log(
    `[AN][FALLBACK][VERIFY] ${result.length > 0 ? "PASS" : "WARN — 0 games"} | date=${dateStr}`
  );
  return result;
}

// ─── NHL API Fallback ────────────────────────────────────────────────────────

/**
 * Build lookup maps for NHL teams by abbreviation and by dbSlug.
 * Used by fetchNhlStatsSlate to resolve team data from NHL API responses.
 */
const NHL_BY_ABBREV = new Map(NHL_TEAMS.map(t => [t.abbrev, t]));

/**
 * Fetch NHL game slate from api-web.nhle.com as a fallback
 * when Action Network returns 0 games for past dates.
 * Returns SlateGame[] with empty odds — sufficient for bet entry and history display.
 */
async function fetchNhlStatsSlate(dateStr: string): Promise<SlateGame[]> {
  const url = `https://api-web.nhle.com/v1/schedule/${dateStr}`;
  console.log(`[AN][FALLBACK][INPUT] fetchNhlStatsSlate: date=${dateStr}`);
  console.log(`[AN][FALLBACK][STEP]  URL=${url}`);
  const fetchStart = Date.now();
  let resp: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    console.error(
      `[AN][FALLBACK][ERROR] fetchNhlStatsSlate: fetch failed date=${dateStr} err=${err}`
    );
    return [];
  }
  const elapsed = Date.now() - fetchStart;
  console.log(
    `[AN][FALLBACK][STATE] HTTP ${resp.status} date=${dateStr} elapsed=${elapsed}ms`
  );
  if (!resp.ok) {
    console.error(
      `[AN][FALLBACK][ERROR] fetchNhlStatsSlate: non-OK status=${resp.status} date=${dateStr}`
    );
    return [];
  }
  let data: Record<string, unknown>;
  try {
    data = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    console.error(
      `[AN][FALLBACK][ERROR] fetchNhlStatsSlate: JSON parse failed date=${dateStr} err=${err}`
    );
    return [];
  }
  // NHL API returns gameWeek array — find the day matching dateStr
  const gameWeek = (data.gameWeek as Array<Record<string, unknown>>) ?? [];
  let apiGames: Array<Record<string, unknown>> = [];
  for (const day of gameWeek) {
    const dayDate = (day.date as string) ?? "";
    if (dayDate === dateStr) {
      apiGames = (day.games as Array<Record<string, unknown>>) ?? [];
      break;
    }
  }
  console.log(
    `[AN][FALLBACK][STATE] ${apiGames.length} raw NHL games for date=${dateStr}`
  );
  if (apiGames.length === 0) {
    console.log(`[AN][FALLBACK][OUTPUT] 0 NHL games for date=${dateStr}`);
    return [];
  }
  const result: SlateGame[] = [];
  let skipped = 0;
  const emptyOdds: GameOdds = {
    awayMl: null,
    homeMl: null,
    awayRl: null,
    homeRl: null,
    over: null,
    under: null,
    bookId: 0,
  };
  for (const g of apiGames) {
    try {
      const id = g.id as number;
      const startUtc = g.startTimeUTC as string;
      const awayObj = g.awayTeam as Record<string, unknown>;
      const homeObj = g.homeTeam as Record<string, unknown>;
      const awayAbbrev = (awayObj.abbrev as string) ?? "";
      const homeAbbrev = (homeObj.abbrev as string) ?? "";
      // Skip TBD teams (conference finals before opponent determined)
      if (
        !awayAbbrev ||
        awayAbbrev === "TBD" ||
        !homeAbbrev ||
        homeAbbrev === "TBD"
      ) {
        console.log(
          `[AN][FALLBACK][STATE] SKIP NHL game id=${id}: TBD team away=${awayAbbrev} home=${homeAbbrev}`
        );
        skipped++;
        continue;
      }
      const awayTeam = NHL_BY_ABBREV.get(awayAbbrev);
      const homeTeam = NHL_BY_ABBREV.get(homeAbbrev);
      if (!awayTeam || !homeTeam) {
        console.warn(
          `[AN][FALLBACK][STATE] SKIP NHL game id=${id}: unknown team away=${awayAbbrev} home=${homeAbbrev}`
        );
        skipped++;
        continue;
      }
      const gameState = (g.gameState as string) ?? "FUT";
      let status: string;
      if (gameState === "OFF" || gameState === "FINAL") status = "complete";
      else if (gameState === "LIVE" || gameState === "CRIT")
        status = "in_progress";
      else status = "scheduled";
      const awayColors = getTeamColors(awayTeam.dbSlug, "NHL");
      const homeColors = getTeamColors(homeTeam.dbSlug, "NHL");
      result.push({
        id,
        awayTeam: awayTeam.abbrev,
        homeTeam: homeTeam.abbrev,
        awayFull: awayTeam.name,
        homeFull: homeTeam.name,
        awayNickname: awayTeam.nickname,
        homeNickname: homeTeam.nickname,
        awayLogo: awayTeam.logoUrl,
        homeLogo: homeTeam.logoUrl,
        awayColor: awayColors?.primaryColor ?? "#888888",
        homeColor: homeColors?.primaryColor ?? "#888888",
        gameTime: utcToEstTime(startUtc),
        startUtc,
        sport: "NHL",
        gameDate: utcToEstDate(startUtc),
        status,
        odds: emptyOdds,
        gameNumber: 1,
      });
      console.log(
        `[AN][FALLBACK][STATE] NHL mapped id=${id} ${awayAbbrev}@${homeAbbrev} status=${status}`
      );
    } catch (err) {
      console.error(
        `[AN][FALLBACK][ERROR] fetchNhlStatsSlate: parse error on game: ${err}`
      );
      skipped++;
    }
  }
  result.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  console.log(
    `[AN][FALLBACK][OUTPUT] fetchNhlStatsSlate DONE: date=${dateStr} games=${result.length} skipped=${skipped} elapsed=${elapsed}ms`
  );
  console.log(
    `[AN][FALLBACK][VERIFY] ${result.length > 0 ? "PASS" : "WARN — 0 games"} | date=${dateStr}`
  );
  return result;
}

// ─── ESPN Fallback (NBA + NCAAF + NCAAM) ──────────────────────────────────────

/**
 * ESPN sport config for NBA, NCAAF, and NCAAM.
 * groups=50 for NCAAM returns only D1 games (avoids thousands of lower-division games).
 */
const ESPN_SPORT_CONFIG: Record<string, { path: string; sport: string }> = {
  NBA: { path: "basketball/nba", sport: "NBA" },
  NCAAF: { path: "football/college-football", sport: "NCAAF" },
  NCAAM: { path: "basketball/mens-college-basketball", sport: "NCAAM" },
};

/** NBA team lookup by ESPN abbreviation */
const NBA_BY_ABBREV = new Map(NBA_TEAMS.map(t => [t.abbrev, t]));

/**
 * ESPN abbreviation aliases — ESPN uses different abbreviations for some NBA teams.
 * Maps ESPN abbrev → our canonical abbrev.
 */
const ESPN_NBA_ABBREV_ALIASES: Record<string, string> = {
  GS: "GSW", // Golden State Warriors
  NY: "NYK", // New York Knicks
  SA: "SAS", // San Antonio Spurs
  NO: "NOP", // New Orleans Pelicans
  OKC: "OKC",
  LAL: "LAL",
  LAC: "LAC",
};

/**
 * Fetch NBA, NCAAF, or NCAAM game slate from ESPN API as a fallback
 * when Action Network returns 0 games for past dates.
 * Returns SlateGame[] with empty odds — sufficient for bet entry and history display.
 */
async function fetchEspnSlate(
  sport: "NBA" | "NCAAF" | "NCAAM",
  dateStr: string
): Promise<SlateGame[]> {
  const cfg = ESPN_SPORT_CONFIG[sport];
  const dateCompact = dateStr.replace(/-/g, ""); // YYYYMMDD
  const groupsParam =
    sport === "NCAAM"
      ? "&groups=50"
      : sport === "NCAAF"
        ? "&groups=80&limit=400"
        : "";
  const url = `https://site.api.espn.com/apis/site/v2/sports/${cfg.path}/scoreboard?dates=${dateCompact}${groupsParam}`;
  console.log(
    `[AN][FALLBACK][INPUT] fetchEspnSlate: sport=${sport} date=${dateStr}`
  );
  console.log(`[AN][FALLBACK][STEP]  URL=${url}`);
  const fetchStart = Date.now();
  let resp: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    console.error(
      `[AN][FALLBACK][ERROR] fetchEspnSlate: fetch failed sport=${sport} date=${dateStr} err=${err}`
    );
    return [];
  }
  const elapsed = Date.now() - fetchStart;
  console.log(
    `[AN][FALLBACK][STATE] HTTP ${resp.status} sport=${sport} date=${dateStr} elapsed=${elapsed}ms`
  );
  if (!resp.ok) {
    console.error(
      `[AN][FALLBACK][ERROR] fetchEspnSlate: non-OK status=${resp.status} sport=${sport} date=${dateStr}`
    );
    return [];
  }
  let data: Record<string, unknown>;
  try {
    data = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    console.error(
      `[AN][FALLBACK][ERROR] fetchEspnSlate: JSON parse failed sport=${sport} date=${dateStr} err=${err}`
    );
    return [];
  }
  const events = (data.events as Array<Record<string, unknown>>) ?? [];
  console.log(
    `[AN][FALLBACK][STATE] ${events.length} raw ESPN ${sport} events for date=${dateStr}`
  );
  if (events.length === 0) {
    console.log(`[AN][FALLBACK][OUTPUT] 0 ${sport} games for date=${dateStr}`);
    return [];
  }
  const result: SlateGame[] = [];
  let skipped = 0;
  const emptyOdds: GameOdds = {
    awayMl: null,
    homeMl: null,
    awayRl: null,
    homeRl: null,
    over: null,
    under: null,
    bookId: 0,
  };
  for (const evt of events) {
    try {
      const id = parseInt(evt.id as string, 10);
      const startUtc = evt.date as string; // ISO UTC
      const competitions =
        (evt.competitions as Array<Record<string, unknown>>) ?? [];
      const comp = competitions[0];
      if (!comp) {
        skipped++;
        continue;
      }
      const competitors =
        (comp.competitors as Array<Record<string, unknown>>) ?? [];
      // ESPN: competitors[0] = home, competitors[1] = away (homeAway field)
      let awayComp: Record<string, unknown> | undefined;
      let homeComp: Record<string, unknown> | undefined;
      for (const c of competitors) {
        if ((c.homeAway as string) === "away") awayComp = c;
        else homeComp = c;
      }
      if (!awayComp || !homeComp) {
        skipped++;
        continue;
      }
      const awayTeamObj = awayComp.team as Record<string, unknown>;
      const homeTeamObj = homeComp.team as Record<string, unknown>;
      const awayEspnAbbrev = (awayTeamObj.abbreviation as string) ?? "";
      const homeEspnAbbrev = (homeTeamObj.abbreviation as string) ?? "";
      const awayAbbrev =
        ESPN_NBA_ABBREV_ALIASES[awayEspnAbbrev] ?? awayEspnAbbrev;
      const homeAbbrev =
        ESPN_NBA_ABBREV_ALIASES[homeEspnAbbrev] ?? homeEspnAbbrev;
      const statusObj = (comp.status as Record<string, unknown>) ?? {};
      const statusType = (statusObj.type as Record<string, unknown>) ?? {};
      const statusName = (statusType.name as string) ?? "STATUS_SCHEDULED";
      let status: string;
      if (statusName === "STATUS_FINAL") status = "complete";
      else if (statusName === "STATUS_IN_PROGRESS") status = "in_progress";
      else status = "scheduled";
      const awayLogoEspn = (awayTeamObj.logo as string) ?? "";
      const homeLogoEspn = (homeTeamObj.logo as string) ?? "";
      const awayColorEspn = (awayTeamObj.color as string) ?? "";
      const homeColorEspn = (homeTeamObj.color as string) ?? "";
      // For NBA: resolve from our NBA_TEAMS registry for canonical logos/colors
      let awayLogo = awayLogoEspn;
      let homeLogo = homeLogoEspn;
      let awayColor = awayColorEspn ? `#${awayColorEspn}` : "#888888";
      let homeColor = homeColorEspn ? `#${homeColorEspn}` : "#888888";
      let awayFull = (awayTeamObj.displayName as string) ?? awayAbbrev;
      let homeFull = (homeTeamObj.displayName as string) ?? homeAbbrev;
      let awayNickname = (awayTeamObj.shortDisplayName as string) ?? awayAbbrev;
      let homeNickname = (homeTeamObj.shortDisplayName as string) ?? homeAbbrev;
      if (sport === "NBA") {
        const awayNba = NBA_BY_ABBREV.get(awayAbbrev);
        const homeNba = NBA_BY_ABBREV.get(homeAbbrev);
        if (awayNba) {
          awayLogo = awayNba.logoUrl;
          awayFull = awayNba.name;
          awayNickname = awayNba.nickname;
          const awayColors = getTeamColors(awayNba.dbSlug, "NBA");
          if (awayColors?.primaryColor) awayColor = awayColors.primaryColor;
        }
        if (homeNba) {
          homeLogo = homeNba.logoUrl;
          homeFull = homeNba.name;
          homeNickname = homeNba.nickname;
          const homeColors = getTeamColors(homeNba.dbSlug, "NBA");
          if (homeColors?.primaryColor) homeColor = homeColors.primaryColor;
        }
      }
      result.push({
        id,
        awayTeam: awayAbbrev,
        homeTeam: homeAbbrev,
        awayFull,
        homeFull,
        awayNickname,
        homeNickname,
        awayLogo,
        homeLogo,
        awayColor,
        homeColor,
        gameTime: utcToEstTime(startUtc),
        startUtc,
        sport,
        gameDate: utcToEstDate(startUtc),
        status,
        odds: emptyOdds,
        gameNumber: 1,
      });
      console.log(
        `[AN][FALLBACK][STATE] ESPN ${sport} mapped id=${id} ${awayAbbrev}@${homeAbbrev} status=${status}`
      );
    } catch (err) {
      console.error(
        `[AN][FALLBACK][ERROR] fetchEspnSlate: parse error on event: ${err}`
      );
      skipped++;
    }
  }
  result.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  console.log(
    `[AN][FALLBACK][OUTPUT] fetchEspnSlate DONE: sport=${sport} date=${dateStr} games=${result.length} skipped=${skipped} elapsed=${elapsed}ms`
  );
  console.log(
    `[AN][FALLBACK][VERIFY] ${result.length > 0 ? "PASS" : "WARN — 0 games"} | sport=${sport} date=${dateStr}`
  );
  return result;
}

/**
 * Manually invalidate a specific cache entry (e.g., after a date change).
 */
function invalidateSlateCache(sport: string, dateStr: string): void {
  const key = cacheKey(sport, dateStr);
  const existed = slateCache.delete(key);
  console.log(`[AN][CACHE] Invalidate key=${key} | existed=${existed}`);
}
