import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEED_FILTERS,
  easternToday,
  feedFilterOptions,
  filterFeedItems,
  isValidFeedDate,
  shiftFeedDate,
  type FeedFilterItem,
} from "./feedNavigation";

const items: readonly FeedFilterItem[] = Object.freeze(
  [
    {
      id: "ncaaf-1",
      league: "NCAAF",
      status: "final",
      awayCode: "ALA",
      homeCode: "OSU",
      awayName: "Alabama",
      homeName: "Ohio State",
    },
    {
      id: "ncaaf-2",
      league: "NCAAF",
      status: "scheduled",
      awayCode: "BRY",
      homeCode: "ARMY",
      awayName: "Bryant",
      homeName: "Army",
    },
    {
      id: "ncaaf-3",
      league: "NCAAF",
      status: "live",
      awayCode: "UGA",
      homeCode: "TEX",
      awayName: "Georgia",
      homeName: "Texas",
    },
    {
      id: "ncaaf-4",
      league: "NCAAF",
      status: "postponed",
      awayCode: "MICH",
      homeCode: "TENN",
      awayName: "Michigan",
      homeName: "Tennessee",
    },
    {
      id: "ncaaf-5",
      league: "NCAAF",
      status: "suspended",
      awayCode: "UNKNOWN",
      homeCode: "BRY",
      awayName: "Unknown",
      homeName: "Bryant",
    },
    {
      id: "wc-1",
      league: "WC",
      status: "scheduled",
      awayCode: "USA",
      homeCode: "MEX",
      awayName: "United States",
      homeName: "Mexico",
    },
    {
      id: "mlb-1",
      league: "MLB",
      status: "upcoming",
      awayCode: "NYY",
      homeCode: "BOS",
      awayName: "New York Yankees",
      homeName: "Boston Red Sox",
    },
    {
      id: "mlb-2",
      league: "MLB",
      status: "scheduled",
      awayCode: "NYY",
      homeCode: "BOS",
      awayName: "New York Yankees",
      homeName: "Boston Red Sox",
    },
  ].map(item => Object.freeze(item))
);

describe("feed filters", () => {
  it("preserves ordered card identity, including NCAAF kickoff order across statuses", () => {
    const result = filterFeedItems(items, DEFAULT_FEED_FILTERS);
    expect(result).toEqual(items);
    result.forEach((item, index) => expect(item).toBe(items[index]));
    expect(
      filterFeedItems(items, { ...DEFAULT_FEED_FILTERS, league: "NCAAF" }).map(
        item => item.id
      )
    ).toEqual(["ncaaf-1", "ncaaf-2", "ncaaf-3", "ncaaf-4", "ncaaf-5"]);
  });

  it("composes all dimensions, with either participant matching a conference", () => {
    const filters = {
      ...DEFAULT_FEED_FILTERS,
      conference: "Southeastern Conference",
    };
    expect(filterFeedItems(items, filters).map(item => item.id)).toEqual([
      "ncaaf-1",
      "ncaaf-3",
      "ncaaf-4",
    ]);
    expect(
      filterFeedItems(items, {
        ...filters,
        status: "live",
        league: "NCAAF",
        game: "ncaaf-3",
      })
    ).toEqual([items[2]]);
    expect(
      filterFeedItems(items, { ...filters, status: "live", game: "ncaaf-4" })
    ).toEqual([]);
    expect(filterFeedItems(items, { ...filters, league: "MLB" })).toEqual([]);
    expect(
      filterFeedItems(items, {
        ...DEFAULT_FEED_FILTERS,
        conference: "Sun Belt Conference",
      })
    ).toEqual([]); // WC's USA code must not become South Alabama.
  });

  it("keeps postponed/suspended truthful and maps only upcoming to scheduled", () => {
    expect(
      filterFeedItems(items, {
        ...DEFAULT_FEED_FILTERS,
        status: "scheduled",
      }).map(item => item.id)
    ).toEqual(["ncaaf-2", "wc-1", "mlb-1", "mlb-2"]);
    for (const status of ["live", "final", "postponed", "suspended"]) {
      expect(
        filterFeedItems(items, { ...DEFAULT_FEED_FILTERS, status }).map(
          item => item.status
        )
      ).toEqual([status]);
    }
    expect(
      filterFeedItems(items, { ...DEFAULT_FEED_FILTERS, status: "unknown" })
    ).toEqual([]);
  });

  it("derives cascading options while selected game cannot hide alternatives", () => {
    const options = feedFilterOptions(items, {
      status: "scheduled",
      league: "all",
      conference: "all",
      game: "mlb-1",
    });
    expect(options.leagues.map(option => option.value)).toEqual([
      "NCAAF",
      "WC",
      "MLB",
    ]);
    expect(options.conferences.map(option => option.value)).toEqual([
      "American Conference",
    ]);
    expect(options.games.map(option => option.value)).toEqual([
      "ncaaf-2",
      "wc-1",
      "mlb-1",
      "mlb-2",
    ]);
    const doubleheader = options.games.filter(option =>
      option.value.startsWith("mlb")
    );
    expect(new Set(doubleheader.map(option => option.label)).size).toBe(2);
    const collegeOptions = feedFilterOptions(items, {
      ...DEFAULT_FEED_FILTERS,
      league: "NCAAF",
      conference: "Southeastern Conference",
      game: "stale",
    });
    expect(collegeOptions.games.map(option => option.value)).toEqual([
      "ncaaf-1",
      "ncaaf-3",
      "ncaaf-4",
    ]);
    expect(collegeOptions.conferences.map(option => option.value)).toEqual([
      "American Conference",
      "Big Ten Conference",
      "Southeastern Conference",
    ]);
    expect(feedFilterOptions([], DEFAULT_FEED_FILTERS)).toEqual({
      leagues: [],
      conferences: [],
      games: [],
    });
  });

  it("selects every supported league and each doubleheader by stable id", () => {
    for (const league of ["NCAAF", "MLB", "WC"]) {
      const options = feedFilterOptions(items, {
        ...DEFAULT_FEED_FILTERS,
        league,
      });
      for (const option of options.games) {
        const result = filterFeedItems(items, {
          ...DEFAULT_FEED_FILTERS,
          league,
          game: option.value,
        });
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe(option.value);
      }
      if (league !== "NCAAF") expect(options.conferences).toEqual([]);
    }
  });
});

