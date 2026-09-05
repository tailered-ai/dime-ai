import { rankMarkets, type MarketInsight } from "@/lib/gameInsight";
import { MatchupPanel } from "./MatchupPanel";
import { MlbPregamePanel } from "./MlbPregamePanel";
import { ProjectionMarketsPopover } from "./ProjectionMarketsPopover";
import { ProjectionSummary } from "./ProjectionSummary";
import { SummaryCarousel } from "./SummaryCarousel";
import type { ProjectionGame } from "./types";
import "./ProjectionCard.css";

/**
 * ProjectionCard — one game, structured for a 3-second decision (Law v3).
 *
 * Order: status (centered, EVERY state) → matchup block (matchup line ·
 * ballpark, scheduled only) → scheduled-MLB probable pitchers → the dominant
 * model insight (summary) → the full market tables in an anchored, paginated
 * popover. There is no corner league label: the feed's sport chip already names
 * the competition (owner directive 2026-07-18).
 *
 * Owner directive 2026-08-05 (supersedes the 2026-07-17 §3 split): ONE status
 * slot, horizontally centered, directly above the away/home row, identical in
 * placement and register for scheduled / live / final / postponed / suspended.
 * The scheduled card's first-pitch time is that slot's content, so it is no
 * longer printed by the matchup block — each fact renders exactly once.
 *
 * The market popover is closed by default behind "View full AI model
 * projections". It renders one market per page, preserving source order
 * without changing the card's height.
 * The card is its own container (`ds-cq`), so the layout REFLOWS by the card's
 * width, not the viewport — structure adapts before type ever shrinks.
 */
/** Every actionable edge on the game, ranked strongest → weakest by the
 *  decision engine, at most one side per market. */
export function rankedEdges(game: ProjectionGame): MarketInsight[] {
  const seen = new Set<string>();
  return rankMarkets(game.markets.flatMap(m => m.sides)).filter(m => {
    if (m.recommendation === "NO_EDGE" || seen.has(m.marketKey)) return false;
    seen.add(m.marketKey);
    return true;
  });
}

/**
 * A no-action game's most useful market context: the highest canonical no-vig
 * ROI side from each scorable market, ranked best → worst. Zero and negative ROI
 * remain eligible; each item stays visually neutral because none cleared
 * WATCH/BET. `roiPct` is the product's canonical no-vig ROI, so this order is
 * independent of raw probability-edge and posted-price EV order.
 */
export function rankedNoEdgeCandidates(game: ProjectionGame): MarketInsight[] {
  const seen = new Set<string>();
  return rankMarkets(game.markets.flatMap(m => m.sides))
    .filter(insight => insight.recommendation === "NO_EDGE")
    .sort((a, b) => {
      const aRoi = a.roiPct ?? Number.NEGATIVE_INFINITY;
      const bRoi = b.roiPct ?? Number.NEGATIVE_INFINITY;
      if (bRoi !== aRoi) return bRoi - aRoi;
      if (b.edgePP !== a.edgePP) return b.edgePP - a.edgePP;
      if (b.evUnits !== a.evUnits) return b.evUnits - a.evUnits;
      const marketOrder = a.marketKey.localeCompare(b.marketKey);
      return marketOrder || a.sideLabel.localeCompare(b.sideLabel);
    })
    .filter(insight => {
      if (seen.has(insight.marketKey)) return false;
      seen.add(insight.marketKey);
      return true;
    });
}

