// Verified provider crosswalk from the existing September 6 publisher.
// ponytail: only approved events; add a source-verified mapping for new slates, never fuzzy-match teams.
export const DATE = "2026-09-06";
export const SLATE = [
  {
    event: 288813,
    awayId: 356,
    homeId: 360,
    away: "WSU",
    home: "WASH",
    time: "16:00",
    utc: "2026-09-06T20:00:00.000Z",
    vsin: "20260906CFB00237",
    awaySlug: "washington-st-cougars",
    homeSlug: "washington-huskies",
  },
  {
    event: 287973,
    awayId: 300,
    homeId: 325,
    away: "WIS",
    home: "ND",
    time: "19:30",
    utc: "2026-09-06T23:30:00.000Z",
    vsin: "20260906CFB00195",
    awaySlug: "wisconsin-badgers",
    homeSlug: "notre-dame-fighting-irish",
  },
  {
    event: 287972,
    awayId: 257,
    homeId: 363,
    away: "LOU",
    home: "MISS",
    time: "19:30",
    utc: "2026-09-06T23:30:00.000Z",
    vsin: "20260906CFB00182",
    awaySlug: "louisville-cardinals",
    homeSlug: "ole-miss-rebels",
  },
] as const;

/** PREZ's supplied prices; total sides intentionally have different thresholds. */
export const WISCONSIN_OWNER_MODEL = {
  awayModelSpread: "22.7",
  homeModelSpread: "-22.7",
  modelAwaySpreadOdds: "+125",
  modelHomeSpreadOdds: "-125",
  modelOverOdds: "+106",
  modelUnderOdds: "-106",
  modelAwayML: "+1010",
  modelHomeML: "-1010",
  publishedModel: 1,
} as const;

type PriceBasis = {
  awaySpread: number;
  homeSpread: number;
  total: number | null;
  overTotal?: number;
  underTotal?: number;
};

/** Reuse the dated source-presentation path; never reinterpret a changed model. */
export function presentNcaafSeptember6<T extends Record<string, unknown>>(
  row: T
): Omit<T, "modelPriceBasis"> & { modelPriceBasis?: PriceBasis | null } {
  if (row.sport !== "NCAAF" || row.gameDate !== DATE) return row;
  const verified =
    row.id === 4350070 &&
    row.ncaaContestId === "287973" &&
    row.awayTeam === "WIS" &&
    row.homeTeam === "ND" &&
    Number.isSafeInteger(row.modelRunAt) &&
    Number(row.modelRunAt) > 0 &&
    row.modelTotal === null &&
    Object.entries(WISCONSIN_OWNER_MODEL).every(
      ([key, value]) => row[key] != null && Number(row[key]) === Number(value)
    );
  return {
    ...row,
    modelPriceBasis: verified
      ? {
          awaySpread: 21,
          homeSpread: -21,
          total: null,
          overTotal: 46.5,
          underTotal: 46.6,
        }
      : null,
  };
}
