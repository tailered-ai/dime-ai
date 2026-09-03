/** Publish the four PREZ-priced 2026-09-03 NCAAF games. No model logic lives here. */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { games, type InsertGame } from "../drizzle/schema.js";
import {
  forceInvalidateGamesCache,
  getDb,
  insertGames,
  listGamesByDate,
  updateBookOdds,
  updateGameProjections,
} from "../server/db.js";
import { scrapeVsinBettingSplits } from "../server/vsinBettingSplitsScraper.js";

const TAG = "[NCAAF-W1]";
const DATE = "2026-09-03";
const DRY_RUN = process.argv.includes("--dry-run");
const AN_URL = `https://api.actionnetwork.com/web/v2/scoreboard/ncaaf?bookIds=123&date=${DATE.replaceAll("-", "")}&periods=event`;

const SLATE = [
  {
    away: "MASS",
    home: "RUTG",
    awayName: "UMass Minutemen",
    homeName: "Rutgers Scarlet Knights",
    homeSlug: "rutgers-scarlet-knights",
    time: "18:00",
    eventId: 288785,
    bookSpread: -29,
    bookTotal: 53.5,
    modelSpread: -31.6,
    modelTotal: 53.6,
    awayScore: 11,
    homeScore: 42.6,
    awayMl: 10292,
    homeMl: -10292,
    awayWin: 0.96,
    homeWin: 99.04,
    awaySpreadOdds: 136,
    homeSpreadOdds: -136,
  },
  {
    away: "AKR",
    home: "WAKE",
    awayName: "Akron Zips",
    homeName: "Wake Forest Demon Deacons",
    homeSlug: "wake-forest-demon-deacons",
    time: "19:00",
    eventId: 288778,
    bookSpread: -27,
    bookTotal: 50.5,
    modelSpread: -29.6,
    modelTotal: 53.6,
    awayScore: 12,
    homeScore: 41.6,
    awayMl: 6958,
    homeMl: -6958,
    awayWin: 1.42,
    homeWin: 98.58,
    awaySpreadOdds: 136,
    homeSpreadOdds: -136,
  },
  {
    away: "COLO",
    home: "GT",
    awayName: "Colorado Buffaloes",
    homeName: "Georgia Tech Yellow Jackets",
    homeSlug: "georgia-tech-yellow-jackets",
    time: "20:00",
    eventId: 288782,
    bookSpread: -6.5,
    bookTotal: 51.5,
    modelSpread: -5.59,
    modelTotal: 56.9,
    awayScore: 26.15,
    homeScore: 30.75,
    awayMl: 195,
    homeMl: -195,
    awayWin: 33.94,
    homeWin: 66.06,
    awaySpreadOdds: -111,
    homeSpreadOdds: 111,
  },
  {
    away: "UAB",
    home: "ILL",
    awayName: "UAB Blazers",
    homeName: "Illinois Fighting Illini",
    homeSlug: "illinois-fighting-illini",
    time: "21:00",
    eventId: 288856,
    bookSpread: -27.5,
    bookTotal: 54.5,
    modelSpread: -30.1,
    modelTotal: 53.6,
    awayScore: 11.75,
    homeScore: 41.85,
    awayMl: 7660,
    homeMl: -7660,
    awayWin: 1.29,
    homeWin: 98.71,
    awaySpreadOdds: 136,
    homeSpreadOdds: -136,
  },
] as const;

type Side = { side: string; value?: number; odds?: number };
type AnGame = {
  id: number;
  teams: Array<{ full_name: string }>;
  markets: Record<
    string,
    { event?: { spread?: Side[]; total?: Side[]; moneyline?: Side[] } }
  >;
};
const side = (rows: Side[] | undefined, name: string) =>
  rows?.find(row => row.side === name);
const odds = (value: number | undefined) =>
  value == null ? null : String(value > 0 ? `+${value}` : value);

async function sources() {
  const [response, vsin] = await Promise.all([
    fetch(AN_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json",
        Referer: "https://www.actionnetwork.com/",
        Origin: "https://www.actionnetwork.com",
      },
      signal: AbortSignal.timeout(20_000),
    }),
    scrapeVsinBettingSplits("today", "CFB"),
  ]);
  if (!response.ok) throw new Error(`${TAG}[AN] HTTP ${response.status}`);
  const raw = (await response.json()) as { games?: AnGame[] };
  const an = new Map((raw.games ?? []).map(game => [game.id, game]));
  const rows = SLATE.map(game => {
    const event = an.get(game.eventId);
    if (
      !event ||
      !event.teams.some(team => team.full_name === game.awayName) ||
      !event.teams.some(team => team.full_name === game.homeName)
    ) {
      throw new Error(
        `${TAG}[AN] missing exact event ${game.awayName} @ ${game.homeName}`
      );
    }
    const market = event.markets["123"]?.event;
    const homeSpread = side(market?.spread, "home");
    const awaySpread = side(market?.spread, "away");
    const over = side(market?.total, "over");
    const under = side(market?.total, "under");
    const homeMl = side(market?.moneyline, "home");
    const awayMl = side(market?.moneyline, "away");
    if (
      homeSpread?.value !== game.bookSpread ||
      over?.value !== game.bookTotal
    ) {
      throw new Error(
        `${TAG}[AN] market moved for ${game.away}@${game.home}; rerun private pricing before publish`
      );
    }
    const splits = vsin.find(row => row.homeVsinSlug === game.homeSlug);
    if (!splits)
      throw new Error(`${TAG}[VSIN] missing ${game.away}@${game.home}`);
    return {
      game,
      homeSpread,
      awaySpread,
      over,
      under,
      homeMl,
      awayMl,
      splits,
    };
  });
  if (rows.length !== 4)
    throw new Error(`${TAG}[GATE] expected four source-complete games`);
  return rows;
}

