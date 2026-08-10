/**
 * buildManifest.ts — turns a dry-run result into a sealed, reviewable manifest.
 *
 * This is the bridge between the two halves of the closeout architecture:
 * ingestMlbOutcomes({ dryRun: true, historical: true }) computes what a repair
 * WOULD do without mutating anything, and this module freezes that result into
 * the immutable artifact applyRepairManifest() consumes.
 *
 * Nothing here talks to a database or the network. It is a pure transform over
 * a dry-run summary, which is what makes the manifest reproducible: the same
 * dry-run output always yields the same checksum.
 */
import {
  classifyCandidate,
  reconcileAccounting,
  sealManifest,
  sha256,
  stableStringify,
  type AccountingResult,
  type BrierMap,
  type CandidateInputs,
  type ComputedOutcomes,
  type ManifestRow,
  type RepairManifest,
  type SealedManifest,
} from "./repairManifest";
import { diffBrier } from "./repairManifest";
import type { BinaryOutcome } from "./brierOracle";

/**
 * The shape this module needs from a dry-run row. Declared structurally rather
 * than importing OutcomeIngestResult so the manifest layer stays decoupled from
 * the ingestor's evolving result type.
 */
export interface DryRunRow {
  gameId: number;
  matchup: string;
  gameDate: string;
  status: string;
  mlbGamePk?: number | null;
  outcomeIngestedAt?: number | null;
  matchMethod?: ManifestRow["matchMethod"];
  previousBrier?: BrierMap | null;
  brierFgTotal: number | null;
  brierF5Total: number | null;
  brierNrfi: number | null;
  brierFgMl: number | null;
  brierF5Ml: number | null;
  actualFgTotal: number | null;
  actualF5Total: number | null;
  actualNrfiBinary: number | null;
  inputs?: CandidateInputs | null;
  outcomes?: ComputedOutcomes | null;
  error?: string;
  ambiguous?: boolean;
  doubleheader?: boolean;
  previousActualFgTotal?: string | null;
}

export interface BuildManifestOptions {
  repairRunId: string;
  generatedAt: number;
  codeSha: string;
  schemaVersion: string;
  /**
   * REQUIRED. The production defect interval. Candidate admission is enforced
   * here rather than left to a caller who may forget to apply it — a row that
   * was not scored inside this window can never become a writable correction.
   */
  window: DefectWindow;
  rows: DryRunRow[];
}

export interface BuildManifestResult {
  sealed: SealedManifest;
  accounting: AccountingResult;
}

const NULL_BRIER: BrierMap = {
  brierFgTotal: null,
  brierF5Total: null,
  brierNrfi: null,
  brierFgMl: null,
  brierF5Ml: null,
};

const EMPTY_INPUTS: CandidateInputs = {
  modelOverRate: null,
  modelF5OverRate: null,
  modelPNrfi: null,
  modelHomeWinPct: null,
  modelF5HomeWinPct: null,
  bookTotal: null,
  f5Total: null,
};

const EMPTY_OUTCOMES: ComputedOutcomes = {
  actualFgTotal: null,
  actualF5Total: null,
  actualNrfiBinary: null,
  outcomeFgOver: null,
  outcomeF5Over: null,
  outcomeNrfi: null,
  outcomeHomeWin: null,
  outcomeF5HomeWin: null,
};

/**
 * Deterministic hash of the NORMALIZED evidence used to compute this row.
 *
 * Named precisely (Phase S): this is not a hash of the raw MLB Stats API
 * payload. It covers the normalized outcome + input evidence that actually
 * determined the proposed values, which is what must be provably identical
 * between review and apply. Raw upstream payloads are deliberately not stored.
 */
export function sourceEvidenceHash(row: DryRunRow): string {
  return sha256(
    stableStringify({
      gameId: row.gameId,
      mlbGamePk: row.mlbGamePk ?? null,
      actualFgTotal: row.actualFgTotal,
      actualF5Total: row.actualF5Total,
      actualNrfiBinary: row.actualNrfiBinary,
      inputs: row.inputs ?? EMPTY_INPUTS,
    })
  );
}

/**
 * Builds and seals a manifest from dry-run rows.
 *
 * The accounting identity is reconciled here and returned alongside the sealed
 * artifact: a caller that ignores `accounting.balanced` is not permitted to
 * proceed, and applyRepairManifest re-checks the invariants independently.
 */
