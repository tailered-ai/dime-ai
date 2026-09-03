/**
 * leagueSeasons — in-season gating for the Betting Splits league pills.
 *
 * A league is offered on the splits surface only while its season (regular
 * season + postseason) is running. Off-season leagues have no games, no
 * splits, and no odds history — showing their pills is dead UI.
 *
 * Rules:
 *  - Windows are inclusive ET month-day ranges. A window whose start is
 *    later in the year than its end (NHL, NBA) wraps across the new year.
 *  - The reference date should be the server's effective slate date
 *    (games.getCurrentDate) when available, falling back to the client's
 *    UTC today. Gating is about "now", never the date being browsed.
 *  - Fail-open: malformed input or an impossible "nothing in season"
 *    result returns every league rather than blanking the page.
 */

export const SPLITS_LEAGUES = ["NCAAF", "MLB", "NHL", "NBA"] as const;
export type SplitsLeague = (typeof SPLITS_LEAGUES)[number];

/**
 * Inclusive season windows (ET month-day). Buffered a few days on each side
 * so year-to-year schedule drift never hides a live league:
 *  - MLB: mid-March openers (incl. international series) → World Series.
 *  - NHL: early-October puck drop → Stanley Cup Final (mid/late June).
 *  - NBA: preseason-to-opening-week October start → Finals (mid/late June).
 */
const SEASON_WINDOWS: Record<SplitsLeague, { start: string; end: string }> = {
  NCAAF: { start: "08-15", end: "01-31" },
  MLB: { start: "03-15", end: "11-10" },
  NHL: { start: "10-01", end: "06-30" },
  NBA: { start: "10-15", end: "06-30" },
};

const ISO_DATE_RE = /^\d{4}-(\d{2}-\d{2})$/;

/** True when the league's season window contains the given ISO date. */
export function isLeagueInSeason(
  league: SplitsLeague,
  isoDate: string
): boolean {
  const match = ISO_DATE_RE.exec(isoDate);
  if (!match) return true; // fail-open on malformed dates
  const monthDay = match[1]!;
  const { start, end } = SEASON_WINDOWS[league];
  // MM-DD compares correctly as a string; start > end means the window wraps.
  return start <= end
    ? monthDay >= start && monthDay <= end
    : monthDay >= start || monthDay <= end;
}

/**
 * Leagues to offer for the given date, in canonical pill order.
 * Never returns an empty list (fail-open).
 */
export function inSeasonLeagues(isoDate: string): SplitsLeague[] {
  const active = SPLITS_LEAGUES.filter(league =>
    isLeagueInSeason(league, isoDate)
  );
  return active.length > 0 ? active : [...SPLITS_LEAGUES];
}

/**
 * Resolve a requested sport (route param, stored preference) against the
 * season calendar: honor it while in season, otherwise fall back to the
 * first in-season league.
 */
export function resolveInSeasonSport(
  requested: SplitsLeague,
  isoDate: string
): SplitsLeague {
  if (isLeagueInSeason(requested, isoDate)) return requested;
  return inSeasonLeagues(isoDate)[0] ?? requested;
}
