import { DATE, SLATE } from "../shared/ncaafSeptember6";
import { fetchActionNetworkOdds } from "./actionNetworkScraper";
import {
  listGamesByDate,
  updateNcaafMarkets,
  updateFootballMarket,
  reconcileFootballSchedule,
  bindFootballProvider,
} from "./db";
import { scrapeVsinBettingSplits } from "./vsinBettingSplitsScraper";
import { fetchFootballSchedule } from "./footballSchedule";
import {
  footballRefreshDates,
  footballSplitFields,
  type FootballSport,
  type FootballObservation,
  type FootballBinding,
} from "../shared/footballMarkets";
export { footballRefreshDates } from "../shared/footballMarkets";
import { debugLog } from "./_core/debugLogger";
import { gradingAlert } from "./betGradingHealth";

export type FootballCycleResult = NcaafMarketResult & {
  disabled?: boolean;
  startedAt: number;
  completedAt: number;
  providers: Record<"an_dk" | "vsin_dk", { ok: boolean; observations: number }>;
};
const footballFlights = new Map<FootballSport, Promise<FootballCycleResult>>();
const lastSeasonRefresh = new Map<FootballSport, string>();
const providerRetryAt = new Map<string, number>();
async function readFootballProvider<T>(
  sport: FootballSport,
  provider: string,
  read: () => Promise<T>
): Promise<T> {
  const key = `${sport}:${provider}`;
  if ((providerRetryAt.get(key) ?? 0) > Date.now())
    throw new Error(`${provider} Retry-After cooldown active`);
  try {
    return await read();
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "retryAfter" in error &&
      typeof error.retryAfter === "string"
    ) {
      const value = error.retryAfter.trim();
      const retryAt = /^\d+$/.test(value)
        ? Date.now() + Number(value) * 1000
        : Date.parse(value);
      if (Number.isFinite(retryAt) && retryAt > Date.now())
        providerRetryAt.set(key, retryAt);
    }
    throw error;
  }
}
const lastFootballResult: Partial<Record<FootballSport, FootballCycleResult>> =
  {};
export const getFootballRefreshStatus = () =>
  Object.fromEntries(
    Object.entries(lastFootballResult).map(([sport, result]) => [
      sport,
      {
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        disabled: result.disabled ?? false,
        ok:
          !result.disabled && !result.errors.length && !result.unmapped.length,
        providers: result.providers,
        updated: result.updated,
        unmapped: result.unmapped.length,
      },
    ])
  );

const PILOTS = new Set([
  "espn:ncaaf:2026:401858212",
  "espn:nfl:2026:401872656",
]);
// Exact exception verified in the retained 2026-09-07 CFB source response. No fuzzy expansion of "ST".
function matchesVsinTeam(
  sport: FootballSport,
  binding: FootballBinding,
  side: "away" | "home",
  name: string,
  slug: string
) {
  if (sport === "NCAAF" && binding[`${side}EspnId`] === 52)
    return name === "Florida ST Seminoles" && slug === "florida-st-seminoles";
  return name === binding[`${side}Name`];
}

/** Existing timer, authenticated cron and manual calls all share this league-level flight. */
export async function runFootballMarketCycle(
  source: "auto" | "manual",
  sports: FootballSport[] = ["NCAAF", "NFL"]
) {
  const entries = await Promise.all(
    Array.from(new Set(sports)).map(async sport => {
      let work = footballFlights.get(sport);
      if (!work) {
        work = refreshFootballLeague(sport, source).finally(() =>
          footballFlights.delete(sport)
        );
        footballFlights.set(sport, work);
      }
      return [sport, await work] as const;
    })
  );
  return Object.fromEntries(entries) as Partial<
    Record<FootballSport, FootballCycleResult>
  >;
}

