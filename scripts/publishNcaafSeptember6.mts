/** September 6 owner-requested slate. Existing TiDB publisher pattern; no model generation. */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import mysql, { type RowDataPacket } from "mysql2/promise";
import {
  scrapeVsinBettingSplits,
  type VsinSplitsGame,
} from "../server/vsinBettingSplitsScraper";

export const DATE = "2026-09-06";
export const SLATE = [
  {
    event: 288813,
    awayId: 356,
    homeId: 360,
    away: "WSU",
    home: "WASH",
    time: "16:00",
    utc: "2026-09-06T20:00:00.000Z",
    vsin: "20260906CFB00237",
    awaySlug: "washington-st-cougars",
    homeSlug: "washington-huskies",
  },
  {
    event: 287973,
    awayId: 300,
    homeId: 325,
    away: "WIS",
    home: "ND",
    time: "19:30",
    utc: "2026-09-06T23:30:00.000Z",
    vsin: "20260906CFB00195",
    awaySlug: "wisconsin-badgers",
    homeSlug: "notre-dame-fighting-irish",
  },
  {
    event: 287972,
    awayId: 257,
    homeId: 363,
    away: "LOU",
    home: "MISS",
    time: "19:30",
    utc: "2026-09-06T23:30:00.000Z",
    vsin: "20260906CFB00182",
    awaySlug: "louisville-cardinals",
    homeSlug: "ole-miss-rebels",
  },
] as const;
const splitKeys = [
  "spreadAwayBetsPct",
  "spreadAwayMoneyPct",
  "totalOverBetsPct",
  "totalOverMoneyPct",
  "mlAwayBetsPct",
  "mlAwayMoneyPct",
] as const;
type Row = Record<string, any>;
const object = (value: unknown): Row => {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    "Expected source object"
  );
  return value as Row;
};
const numeric = (value: unknown) => {
  assert(
    typeof value === "number" && Number.isFinite(value),
    "Invalid source number"
  );
  return value;
};
const point = (value: unknown) =>
  value == null ? null : String(numeric(value));
const price = (value: unknown) => {
  if (value == null) return null;
  const n = numeric(value);
  assert(Number.isInteger(n) && Math.abs(n) >= 100, "Invalid American odds");
  return n > 0 ? `+${n}` : String(n);
};

export function publication(an: unknown, vsin: VsinSplitsGame[]) {
  const raw = object(an);
  assert.equal(object(raw.league).name, "ncaaf");
  assert(Array.isArray(raw.games));
  return SLATE.map((game, index) => {
    const matches = raw.games.filter((row: Row) => row.id === game.event);
    assert.equal(matches.length, 1, "Missing or duplicate AN event");
    const event = object(matches[0]);
    assert.equal(event.away_team_id, game.awayId);
    assert.equal(event.home_team_id, game.homeId);
    assert.equal(
      event.start_time,
      game.utc,
      "Kickoff changed: review before publication"
    );
    assert(Array.isArray(event.teams));
    for (const id of [game.awayId, game.homeId])
      assert.equal(event.teams.filter((team: Row) => team.id === id).length, 1);
    const statuses: Record<string, string> = {
      scheduled: "upcoming",
      inprogress: "live",
      in_progress: "live",
      complete: "final",
      postponed: "postponed",
      suspended: "suspended",
      delayed: "suspended",
    };
    assert(Object.hasOwn(statuses, event.status), "Unknown source lifecycle");
    const markets = object(event.markets?.["68"]?.event ?? {});
    const outcome = (market: string, side: string, teamId?: number) => {
      const outcomes = markets[market] ?? [];
      assert(Array.isArray(outcomes));
      const selected = outcomes.filter(
        (r: Row) =>
          r.side === side && r.is_live !== true && r.is_alt_market !== true
      );
      assert(selected.length <= 1, "Ambiguous AN price");
      const quote = selected[0];
      if (quote) {
        assert.equal(quote.book_id, 68);
        assert.equal(quote.event_id, game.event);
        assert.equal(quote.period, "event");
        if (teamId) assert.equal(quote.team_id, teamId);
      }
      return quote;
    };
    const away = outcome("spread", "away", game.awayId),
      home = outcome("spread", "home", game.homeId);
    const over = outcome("total", "over"),
      under = outcome("total", "under");
    if (away && home) assert.equal(numeric(away.value), -numeric(home.value));
    if (over && under)
      assert.equal(over.value, under.value, "Total thresholds disagree");
    const splits = vsin.filter(row => row.gameId === game.vsin);
    assert.equal(splits.length, 1, "Missing or duplicate VSiN event");
    assert.equal(splits[0].sport, "CFB");
    assert.equal(splits[0].awayVsinSlug, game.awaySlug);
    assert.equal(splits[0].homeVsinSlug, game.homeSlug);
    const percentages = Object.fromEntries(
      splitKeys.map(key => {
        const value = splits[0][key];
        assert(
          value === null ||
            (Number.isInteger(value) && value >= 0 && value <= 100),
          "Invalid VSiN percentage"
        );
        return [key, value];
      })
    );
    const score = (value: unknown) => {
      if (value == null) return null;
      const n = numeric(value);
      assert(Number.isInteger(n) && n >= 0);
      return n;
    };
    const lifecycle = {
      gameStatus: statuses[event.status],
      awayScore: score(event.boxscore?.total_away_points),
      homeScore: score(event.boxscore?.total_home_points),
      gameClock: ["live", "suspended"].includes(statuses[event.status])
        ? String(event.status_display ?? "").slice(0, 32) || null
        : null,
    };
    if (lifecycle.gameStatus === "final")
      assert(lifecycle.awayScore !== null && lifecycle.homeScore !== null);
    const fields = {
      ncaaContestId: String(game.event),
      startTimeEst: game.time,
      sortOrder: index,
      publishedToFeed: 1,
      awayBookSpread: point(away?.value),
      homeBookSpread: point(home?.value),
      bookTotal: point(over?.value ?? under?.value),
      awaySpreadOdds: price(away?.odds),
      homeSpreadOdds: price(home?.odds),
      overOdds: price(over?.odds),
      underOdds: price(under?.odds),
      awayML: price(outcome("moneyline", "away", game.awayId)?.odds),
      homeML: price(outcome("moneyline", "home", game.homeId)?.odds),
      ...percentages,
    };
    assert(
      fields.awayBookSpread !== null || fields.bookTotal !== null,
      "Existing feed requires at least one priced line"
    );
    assert(
      Object.keys(fields).every(key => !/model|edge|diff/i.test(key)),
      "Never overwrite models"
    );
    return { game, fields, lifecycle };
  });
}

