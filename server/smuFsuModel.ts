/** PREZ's September 7 prices. Server-only: never ship the private ladder in client assets. */
export const SMU_FSU_KEY = "espn:ncaaf:2026:401858212";
export const SMU_FSU_MODEL = {
  modelAwayScore: "26.83",
  modelHomeScore: "25.57",
  awayModelSpread: "-1",
  homeModelSpread: "1",
  modelTotal: "52.40", // Sum of the two supplied projected scores, not a pricing threshold.
  modelAwayML: "-112",
  modelHomeML: "+112",
  modelAwaySpreadOdds: "+105",
  modelHomeSpreadOdds: "-105",
} as const;
export const SMU_FSU_TOTALS = [
  [49.5, -126, 126],
  [50, -121, 121],
  [50.5, -117, 117],
  [51, -113, 113],
  [51.5, -109, 109],
  [52, -105, 105],
  [52.5, 101, -101],
  [53, 105, -105],
  [53.5, 109, -109],
  [54, 113, -113],
  [54.5, 117, -117],
  [55, 121, -121],
  [55.5, 126, -126],
] as const;
export const isSmuFsu = (row: Record<string, unknown>) =>
  row.sport === "NCAAF" &&
  row.gameDate === "2026-09-07" &&
  row.awayTeam === "SMU" &&
  row.homeTeam === "FSU" &&
  row.footballScheduleId === SMU_FSU_KEY;
const price = (value: number) => (value > 0 ? `+${value}` : String(value));

/** Select an exact supplied total quote after provider presentation, before existing auth stripping. */
export function presentSmuFsuModel<T extends Record<string, unknown>>(row: T) {
  if (
    !isSmuFsu(row) ||
    !row.publishedModel ||
    !Number.isSafeInteger(row.modelRunAt) ||
    Number(row.modelRunAt) <= 0 ||
    !Object.entries(SMU_FSU_MODEL).every(
      ([key, value]) => row[key] != null && Number(row[key]) === Number(value)
    )
  )
    return row;
  const state = row.footballMarketState as {
    an_dk?: { snapshot?: { total?: string | null } };
  } | null;
  const observed = state?.an_dk?.snapshot?.total;
  const quote =
    observed != null &&
    row.bookTotal != null &&
    Number(observed) === Number(row.bookTotal)
      ? SMU_FSU_TOTALS.find(([line]) => line === Number(observed))
      : undefined;
  return {
    ...row,
    modelOverOdds: quote ? price(quote[1]) : null,
    modelUnderOdds: quote ? price(quote[2]) : null,
    modelPriceBasis: {
      awaySpread: -1,
      homeSpread: 1,
      total: quote?.[0] ?? null,
    },
  };
}
