/**
 * applyApproved.ts — the single authorized entry point for an M-203 historical
 * repair write.
 *
 * ── Why a client-submitted manifest is safe here ────────────────────────────
 * The approved manifest arrives from outside (a human reviewed it after a dry
 * run), so it must be treated as untrusted input. Four independent controls
 * make a fabricated manifest unusable:
 *
 *   1. REPRODUCIBILITY. The server re-runs the historical dry run for the same
 *      date and requires the regenerated manifest's checksum to equal the
 *      submitted one. A manifest the server cannot itself reproduce is
 *      rejected. This is a consistency check only — the values written still
 *      come from the approved artifact, never from the re-run.
 *   2. IDENTITY. codeSha and schemaVersion must match the deployed system.
 *   3. COMPARE-AND-SWAP. Each row must still hold the exact recorded pre-image,
 *      so a manifest cannot target rows whose current state it misstates.
 *   4. ORACLE + INVARIANT. Proposed values must be mathematically consistent
 *      with the recorded inputs, and no percent-scaled market may move.
 *
 * failFast is not a parameter here. A stop condition discovered during a
 * production run halts that run.
 */
import { ingestMlbOutcomes } from "../../mlbOutcomeIngestor";
import {
  buildRepairManifest,
  type DefectWindow,
  type DryRunRow,
} from "./buildManifest";
import {
  buildRollbackManifest,
  verifyManifestSeal,
  type RollbackManifest,
  type SealedManifest,
} from "./repairManifest";
import { applyRepairManifest, type ApplyResult } from "./applyManifest";
import { makeTransactionRunner } from "./drizzleGateway";

export interface ApplyApprovedInput {
  /** The exact sealed manifest a human approved. */
  sealed: SealedManifest;
  /** The rollback artifact generated alongside it. */
  rollback: RollbackManifest;
  /** The production defect interval, in real deployment timestamps. */
  window: DefectWindow;
  /** Deployed commit SHA and live migration head, asserted against the manifest. */
  actualCodeSha: string;
  actualSchemaVersion: string;
}

export type ApplyApprovedRejection =
  "SEAL_INVALID" | "NOT_SINGLE_DATE" | "NOT_REPRODUCIBLE";

export interface ApplyApprovedResult {
  rejected: ApplyApprovedRejection | null;
  rejectionDetail: string | null;
  regeneratedSha256: string | null;
  apply: ApplyResult | null;
}

const TAG = "[M203:applyApproved]";

/**
 * Applies one approved single-date manifest.
 *
 * Scope is deliberately one date: the season runner is not built, and a
 * multi-date artifact would let a single approval authorize far more mutation
 * than a reviewer actually inspected.
 */
export async function applyApprovedManifest(
  input: ApplyApprovedInput,
  log: (msg: string) => void = console.log
): Promise<ApplyApprovedResult> {
  const { sealed, rollback, window } = input;

  if (!verifyManifestSeal(sealed)) {
    return {
      rejected: "SEAL_INVALID",
      rejectionDetail: "submitted manifest does not re-derive its own checksum",
      regeneratedSha256: null,
      apply: null,
    };
  }

  const dates = Array.from(new Set(sealed.manifest.rows.map(r => r.gameDate)));
  if (dates.length !== 1) {
    return {
      rejected: "NOT_SINGLE_DATE",
      rejectionDetail: `manifest spans ${dates.length} dates; this surface applies exactly one`,
      regeneratedSha256: null,
      apply: null,
    };
  }
  const dateStr = dates[0];

  // ── Control 1: the server must be able to reproduce this manifest ────────
  // Non-authoritative: nothing from this run is written. It exists solely to
  // prove the submitted artifact is the one this system would have produced.
  const dryRun = await ingestMlbOutcomes(dateStr, true, {
    dryRun: true,
    historical: true,
  });

  const regenerated = buildRepairManifest({
    repairRunId: sealed.manifest.repairRunId,
    generatedAt: sealed.manifest.generatedAt,
    codeSha: sealed.manifest.codeSha,
    schemaVersion: sealed.manifest.schemaVersion,
    window,
    rows: dryRun.results as unknown as DryRunRow[],
  });

  if (regenerated.sealed.manifestSha256 !== sealed.manifestSha256) {
    log(
      `${TAG} [REJECT] regenerated=${regenerated.sealed.manifestSha256.slice(0, 12)} submitted=${sealed.manifestSha256.slice(0, 12)}`
    );
    return {
      rejected: "NOT_REPRODUCIBLE",
      rejectionDetail:
        "the server could not reproduce the submitted manifest from a fresh dry run; " +
        "production state or upstream evidence has changed since review",
      regeneratedSha256: regenerated.sealed.manifestSha256,
      apply: null,
    };
  }

  log(`${TAG} manifest reproduced exactly — proceeding to apply ${dateStr}`);

  const runInTransaction = await makeTransactionRunner();
  const apply = await applyRepairManifest({
    sealed,
    rollback,
    actualCodeSha: input.actualCodeSha,
    actualSchemaVersion: input.actualSchemaVersion,
    runInTransaction,
    // Not configurable. A stop condition halts the run that finds it.
    failFast: true,
    log,
  });

  return {
    rejected: null,
    rejectionDetail: null,
    regeneratedSha256: regenerated.sealed.manifestSha256,
    apply,
  };
}

/**
 * Generates a sealed manifest + rollback for one date from a historical dry
 * run. Performs no mutation — this is what produces the artifact a human
 * reviews before authorizing an apply.
 */
export async function generateApprovalPacket(
  dateStr: string,
  opts: {
    repairRunId: string;
    generatedAt: number;
    codeSha: string;
    schemaVersion: string;
    window: DefectWindow;
  }
): Promise<{
  sealed: SealedManifest;
  rollback: RollbackManifest;
  accounting: ReturnType<typeof buildRepairManifest>["accounting"];
}> {
  const dryRun = await ingestMlbOutcomes(dateStr, true, {
    dryRun: true,
    historical: true,
  });
  const { sealed, accounting } = buildRepairManifest({
    ...opts,
    rows: dryRun.results as unknown as DryRunRow[],
  });
  const rollback = buildRollbackManifest(sealed, opts.generatedAt);
  return { sealed, rollback, accounting };
}