export function target(rows: Row[], game: (typeof SLATE)[number]) {
  const matches = rows.filter(
    row =>
      String(row.ncaaContestId) === String(game.event) ||
      (row.awayTeam === game.away && row.homeTeam === game.home)
  );
  assert(matches.length <= 1, "Duplicate destination identity");
  const row = matches[0];
  if (row) {
    assert.equal(row.gameDate, DATE);
    assert.equal(row.sport, "NCAAF");
    assert.equal(row.awayTeam, game.away);
    assert.equal(row.homeTeam, game.home);
    assert(
      !row.ncaaContestId || String(row.ncaaContestId) === String(game.event),
      "Conflicting source identity"
    );
  }
  return row;
}
const verify = (row: Row, fields: Row) => {
  assert(row, "Published row missing");
  for (const [key, value] of Object.entries(fields))
    if (value === null) assert.equal(row[key], null, key);
    else if (
      typeof value === "number" ||
      /Spread$|Total$/.test(key) ||
      key === "total"
    )
      assert.equal(Number(row[key]), Number(value), key);
    else assert.equal(String(row[key]), String(value), key);
};

/** Owner-supplied September 6 values, not generated odds or a new model run. */
export function washingtonOwnerModel(rows: Row[], importedAt: number) {
  assert.equal(rows.length, 1, "Missing or duplicate Washington target");
  const row = target(rows, SLATE[0])!;
  assert.equal(row.id, 4350069, "Washington row identity changed");
  assert.equal(Number(row.publishedToFeed), 1);
  assert(Number.isSafeInteger(importedAt) && importedAt > 0);
  const fields = {
    awayModelSpread: "21.1",
    homeModelSpread: "-21.1",
    modelTotal: "52.1",
    publishedModel: 1,
  };
  const replay = Object.entries(fields).every(
    ([k, v]) => row[k] !== null && Number(row[k]) === Number(v)
  );
  if (replay) {
    assert(Number.isSafeInteger(row.modelRunAt) && row.modelRunAt > 0);
    return { ...fields, modelRunAt: row.modelRunAt as number };
  }
  for (const key of [
    "awayModelSpread",
    "homeModelSpread",
    "modelTotal",
    "modelRunAt",
    "modelAwaySpreadOdds",
    "modelHomeSpreadOdds",
    "modelOverOdds",
    "modelUnderOdds",
    "modelAwayML",
    "modelHomeML",
  ])
    assert.equal(
      row[key],
      null,
      `Existing ${key} changed; review before publishing`
    );
  assert.equal(Number(row.publishedModel), 0);
  // Existing feed publication marker, also used by September 5 imports; not execution time.
  return { ...fields, modelRunAt: importedAt };
}

