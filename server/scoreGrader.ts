/**
 * scoreGrader.ts — Official league score fetcher + deterministic bet grading engine.
 *
 * Score sources (all public, no API key required):
 *   MLB  → statsapi.mlb.com/api/v1/schedule  (innings-level linescore)
 *   NHL  → api-web.nhle.com/v1/score/{date}  + /gamecenter/{id}/landing
 *   NBA  → site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard
 *   NCAAM → site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard
 *
 * Grading logic (deterministic, no heuristics):
 *   ML    → winner by final score (or regulation score for REGULATION timeframe)
 *   RL    → winner covers the run/puck line (±1.5 for MLB/NHL, ±spread for NBA/NCAAM)
 *   TOTAL → final total vs. the line (OVER/UNDER)
 *
 * Timeframe mapping:
 *   FULL_GAME    → full final score
 *   REGULATION   → score after 3 periods (NHL only, OT/SO excluded)
 *   FIRST_PERIOD → score after period 1 (NHL)
 *   FIRST_HALF   → score after 2 quarters (NBA) or halftime (NCAAM)
 *   FIRST_QUARTER → score after Q1 (NBA)
 *   FIRST_5      → score after 5 innings (MLB)
 *   FIRST_INNING → score after inning 1 (MLB)
 *
 * Logging convention:
 *   [ScoreGrader][INPUT]  — raw inputs
 *   [ScoreGrader][STEP]   — fetch/parse operation
 *   [ScoreGrader][STATE]  — intermediate values
 *   [ScoreGrader][OUTPUT] — grading result
 *   [ScoreGrader][VERIFY] — validation pass/fail
 *   [ScoreGrader][ERROR]  — failure with context
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type Sport = "NCAAF" | "MLB" | "NHL" | "NBA" | "NCAAM" | "NFL";

export type Timeframe =
  | "FULL_GAME"
  | "REGULATION"
  | "FIRST_PERIOD"
  | "FIRST_HALF"
  | "FIRST_QUARTER"
  | "FIRST_5"
  | "FIRST_INNING"
  | "NRFI"
  | "YRFI";

export type Market = "ML" | "RL" | "TOTAL";
export type PickSide = "AWAY" | "HOME" | "OVER" | "UNDER";
export type GradeResult = "WIN" | "LOSS" | "PUSH" | "PENDING" | "VOID" | "NO_RESULT";

// ─── Settlement state machine ────────────────────────────────────────────────
//
// Every upstream feed reports game status as free text with its own vocabulary.
// Collapsing that to four states in ONE place is what lets a bet reach a
// terminal result instead of sitting PENDING forever.
//
//   FINAL       → the timeframe can be graded
//   IN_PROGRESS → started, not finished; try again later
//   SCHEDULED   → not started; try again later
//   NO_CONTEST  → the game will never produce a result (postponed, cancelled).
//                 The bet is VOID: the stake comes back, and it leaves the
//                 pending pool so the grader stops re-scanning it every cycle.
//
// "Completed Early" (rain-shortened but official, MLB reports it as e.g.
// "Completed Early: Rain") is FINAL — books grade those, and treating it as
// non-final was leaving legitimately settled games unsettled indefinitely.
//
// "Suspended" is IN_PROGRESS on purpose: MLB resumes suspended games, so
// voiding them would settle bets that are still live.

export type SettlementState = "FINAL" | "IN_PROGRESS" | "SCHEDULED" | "NO_CONTEST";

const NO_CONTEST_SUBSTRINGS = ["postponed", "cancel"] as const;
const NO_CONTEST_EXACT = ["ppd"] as const;
const FINAL_SUBSTRINGS = ["final", "game over", "completed early"] as const;
const FINAL_EXACT = ["off"] as const; // NHL reports a finished game as gameState "OFF"
const IN_PROGRESS_SUBSTRINGS = [
  "progress", "live", "warmup", "delayed", "suspended",
  "manager challenge", "instant replay", "under review",
  // NOT a bare "review": MLB/ESPN report a not-yet-started game as "Preview",
  // which contains it. That misread every scheduled game as live and forced the
  // short (60s) score-cache TTL on slates with nothing in progress.
] as const;
const IN_PROGRESS_EXACT = ["in", "crit"] as const; // ESPN "in", NHL "CRIT"

/**
 * Classify a raw upstream game-state string into a settlement state.
 * Total function: unknown vocabulary falls back to SCHEDULED (never grade on a
 * state we do not understand).
 *
 * Short codes ("OFF", "IN", "CRIT", "PPD") match exactly rather than by
 * substring so they cannot fire inside an unrelated word.
 */
export function classifyGameState(rawState: string | null | undefined): SettlementState {
  const s = (rawState ?? "").trim().toLowerCase();
  if (!s) return "SCHEDULED";
  // No-contest wins over everything: "Postponed" must never be read as "Final".
  if (NO_CONTEST_EXACT.includes(s as typeof NO_CONTEST_EXACT[number])) return "NO_CONTEST";
  if (NO_CONTEST_SUBSTRINGS.some(m => s.includes(m))) return "NO_CONTEST";
  if (IN_PROGRESS_EXACT.includes(s as typeof IN_PROGRESS_EXACT[number])) return "IN_PROGRESS";
  if (IN_PROGRESS_SUBSTRINGS.some(m => s.includes(m))) return "IN_PROGRESS";
  if (FINAL_EXACT.includes(s as typeof FINAL_EXACT[number])) return "FINAL";
  if (FINAL_SUBSTRINGS.some(m => s.includes(m))) return "FINAL";
  return "SCHEDULED";
}

/** True when the game reached a state that can be graded as a completed contest. */
export function isFinalState(rawState: string | null | undefined): boolean {
  return classifyGameState(rawState) === "FINAL";
}

/** Scores for a specific timeframe window */
export interface TimeframeScore {
  awayScore: number;
  homeScore: number;
  /** True = game is final for this timeframe (e.g. game over, or period completed) */
  isFinal: boolean;
  /** Human-readable label for logging */
  label: string;
}

