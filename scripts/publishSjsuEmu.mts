/** Owner-selected pregame snapshot; no model fitting or live odds substitution. */
import assert from "node:assert/strict";
import mysql, { type RowDataPacket } from "mysql2/promise";
import sourceRows from "../shared/ncaafSeptember4Sources.json";
import {
  NCAAF_SEPTEMBER4,
  ncaafSeptember4Record,
  ncaafSeptember4HistoryRecord,
} from "../shared/ncaafSeptember4";

import {
  NCAAF_DK_SOURCES,
  NCAAF_DK_SPLIT_KEYS,
  ncaafDkHistoryRecord,
} from "../shared/ncaafSeptember4Dk";

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

const dk = process.argv.includes("--source=vsin-dk");
assert(
  process.argv
    .filter(arg => arg.startsWith("--source="))
    .every(arg => arg === "--source=vsin-dk"),
  "Unsupported source"
);
const five = process.argv.includes("--slate=september-4-five");
assert(
  process.argv
    .filter(arg => arg.startsWith("--slate="))
    .every(arg => arg === "--slate=september-4-five"),
  "Unsupported slate"
);
assert(!dk || five, "DK requires the exact five-game slate");
const selected: {
  away: string;
  home: string;
  event: string;
  record: Record<string, unknown>;
}[] = five
  ? NCAAF_SEPTEMBER4.map(game => ({
      away: game.away,
      home: game.home,
      event: game.event,
      record: dk
        ? NCAAF_DK_SOURCES.find(source => source.event === game.event)!.splits
        : {
            ...ncaafSeptember4Record(game),
            ...sourceRows.find(source => source.event === game.event)!.splits,
          },
    }))
  : [{ away: "SJSU", home: "EMU", event: EVENT, record }];
type Target = (typeof selected)[number];

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

