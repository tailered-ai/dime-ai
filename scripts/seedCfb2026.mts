/**
 * Seed the CFB 2026 verified corpus into MySQL (cfb_teams / cfb_games / cfb_players).
 * Idempotent: primary-key upserts (INSERT ... ON DUPLICATE KEY UPDATE); safe to re-run.
 *
 * Usage:
 *   pnpm exec tsx scripts/seedCfb2026.mts [--dry-run]
 *
 * Requires DATABASE_URL (schema must already be applied via db-push.yml).
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { cfbGames, cfbPlayers, cfbTeams } from "../drizzle/cfb.schema.js";
import { etKickoffToUtc } from "../shared/cfbKickoff.js";
import { getDb, reconcileFootballSchedule } from "../server/db.js";
import { fetchFootballSchedule } from "../server/footballSchedule.js";

const TAG = "[SeedCfb2026]";
const DRY_RUN = process.argv.includes("--dry-run");
const DIR = join(dirname(fileURLToPath(import.meta.url)), "data", "cfb-2026");

const load = (f: string) => JSON.parse(readFileSync(join(DIR, f), "utf8"));
const chunk = <T,>(arr: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) =>
    arr.slice(i * n, (i + 1) * n)
  );

async function main() {
  if (process.argv.includes("--feed-season")) {
    const season = Number(
      process.argv.find(arg => arg.startsWith("--season="))?.split("=")[1] ??
        2026
    );
    const schedule = await fetchFootballSchedule(
      "NCAAF",
      `${season}0801-${season + 1}0220`,
      season
    );
    console.log(
      JSON.stringify({
        sourceUrl: schedule.sourceUrl,
        responseSha256: schedule.responseSha256,
        rows: schedule.rows.length,
        unresolved: schedule.unresolved,
      })
    );
    if (!DRY_RUN)
      console.log(await reconcileFootballSchedule("NCAAF", schedule.rows));
    return;
  }
  const teams = load("teams.json");
  const games = load("games.json");
  const players = load("players.json");
  const manifest = load("manifest.json");
  console.log(
    `${TAG}[INPUT] teams=${teams.length} games=${games.length} players=${players.length}`
  );
  if (
    teams.length !== manifest.counts.teams ||
    games.length !== manifest.counts.games ||
    players.length !== manifest.counts.players
  ) {
    throw new Error(
      `${TAG} seed files disagree with manifest — refusing to load`
    );
  }
  if (DRY_RUN) {
    console.log(`${TAG}[STEP] dry-run: inputs validated, skipping DB writes`);
    return;
  }
  const db = await getDb();
  if (!db) throw new Error(`${TAG} DATABASE_URL not set — cannot seed`);

  console.log(`${TAG}[STEP] upserting ${teams.length} teams`);
  for (const batch of chunk(teams, 200)) {
    await db
      .insert(cfbTeams)
      .values(batch)
      .onDuplicateKeyUpdate({
        set: {
          espnDisplayName: sql`VALUES(espn_display_name)`,
          espnAbbreviation: sql`VALUES(espn_abbreviation)`,
          fbschedulesName: sql`VALUES(fbschedules_name)`,
          fbschedulesSlug: sql`VALUES(fbschedules_slug)`,
          conference: sql`VALUES(conference)`,
          division: sql`VALUES(division)`,
          espnGroupId: sql`VALUES(espn_group_id)`,
          rosterCount: sql`VALUES(roster_count)`,
        },
      });
  }

  console.log(`${TAG}[STEP] upserting ${games.length} games`);
  const gameRows = games.map((g: any) => ({
    gameId: g.gameId,
    week: g.week,
    kickoffDate: g.dateIso,
    kickoffTimeEt: g.timeEt,
    kickoffUtc: etKickoffToUtc(g.dateIso, g.timeEt),
    awayTeamName: g.awayTeam,
    homeTeamName: g.homeTeam,
    awayEspnId: g.awayEspnId,
    homeEspnId: g.homeEspnId,
    tv: g.tv,
    isPlaceholder: g.isPlaceholder,
    isFlex: g.isFlex,
    note: g.note,
  }));
  for (const batch of chunk(gameRows, 200)) {
    await db
      .insert(cfbGames)
      .values(batch)
      .onDuplicateKeyUpdate({
        set: {
          week: sql`VALUES(week)`,
          kickoffDate: sql`VALUES(kickoff_date)`,
          kickoffTimeEt: sql`VALUES(kickoff_time_et)`,
          kickoffUtc: sql`VALUES(kickoff_utc)`,
          awayTeamName: sql`VALUES(away_team_name)`,
          homeTeamName: sql`VALUES(home_team_name)`,
          awayEspnId: sql`VALUES(away_espn_id)`,
          homeEspnId: sql`VALUES(home_espn_id)`,
          tv: sql`VALUES(tv)`,
          isPlaceholder: sql`VALUES(is_placeholder)`,
          isFlex: sql`VALUES(is_flex)`,
          note: sql`VALUES(note)`,
        },
      });
  }

  console.log(`${TAG}[STEP] upserting ${players.length} players`);
  for (const batch of chunk(players, 500)) {
    await db
      .insert(cfbPlayers)
      .values(batch)
      .onDuplicateKeyUpdate({
        set: {
          teamEspnId: sql`VALUES(team_espn_id)`,
          fullName: sql`VALUES(full_name)`,
          jersey: sql`VALUES(jersey)`,
          position: sql`VALUES(position)`,
          heightIn: sql`VALUES(height_in)`,
          weightLb: sql`VALUES(weight_lb)`,
          classYear: sql`VALUES(class_year)`,
          hometown: sql`VALUES(hometown)`,
        },
      });
  }

  console.log(`${TAG}[VERIFY] recounting rows`);
  const [tc] = await db.select({ n: sql<number>`count(*)` }).from(cfbTeams);
  const [gc] = await db.select({ n: sql<number>`count(*)` }).from(cfbGames);
  const [pc] = await db.select({ n: sql<number>`count(*)` }).from(cfbPlayers);
  console.log(
    `${TAG}[VERIFY] db counts: teams=${tc.n} games=${gc.n} players=${pc.n}`
  );
  if (Number(tc.n) < 138 || Number(gc.n) < 902 || Number(pc.n) < 14933) {
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
