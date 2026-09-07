/**
 * Seed the NFL 2026 verified corpus into MySQL (nfl_venues / nfl_teams / nfl_games / nfl_players).
 * Idempotent: primary-key upserts (INSERT ... ON DUPLICATE KEY UPDATE); safe to re-run.
 *
 * Usage:
 *   pnpm exec tsx scripts/seedNfl2026.mts [--dry-run]
 *
 * Requires DATABASE_URL (schema must already be applied via db-push.yml).
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { games as feedGames } from "../drizzle/schema.js";
import {
  buildNflWeek1FeedRows,
  planNflWeek1Insertions,
} from "./nflWeek1Feed.js";
import {
  nflGames,
  nflPlayers,
  nflTeams,
  nflVenues,
} from "../drizzle/nfl.schema.js";
import { deriveKickoffDate } from "../shared/kickoffDate.js";
import { getDb } from "../server/db.js";

const TAG = "[SeedNfl2026]";
const DRY_RUN = process.argv.includes("--dry-run");
const DIR = join(dirname(fileURLToPath(import.meta.url)), "data", "nfl-2026");

const load = (f: string) => JSON.parse(readFileSync(join(DIR, f), "utf8"));
const chunk = <T,>(arr: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) =>
    arr.slice(i * n, (i + 1) * n)
  );

async function main() {
  const venues = load("venues.json");
  const teams = load("teams.json");
  const games = load("games.json");
  const players = load("players.json");
  const manifest = load("manifest.json");
  console.log(
    `${TAG}[INPUT] venues=${venues.length} teams=${teams.length} games=${games.length} players=${players.length}`
  );
  if (
    venues.length !== manifest.counts.venues ||
    teams.length !== manifest.counts.teams ||
    games.length !== manifest.counts.games ||
    players.length !== manifest.counts.players
  ) {
    throw new Error(
      `${TAG} seed files disagree with manifest — refusing to load`
    );
  }
  if (DRY_RUN) {
    if (process.argv.includes("--feed-week1"))
      console.log(JSON.stringify(buildNflWeek1FeedRows(games, teams, venues)));
    console.log(`${TAG}[STEP] dry-run: inputs validated, skipping DB writes`);
    return;
  }
  const db = await getDb();
  if (!db) throw new Error(`${TAG} DATABASE_URL not set — cannot seed`);

  if (process.argv.includes("--feed-week1")) {
    const rows = buildNflWeek1FeedRows(games, teams, venues);
    // Single writer: run through seed-nfl.yml's non-cancelling concurrency group.
    // Existing rows are verified, never overwritten (including scores/prices).
    await db.transaction(async tx => {
      const existing = await tx
        .select()
        .from(feedGames)
        .where(eq(feedGames.sport, "NFL"))
        .for("update");
      for (const row of planNflWeek1Insertions(rows, existing)) {
        await tx.insert(feedGames).values(row);
      }
      const verified = await tx
        .select()
        .from(feedGames)
        .where(eq(feedGames.sport, "NFL"));
      if (planNflWeek1Insertions(rows, verified).length)
        throw new Error("NFL Feed verification failed");
    });
    console.log(
      `${TAG}[OUTPUT] NFL Feed Week 1: 16 unique published games verified; existing prices/scores untouched`
    );
    return;
  }

  console.log(`${TAG}[STEP] upserting ${venues.length} venues`);
  for (const batch of chunk(venues, 200)) {
    await db
      .insert(nflVenues)
      .values(batch)
      .onDuplicateKeyUpdate({
        set: {
          name: sql`VALUES(name)`,
          city: sql`VALUES(city)`,
          state: sql`VALUES(state)`,
          country: sql`VALUES(country)`,
          capacity: sql`VALUES(capacity)`,
          indoor: sql`VALUES(indoor)`,
        },
      });
  }

  console.log(`${TAG}[STEP] upserting ${teams.length} teams`);
  for (const batch of chunk(teams, 200)) {
    await db
      .insert(nflTeams)
      .values(batch)
      .onDuplicateKeyUpdate({
        set: {
          displayName: sql`VALUES(display_name)`,
          abbreviation: sql`VALUES(abbreviation)`,
          conference: sql`VALUES(conference)`,
          division: sql`VALUES(division)`,
          venueId: sql`VALUES(venue_id)`,
          rosterCount: sql`VALUES(roster_count)`,
        },
      });
  }

  console.log(`${TAG}[STEP] upserting ${games.length} games`);
  const gameRows = games.map((g: any) => ({
    eventId: g.eventId,
    seasonType: g.seasonType,
    week: g.week,
    kickoffUtc: new Date(g.kickoffUtc),
    kickoffDate: deriveKickoffDate(g.kickoffUtc, g.timeValid),
    timeValid: g.timeValid,
    awayTeamName: g.awayTeam,
    homeTeamName: g.homeTeam,
    awayEspnId: g.awayEspnId,
    homeEspnId: g.homeEspnId,
    venueId: g.venueId,
    broadcast: g.broadcast,
    isTbd: g.isTbd,
    note: g.note,
  }));
  for (const batch of chunk(gameRows, 200)) {
    await db
      .insert(nflGames)
      .values(batch)
      .onDuplicateKeyUpdate({
        set: {
          seasonType: sql`VALUES(season_type)`,
          week: sql`VALUES(week)`,
          kickoffUtc: sql`VALUES(kickoff_utc)`,
          kickoffDate: sql`VALUES(kickoff_date)`,
          timeValid: sql`VALUES(time_valid)`,
          awayTeamName: sql`VALUES(away_team_name)`,
          homeTeamName: sql`VALUES(home_team_name)`,
          awayEspnId: sql`VALUES(away_espn_id)`,
          homeEspnId: sql`VALUES(home_espn_id)`,
          venueId: sql`VALUES(venue_id)`,
          broadcast: sql`VALUES(broadcast)`,
          isTbd: sql`VALUES(is_tbd)`,
          note: sql`VALUES(note)`,
        },
      });
  }

  console.log(`${TAG}[STEP] upserting ${players.length} players`);
  for (const batch of chunk(players, 500)) {
    await db
      .insert(nflPlayers)
      .values(batch)
      .onDuplicateKeyUpdate({
        set: {
          teamEspnId: sql`VALUES(team_espn_id)`,
          fullName: sql`VALUES(full_name)`,
          jersey: sql`VALUES(jersey)`,
          position: sql`VALUES(position)`,
          heightIn: sql`VALUES(height_in)`,
          weightLb: sql`VALUES(weight_lb)`,
          experience: sql`VALUES(experience)`,
          hometown: sql`VALUES(hometown)`,
        },
      });
  }

  console.log(`${TAG}[VERIFY] recounting rows`);
  const [vc] = await db.select({ n: sql<number>`count(*)` }).from(nflVenues);
  const [tc] = await db.select({ n: sql<number>`count(*)` }).from(nflTeams);
  const [gc] = await db.select({ n: sql<number>`count(*)` }).from(nflGames);
  const [pc] = await db.select({ n: sql<number>`count(*)` }).from(nflPlayers);
  console.log(
    `${TAG}[VERIFY] db counts: venues=${vc.n} teams=${tc.n} games=${gc.n} players=${pc.n}`
  );
  if (
    Number(vc.n) < manifest.counts.venues ||
    Number(tc.n) < manifest.counts.teams ||
    Number(gc.n) < manifest.counts.games ||
    Number(pc.n) < manifest.counts.players
  ) {
    throw new Error(`${TAG} post-load verification FAILED`);
  }
  console.log(`${TAG}[OUTPUT] seed complete and verified`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(`${TAG}[ERROR]`, err);
    process.exit(1);
  });