/** Full score data for a game, keyed by timeframe */
export interface GameScoreData {
  sport: Sport;
  gameId: string;
  /** ISO UTC start time (e.g. "2026-04-30T16:35:00Z") — used for DH G1/G2 chronological ordering */
  startTime: string;
  awayAbbrev: string;
  homeAbbrev: string;
  gameState: string; // "Final", "Live", "Scheduled", "OFF", etc.
  scores: Partial<Record<Timeframe, TimeframeScore>>;
}

/** Input for grading a single bet */
export interface BetGradeInput {
  sport: Sport;
  gameDate: string;       // YYYY-MM-DD
  awayTeam: string;       // team abbreviation (e.g. "HOU", "CAR")
  homeTeam: string;
  timeframe: Timeframe;
  market: Market;
  pickSide: PickSide;
  odds: number;           // American odds
  line?: number | null;   // RL spread or Total line (e.g. -1.5, 8.5)
  anGameId?: number | null;
  /**
   * Doubleheader game number: 1 = G1, 2 = G2.
   * Used when anGameId cannot be matched by gamePk (AN IDs ≠ MLB Stats API gamePk).
   * When gameNumber=2, the fallback team-name match sorts by startTime ASC and returns G2.
   * G1/G2 is determined by chronological start time (NOT gamePk order).
   * NOTE: gamePk order does NOT reliably match chronological order
   * (e.g. SF@PHI 2026-04-30: gamePk=823471 starts 21:35Z but gamePk=823472 starts 16:35Z).
   */
  gameNumber?: 1 | 2;
}

export interface BetGradeOutput {
  result: GradeResult;
  awayScore: number | null;
  homeScore: number | null;
  gameState: string;
  reason: string;
  /** Actual away abbreviation from the official API (may differ from stored awayTeam) */
  awayAbbrev: string | null;
  /** Actual home abbreviation from the official API (may differ from stored homeTeam) */
  homeAbbrev: string | null;
}

// ─── Score cache (5-min TTL, keyed by "sport:date") ──────────────────────────

interface CacheEntry {
  data: GameScoreData[];
  fetchedAt: number;
}

const scoreCache = new Map<string, CacheEntry>();
// TTL policy:
//   LIVE games  → 60s  (scores change rapidly; we need near-real-time grading)
//   FINAL games → 5min (immutable; no need to re-fetch)
//   MIXED slate → 60s  (any live game in the slate forces short TTL)
const SCORE_CACHE_TTL_LIVE_MS  =  60 * 1000; //  60 seconds — live/in-progress games
const SCORE_CACHE_TTL_FINAL_MS = 5 * 60 * 1000; //  5 minutes  — all games final

/** Returns true if any game in the data set is still live (not yet final) */
function hasLiveGame(data: GameScoreData[]): boolean {
  return data.some(g => classifyGameState(g.gameState) === "IN_PROGRESS");
}

function getCached(key: string): GameScoreData[] | null {
  const entry = scoreCache.get(key);
  if (!entry) return null;
  // Use short TTL if any game is live, long TTL if all final
  const ttl = hasLiveGame(entry.data) ? SCORE_CACHE_TTL_LIVE_MS : SCORE_CACHE_TTL_FINAL_MS;
  if (Date.now() - entry.fetchedAt > ttl) {
    scoreCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: GameScoreData[]): void {
  scoreCache.set(key, { data, fetchedAt: Date.now() });
}

// ─── MLB Score Fetcher ────────────────────────────────────────────────────────

async function fetchMlbScores(date: string): Promise<GameScoreData[]> {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore,team`;
  console.log(`[ScoreGrader][STEP] MLB fetch: GET ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    console.log(`[ScoreGrader][ERROR] MLB fetch failed: status=${res.status}`);
    return [];
  }
  const json = await res.json() as {
    dates?: Array<{ games: Array<{
      gamePk: number;
      /** ISO UTC start time (e.g. "2026-04-30T16:35:00Z") */
      gameDate: string;
      status: { detailedState: string };
      teams: {
        away: { team: { abbreviation?: string; name: string }; score?: number };
        home: { team: { abbreviation?: string; name: string }; score?: number };
      };
      linescore?: {
        currentInning?: number;
        teams?: { away?: { runs?: number }; home?: { runs?: number } };
        innings?: Array<{
          num: number;
          away: { runs?: number };
          home: { runs?: number };
        }>;
      };
    }> }>
  };

  const dates = json.dates ?? [];
  if (!dates.length) {
    console.log(`[ScoreGrader][STATE] MLB: no games found for date=${date}`);
    return [];
  }

  const games = dates[0].games ?? [];
  console.log(`[ScoreGrader][STATE] MLB: ${games.length} games found for date=${date}`);

  return games.map(g => {
    const ls = g.linescore ?? {};
    const innings = ls.innings ?? [];
    const gameState = g.status.detailedState;

    // Full game score
    const awayFull = g.teams.away.score ?? 0;
    const homeFull = g.teams.home.score ?? 0;
    // Includes "Completed Early: <reason>" (rain-shortened but official). Excludes
    // Postponed/Cancelled, which are handled as NO_CONTEST → VOID in gradeTrackedBet.
    const isFinalFull = isFinalState(gameState);

    // First inning score (sum of inning 1 only)
    const inn1 = innings.find(i => i.num === 1);
    const awayF1 = inn1?.away?.runs ?? 0;
    const homeF1 = inn1?.home?.runs ?? 0;
    // F1 is final when inning 1 is complete:
    //   - game is over (isFinalFull), OR
    //   - we are past inning 1 (currentInning > 1), OR
    //   - we are in the bottom of inning 1 and home has scored (inningState = End/Middle = top complete)
    const isFinalF1 = innings.length >= 1 && (
      isFinalFull ||
      (ls.currentInning ?? 0) > 1
    );

    // NRFI/YRFI: same window as FIRST_INNING but graded as TOTAL (0.5 line)
    // NRFI = UNDER 0.5 total runs in inning 1 (no runs scored = WIN for NRFI)
    // YRFI = OVER 0.5 total runs in inning 1 (at least 1 run scored = WIN for YRFI)
    // Both use the same score window as FIRST_INNING
    const awayNrfi = awayF1;
    const homeNrfi = homeF1;
    const isFinalNrfi = isFinalF1;

    // First 5 innings score (sum innings 1-5)
    const awayF5 = innings.filter(i => i.num <= 5).reduce((s, i) => s + (i.away?.runs ?? 0), 0);
    const homeF5 = innings.filter(i => i.num <= 5).reduce((s, i) => s + (i.home?.runs ?? 0), 0);
    // F5 is final when inning 5 is complete:
    //   - game is over (isFinalFull), OR
    //   - we are past inning 5 (currentInning > 5)
    const isFinalF5 = isFinalFull || (ls.currentInning ?? 0) > 5;

    // Derive abbreviation from team name if not present
    const awayAbbrev = g.teams.away.team.abbreviation ?? g.teams.away.team.name.split(" ").pop() ?? "UNK";
    const homeAbbrev = g.teams.home.team.abbreviation ?? g.teams.home.team.name.split(" ").pop() ?? "UNK";

    console.log(`[ScoreGrader][STATE] MLB game=${g.gamePk} ${awayAbbrev}@${homeAbbrev} state=${gameState} full=${awayFull}-${homeFull} f5=${awayF5}-${homeF5} f1=${awayF1}-${homeF1} nrfi/yrfi_total=${awayF1+homeF1} isFinalF1=${isFinalF1} isFinalF5=${isFinalF5}`);

    return {
      sport: "MLB" as Sport,
      gameId: String(g.gamePk),
      startTime: g.gameDate ?? "",
      awayAbbrev,
      homeAbbrev,
      gameState,
      scores: {
        FULL_GAME:    { awayScore: awayFull,  homeScore: homeFull,  isFinal: isFinalFull,  label: "Full Game" },
        FIRST_5:      { awayScore: awayF5,    homeScore: homeF5,    isFinal: isFinalF5,    label: "First 5 Innings" },
        FIRST_INNING: { awayScore: awayF1,    homeScore: homeF1,    isFinal: isFinalF1,    label: "First Inning" },
        NRFI:         { awayScore: awayNrfi,  homeScore: homeNrfi,  isFinal: isFinalNrfi,  label: "NRFI (Inning 1 Total)" },
        YRFI:         { awayScore: awayNrfi,  homeScore: homeNrfi,  isFinal: isFinalNrfi,  label: "YRFI (Inning 1 Total)" },
      },
    };
  });
}