async function refreshFootballLeague(
  sport: FootballSport,
  source: "auto" | "manual"
): Promise<FootballCycleResult> {
  const startedAt = Date.now();
  const result: FootballCycleResult = {
    updated: 0,
    skipped: 0,
    frozen: 0,
    unmapped: [],
    errors: [],
    startedAt,
    completedAt: 0,
    providers: {
      an_dk: { ok: true, observations: 0 },
      vsin_dk: { ok: true, observations: 0 },
    },
  };
  const mode = process.env.FOOTBALL_MARKETS_MODE;
  if (
    !(["pilots", "all"] as unknown[]).includes(mode) ||
    (process.env.RAILWAY_ENVIRONMENT_ID &&
      (!process.env.FOOTBALL_MARKETS_WRITER_SERVICE_ID ||
        process.env.RAILWAY_SERVICE_ID !==
          process.env.FOOTBALL_MARKETS_WRITER_SERVICE_ID))
  ) {
    result.disabled = true;
    result.completedAt = Date.now();
    lastFootballResult[sport] = result;
    return result;
  }
  const signal = AbortSignal.timeout(240_000);
  const dates = footballRefreshDates(new Date(startedAt)),
    compact = (date: string) => date.replaceAll("-", "");
  const year =
    Number(dates[0].slice(0, 4)) - (Number(dates[0].slice(5, 7)) < 8 ? 1 : 0);
  const inScope = (key: string | null | undefined) =>
    mode === "all" || (!!key && PILOTS.has(key));
  try {
    const seasonRead = lastSeasonRefresh.get(sport) !== dates[0];
    const schedule = await fetchFootballSchedule(
      sport,
      seasonRead
        ? `${year}0801-${year + 1}0220`
        : `${compact(dates[0])}-${compact(dates[6])}`,
      year,
      signal
    );
    await reconcileFootballSchedule(
      sport,
      schedule.rows.filter(row => inScope(row.footballScheduleId)),
      signal
    );
    if (seasonRead) lastSeasonRefresh.set(sport, dates[0]);
    if (schedule.unresolved.length)
      debugLog(
        "FootballMarkets",
        "warn",
        `${sport} unresolved schedule participants/time`,
        { count: schedule.unresolved.length }
      );
    const rows = (
      await Promise.all(dates.map(date => listGamesByDate(date, sport)))
    )
      .flat()
      .filter(row => row.publishedToFeed && inScope(row.footballScheduleId));
    const eligible = rows.filter(row => {
      if (
        row.gameStatus !== "upcoming" ||
        (row.footballBinding?.kickoff != null &&
          Date.now() >= row.footballBinding.kickoff)
      ) {
        result.frozen++;
        return false;
      }
      if (!row.footballBinding || row.footballBinding.kickoff == null) {
        result.unmapped.push(row.id);
        return false;
      }
      return true;
    });
    if (!eligible.length) return result;
    let vsin: Awaited<ReturnType<typeof scrapeVsinBettingSplits>> = [];
    try {
      vsin = await readFootballProvider(sport, "vsin_dk", () =>
        scrapeVsinBettingSplits(
          "sport",
          sport === "NFL" ? "NFL" : "CFB",
          signal
        )
      );
    } catch (error) {
      result.providers.vsin_dk.ok = false;
      result.errors.push(
        `vsin_dk: ${error instanceof Error ? error.message : "read failed"}`
      );
    }
    let stopAn = false;
    for (const date of dates) {
      signal.throwIfAborted();
      const slate = eligible.filter(row => row.gameDate === date);
      if (!slate.length) continue;
      let an: Awaited<ReturnType<typeof fetchActionNetworkOdds>> = [];
      if (!stopAn)
        try {
          an = await readFootballProvider(sport, "an_dk", () =>
            fetchActionNetworkOdds(
              sport === "NFL" ? "nfl" : "ncaaf",
              date,
              signal
            )
          );
        } catch (error) {
          result.providers.an_dk.ok = false;
          result.errors.push(
            `an_dk: ${error instanceof Error ? error.message : "read failed"}`
          );
          stopAn =
            !!error &&
            typeof error === "object" &&
            "status" in error &&
            Number(error.status) >= 400 &&
            Number(error.status) < 500;
        }
      for (const row of slate) {
        let binding = row.footballBinding!;
        for (const provider of ["an_dk", "vsin_dk"] as const) {
          try {
            signal.throwIfAborted();
            if (Date.now() >= binding.kickoff!) {
              result.frozen++;
              break;
            }
            let observation: FootballObservation;
            if (provider === "an_dk") {
              if (!an.length && !result.providers.an_dk.ok) continue;
              const matches = an.filter(g =>
                binding.an
                  ? g.gameId === binding.an.eventId
                  : g.awayFullName === binding.awayName &&
                    g.homeFullName === binding.homeName &&
                    Date.parse(g.startTime) === binding.kickoff
              );
              const a = matches[0];
              if (!matches.length)
                throw new Error("event not available from provider");
              if (
                matches.length !== 1 ||
                !a?.provenance ||
                !a.awayTeamId ||
                !a.homeTeamId ||
                Date.parse(a.startTime) !== binding.kickoff ||
                (binding.an &&
                  (a.awayTeamId !== binding.an.awayTeamId ||
                    a.homeTeamId !== binding.an.homeTeamId))
              )
                throw new Error(
                  "event/team/kickoff identity unavailable or ambiguous"
                );
              if (a.status !== "scheduled") {
                result.frozen++;
                break;
              }
              if (!binding.an)
                binding = await bindFootballProvider(
                  row.id,
                  binding,
                  provider,
                  {
                    eventId: a.gameId,
                    awayTeamId: a.awayTeamId,
                    homeTeamId: a.homeTeamId,
                  },
                  signal
                );
              const point = (v: number | null) =>
                v == null ? null : String(v);
              observation = {
                provider,
                eventId: String(a.gameId),
                ...a.provenance,
                snapshot: {
                  awaySpread: point(a.dkAwaySpread),
                  homeSpread: point(a.dkHomeSpread),
                  total: point(a.dkTotal),
                  awaySpreadOdds: a.dkAwaySpreadOdds ?? null,
                  homeSpreadOdds: a.dkHomeSpreadOdds ?? null,
                  overOdds: a.dkOverOdds ?? null,
                  underOdds: a.dkUnderOdds ?? null,
                  awayML: a.dkAwayML ?? null,
                  homeML: a.dkHomeML ?? null,
                },
              };
            } else {
              if (!vsin.length && !result.providers.vsin_dk.ok) continue;
              const matches = vsin.filter(g =>
                binding.vsin
                  ? g.gameId === binding.vsin.eventId
                  : g.gameDate === date &&
                    matchesVsinTeam(
                      sport,
                      binding,
                      "away",
                      g.awayName,
                      g.awayVsinSlug
                    ) &&
                    matchesVsinTeam(
                      sport,
                      binding,
                      "home",
                      g.homeName,
                      g.homeVsinSlug
                    )
              );
              const v = matches[0];
              if (!matches.length)
                throw new Error("event not available from provider");
              if (
                matches.length !== 1 ||
                !v?.provenance ||
                v.gameDate !== date ||
                v.sport !== (sport === "NFL" ? "NFL" : "CFB") ||
                (binding.vsin &&
                  (v.awayVsinSlug !== binding.vsin.awaySlug ||
                    v.homeVsinSlug !== binding.vsin.homeSlug))
              )
                throw new Error(
                  "event/team/date identity unavailable or ambiguous"
                );
              if (!binding.vsin)
                binding = await bindFootballProvider(
                  row.id,
                  binding,
                  provider,
                  {
                    eventId: v.gameId,
                    awaySlug: v.awayVsinSlug,
                    homeSlug: v.homeVsinSlug,
                  },
                  signal
                );
              observation = {
                provider,
                eventId: v.gameId,
                ...v.provenance,
                splitLines: v.splitLines,
                snapshot: Object.fromEntries(
                  footballSplitFields.map(key => [key, v[key] ?? null])
                ),
              };
            }
            if (
              await updateFootballMarket({
                id: row.id,
                sport,
                binding,
                observation,
                source,
                signal,
              })
            ) {
              result.updated++;
              row.footballMarketState = {
                ...row.footballMarketState,
                [provider]: {
                  ...observation,
                  missing: Object.keys(observation.snapshot).filter(
                    key =>
                      observation.snapshot[
                        key as keyof typeof observation.snapshot
                      ] == null
                  ),
                },
              };
            } else result.skipped++;
            result.providers[provider].observations++;
          } catch (error) {
            signal.throwIfAborted();
            result.providers[provider].ok = false;
            result.unmapped.push(row.id);
            result.errors.push(
              `${provider} game ${row.id}: ${error instanceof Error ? error.message : "write failed"}`
            );
          }
        }
      }
    }
    for (const provider of ["an_dk", "vsin_dk"] as const) {
      const stale = eligible.filter(
        row =>
          Date.now() < row.footballBinding!.kickoff! &&
          Date.now() -
            (row.footballMarketState?.[provider]?.receivedAt ??
              new Date(row.createdAt).getTime()) >=
            15 * 60_000
      );
      if (stale.length)
        await gradingAlert(
          "FOOTBALL_STALE",
          `${sport} ${provider}: ${stale.length} eligible games have no successful observation for at least 15 minutes.`,
          `${sport}:${provider}`
        );
    }
  } catch (error) {
    result.errors.push(
      error instanceof Error ? error.message : "football cycle failed"
    );
  } finally {
    result.unmapped = Array.from(new Set(result.unmapped));
    result.completedAt = Date.now();
    lastFootballResult[sport] = result;
    debugLog(
      "FootballMarkets",
      result.errors.length ? "error" : "info",
      `${sport} cycle completed`,
      { ...result }
    );
    if (
      result.errors.some(error =>
        /ambiguous|identity changed|contradictory|duplicate|invalid/i.test(
          error
        )
      )
    )
      await gradingAlert(
        "FOOTBALL_INTEGRITY",
        `${sport}: football identity/integrity check failed. Refresh retained committed records; inspect FootballMarkets diagnostics.`,
        sport
      );
  }
  return result;
}

