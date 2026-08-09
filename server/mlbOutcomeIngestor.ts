/**
 * mlbOutcomeIngestor.ts — Automated MLB outcome ingestion + Brier score computation.
 *
 * PURPOSE:
 *   After a game transitions to 'final', this module fetches the authoritative
 *   innings-level linescore from the MLB Stats API and writes the following to DB:
 *
 *   Outcome fields (games table):
 *     actualFgTotal      — away + home final runs (used for FG Total Brier + drift)
 *     actualF5Total      — away + home F5 runs (used for F5 Total Brier + f5_share drift)
 *     actualNrfiBinary   — 1 if no run in inning 1, 0 if run scored (used for NRFI Brier)
 *
 *   Brier score fields (games table):
 *     brierFgTotal  — (p_over - outcome_over)^2 for FG Total market
 *     brierF5Total  — (p_f5_over - outcome_f5_over)^2 for F5 Total market
 *     brierNrfi     — (p_nrfi - outcome_nrfi)^2 for NRFI market
 *     brierFgMl     — (p_home_win - outcome_home_win)^2 for FG ML market
 *     brierF5Ml     — (p_f5_home_win - outcome_f5_home_win)^2 for F5 ML market
 *     outcomeIngestedAt — UTC ms timestamp of ingestion
 *
 * PROBABILITY STORAGE SCALES (audit M-203) — READ BEFORE TOUCHING A BRIER CALL:
 *   The games table stores model probabilities on TWO different scales, and
 *   nothing in the schema or the column names distinguishes them.
 *
 *     0-100 (percent):  modelOverRate, modelHomeWinPct, modelF5HomeWinPct
 *     0-1   (unit):     modelF5OverRate, modelPNrfi
 *
 *   Verified at the producers in server/mlbModelRunner.ts:
 *     :4228 modelOverRate      = over_pct.toFixed(2)            -> 0-100
 *     :4237 modelHomeWinPct    = home_win_pct.toFixed(2)        -> 0-100
 *     :4261 modelF5HomeWinPct  = (p_f5_home_win * 100).toFixed(2) -> 0-100
 *     :4259 modelF5OverRate    = p_f5_over.toFixed(4)           -> 0-1  (NO *100)
 *     :4284 modelPNrfi         = p_nrfi.toFixed(4)              -> 0-1  (NO *100)
 *
 *   brierScore() used to divide EVERY input by 100, so the two unit-scaled
 *   columns were scored at 1/100th of their real probability: a genuine
 *   p_nrfi of 0.52 was scored as 0.0052, making brierNrfi ~0.99 on every
 *   no-run first inning. brierF5Total and brierNrfi were therefore garbage
 *   for the whole 2026 season. brierScore() now takes an ALREADY-NORMALIZED
 *   [0,1] probability and every call site declares its scale explicitly via
 *   probFromPct() or probFromUnit().
 *
 *   Historical rows do NOT self-heal: outcomeIngestedAt gates re-ingestion,
 *   so correcting stored values needs a force re-ingest by the owner.
 *
 * EXECUTION MODES (OutcomeIngestOptions) — for the M-203 correction run:
 *   dryRun     Runs every selection, matching and scoring path exactly as a
 *              live run would, then reports `would_write` instead of issuing
 *              the UPDATE. Zero database mutations. Each row carries
 *              previousBrier + brierChanged so the scope of a correction can
 *              be measured BEFORE deciding to write.
 *   historical Suppresses checkF5ShareDrift() — which takes no date, always
 *              evaluates the CURRENT rolling window, and can TRIGGER
 *              RECALIBRATION — and suppresses the owner notification. Without
 *              it, replaying a season would re-evaluate today's window once
 *              per replayed date and send one notification per date.
 *   dryRun implies historical's suppressions; a dry run has no side effects.
 *
 * NULL SEMANTICS (why the Brier fields are written as explicit null):
 *   Drizzle OMITS `undefined` columns from the SET clause. The Brier fields
 *   used to be written as undefined when null, so a FORCE re-ingest could not
 *   CLEAR a stale value that should now be null (push, tie, unparseable
 *   probability) — it could only overwrite non-null with non-null. They are
 *   now written as explicit null. The actual* fields intentionally remain
 *   `undefined`: they feed the drift detector's rolling window, and clearing
 *   them on a transient API gap would silently shrink it.
 *
 * BRIER SCORE FORMULA:
 *   BS = (p - o)^2
 *   where p = model probability [0,1], o = binary outcome (0 or 1)
 *   Range: [0, 1]. Lower = better calibration.
 *   Perfect calibration: BS = 0. Worst: BS = 1.
 *   Null if required inputs (model prob or actual score) are unavailable.
 *
 * PUSH HANDLING:
 *   If actualFgTotal == bookTotal (push), brierFgTotal = null (no outcome to score).
 *   If actualF5Total == f5Total (push), brierF5Total = null.
 *   Ties in ML (actualAway == actualHome) → brierFgMl = null.
 *
 * IDEMPOTENCY:
 *   Games with outcomeIngestedAt already set are SKIPPED unless force=true.
 *   Safe to run multiple times per day — only processes newly-final games.
 *
 * LOGGING CONVENTION:
 *   [OutcomeIngestor][INPUT]  — trigger context + date range
 *   [OutcomeIngestor][STEP]   — operation in progress
 *   [OutcomeIngestor][STATE]  — intermediate values per game
 *   [OutcomeIngestor][OUTPUT] — write result per game
 *   [OutcomeIngestor][VERIFY] — post-write validation pass/fail
 *   [OutcomeIngestor][ERROR]  — failure with context
 *   [OutcomeIngestor][SUMMARY]— batch summary
 *
 * INTEGRATION:
 *   Called by mlbNightlyCron after score refresh completes.
 *   Also exported for manual backfill via scripts/backfillOutcomes.mts.
 */

import { and, eq, isNull, isNotNull, sql, or } from "drizzle-orm";
import { getDb } from "./db";
import { games } from "../drizzle/schema";
import { notifyOwner } from "./_core/notification";
import { checkF5ShareDrift } from "./mlbDriftDetector";

// ─── Constants ────────────────────────────────────────────────────────────────

