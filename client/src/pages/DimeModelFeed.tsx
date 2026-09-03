/**
 * DimeModelFeed — the Dime AI "AI Model Projections" feed surface.
 *
 * Route: /feed/model/:sport-:date  (e.g. /feed/model/mlb-07-11-2026,
 *        /feed/model/wc-07-11-2026) and /feed/model/:sport/:date.
 *        Bare /feed/model/:sport canonicalizes to today's dated URL.
 *
 * A parallel surface over the SAME tRPC data contracts as /feed
 * (DIME-FEED-MIGRATION-DRAFT §2: new frontend, zero backend changes).
 * Implements dime-ai/reference-pages/dime-feed-projections.html — the
 * judge-verified v4 reference — under the locked brand law
 * (design-system/dime-ai/MASTER.md + pages/ai-model-projections.md):
 *
 *  - one-accent mint strictly on signal (model edges, picks, live, active)
 *  - Familjen Grotesk values / IBM Plex Mono micro-labels, 160ms single curve
 *  - solid surfaces separated by background tier + 1px border (no glass,
 *    no gradients, no elevation on data cards)
 *  - OWNER RULES: crest/flag beside every team reference; every market keeps
 *    both sides as rows (away TOP / home BOTTOM, O/U, DRAW/NO DRAW,
 *    HOME WD top / AWAY WD bottom, YES/NO) with Book | Model per side;
 *    zero truncation down to 360px (labels stack above values <380px).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";
import type { inferRouterOutputs } from "@trpc/server";
import { keepPreviousData } from "@tanstack/react-query";
import { trpc, type AppRouter } from "@/lib/trpc";
import { useAnalytics, useTrackAction } from "@/lib/analytics";
import { useTheme } from "@/contexts/ThemeContext";
import { ProjectionCard } from "@/components/projections/ProjectionCard";
import { presentationToProjectionGame } from "@/components/projections/fromPresentation";
import {
  mlbLineupToProjectionPregame,
  type MlbLineupLike,
} from "@/components/projections/fromMlbLineup";
import type {
  GameStatus,
  ProjectionPregameLineups,
} from "@/components/projections/types";
import { sportAdapters } from "@/lib/sport/presentation";
import { MLB_BY_ABBREV } from "@shared/mlbTeams";
import { formatGameTime, timeToMinutes } from "@/lib/gameUtils";
import {
  calculateEdge,
  calculate3WayResult,
  EDGE_THRESHOLD_PP,
  type ThreeWayOdds,
} from "@/lib/edgeUtils";
import { feedModelPath, bettingSplitsPath, toFeedSlugDate } from "@/lib/feedRoutes";
import "./dimeModelFeed.css";

// ─── Normalized card model (adapters below map tRPC rows into this) ─────────

interface CrestSpec {
  /** Image URL when the data source provides one (MLB logos, WC flags). */
  url?: string | null;
  /** Fallback monogram + colors when no image is available. */
  code: string;
  bg?: string;
}
interface MarketRowSpec {
  label: string;
  crest?: CrestSpec | null;
  book: string;
  model: string;
  sig?: boolean;
  wp?: string | null;
}
interface MarketColSpec {
  title: string;
  rows: MarketRowSpec[];
  foot: { label: string; crest?: CrestSpec | null; edge: boolean };
}
interface TeamSpec {
  name: string;
  crest: CrestSpec;
  score?: string | null;
}
interface FeedCardSpec {
  id: string;
  /** Explicit status prevents postponed/suspended games from looking scheduled. */
  status: GameStatus;
  /** Numeric DB identity for batched source-specific reads. */
  sourceGameId?: number;
  liveLabel?: string | null;
  timeLabel: string;
  away: TeamSpec;
  home: TeamSpec;
  meta: string;
  /** Quiet secondary line under the mobile matchup header (venue / round). */
  venueLine?: string | null;
  /** Scheduled MLB only; ignored by the sport-generic market adapter. */
  pregameLineups?: ProjectionPregameLineups;
  markets: MarketColSpec[];
  /** False when this game has no published model output at all. Optional: only
   *  the MLB adapter sets it; soccer leaves it undefined (= published). */
  modelPublished?: boolean;
  verdict: {
    pick: string;
    crest?: CrestSpec | null;
    edge: string;
    grade: string;
    pass: boolean;
  };
}

// ─── Shared formatting ───────────────────────────────────────────────────────

const fmtAm = (v: number | null | undefined): string =>
  v == null || Number.isNaN(v) ? "—" : v > 0 ? `+${v}` : `${v}`;

const NO_EDGE = { label: "NO EDGE", edge: false } as const;

/** Simple edge → letter grade tiering (matches the reference verdict strip). */
function edgeGrade(pp: number): string {
  if (Number.isNaN(pp) || pp < EDGE_THRESHOLD_PP) return "—";
  if (pp >= 6) return "A";
  if (pp >= 4.5) return "A−";
  if (pp >= 3.5) return "B+";
  if (pp >= 2.5) return "B";
  return "C+";
}

// ─── Presentational components ───────────────────────────────────────────────
// (GameRow/MarketCol/TeamRow/Crest — the pre-ProjectionCard render tree — were
// removed 2026-08-02: zero call sites since the card migrated to
// components/projections/ProjectionCard. FeedCardSpec and the data adapters
// below remain the live pipeline feeding the presentation adapters.)

function SkeletonRow() {
  // Audit DIME-UI-019: the skeleton mirrors the loaded ProjectionCard anatomy
  // (matchup header → pregame panel → summary row → markets row) inside the
  // same card chrome, so resolving data swaps content without reflowing the
  // card. Bars are percentage-based (container-relative like the loaded type),
  // and the pulse matches the app's one skeleton treatment (killed globally
  // under prefers-reduced-motion).
  return (
    <div className="dmf-skelcard animate-pulse" aria-hidden="true">
      <div className="dmf-skel" style={{ width: "55%", height: 20, marginInline: "auto" }} />
      <div className="dmf-skel" style={{ width: "38%", height: 12, marginTop: 8, marginInline: "auto" }} />
      <div className="dmf-skel" style={{ width: "30%", height: 10, marginTop: 6, marginInline: "auto" }} />
      <div className="dmf-skel" style={{ width: "100%", height: 132, marginTop: 12, borderRadius: 12 }} />
      <div className="dmf-skel" style={{ width: "100%", height: 44, marginTop: 12, borderRadius: 10 }} />
      <div className="dmf-skel" style={{ width: "100%", height: 44, marginTop: 8, borderRadius: 10 }} />
    </div>
  );
}

// ─── Route parsing ───────────────────────────────────────────────────────────

/** Accepts dated MLB, WC, or NCAAF slugs (also :sport/:date split form).
 *  A bare sport parses with isoDate=null — the page canonicalizes it
 *  to today's dated URL so sport-only links always land on a real slate. */