async function publishWashingtonOwnerModel(mode: string) {
  assert(process.env.DATABASE_URL, "DATABASE_URL unavailable");
  const db = await mysql.createConnection({
    uri: process.env.DATABASE_URL,
    timezone: "Z",
    ssl: { rejectUnauthorized: true },
  });
  try {
    await db.beginTransaction();
    const read = async () =>
      (
        await db.query<RowDataPacket[]>(
          "SELECT * FROM games WHERE id = ? OR ncaaContestId = ? OR (gameDate = ? AND sport = ? AND awayTeam = ? AND homeTeam = ?) ORDER BY id FOR UPDATE",
          [4350069, "288813", DATE, "NCAAF", "WSU", "WASH"]
        )
      )[0];
    const before = await read();
    const fields = washingtonOwnerModel(before, Date.now());
    const changed = Object.entries(fields).some(
      ([k, v]) => before[0][k] === null || Number(before[0][k]) !== Number(v)
    );
    if (mode === "--washington-model-verify")
      assert(!changed, "Owner model not yet published");
    if (mode === "--washington-model-publish" && changed) {
      const result = (
        await db.execute<mysql.ResultSetHeader>(
          "UPDATE games SET awayModelSpread = ?, homeModelSpread = ?, modelTotal = ?, publishedModel = ?, modelRunAt = ? WHERE id = ? AND ncaaContestId = ? AND gameDate = ? AND sport = ? AND awayTeam = ? AND homeTeam = ? AND modelRunAt IS NULL AND publishedModel = 0",
          [
            ...Object.values(fields),
            4350069,
            "288813",
            DATE,
            "NCAAF",
            "WSU",
            "WASH",
          ]
        )
      )[0];
      assert.equal(result.affectedRows, 1, "Owner model update guard failed");
      const after = await read();
      assert.equal(after.length, 1);
      verify(after[0], fields);
      const preserved = (row: Row) =>
        Object.fromEntries(
          Object.entries(row).filter(
            ([k]) => !(k in fields) && k !== "updatedAt"
          )
        );
      assert.deepEqual(
        preserved(after[0]),
        preserved(before[0]),
        "Unrequested fields changed"
      );
    }
    if (mode === "--washington-model-publish") {
      await db.commit();
      const fresh = await read();
      verify(target(fresh, SLATE[0])!, fields);
    } else await db.rollback();
    console.log(
      JSON.stringify({
        operation: mode,
        event: 288813,
        rowId: 4350069,
        source: "PREZ supplied model thresholds",
        fields,
        publicationMarkerMeaning: "owner import time, not model execution time",
        changed: mode === "--washington-model-publish" && changed,
        pending: mode === "--washington-model-dry-run" && changed,
        bookAndSplitsPreserved: true,
      })
    );
    console.log("NCAAF_WASHINGTON_OWNER_MODEL_PASS");
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    await db.end();
  }
}