const TAG = "[OutcomeIngestor]";
const MLB_STATS_API_BASE = "https://statsapi.mlb.com/api/v1";
const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "application/json",
  Referer: "https://www.mlb.com/",
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface MlbApiInning {
  num: number;
  away?: { runs?: number };
  home?: { runs?: number };
}

interface MlbApiLinescore {
  teams?: {
    away?: { runs?: number };
    home?: { runs?: number };
  };
  innings?: MlbApiInning[];
}

interface MlbApiGame {
  gamePk: number;
  status: {
    abstractGameState: string;
    detailedState: string;
  };
  teams: {
    away: { team: { abbreviation: string }; score?: number };
    home: { team: { abbreviation: string }; score?: number };
  };
  linescore?: MlbApiLinescore;
}

/** Parsed outcome data from the MLB Stats API for a single game */
export interface GameOutcome {
  gamePk: number;
  awayAbbrev: string;
  homeAbbrev: string;
  /** Full-game away runs (null if game not final or linescore missing) */
  awayFgRuns: number | null;
  /** Full-game home runs (null if game not final or linescore missing) */
  homeFgRuns: number | null;
  /** Away runs through 5 innings (null if < 5 innings in linescore) */
  awayF5Runs: number | null;
  /** Home runs through 5 innings (null if < 5 innings in linescore) */
  homeF5Runs: number | null;
  /** 1 if no run scored in inning 1, 0 if run scored, null if inning 1 not in linescore */
  nrfiBinary: number | null;
  /** True if game is final per API */
  isFinal: boolean;
}

/** The five Brier fields, as stored before this run (for dry-run diffing). */
export interface BrierSnapshot {
  brierFgTotal: number | null;
  brierF5Total: number | null;
  brierNrfi: number | null;
  brierFgMl: number | null;
  brierF5Ml: number | null;
}

/** Per-game ingestion result */
export interface OutcomeIngestResult {
  gameId: number;
  matchup: string;
  gameDate: string;
  status:
    | "written"
    | "would_write"
    | "skipped_already_ingested"
    | "skipped_not_final"
    | "skipped_no_mlbgamepk"
    | "skipped_no_api_match"
    | "error";
  actualFgTotal: number | null;
  actualF5Total: number | null;
  actualNrfiBinary: number | null;
  brierFgTotal: number | null;
  brierF5Total: number | null;
  brierNrfi: number | null;
  brierFgMl: number | null;
  brierF5Ml: number | null;
  /**
   * Brier values as they stood BEFORE this run. Populated for written and
   * would_write rows so a dry run can be diffed field-by-field without a
   * second query. Null for skipped/error rows.
   */
  previousBrier?: BrierSnapshot | null;
  /** True when at least one Brier field differs from previousBrier. */
  brierChanged?: boolean;
  error?: string;
}

/** Batch ingestion summary */
export interface OutcomeIngestSummary {
  date: string;
  totalGames: number;
  written: number;
  /** Rows a dry run WOULD have written. Always 0 on a live run. */
  wouldWrite: number;
  /** Of the written/would_write rows, how many change at least one Brier field. */
  brierChanged: number;
  skippedAlreadyIngested: number;
  skippedNotFinal: number;
  skippedNoGamePk: number;
  skippedNoApiMatch: number;
  errors: number;
  results: OutcomeIngestResult[];
  runAt: number;
  /** Echo of the options this run executed under. */
  dryRun: boolean;
  historical: boolean;
}

/**
 * Execution modes for ingestMlbOutcomes.
 *
 * Both flags exist to make the M-203 historical Brier correction measurable
 * and inert with respect to the live model. Neither changes how any score is
 * computed — only whether the result is persisted and what runs afterwards.
 */
export interface OutcomeIngestOptions {
  /**
   * Compute and report, mutate NOTHING. Every selection, matching and scoring
   * path runs exactly as it would live; the UPDATE and its verification read
   * are skipped and rows are reported as `would_write`.
   */
  dryRun?: boolean;
  /**
   * Historical replay. Suppresses the post-ingest drift detector (which can
   * TRIGGER RECALIBRATION of the live model) and the owner notification.
   * checkF5ShareDrift() evaluates the CURRENT rolling window regardless of the
   * date being ingested, so replaying a season of past dates would otherwise
   * re-evaluate — and potentially recalibrate against — today's window once per
   * date, and send one notification per date.
   */
  historical?: boolean;
}

// ─── Brier Score Computation ──────────────────────────────────────────────────

/**
 * Computes a single Brier score: (p - o)^2
 *
 * @param modelProbPct  Model probability in [0, 100] (e.g. 54.3 = 54.3%)
 * @param outcome       Binary outcome: 1 = event occurred, 0 = did not occur
 * @returns Brier score in [0, 1], or null if inputs are invalid
 */