export type NcaafMarketResult = {
  updated: number;
  skipped: number;
  frozen: number;
  unmapped: number[];
  errors: string[];
};
// Coalesce this process's cron/manual overlaps; the DB parent lock serializes other instances.
const inFlight = new Map<string, Promise<NcaafMarketResult>>();

export function refreshNcaafMarkets(
  date: string,
  view: "today" | "tomorrow",
  source: "auto" | "manual"
) {
  if (process.env.FOOTBALL_MARKETS_MODE != null)
    return runFootballMarketCycle(source, ["NCAAF"]).then(
      result => result.NCAAF!
    );
  // Compatibility for the previous dated publisher until the guarded football rollout is enabled.
  const existing = inFlight.get(date);
  if (existing) return existing;
  const work = refresh(date, view, source).finally(() => inFlight.delete(date));
  inFlight.set(date, work);
  return work;
}

async function refresh(
  date: string,
  view: "today" | "tomorrow",
  source: "auto" | "manual"
): Promise<NcaafMarketResult> {
  const result: NcaafMarketResult = {
    updated: 0,
    skipped: 0,
    frozen: 0,
    unmapped: [],
    errors: [],
  };
  try {
    const rows = (await listGamesByDate(date, "NCAAF")).filter(
      g => g.publishedToFeed
    );
    const eligible: Array<{
      row: (typeof rows)[number];
      mapping: (typeof SLATE)[number];
    }> = [];
    for (const row of rows) {
      if (row.gameStatus !== "upcoming") {
        result.frozen++;
        continue;
      }
      const mapping =
        date === DATE
          ? SLATE.find(m => String(m.event) === row.ncaaContestId)
          : undefined;
      if (!mapping) {
        result.skipped++;
        result.unmapped.push(row.id);
        continue;
      }
      if (Date.now() >= Date.parse(mapping.utc)) {
        result.frozen++;
        continue;
      }
      if (
        row.gameDate !== date ||
        row.sport !== "NCAAF" ||
        row.awayTeam !== mapping.away ||
        row.homeTeam !== mapping.home ||
        rows.filter(g => g.ncaaContestId === row.ncaaContestId).length !== 1
      ) {
        result.errors.push(
          `game ${row.id}: parent identity mismatch/duplicate`
        );
        continue;
      }
      eligible.push({ row, mapping });
    }
    if (!eligible.length) {
      if (result.errors.length || result.unmapped.length)
        console.warn("[NCAAFMarkets] Incomplete refresh", result);
      return result;
    }
    const [anRead, vsinRead] = await Promise.allSettled([
      fetchActionNetworkOdds("ncaaf", date),
      scrapeVsinBettingSplits(view, "CFB"),
    ]);
    for (const read of [anRead, vsinRead]) {
      if (read.status === "rejected")
        result.errors.push(
          read.reason instanceof Error
            ? read.reason.message
            : "Provider read failed"
        );
    }
    const an = anRead.status === "fulfilled" ? anRead.value : null;
    const vsin = vsinRead.status === "fulfilled" ? vsinRead.value : null;
    if (!an && !vsin) {
      console.warn("[NCAAFMarkets] Incomplete refresh", result);
      return result;
    }
    const capturedAt = Date.now();
    for (const { row, mapping: m } of eligible) {
      try {
        const prices = an?.filter(g => g.gameId === m.event) ?? [];
        const splits = vsin?.filter(g => g.gameId === m.vsin) ?? [];
        const a = prices[0],
          v = splits[0];
        if (
          (an &&
            (prices.length !== 1 ||
              !a ||
              a.awayTeamId !== m.awayId ||
              a.homeTeamId !== m.homeId ||
              Date.parse(a.startTime) !== Date.parse(m.utc))) ||
          (vsin &&
            (splits.length !== 1 ||
              !v ||
              v.sport !== "CFB" ||
              v.awayVsinSlug !== m.awaySlug ||
              v.homeVsinSlug !== m.homeSlug))
        )
          throw new Error("provider identity/kickoff mismatch");
        if (
          (a && a.status !== "scheduled") ||
          capturedAt >= Date.parse(m.utc)
        ) {
          result.frozen++;
          continue;
        }
        const percentages = v
          ? {
              spreadAwayBetsPct: v.spreadAwayBetsPct,
              spreadAwayMoneyPct: v.spreadAwayMoneyPct,
              totalOverBetsPct: v.totalOverBetsPct,
              totalOverMoneyPct: v.totalOverMoneyPct,
              mlAwayBetsPct: v.mlAwayBetsPct,
              mlAwayMoneyPct: v.mlAwayMoneyPct,
            }
          : {};
        for (const value of Object.values(percentages)) {
          if (
            value !== null &&
            (!Number.isInteger(value) || value < 0 || value > 100)
          )
            throw new Error("invalid VSiN percentage");
        }
        const point = (value: number | null | undefined) =>
          value == null ? null : String(value);
        const changed = await updateNcaafMarkets({
          id: row.id,
          gameDate: date,
          eventId: String(m.event),
          awayTeam: m.away,
          homeTeam: m.home,
          kickoff: Date.parse(m.utc),
          capturedAt,
          source,
          providers: { an: !!a, vsin: !!v },
          snapshot: {
            ...(a
              ? {
                  awaySpread: point(a.dkAwaySpread),
                  homeSpread: point(a.dkHomeSpread),
                  total: point(a.dkTotal),
                  awaySpreadOdds: a.dkAwaySpreadOdds ?? null,
                  homeSpreadOdds: a.dkHomeSpreadOdds ?? null,
                  overOdds: a.dkOverOdds ?? null,
                  underOdds: a.dkUnderOdds ?? null,
                  awayML: a.dkAwayML ?? null,
                  homeML: a.dkHomeML ?? null,
                }
              : {}),
            ...percentages,
          },
        });
        if (changed) result.updated++;
        else result.skipped++;
      } catch (error) {
        result.errors.push(
          `game ${row.id}: ${error instanceof Error ? error.message : "market refresh failed"}`
        );
      }
    }
  } catch (error) {
    result.errors.push(
      error instanceof Error ? error.message : "NCAAF refresh failed"
    );
  }
  if (result.errors.length || result.unmapped.length)
    console.warn("[NCAAFMarkets] Incomplete refresh", result);
  return result;
}
