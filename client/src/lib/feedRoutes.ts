/**
 * feedRoutes — canonical navigation targets for the Dime AI surfaces.
 *
 * The ONLY link targets app code may emit for these surfaces:
 *   • AI Model Projections → /feed/model/MM-DD-YYYY
 *   • Betting Splits       → /betting-splits/{mlb|nhl|nba}-MM-DD-YYYY
 *
 * Legacy slugs (/feed, /feed?tab=…, /splits, /projections, /dashboard) must
 * never populate from any link, tab, or redirect default. They survive only
 * as permanent redirects INTO the paths built here (client: App.tsx,
 * server: server/_core/index.ts).
 */
import { todayUTC } from "@/components/CalendarPicker";

export type FeedSport = "MLB" | "WC" | "NCAAF";
export type SplitsSport = "MLB" | "NHL" | "NBA";

const SPLITS_SPORTS: readonly SplitsSport[] = ["MLB", "NHL", "NBA"];

/** YYYY-MM-DD → MM-DD-YYYY (the feed slug date form). */
export function toFeedSlugDate(iso: string): string {
  const [y, mo, d] = iso.split("-");
  return `${mo}-${d}-${y}`;
}

/**
 * Canonical combined AI Model Projections path, e.g. /feed/model/07-11-2026.
 * Defaults to today's effective feed date (todayUTC — the 07:00 UTC /
 * 00:00 PT rollover shared by the whole feed stack).
 */
export function feedModelPath(
  _sport: FeedSport = "MLB",
  isoDate?: string
): string {
  const iso = isoDate ?? todayUTC();
  return `/feed/model/${toFeedSlugDate(iso)}`;
}

/**
 * Canonical Betting Splits path, e.g. /betting-splits/mlb-07-11-2026.
 * This deliberately shares the feed builder's ISO → MM-DD-YYYY boundary;
 * callers and parsed state remain ISO-only.
 */
export function bettingSplitsPath(
  sport: SplitsSport = "MLB",
  isoDate?: string
): string {
  const iso = isoDate ?? todayUTC();
  return `/betting-splits/${sport.toLowerCase()}-${toFeedSlugDate(iso)}`;
}

/** Validates a /betting-splits/:sport route segment (case-insensitive). */
export function parseSplitsSport(seg: string | undefined): SplitsSport | null {
  const s = (seg ?? "").toUpperCase();
  return (SPLITS_SPORTS as readonly string[]).includes(s)
    ? (s as SplitsSport)
    : null;
}

function slugDateToIso(date: string): string | null {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(date);
  if (!match) return null;

  const [, mm, dd, yyyy] = match;
  const month = Number(mm);
  const day = Number(dd);
  const year = Number(yyyy);
  if (month < 1 || month > 12) return null;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (day < 1 || day > daysInMonth[month - 1]) return null;

  return `${yyyy}-${mm}-${dd}`;
}

function validIsoDate(iso: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return false;
  const [, yyyy, mm, dd] = match;
  return slugDateToIso(`${mm}-${dd}-${yyyy}`) === iso;
}

/**
 * Parses canonical combined slugs and the legacy split/bare route forms:
 *   mlb-07-11-2026      → { sport: "MLB", isoDate: "2026-07-11" }
 *   mlb / 07-11-2026    → { sport: "MLB", isoDate: "2026-07-11" }
 *   MLB                 → { sport: "MLB", isoDate: null }
 *
 * A null date means the route is recognized but must be replaced with today's
 * canonical dated URL. Invalid sports and calendar dates return null.
 */
export function parseBettingSplitsPath(
  sportSegment?: string,
  dateSegment?: string
): { sport: SplitsSport; isoDate: string | null } | null {
  let sportPart = sportSegment ?? "";
  let slugDate = dateSegment ?? "";

  if (!slugDate) {
    const combined = /^([a-z]+)-(\d{2}-\d{2}-\d{4})$/i.exec(sportPart);
    if (combined) [, sportPart, slugDate] = combined;
  }

  const sport = parseSplitsSport(sportPart);
  if (!sport) return null;
  if (!slugDate) return { sport, isoDate: null };

  const isoDate = slugDateToIso(slugDate);
  return isoDate ? { sport, isoDate } : null;
}

/**
 * Resolves every recognized or malformed splits route form to one dated URL.
 * A missing/invalid date falls back to today's effective date; an invalid sport
 * falls back to MLB. Passing the returned slug back through this function is
 * stable, which bounds client canonicalization to one redirect hop.
 */
export function canonicalBettingSplitsPath(
  sportSegment?: string,
  dateSegment?: string
): string {
  const parsed = parseBettingSplitsPath(sportSegment, dateSegment);
  return parsed?.isoDate
    ? bettingSplitsPath(parsed.sport, parsed.isoDate)
    : bettingSplitsPath(parsed?.sport ?? "MLB");
}

/**
 * Maps a legacy /feed?… URL onto its canonical replacement. Pure — pass the
 * query string (window.location.search); "" handles the bare /feed slug.
 *   ?tab=splits            → /betting-splits/mlb-MM-DD-YYYY
 *   ?sport=WC[&date=ISO]   → /feed/model/MM-DD-YYYY
 *   anything else          → /feed/model/MM-DD-YYYY (today, or legacy ?date=)
 */
export function legacyFeedRedirectTarget(search: string): string {
  const params = new URLSearchParams(search);
  const date = params.get("date");
  const iso = date && validIsoDate(date) ? date : undefined;
  if (params.get("tab") === "splits") return bettingSplitsPath("MLB", iso);
  const sport: FeedSport =
    (params.get("sport") ?? "").toUpperCase() === "WC" ? "WC" : "MLB";
  return feedModelPath(sport, iso);
}
