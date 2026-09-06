#!/usr/bin/env tsx
/**
 * m203-dry-run.mts — read-only production candidate ledger for ONE historical date.
 *
 * This is the G3/G4/G5 evidence mechanism for the M-203 historical Brier repair.
 * It runs the reviewed `ingestMlbOutcomes` path with `dryRun` and `historical`
 * BOTH hard-coded true, and it is the only thing this script can do.
 *
 * Why this cannot write:
 *   1. `dryRun: true` skips the UPDATE entirely — the ingestor computes the
 *      would-be values and returns them instead of persisting.
 *   2. `historical: true` sets `suppressSideEffects`, which withholds the drift
 *      detector (and the recalibration it can trigger) plus the owner
 *      notification, so replaying a past date cannot perturb the live model.
 *   3. The ingestor throws on `historical: true` with `dryRun: false`, so the
 *      dangerous combination is unreachable rather than merely unused.
 *   4. Neither flag is an input here. A caller can choose the date; it cannot
 *      choose the mode.
 *
 * The script additionally fails loud if the returned summary contradicts any of
 * that — a dry run that reports a write is a P0, not a warning.
 *
 * Output: the per-row candidate ledger, which carries model probabilities and
 * Brier values. Keep this repository private; these are the same fields
 * `server/feedGating.ts` withholds from anonymous API callers.
 */
import { ingestMlbOutcomes } from "../server/mlbOutcomeIngestor";

const TAG = "[m203-dry-run]";

/** The date arrives via env, never interpolated into a shell command. */
function requireDate(): string {
  const raw = process.env.M203_DATE?.trim() ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(
      `${TAG} M203_DATE must be YYYY-MM-DD; received ${JSON.stringify(raw)}`
    );
  }
  return raw;
}

async function main(): Promise<void> {
  const dateStr = requireDate();
  if (!process.env.DATABASE_URL) {
    throw new Error(`${TAG} DATABASE_URL is not set — cannot reach production`);
  }

  console.log(
    `${TAG} [INPUT] date=${dateStr} force=true dryRun=true historical=true`
  );

  const summary = await ingestMlbOutcomes(dateStr, true, {
    dryRun: true,
    historical: true,
  });

  // ── Fail-loud assertions ────────────────────────────────────────────────
  // A green run that silently wrote would be worse than a red one.
  if (summary.written !== 0) {
    throw new Error(
      `${TAG} STOP — dry run reported written=${summary.written}, expected 0`
    );
  }
  if (summary.dryRun !== true || summary.historical !== true) {
    throw new Error(
      `${TAG} STOP — mode echo mismatch: dryRun=${summary.dryRun} ` +
        `historical=${summary.historical}`
    );
  }
  if (summary.date !== dateStr) {
    throw new Error(
      `${TAG} STOP — date echo mismatch: requested=${dateStr} ran=${summary.date}`
    );
  }

  const { results, ...counts } = summary;

  console.log(`${TAG} [SUMMARY] ${JSON.stringify(counts)}`);
  console.log(`${TAG} [K] brierChanged=${summary.brierChanged}`);
  console.log(`${TAG} [LEDGER] ${results.length} row(s), one JSON document:`);
  console.log(JSON.stringify(results, null, 2));
  console.log(`${TAG} [OUTPUT] complete — 0 rows written`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(`${TAG} [ERROR]`, err);
    process.exit(1);
  });