export function parseFeedModelPath(
  sportSeg: string | undefined,
  dateSeg: string | undefined,
): { sport: "MLB" | "WC" | "NCAAF"; isoDate: string | null } | null {
  let sport = (sportSeg ?? "").toLowerCase();
  let date = dateSeg ?? "";
  if (!date && /^(mlb|wc|ncaaf)-\d{2}-\d{2}-\d{4}$/.test(sport)) {
    date = sport.slice(sport.indexOf("-") + 1);
    sport = sport.slice(0, sport.indexOf("-"));
  }
  if (sport !== "mlb" && sport !== "wc" && sport !== "ncaaf") return null;
  const sportCode = sport === "mlb" ? ("MLB" as const) : sport === "wc" ? ("WC" as const) : ("NCAAF" as const);
  if (!date) return { sport: sportCode, isoDate: null };
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(date);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const mo = Number(mm), da = Number(dd);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  return { sport: sportCode, isoDate: `${yyyy}-${mm}-${dd}` };
}

const shiftIso = (iso: string, days: number): string => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const prettyDate = (iso: string): string =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

/** League logo box, shared by the in-list collapsible header (desktop) and the
 *  feedhead league bar (mobile). WC emblem is theme-keyed (black FIFA wordmark
 *  on light, white on dark — CSS swaps by data-dmf-theme; both render in the
 *  same fixed box). A missing logo file hides itself and the row stays clean
 *  text. MLB uses the actual current mark (navy/red, owner directive
 *  2026-07-21) — official mlbstatic league SVG with the bundled recolored mark
 *  as offline fallback before hiding. */
