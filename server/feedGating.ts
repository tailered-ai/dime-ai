import type { Request } from "express";
import { parse as parseCookieHeader } from "cookie";
import { verifyAppUserToken, APP_USER_COOKIE } from "./routers/appUsers";
import type { MlbMarketGates, MlbMarketKey } from "./mlbMarketGates";

/**
 * Feed IP gating (Phase 3, credential-protected data).
 *
 * The proprietary product is the MODEL: projections, win probabilities, edges,
 * fair odds. Schedules, book lines, and betting splits are commodity facts
 * anyone can get from a sportsbook — those stay public. For ANONYMOUS callers
 * we null the model fields at the wire layer (like the existing NCAAM
 * publishedModel gate and stripSportNullFields) so a direct API scrape returns
 * only commodity data. Authenticated callers get the full payload — the logged
 * -in UX is unchanged (the feed surface is already RequireAuth-gated).
 *
 * Amends the previously-public data contract (ai-model-projections.md /
 * DIME-FEED-MIGRATION-DRAFT.md) — owner-ratified via the PR.
 */

/** Is this request from a logged-in app user? (cookie + JWT verify, no DB hit.) */
export async function isRequestAuthenticated(req: Request): Promise<boolean> {
  try {
    const header = req?.headers?.cookie;
    if (!header) return false;
    const token = parseCookieHeader(header)[APP_USER_COOKIE];
    if (!token) return false;
    return (await verifyAppUserToken(token)) != null;
  } catch {
    return false;
  }
}

/**
 * games.list PREZ ungating only: cookie subscriber OR Tailered OS machine principal.
 * Do NOT use for props/WC feeds — keep those cookie-only via isRequestAuthenticated.
 */
export async function isGamesListAuthenticated(req: Request): Promise<boolean> {
  try {
    const { isMachineSportsReadRequest } = await import("./_core/machineAuth");
    if (isMachineSportsReadRequest(req)) return true;
    return await isRequestAuthenticated(req);
  } catch {
    return false;
  }
}

/** Cache key must include machine headers so anon public responses never serve to S2S. */
export const GATED_FEED_VARY =
  "Cookie, Authorization, x-tailered-sports-secret";

/**
 * Is this request from the OWNER? Used only by the MLB per-market publication
 * gate, to keep owner backtest surfaces ungated — they are the BACKTEST-ONLY
 * audience (docs/audits/mlb-model-audit-2026/BACKTESTING-EXECUTION-REPORT.md).
 *
 * Two-stage on purpose. The JWT `role` claim is a cheap PRE-FILTER only: a
 * request whose token does not even claim owner never touches the database, so
 * this adds zero query load to the anonymous/subscriber hot path. The
 * authoritative answer still comes from the DB, matching ownerProcedure's
 * documented rule ("role is checked from DB, NOT from JWT claim... JWT role is
 * baked at login time") — so a demoted owner loses the exemption immediately
 * rather than keeping it until their 90-day token expires.
 *
 * Fails CLOSED (returns false) on any error: the cost of a false negative is a
 * blanked owner page, never a leak.
 */
export async function isOwnerRequest(req: Request): Promise<boolean> {
  try {
    const header = req?.headers?.cookie;
    if (!header) return false;
    const token = parseCookieHeader(header)[APP_USER_COOKIE];
    if (!token) return false;
    const payload = await verifyAppUserToken(token);
    if (!payload) return false;
    // Cheap pre-filter — no DB hit unless the token itself claims owner.
    if (String(payload.role ?? "").toLowerCase() !== "owner") return false;
    const { lookupAppUserByIdFresh } = await import("./db");
    const { resolveOwnerIdentity } = await import("./ownerAuth");
    const lookup = await lookupAppUserByIdFresh(payload.userId);
    const resolved = resolveOwnerIdentity({
      lookup,
      fallback: null,
      tokenVersion: payload.tv,
    });
    return resolved.ok === true;
  } catch {
    return false;
  }
}

