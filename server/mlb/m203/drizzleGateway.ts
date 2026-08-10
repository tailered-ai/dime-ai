/**
 * drizzleGateway.ts — the production database adapter for the M-203 applier.
 *
 * The narrowest surface that can execute a sealed manifest against the real
 * games table. Deliberately not a general repair platform:
 *
 *   • writeBrier writes ONLY the five Brier columns. It never touches actual*,
 *     outcomeIngestedAt, model probabilities, or calibration state. The manifest
 *     applier exists to repair Brier history, not to replay ingestion side
 *     effects, and a wider write surface here would silently re-open the very
 *     bypass the architecture removes.
 *   • Nulls are written as explicit SQL NULL, because a corrective repair must
 *     be able to CLEAR a stale value, not only overwrite one.
 *   • readForUpdate takes a row lock, so the compare-and-swap in the applier is
 *     a real check-then-act under isolation rather than an advisory read.
 *   • No external I/O of any kind happens here; the MLB Stats API was consulted
 *     during manifest GENERATION, never inside a transaction.
 */
import { eq } from "drizzle-orm";
import { games } from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { BrierMap } from "./repairManifest";
import type { RepairRowGateway, TransactionRunner } from "./applyManifest";

/** The five Brier columns, read back as numbers or null. */
function toBrierMap(row: {
  brierFgTotal: string | null;
  brierF5Total: string | null;
  brierNrfi: string | null;
  brierFgMl: string | null;
  brierF5Ml: string | null;
}): BrierMap {
  const n = (v: string | null): number | null => {
    if (v === null || v === undefined) return null;
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    brierFgTotal: n(row.brierFgTotal),
    brierF5Total: n(row.brierF5Total),
    brierNrfi: n(row.brierNrfi),
    brierFgMl: n(row.brierFgMl),
    brierF5Ml: n(row.brierF5Ml),
  };
}

const BRIER_SELECT = {
  brierFgTotal: games.brierFgTotal,
  brierF5Total: games.brierF5Total,
  brierNrfi: games.brierNrfi,
  brierFgMl: games.brierFgMl,
  brierF5Ml: games.brierF5Ml,
} as const;

/** Drizzle stores decimals as strings; null must stay null, never "null". */
function toColumn(v: number | null): string | null {
  return v === null ? null : String(v);
}

/**
 * Builds a gateway bound to a transaction handle.
 *
 * `tx` is the Drizzle transaction object, so every read and write in one date
 * shares the transaction's isolation and rolls back together.
 */
export function makeRepairRowGateway(tx: {
  select: (cols: typeof BRIER_SELECT) => {
    from: (t: typeof games) => {
      where: (cond: unknown) => {
        for: (mode: "update") => Promise<Array<Record<string, string | null>>>;
      } & Promise<Array<Record<string, string | null>>>;
    };
  };
  update: (t: typeof games) => {
    set: (values: Record<string, string | null>) => {
      where: (cond: unknown) => Promise<unknown>;
    };
  };
}): RepairRowGateway {
  return {
    async readForUpdate(gameRowId: number): Promise<BrierMap | null> {
      // SELECT ... FOR UPDATE — the lock is what makes the applier's
      // compare-and-swap sound under concurrency.
      const rows = await tx
        .select(BRIER_SELECT)
        .from(games)
        .where(eq(games.id, gameRowId))
        .for("update");
      const row = rows?.[0];
      return row ? toBrierMap(row as never) : null;
    },

    async writeBrier(gameRowId: number, values: BrierMap): Promise<void> {
      await tx
        .update(games)
        .set({
          // EXACTLY the five Brier columns. Explicit null, never undefined:
          // Drizzle omits undefined from the SET clause, which would leave a
          // stale value in place on a correction run.
          brierFgTotal: toColumn(values.brierFgTotal),
          brierF5Total: toColumn(values.brierF5Total),
          brierNrfi: toColumn(values.brierNrfi),
          brierFgMl: toColumn(values.brierFgMl),
          brierF5Ml: toColumn(values.brierF5Ml),
        })
        .where(eq(games.id, gameRowId));
    },

    async readBack(gameRowId: number): Promise<BrierMap | null> {
      const rows = await tx
        .select(BRIER_SELECT)
        .from(games)
        .where(eq(games.id, gameRowId));
      const row = rows?.[0];
      return row ? toBrierMap(row as never) : null;
    },
  };
}

/**
 * A TransactionRunner backed by the real database.
 *
 * One call per date. Throwing inside the callback rolls the transaction back,
 * which is how the applier guarantees a failed date leaves nothing partially
 * repaired.
 */
export async function makeTransactionRunner(): Promise<TransactionRunner> {
  const db = await getDb();
  return async <T>(work: (gw: RepairRowGateway) => Promise<T>): Promise<T> => {
    return (await (
      db as unknown as {
        transaction: (fn: (tx: unknown) => Promise<T>) => Promise<T>;
      }
    ).transaction(async tx => work(makeRepairRowGateway(tx as never)))) as T;
  };
}
