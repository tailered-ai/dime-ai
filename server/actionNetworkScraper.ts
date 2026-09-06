/**
 * actionNetworkScraper.ts
 *
 * Fetches DraftKings NJ (book_id=68) and Opening line (book_id=30) odds from
 * the Action Network v2 scoreboard API for NCAAB, NBA, and NHL.
 *
 * ─── Why v2 (not v1)? ────────────────────────────────────────────────────────
 * The v1 API only returns games that AN considers "major" — it silently drops
 * Ivy League, AAC conference tournament, and other smaller-conference NCAAB
 * games.  The v2 endpoint is the same one the AN website itself uses and
 * returns the full slate for every date.
 *
 * ─── API endpoint ────────────────────────────────────────────────────────────
 *   https://api.actionnetwork.com/web/v2/scoreboard/<league>
 *     ?bookIds=15,30,68,69,71,75,79
 *     &date=YYYYMMDD
 *     &periods=event
 *     [&division=D1&tournament=0]   ← NCAAB only
 *
 * ─── Confirmed book IDs ──────────────────────────────────────────────────────
 *   30  = Open (opening line)
 *   68  = DK NJ  ← DraftKings New Jersey  ★ primary target
 *   69  = FanDuel NJ
 *   71  = BetRivers NJ
 *   75  = BetMGM NJ
 *   79  = bet365 NJ
 *   15  = Consensus
 *
 * ─── v2 response structure per game ─────────────────────────────────────────
 *   game.markets[bookId].event.spread[]   → [{side:"away"|"home", value, odds}]
 *   game.markets[bookId].event.total[]    → [{side:"over"|"under", value, odds}]
 *   game.markets[bookId].event.moneyline[] → [{team_id, odds}]
 *   game.teams[]                          → [{id, url_slug, full_name, abbr}]
 *   game.away_team_id / game.home_team_id → identify away/home
 *
 * ─── Supported sports ────────────────────────────────────────────────────────
 *   "ncaab" = NCAAB (College Basketball) — includes all D1 games
 *   "nba"   = NBA
 *   "nhl"   = NHL
 */

import { debugLog } from "./_core/debugLogger";

export type AnSport = "ncaab" | "nba" | "nhl" | "mlb" | "ncaaf";

export interface AnGameOdds {
  /** Action Network internal game ID */
  gameId: number;
  awayTeamId?: number;
  homeTeamId?: number;
  /** Away team full name, e.g. "Ohio State Buckeyes" */
  awayFullName: string;
  /** Away team abbreviation */
  awayAbbr: string;
  /** Away team url_slug from AN, e.g. "ohio-state-buckeyes" */
  awayUrlSlug: string;
  /** Home team full name */
  homeFullName: string;
  /** Home team abbreviation */
  homeAbbr: string;
  /** Home team url_slug from AN */
  homeUrlSlug: string;
  /** Game start time as ISO string */
  startTime: string;
  /** Game status: "scheduled" | "in-progress" | "final" */
  status: string;

  // ── Opening line (book_id=30) ─────────────────────────────────────────────
  openAwaySpread: number | null;
  openAwaySpreadOdds: string | null;
  openHomeSpread: number | null;
  openHomeSpreadOdds: string | null;
  openTotal: number | null;
  openOverOdds: string | null;
  openUnderOdds: string | null;
  openAwayML: string | null;
  openHomeML: string | null;

  // ── Current DraftKings NJ line (book_id=68) ───────────────────────────────
  /** Current DK NJ away spread, e.g. 12.5 (positive = underdog) */
  dkAwaySpread: number | null;
  /** Current DK NJ away spread juice in American format, e.g. "-110" or "-225" */
  dkAwaySpreadOdds: string | null;
  /** Current DK NJ home spread, e.g. -12.5 */
  dkHomeSpread: number | null;
  /** Current DK NJ home spread juice in American format */
  dkHomeSpreadOdds: string | null;
  /** Current DK NJ total, e.g. 155.5 */
  dkTotal: number | null;
  /** Current DK NJ over juice in American format, e.g. "-110" */
  dkOverOdds: string | null;
  /** Current DK NJ under juice in American format, e.g. "-110" */
  dkUnderOdds: string | null;
  /** Current DK NJ away moneyline in American format, e.g. "+650" */
  dkAwayML: string | null;
  /** Current DK NJ home moneyline in American format, e.g. "-1000" */
  dkHomeML: string | null;