// Proprietary Game fields whose NAMES do NOT contain "model" (so the
// includes-"model" rule below misses them). Verified against the model-field
// inventory (db.ts MODEL_FIELDS, routers.ts stripSportNullFields) + a leak
// audit: edges/diffs, the NRFI edge signal + pass flag, the Brier scores
// (which algebraically reconstruct the nulled model probabilities on completed
// games), and the model-correctness flags (reveal the model's pick direction).
//
// `nrfiBacktestResult` is MODEL-graded (mlbBacktestAuditCore grades NRFI as
// WIN/LOSS vs the model's pick — same class as the HR-prop backtestResult leak),
// distinct from the commodity `nrfiActualResult` (NRFI/YRFI, the actual outcome).
// `*BacktestRunAt` are model-pipeline timing metadata (sibling of the model-rule
// -stripped modelRunAt). All four are null in current data — stripped proactively
// so they can never leak once populated. Actual game RESULTS (fgMlResult,
// fg/f5 *Result, actual* scores, nrfiActualResult) stay public — commodity.
const PROPRIETARY_GAME_FIELDS = [
  "spreadEdge",
  "spreadDiff",
  "totalEdge",
  "totalDiff",
  "nrfiCombinedSignal",
  "nrfiFilterPass",
  "brierFgTotal",
  "brierF5Total",
  "brierNrfi",
  "brierFgMl",
  "brierF5Ml",
  "fgMlCorrect",
  "fgRlCorrect",
  "fgTotalCorrect",
  "f5MlCorrect",
  "f5RlCorrect",
  "f5TotalCorrect",
  "nrfiCorrect",
  "nrfiBacktestResult",
  "fgBacktestRunAt",
  "f5BacktestRunAt",
  "nrfiBacktestRunAt",
] as const;

/**
 * Null the proprietary model IP on a Game row for an anonymous caller.
 * Strips every field whose name contains "model" (case-insensitive — covers
 * `modelTotal`, `awayModelSpread`, `modelF5*`, `modelPNrfi`, `modelPHr`, and
 * anything added later) PLUS the explicit `PROPRIETARY_GAME_FIELDS` that carry
 * IP without a "model" token. Keeps schedule, book lines, splits, lineups, and
 * actual results (commodity/public — none contain "model").
 */
export function stripGameModelFields<T extends Record<string, unknown>>(
  row: T
): T {
  const copy = { ...row } as Record<string, unknown>;
  for (const key of Object.keys(copy)) {
    if (key.toLowerCase().includes("model")) copy[key] = null;
  }
  for (const f of PROPRIETARY_GAME_FIELDS) {
    if (f in copy) copy[f] = null;
  }
  return copy as T;
}

/** Shared: null model* fields (prefix rule) + an explicit proprietary list. */
function stripByModelRuleAndList<T extends Record<string, unknown>>(
  row: T,
  extra: readonly string[]
): T {
  const copy = { ...row } as Record<string, unknown>;
  for (const key of Object.keys(copy)) {
    if (key.toLowerCase().includes("model")) copy[key] = null;
  }
  for (const f of extra) {
    if (f in copy) copy[f] = null;
  }
  return copy as T;
}

// Strikeout-prop proprietary fields WITHOUT a "model" token (the prefix rule
// catches modelOverOdds/modelUnderOdds/modelError/modelCorrect/modelRunAt). NOTE
// kLine is the MODEL-recommended line (schema: "Model recommended line") — IP;
// bookLine is the commodity book line and stays. `backtestResult` here is NOT
// stripped: for K-props it is OVER/UNDER/PUSH vs the BOOK line (kPropsBacktest
// Service — a commodity outcome), unlike the HR-prop backtestResult which is
// WIN/LOSS vs the model's verdict. `backtestRunAt` (model-pipeline timing,
// sibling of the stripped modelRunAt) IS stripped for consistency.
const STRIKEOUT_PROPRIETARY_FIELDS = [
  "kProj",
  "kMedian",
  "kP5",
  "kP95",
  "kLine",
  "kPer9",
  "pOver",
  "pUnder",
  "edgeOver",
  "edgeUnder",
  "verdict",
  "bestEdge",
  "bestSide",
  "bestMlStr",
  "signalBreakdown",
  "distribution",
  "matchupRows",
  "inningBreakdown",
  "backtestRunAt",
] as const;

