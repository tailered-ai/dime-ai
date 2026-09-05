/** Bounded owner-selected September 5 slate; preserves live state and prior history. */
import assert from "node:assert/strict";
import mysql, { type RowDataPacket } from "mysql2/promise";
import {
  DATE,
  REVISION,
  SOURCES,
  ncaafSeptember5Record,
  ncaafSeptember5HistoryRecord,
} from "../shared/ncaafSeptember5";

const selected = SOURCES.map(game => ({
  ...game,
  record: ncaafSeptember5Record(game),
}));
type Target = (typeof selected)[number];
type RecordValues = Record<string, unknown>;
const splitKeys = [
  "spreadAwayMoneyPct",
  "spreadAwayBetsPct",
  "totalOverMoneyPct",
  "totalOverBetsPct",
  "mlAwayMoneyPct",
  "mlAwayBetsPct",
];
const historyKeys = [
  "sport",
  "source",
  "scrapedAt",
  "lineSource",
  "awaySpread",
  "homeSpread",
  "awaySpreadOdds",
  "homeSpreadOdds",
  "total",
  "overOdds",
  "underOdds",
  "awayML",
  "homeML",
  ...splitKeys,
];
const lifecycleKeys = [
  "id",
  "fileId",
  "gameDate",
  "sport",
  "awayTeam",
  "homeTeam",
  "gameStatus",
  "awayScore",
  "homeScore",
  "gameClock",
  "createdAt",
  "updatedAt",
];
const numericColumns = new Set([
  "awayBookSpread",
  "homeBookSpread",
  "bookTotal",
  "awayModelSpread",
  "homeModelSpread",
  "modelTotal",
  "spreadDiff",
  "totalDiff",
  "modelAwayScore",
  "modelHomeScore",
  "modelAwayWinPct",
  "modelHomeWinPct",
  "modelOverRate",
  "modelUnderRate",
]);

function target(rows: RowDataPacket[], game: Target) {
  const matches = rows.filter(
    row =>
      (row.awayTeam === game.away && row.homeTeam === game.home) ||
      row.ncaaContestId === game.event
  );
  assert(
    matches.length <= 1,
    "Duplicate event or matchup; refusing publication"
  );
  const row = matches[0];
  if (row) {
    assert(
      row.gameDate === DATE && row.sport === "NCAAF",
      "Event date or sport mismatch"
    );
    assert(
      row.awayTeam === game.away && row.homeTeam === game.home,
      "Event identity mismatch"
    );
    assert(
      !row.ncaaContestId || row.ncaaContestId === game.event,
      "Matchup event mismatch"
    );
  }
  return row;
}

function verify(row: RowDataPacket | undefined, record: RecordValues) {
  assert(row, "Required published row missing");
  for (const [key, expected] of Object.entries(record)) {
    if (expected === null)
      assert.equal(row[key], null, `${key} must remain unavailable`);
    else if (expected instanceof Date)
      assert.equal(
        new Date(row[key]).getTime(),
        expected.getTime(),
        `Timestamp mismatch: ${key}`
      );
    else if (numericColumns.has(key))
      assert.equal(
        Number(row[key]),
        Number(expected),
        `Numeric readback mismatch: ${key}`
      );
    else
      assert.equal(
        String(row[key]),
        String(expected),
        `Readback mismatch: ${key}`
      );
  }
}

function historyRecord(
  game: Target,
  gameId: number,
  quote: Target["history"][number]
) {
  return { gameId, ...ncaafSeptember5HistoryRecord(quote) };
}

function snapshot(
  rows: RowDataPacket[],
  expected: ReturnType<typeof historyRecord>
) {
  const found = rows.filter(
    row =>
      row.gameId === expected.gameId &&
      Number(row.scrapedAt) === expected.scrapedAt &&
      row.lineSource === expected.lineSource
  );
  assert(
    found.length <= 1,
    "Duplicate history observation; refusing publication"
  );
  if (found[0]) verify(found[0], expected);
  return found[0];
}

function price(value: unknown) {
  return (
    value === null ||
    (value !== undefined &&
      Number.isFinite(Number(value)) &&
      Math.abs(Number(value)) >= 100)
  );
}