async function main() {
  const [mode, ...extra] = process.argv.slice(2);
  if (
    !extra.length &&
    [
      "--washington-model-dry-run",
      "--washington-model-publish",
      "--washington-model-verify",
    ].includes(mode)
  ) {
    await publishWashingtonOwnerModel(mode);
    return;
  }
  assert(
    !extra.length && ["--check", "--dry-run", "--publish"].includes(mode),
    "Choose --check, --dry-run or --publish"
  );
  const [response, vsin] = await Promise.all([
    fetch(
      "https://api.actionnetwork.com/web/v2/scoreboard/ncaaf?bookIds=68&date=20260906&periods=event",
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Referer: "https://www.actionnetwork.com/",
        },
        signal: AbortSignal.timeout(20000),
      }
    ),
    scrapeVsinBettingSplits("today", "CFB"),
  ]);
  assert(response.ok, `AN HTTP ${response.status}`);
  const selected = publication(await response.json(), vsin);
  const capturedAt = Date.now(); // Retrieval, never an asserted model-run or opening timestamp.
  console.log(
    JSON.stringify({
      date: DATE,
      oddsSource: "Action Network / DraftKings 68",
      splitsSource: "VSiN / DraftKings",
      retrievedAt: new Date(capturedAt).toISOString(),
      records: selected.map(({ game, fields, lifecycle }) => ({
        event: game.event,
        away: game.away,
        home: game.home,
        ...fields,
        ...lifecycle,
      })),
    })
  );
  if (mode === "--check") {
    console.log("NCAAF_SEPTEMBER6_SOURCE_CHECK_PASS");
    return;
  }
  assert(process.env.DATABASE_URL, "DATABASE_URL unavailable");
  const db = await mysql.createConnection({
    uri: process.env.DATABASE_URL,
    timezone: "Z",
    ssl: { rejectUnauthorized: true },
  });
  try {
    // Same bounded slate transaction and publisher concurrency group as September 5.
    await db.beginTransaction();
    const read = async () =>
      (
        await db.query<RowDataPacket[]>(
          "SELECT * FROM games WHERE (gameDate = ? AND sport = 'NCAAF') OR ncaaContestId IN (?, ?, ?) ORDER BY id FOR UPDATE",
          [DATE, ...SLATE.map(g => String(g.event))]
        )
      )[0];
    const before = await read();
    const existing = selected.map(({ game }) => target(before, game));
    if (mode === "--dry-run") {
      await db.rollback();
      console.log(
        `NCAAF_SEPTEMBER6_DRY_RUN_PASS existing=${existing.filter(Boolean).length} selected=3`
      );
      return;
    }
    for (const [index, { game, fields, lifecycle }] of selected.entries()) {
      const row = existing[index];
      if (row) {
        const entries = Object.entries(fields);
        await db.execute(
          `UPDATE games SET ${entries.map(([k]) => `\`${k}\` = ?`).join(",")} WHERE id = ? AND gameDate = ? AND sport = 'NCAAF'`,
          [...entries.map(([, v]) => v), row.id, DATE]
        );
      } else {
        const insert = {
          fileId: 0,
          gameDate: DATE,
          sport: "NCAAF",
          gameType: "regular_season",
          awayTeam: game.away,
          homeTeam: game.home,
          publishedModel: 0,
          ...lifecycle,
          ...fields,
        };
        await db.execute(
          `INSERT INTO games (${Object.keys(insert)
            .map(k => `\`${k}\``)
            .join(",")}) VALUES (${Object.keys(insert)
            .map(() => "?")
            .join(",")})`,
          Object.values(insert)
        );
      }
    }
    const after = await read();
    const ids = new Set<number>();
    for (const [index, { game, fields }] of selected.entries()) {
      const row = target(after, game)!;
      verify(row, fields);
      ids.add(row.id);
      if (existing[index]) {
        const preserved = (r: Row) =>
          Object.fromEntries(
            Object.entries(r).filter(
              ([k]) => !(k in fields) && k !== "updatedAt"
            )
          );
        assert.deepEqual(
          preserved(row),
          preserved(existing[index]),
          "Existing model or lifecycle changed"
        );
      }
      const history = {
        gameId: row.id,
        sport: "NCAAF",
        source: "manual",
        scrapedAt: capturedAt,
        lineSource: "dk",
        awaySpread: fields.awayBookSpread,
        homeSpread: fields.homeBookSpread,
        total: fields.bookTotal,
        awaySpreadOdds: fields.awaySpreadOdds,
        homeSpreadOdds: fields.homeSpreadOdds,
        overOdds: fields.overOdds,
        underOdds: fields.underOdds,
        awayML: fields.awayML,
        homeML: fields.homeML,
        ...Object.fromEntries(splitKeys.map(k => [k, (fields as Row)[k]])),
      };
      await db.execute(
        `INSERT INTO odds_history (${Object.keys(history)
          .map(k => `\`${k}\``)
          .join(",")}) VALUES (${Object.keys(history)
          .map(() => "?")
          .join(",")})`,
        Object.values(history)
      );
      const [saved] = await db.query<RowDataPacket[]>(
        "SELECT * FROM odds_history WHERE gameId = ? AND scrapedAt = ? AND lineSource = 'dk'",
        [row.id, capturedAt]
      );
      assert.equal(saved.length, 1);
      verify(saved[0], history);
    }
    assert.deepEqual(
      after.filter(r => !ids.has(r.id)),
      before.filter(r => !ids.has(r.id)),
      "Unrelated rows changed"
    );
    await db.commit();
    const [fresh] = await db.query<RowDataPacket[]>(
      "SELECT * FROM games WHERE id IN (?, ?, ?)",
      [...ids]
    );
    for (const { game, fields } of selected)
      verify(target(fresh, game)!, fields);
    console.log(
      `NCAAF_SEPTEMBER6_PUBLISH_PASS rows=3 history=3 ids=${[...ids].join(",")} modelsPreserved=true`
    );
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    await db.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => {
    console.error(
      "NCAAF_SEPTEMBER6_FAILED",
      error instanceof assert.AssertionError
        ? error.message
        : "Provider/database operation failed; credentials omitted"
    );
    process.exitCode = 1;
  });