export function stripStrikeoutPropModelFields<
  T extends Record<string, unknown>,
>(row: T): T {
  return stripByModelRuleAndList(row, STRIKEOUT_PROPRIETARY_FIELDS);
}

// HR-prop proprietary fields without a "model" token (prefix rule catches
// modelPHr/modelOverOdds/modelCorrect/modelRunAt). NOTE `backtestResult` is
// MODEL-relative IP: it is WIN/LOSS only when the model's verdict was "OVER"
// (mlbHrPropsBacktestService.ts) — so leaking it re-identifies the model's
// actionable OVER pick list AND its win/loss record on finished games,
// reconstructing the pick direction that `verdict` nulls. `backtestRunAt` is
// model-pipeline timing metadata (sibling of the stripped modelRunAt). Actual
// results (`actualHr` — did the player homer) stay: commodity box-score fact.
const HR_PROPRIETARY_FIELDS = [
  "edgeOver",
  "evOver",
  "verdict",
  "backtestResult",
  "backtestRunAt",
] as const;

export function stripHrPropModelFields<T extends Record<string, unknown>>(
  row: T
): T {
  return stripByModelRuleAndList(row, HR_PROPRIETARY_FIELDS);
}

// WC2026 matchup proprietary fields WITHOUT a "model" token (prefix rule
// catches modelOdds/modelVersion). The projection object + its derived
// odds/edges/probs/scores.
const WC_PROPRIETARY_FIELDS = [
  "projection",
  "homeEdge",
  "drawEdge",
  "awayEdge",
  "homeWinProb",
  "drawProb",
  "awayWinProb",
  "projHomeScore",
  "projAwayScore",
  "projTotal",
  "isFrozen",
  "frozenAt",
] as const;

export function stripWcMatchupModelFields<T extends Record<string, unknown>>(
  row: T
): T {
  return stripByModelRuleAndList(row, WC_PROPRIETARY_FIELDS);
}

/**
 * Cache headers for model-bearing feed endpoints, so gated model IP can never
 * be shared-cached and cross-served to an anonymous scraper (Phase 4 cache-leak
 * fix — closes the path-confusion / header-less-endpoint edge-cache vector at
 * the ORIGIN, independent of any Cloudflare cache rule).
 *
 * - authed: the response carries full model IP → `private, no-store` so no
 *   shared/edge cache stores it, even one that ignores `Vary: Cookie` (which
 *   Cloudflare does). `private` alone is not enough against an "Override TTL"
 *   edge rule — `no-store` is the belt-and-suspenders.
 * - anon: the stripped commodity shape → a short public cache is fine.
 * - always `Vary: Cookie, Authorization, x-tailered-sports-secret` so a
 *   compliant cache keys on cookie and Tailered OS machine credentials.
 *
 * Mirrors the games.list auth-aware header (Phase 3), extended to the strikeout
 * / HR / WC endpoints that previously set NO Cache-Control at all.
 */
// ─── MLB per-market publication gate (POLICY) ─────────────────────────────────
//
// Pure and synchronous. The SOURCE of the verdicts is mlbMarketGates.ts (DB +
// kill switch); this file only decides WHICH FIELDS a gated market owns, so
// that all wire-layer model nulling continues to live in exactly one place.
// Types only are imported, so this file keeps zero runtime DB dependency.
//
// Field assignments are evidence-based (writer + consumer, see the audit's
// GRADING-REPORT and drizzle/schema.ts column docs).

