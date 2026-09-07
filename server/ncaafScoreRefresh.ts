import { z } from "zod";
import { listGamesByDate, updateNcaaStartTime } from "./db";
import { isStatusRegression } from "./mlbEventIdentity";
import type { FootballSport } from "../shared/footballMarkets";

const ZONE = "America/New_York";
const easternDate = (date: Date) =>
  date.toLocaleDateString("en-CA", { timeZone: ZONE });
const competitor = z.object({
  team: z.object({
    id: z.string().regex(/^\d+$/),
    abbreviation: z.string().min(1),
    displayName: z.string().optional(),
  }),
  homeAway: z.enum(["home", "away"]),
  score: z
    .union([
      z.number().int().nonnegative(),
      z
        .string()
        .regex(/^\d+$/)
        .transform(Number)
        .pipe(z.number().int().nonnegative()),
    ])
    .optional(),
});
const eventSchema = z.object({
  id: z.string().regex(/^\d+$/),
  season: z
    .object({ year: z.number().int(), type: z.number().int() })
    .optional(),
  competitions: z
    .array(
      z.object({
        date: z
          .string()
          .regex(/Z$/)
          .refine(value => Number.isFinite(Date.parse(value))),
        timeValid: z.boolean().optional(),
        status: z.object({
          type: z.object({
            id: z.string(),
            state: z.string(),
            description: z.string(),
            detail: z.string(),
          }),
        }),
        competitors: z.array(competitor).length(2),
      })
    )
    .length(1),
});

/** Same ESPN scoreboard JSON endpoint used by the existing football score grader. */
export function parseFootballScoreboard(payload: unknown, date?: string) {
  const raw = z.object({ events: z.array(z.unknown()) }).parse(payload).events;
  return raw.flatMap(value => {
    const parsed = eventSchema.safeParse(value);
    if (!parsed.success) return [];
    const event = parsed.data;
    const competition = event.competitions[0];
    const status = competition.status.type;
    const kickoff = new Date(competition.date);
    if (date && easternDate(kickoff) !== date) return [];
    const away = competition.competitors.find(team => team.homeAway === "away");
    const home = competition.competitors.find(team => team.homeAway === "home");
    if (!away || !home || away.team.id === home.team.id) return [];
    const description = status.description.toLowerCase();
    let gameStatus:
      "upcoming" | "live" | "final" | "postponed" | "suspended" | null = null;
    if (/postponed|cancelled|canceled/.test(description))
      gameStatus = "postponed";
    else if (/suspended/.test(description)) gameStatus = "suspended";
    else if (/delayed/.test(description))
      gameStatus = status.state === "pre" ? "upcoming" : "suspended";
    else if (status.state === "post" && /final/.test(description))
      gameStatus = "final";
    else if (status.state === "in") gameStatus = "live";
    else if (status.state === "pre" && status.id === "1")
      gameStatus = "upcoming";
    if (!gameStatus) return [];
    // A completed result without both scores is not a usable final snapshot.
    if (gameStatus === "final" && (away.score == null || home.score == null))
      return [];
    return [
      {
        id: event.id,
        season: event.season,
        gameDate: easternDate(kickoff),
        kickoff: competition.timeValid === false ? null : kickoff.getTime(),
        awayEspnId: Number(away.team.id),
        homeEspnId: Number(home.team.id),
        awayName: away.team.displayName ?? null,
        homeName: home.team.displayName ?? null,
        awayTeam: away.team.abbreviation,
        homeTeam: home.team.abbreviation,
        startTimeEst:
          competition.timeValid === false
            ? "TBD"
            : kickoff.toLocaleTimeString("en-GB", {
                timeZone: ZONE,
                hour: "2-digit",
                minute: "2-digit",
                hourCycle: "h23",
              }),
        gameStatus,
        awayScore: away.score ?? null,
        homeScore: home.score ?? null,
        gameClock:
          gameStatus === "live" || gameStatus === "suspended"
            ? status.detail.slice(0, 32)
            : null,
      },
    ];
  });
}

export const parseNcaafScoreboard = parseFootballScoreboard;

/** Today plus the prior Eastern day covers late finals without switching dates at UTC midnight. */
export function ncaafRefreshDates(now = new Date()): string[] {
  const today = easternDate(now);
  const yesterday = new Date(`${today}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return [yesterday.toISOString().slice(0, 10), today];
}

const inFlight = new Map<FootballSport, Promise<void>>();

/** Reuse the existing score job and narrow DB updater; never publish games or touch market data. */
export function refreshNcaafScoresNow(now = new Date()): Promise<void> {
  return refreshFootballScoresNow("NCAAF", now);
}

export function refreshFootballScoresNow(
  sport: FootballSport,
  now = new Date()
): Promise<void> {
  // ponytail: one refresh per process; use a shared lease if score jobs span replicas.
  const existing = inFlight.get(sport);
  if (existing) return existing;
  const work = refreshDates(now, sport).finally(() => {
    inFlight.delete(sport);
  });
  inFlight.set(sport, work);
  return work;
}

async function refreshDates(now: Date, sport: FootballSport): Promise<void> {
  for (const date of ncaafRefreshDates(now)) {
    try {
      const rows = (await listGamesByDate(date, sport)).filter(
        row => row.publishedToFeed || row.publishedModel
      );
      if (!rows.length) continue;
      const response = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/football/${sport === "NFL" ? "nfl" : "college-football"}/scoreboard?dates=${date.replaceAll("-", "")}${sport === "NCAAF" ? "&groups=80" : ""}&limit=400`,
        {
          signal: AbortSignal.timeout(20_000),
        }
      );
      if (!response.ok)
        throw new Error(`NCAAF scoreboard HTTP ${response.status}`);
      const events = parseNcaafScoreboard(await response.json(), date);
      let updated = 0;
      let unmatched = 0;
      for (const row of rows) {
        const matches = events.filter(
          event =>
            event.awayTeam === row.awayTeam &&
            event.homeTeam === row.homeTeam &&
            (!row.footballBinding ||
              row.footballBinding.scheduleKey.endsWith(`:${event.id}`))
        );
        // Fail closed on ambiguous same-date matchups in either source; never guess orientation.
        if (
          matches.length !== 1 ||
          rows.filter(
            other =>
              other.awayTeam === row.awayTeam && other.homeTeam === row.homeTeam
          ).length !== 1
        ) {
          unmatched++;
          continue;
        }
        const event = matches[0];
        if (isStatusRegression(row.gameStatus, event.gameStatus)) continue;
        const patch = {
          startTimeEst:
            event.startTimeEst === "TBD"
              ? row.startTimeEst
              : event.startTimeEst,
          gameStatus: event.gameStatus,
          awayScore: event.awayScore ?? row.awayScore,
          homeScore: event.homeScore ?? row.homeScore,
          gameClock: event.gameClock,
        };
        if (
          Object.entries(patch).every(
            ([key, value]) => row[key as keyof typeof row] === value
          )
        )
          continue;
        await updateNcaaStartTime(row.id, patch);
        updated++;
      }
      console.log(
        `[ScoreRefresh][${sport}] date=${date} source=${events.length} rows=${rows.length} updated=${updated} unmatched=${unmatched}`
      );
    } catch (error) {
      // Keep last-known state on provider failure; another date/sport must still refresh.
      console.warn(
        `[ScoreRefresh][${sport}] date=${date} refresh failed`,
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  }
}
