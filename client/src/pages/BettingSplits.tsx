/**
 * BettingSplits page
 *
 * Shows matchup/score + BETTING SPLITS for every game across all leagues.
 * ODDS/LINES model projections are intentionally hidden — use Model Projections for those.
 */

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { CalendarX, Loader2, Search, X } from "lucide-react"; // 2026-08-05: lab flask was off-domain for an empty slate
import { CalendarPicker, todayUTC } from "@/components/CalendarPicker";
import { bettingSplitsPath } from "@/lib/feedRoutes";
import { useTrackAction } from "@/lib/analytics";
import {
  resolveSplitsServerDate,
  shouldAutoAdvance,
  type SplitsDateSource,
} from "./dime-shell/splitsDateState";
// Splits-surface interaction styles ride this chunk (NOT the chat critical
// path — see the bundle budget note in splits-interactions.css).
import "@/styles/splits-interactions.css";

// CDN icon URLs
const CDN_NBA =
  "https://d2xsxph8kpxj0f.cloudfront.net/310519663397752079/MW3FicTy7ae3qrm8dx8Lua/icon-nba_3fa4f508.png";

// League pill logos — rendered only for in-season leagues (see leagueSeasons).
const LEAGUE_LOGOS: Record<SplitsLeague, string> = {
  NCAAF:
    "https://a.espncdn.com/redesign/assets/img/icons/ESPN-icon-football-college.png",
  MLB: "https://www.mlbstatic.com/team-logos/league-on-dark/1.svg",
  NHL: "https://assets.nhle.com/logos/nhl/svg/NHL_light.svg",
  NBA: CDN_NBA,
};

