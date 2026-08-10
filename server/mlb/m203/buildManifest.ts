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
  defectWindowStart: string;
  defectWindowEnd: string;
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

/** Hashes the upstream payload a row was derived from, for provenance. */
export function sourcePayloadHash(row: DryRunRow): string {
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
  const rows: ManifestRow[] = opts.rows.map(r => {
    const previousBrier: BrierMap = r.previousBrier ?? { ...NULL_BRIER };
    const proposedBrier: BrierMap = {
      brierFgTotal: r.brierFgTotal,
      brierF5Total: r.brierF5Total,
      brierNrfi: r.brierNrfi,
      brierFgMl: r.brierFgMl,
      brierF5Ml: r.brierF5Ml,
    };
    const inputs = r.inputs ?? EMPTY_INPUTS;
    const computedOutcomes = r.outcomes ?? {
      ...EMPTY_OUTCOMES,
      actualFgTotal: r.actualFgTotal,
      actualF5Total: r.actualF5Total,
      actualNrfiBinary: r.actualNrfiBinary,
      outcomeNrfi: (r.actualNrfiBinary as BinaryOutcome | null) ?? null,
    };

    const matchMethod: ManifestRow["matchMethod"] =
      r.matchMethod ??
      (r.status === "skipped_no_api_match"
        ? "none"
        : r.mlbGamePk
          ? "mlbGamePk"
          : "teamAbbrev");

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
      gameRowId: r.gameId,
      mlbGamePk: r.mlbGamePk ?? null,
      gameDate: r.gameDate,
      matchup: r.matchup,
      matchMethod,
      outcomeIngestedAt: r.outcomeIngestedAt ?? null,
      sourcePayloadHash: sourcePayloadHash(r),
      previousBrier,
      previousActualFgTotal: r.previousActualFgTotal ?? null,
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
    defectWindowStart: opts.defectWindowStart,
    defectWindowEnd: opts.defectWindowEnd,
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
export function isInDefectWindow(
  outcomeIngestedAt: number | null | undefined,
  window: DefectWindow | number
): boolean {
  if (outcomeIngestedAt === null || outcomeIngestedAt === undefined) {
    return false;
  }
  if (
    typeof outcomeIngestedAt !== "number" ||
    !Number.isFinite(outcomeIngestedAt)
  ) {
    return false;
  }
  const w: DefectWindow =
    typeof window === "number"
      ? { defectStartMs: Number.NEGATIVE_INFINITY, fixDeployedAtMs: window }
      : window;
  return (
    outcomeIngestedAt >= w.defectStartMs &&
    outcomeIngestedAt < w.fixDeployedAtMs
  );
}
