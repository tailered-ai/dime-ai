/**
 * applyRollback.ts — executable recovery for an applied M-203 repair.
 *
 * A rollback artifact that cannot actually be executed is not a recovery path,
 * it is a document. The production canary must never exist without a tested,
 * runnable way back to the exact prior database state.
 *
 * This restores the RECORDED pre-image. It never recomputes historical values —
 * reproducing them would mean re-running the defective scorer, which is both
 * absurd and impossible to validate. It performs no external I/O, touches no
 * drift or calibration state, and sends no notification.
 *
 * Guard order mirrors the applier, in reverse intent:
 *   1. rollback content validates against its source manifest
 *   2. code SHA        — the deployed code matches what generated the repair
 *   3. schema version  — the migration head matches
 *   4. per-row CAS on expectedCurrent (what the repair wrote)
 *   5. restore restoreTo
 *   6. read back and verify every restored field
 * One transaction per date; any failure reverts that whole date.
 */
import {
  validateRollback,
  verifyManifestSeal,
  type BrierMap,
  type RollbackManifest,
  type RollbackRow,
  type SealedManifest,
} from "./repairManifest";
import { BRIER_MARKETS, brierEquals, type BrierField } from "./brierOracle";
import type { RepairRowGateway, TransactionRunner } from "./applyManifest";

export type RollbackRowOutcome =
  | "RESTORED"
  | "REVERTED"
  | "NOT_ATTEMPTED_DATE_ABORTED"
  | "CURRENT_STATE_MISMATCH"
  | "ROW_MISSING"
  | "VERIFY_FAILED"
  | "WRITE_ERROR";

export interface RollbackRowResult {
  gameRowId: number;
  outcome: RollbackRowOutcome;
  detail: string | null;
}

export type RollbackAbortReason =
  | "MANIFEST_SEAL_MISMATCH"
  | "ROLLBACK_INVALID"
  | "CODE_SHA_MISMATCH"
  | "SCHEMA_VERSION_MISMATCH";

export interface RollbackResult {
  repairRunId: string;
  aborted: RollbackAbortReason | null;
  abortDetail: string | null;
  restored: number;
  failed: number;
  rows: RollbackRowResult[];
  datesCompleted: string[];
}

export interface RollbackOptions {
  sealed: SealedManifest;
  rollback: RollbackManifest;
  actualCodeSha: string;
  actualSchemaVersion: string;
  runInTransaction: TransactionRunner;
  log?: (msg: string) => void;
}

const TAG = "[M203:rollback]";

function changedBetween(a: BrierMap, b: BrierMap): BrierField[] {
  return BRIER_MARKETS.map(m => m.field).filter(f => !brierEquals(a[f], b[f]));
}

class RollbackFailure extends Error {
  constructor(
    readonly gameRowId: number,
    readonly outcome: RollbackRowOutcome,
    readonly partial: RollbackRowResult[]
  ) {
    super(`row ${gameRowId}: ${outcome}`);
    this.name = "RollbackFailure";
  }
}

function abort(
  rollback: RollbackManifest,
  reason: RollbackAbortReason,
  detail: string
): RollbackResult {
  return {
    repairRunId: rollback.repairRunId,
    aborted: reason,
    abortDetail: detail,
    restored: 0,
    failed: 0,
    rows: [],
    datesCompleted: [],
  };
}

/**
 * Executes a rollback. Fails closed: if the current row state is not exactly
 * what the repair wrote, the row is NOT restored — something else changed it,
 * and blindly overwriting would destroy that change.
 */
