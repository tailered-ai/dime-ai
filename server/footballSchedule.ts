import { createHash } from "node:crypto";
import type { InsertGame } from "../drizzle/schema";
import type { FootballSport } from "../shared/footballMarkets";
import cfbTeams from "../scripts/data/cfb-2026/teams.json";
import nflTeams from "../scripts/data/nfl-2026/teams.json";
import extraCfbTeams from "../shared/ncaafFeedTeams.json";
import { parseFootballScoreboard } from "./ncaafScoreRefresh";

/** The score adapter supplies schedule identities too. Never consume its book odds. */
export async function fetchFootballSchedule(
  sport: FootballSport,
  dates: string,
  season: number,
  signal?: AbortSignal
) {
  if (!/^\d{8}(?:-\d{8})?$/.test(dates) || !Number.isInteger(season))
    throw new Error("Invalid football schedule window");
  const league = sport === "NFL" ? "nfl" : "college-football";
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/${league}/scoreboard?dates=${dates}${sport === "NCAAF" ? "&groups=80" : ""}&limit=1000`;
  signal?.throwIfAborted();
  const response = await fetch(url, {
    signal: AbortSignal.any([
      AbortSignal.timeout(20_000),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!response.ok)
    throw new Error(`Football schedule HTTP ${response.status}`);
  const body = await response.text();
  signal?.throwIfAborted();
  const raw = JSON.parse(body);
  if (
    !Array.isArray(raw.leagues) ||
    raw.leagues.length !== 1 ||
    raw.leagues[0]?.slug !== league ||
    !Array.isArray(raw.events) ||
    raw.events.length >= 1000 ||
    new Set(raw.events.map((g: { id: string }) => g.id)).size !==
      raw.events.length
  )
    throw new Error(
      "Unverified, duplicate or potentially truncated football schedule"
    );
  const receivedAt = Date.now(),
    revision = createHash("sha256").update(body).digest("hex");
  const teams =
    sport === "NFL"
      ? nflTeams.map(t => ({
          id: t.espnId,
          abbr: t.abbreviation,
          name: t.displayName,
        }))
      : [
          ...cfbTeams.map(t => ({
            id: t.espnId,
            abbr: t.espnAbbreviation,
            name: t.espnDisplayName,
          })),
          ...Object.entries(extraCfbTeams)
            .filter(([, t]) => !cfbTeams.some(c => c.espnId === t.espnId))
            .map(([abbr, t]) => ({ id: t.espnId, abbr, name: t.name })),
        ];
  const parsed = parseFootballScoreboard(raw);
  // The old fixed-slate catalog is not a season roster: retain verified FCS opponents too.
  for (const event of parsed) {
    if (event.season?.year !== season || ![2, 3].includes(event.season.type))
      continue;
    for (const side of ["away", "home"] as const) {
      const id = event[`${side}EspnId`],
        abbr = event[`${side}Team`],
        name = event[`${side}Name`];
      if (
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        !name ||
        !/^[A-Z0-9&-]{1,12}$/.test(abbr)
      )
        continue;
      const known = teams.find(team => team.id === id);
      if (
        (known && (known.abbr !== abbr || known.name !== name)) ||
        teams.some(team => team.abbr === abbr && team.id !== id)
      )
        throw new Error(`Contradictory football schedule team identity: ${id}`);
      if (!known) teams.push({ id, abbr, name });
    }
  }
  const rows: InsertGame[] = [],
    unresolved: string[] = raw.events
      .filter((g: { id: string }) => !parsed.some(p => p.id === g.id))
      .map((g: { id: string }) => g.id);
  for (const event of parsed) {
    if (event.season?.year !== season || ![2, 3].includes(event.season.type))
      continue;
    const away = teams.filter(t => t.id === event.awayEspnId),
      home = teams.filter(t => t.id === event.homeEspnId);
    if (
      away.length !== 1 ||
      home.length !== 1 ||
      away[0].name !== event.awayName ||
      home[0].name !== event.homeName
    ) {
      unresolved.push(event.id);
      continue;
    }
    const scheduleKey = `espn:${sport.toLowerCase()}:${season}:${event.id}`;
    rows.push({
      fileId: 0,
      sport,
      gameDate: event.gameDate,
      startTimeEst: event.startTimeEst,
      awayTeam: away[0].abbr,
      homeTeam: home[0].abbr,
      gameStatus: event.gameStatus,
      publishedToFeed: true,
      publishedModel: false,
      footballScheduleId: scheduleKey,
      footballBinding: {
        scheduleKey,
        scheduleRevision: revision,
        seasonType: event.season.type,
        kickoff: event.kickoff,
        awayTeam: away[0].abbr,
        homeTeam: home[0].abbr,
        awayEspnId: event.awayEspnId,
        homeEspnId: event.homeEspnId,
        awayName: event.awayName!,
        homeName: event.homeName!,
        scheduleSourceUrl: url,
        scheduleReceivedAt: receivedAt,
      },
    });
  }
  return {
    rows,
    unresolved,
    sourceUrl: url,
    receivedAt,
    responseSha256: revision,
  };
}