// ─── NHL Score Fetcher ────────────────────────────────────────────────────────

async function fetchNhlScores(date: string): Promise<GameScoreData[]> {
  const url = `https://api-web.nhle.com/v1/score/${date}`;
  console.log(`[ScoreGrader][STEP] NHL fetch: GET ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    console.log(`[ScoreGrader][ERROR] NHL fetch failed: status=${res.status}`);
    return [];
  }
  const json = await res.json() as {
    games?: Array<{
      id: number;
      gameState: string;
      awayTeam: { abbrev: string; score?: number };
      homeTeam: { abbrev: string; score?: number };
      periodDescriptor?: { number: number; periodType: string };
    }>
  };

  const games = json.games ?? [];
  console.log(`[ScoreGrader][STATE] NHL: ${games.length} games found for date=${date}`);

  // Fetch period-level scores for each game in parallel
  const results = await Promise.all(games.map(async g => {
    const awayFull = g.awayTeam.score ?? 0;
    const homeFull = g.homeTeam.score ?? 0;
    const gameState = g.gameState; // "OFF" = final, "LIVE" = in progress, "PRE" = scheduled
    const isFinalFull = isFinalState(gameState);

    // Fetch period-by-period scores from landing endpoint
    let awayP1 = 0, homeP1 = 0;
    let awayReg = 0, homeReg = 0;
    let isFinalP1 = false;
    let isFinalReg = false;

    try {
      const landingUrl = `https://api-web.nhle.com/v1/gamecenter/${g.id}/landing`;
      const lr = await fetch(landingUrl);
      if (lr.ok) {
        const ld = await lr.json() as {
          summary?: {
            scoring?: Array<{
              periodDescriptor: { number: number; periodType: string };
              goals: Array<{ awayScore: number; homeScore: number }>;
            }>
          };
          periodDescriptor?: { number: number; periodType: string };
        };
        const scoring = ld.summary?.scoring ?? [];
        const currentPeriod = ld.periodDescriptor?.number ?? 0;
        const currentPeriodType = ld.periodDescriptor?.periodType ?? "REG";

        // Period 1 score: last goal of period 1
        const p1Goals = scoring.find(s => s.periodDescriptor.number === 1)?.goals ?? [];
        if (p1Goals.length > 0) {
          const last = p1Goals[p1Goals.length - 1];
          awayP1 = last.awayScore;
          homeP1 = last.homeScore;
        }
        isFinalP1 = isFinalFull || currentPeriod > 1;

        // Regulation score: last goal of period 3 (exclude OT/SO)
        const p3Goals = scoring.find(s => s.periodDescriptor.number === 3)?.goals ?? [];
        if (p3Goals.length > 0) {
          const last = p3Goals[p3Goals.length - 1];
          awayReg = last.awayScore;
          homeReg = last.homeScore;
        } else if (currentPeriod >= 3) {
          // No goals in P3 — carry P2 score
          const p2Goals = scoring.find(s => s.periodDescriptor.number === 2)?.goals ?? [];
          if (p2Goals.length > 0) {
            const last = p2Goals[p2Goals.length - 1];
            awayReg = last.awayScore;
            homeReg = last.homeScore;
          }
        }
        isFinalReg = isFinalFull || currentPeriod > 3 || (currentPeriod === 3 && currentPeriodType !== "REG");

        console.log(`[ScoreGrader][STATE] NHL game=${g.id} ${g.awayTeam.abbrev}@${g.homeTeam.abbrev} state=${gameState} full=${awayFull}-${homeFull} reg=${awayReg}-${homeReg} p1=${awayP1}-${homeP1}`);
      }
    } catch (err) {
      console.log(`[ScoreGrader][ERROR] NHL landing fetch failed for gameId=${g.id}: ${err}`);
    }

    return {
      sport: "NHL" as Sport,
      gameId: String(g.id),
      startTime: "", // NHL API does not return ISO UTC start time in this endpoint
      awayAbbrev: g.awayTeam.abbrev,
      homeAbbrev: g.homeTeam.abbrev,
      gameState,
      scores: {
        FULL_GAME:    { awayScore: awayFull, homeScore: homeFull, isFinal: isFinalFull, label: "Full Game" },
        REGULATION:   { awayScore: awayReg,  homeScore: homeReg,  isFinal: isFinalReg,  label: "Regulation" },
        FIRST_PERIOD: { awayScore: awayP1,   homeScore: homeP1,   isFinal: isFinalP1,   label: "1st Period" },
      },
    };
  }));

  return results;
}