function LeagueMark({ league }: { league: "WC" | "MLB" | "NCAAF" }) {
  if (league === "NCAAF") {
    return <span className="dmf-lglogo dmf-micro" aria-hidden="true">CFB</span>;
  }
  return (
    <span className={`dmf-lglogo${league === "MLB" ? " dmf-lglogo--mlb" : ""}`} aria-hidden="true">
      {league === "WC" ? (
        <>
          <img
            className="dmf-lglogo-light"
            src="/brand/wc26-emblem-on-light.png"
            alt=""
            loading="lazy"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
          <img
            className="dmf-lglogo-dark"
            src="/brand/wc26-emblem-on-dark.png"
            alt=""
            loading="lazy"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        </>
      ) : (
        <img
          src="https://www.mlbstatic.com/team-logos/league-on-dark/1.svg"
          alt=""
          loading="lazy"
          onError={(e) => {
            const img = e.target as HTMLImageElement;
            if (img.src.endsWith("/brand/mlb-logo.png")) {
              img.style.display = "none";
            } else {
              img.src = "/brand/mlb-logo.png";
            }
          }}
        />
      )}
    </span>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export interface DimeModelFeedProps {
  sport?: string;
  date?: string;
  /** The unified app shell owns primary navigation when this surface is embedded. */
  embeddedInShell?: boolean;
  /** Allows the shell to preserve a local-only preview capability in route changes. */
  resolveRouteHref?: (href: string) => string;
}

const identityRouteHref = (href: string) => href;

export default function DimeModelFeed(props: DimeModelFeedProps) {
  const [, navigate] = useLocation();
  const resolveRouteHref = props.resolveRouteHref ?? identityRouteHref;
  const parsed = parseFeedModelPath(props.sport, props.date);
  // Theme is app-global (ThemeContext) so the choice follows the user across
  // every tab and the bottom tab bar. ?theme= is still honored for embeds.
  const { theme, mode, setTheme } = useTheme();
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get("theme");
      if ((q === "light" || q === "dark") && setTheme) setTheme(q);
    } catch {
      /* no-op */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sport = parsed?.sport ?? "MLB";
  const isoDate = parsed?.isoDate ?? "";

  // Bare-sport URLs (/feed/model/mlb) canonicalize to today's dated URL —
  // replace, so back-button never re-lands on the dateless form.
  const needsDateCanonicalize = parsed !== null && parsed.isoDate === null;
  useEffect(() => {
    if (needsDateCanonicalize) {
      navigate(resolveRouteHref(feedModelPath(sport)), { replace: true });
    }
  }, [needsDateCanonicalize, sport, navigate, resolveRouteHref]);

  // Discord account-link feedback lands here now (the legacy /dashboard
  // consumer is unrouted): surface it once, then strip the params.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linked = params.get("discord_linked");
    const linkError = params.get("discord_error");
    if (!linked && !linkError) return;
    if (linked === "1") toast.success("Discord account linked.");
    else if (linkError) toast.error(`Discord link failed: ${linkError.replace(/_/g, " ")}`);
    params.delete("discord_linked");
    params.delete("discord_error");
    const qs = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
  }, []);

  // ADAPTER WIRING (exact bindings from GameCard / WcFeedInline) is attached
  // below in useFeedCards — see mlbRowToCard / wcMatchToCard. The feed is
  // combined (owner directive 2026-07-18): both leagues load for the date.
  const { sections, isLoading, isStale, gamesCount, isError, retry } = useFeedCards(isoDate, sport);

  // League open/closed is CONTROLLED state (owner directive 2026-07-29): on
  // mobile the league header lives inside the sticky feedhead (the feed's
  // primary menu bar), physically apart from the <details> it collapses, so
  // native summary toggling alone can't drive it. Desktop summary clicks and
  // mobile bar taps both funnel through setLeagueOpen; onToggle keeps state in
  // sync when the browser flips the DOM first. Leagues default open.
  const [closedLeagues, setClosedLeagues] = useState<ReadonlySet<FeedSection["key"]>>(
    () => new Set(),
  );
  const setLeagueOpen = (key: FeedSection["key"], open: boolean) =>
    setClosedLeagues((prev) => {
      if (prev.has(key) === !open) return prev;
      const next = new Set(prev);
      if (open) next.delete(key);
      else next.add(key);
      return next;
    });

  // Value event (D1): fires once per (date, gamesCount) the moment a complete,
  // trustworthy projection set renders — loaded, fresh (not stale), non-empty.
  // Never fires on a bare/loading/stale feed. No betting signals in the props.
  const track = useAnalytics();
  // Action emitter (D3): fire-and-forget curated actions on this lazy surface.
  const trackAction = useTrackAction();
  const firedRef = useRef<string | null>(null);
  useEffect(() => {
    if (isLoading || isStale || gamesCount <= 0) return;
    const sig = `${isoDate}:${gamesCount}`;
    if (firedRef.current === sig) return;
    firedRef.current = sig;
    track("projection_evaluation_viewed", {
      featureId: "model_feed",
      outcome: "success",
      props: { sport: sport.toLowerCase(), data_freshness_state: "fresh" },
    });
  }, [isLoading, isStale, gamesCount, isoDate, track, sport]);

  // Date nav canonicalizes on the mlb- slug: the combined feed has one URL per
  // date. Legacy wc- deep links still parse and render the same combined slate.
  const go = (nextIso: string) =>
    navigate(resolveRouteHref(feedModelPath(sport === "NCAAF" ? "NCAAF" : "MLB", nextIso)));

  if (needsDateCanonicalize) {
    // One-frame redirect to the dated URL; queries stay disabled (isoDate="").
    return (
      <div className="dmf-root" data-dmf-theme={theme} data-dmf-mode={mode}>
      </div>
    );
  }

  if (!parsed) {
    return (
      <div className="dmf-root" data-dmf-theme="dark" data-dmf-mode="dark">
        <div className="dmf-invalid">
          <span className="dmf-micro">Invalid feed URL</span>
          <p>
            Expected <code>/feed/model/mlb-MM-DD-YYYY</code>,{" "}
            <code>/feed/model/wc-MM-DD-YYYY</code>, or{" "}
            <code>/feed/model/ncaaf-MM-DD-YYYY</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="dmf-root" data-dmf-theme={theme} data-dmf-mode={mode}>
      <div className="dmf-topbar">
        {/* One Dime identity per page (directive §6): when embedded in the app
            shell, the sidebar already carries the Dime brand — repeating the
            wordmark here would put two Dime logos on the same page. Standalone
            /feed keeps the wordmark so the surface is still branded. */}
        {!props.embeddedInShell && (
          <>
            <span className="dmf-wordmark" aria-label="dime">
              d<span className="dmf-i">ı<span className="dmf-coindot" /></span>me
            </span>
            <span className="dmf-topsep" />
          </>
        )}
        <span className="dmf-toptitle">AI Model Projections</span>
        <div className="dmf-sync">
          {/* Outbound nav — the canonical feed must never be a dead end
              (tablet/desktop have no bottom tab bar; non-owners never do) */}
          {!props.embeddedInShell && (
            <nav className="dmf-nav" aria-label="Dime surfaces">
              <Link href={bettingSplitsPath("MLB")} className="dmf-navlink">Splits</Link>
              <Link href="/chat" className="dmf-navlink">Chat</Link>
              <Link href="/profile" className="dmf-navlink">Profile</Link>
            </nav>
          )}
          {/* No theme toggle here — the Profile tab's Appearance setting is the
              single theme control (owner directive 2026-07-17). ?theme= embeds
              are still honored via the effect above. */}
        </div>
      </div>

      {/* Landmark/heading ownership (A11Y-NO-MAIN / A11Y-NO-H1): every host
          mode renders the scroll region as the page's <main> — the shell's
          external pane is a <section>, so pages own their landmark
          (BettingSplits/TrendsPage pattern). The h1 is sr-only and
          standalone-only: the topbar title span is display:none'd by the
          mobile floating nav, and embedded the shell already exposes an
          sr-only pane h1. */}
      <main className="dmf-scroll">
        {!props.embeddedInShell && <h1 className="sr-only">AI Model Projections</h1>}
        <div className="dmf-feedhead">
          <div className="dmf-datenav">
            <button
              className="dmf-sq"
              aria-label="Previous day"
              onClick={() => {
                trackAction("feed_date_navigated", { props: { direction: "prev" } });
                go(shiftIso(isoDate, -1));
              }}
            >
              ‹
            </button>
            <div className="dmf-datelbl">{prettyDate(isoDate)}</div>
            <button
              className="dmf-sq"
              aria-label="Next day"
              onClick={() => {
                trackAction("feed_date_navigated", { props: { direction: "next" } });
                go(shiftIso(isoDate, 1));
              }}
            >
              ›
            </button>
          </div>
          {/* Combined slate (owner directive 2026-07-18): no sport toggle and
              no slate count — the league headers below own identification;
              the feedhead's bottom border stays as the divider. */}
          {/* MOBILE (<768px, owner directive 2026-07-29): the league headers
              join the date inside this sticky feedhead — one grouped primary
              menu bar with no gap to the floating nav. Each bar toggles its
              league's <details> below (controlled state); the in-list summary
              headers are display:none'd on mobile so the bar is the single
              control. Desktop never shows these (CSS hides .dmf-lgbars). */}
          {sections.length > 0 && (
            <div className="dmf-lgbars">
              {sections.map((section) => {
                const open = !closedLeagues.has(section.key);
                return (
                  <button
                    key={section.key}
                    type="button"
                    className="dmf-lgbar"
                    aria-expanded={open}
                    aria-controls={`dmf-league-${section.key}`}
                    onClick={() => setLeagueOpen(section.key, !open)}
                  >
                    <LeagueMark league={section.key} />
                    <span className="dmf-lgname">{section.label}</span>
                    <ChevronDown className="dmf-lgchev dmf-lgchev--expand" aria-hidden="true" />
                    <ChevronUp className="dmf-lgchev dmf-lgchev--collapse" aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className={`dmf-list${isStale ? " dmf-stale" : ""}`} aria-busy={isStale}>
          {isLoading && gamesCount === 0 ? (
            /* 2026-08-05 (audit DIME-UI-019 completion): skeletons render
               inside the SAME .dmf-league/.dmf-leaguebody containers as the
               loaded slate, so the container-driven 1/2/3-up column count is
               identical before and after data resolves — loading no longer
               reflows from a single-column stack into a multi-column grid. */
            <div className="dmf-league" aria-hidden="true">
              <div className="dmf-leaguebody">
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
              </div>
            </div>
          ) : gamesCount === 0 && isError ? (
            <div className="dmf-empty" role="alert">
              <span className="dmf-micro">Projections unavailable</span>
              <p>The slate could not be loaded. Check your connection and try again.</p>
              <button type="button" className="dmf-retry" onClick={retry}>
                Retry
              </button>
            </div>
          ) : gamesCount === 0 ? (
            <div className="dmf-empty">
              <span className="dmf-micro">No games for this date</span>
              <p>Try the date arrows above.</p>
            </div>
          ) : (
            // Combined slate, league-sectioned (owner directive 2026-07-18):
            // World Cup on top, MLB beneath — buildFeedSections owns the order
            // and drops empty leagues. Each league is a COLLAPSIBLE container
            // (native details/summary, open by default): official league logo
            // + the full spelled-out name across the row, chevron affordance
            // at the right edge. The WC emblem is theme-keyed (black FIFA
            // wordmark on light, white on dark — CSS swaps by data-dmf-theme;
            // both render in the same fixed box). A missing logo file hides
            // itself and the header stays clean text.
            sections.map((section) => (
              <details
                key={section.key}
                id={`dmf-league-${section.key}`}
                className="dmf-league"
                open={!closedLeagues.has(section.key)}
                onToggle={(e) => setLeagueOpen(section.key, e.currentTarget.open)}
              >
                <summary className="dmf-leaguehead">
                  <LeagueMark league={section.key} />
                  <span className="dmf-lgname">{section.label}</span>
                  <ChevronDown className="dmf-lgchev dmf-lgchev--expand" aria-hidden="true" />
                  <ChevronUp className="dmf-lgchev dmf-lgchev--collapse" aria-hidden="true" />
                </summary>
                <div className="dmf-leaguebody">
                  {section.cards.map((g) => {
                    const model = section.key === "WC"
                      ? sportAdapters.SOCCER(g, { competition: "World Cup" })
                      : section.key === "NCAAF"
                        ? sportAdapters.NCAAF(g, { competition: "NCAAF" })
                        : sportAdapters.MLB(g, { competition: "MLB" });
                    const projectionGame = presentationToProjectionGame(model);
                    return (
                      <ProjectionCard
                        key={g.id}
                        game={{
                          ...projectionGame,
                          modelPublished: g.modelPublished,
                          pregameLineups:
                            projectionGame.status === "scheduled"
                              ? g.pregameLineups
                              : undefined,
                        }}
                        onOpen={() => trackAction("projection_opened", { props: { sport: section.key } })}
                      />
                    );
                  })}
                </div>
              </details>
            ))
          )}
        </div>
      </main>
    </div>
  );
}

// ─── Data adapters — bindings copied EXACTLY from GameCard / WcFeedInline ────

type RouterOutputs = inferRouterOutputs<AppRouter>;
type MlbRow = RouterOutputs["games"]["list"][number];
type WcMatch = RouterOutputs["wc2026"]["matchesByDate"][number];

/** Parse a numeric-ish tRPC field (decimal columns arrive as strings). */
const n = (v: string | number | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
};

const fmtLine = (v: number): string => (v > 0 ? `+${v}` : `${v}`);

interface SideCalc {
  label: string;
  crest?: CrestSpec | null;
  book: number | null;
  model: number | null;
  wp?: string | null;
}

/** Two-sided market column: edge per side via edgeUtils (2-way).
 *  pickSuffix contextualizes bare team-code labels in footers/PICK ("ML"/"ADV"). */
function twoWayCol(
  title: string,
  top: SideCalc,
  bottom: SideCalc,
  pickSuffix?: string,
): MarketColSpec & { bestPP: number; bestSide: SideCalc | null; pickSuffix?: string } {
  const pp = (s: SideCalc) =>
    s.book != null && s.model != null ? calculateEdge(s.book, s.model) : NaN;
  const topPP = pp(top);
  const botPP = pp(bottom);
  const rows: MarketRowSpec[] = [top, bottom].map((s, i) => ({
    label: s.label,
    crest: s.crest,
    book: fmtAm(s.book),
    model: fmtAm(s.model),
    sig: !Number.isNaN(i === 0 ? topPP : botPP) && (i === 0 ? topPP : botPP) >= EDGE_THRESHOLD_PP,
    wp: s.wp ?? null,
  }));
  let bestPP = NaN;
  let bestSide: SideCalc | null = null;
  if (!Number.isNaN(topPP) && (Number.isNaN(botPP) || topPP >= botPP)) {
    bestPP = topPP;
    bestSide = top;
  } else if (!Number.isNaN(botPP)) {
    bestPP = botPP;
    bestSide = bottom;
  }
  const hasEdge = !Number.isNaN(bestPP) && bestPP >= EDGE_THRESHOLD_PP && bestSide != null;
  const footLabel = hasEdge
    ? `${bestSide!.label}${pickSuffix ? ` ${pickSuffix}` : ""} · +${bestPP.toFixed(1)}%`
    : NO_EDGE.label;
  return {
    title,
    rows,
    foot: hasEdge
      ? { label: footLabel, crest: bestSide!.crest, edge: true }
      : { ...NO_EDGE },
    bestPP: hasEdge ? bestPP : NaN,
    bestSide: hasEdge
      ? { ...bestSide!, label: `${bestSide!.label}${pickSuffix ? ` ${pickSuffix}` : ""}` }
      : null,
    pickSuffix,
  };
}

interface BestPick {
  pp: number;
  label: string;
  crest?: CrestSpec | null;
}
function trackBest(best: BestPick | null, col: { bestPP: number; bestSide: SideCalc | null }): BestPick | null {
  if (col.bestSide == null || Number.isNaN(col.bestPP)) return best;
  if (best == null || col.bestPP > best.pp)
    return { pp: col.bestPP, label: col.bestSide.label, crest: col.bestSide.crest };
  return best;
}
function verdictOf(best: BestPick | null): FeedCardSpec["verdict"] {
  if (best == null)
    return { pick: "PASS", edge: "—", grade: "—", pass: true };
  return {
    pick: best.label,
    crest: best.crest,
    edge: `+${best.pp.toFixed(1)}%`,
    grade: edgeGrade(best.pp),
    pass: false,
  };
}

// ── MLB adapter (bindings: GameCard.tsx via @shared/mlbTeams registry) ───────
// Exported for DimeModelFeed.doubleheader.test.ts — the card id is the render
// key, so its per-EVENT uniqueness (doubleheader safety) is pinned by tests.

export function mlbRowToCard(
  g: MlbRow,
  lineup?: MlbLineupLike | null,
): FeedCardSpec {
  const awayAbbr = (g.awayTeam ?? "").toUpperCase();
  const homeAbbr = (g.homeTeam ?? "").toUpperCase();
  const awayReg = MLB_BY_ABBREV.get(awayAbbr);
  const homeReg = MLB_BY_ABBREV.get(homeAbbr);
  const awayCrest: CrestSpec = { url: awayReg?.logoUrl, code: awayAbbr.slice(0, 3), bg: awayReg?.primaryColor };
  const homeCrest: CrestSpec = { url: homeReg?.logoUrl, code: homeAbbr.slice(0, 3), bg: homeReg?.primaryColor };

  // Suspended is its own lifecycle member as of 2026-08-05 (owner directive):
  // it used to be folded into "postponed" and render POSTPONED, which the page
  // law contradicts — it names suspended a first-class state.
  const status: GameStatus =
    g.gameStatus === "live"
      ? "live"
      : g.gameStatus === "final"
        ? "final"
        : g.gameStatus === "suspended"
          ? "suspended"
          : g.gameStatus === "postponed"
            ? "postponed"
            : "scheduled";
  const isLive = status === "live";
  const isFinal = status === "final";
  // Suspended games were halted mid-play, so they have a real score to show —
  // the fact that distinguishes them from postponed (never played).
  const showsScore = isLive || isFinal || status === "suspended";
  // Model freshness gate — modelRunAt null ⇒ model invalidated (GameCard rule).
  const hasModel = g.modelRunAt != null;
  const M = <T,>(v: T | null): T | null => (hasModel ? v : null);

  // RUN LINE — VSiN run line authoritative, book-spread fallback (GameCard 841).
  const awayRl = n(g.awayRunLine) ?? n(g.awayBookSpread);
  const homeRl = n(g.homeRunLine) ?? n(g.homeBookSpread);
  const rl = twoWayCol(
    "Run Line",
    {
      label: awayRl != null ? `${awayAbbr} ${fmtLine(awayRl)}` : awayAbbr,
      crest: awayCrest,
      book: n(g.awayRunLineOdds),
      model: M(n(g.modelAwaySpreadOdds) ?? n(g.modelAwayPLOdds)),
    },
    {
      label: homeRl != null ? `${homeAbbr} ${fmtLine(homeRl)}` : homeAbbr,
      crest: homeCrest,
      book: n(g.homeRunLineOdds),
      model: M(n(g.modelHomeSpreadOdds) ?? n(g.modelHomePLOdds)),
    },
  );

  // TOTAL — O above U (owner row order).
  const totalLine = n(g.bookTotal);
  const total = twoWayCol(
    "Total",
    { label: totalLine != null ? `O ${totalLine}` : "OVER", book: n(g.overOdds), model: M(n(g.modelOverOdds)) },
    { label: totalLine != null ? `U ${totalLine}` : "UNDER", book: n(g.underOdds), model: M(n(g.modelUnderOdds)) },
  );

  // MONEYLINE — away top; win% annotation on the model favorite (page spec).
  const awayWp = n(g.modelAwayWinPct);
  const homeWp = n(g.modelHomeWinPct);
  const favIsAway = awayWp != null && homeWp != null ? awayWp >= homeWp : false;
  const ml = twoWayCol(
    "Moneyline",
    {
      label: awayAbbr,
      crest: awayCrest,
      book: n(g.awayML),
      model: M(n(g.modelAwayML)),
      wp: hasModel && favIsAway && awayWp != null ? `${Math.round(awayWp)}%` : null,
    },
    {
      label: homeAbbr,
      crest: homeCrest,
      book: n(g.homeML),
      model: M(n(g.modelHomeML)),
      wp: hasModel && !favIsAway && homeWp != null ? `${Math.round(homeWp)}%` : null,
    },
    "ML",
  );

  let best: BestPick | null = null;
  for (const col of [rl, total, ml]) best = trackBest(best, col);

  // Ballpark only in the matchup context. Scheduled probable pitchers now own a
  // dedicated middle panel, so they still never pollute or duplicate this line.
  const meta = g.venue || "MLB";

  const pregameLineups =
    status === "scheduled"
      ? mlbLineupToProjectionPregame({
          ...lineup,
          awayPitcherName: lineup?.awayPitcherName ?? g.awayStartingPitcher,
          awayPitcherConfirmed:
            lineup?.awayPitcherConfirmed ?? g.awayPitcherConfirmed,
          homePitcherName: lineup?.homePitcherName ?? g.homeStartingPitcher,
          homePitcherConfirmed:
            lineup?.homePitcherConfirmed ?? g.homePitcherConfirmed,
        })
      : undefined;

  return {
    // Stable event identity = DB primary key. The fallback must stay unique per
    // EVENT, not per matchup: two doubleheader games share awayAbbr/homeAbbr on
    // the same date, so a bare `${away}-${home}` key would collapse them into
    // one React key and silently drop a card. Include date + start time +
    // gameNumber so even the id-less fallback cannot merge distinct games.
    id: String(
      g.id ??
      `${awayAbbr}-${homeAbbr}-${g.gameDate ?? ""}-${g.startTimeEst ?? ""}-${(g as { gameNumber?: number | null }).gameNumber ?? 1}`
    ),
    status,
    sourceGameId: Number.isInteger(g.id) ? g.id : undefined,
    liveLabel: isLive ? `LIVE${g.gameClock ? ` · ${g.gameClock}` : ""}` : null,
    timeLabel:
      status === "suspended"
        ? "SUSPENDED"
        : status === "postponed"
          ? "POSTPONED"
          : isFinal
            ? "FINAL"
            : formatGameTime(g.startTimeEst),
    // A suspended game was halted mid-play and carries a real score — that is
    // exactly what separates it from postponed (2026-08-05 owner directive
    // making suspended first-class). Postponed was never played: no score.
    away: { name: awayReg?.nickname ?? awayAbbr, crest: awayCrest, score: showsScore ? (g.awayScore != null ? String(g.awayScore) : null) : null },
    home: { name: homeReg?.nickname ?? homeAbbr, crest: homeCrest, score: showsScore ? (g.homeScore != null ? String(g.homeScore) : null) : null },
    meta,
    venueLine: g.venue || null,
    pregameLineups,
    markets: [rl, total, ml],
    modelPublished: hasModel,
    verdict: verdictOf(best),
  };
}

/** NCAAF uses the shared games row, but compares book prices only to fair prices. */
export function ncaafRowToCard(g: MlbRow): FeedCardSpec {
  const awayAbbr = (g.awayTeam ?? "").toUpperCase();
  const homeAbbr = (g.homeTeam ?? "").toUpperCase();
  const awayCrest: CrestSpec = { code: awayAbbr.slice(0, 4) };
  const homeCrest: CrestSpec = { code: homeAbbr.slice(0, 4) };
  const status: GameStatus =
    g.gameStatus === "live" ? "live" :
    g.gameStatus === "final" ? "final" :
    g.gameStatus === "suspended" ? "suspended" :
    g.gameStatus === "postponed" ? "postponed" : "scheduled";
  const hasModel = g.modelRunAt != null;
  const M = <T,>(v: T | null): T | null => hasModel ? v : null;
  const awaySp = n(g.awayBookSpread);
  const homeSp = n(g.homeBookSpread);
  const spread = twoWayCol(
    "Spread",
    { label: awaySp == null ? awayAbbr : `${awayAbbr} ${fmtLine(awaySp)}`, crest: awayCrest, book: n(g.awaySpreadOdds), model: M(n(g.modelAwaySpreadOdds)) },
    { label: homeSp == null ? homeAbbr : `${homeAbbr} ${fmtLine(homeSp)}`, crest: homeCrest, book: n(g.homeSpreadOdds), model: M(n(g.modelHomeSpreadOdds)) },
  );
  const totalLine = n(g.bookTotal);
  const total = twoWayCol(
    "Total",
    { label: totalLine == null ? "OVER" : `O ${totalLine}`, book: n(g.overOdds), model: M(n(g.modelOverOdds)) },
    { label: totalLine == null ? "UNDER" : `U ${totalLine}`, book: n(g.underOdds), model: M(n(g.modelUnderOdds)) },
  );
  const awayWp = n(g.modelAwayWinPct);
  const homeWp = n(g.modelHomeWinPct);
  const favIsAway = awayWp != null && homeWp != null && awayWp >= homeWp;
  const ml = twoWayCol(
    "Moneyline",
    { label: awayAbbr, crest: awayCrest, book: n(g.awayML), model: M(n(g.modelAwayML)), wp: hasModel && favIsAway && awayWp != null ? `${Math.round(awayWp)}%` : null },
    { label: homeAbbr, crest: homeCrest, book: n(g.homeML), model: M(n(g.modelHomeML)), wp: hasModel && !favIsAway && homeWp != null ? `${Math.round(homeWp)}%` : null },
    "ML",
  );
  let best: BestPick | null = null;
  for (const col of [spread, total, ml]) best = trackBest(best, col);
  return {
    id: String(g.id ?? `${awayAbbr}-${homeAbbr}-${g.gameDate ?? ""}-${g.startTimeEst ?? ""}`),
    status,
    sourceGameId: Number.isInteger(g.id) ? g.id : undefined,
    liveLabel: status === "live" ? "LIVE" : null,
    timeLabel: status === "suspended" ? "SUSPENDED" : status === "postponed" ? "POSTPONED" : status === "final" ? "FINAL" : formatGameTime(g.startTimeEst),
    away: { name: awayAbbr, crest: awayCrest },
    home: { name: homeAbbr, crest: homeCrest },
    meta: "NCAAF",
    venueLine: hasModel
      ? `Model: ${homeAbbr} ${fmtLine(n(g.homeModelSpread) ?? 0)} · Total ${n(g.modelTotal) ?? "—"}`
      : g.venue || null,
    markets: [spread, total, ml],
    modelPublished: hasModel,
    verdict: verdictOf(best),
  };
}

// ── WC adapter (bindings: WcFeedInline WcDesktopMergedPanel, away = TOP) ─────

const fifaFlagUrl = (code: string): string =>
  `https://api.fifa.com/api/v3/picture/flags-sq-4/${code.toUpperCase()}`;

/** Round label by PT kickoff-day thresholds (WcFeedInline stage ternary). */
export function wcRoundLabel(isoDate: string): string {
  return isoDate >= "2026-07-19" ? "World Cup Final"
    : isoDate >= "2026-07-18" ? "3rd Place Match"
    : isoDate >= "2026-07-14" ? "Semifinal"
    : isoDate >= "2026-07-09" ? "Quarterfinal"
    : isoDate >= "2026-07-04" ? "Round of 16"
    : isoDate >= "2026-06-28" ? "Round of 32"
    : "Group Stage";
}

/** Owner display map (2026-07-18): stadium → "City, ST". Replaces the DB city
 *  wholesale ("Miami Gardens" → "Miami, FL"); stadiums not listed keep their
 *  DB city. Substring match so provider naming variants still hit. */
const WC_VENUE_CITY_DISPLAY: ReadonlyArray<readonly [pattern: string, city: string]> = [
  ["hard rock", "Miami, FL"],
  ["metlife", "East Rutherford, NJ"],
];
export function wcDisplayCity(
  stadium: string | null | undefined,
  city: string | null | undefined,
): string | null {
  const s = (stadium ?? "").toLowerCase();
  for (const [pattern, display] of WC_VENUE_CITY_DISPLAY) {
    if (s.includes(pattern)) return display;
  }
  return city || null;
}

/** Stadium display name drops a trailing parenthetical (owner directive
 *  2026-07-18): "MetLife Stadium (NY/NJ)" reads "MetLife Stadium" — the city
 *  line beside it already carries the location. Display-only: wcDisplayCity
 *  keeps matching on the RAW stadium string. */
export function wcDisplayStadium(stadium: string | null | undefined): string | null {
  if (!stadium) return null;
  const stripped = stadium.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return stripped || stadium;
}

function fmtKickoffEt(kickoffUtc: string | Date | null | undefined): string {
  if (!kickoffUtc) return "TBD";
  const d = typeof kickoffUtc === "string" ? new Date(kickoffUtc) : kickoffUtc;
  if (Number.isNaN(d.getTime())) return "TBD";
  return (
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET"
  );
}

/** Owner winner-scope markets (2026-07-18): the two remaining WC matches
 *  replace their MONEYLINE column with a match-WINNER market — graded on
 *  whoever wins the match when it settles, regardless of 90'+injury time,
 *  extra time, or penalties. Book prices are OWNER-PROVIDED (2026-07-18).
 *  Model prices are the v27 engine's model_*_to_advance (ET+pens
 *  sub-simulation: P(win 90') + P(draw)×[ET λ/3 + pens 50.5/49.5]) — for
 *  these two matches that is literally "wins the match outright" (engine
 *  header, v27_jul18_engine.mjs), i.e. the exact same grading scope. They
 *  reach the card as mo.toAdvanceHome/Away via wc2026_model_projections.
 *  homeCode/awayCode pin the v27-verified orientation (FRA home vs ENG away;
 *  ESP home vs ARG away) — if the live row ever disagreed, the card falls
 *  back to the plain 3-way ML rather than misassign the owner book prices. */
export const WC_WINNER_MARKETS: Record<
  string,
  { title: string; homeCode: string; awayCode: string; bookHome: number; bookAway: number }
> = {
  "wc26-3rd-103": { title: "World Cup 3rd Place", homeCode: "FRA", awayCode: "ENG", bookHome: -215, bookAway: 170 },
  "wc26-final-104": { title: "To Win the World Cup", homeCode: "ESP", awayCode: "ARG", bookHome: -150, bookAway: 130 },
};

function wcMatchToCard(m: WcMatch, isoDate: string): FeedCardSpec {
  const awayCode = m.awayTeam?.fifaCode ?? m.awayTeamId.toUpperCase();
  const homeCode = m.homeTeam?.fifaCode ?? m.homeTeamId.toUpperCase();
  const awayCrest: CrestSpec = { url: m.awayTeam?.flagUrl ?? fifaFlagUrl(awayCode), code: awayCode };
  const homeCrest: CrestSpec = { url: m.homeTeam?.flagUrl ?? fifaFlagUrl(homeCode), code: homeCode };
  const dk = m.dkOdds;
  const mo = m.modelOdds;

  // Winner-scope override applies ONLY when the live orientation matches the
  // v27-verified home/away — the owner book prices bind positionally.
  const winnerSpec = WC_WINNER_MARKETS[m.matchId];
  const winnerApplies =
    winnerSpec != null && winnerSpec.homeCode === homeCode && winnerSpec.awayCode === awayCode;
  // Clarity rule (owner directive 2026-07-18): with the winner market on the
  // card, the 90-minute-scoped markets say so in their headers.
  const t90 = (title: string): string => (winnerApplies ? `${title} (90 Min)` : title);

  // 3-way calc for ML + DRAW (WcMktCol rule) — also yields the win% annotation.
  const threeWayBook: ThreeWayOdds | null =
    dk?.home != null && dk?.draw != null && dk?.away != null
      ? { home: dk.home, draw: dk.draw, away: dk.away }
      : null;
  const threeWayModel: ThreeWayOdds | null =
    mo?.home != null && mo?.draw != null && mo?.away != null
      ? { home: mo.home, draw: mo.draw, away: mo.away }
      : null;
  const calc3 = threeWayBook && threeWayModel ? calculate3WayResult(threeWayBook, threeWayModel) : null;

  // TO ADV — away top (dkOdds.toAdvanceAway), home bottom.
  const toAdv = twoWayCol(
    "To Adv",
    { label: awayCode, crest: awayCrest, book: dk?.toAdvanceAway ?? null, model: mo?.toAdvanceAway ?? null },
    { label: homeCode, crest: homeCrest, book: dk?.toAdvanceHome ?? null, model: mo?.toAdvanceHome ?? null },
    "ADV",
  );

  // WINNER MARKET (owner directive 2026-07-18) — replaces ML on the 3rd-place
  // match and the Final. Away top / home bottom (card row order). Book = the
  // owner-provided winner prices; model = mo.toAdvanceHome/Away — the v27
  // ET+pens winner odds, the exact same "wins the match however it settles"
  // scope — so calculateEdge(book, model) inside twoWayCol IS the precise
  // 2-way edge for this market (the model side is fair: pAdvH + pAdvA = 1).
  const winner = winnerApplies
    ? twoWayCol(
        winnerSpec.title,
        { label: awayCode, crest: awayCrest, book: winnerSpec.bookAway, model: mo?.toAdvanceAway ?? null },
        { label: homeCode, crest: homeCrest, book: winnerSpec.bookHome, model: mo?.toAdvanceHome ?? null },
      )
    : null;
  if (process.env.NODE_ENV === "development" && winnerSpec && !winnerApplies) {
    console.warn(
      `[wcMatchToCard:WINNER] ${m.matchId}: live orientation ${awayCode}@${homeCode} disagrees with ` +
        `verified ${winnerSpec.awayCode}@${winnerSpec.homeCode} — falling back to plain ML (owner odds NOT applied)`,
    );
  }

  // ML — away top; edge/sig from the 3-way calc when available.
  const favIsAway = calc3 ? calc3.away.modelFairProb >= calc3.home.modelFairProb : false;
  const ml = twoWayCol(
    "ML",
    {
      label: awayCode,
      crest: awayCrest,
      book: dk?.away ?? null,
      model: mo?.away ?? null,
      wp: calc3 && favIsAway ? `${Math.round(calc3.away.modelFairProb * 100)}%` : null,
    },
    {
      label: homeCode,
      crest: homeCrest,
      book: dk?.home ?? null,
      model: mo?.home ?? null,
      wp: calc3 && !favIsAway ? `${Math.round(calc3.home.modelFairProb * 100)}%` : null,
    },
    "ML",
  );
  if (calc3) {
    // Override 2-way edge flags with the 3-way results (matches WcMktCol).
    ml.rows[0].sig = calc3.away.edgePP >= EDGE_THRESHOLD_PP;
    ml.rows[1].sig = calc3.home.edgePP >= EDGE_THRESHOLD_PP;
    const top = calc3.away.edgePP >= calc3.home.edgePP;
    const pp = top ? calc3.away.edgePP : calc3.home.edgePP;
    if (pp >= EDGE_THRESHOLD_PP) {
      ml.foot = { label: `${top ? awayCode : homeCode} ML · +${pp.toFixed(1)}%`, crest: top ? awayCrest : homeCrest, edge: true };
      ml.bestPP = pp;
      ml.bestSide = { label: `${top ? awayCode : homeCode} ML`, crest: top ? awayCrest : homeCrest, book: null, model: null };
    } else {
      ml.foot = { ...NO_EDGE };
      ml.bestPP = NaN;
      ml.bestSide = null;
    }
  }

  // DRAW — DRAW top / NO DRAW bottom (owner spec). 90-min scope tagged when
  // the winner market is on the card.
  const draw = twoWayCol(
    t90("Draw"),
    { label: "DRAW", book: dk?.draw ?? null, model: mo?.draw ?? null },
    { label: "NO DRAW", book: dk?.noDraw ?? null, model: mo?.noDraw ?? null },
  );
  if (calc3) {
    draw.rows[0].sig = calc3.draw.edgePP >= EDGE_THRESHOLD_PP;
    if (calc3.draw.edgePP >= EDGE_THRESHOLD_PP) {
      draw.foot = { label: `DRAW · +${calc3.draw.edgePP.toFixed(1)}%`, edge: true };
      draw.bestPP = calc3.draw.edgePP;
      draw.bestSide = { label: "DRAW", book: null, model: null };
    }
  }

  // TOTAL — O top / U bottom; line from dkOdds.overLine (2.5 fallback).
  const totalLine = dk?.overLine ?? 2.5;
  const total = twoWayCol(
    "Total",
    { label: `O ${totalLine}`, book: dk?.overOdds ?? null, model: mo?.overOdds ?? null },
    { label: `U ${totalLine}`, book: dk?.underOdds ?? null, model: mo?.underOdds ?? null },
  );

  // SPREAD — away top with its own line (awaySpreadLine = -bookPrimarySpread).
  const aLine = dk?.awaySpreadLine;
  const hLine = dk?.homeSpreadLine;
  const spread = twoWayCol(
    t90("Spread"),
    {
      label: aLine != null ? `${awayCode} ${fmtLine(aLine)}` : awayCode,
      crest: awayCrest,
      book: dk?.awaySpreadOdds ?? null,
      model: mo?.awaySpreadOdds ?? null,
    },
    {
      label: hLine != null ? `${homeCode} ${fmtLine(hLine)}` : homeCode,
      crest: homeCrest,
      book: dk?.homeSpreadOdds ?? null,
      model: mo?.homeSpreadOdds ?? null,
    },
  );

  // DBL CHC — HOME WD top (dkOdds.homeDrawOdds) / AWAY WD bottom (owner spec),
  // each carrying the matching team's flag (Rule 4).
  const dblChc = twoWayCol(
    t90("Dbl Chc"),
    { label: "HOME WD", crest: homeCrest, book: dk?.homeDrawOdds ?? null, model: mo?.homeDrawOdds ?? null },
    { label: "AWAY WD", crest: awayCrest, book: dk?.awayDrawOdds ?? null, model: mo?.awayDrawOdds ?? null },
  );

  // BTTS — YES top / NO bottom.
  const btts = twoWayCol(
    t90("BTTS"),
    { label: "YES", book: dk?.bttsYes ?? null, model: mo?.bttsYes ?? null },
    { label: "NO", book: dk?.bttsNo ?? null, model: mo?.bttsNo ?? null },
  );

  // TO ADVANCE only exists as a book market when there IS a next round — the
  // 3rd-place match and the Final carry no such market (book adv NULL), so the
  // column is dropped for those cards instead of rendering dashes.
  const hasAdvMarket = dk?.toAdvanceAway != null || dk?.toAdvanceHome != null;
  // Winner market takes the ML slot on the 3rd-place match and the Final
  // (owner directive 2026-07-18); every other card keeps the 3-way ML.
  const markets = [...(hasAdvMarket ? [toAdv] : []), winner ?? ml, draw, total, spread, dblChc, btts];
  let best: BestPick | null = null;
  for (const col of markets) best = trackBest(best, col);

  const status = m.status;
  const minute = m.matchMinute ?? null;
  const liveLabel =
    status === "LIVE" ? `LIVE${minute && minute !== "ETHT" ? ` ${minute}'` : ""}`
    : status === "HT" ? (minute === "ETHT" ? "ET HT" : "HT")
    : status === "ET" ? `ET${minute ? ` ${minute}'` : ""}`
    : status === "SHOOTOUT" ? "PENS"
    : null;
  const isFinal = status === "FT" || status === "FT_PEN";
  const showScores = !!liveLabel || isFinal;

  // Round and venue are separate card lines (owner directive 2026-07-18):
  // the context line carries the round only, and the full venue renders on
  // its own line beneath it so the stadium is never truncated.
  const venueBits = [wcDisplayStadium(m.venue?.stadium), wcDisplayCity(m.venue?.stadium, m.venue?.city)]
    .filter(Boolean)
    .join(" · ");
  const meta = wcRoundLabel(isoDate);

  return {
    id: m.matchId,
    status: liveLabel ? "live" : isFinal ? "final" : "scheduled",
    liveLabel,
    timeLabel: isFinal ? (status === "FT_PEN" ? "FINAL (PENS)" : "FINAL") : fmtKickoffEt(m.kickoffUtc),
    away: {
      name: m.awayTeam?.name ?? awayCode,
      crest: awayCrest,
      score: showScores && m.awayScore != null ? String(m.awayScore) : null,
    },
    home: {
      name: m.homeTeam?.name ?? homeCode,
      crest: homeCrest,
      score: showScores && m.homeScore != null ? String(m.homeScore) : null,
    },
    meta,
    venueLine: venueBits || null,
    markets,
    verdict: verdictOf(best),
  };
}

/**
 * Slate status tier (owner directive 2026-07-18, amended 2026-08-06).
 *
 * LIVE sits above upcoming; SETTLED sinks to the bottom — and "settled" now
 * means final PLUS postponed and suspended. Those two used to fall through into
 * the upcoming tier and sort by their original first pitch, which put games
 * nobody can bet above the ones they can.
 *
 * Exhaustive by construction: adding a GameStatus member without giving it a
 * tier fails the typecheck here, instead of silently defaulting into one. That
 * silent default is exactly how postponed and suspended slipped into the
 * upcoming tier while the rank sniffed the timeLabel string for a FINAL
 * prefix — a test that could only ever recognize the states it was written for.
 *
 * Within a tier the existing order holds: Array.sort is stable, so MLB keeps
 * earliest-first-pitch order and WC keeps the server's match order.
 */
const SLATE_TIER: Record<GameStatus, number> = {
  live: 0,
  scheduled: 1,
  final: 2,
  postponed: 2,
  suspended: 2,
};
export function slateStatusRank(card: Pick<FeedCardSpec, "status">): number {
  return SLATE_TIER[card.status];
}

// ── Query orchestration (contracts: exact {sport, gameDate}; 60s poll;
//    placeholderData keeps the previous slate while the next date loads) ─────

/** One league group in the combined slate. */
export interface FeedSection {
  key: "WC" | "MLB" | "NCAAF";
  /** Full spelled-out league name for the collapsible header (owner directive
   *  2026-07-18: no game counts in the header — the name owns the width). */
  label: string;
  cards: FeedCardSpec[];
}

/** Combined slate (owner directive 2026-07-18): ONE collective feed for the
 *  date — World Cup section on top, NCAAF above MLB (CBS-scores league grouping;
 *  only the grouping/order is mirrored, nothing else). A league renders only
 *  when it has games that date, so inactive leagues leave no empty header.
 *  empty header. Within a section the existing slate order holds. */
export function buildFeedSections(
  wcCards: FeedCardSpec[],
  mlbCards: FeedCardSpec[],
  ncaafCards: FeedCardSpec[] = [],
): FeedSection[] {
  const sections: FeedSection[] = [];
  if (wcCards.length > 0) sections.push({ key: "WC", label: "2026 FIFA World Cup", cards: wcCards });
  if (ncaafCards.length > 0) sections.push({ key: "NCAAF", label: "College Football (NCAAF)", cards: ncaafCards });
  if (mlbCards.length > 0) sections.push({ key: "MLB", label: "Major League Baseball (MLB)", cards: mlbCards });
  return sections;
}

function useFeedCards(
  isoDate: string,
  feedSport: "MLB" | "WC" | "NCAAF" = "MLB",
): { sections: FeedSection[]; isLoading: boolean; isStale: boolean; gamesCount: number; isError: boolean; retry: () => void } {
  const ncaafOnly = feedSport === "NCAAF";
  const mlbQuery = trpc.games.list.useQuery(
    { sport: "MLB", gameDate: isoDate },
    {
      enabled: !!isoDate && !ncaafOnly,
      refetchOnWindowFocus: false,
      refetchInterval: 60 * 1000,
      staleTime: 60 * 1000,
      placeholderData: (prev) => prev,
    },
  );
  const wcQuery = trpc.wc2026.matchesByDate.useQuery(
    { date: isoDate },
    {
      enabled: !!isoDate && !ncaafOnly,
      refetchOnWindowFocus: false,
      refetchInterval: 60 * 1000,
      staleTime: 60 * 1000,
      placeholderData: keepPreviousData,
    },
  );
  const ncaafQuery = trpc.games.list.useQuery(
    { sport: "NCAAF", gameDate: isoDate },
    {
      enabled: !!isoDate,
      refetchOnWindowFocus: false,
      refetchInterval: 60 * 1000,
      staleTime: 60 * 1000,
      placeholderData: (prev) => prev,
    },
  );
  const scheduledMlbGameIds = useMemo(
    () =>
      Array.from(
        new Set(
          ((mlbQuery.data ?? []) as MlbRow[])
            .filter((game) => game.gameStatus === "upcoming")
            .map((game) => game.id)
            .filter((gameId): gameId is number => Number.isInteger(gameId) && gameId > 0),
        ),
      )
        .sort((a, b) => a - b)
        .slice(0, 50),
    [mlbQuery.data],
  );
  const mlbLineupsQuery = trpc.games.mlbLineups.useQuery(
    { gameIds: scheduledMlbGameIds },
    {
      enabled: !!isoDate && !ncaafOnly && scheduledMlbGameIds.length > 0,
      refetchOnWindowFocus: false,
      refetchInterval: 60 * 1000,
      staleTime: 60 * 1000,
      retry: false,
    },
  );

  const sections = useMemo<FeedSection[]>(() => {
    if (ncaafOnly) {
      const cards = [...((ncaafQuery.data ?? []) as MlbRow[])]
        .sort((a, b) => timeToMinutes(a.startTimeEst) - timeToMinutes(b.startTimeEst))
        .map(ncaafRowToCard)
        .sort((a, b) => slateStatusRank(a) - slateStatusRank(b));
      return buildFeedSections([], [], cards);
    }
    // Slate order per league: earliest → latest first pitch (owner directive
    // 2026-07-17; timeToMinutes sends TBD times to the bottom), then LIVE
    // above upcoming above FINAL (2026-07-18) — the stable sort keeps the
    // time order within each tier. Tiers apply WITHIN a league section; the
    // WC → NCAAF → MLB section order is absolute.
    const wcCards = ((wcQuery.data ?? []) as WcMatch[])
      .map((m) => wcMatchToCard(m, isoDate))
      .sort((a, b) => slateStatusRank(a) - slateStatusRank(b));
    const ncaafCards = [...((ncaafQuery.data ?? []) as MlbRow[])]
      .sort((a, b) => timeToMinutes(a.startTimeEst) - timeToMinutes(b.startTimeEst))
      .map(ncaafRowToCard)
      .sort((a, b) => slateStatusRank(a) - slateStatusRank(b));
    const lineupByGameId = (mlbLineupsQuery.data ?? {}) as Record<number, MlbLineupLike>;
    const mlbCards = [...((mlbQuery.data ?? []) as MlbRow[])]
      .sort((a, b) => timeToMinutes(a.startTimeEst) - timeToMinutes(b.startTimeEst))
      .map((game) => mlbRowToCard(game, lineupByGameId[game.id]))
      .sort((a, b) => slateStatusRank(a) - slateStatusRank(b));
    return buildFeedSections(wcCards, mlbCards, ncaafCards);
  }, [wcQuery.data, mlbQuery.data, mlbLineupsQuery.data, ncaafQuery.data, isoDate, ncaafOnly]);

  const isLoading = ncaafOnly
    ? ncaafQuery.isLoading
    : wcQuery.isLoading || ncaafQuery.isLoading || mlbQuery.isLoading;
  // Stale = paging dates while placeholderData keeps the previous slate
  // mounted — the UI dims so the old cards are never mistaken for the new
  // date's numbers (this is a betting surface; wrong-slate reads cost money).
  const isStale = ncaafOnly
    ? ncaafQuery.isPlaceholderData && ncaafQuery.isFetching
    : (wcQuery.isPlaceholderData && wcQuery.isFetching) ||
      (ncaafQuery.isPlaceholderData && ncaafQuery.isFetching) ||
      (mlbQuery.isPlaceholderData && mlbQuery.isFetching);
  const gamesCount = sections.reduce((n, s) => n + s.cards.length, 0);
  // Outage surface (audit D-FEED-ERROR / page law "query errors must be
  // surfaced"): with no data to show and every league query failed, the feed
  // must say so instead of claiming an empty slate.
  const isError = ncaafOnly
    ? ncaafQuery.isError
    : mlbQuery.isError && ncaafQuery.isError && wcQuery.isError;
  const retry = () => {
    if (ncaafOnly) void ncaafQuery.refetch();
    else {
      void mlbQuery.refetch();
      void ncaafQuery.refetch();
      void wcQuery.refetch();
    }
  };
  return { sections, isLoading, isStale, gamesCount, isError, retry };
}
