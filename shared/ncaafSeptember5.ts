import sourceRows from "./ncaafSeptember5Sources.json" with { type: "json" };

type SplitValues = Record<
  | "spreadAwayMoneyPct"
  | "spreadAwayBetsPct"
  | "totalOverMoneyPct"
  | "totalOverBetsPct"
  | "mlAwayMoneyPct"
  | "mlAwayBetsPct",
  number | null
>;
type OppositeSplits = Record<
  | "spreadHomeMoneyPct"
  | "spreadHomeBetsPct"
  | "totalUnderMoneyPct"
  | "totalUnderBetsPct"
  | "mlHomeMoneyPct"
  | "mlHomeBetsPct",
  number | null
>;
type ModelPriceBasis = {
  awaySpread: number;
  homeSpread: number;
  total: number;
};
type ModelBookPrices = Record<
  "awaySpreadOdds" | "homeSpreadOdds" | "overOdds" | "underOdds",
  string
>;
type BookPrices = Record<
  keyof ModelBookPrices | "awayML" | "homeML",
  string | null
>;
type MarketAvailability = Record<"spread" | "total" | "moneyline", boolean>;
type Quote = BookPrices &
  SplitValues & {
    scrapedAt: number;
    lineSource: string;
    awaySpread: string | null;
    homeSpread: string | null;
    total: string | null;
    provider: string;
    sourceSection: string;
    observedAt: number | null;
    retrievedAt: string;
    oppositeSplits: OppositeSplits;
    splitMarkets: MarketAvailability;
  };
type SelectedGame = {
  event: string;
  away: string;
  home: string;
  gameDate: string;
  initialStatus: string;
  splits: SplitValues;
  oppositeSplits: OppositeSplits;
  splitMarkets: MarketAvailability;
  book: BookPrices & {
    awaySpread: number | null;
    homeSpread: number | null;
    total: number | null;
  };
  model: BookPrices &
    ModelPriceBasis & { basis: ModelPriceBasis; bookPrices?: ModelBookPrices };
  modelImportedAt: number;
  schedule: {
    startTimeEst: string;
    startTime: string;
    venue: string;
    venueLocation: string;
    broadcaster: string;
    neutralSite: boolean;
    espnEventId: number;
  };
  marketCapturedAt: string;
  sourceObservedAt: number | null;
  normalizedAt: string;
  splitsRetrievedAt: string;
  vsinGamecode: string;
  history: Quote[];
};
type BettingSplitsSnapshot = SplitValues &
  Partial<OppositeSplits & BookPrices> & {
    sourceLabel: string;
    retrievedAt: string;
    observedAt: number | null;
    awayBookSpread?: string | null;
    homeBookSpread?: string | null;
    bookTotal?: string | null;
  };
type Presentation = {
  modelPriceBasis?: ModelPriceBasis | null;
  modelBookPrices?: ModelBookPrices | null;
  bettingSplitsSnapshot?: BettingSplitsSnapshot | null;
  neutralSite?: boolean;
};

/** Owner-approved numbers and verified sources; server and publisher only. */
export const DATE = "2026-09-05";
export const REVISION = "ncaaf-owner-model-an-dk-vsin-20260905-v1";
// One checked boundary keeps the captured JSON's structural unions out of the tRPC router type.
export const SOURCES: SelectedGame[] = sourceRows;

const point = (value: number | null) =>
  value == null ? null : value.toFixed(1);

function modelRecord(game: SelectedGame) {
  return {
    awayModelSpread: point(game.model.awaySpread),
    homeModelSpread: point(game.model.homeSpread),
    modelTotal: point(game.model.total),
    modelAwaySpreadOdds: game.model.awaySpreadOdds,
    modelHomeSpreadOdds: game.model.homeSpreadOdds,
    modelOverOdds: game.model.overOdds,
    modelUnderOdds: game.model.underOdds,
    modelAwayML: null,
    modelHomeML: null,
    modelAwayScore: null,
    modelHomeScore: null,
    modelAwayWinPct: null,
    modelHomeWinPct: null,
    modelOverRate: null,
    modelUnderRate: null,
    // Existing feed publication marker: attachment arrival, not an asserted model run.
    modelRunAt: game.modelImportedAt,
  };
}