// ─── NBA Score Fetcher ────────────────────────────────────────────────────────

async function fetchNbaScores(date: string): Promise<GameScoreData[]> {
  const dateStr = date.replace(/-/g, ""); // YYYYMMDD
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${dateStr}`;
  console.log(`[ScoreGrader][STEP] NBA fetch: GET ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    console.log(`[ScoreGrader][ERROR] NBA fetch failed: status=${res.status}`);
    return [];
  }
  const json = await res.json() as {
    events?: Array<{
      id: string;
      competitions: Array<{
        status: { type: { description: string; completed: boolean } };
        competitors: Array<{
          homeAway: string;
          team: { abbreviation: string };
          score: string;
          linescores?: Array<{ value: number }>;
        }>;
      }>;
    }>
  };

  const events = json.events ?? [];
  console.log(`[ScoreGrader][STATE] NBA: ${events.length} games found for date=${date}`);

  return events.map(e => {
    const comp = e.competitions[0];
    const status = comp.status.type.description;
    const isFinalFull = comp.status.type.completed;

    // ESPN returns competitors[0] = home, competitors[1] = away
    const homeComp = comp.competitors.find(c => c.homeAway === "home")!;
    const awayComp = comp.competitors.find(c => c.homeAway === "away")!;

    const awayFull = parseFloat(awayComp.score ?? "0") || 0;
    const homeFull = parseFloat(homeComp.score ?? "0") || 0;

    // Quarter linescores: [Q1, Q2, Q3, Q4, OT...]
    const awayQs = (awayComp.linescores ?? []).map(l => l.value);
    const homeQs = (homeComp.linescores ?? []).map(l => l.value);

    // Q1 score
    const awayQ1 = awayQs[0] ?? 0;
    const homeQ1 = homeQs[0] ?? 0;
    const isFinalQ1 = isFinalFull || awayQs.length > 1;

    // First half score (Q1+Q2)
    const awayH1 = (awayQs[0] ?? 0) + (awayQs[1] ?? 0);
    const homeH1 = (homeQs[0] ?? 0) + (homeQs[1] ?? 0);
    const isFinalH1 = isFinalFull || awayQs.length > 2;

    console.log(`[ScoreGrader][STATE] NBA game=${e.id} ${awayComp.team.abbreviation}@${homeComp.team.abbreviation} state=${status} full=${awayFull}-${homeFull} h1=${awayH1}-${homeH1} q1=${awayQ1}-${homeQ1}`);

    return {
      sport: "NBA" as Sport,
      gameId: e.id,
      startTime: "", // ESPN API does not return ISO UTC start time in this endpoint
      awayAbbrev: awayComp.team.abbreviation,
      homeAbbrev: homeComp.team.abbreviation,
      gameState: status,
      scores: {
        FULL_GAME:     { awayScore: awayFull, homeScore: homeFull, isFinal: isFinalFull, label: "Full Game" },
        FIRST_HALF:    { awayScore: awayH1,   homeScore: homeH1,   isFinal: isFinalH1,   label: "1st Half" },
        FIRST_QUARTER: { awayScore: awayQ1,   homeScore: homeQ1,   isFinal: isFinalQ1,   label: "1st Quarter" },
      },
    };
  });
}

// ─── NCAAM Score Fetcher ──────────────────────────────────────────────────────

/**
 * NFL scores from the ESPN scoreboard — same envelope as NBA/NCAAM.
 *
 * `linescores` is [Q1, Q2, Q3, Q4, OT...]. That trailing OT entry is why
 * REGULATION exists here and not just for NHL: a game tied after four quarters
 * is decided in overtime, so the regulation result and the final result are
 * genuinely different bets.
 *
 * Real example (2025-11-09, ATL@IND): final 25-31, quarters 7/7/3/8 and
 * 13/0/0/12 with 0 and 6 in OT. Regulation was 25-25 — a PUSH on the moneyline
 * where the full game was an IND win.
 */