export function buildRepairManifest(
  opts: BuildManifestOptions
): BuildManifestResult {
  assertValidDefectWindow(opts.window);

  const rows: ManifestRow[] = opts.rows.map(r => {
    const admission = classifyWindowAdmission(r.outcomeIngestedAt, opts.window);

    const base = {
      gameRowId: r.gameId,
      mlbGamePk: r.mlbGamePk ?? null,
      gameDate: r.gameDate,
      matchup: r.matchup,
      outcomeIngestedAt: r.outcomeIngestedAt ?? null,
      sourcePayloadHash: sourceEvidenceHash(r),
      previousActualFgTotal: r.previousActualFgTotal ?? null,
    };

    /** A row that cannot be repaired still carries its evidence, unfabricated. */
    const terminal = (
      classification: ManifestRow["classification"],
      reason: string
    ): ManifestRow => ({
      ...base,
      matchMethod: r.matchMethod ?? "none",
      previousBrier: r.previousBrier ?? { ...NULL_BRIER },
      inputs: r.inputs ?? EMPTY_INPUTS,
      computedOutcomes: r.outcomes ?? EMPTY_OUTCOMES,
      proposedBrier: { ...NULL_BRIER },
      changeFields: [],
      classification,
      reason,
    });

    // ── Candidate admission: the defect window is structural, not advisory ──
    if (admission === "NOT_PROVEN") {
      return terminal(
        "INVESTIGATION_REQUIRED",
        "scoring time unknown — cannot prove the row was or was not scored by the defective code"
      );
    }
    if (admission === "PROVEN_OUTSIDE") {
      return terminal(
        "OUTSIDE_DEFECT_WINDOW",
        `outcomeIngestedAt=${r.outcomeIngestedAt} lies outside [${opts.window.defectStartMs}, ${opts.window.fixDeployedAtMs})`
      );
    }

    // ── Structural non-candidates classify on identity alone ───────────────
    // A row with no API pairing, an ambiguous pairing, or an upstream error has
    // no outcome evidence to supply — demanding it would mislabel a genuine
    // MISSING_MLB_MATCH / AMBIGUOUS_MATCH as EVIDENCE_INCOMPLETE and hide the
    // real reason the row cannot be repaired. classifyCandidate decides these
    // structural cases before it ever looks at values.
    const structurallyUnmatched =
      r.matchMethod === "none" || r.ambiguous === true || Boolean(r.error);
    if (structurallyUnmatched) {
      const { classification, reason } = classifyCandidate({
        previousBrier: r.previousBrier ?? { ...NULL_BRIER },
        proposedBrier: { ...NULL_BRIER },
        inputs: r.inputs ?? EMPTY_INPUTS,
        matchMethod: r.matchMethod ?? "none",
        sourceError: r.error ?? null,
        ambiguous: r.ambiguous === true,
        doubleheader: r.doubleheader === true,
      });
      return terminal(classification, reason ?? "structurally unmatched");
    }

    // ── Evidence completeness: unknown is NOT null ──────────────────────────
    // Defaulting absent evidence to an empty object would let a row with no
    // recorded pre-image look like a clean NULL → value correction. Missing
    // evidence gets its own terminal classification instead.
    const missing: string[] = [];
    if (r.previousBrier === null || r.previousBrier === undefined) {
      missing.push("previousBrier");
    }
    if (r.inputs === null || r.inputs === undefined) missing.push("inputs");
    if (r.outcomes === null || r.outcomes === undefined)
      missing.push("outcomes");
    if (r.matchMethod === undefined) missing.push("matchMethod");
    if (missing.length > 0) {
      return terminal(
        "EVIDENCE_INCOMPLETE",
        `dry run did not supply: ${missing.join(", ")}`
      );
    }

    const previousBrier = r.previousBrier as BrierMap;
    const inputs = r.inputs as CandidateInputs;
    const computedOutcomes = r.outcomes as ComputedOutcomes;
    const matchMethod = r.matchMethod as ManifestRow["matchMethod"];

    const proposedBrier: BrierMap = {
      brierFgTotal: r.brierFgTotal,
      brierF5Total: r.brierF5Total,
      brierNrfi: r.brierNrfi,
      brierFgMl: r.brierFgMl,
      brierF5Ml: r.brierF5Ml,
    };

    const { classification, changeFields, reason } = classifyCandidate({
      previousBrier,
      proposedBrier,
      inputs,
      matchMethod,
      sourceError: r.error ?? null,
      ambiguous: r.ambiguous === true,
      doubleheader: r.doubleheader === true,
    });

    return {
      ...base,
      matchMethod,
      previousBrier,
      inputs,
      computedOutcomes,
      proposedBrier,
      changeFields: changeFields.length
        ? changeFields
        : diffBrier(previousBrier, proposedBrier),
      classification,
      reason,
    };
  });

  const manifest: RepairManifest = {
    repairRunId: opts.repairRunId,
    generatedAt: opts.generatedAt,
    codeSha: opts.codeSha,
    schemaVersion: opts.schemaVersion,
    defectWindowStart: new Date(opts.window.defectStartMs).toISOString(),
    defectWindowEnd: new Date(opts.window.fixDeployedAtMs).toISOString(),
    dates: Array.from(new Set(rows.map(r => r.gameDate))).sort(),
    rows,
  };

  return {
    sealed: sealManifest(manifest),
    accounting: reconcileAccounting(rows),
  };
}