/** Fields owned by exactly ONE of the nine markets. */
export const MLB_MARKET_GAME_FIELDS: Record<MlbMarketKey, readonly string[]> = {
  fg_ml: [
    "modelAwayML",
    "modelHomeML",
    "modelAwayWinPct",
    "modelHomeWinPct",
    "brierFgMl",
    "fgMlCorrect",
  ],
  fg_rl: [
    "awayModelSpread",
    "homeModelSpread",
    "modelAwaySpreadOdds",
    "modelHomeSpreadOdds",
    "spreadEdge",
    "spreadDiff",
    "modelAwayPLCoverPct",
    "modelHomePLCoverPct",
    "fgRlCorrect",
  ],
  fg_total: [
    "modelTotal",
    "modelOverOdds",
    "modelUnderOdds",
    "modelOverRate",
    "modelUnderRate",
    "totalEdge",
    "totalDiff",
    "modelProjTotal",
    "brierFgTotal",
    "fgTotalCorrect",
  ],
  f5_ml: [
    "modelF5AwayML",
    "modelF5HomeML",
    "modelF5AwayWinPct",
    "modelF5HomeWinPct",
    "modelF5PushPct",
    "modelF5PushRaw",
    "brierF5Ml",
    "f5MlCorrect",
  ],
  f5_rl: [
    "modelF5AwayRlOdds",
    "modelF5HomeRlOdds",
    "modelF5AwayRLCoverPct",
    "modelF5HomeRLCoverPct",
    "f5RlCorrect",
  ],
  f5_total: [
    "modelF5Total",
    "modelF5OverOdds",
    "modelF5UnderOdds",
    "modelF5OverRate",
    "modelF5UnderRate",
    "brierF5Total",
    "f5TotalCorrect",
  ],
  nrfi_yrfi: [
    "modelPNrfi",
    "modelNrfiOdds",
    "modelYrfiOdds",
    "nrfiCombinedSignal",
    "nrfiFilterPass",
    "brierNrfi",
    "nrfiCorrect",
    "nrfiBacktestResult",
    "nrfiBacktestRunAt",
    "modelInningPNeitherScores",
  ],
  // Team-level HR probabilities live on the games row; the per-player prop
  // fields are gated separately by applyMlbMarketGatesToHrProp.
  hr_props: [
    "modelAwayHrPct",
    "modelHomeHrPct",
    "modelBothHrPct",
    "modelAwayExpHr",
    "modelHomeExpHr",
  ],
  // K-props carry no games-row fields — everything lives on mlb_strikeout_props.
  k_props: [],
};

/**
 * Fields that RECONSTRUCT more than one market, so they must be nulled when ANY
 * contributing market is gated. Leaving them would defeat the gate: the pair
 * (awayScore, homeScore) yields the run-line margin by difference, the total by
 * sum, and the moneyline lean by the SIGN of the difference — which is why
 * fg_ml belongs here alongside fg_rl and fg_total.
 */
export const MLB_CROSS_MARKET_GAME_FIELDS: ReadonlyArray<{
  fields: readonly string[];
  gatedWhenAnyOf: readonly MlbMarketKey[];
}> = [
  {
    fields: ["modelAwayScore", "modelHomeScore"],
    gatedWhenAnyOf: ["fg_ml", "fg_rl", "fg_total"],
  },
  {
    fields: ["modelF5AwayScore", "modelF5HomeScore"],
    gatedWhenAnyOf: ["f5_ml", "f5_rl", "f5_total"],
  },
  {
    // 9-element per-inning arrays: index 0 restores the first-inning scoring
    // probabilities behind NRFI, I1–I5 restore the F5 projections, and the
    // 9-inning sums restore the full-game scores and total.
    fields: [
      "modelInningHomeExp",
      "modelInningAwayExp",
      "modelInningTotalExp",
      "modelInningPHomeScores",
      "modelInningPAwayScores",
    ],
    gatedWhenAnyOf: [
      "nrfi_yrfi",
      "f5_ml",
      "f5_rl",
      "f5_total",
      "fg_ml",
      "fg_rl",
      "fg_total",
    ],
  },
  {
    // One run-environment multiplier applied to the whole simulation; it biases
    // the totals, NRFI and the HR block simultaneously.
    fields: ["modelWeatherAdj"],
    gatedWhenAnyOf: ["fg_total", "f5_total", "nrfi_yrfi", "hr_props"],
  },
];