export async function applyRollbackManifest(
  opts: RollbackOptions
): Promise<RollbackResult> {
  const { sealed, rollback, runInTransaction } = opts;
  const log = opts.log ?? console.log;

  if (!verifyManifestSeal(sealed)) {
    return abort(
      rollback,
      "MANIFEST_SEAL_MISMATCH",
      "source manifest does not re-derive its recorded sha256"
    );
  }
  const problems = validateRollback(sealed, rollback);
  if (problems.length > 0) {
    return abort(
      rollback,
      "ROLLBACK_INVALID",
      `${problems.length} problem(s); first: ${problems[0]}`
    );
  }
  if (sealed.manifest.codeSha !== opts.actualCodeSha) {
    return abort(
      rollback,
      "CODE_SHA_MISMATCH",
      `manifest=${sealed.manifest.codeSha} deployed=${opts.actualCodeSha}`
    );
  }
  if (sealed.manifest.schemaVersion !== opts.actualSchemaVersion) {
    return abort(
      rollback,
      "SCHEMA_VERSION_MISMATCH",
      `manifest=${sealed.manifest.schemaVersion} live=${opts.actualSchemaVersion}`
    );
  }

  // Group by the date recorded in the source manifest, so a rollback reverts
  // in the same units the repair applied.
  const dateOf = new Map<number, string>();
  for (const r of sealed.manifest.rows) dateOf.set(r.gameRowId, r.gameDate);
  const byDate = new Map<string, RollbackRow[]>();
  for (const rb of rollback.rows) {
    const d = dateOf.get(rb.gameRowId) ?? "unknown";
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(rb);
  }

  const rows: RollbackRowResult[] = [];
  const datesCompleted: string[] = [];
  let restored = 0;
  let failed = 0;

  for (const date of Array.from(byDate.keys()).sort()) {
    const dateRows = byDate.get(date)!;
    let dateResults: RollbackRowResult[] = [];
    let reverted = false;

    try {
      dateResults = await runInTransaction(async (gw: RepairRowGateway) => {
        const out: RollbackRowResult[] = [];
        for (const rb of dateRows) {
          const current = await gw.readForUpdate(rb.gameRowId);
          if (current === null) {
            out.push({
              gameRowId: rb.gameRowId,
              outcome: "ROW_MISSING",
              detail: "row absent at rollback time",
            });
            throw new RollbackFailure(rb.gameRowId, "ROW_MISSING", out);
          }

          // CAS: the row must still hold exactly what the repair wrote.
          const drift = changedBetween(current, rb.expectedCurrent);
          if (drift.length > 0) {
            out.push({
              gameRowId: rb.gameRowId,
              outcome: "CURRENT_STATE_MISMATCH",
              detail: `row no longer holds the repaired state: ${drift.join(",")}`,
            });
            throw new RollbackFailure(
              rb.gameRowId,
              "CURRENT_STATE_MISMATCH",
              out
            );
          }

          await gw.writeBrier(rb.gameRowId, rb.restoreTo);

          const after = await gw.readBack(rb.gameRowId);
          if (after === null) {
            out.push({
              gameRowId: rb.gameRowId,
              outcome: "VERIFY_FAILED",
              detail: "row unreadable after restore",
            });
            throw new RollbackFailure(rb.gameRowId, "VERIFY_FAILED", out);
          }
          const bad = changedBetween(after, rb.restoreTo);
          if (bad.length > 0) {
            out.push({
              gameRowId: rb.gameRowId,
              outcome: "VERIFY_FAILED",
              detail: `did not restore: ${bad.join(",")}`,
            });
            throw new RollbackFailure(rb.gameRowId, "VERIFY_FAILED", out);
          }

          out.push({
            gameRowId: rb.gameRowId,
            outcome: "RESTORED",
            detail: null,
          });
        }
        return out;
      });
    } catch (err) {
      if (err instanceof RollbackFailure) {
        dateResults = err.partial.map(r =>
          r.outcome === "RESTORED"
            ? {
                ...r,
                outcome: "REVERTED" as RollbackRowOutcome,
                detail: "restore reverted with the date transaction",
              }
            : r
        );
        const touched = new Set(dateResults.map(r => r.gameRowId));
        for (const missed of dateRows) {
          if (!touched.has(missed.gameRowId)) {
            dateResults.push({
              gameRowId: missed.gameRowId,
              outcome: "NOT_ATTEMPTED_DATE_ABORTED",
              detail: "date aborted before this row was reached",
            });
          }
        }
        reverted = true;
        log(
          `${TAG} [ABORT] date=${date} — ${err.outcome} on row ${err.gameRowId}; entire date reverted`
        );
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        dateResults = dateRows.map(r => ({
          gameRowId: r.gameRowId,
          outcome: "WRITE_ERROR" as RollbackRowOutcome,
          detail: msg,
        }));
        reverted = true;
        log(`${TAG} [ERROR] date=${date}: ${msg}`);
      }
    }

    for (const r of dateResults) {
      rows.push(r);
      if (r.outcome === "RESTORED") restored++;
      else failed++;
    }
    if (!reverted) datesCompleted.push(date);
    // Any failure halts the rollback — a partially recovered dataset must not
    // be extended by continuing into the next date.
    if (reverted) break;
  }

  return {
    repairRunId: rollback.repairRunId,
    aborted: null,
    abortDetail: null,
    restored,
    failed,
    rows,
    datesCompleted,
  };
}

export { RollbackFailure };
