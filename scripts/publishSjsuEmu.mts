/** Owner-selected pregame snapshot; no model fitting or live odds substitution. */
import assert from "node:assert/strict";
import mysql, { type RowDataPacket } from "mysql2/promise";

const DATE = "2026-09-04";
const EVENT = "288794";
// VSiN Circa, 2026-09-04 17:50 ET. Model: approved analyst-paper baseline.
const record = {
  startTimeEst: "18:30",
  ncaaContestId: EVENT,
  awayBookSpread: "1.0",
  homeBookSpread: "-1.0",
  bookTotal: "55.0",
  awayML: "+100",
  homeML: "-120",
  awaySpreadOdds: "-110",
  homeSpreadOdds: "-110",
  overOdds: "-110",
  underOdds: "-110",
  oddsSource: null,
  source_updated_at: new Date("2026-09-04T21:50:00.000Z"),
  provider_observed_at: null,
  ingestion_pipeline_revision: "vsin-circa-selected-sjsu-emu-20260904",
  awayModelSpread: "2.3",
  homeModelSpread: "-2.3",
  modelTotal: "54.7",
  modelAwayScore: "26.20",
  modelHomeScore: "28.50",
  modelAwayML: "+130",
  modelHomeML: "-130",
  modelAwayWinPct: "43.40",
  modelHomeWinPct: "56.60",
  modelAwaySpreadOdds: null,
  modelHomeSpreadOdds: null,
  modelOverOdds: null,
  modelUnderOdds: null,
  modelOverRate: null,
  modelUnderRate: null,
  spreadEdge: null,
  totalEdge: null,
  spreadDiff: "-1.3",
  totalDiff: "-0.3",
  modelRunAt: Date.parse("2026-09-04T21:33:32Z"),
  publishedToFeed: 1,
  publishedModel: 1,
};

function target(rows: RowDataPacket[]) {
  const matches = rows.filter(
    row =>
      (row.awayTeam === "SJSU" && row.homeTeam === "EMU") ||
      row.ncaaContestId === EVENT
  );
  assert(
    matches.length <= 1,
    "Duplicate event or matchup; refusing publication"
  );
  const row = matches[0];
  if (row) {
    assert(
      row.awayTeam === "SJSU" && row.homeTeam === "EMU",
      "Event identity mismatch"
    );
    assert(
      !row.ncaaContestId || row.ncaaContestId === EVENT,
      "Matchup event mismatch"
    );
  }
  return row;
}

function verify(row: RowDataPacket | undefined) {
  assert(row, "Published matchup missing");
  for (const [key, value] of Object.entries(record)) {
    if (key === "source_updated_at") {
      assert.equal(
        new Date(row[key]).toISOString(),
        "2026-09-04T21:50:00.000Z"
      );
    } else if (value === null)
      assert.equal(row[key], null, `${key} must remain unavailable`);
    else
      assert.equal(
        String(row[key]),
        String(value),
        `Readback mismatch: ${key}`
      );
  }
}

async function main() {
  if (process.argv.includes("--check")) {
    assert.equal(
      Number(record.awayModelSpread),
      -Number(record.homeModelSpread)
    );
    assert.equal(
      Number(record.modelAwayScore) + Number(record.modelHomeScore),
      Number(record.modelTotal)
    );
    assert.equal(
      Math.round(
        (100 * Number(record.modelHomeWinPct)) / Number(record.modelAwayWinPct)
      ),
      130
    );
    const valid = {
      awayTeam: "SJSU",
      homeTeam: "EMU",
      ncaaContestId: EVENT,
      ...record,
    } as RowDataPacket;
    verify(target([valid]));
    assert.throws(() => target([valid, valid]));
    assert.throws(() => target([{ ...valid, homeTeam: "USC" }]));
    assert.throws(() => target([{ ...valid, ncaaContestId: "wrong-event" }]));
    assert.throws(() => verify({ ...valid, modelTotal: "55.0" }));
    assert.throws(() => verify({ ...valid, modelOverOdds: "-110" }));
    console.log("SJSU_EMU_PAYLOAD_CHECK_PASS");
    return;
  }
  const publish = process.argv.includes("--publish");
  assert(
    publish ||
      process.argv.includes("--dry-run") ||
      process.argv.includes("--verify"),
    "Choose --dry-run, --publish, or --verify"
  );
  assert(process.env.DATABASE_URL, "DATABASE_URL unavailable");
  const db = await mysql.createConnection({
    uri: process.env.DATABASE_URL,
    timezone: "Z",
    ssl: { rejectUnauthorized: true },
  });
  try {
    await db.beginTransaction();
    // ponytail: one date lock; use a unique event constraint if parallel publishers are added.
    const read = async () =>
      (
        await db.query<RowDataPacket[]>(
          "SELECT * FROM games WHERE gameDate = ? AND sport = ? ORDER BY id FOR UPDATE",
          [DATE, "NCAAF"]
        )
      )[0];
    const before = await read();
    const existing = target(before);
    if (process.argv.includes("--verify")) verify(existing);
    else if (publish) {
      const entries = Object.entries(record);
      if (existing) {
        await db.execute(
          `UPDATE games SET ${entries.map(([key]) => `\`${key}\` = ?`).join(", ")} WHERE id = ? AND gameDate = ? AND sport = ? AND awayTeam = ? AND homeTeam = ?`,
          [
            ...entries.map(([, value]) => value),
            existing.id,
            DATE,
            "NCAAF",
            "SJSU",
            "EMU",
          ]
        );
      } else {
        const insert = {
          fileId: 0,
          gameDate: DATE,
          sport: "NCAAF",
          awayTeam: "SJSU",
          homeTeam: "EMU",
          ...record,
        };
        await db.execute(
          `INSERT INTO games (${Object.keys(insert)
            .map(key => `\`${key}\``)
            .join(", ")}) VALUES (${Object.keys(insert)
            .map(() => "?")
            .join(", ")})`,
          Object.values(insert)
        );
      }
      const after = await read();
      const published = target(after);
      verify(published);
      assert.deepEqual(
        after.filter(row => row.id !== published!.id),
        before.filter(row => row.id !== existing?.id),
        "Unrelated rows changed"
      );
      await db.commit();
    }
    if (!publish) await db.rollback();
    console.log(
      `SJSU_EMU_${publish ? "PUBLISH" : process.argv.includes("--verify") ? "VERIFY" : "DRY_RUN"}_PASS existingRows=${existing ? 1 : 0} unrelatedRows=${before.length - (existing ? 1 : 0)}`
    );
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    await db.end();
  }
}

main().catch(error => {
  console.error(
    "SJSU_EMU_FAILED",
    error instanceof assert.AssertionError
      ? error.message
      : "Database operation failed; no credentials logged"
  );
  process.exitCode = 1;
});
