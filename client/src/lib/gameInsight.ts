/**
 * ═══════════════════════════════════════════════════════════════════════════
 * gameInsight — the deterministic decision layer for the Model Projections feed
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Composes the canonical odds primitives in `edgeUtils.ts` into the three
 * things the redesigned game card needs for a 3-second decision:
 *
 *   1. classifyEdge()   → BET | WATCH | NO_EDGE, from documented, configurable
 *                         thresholds (never from color, row position, or styling).
 *   2. expectedValue()  → +units per unit staked, from model probability and the
 *                         price actually available at the book.
 *   3. rankMarkets()    → every market side scored and sorted strongest-first, so
 *                         the card can surface the single best opportunity as its
 *                         dominant element (primaryInsight()).
 *
 * Everything here is pure and side-effect-free. Raw odds and derived metrics are
 * kept separate in the return shape (MarketInsight) so the UI never re-derives.
 *
 * ── Edge definition (reconciliation note) ─────────────────────────────────────
 * The `edgePP` used for the headline number and the recommendation is the
 * project's canonical RAW edge: (modelImplied − bookImplied) × 100 — the same
 * `calculateEdge` the rest of the app displays. This is what reproduces the
 * directive's worked example exactly:
 *     Over 8.5 · best price −102 · model fair −109 → +1.7pp → WATCH.
 * (No-vig normalization of that same example yields ~+3.8pp, which would classify
 * as BET and contradict the example's stated WATCH. So RAW drives the label.)
 * The no-vig fair book price/probability are still computed and exposed on every
 * MarketInsight (`bookNoVigPct`, `noVigEdgePP`) for the "sportsbook margin
 * removed" comparison the card shows — they are supporting detail, not the label.
 */

import {
  americanToImplied,
  americanToDecimal,
  calculateRoi,
  removeVig,
} from "./edgeUtils";

export type Recommendation = "BET" | "WATCH" | "NO_EDGE";

/** Probability-edge thresholds, in percentage points. Configurable per call. */
export const BET_THRESHOLD_PP = 2.5; // ≥ 2.5pp → BET   (matches getVerdict "PLAYABLE"+)
export const WATCH_THRESHOLD_PP = 1.5; // ≥ 1.5pp → WATCH (matches EDGE_THRESHOLD_PP)

export interface EdgeThresholds {
  bet?: number;
  watch?: number;
}

/**
 * Map a probability edge (in percentage points) to a recommendation.
 * Non-finite input (NaN / missing) is NO_EDGE — never an invented label.
 */
export function classifyEdge(
  edgePercentagePoints: number,
  thresholds: EdgeThresholds = {}
): Recommendation {
  const bet = thresholds.bet ?? BET_THRESHOLD_PP;
  const watch = thresholds.watch ?? WATCH_THRESHOLD_PP;
  if (!Number.isFinite(edgePercentagePoints)) return "NO_EDGE";
  if (edgePercentagePoints >= bet) return "BET";
  if (edgePercentagePoints >= watch) return "WATCH";
  return "NO_EDGE";
}

/**
 * Expected value per 1 unit staked at the given American price, using the
 * model's probability. EV = p·decimal − 1. Positive EV = +units per unit risked.
 * Returns NaN on invalid input.
 */
export function expectedValue(
  modelProbability: number,
  americanPrice: number
): number {
  if (!Number.isFinite(modelProbability) || !Number.isFinite(americanPrice))
    return NaN;
  const decimal = americanToDecimal(americanPrice);
  if (isNaN(decimal)) return NaN;
  return modelProbability * decimal - 1;
}

/** One side of a market, as the card supplies it. Prices are American odds. */
export interface MarketSideInput {
  /** stable key: "runline" | "total" | "moneyline" | … */
  marketKey: string;
  /** human label: "Run line", "Total", "Moneyline" */
  marketLabel: string;
  /** side label: "Over 8.5", "MIL +1.5", "PIT ML" */
  sideLabel: string;
  /** book's American price for THIS side */
  bookPrice: number | null | undefined;
  /** book's American price for the OPPOSITE side (for no-vig fair price) */
  bookOppPrice?: number | null | undefined;
  /** model's American fair price for THIS side (model has no vig; it is fair) */
  modelPrice: number | null | undefined;
  /** False when the model price applies to a different threshold than the book. */
  comparable?: boolean;
}