import { GameCard } from "@/components/GameCard";
import { AgeModal } from "@/components/AgeModal";
import { inSeasonLeagues, type SplitsLeague } from "@/lib/leagueSeasons";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAppAuth } from "@/_core/hooks/useAppAuth";
import { getNbaTeamByDbSlug } from "@shared/nbaTeams";
import { NHL_BY_DB_SLUG } from "@shared/nhlTeams";
import { ncaafSchoolName } from "@shared/ncaafSchoolNames";
import { MLB_BY_ABBREV } from "@shared/mlbTeams";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatMilitaryTime(time: string | null | undefined): string {
  if (!time) return "TBD";
  const upper = time.trim().toUpperCase();
  if (upper === "TBD" || upper === "TBA" || upper === "") return "TBD";
  const [hStr, mStr] = time.split(":");
  const h = parseInt(hStr ?? "0", 10);
  const m = parseInt(mStr ?? "0", 10);
  if (isNaN(h) || isNaN(m)) return "TBD";
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${suffix} ET`;
}

function timeToMinutes(time: string | null | undefined): number {
  if (!time || time.toUpperCase() === "TBD" || time.toUpperCase() === "TBA")
    return 9999;
  const [hStr, mStr] = time.split(":");
  const h = parseInt(hStr ?? "0", 10);
  const m = parseInt(mStr ?? "0", 10);
  if (isNaN(h) || isNaN(m)) return 9999;
  return h * 60 + m;
}

/** Games starting at midnight (00:00 ET) are stored under their correct calendar
 * date by the backend. No frontend date adjustment needed. */
function effectiveGameDate(
  gameDate: string,
  _startTimeEst: string | null | undefined
): string {
  return gameDate;
}

/** Sort key: midnight (00:00) sorts first (beginning of day = 0 minutes) */
function sortableMinutes(time: string | null | undefined): number {
  return timeToMinutes(time);
}

function formatDateHeader(dateStr: string): string {
  try {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function formatDateShort(dateStr: string): string {
  try {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return dateStr;
  }
}

// ─── Team Logo Badge ──────────────────────────────────────────────────────────
function TeamBadge({ slug, size = 32 }: { slug: string; size?: number }) {
  const nba = getNbaTeamByDbSlug(slug);
  const nhl = !nba ? (NHL_BY_DB_SLUG.get(slug) ?? null) : null;
  const mlb = !nba && !nhl ? (MLB_BY_ABBREV.get(slug) ?? null) : null;
  const logo = nba?.logoUrl ?? nhl?.logoUrl ?? mlb?.logoUrl;
  const initials = (
    nba?.name ??
    nhl?.name ??
    mlb?.name ??
    slug.replace(/_/g, " ")
  )
    .slice(0, 2)
    .toUpperCase();
  // Enforce minimum 32px for touch targets and visual clarity
  const actualSize = Math.max(32, size);
  return (
    <div
      className="rounded overflow-hidden bg-secondary flex items-center justify-center flex-shrink-0"
      style={{ width: actualSize, height: actualSize }}
    >
      {logo ? (
        <img
          src={logo}
          alt={initials}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            mixBlendMode: "screen",
            // Enhanced visibility: brightness lifts dark logos, contrast sharpens, saturate keeps vivid
            // brightness(1.7): lifts dark logos (A's green, Padres brown) without blowing out bright logos
            filter:
              "brightness(1.7) contrast(1.12) saturate(1.35) drop-shadow(0 0 4px transparent)",
          }}
        />
      ) : (
        <span
          style={{ fontSize: Math.max(7, Math.round(actualSize * 0.28)) }}
          className="font-bold text-muted-foreground"
        >
          {initials}
        </span>
      )}
    </div>
  );
}

// ─── Search Result Row ────────────────────────────────────────────────────────
type GameRow = {
  id: number;
  awayTeam: string;
  homeTeam: string;
  sport?: string | null;
  gameDate: string;
  startTimeEst: string | null;
  awayBookSpread?: string | null;
};

export function SearchResultRow({
  game,
  onClick,
}: {
  game: GameRow;
  onClick: () => void;
}) {
  const isNcaaf = game.sport === "NCAAF";
  const awayNba = isNcaaf ? null : getNbaTeamByDbSlug(game.awayTeam);
  const homeNba = isNcaaf ? null : getNbaTeamByDbSlug(game.homeTeam);
  const awayNhl =
    !isNcaaf && !awayNba ? (NHL_BY_DB_SLUG.get(game.awayTeam) ?? null) : null;
  const homeNhl =
    !isNcaaf && !homeNba ? (NHL_BY_DB_SLUG.get(game.homeTeam) ?? null) : null;
  const awayMlb =
    !isNcaaf && !awayNba && !awayNhl
      ? (MLB_BY_ABBREV.get(game.awayTeam) ?? null)
      : null;
  const homeMlb =
    !isNcaaf && !homeNba && !homeNhl
      ? (MLB_BY_ABBREV.get(game.homeTeam) ?? null)
      : null;
  const awaySchool = isNcaaf
    ? ncaafSchoolName(game.awayTeam)
    : (awayNba?.city ??
      awayNhl?.city ??
      awayMlb?.city ??
      game.awayTeam.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()));
  const awayNick =
    awayNba?.nickname ?? awayNhl?.nickname ?? awayMlb?.nickname ?? "";
  const homeSchool = isNcaaf
    ? ncaafSchoolName(game.homeTeam)
    : (homeNba?.city ??
      homeNhl?.city ??
      homeMlb?.city ??
      game.homeTeam.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()));
  const homeNick =
    homeNba?.nickname ?? homeNhl?.nickname ?? homeMlb?.nickname ?? "";
  // Official abbreviations for responsive display — never truncated
  const awayAbbr =
    awayNba?.abbrev ??
    awayNhl?.abbrev ??
    awayMlb?.abbrev ??
    game.awayTeam
      .split(/[_\s]+/)
      .map(w => w[0]?.toUpperCase() ?? "")
      .join("")
      .slice(0, 3);
  const homeAbbr =
    homeNba?.abbrev ??
    homeNhl?.abbrev ??
    homeMlb?.abbrev ??
    game.homeTeam
      .split(/[_\s]+/)
      .map(w => w[0]?.toUpperCase() ?? "")
      .join("")
      .slice(0, 3);
  const time = formatMilitaryTime(game.startTimeEst);
  const dateShort = formatDateShort(game.gameDate);
  return (
    <button
      type="button"
      onClick={onClick}
      className="bs-result w-full text-left"
    >
      <div className="flex items-center px-3 py-2.5 gap-2">
        {/* Away team: logo + responsive name */}
        <div
          className="flex items-center gap-2"
          style={{ flex: "1 1 0", minWidth: 0 }}
        >
          <TeamBadge slug={game.awayTeam} size={32} />
          <div className="flex flex-col" style={{ minWidth: 0 }}>
            {/* xs/sm: abbreviation only — never truncates */}
            <span
              className="font-bold leading-tight sm:hidden"
              style={{
                fontSize: 12,
                whiteSpace: isNcaaf ? "normal" : "nowrap",
                letterSpacing: "0.06em",
                color: "var(--dime-text-primary)",
              }}
            >
              {isNcaaf ? awaySchool : awayAbbr}
            </span>
            {/* sm+: city name + nickname — nowrap, no ellipsis */}
            <span
              className="font-bold leading-tight hidden sm:block"
              style={{
                fontSize: 12,
                whiteSpace: isNcaaf ? "normal" : "nowrap",
                color: "var(--dime-text-primary)",
              }}
            >
              {awaySchool}
            </span>
            {awayNick && (
              <span
                className="bs-nick font-normal leading-tight hidden sm:block"
                style={{
                  fontSize: 10,
                  whiteSpace: isNcaaf ? "normal" : "nowrap",
                  color: "var(--dime-text-secondary)",
                }}
              >
                {awayNick}
              </span>
            )}
          </div>
        </div>
        {/* Center: @ + date + time */}
        <div
          className="flex flex-col items-center flex-shrink-0"
          style={{ minWidth: 60 }}
        >
          <span
            className="text-sm font-medium leading-tight"
            style={{ color: "var(--dime-text-secondary)" }}
          >
            @
          </span>
          <span
            className="text-xs leading-tight text-center whitespace-nowrap mt-0.5"
            style={{ color: "var(--dime-text-secondary)" }}
          >
            {dateShort}
          </span>
          <span
            className="text-xs leading-tight text-center whitespace-nowrap"
            style={{ color: "var(--dime-text-secondary)" }}
          >
            {time}
          </span>
        </div>
        {/* Home team: responsive name + logo */}
        <div
          className="flex items-center gap-2 justify-end"
          style={{ flex: "1 1 0", minWidth: 0 }}
        >
          <div className="flex flex-col items-end" style={{ minWidth: 0 }}>
            {/* xs/sm: abbreviation only — never truncates */}
            <span
              className="font-bold leading-tight sm:hidden"
              style={{
                fontSize: 12,
                whiteSpace: isNcaaf ? "normal" : "nowrap",
                letterSpacing: "0.06em",
                color: "var(--dime-text-primary)",
              }}
            >
              {isNcaaf ? homeSchool : homeAbbr}
            </span>
            {/* sm+: city name + nickname — nowrap, no ellipsis */}
            <span
              className="font-bold leading-tight hidden sm:block"
              style={{
                fontSize: 12,
                whiteSpace: isNcaaf ? "normal" : "nowrap",
                color: "var(--dime-text-primary)",
              }}
            >
              {homeSchool}
            </span>
            {homeNick && (
              <span
                className="bs-nick font-normal leading-tight hidden sm:block"
                style={{
                  fontSize: 10,
                  whiteSpace: isNcaaf ? "normal" : "nowrap",
                  color: "var(--dime-text-secondary)",
                }}
              >
                {homeNick}
              </span>
            )}
          </div>
          <TeamBadge slug={game.homeTeam} size={32} />
        </div>
      </div>
    </button>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export interface BettingSplitsPageProps {
  initialSport?: SplitsLeague;
  /** ISO date parsed from the canonical URL; URL state is authoritative. */
  initialDate?: string;
  /**
   * Whether initialDate was a deliberate deep link or an application default.
   * Canonical redirects date every URL, so the URL shape cannot carry this.
   * Auto-advance only ever moves an app-default date.
   */
  initialDateSource?: SplitsDateSource;
  /** Allows the shell to preserve a local-only preview capability in route changes. */
  resolveRouteHref?: (href: string) => string;
  /** Shell pane already exposes an sr-only h1; standalone this page owns it. */
  embeddedInShell?: boolean;
}

const identityRouteHref = (href: string) => href;

export default function BettingSplitsPage({
  initialSport = "NCAAF",
  initialDate,
  initialDateSource = initialDate ? "url-explicit" : "app-default",
  resolveRouteHref = identityRouteHref,
  embeddedInShell = false,
}: BettingSplitsPageProps) {
  const [, setLocation] = useLocation();
  const trackAction = useTrackAction();
  const [showAgeModal, setShowAgeModal] = useState(false);
  // Sport is seeded from the canonical route (/betting-splits/:sport) and the
  // URL is kept in sync on pill changes so the address bar stays shareable.
  const [selectedSport, setSelectedSportState] =
    useState<SplitsLeague>(initialSport);
  const [selectedDate, setSelectedDateState] = useState<string>(
    initialDate ?? todayUTC()
  );
  const userSelectedDateRef = useRef(false);
  const setSelectedSport = useCallback(
    (sport: SplitsLeague) => {
      setSelectedSportState(sport);
      // Analytics: fire-and-forget, inert until the pipeline is enabled server-side.
      trackAction("splits_sport_switched", { props: { sport } });
      setLocation(resolveRouteHref(bettingSplitsPath(sport, selectedDate)));
    },
    [selectedDate, setLocation, resolveRouteHref, trackAction]
  );
  const setSelectedDate = useCallback(
    (date: string) => {
      userSelectedDateRef.current = true;
      setSelectedDateState(date);
      // Analytics: fire-and-forget, inert until the pipeline is enabled server-side.
      // No props — the specific date is not a low-cardinality scalar.
      trackAction("splits_date_navigated");
      setLocation(resolveRouteHref(bettingSplitsPath(selectedSport, date)));
    },
    [selectedSport, setLocation, resolveRouteHref, trackAction]
  );
  useEffect(() => {
    setSelectedSportState(initialSport);
  }, [initialSport]);
  useEffect(() => {
    if (initialDate) setSelectedDateState(initialDate);
  }, [initialDate]);
  const [selectedStatuses, setSelectedStatuses] = useState<
    Set<"upcoming" | "live" | "final">
  >(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const [headerHeight, setHeaderHeight] = useState(88);

  useEffect(() => {
    if (!headerRef.current) return;
    const obs = new ResizeObserver(() => {
      setHeaderHeight(
        Math.ceil(headerRef.current?.getBoundingClientRect().height ?? 88)
      );
    });
    obs.observe(headerRef.current);
    setHeaderHeight(
      Math.ceil(headerRef.current.getBoundingClientRect().height)
    );
    return () => obs.disconnect();
  }, []);

  const {
    appUser,
    isOwner,
    loading: appAuthLoading,
    refetch: refetchAppUser,
  } = useAppAuth();

  // Age modal shown for logged-in users who haven't accepted terms.
  // NOTE: No auth guard redirect — the page is fully public. Unauthenticated users can view splits.
  useEffect(() => {
    if (!appAuthLoading && appUser && !appUser.termsAccepted)
      setShowAgeModal(true);
  }, [appAuthLoading, appUser]);
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node))
        setSearchFocused(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const acceptTermsMutation = trpc.appUsers.acceptTerms.useMutation({
    onSuccess: () => {
      refetchAppUser();
      setShowAgeModal(false);
    },
  });
  const utils = trpc.useUtils();
  const closeSessionMutation = trpc.metrics.closeSession.useMutation();
  const appLogoutMutation = trpc.appUsers.logout.useMutation({
    onSuccess: async () => {
      // [FIX] Immediately zero-out the appUsers.me cache so the Discord button
      // disappears before the redirect fires. Without this, the 5-min staleTime
      // keeps appUser non-null and the Discord button stays rendered after logout.
      utils.appUsers.me.setData(undefined, null);
      await utils.appUsers.me.invalidate();
      toast.success("Signed out");
      // [FIX] Hard redirect — wouter setLocation("/") bounces back to /feed
      // because App.tsx redirects / → /feed. Hard redirect clears all cache.
      window.location.href = "/login";
    },
  });
  const appLogout = () => {
    closeSessionMutation.mutate();
    appLogoutMutation.mutate();
  };

  useEffect(() => {
    setSelectedStatuses(new Set());
  }, [selectedSport]);

  // ─── Fix 1: Remove auth gate — games.list is a publicProcedure, no login required ───────────────
  // Previously: { enabled: isAppAuthed } blocked the query for unauthenticated users.
  // When appUser=null AND appAuthLoading=false: isAppAuthed=false, gamesLoading=false,
  // appAuthLoading=false → NO spinner shown, NO games loaded → "No games found" shown.
  // games.list is declared as publicProcedure on the server — no auth required.
  const isAppAuthed = !appAuthLoading && Boolean(appUser);
  const { data: sourceGames, isLoading: gamesLoading } =
    trpc.games.list.useQuery(
      { sport: selectedSport, gameDate: selectedDate },
      {
        enabled: true, // FIX 1: always enabled — games.list is public
        refetchOnWindowFocus: false,
        refetchInterval: 60 * 1000,
        staleTime: 30 * 1000,
      }
    );

  const allGames = useMemo(
    () =>
      sourceGames?.map(game =>
        game.bettingSplitsSnapshot
          ? { ...game, ...game.bettingSplitsSnapshot }
          : game
      ),
    [sourceGames]
  );

  const dkSnapshot =
    sourceGames?.length && sourceGames.every(game => game.bettingSplitsSnapshot)
      ? sourceGames[0].bettingSplitsSnapshot
      : null;

  // ─── Fix 2: Server-authoritative date sync ───────────────────────────────────────────────────────
  // BettingSplits previously had NO server date sync — selectedDate was computed ONCE at mount
  // via todayUTC() and never updated. If the user kept the page open across the 11:00 UTC boundary,
  // selectedDate stayed as yesterday while the server window advanced to today → 0 games shown.
  // Mirror the same getCurrentDate sync that ModelProjections uses.
  const { data: serverDateData } = trpc.games.getCurrentDate.useQuery(
    undefined,
    {
      refetchInterval: 60 * 1000,
      staleTime: 30 * 1000,
    }
  );
  useEffect(() => {
    if (!serverDateData) return;
    const serverDate = resolveSplitsServerDate(
      selectedDate,
      serverDateData.effectiveDate,
      initialDate,
      userSelectedDateRef.current
    );
    if (serverDate !== selectedDate) {
      console.log(
        `[BettingSplits][DateSync] Syncing selectedDate from client=${selectedDate} to server=${serverDate}` +
          ` (utcHour=${serverDateData.utcHour}, beforeCutoff=${serverDateData.isBeforeCutoff})`
      );
      setSelectedDateState(serverDate);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverDateData, initialDate, selectedDate]);

  // ── In-season league gating ──────────────────────────────────────────────────
  // Off-season leagues have no games, splits, or history — their pills are dead
  // UI. Gate on the server's effective slate date (authoritative) with a client
  // UTC fallback; leagueSeasons fails open so the league row can never blank.
  // Out-of-season deep links (e.g. /betting-splits/nba-… in July) resolve to the
  // first in-season league with a replace navigation — no history spam.
  const seasonDate = serverDateData?.effectiveDate ?? todayUTC();
  const activeLeagues = useMemo(
    () => inSeasonLeagues(seasonDate),
    [seasonDate]
  );
  useEffect(() => {
    if (activeLeagues.includes(selectedSport)) return;
    const fallback = activeLeagues[0];
    if (!fallback) return;
    // Drop the requested date too: an off-season deep link's date belongs to
    // the dead league's calendar — land on the fallback league's live slate.
    setSelectedSportState(fallback);
    setSelectedDateState(todayUTC());
    setLocation(resolveRouteHref(bettingSplitsPath(fallback)), {
      replace: true,
    });
  }, [activeLeagues, selectedSport, setLocation, resolveRouteHref]);

  const { data: availableDatesData } = trpc.games.getAvailableDates.useQuery(
    { sport: selectedSport },
    { staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false }
  );

  const liveCount = useMemo(
    () => (allGames ?? []).filter(g => g?.gameStatus === "live").length,
    [allGames]
  );

  const toggleStatus = (status: "upcoming" | "live" | "final") => {
    // Analytics: fire-and-forget, inert until the pipeline is enabled server-side.
    // `status` is a fixed 3-value enum — low-cardinality, no PII.
    trackAction("splits_filtered", { props: { status } });
    setSelectedStatuses(prev => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      if (next.size === 3) return new Set();
      return next;
    });
  };

  const parseLiveSortKey = (gameClock: string | null): [number, number] => {
    if (!gameClock) return [-1, 9999];
    const upper = gameClock.trim().toUpperCase();
    if (upper === "HALF" || upper === "HALFTIME") return [2, 0];
    const bareOtMatch = upper.match(/^(\d*)OT$/);
    if (bareOtMatch) {
      const otNum = bareOtMatch[1] ? parseInt(bareOtMatch[1]) : 1;
      return [50 + otNum, 0];
    }
    const clockOtMatch = upper.match(/^(\d{1,2}):(\d{2})\s+(\d*)OT$/);
    if (clockOtMatch) {
      const mins = parseInt(clockOtMatch[1]!);
      const secs = parseInt(clockOtMatch[2]!);
      const otNum = clockOtMatch[3] ? parseInt(clockOtMatch[3]) : 1;
      return [50 + otNum, mins * 60 + secs];
    }
    const clockMatch = upper.match(/^(\d{1,2}):(\d{2})\s+(\d+)(ST|ND|RD|TH)?$/);
    if (clockMatch) {
      const mins = parseInt(clockMatch[1]!);
      const secs = parseInt(clockMatch[2]!);
      const period = parseInt(clockMatch[3]!);
      return [period, mins * 60 + secs];
    }
    return [-1, 9999];
  };

  const compareGames = (
    a: NonNullable<typeof allGames>[number],
    b: NonNullable<typeof allGames>[number]
  ): number => {
    // NCAAF stays in Eastern kickoff order as games move through their lifecycle.
    if (a?.sport === "NCAAF" && b?.sport === "NCAAF")
      return sortableMinutes(a.startTimeEst) - sortableMinutes(b.startTimeEst);
    const statusOrder = (s: string | null | undefined) =>
      s === "live" ? 0 : s === "upcoming" ? 1 : s === "final" ? 2 : 3;
    const sSortA = statusOrder(a?.gameStatus);
    const sSortB = statusOrder(b?.gameStatus);
    if (sSortA !== sSortB) return sSortA - sSortB;
    if (a?.gameStatus === "live" && b?.gameStatus === "live") {
      const [periodA, clockA] = parseLiveSortKey(a?.gameClock ?? null);
      const [periodB, clockB] = parseLiveSortKey(b?.gameClock ?? null);
      if (periodA !== periodB) return periodB - periodA;
      return clockA - clockB;
    }
    return sortableMinutes(a?.startTimeEst) - sortableMinutes(b?.startTimeEst);
  };

  // All unique dates available for the current sport (sorted ascending)
  const allDates = useMemo(
    () => availableDatesData?.dates ?? [],
    [availableDatesData?.dates]
  );

  // ─── Fix 3: Auto-advance selectedDate when it has no games ──────────────────────────────────────
  // BettingSplits previously had NO auto-advance. If selectedDate was not in allDates
  // (e.g. stale date after boundary crossing), the page stayed stuck on an empty view.
  // Mirror the same guarded auto-advance that ModelProjections uses.
  useEffect(() => {
    if (!allGames || allDates.length === 0) return; // still loading
    const hasGamesOnDate = allDates.includes(selectedDate);
    if (hasGamesOnDate) return; // selectedDate is valid — no advance needed
    // Guard: only auto-advance if selectedDate is BEFORE the server's effective window start.
    // If effectiveDate is available and selectedDate >= effectiveDate, the dates cache may be
    // stale — do NOT advance, as that would skip to a future date with no published games.
    const effectiveDate = serverDateData?.effectiveDate;
    const blockedByEffectiveWindow = Boolean(
      effectiveDate && selectedDate >= effectiveDate
    );
    const advance = shouldAutoAdvance({
      dateSource: initialDateSource,
      userSelected: userSelectedDateRef.current,
      datesLoaded: true,
      hasGamesOnSelectedDate: false,
      blockedByEffectiveWindow,
    });
    if (!advance) {
      if (blockedByEffectiveWindow) {
        console.warn(
          `[BettingSplits][AutoAdvance] BLOCKED — selectedDate=${selectedDate} >= effectiveDate=${effectiveDate}. ` +
            `allDates=${JSON.stringify(allDates.slice(0, 5))} — stale rolling window, not advancing.`
        );
      }
      return;
    }
    // App-default date genuinely before the window — advance to first available date.
    console.log(
      `[BettingSplits][AutoAdvance] FIRED — selectedDate=${selectedDate} < effectiveDate=${effectiveDate ?? "unknown"}. ` +
        `Advancing to allDates[0]=${allDates[0]}`
    );
    setSelectedDateState(allDates[0]!);
  }, [allDates, selectedDate, serverDateData, initialDateSource, allGames]);

  // ─── Fix 4: Diagnostic logging when allGames=0 ──────────────────────────────────────────────────
  useEffect(() => {
    if (!allGames || gamesLoading) return;
    if (allGames.length === 0) {
      console.warn(
        `[BettingSplits][DIAG] allGames=0 for sport=${selectedSport} date=${selectedDate}. ` +
          `serverDate=${serverDateData?.effectiveDate ?? "loading"} ` +
          `utcHour=${serverDateData?.utcHour ?? "?"} ` +
          `beforeCutoff=${serverDateData?.isBeforeCutoff ?? "?"} ` +
          `isAppAuthed=${isAppAuthed} appAuthLoading=${appAuthLoading}`
      );
    }
  }, [
    allGames,
    gamesLoading,
    selectedSport,
    selectedDate,
    serverDateData,
    isAppAuthed,
    appAuthLoading,
  ]);

  const games = useMemo(() => {
    if (!allGames) return allGames;
    let working =
      selectedStatuses.size === 0
        ? allGames
        : allGames.filter(g =>
            selectedStatuses.has(g?.gameStatus as "upcoming" | "live" | "final")
          );
    working = working.filter(
      g => g && effectiveGameDate(g.gameDate, g.startTimeEst) === selectedDate
    );
    const byDate: Record<string, NonNullable<typeof allGames>[number][]> = {};
    for (const g of working) {
      const d = effectiveGameDate(g!.gameDate, g!.startTimeEst);
      if (!byDate[d]) byDate[d] = [];
      byDate[d]!.push(g!);
    }
    const result: NonNullable<typeof allGames>[number][] = [];
    for (const d of Object.keys(byDate).sort())
      result.push(...byDate[d]!.sort(compareGames));
    return result;
  }, [allGames, selectedStatuses, selectedDate]);

  const { data: lastRefresh } = trpc.games.lastRefresh.useQuery(undefined, {
    refetchInterval: 60_000,
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const splitsAgoLabel = useMemo(() => {
    // A different league's successful job does not establish NCAAF freshness.
    const captures =
      selectedSport === "NCAAF"
        ? sourceGames?.map(game =>
            game.ingestionReceivedAt
              ? new Date(game.ingestionReceivedAt).getTime()
              : NaN
          )
        : undefined;
    const timestamp =
      captures?.length &&
      captures.every(time => Number.isFinite(time) && time <= now)
        ? Math.min(...captures)
        : selectedSport === "NCAAF"
          ? null
          : lastRefresh?.refreshedAt;
    if (timestamp == null) return "—";
    const diffMs = now - new Date(timestamp).getTime();
    const diffMin = Math.round(diffMs / 60_000);
    if (diffMin < 1) return "just now";
    if (diffMin === 1) return "1 min ago";
    if (diffMin < 60) return `${diffMin} min ago`;
    const diffHr = Math.round(diffMin / 60);
    return diffHr === 1 ? "1 hr ago" : `${diffHr} hrs ago`;
  }, [lastRefresh, now, selectedSport, sourceGames]);

  const q = searchQuery.trim().toLowerCase();
  const dropdownResults = useMemo(() => {
    if (!games || !q) return [];
    return [
      ...games.filter(game => {
        if (!game) return false;
        const awayNba = getNbaTeamByDbSlug(game.awayTeam);
        const homeNba = getNbaTeamByDbSlug(game.homeTeam);
        const terms = [
          ...(game.sport === "NCAAF"
            ? [ncaafSchoolName(game.awayTeam), ncaafSchoolName(game.homeTeam)]
            : []),
          awayNba?.name ?? "",
          awayNba?.nickname ?? "",
          game.awayTeam.replace(/_/g, " "),
          homeNba?.name ?? "",
          homeNba?.nickname ?? "",
          game.homeTeam.replace(/_/g, " "),
        ].map(s => s.toLowerCase());
        return terms.some(t => t.includes(q));
      }),
    ].sort((a, b) => {
      const dateCmp = (a!.gameDate ?? "").localeCompare(b!.gameDate ?? "");
      if (dateCmp !== 0) return dateCmp;
      return timeToMinutes(a!.startTimeEst) - timeToMinutes(b!.startTimeEst);
    });
  }, [games, q]);

  const showDropdown = searchFocused && q.length > 0;

  const gamesByDate = useMemo(
    () =>
      (games ?? []).reduce<Record<string, NonNullable<typeof games>[number][]>>(
        (acc, game) => {
          const date = effectiveGameDate(game!.gameDate, game!.startTimeEst);
          if (!acc[date]) acc[date] = [];
          acc[date]!.push(game!);
          return acc;
        },
        {}
      ),
    [games]
  );
  const sortedDates = useMemo(
    () => Object.keys(gamesByDate).sort((a, b) => a.localeCompare(b)),
    [gamesByDate]
  );

  const scrollToGame = (gameId: number) => {
    setSearchFocused(false);
    setSearchQuery("");
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    setTimeout(() => {
      const el = document.getElementById(`game-card-${gameId}`);
      if (!el) return;
      el.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "center",
      });
      el.style.outline = "2px solid var(--dime-mint)";
      el.style.borderRadius = "12px";
      if (reducedMotion) {
        // Static highlight, no pulse — clears after the same total dwell time
        setTimeout(() => {
          el.style.outline = "";
          el.style.borderRadius = "";
        }, 2100);
        return;
      }
      // 2026-08-05: brand motion law — the one 160ms curve, not generic ease
      el.style.transition =
        "box-shadow 160ms cubic-bezier(0.16, 1, 0.3, 1), outline 160ms cubic-bezier(0.16, 1, 0.3, 1)";
      el.style.boxShadow = "0 0 0 4px transparent";
      let count = 0;
      const pulse = setInterval(() => {
        count++;
        if (count % 2 === 0) {
          el.style.boxShadow = "0 0 0 4px transparent";
          el.style.outline = "2px solid var(--dime-mint)";
        } else {
          el.style.boxShadow = "0 0 0 2px transparent";
          el.style.outline = "2px solid var(--dime-mint)";
        }
        if (count >= 5) {
          clearInterval(pulse);
          setTimeout(() => {
            el.style.outline = "";
            el.style.boxShadow = "";
            el.style.borderRadius = "";
            el.style.transition = "";
          }, 600);
        }
      }, 300);
    }, 120);
  };

  return (
    <div className="bs-page bg-background">
      {showAgeModal && (
        <AgeModal
          onAccept={() => acceptTermsMutation.mutate()}
          onClose={appLogout}
        />
      )}

      {/* ── Sticky Header ── */}
      <header
        ref={headerRef}
        className="bs-header sticky top-0 z-40 bg-background backdrop-blur-sm"
      >
        {/* Row 1: Dime wordmark — the profile control lives in the shell
            sidebar (bottom-left); this header carries brand only. Hidden at
            768–1023px where the shell's compact bar already shows the mark. */}
        <div className="bs-brand-row flex items-center justify-center px-4 pt-2.5 pb-1.5">
          <span className="dime-wordmark" aria-label="dime">
            d
            <span className="dime-wordmark-i">
              ı<span className="dime-coindot" />
            </span>
            me
          </span>
        </div>

        {/* No page-tab row on mobile — the bottom tab bar (Feed | Splits | Chat |
            Props | Profile) is the only <768px navigation; at ≥768px the Dime
            shell sidebar owns pane navigation. */}

        {/* Row 2: Unified filter bar — DATE | NBA | Search */}
        <div
          ref={searchRef}
          className="relative px-3 pt-1 pb-1 flex items-center gap-2"
        >
          {/* DATE picker — calendar dropdown */}
          <CalendarPicker
            selectedDate={selectedDate}
            onSelect={setSelectedDate}
            availableDates={new Set(allDates)}
            isAdmin={isOwner || appUser?.role === "admin"}
          />

          {/* League pills — only in-season leagues render (leagueSeasons).
              State styling comes from the .bs-pill brand layer in dime-mobile.css. */}
          {activeLeagues.map(league => (
            <button
              type="button"
              key={league}
              onClick={() => setSelectedSport(league)}
              data-active={selectedSport === league}
              className="bs-pill flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[13px] font-semibold tracking-wide transition-all flex-shrink-0 cursor-pointer"
            >
              <img
                src={LEAGUE_LOGOS[league]}
                alt=""
                width={12}
                height={12}
                style={{
                  objectFit: "contain",
                  opacity: selectedSport === league ? 1 : 0.5,
                  flexShrink: 0,
                }}
              />
              {league}
            </button>
          ))}

          {/* Search bar — takes remaining space */}
          <div className="flex-1 min-w-0">
            <div
              className="bs-search flex items-center gap-2 px-2.5 py-1.5 rounded-full border"
              data-focused={searchFocused}
            >
              <Search
                className="w-3 h-3 flex-shrink-0"
                aria-hidden="true"
                style={{ color: "var(--dime-text-muted)" }}
              />
              {/* 16px on touch widths — anything smaller makes iOS Safari zoom the page on focus */}
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-expanded={showDropdown}
                aria-controls="bs-search-listbox"
                aria-label={`Search ${selectedSport} games`}
                placeholder="Search…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                className="flex-1 min-w-0 bg-transparent text-base sm:text-xs text-foreground placeholder:text-muted-foreground outline-none"
              />
              {searchQuery && (
                <button
                  type="button"
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => {
                    setSearchQuery("");
                    inputRef.current?.focus();
                  }}
                  className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          {/* Search dropdown */}
          {showDropdown && (
            <div
              id="bs-search-listbox"
              className="bs-dropdown absolute left-3 right-3 top-full mt-0.5 z-50 overflow-hidden"
              style={{
                maxHeight: "calc(3 * 68px + 44px)",
                overflowY: "auto",
              }}
            >
              <div
                className="bs-dropdown-head flex items-center justify-between px-3 py-2 border-b sticky top-0"
                style={{ zIndex: 10 }}
              >
                <span
                  className="dime-mono-label"
                  style={{ fontSize: 11 }}
                  aria-live="polite"
                >
                  {dropdownResults.length === 0
                    ? "No results"
                    : `${dropdownResults.length} game${dropdownResults.length !== 1 ? "s" : ""}`}
                </span>
                {dropdownResults.length > 0 && (
                  <span className="dime-mono-label" style={{ fontSize: 10 }}>
                    tap to jump
                  </span>
                )}
              </div>
              {dropdownResults.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-6 gap-2">
                  <Search
                    className="w-5 h-5"
                    aria-hidden="true"
                    style={{ color: "var(--dime-text-muted)" }}
                  />
                  <p
                    className="text-xs"
                    style={{ color: "var(--dime-text-secondary)" }}
                  >
                    No games found for "{searchQuery}"
                  </p>
                </div>
              ) : (
                dropdownResults.map(game => (
                  <SearchResultRow
                    key={game!.id}
                    game={game!}
                    onClick={() => scrollToGame(game!.id)}
                  />
                ))
              )}
            </div>
          )}
        </div>

        {/* Row 4: Date header — shown when games are loaded */}
        {!gamesLoading && !appAuthLoading && sortedDates.length > 0 && (
          <div className="flex items-center px-4 py-1 border-b border-border bg-background">
            <div className="flex-1" />
            <div className="flex items-center gap-1 sm:gap-2 flex-wrap justify-center">
              <span
                className="bs-datehdr font-bold tracking-widest uppercase"
                style={{
                  fontSize: "clamp(11px, 3.5vw, 19px)",
                  color: "var(--dime-text-primary)",
                  whiteSpace: "nowrap",
                }}
              >
                {formatDateHeader(selectedDate)}
              </span>
              <span
                aria-hidden="true"
                style={{
                  fontSize: "clamp(14px, 3.5vw, 22px)",
                  color: "var(--dime-text-secondary)",
                  fontWeight: 700,
                  lineHeight: 1,
                  flexShrink: 0,
                }}
              >
                ·
              </span>
              <span
                className="bs-datehdr-sub font-semibold"
                style={{
                  color: "var(--dime-text-secondary)",
                  letterSpacing: "0.06em",
                  fontSize: "clamp(9px, 2.8vw, 17px)",
                  textTransform: "uppercase",
                  whiteSpace: "nowrap",
                }}
              >
                {selectedSport === "NCAAF"
                  ? "NCAAF FOOTBALL"
                  : selectedSport === "MLB"
                    ? "MLB BASEBALL"
                    : selectedSport === "NHL"
                      ? "NHL HOCKEY"
                      : "NBA BASKETBALL"}
              </span>
            </div>
            {/* 2026-08-05: splitsAgoLabel was computed but never rendered —
                no freshness stamp on a page whose value is freshness. Mono
                micro-label, desktop only (the sibling projections law's
                "SYNCED N MIN AGO" analog). */}
            <div className="flex-1 hidden md:flex items-center justify-end">
              <span
                style={{
                  fontFamily: "var(--dime-font-mono)",
                  fontSize: 10,
                  fontWeight: 500,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--dime-text-secondary)",
                  whiteSpace: "nowrap",
                }}
              >
                {dkSnapshot
                  ? `VSiN DK · ${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(dkSnapshot.retrievedAt))} ET`
                  : selectedSport === "NCAAF"
                    ? splitsAgoLabel === "—"
                      ? "NCAAF capture time unavailable"
                      : `Oldest NCAAF capture ${splitsAgoLabel}`
                    : `Splits synced ${splitsAgoLabel}`}
              </span>
            </div>
          </div>
        )}
      </header>

      {/* ── Main Feed ── */}
      <main className="w-full pb-1">
        {/* A11Y-NO-H1: standalone (<768px bottom-tab world) this page owns its
            heading; embedded, the shell pane's sr-only h1 already announces it. */}
        {!embeddedInShell && <h1 className="sr-only">Betting Splits</h1>}
        {gamesLoading ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <Loader2
              className="w-8 h-8 animate-spin"
              aria-hidden="true"
              style={{ color: "var(--dime-mint)" }}
            />
            <p className="text-sm text-muted-foreground">
              Loading betting splits…
            </p>
          </div>
        ) : sortedDates.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-4 text-center px-4">
            <CalendarX
              size={40}
              strokeWidth={1.5}
              aria-hidden="true"
              style={{ color: "var(--dime-text-muted)" }}
            />
            <div>
              <p className="text-sm font-semibold text-foreground mb-1">
                No games found
              </p>
              <p className="text-xs text-muted-foreground">
                {selectedStatuses.size > 0
                  ? `No ${Array.from(selectedStatuses).join(" or ")} ${selectedSport} games right now.`
                  : `No ${selectedSport} games found.`}
              </p>
            </div>
          </div>
        ) : (
          sortedDates.map(date => (
            <div key={date}>
              <div className="bg-card mx-0">
                {gamesByDate[date]!.map(game => (
                  <div key={game!.id} id={`game-card-${game!.id}`}>
                    <GameCard game={game!} mode="splits" />
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </main>
    </div>
  );
}