export function parseNumOrNull(
  v: string | number | null | undefined
): number | null {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** A 0-100 percent column -> [0,1] probability. */
export function probFromPct(
  v: string | number | null | undefined
): number | null {
  const n = parseNumOrNull(v);
  return n === null ? null : n / 100;
}

/** A 0-1 unit column -> [0,1] probability (identity parse, named for intent). */
export function probFromUnit(
  v: string | number | null | undefined
): number | null {
  return parseNumOrNull(v);
}

export function brierScore(
  p: number | null,
  outcome: 0 | 1 | null
): number | null {
  if (p === null) return null;
  if (outcome === null) return null;
  if (isNaN(p) || p < 0 || p > 1) return null;
  const bs = Math.pow(p - outcome, 2);
  // Round to 6 decimal places (matches precision: 7, scale: 6 in schema)
  return parseFloat(bs.toFixed(6));
}

/**
 * Computes all 5 Brier scores for a game.
 *
 * @param game        DB game row (model probabilities)
 * @param outcome     Parsed outcome from MLB Stats API
 * @returns Object with all 5 Brier scores (null if inputs unavailable)
 */
export function computeBrierScores(
  game: {
    bookTotal: string | null | undefined;
    modelOverRate: string | null | undefined;
    f5Total: string | null | undefined;
    modelF5OverRate: string | null | undefined;
    modelPNrfi: string | null | undefined;
    modelHomeWinPct: string | null | undefined;
    modelF5HomeWinPct: string | null | undefined;
  },
  outcome: GameOutcome
): {
  brierFgTotal: number | null;
  brierF5Total: number | null;
  brierNrfi: number | null;
  brierFgMl: number | null;
  brierF5Ml: number | null;
} {
  // ── FG Total ──────────────────────────────────────────────────────────────
  let brierFgTotal: number | null = null;
  const fgTotal =
    outcome.awayFgRuns !== null && outcome.homeFgRuns !== null
      ? outcome.awayFgRuns + outcome.homeFgRuns
      : null;
  const bookTotalNum = game.bookTotal
    ? parseFloat(String(game.bookTotal))
    : null;
  if (fgTotal !== null && bookTotalNum !== null && bookTotalNum > 0) {
    if (fgTotal !== bookTotalNum) {
      // Not a push — compute Brier
      const outcomeOver: 0 | 1 = fgTotal > bookTotalNum ? 1 : 0;
      brierFgTotal = brierScore(probFromPct(game.modelOverRate), outcomeOver);
    }
    // Push → brierFgTotal stays null
  }

  // ── F5 Total ──────────────────────────────────────────────────────────────
  let brierF5Total: number | null = null;
  const f5TotalActual =
    outcome.awayF5Runs !== null && outcome.homeF5Runs !== null
      ? outcome.awayF5Runs + outcome.homeF5Runs
      : null;
  const bookF5TotalNum = game.f5Total ? parseFloat(String(game.f5Total)) : null;
  if (f5TotalActual !== null && bookF5TotalNum !== null && bookF5TotalNum > 0) {
    if (f5TotalActual !== bookF5TotalNum) {
      const outcomeF5Over: 0 | 1 = f5TotalActual > bookF5TotalNum ? 1 : 0;
      brierF5Total = brierScore(
        probFromUnit(game.modelF5OverRate),
        outcomeF5Over
      );
    }
    // Push → brierF5Total stays null
  }

  // ── NRFI ──────────────────────────────────────────────────────────────────
  let brierNrfi: number | null = null;
  if (outcome.nrfiBinary !== null) {
    brierNrfi = brierScore(
      probFromUnit(game.modelPNrfi),
      outcome.nrfiBinary as 0 | 1
    );
  }

  // ── FG ML ─────────────────────────────────────────────────────────────────
  let brierFgMl: number | null = null;
  if (outcome.awayFgRuns !== null && outcome.homeFgRuns !== null) {
    if (outcome.awayFgRuns !== outcome.homeFgRuns) {
      // No tie in MLB (extra innings always produce a winner)
      const outcomeHomeWin: 0 | 1 =
        outcome.homeFgRuns > outcome.awayFgRuns ? 1 : 0;
      brierFgMl = brierScore(probFromPct(game.modelHomeWinPct), outcomeHomeWin);
    }
    // Tie (shouldn't happen in MLB but guard anyway) → brierFgMl stays null
  }

  // ── F5 ML ─────────────────────────────────────────────────────────────────
  let brierF5Ml: number | null = null;
  if (outcome.awayF5Runs !== null && outcome.homeF5Runs !== null) {
    if (outcome.awayF5Runs !== outcome.homeF5Runs) {
      const outcomeF5HomeWin: 0 | 1 =
        outcome.homeF5Runs > outcome.awayF5Runs ? 1 : 0;
      brierF5Ml = brierScore(
        probFromPct(game.modelF5HomeWinPct),
        outcomeF5HomeWin
      );
    }
    // F5 tie (common) → brierF5Ml stays null
  }

  return { brierFgTotal, brierF5Total, brierNrfi, brierFgMl, brierF5Ml };
}

// ─── Brier diffing + write verification ───────────────────────────────────────

/** The five Brier columns, in a fixed order, for diffing and verification. */
export const BRIER_FIELDS = [
  "brierFgTotal",
  "brierF5Total",
  "brierNrfi",
  "brierFgMl",
  "brierF5Ml",
] as const;

/**
 * Brier columns are decimal(7,6) and brierScore() rounds to 6dp, so equality
 * must be compared at that resolution rather than exactly — a round-trip
 * through MySQL returns a string that need not re-parse bit-identically.
 */
const BRIER_EPSILON = 5e-7;

/** True when any of the five Brier fields differs between two snapshots. */
export function brierSnapshotDiffers(
  before: BrierSnapshot,
  after: BrierSnapshot
): boolean {
  return BRIER_FIELDS.some(f => {
    const x = before[f];
    const y = after[f];
    if (x === null || y === null) return x !== y;
    return Math.abs(x - y) > BRIER_EPSILON;
  });
}

/** Compact one-line rendering of a Brier snapshot for logs. */
export function formatBrierSnapshot(s: BrierSnapshot): string {
  return BRIER_FIELDS.map(f => `${f.slice(5)}=${s[f] ?? "null"}`).join(" ");
}

/**
 * Compares what we intended to write against what the row actually holds,
 * returning one message per mismatched field (empty array = verified).
 *
 * Only fields the write actually CLAIMED are checked. actualFgTotal is written
 * as `undefined` (column omitted) when null, so in that case nothing was
 * claimed and asserting the stored value is null would be a false failure. The
 * five Brier fields are always written explicitly — including as null — so they
 * are always verified.
 */
export function verifyWrittenFields(
  intended: { actualFgTotal: number | null } & BrierSnapshot,
  stored: {
    actualFgTotal: string | number | null;
    brierFgTotal: string | number | null;
    brierF5Total: string | number | null;
    brierNrfi: string | number | null;
    brierFgMl: string | number | null;
    brierF5Ml: string | number | null;
  }
): string[] {
  const mismatches: string[] = [];

  if (intended.actualFgTotal !== null) {
    const got = parseNumOrNull(stored.actualFgTotal);
    if (got === null || Math.abs(got - intended.actualFgTotal) >= 0.01) {
      mismatches.push(
        `actualFgTotal expected=${intended.actualFgTotal} got=${stored.actualFgTotal ?? "null"}`
      );
    }
  }

  for (const f of BRIER_FIELDS) {
    const want = intended[f];
    const got = parseNumOrNull(stored[f]);
    const ok =
      want === null
        ? got === null
        : got !== null && Math.abs(got - want) <= BRIER_EPSILON;
    if (!ok) {
      mismatches.push(
        `${f} expected=${want ?? "null"} got=${stored[f] ?? "null"}`
      );
    }
  }

  return mismatches;
}

// ─── MLB Stats API Fetch ──────────────────────────────────────────────────────

/**
 * Fetches innings-level linescore data for all games on a given date.
 * Returns a map of gamePk → GameOutcome.
 *
 * API endpoint: statsapi.mlb.com/api/v1/schedule
 * Hydration: linescore (includes innings array)
 */
async function fetchMlbOutcomes(
  dateStr: string
): Promise<Map<number, GameOutcome>> {
  const url =
    `${MLB_STATS_API_BASE}/schedule` +
    `?sportId=1&date=${dateStr}&hydrate=linescore`;

  console.log(`${TAG} [STEP] Fetching MLB Stats API: ${url}`);

  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) {
    throw new Error(`MLB Stats API HTTP ${res.status} for date=${dateStr}`);
  }

  const json = (await res.json()) as {
    dates?: Array<{ games?: MlbApiGame[] }>;
  };

  const outcomes = new Map<number, GameOutcome>();
  const dateEntry = json.dates?.[0];
  if (!dateEntry?.games) {
    console.log(
      `${TAG} [STATE] No games found in API response for date=${dateStr}`
    );
    return outcomes;
  }

  for (const g of dateEntry.games) {
    const abstractState = g.status?.abstractGameState ?? "";
    const detailedState = g.status?.detailedState ?? "";
    const isFinal =
      abstractState === "Final" &&
      !["Postponed", "Suspended", "Cancelled"].includes(detailedState);

    const linescore = g.linescore;
    const innings = linescore?.innings ?? [];

    // Full-game runs from linescore teams (most reliable for final games)
    const awayFgRuns = isFinal
      ? (linescore?.teams?.away?.runs ?? g.teams.away.score ?? null)
      : null;
    const homeFgRuns = isFinal
      ? (linescore?.teams?.home?.runs ?? g.teams.home.score ?? null)
      : null;

    // F5 runs: sum innings 1-5 (only if at least 5 innings are present)
    const f5Innings = innings.filter(i => i.num >= 1 && i.num <= 5);
    const hasF5 = f5Innings.length >= 5 || (isFinal && innings.length >= 5);
    const awayF5Runs = hasF5
      ? f5Innings.reduce((s, i) => s + (i.away?.runs ?? 0), 0)
      : null;
    const homeF5Runs = hasF5
      ? f5Innings.reduce((s, i) => s + (i.home?.runs ?? 0), 0)
      : null;

    // NRFI: inning 1 — 1 if no run scored, 0 if any run scored
    const inn1 = innings.find(i => i.num === 1);
    let nrfiBinary: number | null = null;
    if (inn1) {
      const i1Away = inn1.away?.runs ?? 0;
      const i1Home = inn1.home?.runs ?? 0;
      nrfiBinary = i1Away === 0 && i1Home === 0 ? 1 : 0;
    }

    const awayAbbrev = g.teams.away.team.abbreviation;
    const homeAbbrev = g.teams.home.team.abbreviation;

    outcomes.set(g.gamePk, {
      gamePk: g.gamePk,
      awayAbbrev,
      homeAbbrev,
      awayFgRuns,
      homeFgRuns,
      awayF5Runs,
      homeF5Runs,
      nrfiBinary,
      isFinal,
    });

    console.log(
      `${TAG} [STATE] gamePk=${g.gamePk} ${awayAbbrev}@${homeAbbrev}` +
        ` | final=${isFinal} | FG=${awayFgRuns ?? "?"}–${homeFgRuns ?? "?"}` +
        ` | F5=${awayF5Runs ?? "?"}–${homeF5Runs ?? "?"}` +
        ` | NRFI=${nrfiBinary ?? "?"}` +
        ` | innings=${innings.length}`
    );
  }

  console.log(
    `${TAG} [STEP] API returned ${outcomes.size} games for date=${dateStr}`
  );
  return outcomes;
}

