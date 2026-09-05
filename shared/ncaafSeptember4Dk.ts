import sources from "./ncaafSeptember4Dk.json" with { type: "json" };

export const NCAAF_DK_SOURCES = sources;
export const NCAAF_DK_SPLIT_KEYS = [
  "spreadAwayMoneyPct",
  "spreadAwayBetsPct",
  "totalOverMoneyPct",
  "totalOverBetsPct",
  "mlAwayMoneyPct",
  "mlAwayBetsPct",
] as const;

/** Only columns supplied by VSiN; absent spread/total prices stay null. */
export function ncaafDkHistoryRecord(
  quote: (typeof sources)[number]["history"][number]
) {
  return {
    sport: "NCAAF",
    source: "manual",
    scrapedAt: quote.scrapedAt,
    lineSource: "dk",
    awaySpread: quote.awaySpread,
    homeSpread: quote.homeSpread,
    awaySpreadOdds: quote.awaySpreadOdds,
    homeSpreadOdds: quote.homeSpreadOdds,
    total: quote.total,
    overOdds: quote.overOdds,
    underOdds: quote.underOdds,
    awayML: quote.awayML,
    homeML: quote.homeML,
    spreadAwayMoneyPct: quote.spreadAwayMoneyPct,
    spreadAwayBetsPct: quote.spreadAwayBetsPct,
    totalOverMoneyPct: quote.totalOverMoneyPct,
    totalOverBetsPct: quote.totalOverBetsPct,
    mlAwayMoneyPct: quote.mlAwayMoneyPct,
    mlAwayBetsPct: quote.mlAwayBetsPct,
  };
}

const matches = (
  row: Record<string, unknown>,
  expected: Record<string, unknown>
) =>
  Object.entries(expected).every(([key, value]) =>
    value == null ? row[key] == null : String(row[key]) === String(value)
  );

/** The splits view uses DK lines; the model comparison keeps its selected Circa book. */
export function presentNcaafDk<T extends Record<string, unknown>>(row: T) {
  const source = sources.find(
    source =>
      row.sport === "NCAAF" &&
      row.gameDate === source.gameDate &&
      row.ncaaContestId === source.event &&
      row.awayTeam === source.away &&
      row.homeTeam === source.home &&
      matches(row, source.splits)
  );
  if (!source) return { ...row, bettingSplitsSnapshot: null };
  const { awaySpread, homeSpread, total, ...prices } = source.currentLines;
  return {
    ...row,
    bettingSplitsSnapshot: {
      ...prices,
      ...source.splits,
      mlAwayMoneyPct:
        prices.awayML === null && prices.homeML === null
          ? null
          : source.splits.mlAwayMoneyPct,
      mlAwayBetsPct:
        prices.awayML === null && prices.homeML === null
          ? null
          : source.splits.mlAwayBetsPct,
      awayBookSpread: awaySpread,
      homeBookSpread: homeSpread,
      bookTotal: total,
      sourceLabel: "VSiN · DraftKings",
      retrievedAt: source.currentRetrievedAt,
      observedAt: Math.max(...source.history.map(quote => quote.scrapedAt)),
    },
  };
}

export function presentNcaafDkHistory<T extends Record<string, unknown>>(
  row: T
): T & { sourceLabel?: string; sourceNote?: string; isOpening?: boolean } {
  if (row.sport !== "NCAAF" || row.source !== "manual") return row;
  const quote = sources
    .flatMap<(typeof sources)[number]["history"][number]>(
      source => source.history
    )
    .find(quote => matches(row, ncaafDkHistoryRecord(quote)));
  return quote
    ? {
        ...row,
        sourceLabel: "VSiN DK",
        isOpening: quote.sourceSection === "Opening Split",
        sourceNote:
          "DraftKings splits and line history via VSiN. Times are source observations; spread and total prices are not supplied.",
      }
    : row;
}