/**
 * The production interval during which rows were scored by the defective
 * unit-conversion. Both bounds are PRODUCTION timestamps, not commit dates.
 *
 * defectStartMs — when the defective scorer became active in production.
 * fixDeployedAtMs — when the corrected scorer became active in production.
 *
 * The evidence record must carry the real deployment timestamp for
 * fixDeployedAtMs. A commit date is NOT a substitute: code lands and deploys at
 * different moments, and using the earlier of the two would silently exclude
 * rows scored in the gap between merge and deploy.
 */
export interface DefectWindow {
  defectStartMs: number;
  fixDeployedAtMs: number;
}

/**
 * A row is inside the M-203 defect window when it was SCORED inside that
 * interval — not when the game was played.
 *
 * This distinction is load-bearing. An April game re-ingested in July carries
 * correct scores and must not be repaired; a July game scored before the fix
 * must be. Selecting on game date would get both wrong.
 *
 * Boundary contract, stated explicitly rather than left to be inferred:
 *
 *   defectStartMs   INCLUSIVE  (a row scored at the instant the defect went
 *                              live carries the defect)
 *   fixDeployedAtMs EXCLUSIVE  (a row scored at the instant the fix went live
 *                              was scored by the corrected code)
 *
 * Fails closed: a null, undefined, NaN or non-finite timestamp is NOT treated
 * as in-window, because a row whose scoring time is unknown cannot be proven
 * defective and must be classified for investigation instead of silently
 * repaired.
 */
/**
 * Rejects a window that cannot describe a real production interval.
 *
 * There is no single-bound form. An open-ended window (defectStart = -Infinity)
 * would admit every row ever scored, including rows scored before the defective
 * code existed, so it is not a weaker-but-acceptable variant — it is wrong.
 */
export function assertValidDefectWindow(w: DefectWindow): void {
  for (const [k, v] of [
    ["defectStartMs", w?.defectStartMs],
    ["fixDeployedAtMs", w?.fixDeployedAtMs],
  ] as const) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(
        `[M203] invalid defect window: ${k}=${String(v)} is not a finite production timestamp`
      );
    }
  }
  if (w.defectStartMs >= w.fixDeployedAtMs) {
    throw new Error(
      `[M203] invalid defect window: defectStartMs (${w.defectStartMs}) must precede fixDeployedAtMs (${w.fixDeployedAtMs})`
    );
  }
}

/**
 * Three-way admission, because "not proven inside the window" and "proven
 * outside the window" are different facts and collapsing them loses evidence.
 *
 * A row whose scoring time is unknown is NOT proof that the row is unaffected.
 * It becomes NOT_PROVEN and must reach an explicit terminal classification
 * (INVESTIGATION_REQUIRED), never a silent exclusion from the population.
 */
export type WindowAdmission = "IN_WINDOW" | "PROVEN_OUTSIDE" | "NOT_PROVEN";

export function classifyWindowAdmission(
  outcomeIngestedAt: number | null | undefined,
  window: DefectWindow
): WindowAdmission {
  assertValidDefectWindow(window);
  if (
    outcomeIngestedAt === null ||
    outcomeIngestedAt === undefined ||
    typeof outcomeIngestedAt !== "number" ||
    !Number.isFinite(outcomeIngestedAt)
  ) {
    return "NOT_PROVEN";
  }
  return outcomeIngestedAt >= window.defectStartMs &&
    outcomeIngestedAt < window.fixDeployedAtMs
    ? "IN_WINDOW"
    : "PROVEN_OUTSIDE";
}

/**
 * A row is inside the M-203 defect window when it was SCORED inside that
 * interval — not when the game was played.
 *
 * This distinction is load-bearing. An April game re-ingested in July carries
 * correct scores and must not be repaired; a July game scored before the fix
 * must be. Selecting on game date would get both wrong.
 *
 * Boundary contract, stated explicitly rather than left to be inferred:
 *
 *   defectStartMs   INCLUSIVE  (a row scored at the instant the defect went
 *                              live carries the defect)
 *   fixDeployedAtMs EXCLUSIVE  (a row scored at the instant the fix went live
 *                              was scored by the corrected code)
 *
 * Fails closed on an unknown or invalid scoring time. Use
 * classifyWindowAdmission() where the NOT_PROVEN vs PROVEN_OUTSIDE distinction
 * matters, which it does for candidate accounting.
 */
export function isInDefectWindow(
  outcomeIngestedAt: number | null | undefined,
  window: DefectWindow
): boolean {
  return classifyWindowAdmission(outcomeIngestedAt, window) === "IN_WINDOW";
}
