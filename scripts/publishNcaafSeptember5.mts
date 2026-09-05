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

// AN event/side IDs pinned to evidence/an/normalized.json captured 2026-09-05T16:27:07.498Z.
// Lifecycle reads use the same public source; odds and splits below remain the approved snapshot.
const AN_TEAMS: Record<string, readonly [number, number]> = {
  "288805": [447, 319], // BRY at ARMY
  "288800": [415, 288], // CC at WVU
  "288815": [274, 362], // ECU at BAMA
  "288884": [466, 267], // LAF at UCONN
  "288857": [401, 404], // LIB at JMU
  "288877": [413, 260], // NH at SYR
  "288819": [314, 294], // UNT at IU
  "288840": [324, 303], // OHIO at NEB
  "288820": [354, 277], // ORST at HOU
  "288851": [582, 320], // TAR at BGSU
  "288880": [332, 295], // BALL at OSU
  "288868": [327, 268], // M-OH at PITT
  "288878": [326, 368], // KENT at SC
  "288823": [448, 336], // DUQ at AFA
  "288879": [457, 285], // SEM at ISU
  "288872": [440, 372], // YSU at UK
  "288885": [405, 276], // URI at TEM
  "288824": [460, 366], // TNST at UGA
  "287969": [282, 364], // BAY at AUB
  "288874": [338, 357], // BOISE at ORE
  "288795": [259, 270], // BC at CIN
  "288854": [489, 371], // FUR at TENN
  "288852": [402, 382], // ME at APP
  "288842": [310, 292], // MRSH at PSU
  "288859": [374, 287], // TXST at TEX
  "288832": [482, 306], // CIT at CHA
  "288814": [410, 278], // TOW at NAVY
  "288807": [468, 436], // FOR at NDSU
  "288875": [281, 265], // TULN at DUKE
  "288812": [6035, 317], // UTRGV at UTSA
  "288841": [286, 272], // OKST at TLSA
  "288858": [566, 361], // UNA at ARK
  "288867": [333, 299], // NIU at IOWA
  "288833": [503, 315], // ALCST at USM
  "288829": [432, 308], // NORF at ODU
  "288802": [344, 340], // WYO at CSU
  "288806": [498, 290], // ACU at TTU
  "288811": [381, 280], // ARST at MEM
  "288843": [454, 367], // APSU at VAN
  "288822": [400, 375], // CCH at GASO
  "288853": [453, 455], // EKU at JVST
  "288876": [313, 273], // FIU at USF
  "288818": [497, 318], // HB at RICE
  "288873": [387, 335], // IDS at USU
  "288838": [435, 358], // MOST at TA&M
  "288882": [458, 307], // MUR at MTSU
  "288881": [488, 291], // NIC at KSU
  "288883": [496, 376], // SEL at USA
  "288808": [493, 383], // SHSU at TROY
  "287971": [261, 365], // CLEM at LSU
  "288869": [494, 309], // NWS at LT
  "288827": [379, 359], // ULM at MSST
  "288871": [483, 256], // VMI at VT
  "288825": [334, 305], // WMU at MICH
  "288803": [311, 370], // FAU at FLA
  "288862": [430, 297], // HAMP at UMD
  "288855": [486, 378], // LAM at UL
  "288866": [438, 301], // SDKSU at NW
  "288844": [554, 322], // UTU at BYU
  "288796": [643, 369], // MHU at NMSU
  "288834": [392, 353], // NAZ at ARI
  "288804": [399, 343], // PRST at SDSU
  "288850": [329, 339], // CMU at UNM
  "288848": [505, 391], // MVS at SAC
  "288886": [424, 349], // MGN at ASU
  "288799": [341, 345], // UNLV at HAW
  "287970": [350, 348], // UCLA at CAL
  "288810": [312, 346], // WKU at NEV
};
type Lifecycle = {
  gameStatus: "upcoming" | "live" | "final" | "postponed" | "suspended";
  awayScore: number | null;
  homeScore: number | null;
  gameClock: string | null;
};
function object(value: unknown): Record<string, unknown> {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Malformed AN lifecycle response"
  );
  return value as Record<string, unknown>;
}
function parseLifecycle(payload: unknown) {
  const raw = object(payload);
  assert.equal(object(raw.league).name, "ncaaf", "Lifecycle league mismatch");
  assert(Array.isArray(raw.games), "Lifecycle games missing");
  const rows: Record<string, unknown>[] = raw.games.map(object);
  const statusMap: Record<string, Lifecycle["gameStatus"]> = {
    scheduled: "upcoming",
    inprogress: "live",
    in_progress: "live",
    complete: "final",
    postponed: "postponed",
    suspended: "suspended",
    // The storage enum represents a provider-reported delay as a paused game.
    delayed: "suspended",
  };
  const result = new Map<string, Lifecycle>();
  for (const game of selected) {
    const found: Record<string, unknown>[] = rows.filter(
      row => String(row.id) === game.event
    );
    assert.equal(found.length, 1, "Lifecycle event missing or duplicated");
    const row = found[0];
    assert.equal(row.league_name, "ncaaf", "Lifecycle event league mismatch");
    assert(
      typeof row.start_time === "string" &&
        Number.isFinite(Date.parse(row.start_time)),
      "Lifecycle start time missing"
    );
    assert.equal(
      new Date(row.start_time).toLocaleDateString("en-CA", {
        timeZone: "America/New_York",
      }),
      DATE,
      "Lifecycle event date mismatch"
    );
    const [awayId, homeId] = AN_TEAMS[game.event];
    assert(
      row.away_team_id === awayId && row.home_team_id === homeId,
      "Lifecycle team orientation mismatch"
    );
    assert(Array.isArray(row.teams), "Lifecycle teams missing");
    assert.deepEqual(
      row.teams.map((team: unknown) => object(team).id).sort(),
      [awayId, homeId].sort(),
      "Lifecycle team identities mismatch"
    );
    assert(
      typeof row.status === "string" && Object.hasOwn(statusMap, row.status),
      "Unsupported AN lifecycle status"
    );
    const box = row.boxscore == null ? {} : object(row.boxscore);
    const score = (value: unknown) => {
      if (value == null) return null;
      assert(
        typeof value === "number" && Number.isInteger(value) && value >= 0,
        "Invalid AN score"
      );
      return value;
    };
    assert(
      row.status_display == null ||
        (typeof row.status_display === "string" &&
          row.status_display.length <= 32),
      "Invalid AN status display"
    );
    result.set(game.event, {
      gameStatus: statusMap[row.status],
      awayScore: score(box.total_away_points),
      homeScore: score(box.total_home_points),
      gameClock:
        row.status === "scheduled"
          ? null
          : ((row.status_display as string | null) ?? null),
    });
  }
  return result;
}
async function readCurrentLifecycle() {
  const response = await fetch(
    `https://api.actionnetwork.com/web/v2/scoreboard/ncaaf?bookIds=68&date=${DATE.replaceAll("-", "")}&periods=event`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.actionnetwork.com/",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    }
  );
  assert(response.ok, "AN lifecycle request failed; refusing publication");
  const result = parseLifecycle(await response.json());
  console.log(
    `NCAAF_SEPTEMBER5_LIFECYCLE_READ_PASS events=${result.size} capturedAt=${new Date().toISOString()}`
  );
  return result;
}
function checkLifecycle() {
  assert.deepEqual(
    Object.keys(AN_TEAMS).sort(),
    selected.map(game => game.event).sort()
  );
  const fixture = {
    league: { name: "ncaaf" },
    games: selected.map(game => ({
      id: Number(game.event),
      league_name: "ncaaf",
      start_time: game.schedule.startTime,
      away_team_id: AN_TEAMS[game.event][0],
      home_team_id: AN_TEAMS[game.event][1],
      teams: AN_TEAMS[game.event].map(id => ({ id })),
      status: "scheduled",
      status_display: null,
      boxscore: null as Record<string, unknown> | null,
    })),
  };
  const first = fixture.games[0];
  assert.deepEqual(parseLifecycle(fixture).get(selected[0].event), {
    gameStatus: "upcoming",
    awayScore: null,
    homeScore: null,
    gameClock: null,
  });
  const live = {
    ...first,
    status: "inprogress",
    status_display: "2nd 7:36",
    boxscore: { total_away_points: 0, total_home_points: 14 },
  };
  const withFirst = (row: Record<string, unknown>) => ({
    ...fixture,
    games: [row, ...fixture.games.slice(1)],
  });
  assert.deepEqual(parseLifecycle(withFirst(live)).get(selected[0].event), {
    gameStatus: "live",
    awayScore: 0,
    homeScore: 14,
    gameClock: "2nd 7:36",
  });
  assert.equal(
    parseLifecycle(
      withFirst({ ...live, status: "complete", status_display: "Final" })
    ).get(selected[0].event)?.gameStatus,
    "final"
  );
  assert.deepEqual(
    parseLifecycle(
      withFirst({ ...live, status: "delayed", status_display: "Del 1st" })
    ).get(selected[0].event),
    {
      gameStatus: "suspended",
      awayScore: 0,
      homeScore: 14,
      gameClock: "Del 1st",
    }
  );
  for (const wrong of [
    { away_team_id: first.home_team_id, home_team_id: first.away_team_id },
    { start_time: "2026-09-04T16:00:00Z" },
    { league_name: "nfl" },
    { status: "unknown" },
    { boxscore: { total_away_points: -1 } },
  ])
    assert.throws(() => parseLifecycle(withFirst({ ...first, ...wrong })));
  assert.throws(() =>
    parseLifecycle({ ...fixture, games: fixture.games.slice(1) })
  );
  assert.throws(() =>
    parseLifecycle({ ...fixture, games: [...fixture.games, first] })
  );
}

async function main() {
  const modes = ["--check", "--dry-run", "--publish", "--verify"];
  const args = process.argv.slice(2);
  assert(
    args.length === 1 && modes.includes(args[0]),
    "Choose exactly one mode: --check, --dry-run, --publish, or --verify"
  );
  checkPayload();
  checkLifecycle();
  const mode = args[0];
  if (mode === "--check") {
    console.log(
      "NCAAF_SEPTEMBER5_PAYLOAD_CHECK_PASS selectedRows=68 modelRows=68 historySnapshots=1885"
    );
    return;
  }
  assert(process.env.DATABASE_URL, "DATABASE_URL unavailable");
  // One current source read before any DB transaction; failure cannot partially publish.
  const lifecycle = mode === "--verify" ? null : await readCurrentLifecycle();
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
            ...lifecycle!.get(game.event)!,
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
        } else verify(row, lifecycle!.get(game.event)!);
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
      const status =
        existing[i]?.gameStatus ?? lifecycle!.get(game.event)!.gameStatus;
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
