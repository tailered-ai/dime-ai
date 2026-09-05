import { ncaafConference } from "@shared/ncaafConferences";

export interface FeedFilters {
  status: string;
  league: string;
  conference: string;
  game: string;
}

export const DEFAULT_FEED_FILTERS: Readonly<FeedFilters> = Object.freeze({
  status: "all",
  league: "all",
  conference: "all",
  game: "all",
});

export interface FeedFilterOption {
  value: string;
  label: string;
}

export interface FeedFilterItem {
  id: string;
  league: string;
  status: string;
  awayCode: string;
  homeCode: string;
  awayName: string;
  homeName: string;
}

const normalizedStatus = (status: string) =>
  status.toLowerCase() === "upcoming" ? "scheduled" : status.toLowerCase();

function conferences(item: FeedFilterItem): string[] {
  if (item.league !== "NCAAF") return [];
  return [
    ncaafConference(item.awayCode),
    ncaafConference(item.homeCode),
  ].filter((conference): conference is string => conference !== null);
}

/** Filtering preserves source order, object identity, and distinct game ids. */
export function filterFeedItems<T extends FeedFilterItem>(
  items: readonly T[],
  filters: FeedFilters
): T[] {
  return items.filter(
    item =>
      (filters.status === "all" ||
        normalizedStatus(item.status) === normalizedStatus(filters.status)) &&
      (filters.league === "all" || item.league === filters.league) &&
      (filters.conference === "all" ||
        conferences(item).includes(filters.conference)) &&
      (filters.game === "all" || item.id === filters.game)
  );
}

/** Cascading options omit the "all" entry, which belongs to the control. */
export function feedFilterOptions(
  items: readonly FeedFilterItem[],
  filters: FeedFilters
): {
  leagues: FeedFilterOption[];
  conferences: FeedFilterOption[];
  games: FeedFilterOption[];
} {
  const statusItems = filterFeedItems(items, {
    ...DEFAULT_FEED_FILTERS,
    status: filters.status,
  });
  const leagueItems = filterFeedItems(statusItems, {
    ...DEFAULT_FEED_FILTERS,
    league: filters.league,
  });
  const gameItems = filterFeedItems(leagueItems, {
    ...DEFAULT_FEED_FILTERS,
    conference: filters.conference,
  });
  const games = gameItems.map(item => ({
    value: item.id,
    label: `${item.awayName} at ${item.homeName}`,
  }));
  const labelCounts = new Map<string, number>();
  for (const { label } of games) {
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  return {
    leagues: Array.from(new Set(statusItems.map(item => item.league))).map(
      league => ({
        value: league,
        label: league === "WC" ? "FIFA World Cup" : league,
      })
    ),
    conferences: Array.from(new Set(leagueItems.flatMap(conferences)))
      .sort()
      .map(conference => ({ value: conference, label: conference })),
    // The minimal feed identity has no start time/game number. Disambiguate
    // doubleheaders by their real id instead of inventing either one.
    games: games.map(option => ({
      ...option,
      label:
        labelCounts.get(option.label)! > 1
          ? `${option.label} (${option.value})`
          : option.label,
    })),
  };
}

/** Exact Gregorian ISO date, without Date's normalization of impossible days. */
export function isValidFeedDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || iso.startsWith("0000-")) return false;
  const date = new Date(`${iso}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso
  );
}

/** Calendar arithmetic uses UTC fields, independent of browser timezone/DST. */
export function shiftFeedDate(iso: string, days: number): string {
  if (!isValidFeedDate(iso) || !Number.isSafeInteger(days)) {
    throw new RangeError(
      "Expected a valid ISO feed date and whole calendar days"
    );
  }
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  if (!Number.isFinite(date.getTime()))
    throw new RangeError("Feed date out of range");
  const shifted = date.toISOString().slice(0, 10);
  if (!isValidFeedDate(shifted)) throw new RangeError("Feed date out of range");
  return shifted;
}

export function easternToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(part => part.type === type)!.value;
  return `${value("year").padStart(4, "0")}-${value("month")}-${value("day")}`;
}