  // ── FanDuel NJ spread (book_id=69) — used as NHL puck line fallback ─────────
  /** FanDuel NJ away spread, e.g. 1.5 or -1.5 */
  fdAwaySpread: number | null;
  /** FanDuel NJ away spread juice in American format */
  fdAwaySpreadOdds: string | null;
  /** FanDuel NJ home spread */
  fdHomeSpread: number | null;
  /** FanDuel NJ home spread juice in American format */
  fdHomeSpreadOdds: string | null;
}

// ─── Raw v2 API types ──────────────────────────────────────────────────────────

interface AnV2Team {
  id: number;
  full_name: string;
  display_name?: string;
  short_name?: string;
  location?: string;
  abbr: string;
  url_slug: string;
}

/** A single outcome entry in a v2 market array */
interface AnV2Outcome {
  book_id: number;
  event_id?: number;
  is_alt_market?: boolean;
  side?: "away" | "home" | "over" | "under";
  team_id?: number;
  value?: number;
  odds: number;
  period: string;
  type: string;
  /** True when this outcome is a live in-game (not pre-game) line */
  is_live?: boolean;
}

/** v2 market object: markets[bookId].event.spread[] / .total[] / .moneyline[] */
interface AnV2BookMarkets {
  event?: {
    spread?: AnV2Outcome[];
    total?: AnV2Outcome[];
    moneyline?: AnV2Outcome[];
    [key: string]: AnV2Outcome[] | undefined;
  };
}

interface AnV2Game {
  id: number;
  status: string;
  real_status?: string;
  start_time: string;
  away_team_id: number;
  home_team_id: number;
  teams: AnV2Team[];
  /** markets[bookId] → AnV2BookMarkets */
  markets?: Record<string | number, AnV2BookMarkets>;
}

interface AnV2ApiResponse {
  games: AnV2Game[];
  league?: { name: string };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Formats an American odds integer as a signed string.
 * e.g. -110 → "-110", 650 → "+650"
 */
function fmtOdds(v: number | null | undefined): string | null {
  if (v == null || isNaN(v)) return null;
  return v > 0 ? `+${v}` : `${v}`;
}

/** Rounds to nearest 0.5 */
function roundHalf(v: number | null | undefined): number | null {
  if (v == null || isNaN(v)) return null;
  return Math.round(v * 2) / 2;
}

/**
 * Extracts a single outcome from a v2 market array by side or team_id.
 *
 * CRITICAL: The AN v2 API mixes pre-game and live in-game lines in the same
 * array when a game is in progress. Live lines have `is_live: true` and reflect
 * the current in-game spread/total (e.g. +8.5 with 10 min left), NOT the
 * original pre-game line (e.g. +3.5 at tip-off). We ALWAYS want the pre-game
 * line, so we filter out `is_live=true` outcomes first.
 *
 * Strategy:
 *   1. Try to find a matching outcome with is_live=false (pre-game line).
 *   2. If none found (game not yet started, no live lines), fall back to any
 *      matching outcome regardless of is_live flag.
 *
 * This ensures that for live games we show the original pre-game DK NJ line
 * (e.g. Dayton +3.5 -118) rather than the live in-game line (e.g. +8.5 -110).
 */
function findOutcome(
  arr: AnV2Outcome[] | undefined,
  matcher: { side?: string; teamId?: number }
): AnV2Outcome | undefined {
  if (!arr) return undefined;

  // Filter to pre-game (non-live) outcomes first
  const preGame = arr.filter(o => o.is_live !== true);
  const liveGame = arr.filter(o => o.is_live === true);

  const searchIn = (pool: AnV2Outcome[]) => {
    if (matcher.side) return pool.find(o => o.side === matcher.side);
    if (matcher.teamId != null)
      return pool.find(o => o.team_id === matcher.teamId);
    return undefined;
  };

  // Prefer pre-game; fall back to live only if no pre-game line exists
  const result = searchIn(preGame) ?? searchIn(liveGame);

  // Debug log when a live line is being used as fallback (indicates game is in-progress
  // but DK has not yet posted a pre-game line — should be rare)
  if (result?.is_live === true) {
    debugLog(
      "ANApiOdds",
      "warn",
      `[ActionNetwork][findOutcome] WARNING: Using live in-game line as fallback ` +
        `(no pre-game line found) — side=${matcher.side ?? "teamId=" + matcher.teamId} ` +
        `value=${result.value} odds=${result.odds} is_live=true`
    );
  }

  return result;
}

// ─── API constants ─────────────────────────────────────────────────────────────

const AN_V2_BASE = "https://api.actionnetwork.com/web/v2/scoreboard";

/**
 * Book IDs requested in every API call.
 * Including consensus (15) and all major NJ books so the response is complete.
 */
const BOOK_IDS = "15,30,68,69,71,75,79";

/**
 * DK NJ book_id = 68 (confirmed via browser network intercept on actionnetwork.com/ncaab/odds)
 * NOTE: book_id=79 is bet365 NJ — do NOT use that for DK.
 */
const DK_NJ_BOOK_ID = 68;

/**
 * FanDuel NJ book_id = 69 — used as fallback for NHL puck line when DK gives ML favorite +1.5
 */
const FANDUEL_NJ_BOOK_ID = 69;

/**
 * Open line book_id = 30 (confirmed via browser network intercept)
 */
const OPEN_BOOK_ID = 30;

const AN_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "application/json",
  Referer: "https://www.actionnetwork.com/",
  Origin: "https://www.actionnetwork.com",
};