async function fetchNflScores(
  date: string,
  sport: "NFL" | "NCAAF" = "NFL"
): Promise<GameScoreData[]> {
  const dateStr = date.replace(/-/g, ""); // YYYYMMDD
  const league = sport === "NCAAF" ? "college-football" : "nfl";
  const groups = sport === "NCAAF" ? "&groups=80&limit=400" : "";
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/${league}/scoreboard?dates=${dateStr}${groups}`;
  console.log(`[ScoreGrader][STEP] ${sport} fetch: GET ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    console.log(`[ScoreGrader][ERROR] ${sport} fetch failed: status=${res.status}`);
    return [];
  }
  const json = await res.json() as {
    events?: Array<{
      id: string;
      competitions: Array<{
        status: { type: { description: string; completed: boolean } };
        competitors: Array<{
          homeAway: string;
          team: { abbreviation: string };
          score: string;
          linescores?: Array<{ value: number }>;
        }>;
      }>;
    }>
  };

  const events = json.events ?? [];
  console.log(`[ScoreGrader][STATE] ${sport}: ${events.length} games found for date=${date}`);

  return events.map(e => {
    const comp = e.competitions[0];
    const status = comp.status.type.description;
    const isFinalFull = comp.status.type.completed;

    const homeComp = comp.competitors.find(c => c.homeAway === "home")!;
    const awayComp = comp.competitors.find(c => c.homeAway === "away")!;

    const awayFull = parseFloat(awayComp.score ?? "0") || 0;
    const homeFull = parseFloat(homeComp.score ?? "0") || 0;

    const awayQs = (awayComp.linescores ?? []).map(l => l.value);
    const homeQs = (homeComp.linescores ?? []).map(l => l.value);

    const sum = (qs: number[], from: number, to: number): number =>
      qs.slice(from, to).reduce((a, b) => a + (b ?? 0), 0);

    const awayQ1 = awayQs[0] ?? 0;
    const homeQ1 = homeQs[0] ?? 0;
    const isFinalQ1 = isFinalFull || awayQs.length > 1;

    const awayH1 = sum(awayQs, 0, 2);
    const homeH1 = sum(homeQs, 0, 2);
    const isFinalH1 = isFinalFull || awayQs.length > 2;

    // Regulation is the first FOUR quarters only. Anything beyond index 3 is
    // overtime and must not count, which is the entire point of the timeframe.
    const awayReg = sum(awayQs, 0, 4);
    const homeReg = sum(homeQs, 0, 4);
    const isFinalReg = isFinalFull || awayQs.length > 4;

    console.log(`[ScoreGrader][STATE] ${sport} game=${e.id} ${awayComp.team.abbreviation}@${homeComp.team.abbreviation} state=${status} full=${awayFull}-${homeFull} reg=${awayReg}-${homeReg} h1=${awayH1}-${homeH1} q1=${awayQ1}-${homeQ1}`);

    return {
      sport,
      gameId: e.id,
      startTime: "",
      awayAbbrev: awayComp.team.abbreviation,
      homeAbbrev: homeComp.team.abbreviation,
      gameState: status,
      scores: {
        FULL_GAME:     { awayScore: awayFull, homeScore: homeFull, isFinal: isFinalFull, label: "Full Game" },
        REGULATION:    { awayScore: awayReg,  homeScore: homeReg,  isFinal: isFinalReg,  label: "Regulation" },
        FIRST_HALF:    { awayScore: awayH1,   homeScore: homeH1,   isFinal: isFinalH1,   label: "1st Half" },
        FIRST_QUARTER: { awayScore: awayQ1,   homeScore: homeQ1,   isFinal: isFinalQ1,   label: "1st Quarter" },
      },
    };
  });
}

async function fetchNcaafScores(date: string): Promise<GameScoreData[]> {
  return fetchNflScores(date, "NCAAF");
}

async function fetchNcaamScores(date: string): Promise<GameScoreData[]> {
  const dateStr = date.replace(/-/g, "");
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${dateStr}&limit=200`;
  console.log(`[ScoreGrader][STEP] NCAAM fetch: GET ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    console.log(`[ScoreGrader][ERROR] NCAAM fetch failed: status=${res.status}`);
    return [];
  }
  const json = await res.json() as {
    events?: Array<{
      id: string;
      competitions: Array<{
        status: { type: { description: string; completed: boolean } };
        competitors: Array<{
          homeAway: string;
          team: { abbreviation: string };
          score: string;
          linescores?: Array<{ value: number }>;
        }>;
      }>;
    }>
  };

  const events = json.events ?? [];
  console.log(`[ScoreGrader][STATE] NCAAM: ${events.length} games found for date=${date}`);

  return events.map(e => {
    const comp = e.competitions[0];
    const status = comp.status.type.description;
    const isFinalFull = comp.status.type.completed;

    const homeComp = comp.competitors.find(c => c.homeAway === "home")!;
    const awayComp = comp.competitors.find(c => c.homeAway === "away")!;

    const awayFull = parseFloat(awayComp.score ?? "0") || 0;
    const homeFull = parseFloat(homeComp.score ?? "0") || 0;

    // NCAAM uses 2 halves
    const awayHalves = (awayComp.linescores ?? []).map(l => l.value);
    const homeHalves = (homeComp.linescores ?? []).map(l => l.value);

    const awayH1 = awayHalves[0] ?? 0;
    const homeH1 = homeHalves[0] ?? 0;
    const isFinalH1 = isFinalFull || awayHalves.length > 1;

    return {
      sport: "NCAAM" as Sport,
      gameId: e.id,
      startTime: "", // ESPN API does not return ISO UTC start time in this endpoint
      awayAbbrev: awayComp.team.abbreviation,
      homeAbbrev: homeComp.team.abbreviation,
      gameState: status,
      scores: {
        FULL_GAME:  { awayScore: awayFull, homeScore: homeFull, isFinal: isFinalFull, label: "Full Game" },
        FIRST_HALF: { awayScore: awayH1,   homeScore: homeH1,   isFinal: isFinalH1,   label: "1st Half" },
      },
    };
  });
}

// ─── Public: Fetch all scores for a sport + date ──────────────────────────────

