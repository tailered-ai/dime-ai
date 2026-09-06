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