export function ProjectionCard({
  game,
  defaultMarketsOpen = false,
  onOpen,
}: {
  game: ProjectionGame;
  defaultMarketsOpen?: boolean;
  /** Fired when the user opens the market popover (analytics; presentational
   *  component stays pure — the caller owns the emit). Fire-and-forget. */
  onOpen?: () => void;
}) {
  const edges = rankedEdges(game);
  const fallbackCandidates =
    edges.length === 0 ? rankedNoEdgeCandidates(game) : [];
  const displayInsights = edges.length > 0 ? edges : fallbackCandidates;
  const showsNoEdgeRanking =
    edges.length === 0 && fallbackCandidates.length > 0;
  // Whole-card PASS state (Round 4 Wave 1, item 3 / page law "PASS games"):
  // no market on this game clears the WATCH/BET threshold. The fallback
  // candidates remain recommendation=NO_EDGE, so their richer readout can
  // never disagree with this whole-card state.
  // A LIVE card never takes PASS (final-review I2 precedence ruling,
  // 2026-07-23 — annotated in the page law):
  // live+no-edges is reachable (a mid-game model invalidation nulls every
  // model price). Live-ness wins that semantic conflict; lifecycle compaction
  // may still quiet the whole card independently of PASS.
  //
  // A card with NO published model is not a PASS card either. PASS asserts the
  // model priced the markets and found nothing; "no model" means it never
  // priced anything. Before this flag existed both collapsed into isPass, and
  // the empty summary told the user "Every market is efficiently priced. No
  // action." for a game the model had never touched — an analysis claim about
  // an analysis that did not happen. Same reasoning the owner used to split
  // `unplayable` out of PASS (pages/ai-model-projections.md, 2026-08-06).
  const modelPublished = game.modelPublished !== false;
  const comparisonUnavailable =
    modelPublished &&
    displayInsights.length === 0 &&
    game.markets.some(market =>
      market.sides.some(side => side.comparable === false)
    );
  const isNoModel = game.status !== "live" && !modelPublished;
  const isPass =
    game.status !== "live" &&
    modelPublished &&
    edges.length === 0 &&
    !comparisonUnavailable;
  // Unplayable (owner directive 2026-08-06): the game is not available to act
  // on, whatever the model found. Deliberately NOT folded into isPass — PASS
  // means "nothing worth acting on in a game that WILL be played", which is the
  // opposite claim. They share a treatment (zero mint, per MASTER.md's
  // rationing rule: an edge on a game that will not be played is not signal),
  // so they get separate modifiers over one set of neutralizing rules. A LIVE
  // card is never unplayable — in-play markets are actionable, mirroring the
  // 2026-07-23 ruling that a LIVE card never takes the PASS treatment.
  const isUnplayable =
    game.status === "postponed" || game.status === "suspended";
  const isCompact = game.status !== "scheduled";
  const showPregame =
    game.status === "scheduled" && game.pregameLineups != null;

  // The lifecycle state is the card's primary fact as of 2026-08-05, so it
  // belongs in the accessible name: browsing article-by-article otherwise
  // yields five identical "X at Y" with no way to tell live from final without
  // entering each card. Deliberately NOT an aria-live region — a 15-game slate
  // polling every 60s would interrupt a screen-reader user continuously; the
  // status is simply first in the card's reading order.
  // "no model" is appended, not substituted: the lifecycle state stays first
  // (2026-08-05 directive) and the announcement continues to agree with what is
  // rendered — the summary says the same thing in the same words.
  const cardLabel = isNoModel
    ? `${game.away.name} at ${game.home.name}, ${game.statusLabel}, no model projection published`
    : `${game.away.name} at ${game.home.name}, ${game.statusLabel}`;

  return (
    <article
      className={`projection-card ds-cq projection-card--${game.status}${game.league === "NCAAF" ? " projection-card--ncaaf" : ""}${isCompact ? " projection-card--compact" : ""}${showPregame ? " projection-card--with-pregame" : ""}${isPass ? " projection-card--pass" : ""}${isNoModel ? " projection-card--nomodel" : ""}${isUnplayable ? " projection-card--unplayable" : ""}`}
      aria-label={cardLabel}
    >
      {/* One centered status slot for every lifecycle state (owner directive
          2026-08-05). Scheduled renders the first-pitch time here; the matchup
          block below no longer carries it. */}
      <header className="projection-card__head">
        <span
          className={`projection-card__status projection-card__status--${game.status}`}
        >
          {/* Live indicator (owner directive / page law "Live state"): pulsing
              7px mint dot ahead of the mono-styled status text, at every
              breakpoint (2026-08-05) — see ProjectionCard.css. */}
          {game.status === "live" && (
            <span className="projection-card__live-dot" aria-hidden="true" />
          )}
          {game.statusLabel}
        </span>
      </header>

      <MatchupPanel game={game} />

      {game.status === "scheduled" && game.pregameLineups && (
        <MlbPregamePanel
          away={game.away}
          home={game.home}
          lineups={game.pregameLineups}
        />
      )}

      {/* Actionable games rank qualifying edges. Pass games use the same stable
          slot for one best-ROI candidate per market (including negative ROI),
          while every ROI-only badge remains explicitly neutral. */}
      {game.league === "NCAAF" &&
      comparisonUnavailable &&
      game.markets.length > 1 ? (
        <SummaryCarousel
          comparisonMarkets={game.markets}
          teams={[game.away, game.home]}
        />
      ) : displayInsights.length > 1 ? (
        <SummaryCarousel
          insights={displayInsights}
          teams={[game.away, game.home]}
          variant={showsNoEdgeRanking ? "no-edge" : "edge"}
        />
      ) : (
        <ProjectionSummary
          insight={displayInsights[0] ?? null}
          teams={[game.away, game.home]}
          modelPublished={modelPublished}
          comparisonUnavailable={comparisonUnavailable}
          comparisonMarkets={
            game.league === "NCAAF" && comparisonUnavailable
              ? game.markets
              : undefined
          }
        />
      )}

      {/* The popover portals to a floating surface OUTSIDE .projection-card,
          so a descendant selector cannot reach it — both flags travel by prop. */}
      <ProjectionMarketsPopover
        game={game}
        isPass={isPass}
        isUnplayable={isUnplayable}
        defaultOpen={defaultMarketsOpen}
        onOpen={onOpen}
      />
    </article>
  );
}