/** Bounded SQL update; lifecycle, identity and existing history belong to the publisher. */
export function ncaafSeptember5Record(game: SelectedGame) {
  return {
    startTimeEst: game.schedule.startTimeEst,
    ncaaContestId: game.event,
    venue: game.schedule.venue,
    broadcaster: game.schedule.broadcaster,
    awayBookSpread: point(game.book.awaySpread),
    homeBookSpread: point(game.book.homeSpread),
    bookTotal: point(game.book.total),
    awaySpreadOdds: game.book.awaySpreadOdds,
    homeSpreadOdds: game.book.homeSpreadOdds,
    overOdds: game.book.overOdds,
    underOdds: game.book.underOdds,
    awayML: game.book.awayML,
    homeML: game.book.homeML,
    oddsSource: "dk",
    source_updated_at: null,
    provider_observed_at: null,
    ingestion_received_at: new Date(game.marketCapturedAt),
    ingestion_normalized_at: new Date(game.normalizedAt),
    ingestion_pipeline_revision: REVISION,
    ...game.splits,
    ...modelRecord(game),
    spreadEdge: null,
    totalEdge: null,
    spreadDiff: null,
    totalDiff: null,
    publishedToFeed: 1,
    publishedModel: 1,
  };
}

/** Exactly the 19 persisted history columns, without source-only presentation metadata. */
export function ncaafSeptember5HistoryRecord(quote: Quote) {
  return {
    sport: "NCAAF",
    source: "manual",
    scrapedAt: quote.scrapedAt,
    lineSource: quote.lineSource,
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

const selected = (row: Record<string, unknown>) =>
  SOURCES.find(
    game =>
      row.sport === "NCAAF" &&
      row.gameDate === DATE &&
      row.ncaaContestId === game.event &&
      row.awayTeam === game.away &&
      row.homeTeam === game.home
  );

const matches = (
  row: Record<string, unknown>,
  expected: Record<string, unknown>
) =>
  Object.entries(expected).every(([key, value]) =>
    value == null ? row[key] === null : String(row[key]) === String(value)
  );

/** Missing source markets are unavailable; real independently rounded pairs stay untouched. */
function presentSplits(
  splits: SplitValues,
  opposite: OppositeSplits,
  available: MarketAvailability
) {
  const values = { ...splits, ...opposite };
  for (const [market, prefix] of [
    ["spread", "spread"],
    ["total", "total"],
    ["moneyline", "ml"],
  ] as const) {
    if (!available[market]) {
      for (const key of Object.keys(values) as Array<keyof typeof values>)
        if (key.startsWith(prefix)) values[key] = null;
    }
  }
  return values;
}

/** Model prices retain their original thresholds after independent Book refreshes. */
export function presentNcaafSeptember5<T extends Record<string, unknown>>(
  row: T
): Omit<T, keyof Presentation> & Presentation {
  const game = selected(row);
  if (!game) return row;
  return {
    ...row,
    neutralSite: game.schedule.neutralSite,
    modelPriceBasis: matches(row, modelRecord(game)) ? game.model.basis : null,
    modelBookPrices: matches(row, modelRecord(game))
      ? (game.model.bookPrices ?? null)
      : null,
    bettingSplitsSnapshot: matches(row, game.splits)
      ? {
          ...presentSplits(game.splits, game.oppositeSplits, game.splitMarkets),
          sourceLabel: "VSiN · DraftKings",
          retrievedAt: game.splitsRetrievedAt,
          observedAt: null,
        }
      : null,
  };
}

/** Bind provenance to the parent game's identity and the entire persisted observation. */
export function presentNcaafSeptember5History<
  T extends Record<string, unknown>,
>(
  row: T,
  parentGame?: Record<string, unknown>
): T & {
  sourceLabel?: string;
  sourceNote?: string;
  isOpening?: boolean;
  spreadHomeMoneyPct?: number | null;
  spreadHomeBetsPct?: number | null;
  totalUnderMoneyPct?: number | null;
  totalUnderBetsPct?: number | null;
  mlHomeMoneyPct?: number | null;
  mlHomeBetsPct?: number | null;
} {
  if (
    !parentGame ||
    row.gameId == null ||
    parentGame.id == null ||
    String(row.gameId) !== String(parentGame.id)
  )
    return row;
  const game = selected(parentGame);
  if (!game) return row;
  const quote = game.history.find(quote =>
    matches(row, ncaafSeptember5HistoryRecord(quote))
  );
  if (!quote) return row;
  const splits = Object.fromEntries(
    Object.entries(ncaafSeptember5HistoryRecord(quote)).filter(([key]) =>
      key.endsWith("Pct")
    )
  ) as SplitValues;
  return {
    ...row,
    ...presentSplits(splits, quote.oppositeSplits, quote.splitMarkets),
    sourceLabel: quote.provider === "an" ? "AN DK" : "VSiN DK",
    isOpening: quote.sourceSection === "Opening Split",
    sourceNote:
      quote.provider === "an"
        ? "DraftKings NJ odds via Action Network. Time is API capture time; no provider update timestamp or betting splits were supplied."
        : "DraftKings splits and line history via VSiN. Times are source observations; both published percentage sides are preserved. Spread and total prices are not supplied.",
  };
}