async function main() {
  const started = Date.now();
  console.log(`${TAG}[START] date=${DATE} dryRun=${DRY_RUN}`);
  const rows = await sources();
  console.log(
    `${TAG}[SOURCES] Action Network=4 VSiN=4 elapsedMs=${Date.now() - started}`
  );
  if (DRY_RUN) {
    for (const { game, splits } of rows)
      console.log(
        `${TAG}[DRY] ${game.away}@${game.home} model=${game.home} ${game.modelSpread} total=${game.modelTotal} vsinSpreadAway=${splits.spreadAwayBetsPct}/${splits.spreadAwayMoneyPct}`
      );
    return;
  }
  const db = await getDb();
  if (!db) throw new Error(`${TAG}[DB] DATABASE_URL is unavailable`);
  const byMatchup = new Map(
    (await listGamesByDate(DATE, "NCAAF")).map(row => [
      `${row.awayTeam}@${row.homeTeam}`,
      row,
    ])
  );
  for (let index = 0; index < rows.length; index++) {
    const {
      game,
      homeSpread,
      awaySpread,
      over,
      under,
      homeMl,
      awayMl,
      splits,
    } = rows[index]!;
    let id = byMatchup.get(`${game.away}@${game.home}`)?.id;
    if (!id) {
      const insert: InsertGame = {
        fileId: 0,
        gameDate: DATE,
        startTimeEst: game.time,
        awayTeam: game.away,
        homeTeam: game.home,
        sport: "NCAAF",
        gameType: "regular_season",
        ncaaContestId: String(game.eventId),
        sortOrder: index,
        publishedToFeed: true,
        publishedModel: true,
        awayBookSpread: String(awaySpread!.value),
        homeBookSpread: String(homeSpread!.value),
        bookTotal: String(over!.value),
        awayML: odds(awayMl?.odds),
        homeML: odds(homeMl?.odds),
        awaySpreadOdds: odds(awaySpread?.odds),
        homeSpreadOdds: odds(homeSpread?.odds),
        overOdds: odds(over?.odds),
        underOdds: odds(under?.odds),
      };
      await insertGames([insert]);
      id = (await listGamesByDate(DATE, "NCAAF")).find(
        row => row.awayTeam === game.away && row.homeTeam === game.home
      )?.id;
    }
    if (!id)
      throw new Error(`${TAG}[DB] failed to resolve ${game.away}@${game.home}`);
    await updateBookOdds(id, {
      awayBookSpread: awaySpread!.value!,
      homeBookSpread: homeSpread!.value!,
      bookTotal: over!.value!,
      startTimeEst: game.time,
      awayML: odds(awayMl?.odds),
      homeML: odds(homeMl?.odds),
      awaySpreadOdds: odds(awaySpread?.odds),
      homeSpreadOdds: odds(homeSpread?.odds),
      overOdds: odds(over?.odds),
      underOdds: odds(under?.odds),
      spreadAwayBetsPct: splits.spreadAwayBetsPct,
      spreadAwayMoneyPct: splits.spreadAwayMoneyPct,
      totalOverBetsPct: splits.totalOverBetsPct,
      totalOverMoneyPct: splits.totalOverMoneyPct,
      mlAwayBetsPct: splits.mlAwayBetsPct,
      mlAwayMoneyPct: splits.mlAwayMoneyPct,
    });
    await updateGameProjections(id, {
      awayModelSpread: String(-game.modelSpread),
      homeModelSpread: String(game.modelSpread),
      modelTotal: String(game.modelTotal),
      modelAwayScore: String(game.awayScore),
      modelHomeScore: String(game.homeScore),
      modelAwayML: odds(game.awayMl),
      modelHomeML: odds(game.homeMl),
      modelAwayWinPct: String(game.awayWin),
      modelHomeWinPct: String(game.homeWin),
      modelAwaySpreadOdds: odds(game.awaySpreadOdds),
      modelHomeSpreadOdds: odds(game.homeSpreadOdds),
      modelOverOdds: null,
      modelUnderOdds: null,
      spreadEdge: null,
      totalEdge: null,
      spreadDiff: String(game.modelSpread - game.bookSpread),
      totalDiff: String(game.modelTotal - game.bookTotal),
      modelRunAt: Date.now(),
    });
    await db
      .update(games)
      .set({ publishedToFeed: true, publishedModel: true })
      .where(eq(games.id, id));
    console.log(`${TAG}[WRITE] ${game.away}@${game.home} id=${id}`);
  }
  forceInvalidateGamesCache();
  const verified = (await listGamesByDate(DATE, "NCAAF")).filter(row =>
    SLATE.some(game => row.awayTeam === game.away && row.homeTeam === game.home)
  );
  const complete = verified.filter(
    row =>
      row.publishedToFeed &&
      row.publishedModel &&
      row.modelRunAt &&
      row.awayModelSpread &&
      row.modelTotal
  );
  if (verified.length !== 4 || complete.length !== 4)
    throw new Error(
      `${TAG}[VERIFY] exactRows=${verified.length} complete=${complete.length}`
    );
  console.log(
    `${TAG}[PASS] exactRows=4 modelComplete=4 elapsedMs=${Date.now() - started}`
  );
}

main().catch(error => {
  console.error(`${TAG}[FAIL]`, error);
  process.exitCode = 1;
});