/** A fully-scored market side. Raw and derived metrics kept separate. */
export interface MarketInsight {
  marketKey: string;
  marketLabel: string;
  sideLabel: string;
  /** raw inputs */
  bookPrice: number;
  modelFairPrice: number;
  /** derived (all probabilities as percentages 0–100) */
  bookImpliedPct: number;
  bookNoVigPct: number | null;
  modelProbPct: number;
  /** canonical RAW probability edge, pp — drives the headline + recommendation */
  edgePP: number;
  /** no-vig probability edge, pp — supporting "margin removed" comparison */
  noVigEdgePP: number | null;
  /** expected value per unit staked at the book price */
  evUnits: number;
  /**
   * Canonical display ROI, in percentage points. This compares model
   * probability with the book's no-vig probability (calculateRoi), so it is
   * deliberately distinct from posted-price `evUnits`.
   */
  roiPct: number | null;
  recommendation: Recommendation;
}

function toNum(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : NaN;
}

/**
 * Score a single market side. Returns null when the side cannot be evaluated
 * (missing/invalid book or model price) — an unavailable market, never a guess.
 */
export function scoreMarketSide(
  side: MarketSideInput,
  thresholds: EdgeThresholds = {}
): MarketInsight | null {
  if (side.comparable === false) return null;
  const bookPrice = toNum(side.bookPrice);
  const modelPrice = toNum(side.modelPrice);
  if (isNaN(bookPrice) || isNaN(modelPrice)) return null;

  const bookImplied = americanToImplied(bookPrice); // raw, vig-inclusive
  const modelProb = americanToImplied(modelPrice); // model's fair probability
  if (isNaN(bookImplied) || isNaN(modelProb)) return null;

  const edgePP = (modelProb - bookImplied) * 100; // canonical calculateEdge

  // No-vig fair book price for this side (needs the opposite side's price).
  let bookNoVigPct: number | null = null;
  let noVigEdgePP: number | null = null;
  let roiPct: number | null = null;
  const oppPrice = toNum(side.bookOppPrice);
  if (!isNaN(oppPrice)) {
    const fair = removeVig(String(bookPrice), String(oppPrice));
    if (fair) {
      bookNoVigPct = fair[0]; // removeVig returns [thisSide, oppSide] for the args passed
      noVigEdgePP = modelProb * 100 - bookNoVigPct;
    }
    const canonicalRoi = calculateRoi(modelPrice, bookPrice, oppPrice);
    if (Number.isFinite(canonicalRoi)) roiPct = canonicalRoi;
  }

  return {
    marketKey: side.marketKey,
    marketLabel: side.marketLabel,
    sideLabel: side.sideLabel,
    bookPrice,
    modelFairPrice: modelPrice,
    bookImpliedPct: bookImplied * 100,
    bookNoVigPct,
    modelProbPct: modelProb * 100,
    edgePP,
    noVigEdgePP,
    evUnits: expectedValue(modelProb, bookPrice),
    roiPct,
    recommendation: classifyEdge(edgePP, thresholds),
  };
}

/**
 * Score and rank every valid market side, strongest opportunity first.
 * Ranking is by RAW probability edge desc, tie-broken by expected value desc —
 * deterministic and independent of input order, color, or row position.
 */
export function rankMarkets(
  sides: MarketSideInput[],
  thresholds: EdgeThresholds = {}
): MarketInsight[] {
  return sides
    .map(s => scoreMarketSide(s, thresholds))
    .filter((x): x is MarketInsight => x !== null)
    .sort((a, b) => {
      if (b.edgePP !== a.edgePP) return b.edgePP - a.edgePP;
      return b.evUnits - a.evUnits;
    });
}

/**
 * The single strongest VALID opportunity for the card's dominant insight slot —
 * or null when no market has a positive edge worth surfacing (all NO_EDGE).
 * A ranked-but-negative-edge board returns null rather than promoting a fade.
 */
export function primaryInsight(
  sides: MarketSideInput[],
  thresholds: EdgeThresholds = {}
): MarketInsight | null {
  const top = rankMarkets(sides, thresholds)[0];
  if (!top) return null;
  return top.recommendation === "NO_EDGE" ? null : top;
}