function checkPayload() {
  assert.equal(DATE, "2026-09-05");
  assert(REVISION.length > 0);
  assert.equal(selected.length, 68);
  assert.equal(
    new Set(selected.map(game => game.event)).size,
    68,
    "Duplicate source event"
  );
  assert.equal(
    new Set(selected.map(game => `${game.away}/${game.home}`)).size,
    68,
    "Duplicate source matchup"
  );
  let observations = 0;
  for (const game of selected) {
    assert.equal(game.gameDate, DATE);
    assert(game.away && game.home && game.away !== game.home && game.event);
    assert(["upcoming", "live", "final"].includes(game.initialStatus));
    const record: RecordValues = game.record;
    assert.equal(record.ncaaContestId, game.event);
    assert.equal(Number(record.publishedToFeed), 1);
    assert.equal(Number(record.publishedModel), 1);
    for (const [key, value] of Object.entries(record)) {
      assert(
        /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) && !lifecycleKeys.includes(key),
        "Forbidden update column"
      );
      assert.notEqual(value, undefined, `Undefined payload field: ${key}`);
    }
    assert(
      Number.isFinite(Number(record.awayModelSpread)) &&
        record.awayModelSpread !== null &&
        record.homeModelSpread !== null
    );
    assert.equal(
      Number(record.awayModelSpread),
      -Number(record.homeModelSpread)
    );
    assert(Number(record.modelTotal) > 0);
    for (const key of [
      "awayML",
      "homeML",
      "awaySpreadOdds",
      "homeSpreadOdds",
      "overOdds",
      "underOdds",
      "modelAwayML",
      "modelHomeML",
      "modelAwaySpreadOdds",
      "modelHomeSpreadOdds",
      "modelOverOdds",
      "modelUnderOdds",
    ])
      assert(price(record[key]), `Invalid American price: ${key}`);
    if (record.awayBookSpread != null && record.homeBookSpread != null)
      assert.equal(
        Number(record.awayBookSpread),
        -Number(record.homeBookSpread)
      );
    if (record.bookTotal != null) assert(Number(record.bookTotal) > 0);
    for (const key of splitKeys)
      assert(
        record[key] === null ||
          (Number.isInteger(record[key]) &&
            Number(record[key]) >= 0 &&
            Number(record[key]) <= 100),
        `Invalid split: ${key}`
      );
    const valid = {
      id: 1,
      gameDate: DATE,
      sport: "NCAAF",
      awayTeam: game.away,
      homeTeam: game.home,
      ...record,
    } as RowDataPacket;
    verify(target([valid], game), record);
    assert.equal(target([], game), undefined);
    assert.throws(() => target([valid, valid], game));
    for (const wrong of [
      { gameDate: "2026-09-04" },
      { sport: "NCAAM" },
      { homeTeam: "WRONG" },
      { ncaaContestId: "wrong-event" },
    ])
      assert.throws(() => target([{ ...valid, ...wrong }], game));
    assert.throws(() => verify({ ...valid, modelTotal: "9999" }, record));
    const keys = new Set<string>();
    for (const quote of game.history) {
      const expected = historyRecord(game, 1, quote);
      assert.deepEqual(
        Object.keys(expected)
          .filter(key => key !== "gameId")
          .sort(),
        [...historyKeys].sort()
      );
      assert.equal(expected.sport, "NCAAF");
      assert.equal(expected.source, "manual");
      assert(
        Object.values(expected).every(value => value !== undefined),
        "Undefined history field"
      );
      if (expected.awaySpread !== null && expected.homeSpread !== null)
        assert.equal(Number(expected.awaySpread), -Number(expected.homeSpread));
      if (expected.total !== null) assert(Number(expected.total) > 0);
      const retrievedAt = Date.parse(quote.retrievedAt);
      assert(
        Number.isFinite(retrievedAt) && expected.scrapedAt <= retrievedAt,
        "History observation after retrieval"
      );
      assert(["dk", "open"].includes(expected.lineSource));
      assert(
        Number.isSafeInteger(expected.scrapedAt) && expected.scrapedAt > 0
      );
      const key = `${expected.scrapedAt}/${expected.lineSource}`;
      assert(!keys.has(key), "Duplicate source history observation");
      keys.add(key);
      for (const name of [
        "awaySpreadOdds",
        "homeSpreadOdds",
        "overOdds",
        "underOdds",
        "awayML",
        "homeML",
      ] as const)
        assert(price(expected[name]), `Invalid history price: ${name}`);
      for (const name of splitKeys) {
        const value = (expected as RecordValues)[name];
        assert(
          value === null ||
            (Number.isInteger(value) &&
              Number(value) >= 0 &&
              Number(value) <= 100)
        );
      }
      const validHistory = { id: 2, ...expected } as RowDataPacket;
      verify(snapshot([validHistory], expected), expected);
      assert.equal(snapshot([], expected), undefined);
      assert.throws(() => snapshot([validHistory, validHistory], expected));
      assert.throws(() =>
        snapshot([{ ...validHistory, awaySpread: "9999" }], expected)
      );
      assert.throws(() => verify(undefined, expected));
    }
    observations += game.history.length;
  }
  assert.equal(observations, 1885, "Expected 1817 VSiN and 68 AN observations");
}

