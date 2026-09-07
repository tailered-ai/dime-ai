import type games from "./data/nfl-2026/games.json";
import type teams from "./data/nfl-2026/teams.json";
import type venues from "./data/nfl-2026/venues.json";

/** Map the verified ESPN corpus to the existing Feed schema, without pricing. */
export function buildNflWeek1FeedRows(
  source: typeof games,
  teamRows: typeof teams,
  venueRows: typeof venues
) {
  const week = source
    .filter(g => g.seasonType === 2 && g.week === 1)
    .sort(
      (a, b) =>
        a.kickoffUtc.localeCompare(b.kickoffUtc) || a.eventId - b.eventId
    );
  if (
    week.length !== 16 ||
    new Set(week.map(g => g.eventId)).size !== 16 ||
    new Set(week.flatMap(g => [g.awayEspnId, g.homeEspnId])).size !== 32
  ) {
    throw new Error(
      "NFL Week 1 must contain 16 unique games and 32 unique teams"
    );
  }
  const easternDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const easternTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return week.map((g, sortOrder) => {
    const away = teamRows.filter(t => t.espnId === g.awayEspnId);
    const home = teamRows.filter(t => t.espnId === g.homeEspnId);
    const venue = venueRows.filter(v => v.venueId === g.venueId);
    const kickoff = new Date(g.kickoffUtc);
    if (
      !g.timeValid ||
      g.isTbd ||
      !Number.isFinite(kickoff.getTime()) ||
      kickoff.getUTCFullYear() !== 2026 ||
      away.length !== 1 ||
      home.length !== 1 ||
      venue.length !== 1 ||
      away[0].displayName !== g.awayTeam ||
      home[0].displayName !== g.homeTeam
    ) {
      throw new Error(
        `Unverified NFL Week 1 identity/time/venue: ${g.eventId}`
      );
    }
    return {
      fileId: 0,
      sport: "NFL",
      gameDate: easternDate.format(kickoff),
      startTimeEst: easternTime.format(kickoff),
      awayTeam: away[0].abbreviation,
      homeTeam: home[0].abbreviation,
      venue: venue[0].name,
      broadcaster: g.broadcast,
      gameType: "regular_season" as const,
      gameStatus: "upcoming" as const,
      publishedToFeed: true,
      publishedModel: false,
      sortOrder,
      ingestionPipelineRevision: "nfl-2026-week1-feed-v1",
      ingestionRunId: `espn:nfl:2026:2:1:${g.eventId}`,
    };
  });
}

type FeedRow = ReturnType<typeof buildNflWeek1FeedRows>[number];
type ExistingIdentity = Pick<
  FeedRow,
  "gameDate" | "awayTeam" | "homeTeam" | "startTimeEst"
> & {
  ingestionRunId: string | null;
  venue: string | null;
  publishedToFeed: boolean | null;
};

/** A replay is read-only. Any conflicting existing identity blocks the batch. */
export function planNflWeek1Insertions(
  rows: FeedRow[],
  existing: ExistingIdentity[]
): FeedRow[] {
  return rows.filter(row => {
    const matches = existing.filter(
      g =>
        g.ingestionRunId === row.ingestionRunId ||
        (g.gameDate === row.gameDate &&
          g.awayTeam === row.awayTeam &&
          g.homeTeam === row.homeTeam)
    );
    if (matches.length > 1)
      throw new Error(`Duplicate NFL identity: ${row.ingestionRunId}`);
    if (!matches.length) return true;
    const match = matches[0];
    if (
      !match.publishedToFeed ||
      match.gameDate !== row.gameDate ||
      match.awayTeam !== row.awayTeam ||
      match.homeTeam !== row.homeTeam ||
      match.startTimeEst !== row.startTimeEst ||
      match.venue !== row.venue
    ) {
      throw new Error(
        `Existing NFL row conflicts with schedule: ${row.ingestionRunId}`
      );
    }
    return false;
  });
}