export async function fetchScores(sport: Sport, date: string): Promise<GameScoreData[]> {
  const cacheKey = `${sport}:${date}`;
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[ScoreGrader][STEP] Cache HIT for ${cacheKey} (${cached.length} games)`);
    return cached;
  }

  console.log(`[ScoreGrader][STEP] Cache MISS for ${cacheKey} — fetching from API`);
  let data: GameScoreData[] = [];

  switch (sport) {
    case "NCAAF": data = await fetchNcaafScores(date); break;
    case "MLB":   data = await fetchMlbScores(date);   break;
    case "NHL":   data = await fetchNhlScores(date);   break;
    case "NBA":   data = await fetchNbaScores(date);   break;
    case "NCAAM": data = await fetchNcaamScores(date); break;
    case "NFL":   data = await fetchNflScores(date);   break;
    default:
      console.log(`[ScoreGrader][ERROR] Unknown sport: ${sport}`);
  }

  setCache(cacheKey, data);
  console.log(`[ScoreGrader][OUTPUT] fetchScores: sport=${sport} date=${date} → ${data.length} games cached`);
  return data;
}

// ─── Abbreviation normalizer ──────────────────────────────────────────────────
// Maps common AN abbreviation variants to the official league abbreviation

const ABBREV_ALIASES: Record<string, string> = {
  // NCAAF — ESPN and Action Network use different abbreviations.
  "RUTG": "RUT",
  "WAKE": "WF",
  // MLB — normalize MLB Stats API abbreviations to AN canonical form
  "AZ":  "ARI",  // Diamondbacks: MLB Stats API returns "AZ", AN/DB uses "ARI"
  "KC":  "KC",   // Royals — AN sends KC, MLB API sends KC
  "TB":  "TB",   // Rays (MLB)
  "ATH": "ATH",  // Athletics (new Oakland → ATH)
  "WSH": "WSH",  // Nationals
  "SD":  "SD",   // Padres
  "SF":  "SF",   // Giants
  // NHL
  "VGK": "VGK",  // Vegas Golden Knights
  "SJS": "SJS",  // San Jose Sharks (sometimes SJ)
  "SJ":  "SJS",
  "TBL": "TBL",  // Tampa Bay Lightning (sometimes TBL)
  "NJD": "NJD",  // New Jersey Devils (sometimes NJ)
  "NJ":  "NJD",
  // NBA
  "GS":  "GSW",  // Golden State Warriors
  "GSW": "GSW",
  "SA":  "SAS",  // San Antonio Spurs
  "SAS": "SAS",
  "NO":  "NOP",  // New Orleans Pelicans
  "NOP": "NOP",
};

function normalizeAbbrev(abbrev: string): string {
  return ABBREV_ALIASES[abbrev.toUpperCase()] ?? abbrev.toUpperCase();
}

// ─── Game matcher ─────────────────────────────────────────────────────────────

/**
 * Find a game in the score data by matching team abbreviations.
 * Uses fuzzy matching to handle AN vs. official API abbreviation differences.
 */
export function findGame(
  games: GameScoreData[],
  awayAbbrev: string,
  homeAbbrev: string,
): GameScoreData | null {
  const normAway = normalizeAbbrev(awayAbbrev);
  const normHome = normalizeAbbrev(homeAbbrev);

  console.log(`[ScoreGrader][STEP] findGame: looking for ${normAway}@${normHome} among ${games.length} games`);

  for (const g of games) {
    const ga = normalizeAbbrev(g.awayAbbrev);
    const gh = normalizeAbbrev(g.homeAbbrev);
    if (ga === normAway && gh === normHome) {
      console.log(`[ScoreGrader][VERIFY] findGame: MATCH found — gameId=${g.gameId} ${ga}@${gh}`);
      return g;
    }
  }

  // Fallback: prefix match for feed-vocabulary drift the alias table has not
  // caught up with (e.g. a provider renaming a franchise mid-season).
  //
  // This fallback decides where money goes, so it must never GUESS. A 2-char
  // prefix is ambiguous across real MLB abbreviations — AT (ATH/ATL), LA
  // (LAA/LAD), MI (MIA/MIL/MIN), NY (NYM/NYY) — and same-city teams frequently
  // play on the same date. The previous version returned the FIRST prefix hit,
  // so a bet on NYM@LAA could silently grade against NYY@LAD: a real result,
  // for the wrong game, indistinguishable from a correct one afterwards.
  //
  // Now: collect every candidate, and only accept a UNIQUE one. Ambiguity
  // returns null, which leaves the bet PENDING with a logged reason — a visible
  // non-event instead of an invisible wrong answer.
  const candidates = games.filter(g => {
    const ga = normalizeAbbrev(g.awayAbbrev);
    const gh = normalizeAbbrev(g.homeAbbrev);
    return ga.startsWith(normAway.slice(0, 2)) && gh.startsWith(normHome.slice(0, 2));
  });

  if (candidates.length === 1) {
    const g = candidates[0];
    console.log(`[ScoreGrader][VERIFY] findGame: UNIQUE PREFIX MATCH — gameId=${g.gameId} ${normalizeAbbrev(g.awayAbbrev)}@${normalizeAbbrev(g.homeAbbrev)} (searched ${normAway}@${normHome})`);
    return g;
  }
  if (candidates.length > 1) {
    const shown = candidates
      .map(g => `${normalizeAbbrev(g.awayAbbrev)}@${normalizeAbbrev(g.homeAbbrev)}(${g.gameId})`)
      .join(", ");
    console.log(
      `[ScoreGrader][ERROR] findGame: AMBIGUOUS prefix match for ${normAway}@${normHome} — ` +
      `${candidates.length} candidates [${shown}]. Refusing to guess; bet stays PENDING. ` +
      `Add the correct mapping to ABBREV_ALIASES.`
    );
    return null;
  }

  console.log(`[ScoreGrader][VERIFY] findGame: NO MATCH for ${normAway}@${normHome}`);
  return null;
}

// ─── Deterministic Grading Engine ────────────────────────────────────────────

/**
 * Grade a bet deterministically from a TimeframeScore.
 *
 * ML:
 *   AWAY wins → AWAY ML = WIN, HOME ML = LOSS
 *   HOME wins → HOME ML = WIN, AWAY ML = LOSS
 *   Tie       → PUSH (only possible in NCAAM OT, NHL regulation tie before OT)
 *
 * RL (Run Line / Puck Line / Spread):
 *   The signed spread from the picked side's perspective is REQUIRED — there is
 *   no default. Missing line → NO_RESULT (the bet stays PENDING with a reason).
 *   AWAY covers → AWAY RL = WIN
 *   HOME covers → HOME RL = WIN
 *   Exact cover → PUSH
 *
 * TOTAL:
 *   OVER → total > line = WIN, total < line = LOSS, total = line = PUSH
 *   UNDER → total < line = WIN, total > line = LOSS, total = line = PUSH
 */
export function gradeBet(
  score: TimeframeScore,
  market: Market,
  pickSide: PickSide,
  line: number | null | undefined,
  sport: Sport,
): GradeResult {
  const { awayScore, homeScore } = score;
  const total = awayScore + homeScore;

  console.log(`[ScoreGrader][INPUT] gradeBet: market=${market} pickSide=${pickSide} line=${line} sport=${sport} score=${awayScore}-${homeScore} total=${total}`);

  if (market === "ML") {
    if (awayScore > homeScore) {
      const result = pickSide === "AWAY" ? "WIN" : "LOSS";
      console.log(`[ScoreGrader][OUTPUT] gradeBet ML: AWAY wins ${awayScore}-${homeScore} → ${result}`);
      return result;
    } else if (homeScore > awayScore) {
      const result = pickSide === "HOME" ? "WIN" : "LOSS";
      console.log(`[ScoreGrader][OUTPUT] gradeBet ML: HOME wins ${homeScore}-${awayScore} → ${result}`);
      return result;
    } else {
      console.log(`[ScoreGrader][OUTPUT] gradeBet ML: TIE ${awayScore}-${homeScore} → PUSH`);
      return "PUSH";
    }
  }

  if (market === "RL") {
    // No default. A missing spread used to fall back to -1.5 for MLB/NHL, which
    // inverted every underdog run line on a one-run margin, and to 0 for
    // NBA/NCAAM, which silently graded a spread bet as a moneyline. A bet with
    // no stored line is un-gradeable, and saying so keeps it PENDING instead of
    // writing a wrong result.
    if (line == null) {
      console.log(`[ScoreGrader][ERROR] gradeBet RL: no line provided → NO_RESULT`);
      return "NO_RESULT";
    }
    // RL line convention:
    //   line is stored as a SIGNED value from the pick string.
    //   e.g. "SEA RL -1.5" → line = -1.5 (SEA is favorite, must win by >1.5)
    //        "LAA RL +1.5" → line = +1.5 (LAA is underdog, can lose by <1.5)
    //
    // Grading formula (unified for both AWAY and HOME):
    //   The picked team covers if: pickedTeamScore + line > opposingTeamScore
    //   Equivalently: pickedTeamMargin + line > 0
    //
    // For AWAY pick: awayMargin = awayScore - homeScore; covers if awayMargin + line > 0
    // For HOME pick: homeMargin = homeScore - awayScore; covers if homeMargin + line > 0
    //
    const rlLine = line;

    const awayMargin = awayScore - homeScore;
    const homeMargin = homeScore - awayScore;

    const pickedMargin = pickSide === "AWAY" ? awayMargin : homeMargin;
    const coverValue = pickedMargin + rlLine;

    console.log(`[ScoreGrader][STATE] gradeBet RL: pickSide=${pickSide} pickedMargin=${pickedMargin} rlLine=${rlLine} coverValue=${coverValue}`);

    if (coverValue > 0) {
      console.log(`[ScoreGrader][OUTPUT] gradeBet RL: ${pickSide} covers (coverValue=${coverValue}) → WIN`);
      return "WIN";
    }
    if (coverValue < 0) {
      console.log(`[ScoreGrader][OUTPUT] gradeBet RL: ${pickSide} fails (coverValue=${coverValue}) → LOSS`);
      return "LOSS";
    }
    console.log(`[ScoreGrader][OUTPUT] gradeBet RL: exact push (coverValue=0) → PUSH`);
    return "PUSH";
  }

  if (market === "TOTAL") {
    if (line == null) {
      console.log(`[ScoreGrader][ERROR] gradeBet TOTAL: no line provided → NO_RESULT`);
      return "NO_RESULT";
    }
    if (pickSide === "OVER") {
      if (total > line)  { console.log(`[ScoreGrader][OUTPUT] gradeBet TOTAL: ${total} > ${line} OVER → WIN`);  return "WIN"; }
      if (total < line)  { console.log(`[ScoreGrader][OUTPUT] gradeBet TOTAL: ${total} < ${line} OVER → LOSS`); return "LOSS"; }
      console.log(`[ScoreGrader][OUTPUT] gradeBet TOTAL: ${total} = ${line} OVER → PUSH`); return "PUSH";
    } else {
      if (total < line)  { console.log(`[ScoreGrader][OUTPUT] gradeBet TOTAL: ${total} < ${line} UNDER → WIN`);  return "WIN"; }
      if (total > line)  { console.log(`[ScoreGrader][OUTPUT] gradeBet TOTAL: ${total} > ${line} UNDER → LOSS`); return "LOSS"; }
      console.log(`[ScoreGrader][OUTPUT] gradeBet TOTAL: ${total} = ${line} UNDER → PUSH`); return "PUSH";
    }
  }

  console.log(`[ScoreGrader][ERROR] gradeBet: unknown market=${market} → NO_RESULT`);
  return "NO_RESULT";
}

// ─── Public: Grade a single bet ───────────────────────────────────────────────

export async function gradeTrackedBet(input: BetGradeInput): Promise<BetGradeOutput> {
  console.log(`[ScoreGrader][INPUT] gradeTrackedBet: sport=${input.sport} date=${input.gameDate} ${input.awayTeam}@${input.homeTeam} timeframe=${input.timeframe} market=${input.market} pickSide=${input.pickSide} odds=${input.odds} line=${input.line}`);

  const games = await fetchScores(input.sport, input.gameDate);

  // ── Primary resolution: use anGameId for exact game lookup (critical for doubleheaders) ──────────
  // IMPORTANT: Action Network game IDs and MLB Stats API gamePk are DIFFERENT number spaces.
  //   AN game ID: e.g. 287818, 290399
  //   MLB gamePk: e.g. 824848, 824850
  // The anGameId match will always fail for MLB bets created via the AN primary path.
  // We keep this lookup for future cases where IDs may align (e.g. NHL, NBA via ESPN).
  let game: GameScoreData | null = null;
  if (input.anGameId != null) {
    const anIdStr = String(input.anGameId);
    game = games.find(g => g.gameId === anIdStr) ?? null;
    if (game) {
      console.log(`[ScoreGrader][STEP] gradeTrackedBet: resolved via anGameId=${input.anGameId} → gameId=${game.gameId} ${game.awayAbbrev}@${game.homeAbbrev}`);
    } else {
      console.log(`[ScoreGrader][STEP] gradeTrackedBet: anGameId=${input.anGameId} not found by direct ID match (AN ID ≠ MLB gamePk) — falling back to gameNumber-aware team-name match`);
    }
  }

  // ── Fallback: gameNumber-aware team-name match ──────────────────────────────────
  // For doubleheaders: gameNumber=1 → first match (chronologically earlier = G1)
  //                    gameNumber=2 → second match (chronologically later = G2)
  // Sort by startTime ASC (ISO UTC string comparison) for correct G1/G2 ordering.
  // IMPORTANT: gamePk order does NOT reliably match chronological order.
  // Example: SF@PHI 2026-04-30 — gamePk=823471 starts 21:35Z but gamePk=823472 starts 16:35Z.
  // For non-DH games (gameNumber=1 or undefined), findGame returns the only match.
  if (!game) {
    const gameNum = input.gameNumber ?? 1;
    if (gameNum === 2) {
      // For G2: find ALL games matching away+home, sort by startTime ASC, take index 1
      const normAway = input.awayTeam.toUpperCase();
      const normHome = input.homeTeam.toUpperCase();
      const matches = games.filter(g => {
        const ga = g.awayAbbrev.toUpperCase();
        const gh = g.homeAbbrev.toUpperCase();
        return (ga === normAway && gh === normHome) ||
               (ga.includes(normAway) || normAway.includes(ga)) && (gh.includes(normHome) || normHome.includes(gh));
      });
      // Sort by startTime ASC (chronological) — NOT by gameId/gamePk
      // Falls back to gameId sort only when startTime is empty (non-MLB sports)
      matches.sort((a, b) => {
        if (a.startTime && b.startTime) return a.startTime.localeCompare(b.startTime);
        return Number(a.gameId) - Number(b.gameId); // legacy fallback for non-MLB
      });
      game = matches[1] ?? matches[0] ?? null; // G2 = index 1; fallback to G1 if only one found
      if (game) {
        console.log(`[ScoreGrader][STEP] gradeTrackedBet: resolved G2 via gameNumber=2 team-name match → gameId=${game.gameId} ${game.awayAbbrev}@${game.homeAbbrev} (${matches.length} matches found, took index 1)`);
      } else {
        console.log(`[ScoreGrader][STEP] gradeTrackedBet: G2 team-name match found 0 games for ${input.awayTeam}@${input.homeTeam}`);
      }
    } else {
      game = findGame(games, input.awayTeam, input.homeTeam);
      if (game) {
        console.log(`[ScoreGrader][STEP] gradeTrackedBet: resolved via team-name match (gameNumber=${gameNum}) → gameId=${game.gameId} ${game.awayAbbrev}@${game.homeAbbrev}`);
      }
    }
  }

  if (!game) {
    console.log(`[ScoreGrader][VERIFY] gradeTrackedBet: FAIL — game not found for ${input.awayTeam}@${input.homeTeam} on ${input.gameDate} (anGameId=${input.anGameId ?? "null"})`);
    return {
      result: "PENDING",
      awayScore: null,
      homeScore: null,
      gameState: "NOT_FOUND",
      reason: `Game ${input.awayTeam}@${input.homeTeam} not found in ${input.sport} scores for ${input.gameDate}`,
      awayAbbrev: null,
      homeAbbrev: null,
    };
  }

  // ── Terminal no-contest: postponed / cancelled ───────────────────────────────
  // The game will never produce a result, so the bet is VOID (stake returned).
  // Before this, such bets sat PENDING forever and were re-graded by every
  // polling cycle and every nightly sweep, permanently.
  const settlement = classifyGameState(game.gameState);
  if (settlement === "NO_CONTEST") {
    console.log(`[ScoreGrader][OUTPUT] gradeTrackedBet: gameId=${game.gameId} state="${game.gameState}" → NO_CONTEST → VOID`);
    return {
      result: "VOID",
      awayScore: null,
      homeScore: null,
      gameState: game.gameState,
      reason: `Game did not take place (state=${game.gameState}) — bet voided, stake returned`,
      awayAbbrev: game.awayAbbrev,
      homeAbbrev: game.homeAbbrev,
    };
  }

  const tfScore = game.scores[input.timeframe];
  if (!tfScore) {
    console.log(`[ScoreGrader][VERIFY] gradeTrackedBet: FAIL — timeframe ${input.timeframe} not available for sport=${input.sport}`);
    return {
      result: "PENDING",
      awayScore: game.scores.FULL_GAME?.awayScore ?? null,
      homeScore: game.scores.FULL_GAME?.homeScore ?? null,
      gameState: game.gameState,
      reason: `Timeframe ${input.timeframe} not supported for ${input.sport}`,
      awayAbbrev: game.awayAbbrev,
      homeAbbrev: game.homeAbbrev,
    };
  }

  if (!tfScore.isFinal) {
    console.log(`[ScoreGrader][VERIFY] gradeTrackedBet: game=${game.gameId} timeframe=${input.timeframe} not yet final (gameState=${game.gameState})`);
    return {
      result: "PENDING",
      awayScore: tfScore.awayScore,
      homeScore: tfScore.homeScore,
      gameState: game.gameState,
      reason: `Game in progress or not yet started (state=${game.gameState})`,
      awayAbbrev: game.awayAbbrev,
      homeAbbrev: game.homeAbbrev,
    };
  }

  const result = gradeBet(tfScore, input.market, input.pickSide, input.line ?? null, input.sport);

  if (result === "NO_RESULT") {
    return {
      result: "PENDING",
      awayScore: tfScore.awayScore,
      homeScore: tfScore.homeScore,
      gameState: game.gameState,
      reason:
        `Cannot grade ${input.market} ${input.pickSide} — no line stored for this bet. ` +
        `RL and TOTAL bets require a line; edit the bet to supply one.`,
      awayAbbrev: game.awayAbbrev,
      homeAbbrev: game.homeAbbrev,
    };
  }

  console.log(`[ScoreGrader][VERIFY] gradeTrackedBet: PASS — gameId=${game.gameId} timeframe=${input.timeframe} ${tfScore.awayScore}-${tfScore.homeScore} → ${result}`);

  return {
    result,
    awayScore: tfScore.awayScore,
    homeScore: tfScore.homeScore,
    gameState: game.gameState,
    reason: `${tfScore.label}: ${tfScore.awayScore}-${tfScore.homeScore} | ${input.market} ${input.pickSide}${input.line != null ? ` ${input.line}` : ""} → ${result}`,
    awayAbbrev: game.awayAbbrev,
    homeAbbrev: game.homeAbbrev,
  };
}
