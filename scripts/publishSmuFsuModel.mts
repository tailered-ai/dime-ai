/** Existing Production-workflow publisher pattern; one identity-locked model import. */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import mysql, { type RowDataPacket } from "mysql2/promise";
import {
  SMU_FSU_KEY,
  SMU_FSU_MODEL,
  isSmuFsu,
  presentSmuFsuModel,
} from "../server/smuFsuModel";

export function prepareSmuFsuModel(
  rows: Record<string, any>[],
  importedAt: number
) {
  assert.equal(
    rows.length,
    1,
    "Missing or duplicate SMU FSU destination; verify scheduled pilot seeding"
  );
  const row = rows[0];
  assert(isSmuFsu(row), "SMU FSU identity mismatch");
  assert.equal(Number(row.publishedToFeed), 1);
  assert(Number.isSafeInteger(importedAt) && importedAt > 0);
  const replay =
    Number(row.publishedModel) === 1 &&
    Number.isSafeInteger(row.modelRunAt) &&
    row.modelRunAt > 0 &&
    Object.entries(SMU_FSU_MODEL).every(
      ([key, value]) => row[key] != null && Number(row[key]) === Number(value)
    );
  for (const key of ["modelOverOdds", "modelUnderOdds"])
    assert.equal(row[key], null, `Existing ${key} requires review`);
  if (!replay) {
    assert.equal(row.modelRunAt, null, "Existing model requires review");
    assert.equal(Number(row.publishedModel), 0);
    for (const key of Object.keys(SMU_FSU_MODEL))
      assert.equal(row[key], null, `Existing ${key} requires review`);
  }
  return {
    ...SMU_FSU_MODEL,
    publishedModel: 1,
    modelRunAt: replay ? row.modelRunAt : importedAt,
  };
}

async function main() {
  const [mode, ...extra] = process.argv.slice(2);
  assert(
    !extra.length && ["--dry-run", "--publish", "--verify"].includes(mode),
    "Choose --dry-run, --publish or --verify"
  );
  assert(process.env.DATABASE_URL, "DATABASE_URL unavailable");
  const db = await mysql.createConnection({
    uri: process.env.DATABASE_URL,
    timezone: "Z",
    ssl: { rejectUnauthorized: true },
  });
  let committed = false;
  const read = async () =>
    (
      await db.query<RowDataPacket[]>(
        "SELECT * FROM games WHERE football_schedule_id = ? OR (sport = 'NCAAF' AND gameDate = '2026-09-07' AND awayTeam = 'SMU' AND homeTeam = 'FSU') ORDER BY id FOR UPDATE",
        [SMU_FSU_KEY]
      )
    )[0].map(row => ({
      ...row,
      footballScheduleId: row.football_schedule_id,
      footballMarketState:
        typeof row.football_market_state === "string"
          ? JSON.parse(row.football_market_state)
          : row.football_market_state,
    }));
  try {
    await db.beginTransaction();
    const before = await read();
    const fields = prepareSmuFsuModel(before, Date.now());
    const changed = Object.entries(fields).some(
      ([key, value]) =>
        before[0][key] == null || Number(before[0][key]) !== Number(value)
    );
    if (mode === "--verify") assert(!changed, "Model not published");
    if (mode === "--publish" && changed) {
      const [result] = await db.execute<mysql.ResultSetHeader>(
        `UPDATE games SET ${Object.keys(fields)
          .map(key => `\`${key}\` = ?`)
          .join(
            ","
          )} WHERE id = ? AND football_schedule_id = ? AND modelRunAt IS NULL AND publishedModel = 0`,
        [...Object.values(fields), before[0].id, SMU_FSU_KEY]
      );
      assert.equal(result.affectedRows, 1, "Model update guard failed");
      const after = await read();
      assert.equal(after.length, 1);
      for (const [key, value] of Object.entries(fields))
        assert.equal(Number(after[0][key]), Number(value), key);
      const preserved = (row: Record<string, any>) =>
        Object.fromEntries(
          Object.entries(row).filter(
            ([key]) => !(key in fields) && key !== "updatedAt"
          )
        );
      assert.deepEqual(
        preserved(after[0]),
        preserved(before[0]),
        "Unrequested fields changed"
      );
    }
    if (mode === "--publish") {
      await db.commit();
      committed = true;
    } else await db.rollback();
    const result =
      mode === "--publish" ? (await read())[0] : { ...before[0], ...fields };
    assert.deepEqual(prepareSmuFsuModel([result], fields.modelRunAt), fields);
    const displayed = presentSmuFsuModel(result) as Record<string, any>;
    console.log(
      JSON.stringify({
        operation: mode,
        rowId: result.id,
        scheduleKey: SMU_FSU_KEY,
        source: "PREZ supplied values",
        publicationMarker: fields.modelRunAt,
        changed: mode === "--publish" && changed,
        committed,
        model: fields,
        selected: {
          modelOverOdds: displayed.modelOverOdds,
          modelUnderOdds: displayed.modelUnderOdds,
          modelPriceBasis: displayed.modelPriceBasis,
        },
        bookAndSplitsPreserved: true,
      })
    );
  } catch (error) {
    if (!committed) await db.rollback();
    throw error;
  } finally {
    await db.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => {
    console.error(
      error instanceof Error ? error.message : "Publication failed"
    );
    process.exitCode = 1;
  });
