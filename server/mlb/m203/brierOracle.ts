/**
 * brierOracle.ts — INDEPENDENT verification calculator for the M-203 repair.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * Verifying a repaired Brier score by calling the same helper that produced it
 * proves only that the function is deterministic. If that helper carries a
 * defect, generation and verification fail identically and the error is
 * invisible — a common-mode failure. M-203 exists BECAUSE such a defect went
 * undetected for 114 days.
 *
 * This module is therefore written from first principles and MUST NOT import
 * anything from server/mlbOutcomeIngestor.ts. That independence is enforced by
 * test (see brierOracle.test.ts) so a future refactor cannot quietly collapse
 * the two implementations back together.
 *
 * ── Scale contract (the M-203 defect itself) ────────────────────────────────
 * The games table stores model probabilities on TWO scales and nothing in the
 * schema distinguishes them:
 *
 *   PERCENT (0-100): modelOverRate, modelHomeWinPct, modelF5HomeWinPct
 *   UNIT    (0-1):   modelF5OverRate, modelPNrfi
 *
 * The pre-M-203 scorer divided EVERY input by 100, so a genuine 0.66 unit-scale
 * probability was scored as 0.0066. This module requires the scale to be named
 * explicitly at every call site — there is no default and no inference.
 */

/** Which storage scale a persisted probability column uses. */
export type ProbabilityScale = "percent" | "unit";

/** A binary outcome: 1 = the event occurred, 0 = it did not. */
export type BinaryOutcome = 0 | 1;

/** Why a probability was rejected as unusable. */
export type ProbabilityRejection = "ABSENT" | "NOT_NUMERIC" | "OUT_OF_DOMAIN";

export interface ProbabilityReading {
  /** Normalized [0,1] probability, or null when unusable. */
  value: number | null;
  /** Populated only when value is null. */
  rejection: ProbabilityRejection | null;
  /** The raw persisted value, echoed for evidence. */
  raw: string | null;
}

/**
 * Reads a persisted probability under an EXPLICIT scale and normalizes it to
 * [0,1], refusing anything outside the column's declared domain.
 *
 * Domain enforcement is deliberate and non-clamping (M-203 closeout Phase 10):
 * a percent column holding 0.66, or a unit column holding 66, is corrupt input,
 * not a value to be silently rescued. Clamping such a row would fabricate a
 * forecast the model never made.
 */
export function readProbability(
  raw: string | number | null | undefined,
  scale: ProbabilityScale
): ProbabilityReading {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return {
      value: null,
      rejection: "ABSENT",
      raw: raw == null ? null : String(raw),
    };
  }
  const rawStr = String(raw);
  const n = Number(rawStr);
  if (!Number.isFinite(n)) {
    return { value: null, rejection: "NOT_NUMERIC", raw: rawStr };
  }
  const max = scale === "percent" ? 100 : 1;
  if (n < 0 || n > max) {
    return { value: null, rejection: "OUT_OF_DOMAIN", raw: rawStr };
  }
  return {
    value: scale === "percent" ? n / 100 : n,
    rejection: null,
    raw: rawStr,
  };
}

/**
 * The Brier score, from first principles: BS = (p - o)^2.
 *
 * Rounded to 6 decimals to match the games table's decimal(7,6) Brier columns —
 * storing more precision than the column holds would guarantee a false mismatch
 * on read-back verification.
 *
 * Returns null when either input is unavailable; a null Brier is a legitimate
 * result (a push, a tie, or an unpriced market), NOT an error.
 */
export function oracleBrier(
  p: number | null,
  outcome: BinaryOutcome | null
): number | null {
  if (p === null || outcome === null) return null;
  if (!Number.isFinite(p) || p < 0 || p > 1) return null;
  const diff = p - outcome;
  return Number((diff * diff).toFixed(6));
}

/**
 * Every Brier score the games table stores, with its column's scale.
 * This table IS the M-203 contract — it is what the defective scorer got wrong.
 */
export const BRIER_MARKETS = [
  { field: "brierFgTotal", probColumn: "modelOverRate", scale: "percent" },
  { field: "brierF5Total", probColumn: "modelF5OverRate", scale: "unit" },
  { field: "brierNrfi", probColumn: "modelPNrfi", scale: "unit" },
  { field: "brierFgMl", probColumn: "modelHomeWinPct", scale: "percent" },
  { field: "brierF5Ml", probColumn: "modelF5HomeWinPct", scale: "percent" },
] as const satisfies ReadonlyArray<{
  field: string;
  probColumn: string;
  scale: ProbabilityScale;
}>;

export type BrierField = (typeof BRIER_MARKETS)[number]["field"];

/**
 * The two markets M-203 repairs — the unit-scaled ones the old scorer
 * double-divided.
 */
export const M203_AFFECTED_FIELDS: readonly BrierField[] = [
  "brierF5Total",
  "brierNrfi",
];

/**
 * The three markets that were ALREADY correct and must not move. Used as a
 * production stop condition: if one of these changes during a repair, the run
 * is doing something beyond M-203 and must halt.
 */
export const M203_INVARIANT_FIELDS: readonly BrierField[] = [
  "brierFgTotal",
  "brierFgMl",
  "brierF5Ml",
];

/** A Brier score is a squared difference of values in [0,1]. */
export function isBrierInDomain(v: number | null): boolean {
  return v === null || (Number.isFinite(v) && v >= 0 && v <= 1);
}

/**
 * Reproduces the PRE-M-203 defective scorer exactly, for evidence only.
 *
 * The old implementation divided every input by 100 regardless of scale. This
 * lets a repair manifest state what the stored value SHOULD have been under the
 * defect, which is how a row is confirmed to be genuinely M-203-affected rather
 * than wrong for some unrelated reason. Never use this to write anything.
 */
export function defectiveBrierForEvidence(
  rawProbability: string | number | null | undefined,
  outcome: BinaryOutcome | null
): number | null {
  if (rawProbability === null || rawProbability === undefined) return null;
  if (outcome === null) return null;
  const p = Number(String(rawProbability)) / 100;
  if (!Number.isFinite(p) || p < 0 || p > 1) return null;
  return Number(Math.pow(p - outcome, 2).toFixed(6));
}

/** Comparison tolerance at decimal(7,6) storage resolution. */
export const BRIER_EPSILON = 5e-7;

/** Equality at the resolution the database can actually store. */
export function brierEquals(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= BRIER_EPSILON;
}
