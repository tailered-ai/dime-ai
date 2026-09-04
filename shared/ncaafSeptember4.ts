/** Owner-selected Circa snapshot, 2026-09-04 17:50 ET; server/publisher only. */
export const NCAAF_DATE = "2026-09-04";
export const NCAAF_REVISION = "vsin-circa-five-provisional-20260904-v1";
export const NCAAF_MODEL_RUN_AT = Date.parse("2026-09-04T23:21:00Z");
export const NCAAF_SOURCE_TIME = "2026-09-04T21:50:00.000Z";

export const NCAAF_SEPTEMBER4 = [
  {
    spreadOdds: [117, -117],
    totalOdds: [103, -103],
    away: "SJSU",
    home: "EMU",
    event: "288794",
    start: "18:30",
    bookSpread: 1,
    bookTotal: 55,
    bookML: [100, -120],
    modelSpread: 2.3,
    modelTotal: 54.7,
    modelML: [130, -130],
  },
  {
    spreadOdds: [-962, 962],
    totalOdds: [-129, 129],
    away: "TOL",
    home: "MSU",
    event: "288839",
    start: "20:00",
    bookSpread: 10,
    bookTotal: 48.5,
    bookML: [310, -380],
    modelSpread: -7.36,
    modelTotal: 51.06,
    modelML: [-241, 241],
  },
  {
    spreadOdds: [-127, 127],
    totalOdds: [-141, 141],
    away: "FRES",
    home: "USC",
    event: "288845",
    start: "21:00",
    bookSpread: 21.5,
    bookTotal: 51,
    bookML: [1300, -2600],
    modelSpread: 19.5,
    modelTotal: 54.35,
    modelML: [1001, -1001],
    modelSpreadNote:
      "Model line: Fresno State +19.5 (-111) / USC -19.5 (+111). Table prices are at Circa's +21.5 / -21.5.",
  },
  {
    spreadOdds: [-659, 659],
    totalOdds: [159, -159],
    away: "UTEP",
    home: "OU",
    event: "288837",
    start: "20:00",
    bookSpread: 41,
    bookTotal: 50.5,
    bookML: [null, null],
    modelSpread: 26.27,
    modelTotal: 45.86,
    modelML: [3769, -3769],
  },
  {
    spreadOdds: [211, -211],
    totalOdds: [109, -109],
    away: "MIA",
    home: "STAN",
    event: "288791",
    start: "21:00",
    bookSpread: -25,
    bookTotal: 46.5,
    bookML: [-4200, 1700],
    modelSpread: -18.91,
    modelTotal: 45.67,
    modelML: [-1141, 1141],
  },
] as const;

export type SelectedNcaafGame = (typeof NCAAF_SEPTEMBER4)[number];

const american = (value: number | null): string | null =>
  value == null ? null : value > 0 ? `+${value}` : `${value}`;

/** SQL payload: old DECIMAL(6,1) storage is deliberate; the verified wire view restores exact points. */
export function ncaafSeptember4Record(game: SelectedNcaafGame) {
  const winProbability = (odds: number) =>
    odds < 0 ? -odds / (100 - odds) : 100 / (100 + odds);
  return {
    startTimeEst: game.start,
    ncaaContestId: game.event,
    awayBookSpread: game.bookSpread.toFixed(1),
    homeBookSpread: (-game.bookSpread).toFixed(1),
    bookTotal: game.bookTotal.toFixed(1),
    awayML: american(game.bookML[0]),
    homeML: american(game.bookML[1]),
    awaySpreadOdds: "-110",
    homeSpreadOdds: "-110",
    overOdds: "-110",
    underOdds: "-110",
    oddsSource: null,
    source_updated_at: new Date(NCAAF_SOURCE_TIME),
    provider_observed_at: null,
    ingestion_pipeline_revision: NCAAF_REVISION,
    awayModelSpread: game.modelSpread.toFixed(1),
    homeModelSpread: (-game.modelSpread).toFixed(1),
    modelTotal: game.modelTotal.toFixed(1),
    modelAwayScore: ((game.modelTotal - game.modelSpread) / 2).toFixed(2),
    modelHomeScore: ((game.modelTotal + game.modelSpread) / 2).toFixed(2),
    modelAwayML: american(game.modelML[0]),
    modelHomeML: american(game.modelML[1]),
    modelAwayWinPct: (winProbability(game.modelML[0]) * 100).toFixed(2),
    modelHomeWinPct: (winProbability(game.modelML[1]) * 100).toFixed(2),
    modelAwaySpreadOdds: american(game.spreadOdds[0]),
    modelHomeSpreadOdds: american(game.spreadOdds[1]),
    modelOverOdds: american(game.totalOdds[0]),
    modelUnderOdds: american(game.totalOdds[1]),
    // Prices include integer-line pushes. Do not represent conditional prices as raw win rates.
    modelOverRate: null,
    modelUnderRate: null,
    spreadEdge: null,
    totalEdge: null,
    spreadDiff: (game.bookSpread - game.modelSpread).toFixed(1),
    totalDiff: (game.modelTotal - game.bookTotal).toFixed(1),
    modelRunAt: NCAAF_MODEL_RUN_AT,
    publishedToFeed: 1,
    publishedModel: 1,
  };
}

/** Restore exact owner points only for an unchanged published snapshot, before auth stripping. */
export function presentNcaafSeptember4<T extends Record<string, unknown>>(
  row: T
): T & { modelSpreadNote?: string | null } {
  if (
    row.sport !== "NCAAF" ||
    row.gameDate !== NCAAF_DATE ||
    row.ingestionPipelineRevision !== NCAAF_REVISION
  )
    return row;
  const game = NCAAF_SEPTEMBER4.find(
    g =>
      row.ncaaContestId === g.event &&
      row.awayTeam === g.away &&
      row.homeTeam === g.home
  );
  if (!game) return row;
  const names: Record<string, string> = {
    source_updated_at: "sourceUpdatedAt",
    provider_observed_at: "providerObservedAt",
    ingestion_pipeline_revision: "ingestionPipelineRevision",
  };
  const matches = Object.entries(ncaafSeptember4Record(game)).every(
    ([key, value]) => {
      const actual = row[names[key] ?? key];
      if (value instanceof Date)
        return (
          actual != null &&
          new Date(actual as string | Date).getTime() === value.getTime()
        );
      if (key === "publishedModel" || key === "publishedToFeed")
        return actual === true || actual === 1;
      return value == null ? actual === null : String(actual) === String(value);
    }
  );
  if (!matches) return row;
  return {
    ...row,
    awayModelSpread: String(game.modelSpread),
    homeModelSpread: String(-game.modelSpread),
    modelTotal: String(game.modelTotal),
    modelSpreadNote:
      "modelSpreadNote" in game
        ? game.modelSpreadNote
        : "Provisional model odds at the Circa spread shown.",
  };
}