// ─── Main Ingestion Function ──────────────────────────────────────────────────

/**
 * Ingests outcomes for all final MLB games on the given date.
 *
 * Strategy:
 *   1. Query DB for all MLB games on date with gameStatus='final' and sport='MLB'
 *   2. Skip games where outcomeIngestedAt is already set (unless force=true)
 *   3. Fetch innings-level linescore from MLB Stats API
 *   4. Match DB games to API outcomes by mlbGamePk (primary) or team abbreviation (fallback)
 *   5. Compute actualFgTotal, actualF5Total, actualNrfiBinary
 *   6. Compute 5 Brier scores using model probabilities from DB
 *   7. Write all fields atomically in a single UPDATE per game
 *   8. Verify written values match computed values
 *
 * @param dateStr  YYYY-MM-DD date string (PST/PDT)
 * @param force    If true, re-ingest games that already have outcomeIngestedAt set
 */
export async function ingestMlbOutcomes(
  dateStr: string,
  force = false,
  options: OutcomeIngestOptions = {}
): Promise<OutcomeIngestSummary> {
  const dryRun = options.dryRun === true;
  const historical = options.historical === true;
  // A dry run must have no side effects at all, so it implies the historical
  // suppressions on top of skipping the write.
  const suppressSideEffects = dryRun || historical;

  const startMs = Date.now();
  console.log(
    `\n${TAG} ══════════════════════════════════════════════════════`
  );
  console.log(
    `${TAG} [INPUT] date=${dateStr} force=${force} dryRun=${dryRun} historical=${historical}`
  );
  if (dryRun) {
    console.log(
      `${TAG} [INPUT] DRY RUN — no database mutation will be performed`
    );
  }
  if (suppressSideEffects) {
    console.log(
      `${TAG} [INPUT] side effects SUPPRESSED — drift detector, recalibration and owner notification will not run`
    );
  }

  const db = await getDb();

  // ── Step 1: Query DB for final MLB games on this date ─────────────────────
  console.log(`${TAG} [STEP 1] Querying DB for final MLB games on ${dateStr}`);

  const dbGames = await db
    .select({
      id: games.id,
      gameDate: games.gameDate,
      awayTeam: games.awayTeam,
      homeTeam: games.homeTeam,
      gameStatus: games.gameStatus,
      mlbGamePk: games.mlbGamePk,
      outcomeIngestedAt: games.outcomeIngestedAt,
      // Model probabilities for Brier computation
      bookTotal: games.bookTotal,
      modelOverRate: games.modelOverRate,
      f5Total: games.f5Total,
      modelF5OverRate: games.modelF5OverRate,
      modelPNrfi: games.modelPNrfi,
      modelHomeWinPct: games.modelHomeWinPct,
      modelF5HomeWinPct: games.modelF5HomeWinPct,
      // Existing actual scores (may already be set by mlbScoreRefresh)
      actualAwayScore: games.actualAwayScore,
      actualHomeScore: games.actualHomeScore,
      actualF5AwayScore: games.actualF5AwayScore,
      actualF5HomeScore: games.actualF5HomeScore,
      // Previously-stored Brier values, so a dry run can report before/after
      // without a second query. Read-only — never fed to computeBrierScores.
      prevBrierFgTotal: games.brierFgTotal,
      prevBrierF5Total: games.brierF5Total,
      prevBrierNrfi: games.brierNrfi,
      prevBrierFgMl: games.brierFgMl,
      prevBrierF5Ml: games.brierF5Ml,
    })
    .from(games)
    .where(
      and(
        eq(games.gameDate, dateStr),
        eq(games.sport, "MLB"),
        eq(games.gameStatus, "final")
      )
    );

  console.log(
    `${TAG} [STATE] Found ${dbGames.length} final MLB games in DB for ${dateStr}`
  );

  const results: OutcomeIngestResult[] = [];
  let written = 0;
  let wouldWrite = 0;
  let brierChangedCount = 0;
  let skippedAlreadyIngested = 0;
  let skippedNotFinal = 0;
  let skippedNoGamePk = 0;
  let skippedNoApiMatch = 0;
  let errors = 0;

  if (dbGames.length === 0) {
    console.log(`${TAG} [OUTPUT] No final MLB games to ingest for ${dateStr}`);
    return {
      date: dateStr,
      totalGames: 0,
      written: 0,
      wouldWrite: 0,
      brierChanged: 0,
      skippedAlreadyIngested: 0,
      skippedNotFinal: 0,
      skippedNoGamePk: 0,
      skippedNoApiMatch: 0,
      errors: 0,
      results: [],
      runAt: Date.now(),
      dryRun,
      historical,
    };
  }

  // ── Step 2: Fetch MLB Stats API outcomes ──────────────────────────────────
  console.log(`${TAG} [STEP 2] Fetching MLB Stats API for date=${dateStr}`);
  let apiOutcomes: Map<number, GameOutcome>;
  try {
    apiOutcomes = await fetchMlbOutcomes(dateStr);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} [ERROR] MLB Stats API fetch failed: ${msg}`);
    // Return all games as errors
    for (const g of dbGames) {
      results.push({
        gameId: g.id,
        matchup: `${g.awayTeam}@${g.homeTeam}`,
        gameDate: g.gameDate ?? dateStr,
        status: "error",
        actualFgTotal: null,
        actualF5Total: null,
        actualNrfiBinary: null,
        brierFgTotal: null,
        brierF5Total: null,
        brierNrfi: null,
        brierFgMl: null,
        brierF5Ml: null,
        error: `API fetch failed: ${msg}`,
      });
      errors++;
    }
    return {
      date: dateStr,
      totalGames: dbGames.length,
      written: 0,
      wouldWrite: 0,
      brierChanged: 0,
      skippedAlreadyIngested: 0,
      skippedNotFinal: 0,
      skippedNoGamePk: 0,
      skippedNoApiMatch: 0,
      errors,
      results,
      runAt: Date.now(),
      dryRun,
      historical,
    };
  }

  // ── Step 3: Process each DB game ──────────────────────────────────────────
  console.log(`${TAG} [STEP 3] Processing ${dbGames.length} games`);

  for (const game of dbGames) {
    const matchup = `${game.awayTeam}@${game.homeTeam}`;
    console.log(
      `\n${TAG} [STEP] Processing game id=${game.id} ${matchup} date=${game.gameDate}`
    );

    // Skip if already ingested (unless force)
    if (
      !force &&
      game.outcomeIngestedAt !== null &&
      game.outcomeIngestedAt !== undefined
    ) {
      console.log(
        `${TAG} [STATE] SKIP — already ingested at ${new Date(game.outcomeIngestedAt).toISOString()}`
      );
      results.push({
        gameId: game.id,
        matchup,
        gameDate: game.gameDate ?? dateStr,
        status: "skipped_already_ingested",
        actualFgTotal: null,
        actualF5Total: null,
        actualNrfiBinary: null,
        brierFgTotal: null,
        brierF5Total: null,
        brierNrfi: null,
        brierFgMl: null,
        brierF5Ml: null,
      });
      skippedAlreadyIngested++;
      continue;
    }

    // Match to API outcome
    let apiOutcome: GameOutcome | undefined;

    // Primary match: mlbGamePk
    if (game.mlbGamePk) {
      apiOutcome = apiOutcomes.get(game.mlbGamePk);
      if (apiOutcome) {
        console.log(`${TAG} [STATE] Matched by mlbGamePk=${game.mlbGamePk}`);
      }
    }

    // Fallback match: team abbreviation (normalize SF → SF, etc.)
    // DOUBLEHEADER GUARD: this fallback is only safe when it is UNAMBIGUOUS —
    // exactly one team-matching outcome. When the same matchup appears twice
    // (a doubleheader) the fallback cannot tell G1 from G2, so we refuse to
    // guess and require mlbGamePk (stamped by syncMlbSchedule) instead of
    // silently grading both DB rows against the same outcome.
    if (!apiOutcome) {
      const teamMatches = Array.from(apiOutcomes.values()).filter(outcome => {
        const awayMatch =
          outcome.awayAbbrev === game.awayTeam ||
          normalizeTeamAbbrev(outcome.awayAbbrev) ===
            normalizeTeamAbbrev(game.awayTeam);
        const homeMatch =
          outcome.homeAbbrev === game.homeTeam ||
          normalizeTeamAbbrev(outcome.homeAbbrev) ===
            normalizeTeamAbbrev(game.homeTeam);
        return awayMatch && homeMatch;
      });
      if (teamMatches.length === 1) {
        apiOutcome = teamMatches[0];
        console.log(
          `${TAG} [STATE] Matched by team abbreviation: ${apiOutcome.awayAbbrev}@${apiOutcome.homeAbbrev}`
        );
      } else if (teamMatches.length > 1) {
        console.error(
          `${TAG} [ERROR] AMBIGUOUS team-name fallback for game id=${game.id} ${matchup}: ` +
            `${teamMatches.length} same-matchup outcomes (doubleheader) and row has no mlbGamePk — ` +
            `refusing to guess; run syncMlbSchedule to stamp identity, then re-ingest`
        );
      }
    }

    if (!apiOutcome) {
      console.warn(
        `${TAG} [WARN] No API match for game id=${game.id} ${matchup} — skipping`
      );
      results.push({
        gameId: game.id,
        matchup,
        gameDate: game.gameDate ?? dateStr,
        status: "skipped_no_api_match",
        actualFgTotal: null,
        actualF5Total: null,
        actualNrfiBinary: null,
        brierFgTotal: null,
        brierF5Total: null,
        brierNrfi: null,
        brierFgMl: null,
        brierF5Ml: null,
      });
      skippedNoApiMatch++;
      continue;
    }

    if (!apiOutcome.isFinal) {
      console.log(
        `${TAG} [STATE] SKIP — API reports game not final (gamePk=${apiOutcome.gamePk})`
      );
      results.push({
        gameId: game.id,
        matchup,
        gameDate: game.gameDate ?? dateStr,
        status: "skipped_not_final",
        actualFgTotal: null,
        actualF5Total: null,
        actualNrfiBinary: null,
        brierFgTotal: null,
        brierF5Total: null,
        brierNrfi: null,
        brierFgMl: null,
        brierF5Ml: null,
      });
      skippedNotFinal++;
      continue;
    }

    // ── Compute derived outcome fields ────────────────────────────────────
    const actualFgTotal =
      apiOutcome.awayFgRuns !== null && apiOutcome.homeFgRuns !== null
        ? apiOutcome.awayFgRuns + apiOutcome.homeFgRuns
        : null;
    const actualF5Total =
      apiOutcome.awayF5Runs !== null && apiOutcome.homeF5Runs !== null
        ? apiOutcome.awayF5Runs + apiOutcome.homeF5Runs
        : null;
    const actualNrfiBinary = apiOutcome.nrfiBinary;

    console.log(
      `${TAG} [STATE] id=${game.id} ${matchup}` +
        ` | actualFgTotal=${actualFgTotal ?? "null"}` +
        ` | actualF5Total=${actualF5Total ?? "null"}` +
        ` | actualNrfiBinary=${actualNrfiBinary ?? "null"}`
    );

    // ── Compute Brier scores ──────────────────────────────────────────────
    const briers = computeBrierScores(game, apiOutcome);

    console.log(
      `${TAG} [STATE] Brier scores:` +
        ` FgTotal=${briers.brierFgTotal ?? "null"}` +
        ` F5Total=${briers.brierF5Total ?? "null"}` +
        ` NRFI=${briers.brierNrfi ?? "null"}` +
        ` FgML=${briers.brierFgMl ?? "null"}` +
        ` F5ML=${briers.brierF5Ml ?? "null"}`
    );

    // ── Diff against what is already stored ───────────────────────────────
    const previousBrier: BrierSnapshot = {
      brierFgTotal: parseNumOrNull(game.prevBrierFgTotal),
      brierF5Total: parseNumOrNull(game.prevBrierF5Total),
      brierNrfi: parseNumOrNull(game.prevBrierNrfi),
      brierFgMl: parseNumOrNull(game.prevBrierFgMl),
      brierF5Ml: parseNumOrNull(game.prevBrierF5Ml),
    };
    const brierChanged = brierSnapshotDiffers(previousBrier, briers);
    if (brierChanged) brierChangedCount++;

    console.log(
      `${TAG} [STATE] id=${game.id} ${matchup} | brierChanged=${brierChanged}` +
        ` | before=${formatBrierSnapshot(previousBrier)}` +
        ` | after=${formatBrierSnapshot(briers)}`
    );

    // ── Dry run: report what WOULD happen, mutate nothing ─────────────────
    if (dryRun) {
      console.log(
        `${TAG} [OUTPUT] id=${game.id} ${matchup} — WOULD WRITE (dry run, no mutation)`
      );
      results.push({
        gameId: game.id,
        matchup,
        gameDate: game.gameDate ?? dateStr,
        status: "would_write",
        actualFgTotal,
        actualF5Total,
        actualNrfiBinary,
        brierFgTotal: briers.brierFgTotal,
        brierF5Total: briers.brierF5Total,
        brierNrfi: briers.brierNrfi,
        brierFgMl: briers.brierFgMl,
        brierF5Ml: briers.brierF5Ml,
        previousBrier,
        brierChanged,
      });
      wouldWrite++;
      continue;
    }

    // ── Write to DB ───────────────────────────────────────────────────────
    try {
      const now = Date.now();
      await db
        .update(games)
        .set({
          // actual* stay `undefined` (= column omitted) deliberately: they are
          // the drift detector's rolling-window inputs, and clearing them on a
          // transient API gap would silently shrink that window. The Brier
          // fields below MUST be explicit null — see the note on that block.
          actualFgTotal:
            actualFgTotal !== null ? String(actualFgTotal) : undefined,
          actualF5Total:
            actualF5Total !== null ? String(actualF5Total) : undefined,
          actualNrfiBinary: actualNrfiBinary,
          // EXPLICIT null, never undefined. Drizzle OMITS undefined columns
          // from the SET clause, so passing undefined made a force re-ingest
          // unable to CLEAR a stale Brier value that should now be null (a
          // push, a tie, or a probability that no longer parses). Writing null
          // is a no-op on a first ingest — the column is already null — and is
          // the whole point of a correction run.
          brierFgTotal:
            briers.brierFgTotal !== null ? String(briers.brierFgTotal) : null,
          brierF5Total:
            briers.brierF5Total !== null ? String(briers.brierF5Total) : null,
          brierNrfi:
            briers.brierNrfi !== null ? String(briers.brierNrfi) : null,
          brierFgMl:
            briers.brierFgMl !== null ? String(briers.brierFgMl) : null,
          brierF5Ml:
            briers.brierF5Ml !== null ? String(briers.brierF5Ml) : null,
          outcomeIngestedAt: now,
        })
        .where(eq(games.id, game.id));

      console.log(`${TAG} [OUTPUT] id=${game.id} ${matchup} — written OK`);

      // ── Post-write verification ────────────────────────────────────────
      // Reads back and checks actualFgTotal AND all five Brier fields. The
      // Brier fields are the entire point of an M-203 correction run, so a
      // verification that ignored them could pass while every corrected score
      // silently failed to land.
      const [verify] = await db
        .select({
          actualFgTotal: games.actualFgTotal,
          actualF5Total: games.actualF5Total,
          actualNrfiBinary: games.actualNrfiBinary,
          brierFgTotal: games.brierFgTotal,
          brierF5Total: games.brierF5Total,
          brierNrfi: games.brierNrfi,
          brierFgMl: games.brierFgMl,
          brierF5Ml: games.brierF5Ml,
          outcomeIngestedAt: games.outcomeIngestedAt,
        })
        .from(games)
        .where(eq(games.id, game.id));

      const mismatches = verifyWrittenFields(
        { actualFgTotal, ...briers },
        verify
      );

      if (mismatches.length > 0) {
        console.error(
          `${TAG} [VERIFY] FAIL — id=${game.id} ${matchup} | ${mismatches.join(" | ")}`
        );
      } else {
        console.log(
          `${TAG} [VERIFY] PASS — id=${game.id} ${matchup} | actualFgTotal=${verify.actualFgTotal} | brier=${formatBrierSnapshot(briers)} | outcomeIngestedAt=${verify.outcomeIngestedAt}`
        );
      }

      results.push({
        gameId: game.id,
        matchup,
        gameDate: game.gameDate ?? dateStr,
        status: "written",
        actualFgTotal,
        actualF5Total,
        actualNrfiBinary,
        brierFgTotal: briers.brierFgTotal,
        brierF5Total: briers.brierF5Total,
        brierNrfi: briers.brierNrfi,
        brierFgMl: briers.brierFgMl,
        brierF5Ml: briers.brierF5Ml,
        previousBrier,
        brierChanged,
      });
      written++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `${TAG} [ERROR] DB write failed for id=${game.id} ${matchup}: ${msg}`
      );
      results.push({
        gameId: game.id,
        matchup,
        gameDate: game.gameDate ?? dateStr,
        status: "error",
        actualFgTotal: null,
        actualF5Total: null,
        actualNrfiBinary: null,
        brierFgTotal: null,
        brierF5Total: null,
        brierNrfi: null,
        brierFgMl: null,
        brierF5Ml: null,
        error: msg,
      });
      errors++;
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(2);
  console.log(
    `\n${TAG} ══════════════════════════════════════════════════════`
  );
  console.log(`${TAG} [SUMMARY] date=${dateStr}`);
  console.log(
    `${TAG} [SUMMARY] mode=${dryRun ? "DRY-RUN" : "LIVE"}${historical ? "+historical" : ""}`
  );
  console.log(
    `${TAG} [SUMMARY] total=${dbGames.length} | written=${written} | would_write=${wouldWrite} | brier_changed=${brierChangedCount} | skipped_ingested=${skippedAlreadyIngested} | skipped_not_final=${skippedNotFinal} | skipped_no_pk=${skippedNoGamePk} | skipped_no_match=${skippedNoApiMatch} | errors=${errors}`
  );
  console.log(`${TAG} [SUMMARY] elapsed=${elapsed}s`);
  console.log(
    `${TAG} ══════════════════════════════════════════════════════\n`
  );

  // ── Drift detector: run rolling f5_share check (before notifyOwner so result is included) ─────────
  //
  // SUPPRESSED for dry runs and historical replays. checkF5ShareDrift() takes
  // no date — it always evaluates the CURRENT rolling window and can set
  // recalibrationTriggered. Replaying past dates would therefore re-evaluate,
  // and potentially recalibrate, the live model once per replayed date.
  let driftSummaryLine = "Drift check: skipped (insufficient data)";
  if (suppressSideEffects) {
    driftSummaryLine = "Drift check: SUPPRESSED (dry-run / historical replay)";
    console.log(
      `${TAG} [STEP] Drift detector SUPPRESSED — replay must not evaluate or recalibrate the live rolling window`
    );
  } else {
    try {
      console.log(
        `${TAG} [STEP] Running drift detector (rolling f5_share check)...`
      );
      const driftResult = await checkF5ShareDrift();
      console.log(
        `${TAG} [OUTPUT] driftDetected=${driftResult.driftDetected} | delta=${driftResult.delta?.toFixed(4) ?? "N/A"} | rollingF5Share=${driftResult.rollingF5Share?.toFixed(4) ?? "N/A"} | windowSize=${driftResult.windowSize}`
      );
      console.log(`${TAG} [OUTPUT] drift message: ${driftResult.message}`);
      if (driftResult.driftDetected) {
        console.warn(
          `${TAG} [VERIFY] DRIFT DETECTED — delta=${driftResult.delta?.toFixed(4)} exceeds threshold. recalibrationTriggered=${driftResult.recalibrationTriggered}`
        );
        driftSummaryLine = `⚠️ DRIFT DETECTED — delta=${driftResult.delta?.toFixed(4)} | rolling=${driftResult.rollingF5Share?.toFixed(4)} | baseline=${driftResult.baselineF5Share.toFixed(4)} | recalibrated=${driftResult.recalibrationTriggered}`;
      } else if (driftResult.rollingF5Share !== null) {
        console.log(
          `${TAG} [VERIFY] PASS — no drift detected (delta=${driftResult.delta?.toFixed(4) ?? "N/A"})`
        );
        driftSummaryLine = `✅ No drift — delta=${driftResult.delta?.toFixed(4)} | rolling=${driftResult.rollingF5Share?.toFixed(4)} | baseline=${driftResult.baselineF5Share.toFixed(4)} | window=${driftResult.windowSize}`;
      } else {
        driftSummaryLine = `Drift check: insufficient data (${driftResult.windowSize} games, need 20+)`;
      }
    } catch (driftErr) {
      const driftMsg =
        driftErr instanceof Error ? driftErr.message : String(driftErr);
      console.error(
        `${TAG} [ERROR] drift detector failed (non-fatal): ${driftMsg}`
      );
      driftSummaryLine = `Drift check: error — ${driftMsg.slice(0, 80)}`;
    }
  }

  // ── F5 ML coverage audit: count games with model but no book F5 ML odds ──────────────────
  let coverageLine = "";
  try {
    const db = await getDb();
    const coverageGap = await db
      .select({ count: sql<number>`count(*)` })
      .from(games)
      .where(and(isNotNull(games.modelF5AwayWinPct), isNull(games.f5AwayML)));
    const gapCount = Number(coverageGap[0]?.count ?? 0);
    coverageLine =
      gapCount > 0
        ? `⚠️ F5 ML coverage gap: ${gapCount} game${gapCount !== 1 ? "s" : ""} have model but no book F5 ML odds`
        : `✅ F5 ML coverage: no gaps detected`;
    console.log(`${TAG} [OUTPUT] F5 ML coverage audit: ${coverageLine}`);
  } catch (covErr) {
    coverageLine = "F5 ML coverage audit: error (non-fatal)";
    console.error(
      `${TAG} [ERROR] F5 ML coverage audit failed: ${covErr instanceof Error ? covErr.message : String(covErr)}`
    );
  }

  // ── notifyOwner: push Brier calibration summary + drift result to owner ──────────────────
  //
  // SUPPRESSED for dry runs and historical replays: a season-long backfill
  // would otherwise send one owner notification per replayed date.
  if (suppressSideEffects) {
    console.log(
      `${TAG} [STEP] Owner notification SUPPRESSED (dry-run / historical replay)`
    );
  } else if (written > 0) {
    try {
      const ingestedResults = results.filter(r => r.status === "written");
      const brierAvg = (field: keyof OutcomeIngestResult): string => {
        const vals = ingestedResults
          .map(r => r[field] as number | null | undefined)
          .filter((v): v is number => v != null && !isNaN(v as number));
        if (vals.length === 0) return "N/A";
        const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
        return avg.toFixed(4);
      };
      const statusLine = errors > 0 ? `⚠️ ${errors} error(s)` : "✅ 0 errors";
      const notifTitle = `MLB Outcome Ingest — ${dateStr}`;
      const notifContent = [
        `Date: ${dateStr}`,
        `Games ingested: ${written} / ${dbGames.length} | ${statusLine}`,
        `Elapsed: ${elapsed}s`,
        ``,
        `Brier Scores (today's ${written} game${written !== 1 ? "s" : ""}):`,
        `  FG ML:    ${brierAvg("brierFgMl")}`,
        `  F5 ML:    ${brierAvg("brierF5Ml")}`,
        `  NRFI:     ${brierAvg("brierNrfi")}`,
        `  FG Total: ${brierAvg("brierFgTotal")}`,
        `  F5 Total: ${brierAvg("brierF5Total")}`,
        ``,
        `(lower = better | perfect = 0.0000 | random = 0.2500)`,
        ``,
        `Drift Detector:`,
        `  ${driftSummaryLine}`,
        ``,
        `Coverage Audit:`,
        `  ${coverageLine}`,
      ].join("\n");
      console.log(
        `${TAG} [STEP] Sending owner notification with Brier calibration summary + drift result...`
      );
      const notifOk = await notifyOwner({
        title: notifTitle,
        content: notifContent,
      });
      console.log(
        `${TAG} [OUTPUT] notifyOwner: ${notifOk ? "sent" : "failed (non-fatal)"}`
      );
    } catch (notifErr) {
      const notifMsg =
        notifErr instanceof Error ? notifErr.message : String(notifErr);
      console.error(
        `${TAG} [ERROR] notifyOwner failed (non-fatal): ${notifMsg}`
      );
    }
  } else {
    console.log(
      `${TAG} [STEP] Skipping owner notification (written=0, no new games ingested)`
    );
  }

  return {
    date: dateStr,
    totalGames: dbGames.length,
    written,
    wouldWrite,
    brierChanged: brierChangedCount,
    skippedAlreadyIngested,
    skippedNotFinal,
    skippedNoGamePk,
    skippedNoApiMatch,
    errors,
    results,
    runAt: Date.now(),
    dryRun,
    historical,
  };
}