/**
 * NEVER gate `modelRunAt` per market. It is the row-level model-freshness key,
 * and the feed derives `hasModel = g.modelRunAt != null` from it to produce the
 * established "—" state for EVERY market at once. Nulling it under a single
 * market's gate would silently blank all nine.
 */
export const MLB_MARKET_GATE_NEVER_NULL = ["modelRunAt"] as const;

/** Per-player strikeout-prop fields owned by publish_k_props. */
const K_PROP_GATED_FIELDS = [
  "kProj",
  "kLine",
  "kPer9",
  "kMedian",
  "kP5",
  "kP95",
  "pOver",
  "pUnder",
  "modelOverOdds",
  "modelUnderOdds",
  "edgeOver",
  "edgeUnder",
  "verdict",
  "bestEdge",
  "bestSide",
  "bestMlStr",
  "signalBreakdown",
  "matchupRows",
  "distribution",
  "inningBreakdown",
  "modelError",
  "modelCorrect",
  "modelRunAt",
  "backtestRunAt",
] as const;

/**
 * Per-player HR-prop fields owned by publish_hr_props. `backtestResult` IS
 * included — for HR props it is WIN/LOSS against the model's own verdict, so it
 * re-identifies the pick list (unlike the K-prop backtestResult, which grades
 * against the BOOK line and is commodity).
 */
const HR_PROP_GATED_FIELDS = [
  "modelPHr",
  "modelOverOdds",
  "edgeOver",
  "evOver",
  "verdict",
  "backtestResult",
  "modelCorrect",
  "modelRunAt",
  "backtestRunAt",
] as const;

function nullFields<T extends Record<string, unknown>>(
  row: T,
  fields: readonly string[]
): T {
  let copy: Record<string, unknown> | null = null;
  for (const f of fields) {
    if (f in row) {
      if (!copy) copy = { ...row };
      copy[f] = null;
    }
  }
  return (copy ?? row) as T;
}

/**
 * Null the fields of every gated market on a Game row. Pure; returns the SAME
 * object reference when nothing is gated, so an all-published snapshot cannot
 * change a byte of the response.
 */
export function applyMlbMarketGatesToGame<T extends Record<string, unknown>>(
  row: T,
  gates: MlbMarketGates
): T {
  const doomed: string[] = [];
  for (const key of Object.keys(MLB_MARKET_GAME_FIELDS) as MlbMarketKey[]) {
    if (gates[key] === false) doomed.push(...MLB_MARKET_GAME_FIELDS[key]);
  }
  for (const entry of MLB_CROSS_MARKET_GAME_FIELDS) {
    if (entry.gatedWhenAnyOf.some(k => gates[k] === false)) {
      doomed.push(...entry.fields);
    }
  }
  if (doomed.length === 0) return row;
  const safe = doomed.filter(
    f => !(MLB_MARKET_GATE_NEVER_NULL as readonly string[]).includes(f)
  );
  return nullFields(row, safe);
}

/** Null model output on a strikeout-prop row when publish_k_props is 0. */
export function applyMlbMarketGatesToStrikeoutProp<
  T extends Record<string, unknown>,
>(row: T, gates: MlbMarketGates): T {
  if (gates.k_props !== false) return row;
  return nullFields(row, K_PROP_GATED_FIELDS);
}

/** Null model output on an HR-prop row when publish_hr_props is 0. */
export function applyMlbMarketGatesToHrProp<T extends Record<string, unknown>>(
  row: T,
  gates: MlbMarketGates
): T {
  if (gates.hr_props !== false) return row;
  return nullFields(row, HR_PROP_GATED_FIELDS);
}

export function setGatedCacheHeaders(
  res: { setHeader?: (name: string, value: string) => void } | undefined,
  authed: boolean
): void {
  if (!res || typeof res.setHeader !== "function") return;
  res.setHeader("Vary", GATED_FEED_VARY);
  res.setHeader(
    "Cache-Control",
    authed
      ? "private, no-store"
      : "public, max-age=30, stale-while-revalidate=60"
  );
}