function verify(row: RowDataPacket | undefined, game: Target) {
  assert(row, "Published matchup missing");
  for (const [key, value] of Object.entries(game.record)) {
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

function checkPayload() {
  if (dk) {
    assert.equal(NCAAF_DK_SOURCES.length, 5);
    assert.equal(new Set(NCAAF_DK_SOURCES.map(source => source.event)).size, 5);
    let observations = 0;
    for (const source of NCAAF_DK_SOURCES) {
      assert(
        NCAAF_SEPTEMBER4.some(
          game =>
            game.event === source.event &&
            game.away === source.away &&
            game.home === source.home
        )
      );
      assert.equal(source.gameDate, DATE);
      assert.deepEqual(
        Object.keys(source.splits).sort(),
        [...NCAAF_DK_SPLIT_KEYS].sort()
      );
      const keys = new Set<string>();
      for (const quote of source.history) {
        const record = ncaafDkHistoryRecord(quote);
        const key = `${record.scrapedAt}/${record.lineSource}`;
        assert(!keys.has(key), "Duplicate DK observation");
        keys.add(key);
        assert.equal(Date.parse(quote.sourceObservedAt), quote.scrapedAt);
        assert(quote.scrapedAt <= Date.parse(quote.retrievedAt));
        assert(Number(quote.awaySpread) === -Number(quote.homeSpread));
        for (const field of NCAAF_DK_SPLIT_KEYS)
          assert(
            Number.isInteger(quote[field]) &&
              quote[field] >= 0 &&
              quote[field] <= 100
          );
        for (const field of [
          "awaySpreadOdds",
          "homeSpreadOdds",
          "overOdds",
          "underOdds",
        ] as const)
          assert.equal(quote[field], null);
        if (source.away === "UTEP")
          assert(quote.awayML === null && quote.homeML === null);
      }
      const latest = source.history.reduce((a, b) =>
        a.scrapedAt > b.scrapedAt ? a : b
      );
      for (const [key, value] of Object.entries(source.currentLines))
        assert.equal(latest[key as keyof typeof latest], value);
      for (const field of NCAAF_DK_SPLIT_KEYS)
        assert.equal(source.splits[field], latest[field]);
      observations += source.history.length;
    }
    assert.equal(observations, 134);
  }
  assert.equal(sourceRows.length, 5);
  assert.equal(new Set(sourceRows.map(source => source.event)).size, 5);
  for (const source of sourceRows) {
    assert(
      NCAAF_SEPTEMBER4.some(
        game =>
          game.event === source.event &&
          game.away === source.away &&
          game.home === source.home
      )
    );
    assert.equal(Object.keys(source.splits).length, 6);
    assert(
      Object.values(source.splits).every(
        value => Number.isInteger(value) && value >= 0 && value <= 100
      )
    );
    assert.deepEqual(
      source.history.map(row => row.lineSource),
      ["open", "dk"]
    );
    for (const row of source.history) {
      assert.equal(
        new Date(row.scrapedAt).toISOString(),
        "2026-09-04T23:36:19.387Z"
      );
      assert.equal(Number(row.awaySpread), -Number(row.homeSpread));
      assert(Number(row.total) > 0);
      for (const value of [
        row.awaySpreadOdds,
        row.homeSpreadOdds,
        row.overOdds,
        row.underOdds,
      ])
        assert(value && Math.abs(Number(value)) >= 100);
      if (source.away === "UTEP")
        assert(row.awayML === null && row.homeML === null);
    }
  }

  assert.equal(selected.length, five ? 5 : 1);
  assert.equal(new Set(selected.map(g => g.event)).size, selected.length);
  for (const game of selected) {
    if (!dk)
      assert.equal(
        Number(game.record.awayModelSpread),
        -Number(game.record.homeModelSpread)
      );
    const valid = {
      gameDate: DATE,
      sport: "NCAAF",
      awayTeam: game.away,
      homeTeam: game.home,
      ...game.record,
      ncaaContestId: game.event,
    } as RowDataPacket;
    verify(target([valid], game), game);
    assert.throws(() => target([valid, valid], game));
    for (const wrong of [
      { gameDate: "2026-09-03" },
      { sport: "NCAAM" },
      { homeTeam: "WRONG" },
      { ncaaContestId: "wrong-event" },
    ]) {
      assert.throws(() => target([{ ...valid, ...wrong }], game));
    }
    assert.throws(() =>
      verify(
        { ...valid, [dk ? "spreadAwayBetsPct" : "modelTotal"]: "999.0" },
        game
      )
    );
    if (!dk)
      assert.throws(() => verify({ ...valid, modelOverOdds: "-999" }, game));
    if (five) {
      if (!dk)
        assert(
          game.record.modelAwaySpreadOdds &&
            game.record.modelHomeSpreadOdds &&
            game.record.modelOverOdds &&
            game.record.modelUnderOdds
        );
      if (!dk && game.away === "UTEP") assert.equal(game.record.homeML, null);
      for (const quote of quotes(game)) {
        const expected = historyRecord(game, 1, quote);
        const valid = { id: 2, ...expected } as RowDataPacket;
        verifyHistory(snapshot([valid], expected), expected);
        assert.equal(snapshot([], expected), undefined);
        assert.throws(() => snapshot([valid, valid], expected));
        assert.throws(() =>
          snapshot([{ ...valid, awaySpread: "999" }], expected)
        );
        assert.throws(() => verifyHistory(undefined, expected));
      }
    }
  }
}

function quotes(game: Target) {
  return dk
    ? NCAAF_DK_SOURCES.find(source => source.event === game.event)!.history
    : sourceRows.find(source => source.event === game.event)!.history;
}

function historyRecord(
  game: Target,
  gameId: number,
  quote: ReturnType<typeof quotes>[number]
) {
  return {
    gameId,
    ...("sourceSection" in quote
      ? ncaafDkHistoryRecord(quote)
      : ncaafSeptember4HistoryRecord(game.event, quote)),
  };
}
function verifyHistory(
  row: RowDataPacket | undefined,
  record: ReturnType<typeof historyRecord>
) {
  assert(row, "Required history snapshot missing");
  for (const [key, value] of Object.entries(record))
    assert.equal(
      row[key] == null ? null : String(row[key]),
      value == null ? null : String(value),
      `History readback mismatch: ${key}`
    );
}

function snapshot(
  rows: RowDataPacket[],
  record: ReturnType<typeof historyRecord>
) {
  const found = rows.filter(
    row =>
      row.gameId === record.gameId &&
      row.scrapedAt === record.scrapedAt &&
      row.lineSource === record.lineSource
  );
  assert(found.length <= 1, "Duplicate history snapshot");
  if (found[0]) verifyHistory(found[0], record);
  return found[0];
}

async function main() {
  checkPayload();
  const modes = ["--check", "--publish", "--dry-run", "--verify"].filter(mode =>
    process.argv.includes(mode)
  );
  assert.equal(
    modes.length,
    1,
    "Choose exactly one mode: --check, --dry-run, --publish, or --verify"
  );
  const prefix = dk ? "NCAAF_DK" : five ? "NCAAF_FIVE" : "SJSU_EMU";
  if (modes[0] === "--check") {
    console.log(`${prefix}_PAYLOAD_CHECK_PASS`);
    return;
  }
  const publish = modes[0] === "--publish";
  assert(process.env.DATABASE_URL, "DATABASE_URL unavailable");
  const db = await mysql.createConnection({
    uri: process.env.DATABASE_URL,
    timezone: "Z",
    ssl: { rejectUnauthorized: true },
  });
  try {
    await db.beginTransaction();
    // ponytail: one slate/event lock; use a unique event constraint if parallel publishers are added.
    const read = async () =>
      (
        await db.query<RowDataPacket[]>(
          `SELECT * FROM games WHERE (gameDate = ? AND sport = ?) OR ncaaContestId IN (${selected.map(() => "?").join(", ")}) ORDER BY id FOR UPDATE`,
          [DATE, "NCAAF", ...selected.map(g => g.event)]
        )
      )[0];
    const before = await read();
    // Validate EVERY identity before the first write, including cross-date/event collisions.
    const existing = selected.map(game => target(before, game));
    if (dk)
      assert(
        existing.every(Boolean),
        "DK update requires all five existing games"
      );
    const readHistory = async (ids: number[]) =>
      ids.length === 0
        ? []
        : (
            await db.query<RowDataPacket[]>(
              `SELECT * FROM odds_history WHERE gameId IN (${ids.map(() => "?").join(", ")}) ORDER BY id FOR UPDATE`,
              ids
            )
          )[0];
    const historyBefore = five
      ? await readHistory(existing.filter(Boolean).map(row => row!.id))
      : [];
    // Validate pre-existing observations before any write; never rewrite history.
    if (five)
      selected.forEach((game, i) => {
        if (existing[i])
          for (const quote of quotes(game))
            snapshot(
              historyBefore,
              historyRecord(game, existing[i]!.id, quote)
            );
      });
    if (modes[0] === "--verify") {
      selected.forEach((game, i) => verify(existing[i], game));
      if (five)
        selected.forEach((game, i) => {
          for (const quote of quotes(game)) {
            const record = historyRecord(game, existing[i]!.id, quote);
            verifyHistory(snapshot(historyBefore, record), record);
          }
        });
    } else if (publish) {
      for (const [i, game] of selected.entries()) {
        const entries = Object.entries(game.record);
        if (existing[i]) {
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
        } else {
          const insert = {
            fileId: 0,
            gameDate: DATE,
            sport: "NCAAF",
            awayTeam: game.away,
            homeTeam: game.home,
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
      const published = selected.map(game => {
        const row = target(after, game);
        verify(row, game);
        return row!;
      });
      if (dk)
        published.forEach((row, i) => {
          const unchanged = (value: RowDataPacket) =>
            Object.fromEntries(
              Object.entries(value).filter(
                ([key]) =>
                  !NCAAF_DK_SPLIT_KEYS.includes(
                    key as (typeof NCAAF_DK_SPLIT_KEYS)[number]
                  ) && key !== "updatedAt"
              )
            );
          assert.deepEqual(
            unchanged(row),
            unchanged(existing[i]!),
            "DK update changed model or Circa book fields"
          );
        });
      const oldIds = new Set(existing.filter(Boolean).map(row => row!.id));
      const newIds = new Set(published.map(row => row.id));
      assert.deepEqual(
        after.filter(row => !newIds.has(row.id)),
        before.filter(row => !oldIds.has(row.id)),
        "Unrelated rows changed"
      );
      if (five) {
        const missing = selected
          .flatMap((game, i) =>
            quotes(game).map(quote =>
              historyRecord(game, published[i].id, quote)
            )
          )
          .filter(record => !snapshot(historyBefore, record));
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
        selected.forEach((game, i) => {
          for (const quote of quotes(game)) {
            const record = historyRecord(game, published[i].id, quote);
            const row = snapshot(historyAfter, record);
            verifyHistory(row, record);
            if (!snapshot(historyBefore, record)) insertedIds.add(row!.id);
          }
        });
        assert.deepEqual(
          historyAfter.filter(row => !insertedIds.has(row.id)),
          historyBefore,
          "Existing odds history changed"
        );
      }
      await db.commit();
    }
    if (!publish) await db.rollback();
    const count = existing.filter(Boolean).length;
    console.log(
      `${prefix}_${publish ? "PUBLISH" : modes[0] === "--verify" ? "VERIFY" : "DRY_RUN"}_PASS selectedRows=${selected.length} existingRows=${count} unrelatedRows=${before.length - count} historySnapshots=${five ? selected.reduce((count, game) => count + quotes(game).length, 0) : 0}`
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
