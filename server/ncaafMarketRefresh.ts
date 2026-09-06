import { DATE, SLATE } from "../shared/ncaafSeptember6";
import { fetchActionNetworkOdds } from "./actionNetworkScraper";
import { listGamesByDate, updateNcaafMarkets } from "./db";
import { scrapeVsinBettingSplits } from "./vsinBettingSplitsScraper";

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
    const [an, vsin] = await Promise.all([
      fetchActionNetworkOdds("ncaaf", date),
      scrapeVsinBettingSplits(view, "CFB"),
    ]);
    const capturedAt = Date.now();
    for (const { row, mapping: m } of eligible) {
      try {
        const prices = an.filter(g => g.gameId === m.event);
        const splits = vsin.filter(g => g.gameId === m.vsin);
        const a = prices[0],
          v = splits[0];
        if (
          prices.length !== 1 ||
          !a ||
          a.awayTeamId !== m.awayId ||
          a.homeTeamId !== m.homeId ||
          Date.parse(a.startTime) !== Date.parse(m.utc) ||
          splits.length !== 1 ||
          !v ||
          v.sport !== "CFB" ||
          v.awayVsinSlug !== m.awaySlug ||
          v.homeVsinSlug !== m.homeSlug
        )
          throw new Error("provider identity/kickoff mismatch");
        if (a.status !== "scheduled" || capturedAt >= Date.parse(m.utc)) {
          result.frozen++;
          continue;
        }
        const percentages = {
          spreadAwayBetsPct: v.spreadAwayBetsPct,
          spreadAwayMoneyPct: v.spreadAwayMoneyPct,
          totalOverBetsPct: v.totalOverBetsPct,
          totalOverMoneyPct: v.totalOverMoneyPct,
          mlAwayBetsPct: v.mlAwayBetsPct,
          mlAwayMoneyPct: v.mlAwayMoneyPct,
        };
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