// ─── Main scraper ──────────────────────────────────────────────────────────────

/**
 * Fetches Action Network DraftKings NJ odds (and Opening lines) for a given sport and date.
 *
 * Uses the v2 scoreboard API which returns the FULL slate including:
 *   - All NCAAB D1 games (Ivy League, conference tournaments, etc.)
 *   - All NBA games
 *   - All NHL games
 *   - All MLB games (run line = spread, total, moneyline)
 *
 * Unlike the v1 API, v2 never silently drops games.
 *
 * @param sport  - "ncaab", "nba", "nhl", or "mlb"
 * @param date   - Date string in YYYY-MM-DD format (e.g. "2026-03-15")
 * @returns Array of AnGameOdds for ALL games that day (Open + DK NJ fields populated where available).
 */
export async function fetchActionNetworkOdds(
  sport: AnSport,
  date: string
): Promise<AnGameOdds[]> {
  // Convert YYYY-MM-DD → YYYYMMDD for the API
  const dateParam = date.replace(/-/g, "");

  // Build URL — NCAAB needs division=D1 to get all D1 games
  // MLB uses the same v2 endpoint with no extra params
  const extraParams = sport === "ncaab" ? "&division=D1&tournament=0" : "";
  const url = `${AN_V2_BASE}/${sport}?bookIds=${BOOK_IDS}&date=${dateParam}&periods=event${extraParams}`;

  // Log MLB specifically since it's a new integration
  if (sport === "mlb") {
    debugLog(
      "ANApiOdds",
      "info",
      `[ActionNetwork][v2][MLB] Fetching MLB run line + total + ML odds for ${date}` +
        ` | bookIds=${BOOK_IDS} (30=Open, 68=DK NJ, 69=FD NJ)`
    );
  }

  debugLog(
    "ANApiOdds",
    "info",
    `[ActionNetwork][v2] Fetching ${sport.toUpperCase()} Open + DK NJ odds for ${date} | URL: ${url}`
  );

  // ── Fetch with exponential backoff retry (3 attempts: 2s → 4s → 8s) ──────────
  // Handles transient TLS/network failures ("Client network socket disconnected").
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAYS_MS = [2000, 4000, 8000];
  let resp: Response | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      debugLog(
        "ANApiOdds",
        "info",
        `[ActionNetwork][v2] ${sport.toUpperCase()} ${date}: fetch attempt ${attempt}/${MAX_ATTEMPTS}`
      );
      const r = await fetch(url, {
        headers: AN_HEADERS,
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) {
        throw new Error(
          `[ActionNetwork][v2] HTTP ${r.status} for ${sport} ${date}`
        );
      }
      debugLog(
        "ANApiOdds",
        "info",
        `[ActionNetwork][v2] ${sport.toUpperCase()} ${date}: fetch OK on attempt ${attempt}/${MAX_ATTEMPTS} (status=${r.status})`
      );
      resp = r;
      break;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS) {
        const delayMs = RETRY_DELAYS_MS[attempt - 1];
        debugLog(
          "ANApiOdds",
          "warn",
          `[ActionNetwork][v2] ${sport.toUpperCase()} ${date}: attempt ${attempt}/${MAX_ATTEMPTS} FAILED — ` +
            `retrying in ${delayMs}ms | error: ${errMsg}`
        );
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else {
        console.error(
          `[ActionNetwork][v2] ${sport.toUpperCase()} ${date}: ALL ${MAX_ATTEMPTS} attempts FAILED | last error: ${errMsg}`
        );
        throw err;
      }
    }
  }
  if (!resp)
    throw new Error(
      `[ActionNetwork][v2] No response after ${MAX_ATTEMPTS} attempts for ${sport} ${date}`
    );

  const data = (await resp.json()) as AnV2ApiResponse;
  if (sport === "ncaaf" && (data?.league?.name !== "ncaaf" || !Array.isArray(data.games))) {
    throw new Error("Invalid NCAAF scoreboard identity");
  }
  const games = data?.games ?? [];

  debugLog(
    "ANApiOdds",
    "info",
    `[ActionNetwork][v2] ${sport.toUpperCase()} ${date}: ${games.length} total games from API`
  );

  const results: AnGameOdds[] = [];
  let skippedNoDk = 0;
  let skippedNoTeam = 0;

  for (const game of games) {
    if (sport === "ncaaf" && [game.away_team_id, game.home_team_id].some(id =>
      !Number.isSafeInteger(id) || game.teams?.filter(team => team.id === id).length !== 1)) {
      throw new Error(`NCAAF event ${game.id}: ambiguous team identities`);
    }
    // Build team map
    const teamMap = new Map<number, AnV2Team>();
    for (const t of game.teams ?? []) teamMap.set(t.id, t);

    const awayTeam = teamMap.get(game.away_team_id);
    const homeTeam = teamMap.get(game.home_team_id);

    if (!awayTeam || !homeTeam) {
      debugLog(
        "ANApiOdds",
        "warn",
        `[ActionNetwork][v2] SKIP game ${game.id}: missing team data ` +
          `(awayId=${game.away_team_id}, homeId=${game.home_team_id})`
      );
      skippedNoTeam++;
      continue;
    }

    const gameLabel = `${awayTeam.abbr} @ ${homeTeam.abbr} (id=${game.id})`;

    // Extract v2 market data for Open (30), DK NJ (68), and FanDuel NJ (69)
    const openBook = game.markets?.[OPEN_BOOK_ID];
    const dkBook = game.markets?.[DK_NJ_BOOK_ID];
    const fdBook = game.markets?.[FANDUEL_NJ_BOOK_ID];

    const openEvent = openBook?.event;
    const dkEvent = dkBook?.event;
    const fdEvent = fdBook?.event;

    // NCAAF never substitutes live, alternate, foreign-book or ambiguous prices.
    const selectDk = (arr: AnV2Outcome[] | undefined, matcher: { side?: string; teamId?: number }) => {
      if (sport !== "ncaaf") return findOutcome(arr, matcher);
      const matches = (arr ?? []).filter(o =>
        o.book_id === DK_NJ_BOOK_ID && o.event_id === game.id &&
        o.period === "event" && o.is_live !== true && o.is_alt_market !== true &&
        Number.isInteger(o.odds) && Math.abs(o.odds) >= 100 &&
        (matcher.side ? o.side === matcher.side : o.team_id === matcher.teamId) &&
        (matcher.side === "away" ? o.team_id === game.away_team_id :
          matcher.side === "home" ? o.team_id === game.home_team_id : true) &&
        (matcher.side ? typeof o.value === "number" && Number.isFinite(o.value) : true)
      );
      return matches.length === 1 ? matches[0] : undefined;
    };
    const dkPoint = (value: number | undefined) => sport === "ncaaf"
      ? (value != null && Number.isFinite(value) ? value : null) : roundHalf(value);

    // ── Open line extraction ────────────────────────────────────────────────
    const openSpreadAway = findOutcome(openEvent?.spread, { side: "away" });
    const openSpreadHome = findOutcome(openEvent?.spread, { side: "home" });
    const openTotalOver = findOutcome(openEvent?.total, { side: "over" });
    const openTotalUnder = findOutcome(openEvent?.total, { side: "under" });
    const openMlAway = findOutcome(openEvent?.moneyline, {
      teamId: game.away_team_id,
    });
    const openMlHome = findOutcome(openEvent?.moneyline, {
      teamId: game.home_team_id,
    });

    // ── DK NJ line extraction ───────────────────────────────────────────────
    const dkSpreadAway = selectDk(dkEvent?.spread, { side: "away" });
    const dkSpreadHome = selectDk(dkEvent?.spread, { side: "home" });

    // ── FanDuel NJ spread extraction (for NHL puck line fallback) ───────────
    const fdSpreadAway = findOutcome(fdEvent?.spread, { side: "away" });
    const fdSpreadHome = findOutcome(fdEvent?.spread, { side: "home" });
    const dkTotalOver = selectDk(dkEvent?.total, { side: "over" });
    const dkTotalUnder = selectDk(dkEvent?.total, { side: "under" });
    const dkMlAway = selectDk(dkEvent?.moneyline, {
      teamId: game.away_team_id,
    });
    const dkMlHome = selectDk(dkEvent?.moneyline, {
      teamId: game.home_team_id,
    });
    if (sport === "ncaaf" && ((dkSpreadAway && dkSpreadHome && dkSpreadAway.value !== -dkSpreadHome.value!) ||
        (dkTotalOver && dkTotalUnder && dkTotalOver.value !== dkTotalUnder.value))) {
      throw new Error(`NCAAF event ${game.id}: contradictory DraftKings thresholds`);
    }

    // Log every game with full detail — redirected to DB to avoid stdout noise
    const hasDk = !!(dkSpreadAway || dkTotalOver || dkMlAway);
    const hasOpen = !!(openSpreadAway || openTotalOver || openMlAway);

    debugLog(
      "ANApiOdds",
      "info",
      `[ActionNetwork][v2] ${sport.toUpperCase()} ${hasDk ? "✓DK" : "✗DK"} ${hasOpen ? "✓OPEN" : "✗OPEN"} | ` +
        `${gameLabel} | ` +
        `Open: spread=${openSpreadAway?.value ?? "null"}(${openSpreadAway?.odds ?? "null"}) ` +
        `total=o${openTotalOver?.value ?? "null"}(${openTotalOver?.odds ?? "null"}) ` +
        `ml=${openMlAway?.odds ?? "null"}/${openMlHome?.odds ?? "null"} | ` +
        `DK: spread=${dkSpreadAway?.value ?? "null"}(${dkSpreadAway?.odds ?? "null"}) ` +
        `total=o${dkTotalOver?.value ?? "null"}(${dkTotalOver?.odds ?? "null"}) ` +
        `ml=${dkMlAway?.odds ?? "null"}/${dkMlHome?.odds ?? "null"}`
    );

    if (!hasDk) {
      skippedNoDk++;
      // Still include the game in results so Open lines can be stored
      // even when DK hasn't posted odds yet
    }

    results.push({
      gameId: game.id,
      ...(sport === "ncaaf" ? { awayTeamId: game.away_team_id, homeTeamId: game.home_team_id } : {}),
      awayFullName: awayTeam.full_name,
      awayAbbr: awayTeam.abbr,
      awayUrlSlug: awayTeam.url_slug,
      homeFullName: homeTeam.full_name,
      homeAbbr: homeTeam.abbr,
      homeUrlSlug: homeTeam.url_slug,
      startTime: game.start_time,
      status: game.status,

      // Opening line (book_id=30)
      openAwaySpread: roundHalf(openSpreadAway?.value),
      openAwaySpreadOdds: fmtOdds(openSpreadAway?.odds),
      openHomeSpread: roundHalf(openSpreadHome?.value),
      openHomeSpreadOdds: fmtOdds(openSpreadHome?.odds),
      openTotal: roundHalf(openTotalOver?.value),
      openOverOdds: fmtOdds(openTotalOver?.odds),
      openUnderOdds: fmtOdds(openTotalUnder?.odds),
      openAwayML: fmtOdds(openMlAway?.odds),
      openHomeML: fmtOdds(openMlHome?.odds),

      // DraftKings NJ current line (book_id=68)
      dkAwaySpread: dkPoint(dkSpreadAway?.value),
      dkAwaySpreadOdds: fmtOdds(dkSpreadAway?.odds),
      dkHomeSpread: dkPoint(dkSpreadHome?.value),
      dkHomeSpreadOdds: fmtOdds(dkSpreadHome?.odds),
      dkTotal: dkPoint(dkTotalOver?.value ?? (sport === "ncaaf" ? dkTotalUnder?.value : undefined)),
      dkOverOdds: fmtOdds(dkTotalOver?.odds),
      dkUnderOdds: fmtOdds(dkTotalUnder?.odds),
      dkAwayML: fmtOdds(dkMlAway?.odds),
      dkHomeML: fmtOdds(dkMlHome?.odds),

      // FanDuel NJ spread (NHL puck line fallback)
      fdAwaySpread: roundHalf(fdSpreadAway?.value),
      fdAwaySpreadOdds: fmtOdds(fdSpreadAway?.odds),
      fdHomeSpread: roundHalf(fdSpreadHome?.value),
      fdHomeSpreadOdds: fmtOdds(fdSpreadHome?.odds),
    });
  }

  debugLog(
    "ANApiOdds",
    "info",
    `[ActionNetwork][v2] ${sport.toUpperCase()} ${date}: ` +
      `${results.length} games returned | ` +
      `${results.filter(g => g.dkAwaySpread != null || g.dkTotal != null || g.dkAwayML != null).length} with DK NJ odds | ` +
      `${results.filter(g => g.openAwaySpread != null || g.openTotal != null || g.openAwayML != null).length} with Open odds | ` +
      `${skippedNoDk} without DK (included for Open) | ` +
      `${skippedNoTeam} skipped (no team data)`
  );

  return results;
}
