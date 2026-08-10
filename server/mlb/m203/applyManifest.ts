/**
 * applyManifest.ts — executes a frozen M-203 repair manifest.
 *
 * ── What this does NOT do ───────────────────────────────────────────────────
 * It does not fetch. It does not compute a Brier score. It does not consult the
 * MLB Stats API. Every value it writes was recorded in the manifest that a human
 * reviewed. That is the entire point: what was approved is provably what runs.
 *
 * ── Guards, in the order they fire ──────────────────────────────────────────
 *   1. Manifest seal        — checksum must re-derive, or the artifact is not
 *                             the one that was reviewed.
 *   2. Code SHA             — the deployed code must match what generated it.
 *   3. Schema version       — the migration head must match.
 *   4. Rollback present     — mutation never begins without a restore path.
 *   5. Invariant scan       — no percent-scaled market may move.
 *   6. Oracle cross-check   — independent recomputation must agree.
 *   7. Per-row compare-and-swap — the row must still hold its recorded
 *                             pre-image, or it changed since review.
 *   8. Read-back verification — every written field is re-read and compared.
 *
 * ── Transaction boundary ────────────────────────────────────────────────────
 * External I/O happens during manifest GENERATION, never here. The apply stage
 * opens a transaction per date, so a network call can never be held open inside
 * a database transaction. A row that fails any guard rolls back its whole date
 * rather than leaving that date half-applied.
 */
import {
  WRITABLE_CLASSIFICATIONS,
  crossCheckWithOracle,
  findInvariantViolations,
  rollbackIsComplete,
  verifyManifestSeal,
  type BrierMap,
  type ManifestRow,
  type RollbackManifest,
  type SealedManifest,
} from "./repairManifest";
import { BRIER_MARKETS, brierEquals, type BrierField } from "./brierOracle";

// ─── Gateway ──────────────────────────────────────────────────────────────────

/**
 * The narrow database surface the applier needs. Injected so the guard logic is
 * executable in tests without a live database — the production implementation
 * is the only part that touches Drizzle.
 */
export interface RepairRowGateway {
  /** Reads the repair-relevant fields, locking the row for update. */
  readForUpdate(gameRowId: number): Promise<BrierMap | null>;
  /** Writes the five Brier fields. Null MUST be written as SQL NULL. */
  writeBrier(gameRowId: number, values: BrierMap): Promise<void>;
  /** Re-reads after the write for verification. */
  readBack(gameRowId: number): Promise<BrierMap | null>;
}

/** Runs a unit of work inside a database transaction. */
export type TransactionRunner = <T>(
  work: (gw: RepairRowGateway) => Promise<T>
) => Promise<T>;

// ─── Results ──────────────────────────────────────────────────────────────────

export type RowOutcome =
  | "APPLIED"
  | "REVERTED"
  | "SKIPPED_NOT_WRITABLE"
  | "PREIMAGE_MISMATCH"
  | "ROW_MISSING"
  | "VERIFY_FAILED"
  | "WRITE_ERROR";

export interface RowResult {
  gameRowId: number;
  outcome: RowOutcome;
  changedFields: BrierField[];
  detail: string | null;
}

export type AbortReason =
  | "MANIFEST_SEAL_MISMATCH"
  | "CODE_SHA_MISMATCH"
  | "SCHEMA_VERSION_MISMATCH"
  | "ROLLBACK_INCOMPLETE"
  | "INVARIANT_VIOLATION"
  | "ORACLE_DISAGREEMENT"
  | "ACCOUNTING_UNBALANCED";

export interface ApplyResult {
  repairRunId: string;
  aborted: AbortReason | null;
  abortDetail: string | null;
  applied: number;
  skipped: number;
  failed: number;
  rows: RowResult[];
  datesCompleted: string[];
}

export interface ApplyOptions {
  sealed: SealedManifest;
  rollback: RollbackManifest;
  /** Deployed commit SHA, asserted against the manifest. */
  actualCodeSha: string;
  /** Live migration head, asserted against the manifest. */
  actualSchemaVersion: string;
  /** Opens a transaction for one date's worth of rows. */
  runInTransaction: TransactionRunner;
  /** Stop the entire run on the first row failure. Default true. */
  failFast?: boolean;
  log?: (msg: string) => void;
}

const TAG = "[M203:apply]";

