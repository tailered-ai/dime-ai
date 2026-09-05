import { z } from "zod";
import { listGamesByDate, updateNcaaStartTime } from "./db";
import { isStatusRegression } from "./mlbEventIdentity";

const ZONE = "America/New_York";
const easternDate = (date: Date) =>
  date.toLocaleDateString("en-CA", { timeZone: ZONE });
const competitor = z.object({
  id: z.string().regex(/^\d+$/),
  abbrev: z.string().min(1),
  isHome: z.boolean(),
  score: z.number().int().nonnegative().optional(),
});
const eventSchema = z.object({
  id: z.string().regex(/^\d+$/),
  date: z
    .string()
    .regex(/Z$/)
    .refine(value => Number.isFinite(Date.parse(value))),
  tbd: z.boolean().optional(),
  status: z.object({
    id: z.string(),
    state: z.string(),
    description: z.string(),
    detail: z.string(),
  }),
  competitors: z.array(competitor).length(2),
});
const envelope = z.object({
  page: z.object({
    content: z.object({ scoreboard: z.object({ evts: z.array(z.unknown()) }) }),
  }),
});

/** ESPN's public page carries the same UTC schedule and lifecycle as its game center. */
export function parseNcaafScoreboard(html: string, date: string) {
  const embedded = html.match(
    /window\['__espnfitt__'\]\s*=\s*(\{[\s\S]+?);\s*(?:window|<\/script>)/
  );
  if (!embedded) throw new Error("NCAAF scoreboard data missing");
  const raw = envelope.parse(JSON.parse(embedded[1])).page.content.scoreboard
    .evts;
  return raw.flatMap(value => {
    const parsed = eventSchema.safeParse(value);
    if (!parsed.success) return [];
    const event = parsed.data;
    const kickoff = new Date(event.date);
    if (easternDate(kickoff) !== date) return [];
    const away = event.competitors.find(team => !team.isHome);
    const home = event.competitors.find(team => team.isHome);
    if (!away || !home || away.id === home.id) return [];
    const description = event.status.description.toLowerCase();
    let gameStatus:
      "upcoming" | "live" | "final" | "postponed" | "suspended" | null = null;
    if (/postponed|cancelled|canceled/.test(description))
      gameStatus = "postponed";
    else if (/suspended/.test(description)) gameStatus = "suspended";
    else if (/delayed/.test(description))
      gameStatus = event.status.state === "pre" ? "upcoming" : "suspended";
    else if (event.status.state === "post" && /final/.test(description))
      gameStatus = "final";
    else if (event.status.state === "in") gameStatus = "live";
    else if (event.status.state === "pre" && event.status.id === "1")
      gameStatus = "upcoming";
    if (!gameStatus) return [];
    // A completed result without both scores is not a usable final snapshot.
    if (gameStatus === "final" && (away.score == null || home.score == null))
      return [];
    return [
      {
        id: event.id,
        awayTeam: away.abbrev,
        homeTeam: home.abbrev,
        startTimeEst: event.tbd
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
            ? event.status.detail.slice(0, 32)
            : null,
      },
    ];
  });
}

/** Today plus the prior Eastern day covers late finals without switching dates at UTC midnight. */
export function ncaafRefreshDates(now = new Date()): string[] {
  const today = easternDate(now);
  const yesterday = new Date(`${today}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return [yesterday.toISOString().slice(0, 10), today];
}

let inFlight: Promise<void> | undefined;

/** Reuse the existing score job and narrow DB updater; never publish games or touch market data. */
export function refreshNcaafScoresNow(now = new Date()): Promise<void> {
  // ponytail: one refresh per process; use a shared lease if score jobs span replicas.
  if (inFlight) return inFlight;
  inFlight = refreshDates(now).finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

async function refreshDates(now: Date): Promise<void> {
  for (const date of ncaafRefreshDates(now)) {
    try {
      const rows = (await listGamesByDate(date, "NCAAF")).filter(
        row => row.publishedToFeed || row.publishedModel
      );
      if (!rows.length) continue;
      const response = await fetch(
        `https://www.espn.com/college-football/scoreboard/_/date/${date.replaceAll("-", "")}/group/80`,
        {
          signal: AbortSignal.timeout(20_000),
        }
      );
      if (!response.ok)
        throw new Error(`NCAAF scoreboard HTTP ${response.status}`);
      const events = parseNcaafScoreboard(await response.text(), date);
      let updated = 0;
      let unmatched = 0;
      for (const row of rows) {
        const matches = events.filter(
          event =>
            event.awayTeam === row.awayTeam && event.homeTeam === row.homeTeam
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
        `[ScoreRefresh][NCAAF] date=${date} source=${events.length} rows=${rows.length} updated=${updated} unmatched=${unmatched}`
      );
    } catch (error) {
      // Keep last-known state on provider failure; another date/sport must still refresh.
      console.warn(
        `[ScoreRefresh][NCAAF] date=${date} refresh failed`,
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  }
}
