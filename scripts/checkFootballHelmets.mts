import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fetchFootballSchedule } from "../server/footballSchedule";
import {
  footballHelmet,
  footballRefreshDates,
} from "../shared/footballMarkets";

// Read-only rolling inventory: reuses the same schedule identities/window as ingestion.
const { values } = parseArgs({
  options: { date: { type: "string" }, out: { type: "string" } },
});
if (
  values.date &&
  (!/^\d{4}-\d{2}-\d{2}$/.test(values.date) ||
    new Date(`${values.date}T12:00Z`).toISOString().slice(0, 10) !==
      values.date)
)
  throw new Error("Expected a real YYYY-MM-DD date");
const dates = footballRefreshDates(
  values.date ? new Date(`${values.date}T12:00Z`) : new Date()
);
const season =
  Number(dates[0].slice(0, 4)) - (Number(dates[0].slice(5, 7)) < 3 ? 1 : 0);
const leagues = [];
for (const sport of ["NCAAF", "NFL"] as const) {
  const schedule = await fetchFootballSchedule(
    sport,
    `${dates[0].replaceAll("-", "")}-${dates.at(-1)!.replaceAll("-", "")}`,
    season
  );
  const teams = new Map<
    string,
    { id: number; name: string; games: string[] }
  >();
  for (const game of schedule.rows) {
    if (!dates.includes(game.gameDate)) continue;
    for (const side of ["away", "home"] as const) {
      const code = game[`${side}Team`],
        binding = game.footballBinding!;
      const team = teams.get(code) ?? {
        id: binding[`${side}EspnId`]!,
        name: binding[`${side}Name`]!,
        games: [],
      };
      team.games.push(binding.scheduleKey);
      teams.set(code, team);
    }
  }
  const assets = [...teams]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, team]) => {
      const path = footballHelmet(sport, code);
      let sha256: string | null = null;
      if (path?.startsWith(`/brand/${sport.toLowerCase()}-helmets/`)) {
        try {
          sha256 = createHash("sha256")
            .update(
              readFileSync(new URL(`../client/public${path}`, import.meta.url))
            )
            .digest("hex");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return {
        code,
        ...team,
        path,
        sha256,
        status: sha256 ? "helmet" : "missing",
      };
    });
  leagues.push({
    sport,
    sourceUrl: schedule.sourceUrl,
    receivedAt: schedule.receivedAt,
    responseSha256: schedule.responseSha256,
    gameCount: schedule.rows.filter(game => dates.includes(game.gameDate))
      .length,
    unresolved: schedule.unresolved,
    teams: assets,
  });
}
const report = { window: dates, noLogoFallbacks: true, leagues };
if (values.out)
  writeFileSync(values.out, JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
  });
console.log(JSON.stringify(report, null, 2));
if (
  leagues.some(
    league =>
      league.unresolved.length ||
      league.teams.some(team => team.status !== "helmet")
  )
)
  process.exitCode = 1;