function abort(
  sealed: SealedManifest,
  reason: AbortReason,
  detail: string
): ApplyResult {
  return {
    repairRunId: sealed.manifest.repairRunId,
    aborted: reason,
    abortDetail: detail,
    applied: 0,
    skipped: 0,
    failed: 0,
    rows: [],
    datesCompleted: [],
  };
}

/** Fields that differ between two Brier maps, at storage resolution. */
function changedBetween(a: BrierMap, b: BrierMap): BrierField[] {
  return BRIER_MARKETS.map(m => m.field).filter(f => !brierEquals(a[f], b[f]));
}

/**
 * Applies a sealed manifest.
 *
 * Every pre-mutation guard runs to completion BEFORE the first write, so a
 * manifest that would violate an invariant never partially applies.
 */
export async function applyRepairManifest(
  opts: ApplyOptions
): Promise<ApplyResult> {
  const { sealed, rollback, runInTransaction } = opts;
  const log = opts.log ?? console.log;
  const failFast = opts.failFast !== false;

  // ── Guard 1: the artifact is the one that was reviewed ──────────────────
  if (!verifyManifestSeal(sealed)) {
    return abort(
      sealed,
      "MANIFEST_SEAL_MISMATCH",
      "manifest content does not re-derive its recorded sha256"
    );
  }

  // ── Guard 2 + 3: environment identity ───────────────────────────────────
  if (sealed.manifest.codeSha !== opts.actualCodeSha) {
    return abort(
      sealed,
      "CODE_SHA_MISMATCH",
      `manifest=${sealed.manifest.codeSha} deployed=${opts.actualCodeSha}`
    );
  }
  if (sealed.manifest.schemaVersion !== opts.actualSchemaVersion) {
    return abort(
      sealed,
      "SCHEMA_VERSION_MISMATCH",
      `manifest=${sealed.manifest.schemaVersion} live=${opts.actualSchemaVersion}`
    );
  }

  // ── Guard 4: never mutate without a restore path ────────────────────────
  if (!rollbackIsComplete(sealed, rollback)) {
    return abort(
      sealed,
      "ROLLBACK_INCOMPLETE",
      "rollback manifest does not cover every writable row of this manifest"
    );
  }

  // ── Guard 5: M-203 must not move a percent-scaled market ────────────────
  const violations = findInvariantViolations(sealed.manifest.rows);
  if (violations.length > 0) {
    const v = violations[0];
    return abort(
      sealed,
      "INVARIANT_VIOLATION",
      `${violations.length} invariant change(s); first: row ${v.gameRowId} ${v.field} ${v.previous} → ${v.proposed}`
    );
  }

  // ── Guard 6: independent recomputation must agree ───────────────────────
  const disagreements = crossCheckWithOracle(sealed.manifest.rows);
  if (disagreements.length > 0) {
    const d = disagreements[0];
    return abort(
      sealed,
      "ORACLE_DISAGREEMENT",
      `${disagreements.length} disagreement(s); first: row ${d.gameRowId} ${d.field} manifest=${d.manifestValue} oracle=${d.oracleValue}`
    );
  }

  log(
    `${TAG} guards passed — runId=${sealed.manifest.repairRunId} sha=${sealed.manifestSha256.slice(0, 12)} rows=${sealed.rowCount}`
  );

  // ── Execution, one transaction per date ─────────────────────────────────
  const byDate = new Map<string, ManifestRow[]>();
  for (const r of sealed.manifest.rows) {
    if (!byDate.has(r.gameDate)) byDate.set(r.gameDate, []);
    byDate.get(r.gameDate)!.push(r);
  }

  const rows: RowResult[] = [];
  const datesCompleted: string[] = [];
  let applied = 0;
  let skipped = 0;
  let failed = 0;
  let halt = false;

  for (const date of Array.from(byDate.keys()).sort()) {
    if (halt) break;
    const dateRows = byDate.get(date)!;

    let dateResults: RowResult[] = [];
    let reverted = false;
    try {
      dateResults = await runInTransaction(async gw => {
        const out: RowResult[] = [];
        for (const row of dateRows) {
          if (!WRITABLE_CLASSIFICATIONS.includes(row.classification)) {
            out.push({
              gameRowId: row.gameRowId,
              outcome: "SKIPPED_NOT_WRITABLE",
              changedFields: [],
              detail: row.classification,
            });
            continue;
          }

          // ── Guard 7: compare-and-swap on the recorded pre-image ────────
          const current = await gw.readForUpdate(row.gameRowId);
          if (current === null) {
            out.push({
              gameRowId: row.gameRowId,
              outcome: "ROW_MISSING",
              changedFields: [],
              detail: "row absent at apply time",
            });
            throw new RowFailure(row.gameRowId, "ROW_MISSING", out);
          }
          const drift = changedBetween(current, row.previousBrier);
          if (drift.length > 0) {
            out.push({
              gameRowId: row.gameRowId,
              outcome: "PREIMAGE_MISMATCH",
              changedFields: drift,
              detail: `row changed since review: ${drift.join(",")}`,
            });
            throw new RowFailure(row.gameRowId, "PREIMAGE_MISMATCH", out);
          }

          await gw.writeBrier(row.gameRowId, row.proposedBrier);

          // ── Guard 8: read back and verify every field ──────────────────
          const after = await gw.readBack(row.gameRowId);
          if (after === null) {
            out.push({
              gameRowId: row.gameRowId,
              outcome: "VERIFY_FAILED",
              changedFields: [],
              detail: "row unreadable after write",
            });
            throw new RowFailure(row.gameRowId, "VERIFY_FAILED", out);
          }
          const mismatched = changedBetween(after, row.proposedBrier);
          if (mismatched.length > 0) {
            out.push({
              gameRowId: row.gameRowId,
              outcome: "VERIFY_FAILED",
              changedFields: mismatched,
              detail: `did not persist: ${mismatched.join(",")}`,
            });
            throw new RowFailure(row.gameRowId, "VERIFY_FAILED", out);
          }

          out.push({
            gameRowId: row.gameRowId,
            outcome: "APPLIED",
            changedFields: row.changeFields,
            detail: null,
          });
        }
        return out;
      });
    } catch (err) {
      if (err instanceof RowFailure) {
        // The transaction rolled back; the whole date is unapplied.
        // A row that had been written is NOT "skipped" — its write was
        // reverted with the transaction. Marking it REVERTED (counted as
        // failed) keeps the totals honest and, critically, keeps the date out
        // of datesCompleted so a resume cannot skip work that never landed.
        dateResults = err.partial.map(r =>
          r.outcome === "APPLIED"
            ? {
                ...r,
                outcome: "REVERTED" as RowOutcome,
                detail: "write reverted with the date transaction",
              }
            : r
        );
        reverted = true;
        log(
          `${TAG} [ROLLBACK] date=${date} — ${err.outcome} on row ${err.gameRowId}; entire date reverted`
        );
        halt = failFast;
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        dateResults = dateRows.map(r => ({
          gameRowId: r.gameRowId,
          outcome: "WRITE_ERROR" as RowOutcome,
          changedFields: [],
          detail: msg,
        }));
        log(`${TAG} [ERROR] date=${date} transaction failed: ${msg}`);
        halt = failFast;
      }
    }

    for (const r of dateResults) {
      rows.push(r);
      if (r.outcome === "APPLIED") applied++;
      else if (r.outcome === "SKIPPED_NOT_WRITABLE") skipped++;
      else failed++;
    }
    // A date counts as completed ONLY when it neither reverted nor errored.
    // Anything else must remain re-runnable: reporting a rolled-back date as
    // complete would let a resume silently skip work that never landed.
    const dateClean =
      !reverted && dateResults.every(r => r.outcome !== "WRITE_ERROR");
    if (dateClean) {
      datesCompleted.push(date);
    }
    log(
      `${TAG} date=${date} applied=${dateResults.filter(r => r.outcome === "APPLIED").length} of ${dateRows.length}`
    );
  }

  return {
    repairRunId: sealed.manifest.repairRunId,
    aborted: null,
    abortDetail: null,
    applied,
    skipped,
    failed,
    rows,
    datesCompleted,
  };
}

/** Internal signal that forces the enclosing date transaction to roll back. */
class RowFailure extends Error {
  constructor(
    readonly gameRowId: number,
    readonly outcome: RowOutcome,
    readonly partial: RowResult[]
  ) {
    super(`row ${gameRowId}: ${outcome}`);
    this.name = "RowFailure";
  }
}

export { RowFailure };
