/** One owner direction correction. Never replay the original 68-game Book snapshot. */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import mysql, { type RowDataPacket } from "mysql2/promise";
import {
  DATE,
  SOURCES,
  ncaafSeptember5Record,
} from "../shared/ncaafSeptember5";

export const EVENT = "288841";
// Owner explicitly approved the +110/-110 estimates after correcting the favorite.
// Method and approval are retained in the September 5 source-provenance audit.
export const REPLACEMENT_PRICES_APPROVED = true;
const game = SOURCES.find(game => game.event === EVENT)!;
const prior = {
  awayModelSpread: "12.6",
  homeModelSpread: "-12.6",
  modelAwaySpreadOdds: "+1928",
  modelHomeSpreadOdds: "-1928",
};
const record = ncaafSeptember5Record(game);
export const correction = {
  awayModelSpread: record.awayModelSpread,
  homeModelSpread: record.homeModelSpread,
  modelAwaySpreadOdds: record.modelAwaySpreadOdds,
  modelHomeSpreadOdds: record.modelHomeSpreadOdds,
  spreadEdge: null,
  spreadDiff: null,
};
type Row = Record<string, unknown>;
type SqlValue = string | number | null;
const entries = Object.entries(correction);
const unchangedModel = Object.fromEntries(
  Object.entries(record).filter(
    ([key]) => /model/i.test(key) && !(key in correction)
  )
);
const matches = (row: Row, expected: Row) =>
  Object.entries(expected).every(([key, value]) =>
    value === null ? row[key] === null : String(row[key]) === String(value)
  );

export function checkCorrection() {
  assert.equal(game.away, "OKST");
  assert.equal(game.home, "TLSA");
  assert.equal(DATE, "2026-09-05");
  assert.equal(correction.awayModelSpread, "-12.6");
  assert.equal(correction.homeModelSpread, "12.6");
  assert.deepEqual(game.model.basis, {
    awaySpread: -13.5,
    homeSpread: 13.5,
    total: 59,
  });
  const prices = [
    correction.modelAwaySpreadOdds,
    correction.modelHomeSpreadOdds,
  ];
  assert.deepEqual(
    prices,
    ["+110", "-110"],
    "Approved replacement prices changed"
  );
}

export function planCorrection(rows: Row[]) {
  assert.equal(rows.length, 1, "Missing or duplicate correction target");
  const row = rows[0];
  assert(
    row.sport === "NCAAF" &&
      row.gameDate === DATE &&
      row.awayTeam === "OKST" &&
      row.homeTeam === "TLSA" &&
      row.ncaaContestId === EVENT &&
      Number.isInteger(row.id),
    "Correction identity mismatch"
  );
  assert(
    matches(row, unchangedModel),
    "Model import changed; refusing stale correction"
  );
  if (matches(row, correction)) return { row, changed: false };
  assert(
    matches(row, prior),
    "Expected original model direction/prices changed"
  );
  return { row, changed: true };
}

export function correctionStatement(row: Row) {
  // Null-safe comparison includes each original changed field and the import marker.
  const guards = [
    "id",
    "gameDate",
    "sport",
    "awayTeam",
    "homeTeam",
    "ncaaContestId",
    "modelRunAt",
    ...Object.keys(correction),
  ];
  return {
    sql: `UPDATE games SET ${entries.map(([key]) => `\`${key}\` = ?`).join(", ")} WHERE ${guards.map(key => `\`${key}\` <=> ?`).join(" AND ")}`,
    values: [
      ...entries.map(([, value]) => value),
      ...guards.map(key => row[key]),
    ].map((value): SqlValue => {
      assert(
        value === null ||
          typeof value === "string" ||
          typeof value === "number",
        "Invalid correction parameter"
      );
      return value;
    }),
  };
}

export function verifyPreserved(before: Row, after: Row) {
  assert(matches(after, correction), "Corrected model readback mismatch");
  const preserved = (row: Row) =>
    Object.fromEntries(
      Object.entries(row).filter(
        ([key]) => !(key in correction) && key !== "updatedAt"
      )
    );
  assert.deepEqual(
    preserved(after),
    preserved(before),
    "Unrelated game fields changed"
  );
}

export type CorrectionStore = {
  beginTransaction(): Promise<unknown>;
  read(): Promise<Row[]>;
  execute(sql: string, values: SqlValue[]): Promise<number>;
  commit(): Promise<unknown>;
  rollback(): Promise<unknown>;
};

/** No source/history/other-game UPDATE exists on this path. A failed guard rolls back. */
export async function runCorrection(
  store: CorrectionStore,
  mode: "--dry-run" | "--apply" | "--verify"
) {
  checkCorrection();
  if (mode === "--apply")
    assert(
      REPLACEMENT_PRICES_APPROVED,
      "Replacement spread prices await owner authorization"
    );
  await store.beginTransaction();
  try {
    const { row, changed } = planCorrection(await store.read());
    if (mode === "--verify")
      assert(!changed, "Correction has not been applied");
    if (mode === "--apply" && changed) {
      const statement = correctionStatement(row);
      assert.equal(
        await store.execute(statement.sql, statement.values),
        1,
        "Correction compare-and-set failed"
      );
      const after = planCorrection(await store.read());
      assert(!after.changed, "Corrected model readback mismatch");
      verifyPreserved(row, after.row);
    }
    if (mode === "--apply") await store.commit();
    else await store.rollback();
    return {
      event: EVENT,
      rowId: row.id,
      changed: mode === "--apply" && changed,
      pending: mode === "--dry-run" && changed,
    };
  } catch (error) {
    await store.rollback();
    throw error;
  }
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  assert(
    !rest.length &&
      ["--check", "--dry-run", "--apply", "--verify"].includes(mode),
    "Choose exactly one correction mode"
  );
  checkCorrection();
  if (mode === "--check") {
    console.log(
      `NCAAF_OKST_CORRECTION_CHECK_PASS event=${EVENT} pricesApproved=${REPLACEMENT_PRICES_APPROVED}`
    );
    return;
  }
  assert(process.env.DATABASE_URL, "DATABASE_URL unavailable");
  const db = await mysql.createConnection({
    uri: process.env.DATABASE_URL,
    timezone: "Z",
    ssl: { rejectUnauthorized: true },
  });
  try {
    const result = await runCorrection(
      {
        beginTransaction: () => db.beginTransaction(),
        read: async () =>
          (
            await db.query<RowDataPacket[]>(
              "SELECT * FROM games WHERE ncaaContestId = ? OR (gameDate = ? AND sport = ? AND awayTeam = ? AND homeTeam = ?) ORDER BY id FOR UPDATE",
              [EVENT, DATE, "NCAAF", "OKST", "TLSA"]
            )
          )[0],
        execute: async (sql, values) =>
          (await db.execute<mysql.ResultSetHeader>(sql, values))[0]
            .affectedRows,
        commit: () => db.commit(),
        rollback: () => db.rollback(),
      },
      mode as "--dry-run" | "--apply" | "--verify"
    );
    console.log(
      `NCAAF_OKST_CORRECTION_${mode.slice(2).toUpperCase().replaceAll("-", "_")}_PASS ${JSON.stringify(result)}`
    );
  } finally {
    await db.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(error => {
    console.error(
      "NCAAF_OKST_CORRECTION_FAILED",
      error instanceof assert.AssertionError
        ? error.message
        : "Database operation failed; no credentials logged"
    );
    process.exitCode = 1;
  });
}