async function main() {
  const modes = ["--check", "--dry-run", "--publish", "--verify"];
  const args = process.argv.slice(2);
  assert(
    args.length === 1 && modes.includes(args[0]),
    "Choose exactly one mode: --check, --dry-run, --publish, or --verify"
  );
  checkPayload();
  const mode = args[0];
  if (mode === "--check") {
    console.log(
      "NCAAF_SEPTEMBER5_PAYLOAD_CHECK_PASS selectedRows=68 modelRows=68 historySnapshots=1885"
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
    await db.beginTransaction();
    // ponytail: one bounded slate lock; add a unique event constraint if publishers run concurrently.
    const read = async () =>
      (
        await db.query<RowDataPacket[]>(
          `SELECT * FROM games WHERE (gameDate = ? AND sport = ?) OR ncaaContestId IN (${selected.map(() => "?").join(", ")}) ORDER BY id FOR UPDATE`,
          [DATE, "NCAAF", ...selected.map(game => game.event)]
        )
      )[0];
    const before = await read();
    const existing = selected.map(game => target(before, game));
    const readHistory = async (ids: number[]) =>
      ids.length === 0
        ? []
        : (
            await db.query<RowDataPacket[]>(
              `SELECT * FROM odds_history WHERE gameId IN (${ids.map(() => "?").join(", ")}) ORDER BY id FOR UPDATE`,
              ids
            )
          )[0];
    const historyBefore = await readHistory(
      existing.filter(Boolean).map(row => row!.id)
    );
    // Check every event and existing observation before any write; conflicts must not rewrite history.
    selected.forEach((game, i) => {
      if (existing[i])
        for (const quote of game.history)
          snapshot(historyBefore, historyRecord(game, existing[i]!.id, quote));
    });
    if (mode === "--verify") {
      selected.forEach((game, i) => {
        verify(existing[i], game.record);
        for (const quote of game.history) {
          const expected = historyRecord(game, existing[i]!.id, quote);
          verify(snapshot(historyBefore, expected), expected);
        }
      });
    } else if (mode === "--publish") {
      for (const [i, game] of selected.entries()) {
        const entries = Object.entries(game.record);
        if (existing[i])
          await db.execute(
            `UPDATE games SET ${entries.map(([key]) => `\`${key}\` = ?`).join(", ")} WHERE id = ? AND gameDate = ? AND sport = ? AND awayTeam = ? AND homeTeam = ?`,
            [
              ...entries.map(([, value]) => value),
              existing[i]!.id,
              DATE,
              "NCAAF",
              game.away,
              game.home,
            ]
          );
        else {
          const insert = {
            fileId: 0,
            gameDate: DATE,
            sport: "NCAAF",
            awayTeam: game.away,
            homeTeam: game.home,
            gameStatus: game.initialStatus,
            ...game.record,
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
      }
      const after = await read();
      const published = selected.map((game, i) => {
        const row = target(after, game);
        verify(row, game.record);
        if (existing[i]) {
          const preserved = (value: RowDataPacket) =>
            Object.fromEntries(
              Object.entries(value).filter(
                ([key]) => !(key in game.record) && key !== "updatedAt"
              )
            );
          assert.deepEqual(
            preserved(row!),
            preserved(existing[i]!),
            "Non-published fields or live state changed"
          );
        } else assert.equal(row!.gameStatus, game.initialStatus);
        return row!;
      });
      const oldIds = new Set(existing.filter(Boolean).map(row => row!.id));
      const newIds = new Set(published.map(row => row.id));
      assert.deepEqual(
        after.filter(row => !newIds.has(row.id)),
        before.filter(row => !oldIds.has(row.id)),
        "Unrelated rows changed"
      );
      const expected = selected.flatMap((game, i) =>
        game.history.map(quote => historyRecord(game, published[i].id, quote))
      );
      const missing = expected.filter(
        record => !snapshot(historyBefore, record)
      );
      if (missing.length) {
        const columns = Object.keys(missing[0]);
        for (const record of missing)
          assert.deepEqual(Object.keys(record), columns);
        await db.execute(
          `INSERT INTO odds_history (${columns.map(key => `\`${key}\``).join(", ")}) VALUES ${missing.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ")}`,
          missing.flatMap(record => Object.values(record))
        );
      }
      const historyAfter = await readHistory(published.map(row => row.id));
      const insertedIds = new Set<number>();
      for (const record of expected) {
        const row = snapshot(historyAfter, record);
        verify(row, record);
        if (!snapshot(historyBefore, record)) insertedIds.add(row!.id);
      }
      assert.deepEqual(
        historyAfter.filter(row => !insertedIds.has(row.id)),
        historyBefore,
        "Existing history changed"
      );
      await db.commit();
    }
    if (mode !== "--publish") await db.rollback();
    const count = existing.filter(Boolean).length;
    const statuses: Record<string, number> = {};
    selected.forEach((game, i) => {
      const status = existing[i]?.gameStatus ?? game.initialStatus;
      statuses[status] = (statuses[status] ?? 0) + 1;
    });
    console.log(
      `NCAAF_SEPTEMBER5_${mode.slice(2).toUpperCase().replace("-", "_")}_PASS selectedRows=68 existingRows=${count} modelRows=68 existingModelRows=${existing.filter(row => row?.publishedModel).length} unrelatedRows=${before.length - count} historySnapshots=1885 statuses=${JSON.stringify(statuses)}`
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
    "NCAAF_SEPTEMBER5_FAILED",
    error instanceof assert.AssertionError
      ? error.message
      : "Database operation failed; no credentials logged"
  );
  process.exitCode = 1;
});
