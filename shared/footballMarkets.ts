/** Football provider records share games/odds_history; model fields are deliberately absent. */
import nflTeams from "../scripts/data/nfl-2026/teams.json";
import { ncaafHelmet } from "./ncaafHelmets";
import { ncaafSchoolName } from "./ncaafSchoolNames";
export type FootballSport = "NCAAF" | "NFL";
export function footballRefreshDates(now = new Date()) {
  const today = now.toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(`${today}T12:00Z`);
    date.setUTCDate(date.getUTCDate() + i);
    return date.toISOString().slice(0, 10);
  });
}
export type FootballProvider = "an_dk" | "vsin_dk";
export const footballTeamName = (sport: string, abbr: string) =>
  sport === "NFL"
    ? (nflTeams.find(team => team.abbreviation === abbr)?.displayName ?? abbr)
    : ncaafSchoolName(abbr);
export const footballHelmet = (sport: string, abbr: string) =>
  sport === "NFL"
    ? nflTeams.some(team => team.abbreviation === abbr)
      ? `/brand/nfl-helmets/${abbr}.webp`
      : null
    : ncaafHelmet(abbr);
export type FootballBinding = {
  scheduleKey: string;
  scheduleRevision: string;
  seasonType?: number;
  kickoff: number | null;
  awayTeam: string;
  homeTeam: string;
  awayEspnId?: number;
  homeEspnId?: number;
  awayName?: string;
  homeName?: string;
  scheduleSourceUrl?: string;
  scheduleReceivedAt?: number;
  an?: { eventId: number; awayTeamId: number; homeTeamId: number };
  vsin?: { eventId: string; awaySlug: string; homeSlug: string };
};
export const footballBookFields = {
  awaySpread: "awayBookSpread",
  homeSpread: "homeBookSpread",
  total: "bookTotal",
  awaySpreadOdds: "awaySpreadOdds",
  homeSpreadOdds: "homeSpreadOdds",
  overOdds: "overOdds",
  underOdds: "underOdds",
  awayML: "awayML",
  homeML: "homeML",
} as const;
export const footballSplitFields = [
  "spreadAwayBetsPct",
  "spreadAwayMoneyPct",
  "spreadHomeBetsPct",
  "spreadHomeMoneyPct",
  "totalOverBetsPct",
  "totalOverMoneyPct",
  "totalUnderBetsPct",
  "totalUnderMoneyPct",
  "mlAwayBetsPct",
  "mlAwayMoneyPct",
  "mlHomeBetsPct",
  "mlHomeMoneyPct",
] as const;
export type FootballSnapshot = Partial<
  Record<keyof typeof footballBookFields, string | null>
> &
  Partial<Record<(typeof footballSplitFields)[number], number | null>>;
export type FootballObservation = {
  provider: FootballProvider;
  eventId: string;
  receivedAt: number;
  sourceUpdatedAt: number | null;
  sourceUrl: string;
  responseSha256: string;
  snapshot: FootballSnapshot;
  splitLines?: {
    awaySpread: string | null;
    homeSpread: string | null;
    total: string | null;
  };
};
export type FootballMarketState = Partial<
  Record<FootballProvider, FootballObservation & { missing: string[] }>
>;

/** Football counterparts are source observations, never 100 minus a missing side. */
export function presentFootballMarkets<
  T extends {
    sport?: string | null;
    footballScheduleId?: string | null;
    footballMarketState?: FootballMarketState | null;
  },
>(
  row: T
): T & Partial<Record<(typeof footballSplitFields)[number], number | null>> {
  if (!row.footballScheduleId || (row.sport !== "NFL" && row.sport !== "NCAAF"))
    return row;
  const snapshot = row.footballMarketState?.vsin_dk?.snapshot;
  return {
    ...row,
    ...Object.fromEntries(
      footballSplitFields.map(key => [key, snapshot?.[key] ?? null])
    ),
  };
}

/** Null never means zero. Missing fields cannot make a partial read look fully fresh. */
export function footballFreshness(
  state: FootballMarketState | null | undefined,
  provider: FootballProvider,
  now = Date.now(),
  kickoff?: number | null
) {
  const observation = state?.[provider];
  if (!observation) return "unavailable" as const;
  if (kickoff != null && now >= kickoff) return "closed" as const;
  if (now - observation.receivedAt > 10 * 60_000) return "stale" as const;
  return observation.missing.length ? ("partial" as const) : ("fresh" as const);
}