/**
 * Ingests outcomes for a range of dates (inclusive).
 * Used for backfill operations.
 *
 * @param startDate  YYYY-MM-DD start date
 * @param endDate    YYYY-MM-DD end date
 * @param force      If true, re-ingest already-ingested games
 */
async function ingestMlbOutcomesRange(
  startDate: string,
  endDate: string,
  force = false,
  options: OutcomeIngestOptions = {}
): Promise<OutcomeIngestSummary[]> {
  const summaries: OutcomeIngestSummary[] = [];
  const start = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");

  console.log(
    `${TAG} [INPUT] Range backfill: ${startDate} → ${endDate} force=${force} dryRun=${options.dryRun === true} historical=${options.historical === true}`
  );

  const current = new Date(start);
  while (current <= end) {
    const dateStr = current.toISOString().slice(0, 10);
    const summary = await ingestMlbOutcomes(dateStr, force, options);
    summaries.push(summary);
    current.setUTCDate(current.getUTCDate() + 1);
  }

  const totalWritten = summaries.reduce((s, r) => s + r.written, 0);
  const totalErrors = summaries.reduce((s, r) => s + r.errors, 0);
  console.log(
    `${TAG} [SUMMARY] Range complete: ${startDate}→${endDate} | totalWritten=${totalWritten} | totalErrors=${totalErrors}`
  );

  return summaries;
}

// ─── Team Abbreviation Normalization ─────────────────────────────────────────

/**
 * Normalizes MLB team abbreviations for fuzzy matching.
 * Handles known discrepancies between MLB Stats API and our DB.
 */
function normalizeTeamAbbrev(abbrev: string): string {
  const MAP: Record<string, string> = {
    // MLB Stats API → our DB
    SF: "SF",
    SFG: "SF",
    SD: "SD",
    SDP: "SD",
    KC: "KC",
    KCR: "KC",
    TB: "TB",
    TBR: "TB",
    CWS: "CWS",
    CHW: "CWS",
    WSH: "WSH",
    WAS: "WSH",
    ARI: "ARI",
    AZ: "ARI",
  };
  return MAP[abbrev] ?? abbrev;
}