describe("feed calendar dates", () => {
  it("requires exact real Gregorian dates, including century leap rules", () => {
    for (const date of [
      "0001-01-01",
      "2024-02-29",
      "2000-02-29",
      "2026-09-05",
      "9999-12-31",
    ]) {
      expect(isValidFeedDate(date), date).toBe(true);
    }
    for (const date of [
      "",
      "0000-01-01",
      "2026-02-29",
      "1900-02-29",
      "2100-02-29",
      "2026-04-31",
      "2026-00-10",
      "2026-13-01",
      "2026-01-00",
      "2026-1-01",
      "2026-01-1",
      " 2026-01-01",
      "2026-01-01T00:00:00Z",
      "10000-01-01",
    ]) {
      expect(isValidFeedDate(date), date).toBe(false);
    }
  });

  it("shifts whole calendar days across DST, leap days, months, years and early years", () => {
    for (const [from, days, to] of [
      ["2026-03-08", 1, "2026-03-09"],
      ["2026-11-01", -1, "2026-10-31"],
      ["2024-02-28", 2, "2024-03-01"],
      ["2026-02-28", 1, "2026-03-01"],
      ["2026-12-31", 1, "2027-01-01"],
      ["2000-03-01", -1, "2000-02-29"],
      ["0100-01-01", -1, "0099-12-31"],
    ] as const) {
      expect(shiftFeedDate(from, days)).toBe(to);
      expect(shiftFeedDate(to, -days)).toBe(from);
    }
  });

  it("rejects invalid navigation rather than silently normalizing it", () => {
    for (const [date, days] of [
      ["2026-02-30", 1],
      ["2026-09-05", 0.5],
      ["2026-09-05", Infinity],
      ["2026-09-05", NaN],
      ["9999-12-31", 1],
      ["0001-01-01", -1],
      ["2026-09-05", Number.MAX_SAFE_INTEGER],
    ] as const) {
      expect(() => shiftFeedDate(date, days)).toThrow(RangeError);
    }
  });

  it("calculates today at Eastern midnight under EST and EDT", () => {
    for (const [instant, date] of [
      ["2026-01-01T04:59:59Z", "2025-12-31"],
      ["2026-01-01T05:00:00Z", "2026-01-01"],
      ["2026-07-01T03:59:59Z", "2026-06-30"],
      ["2026-07-01T04:00:00Z", "2026-07-01"],
      ["2026-03-08T07:00:00Z", "2026-03-08"],
      ["2026-11-01T06:00:00Z", "2026-11-01"],
    ])
      expect(easternToday(new Date(instant))).toBe(date);
  });
});
