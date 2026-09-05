import { useRef, useState } from "react";
import type { MarketInsight } from "@/lib/gameInsight";
import { ProjectionSummary } from "./ProjectionSummary";
import type { ProjectionMarket, ProjectionTeam } from "./types";

export function clampActiveEdgeIndex(active: number, count: number): number {
  return Math.max(0, Math.min(active, Math.max(0, count - 1)));
}

/**
 * SummaryCarousel — a game with more than one ranked projection cycles them
 * in a swipeable strip (owner directive 2026-07-18). Actionable games show one
 * slide per edge in
 * the exact ProjectionSummary format (uniform readout: MODEL EDGE / BOOK /
 * MODEL + the mint edge cell); slides arrive pre-ranked strongest → weakest,
 * so the first visible edge is always the strongest. No-action games instead
 * show one best canonical no-vig ROI side per market, ranked highest → lowest,
 * with a neutral ROI-only badge on every slide.
 *
 * Mechanics per brand law: native scroll-snap (momentum swipe on touch,
 * trackpad/scroll on desktop, interruptible by design) plus one compact,
 * accessible next-edge arrow immediately after the edge pill. The last
 * edge wraps to the strongest edge. Prefers-reduced-motion collapses smooth
 * scrolling to an instant jump.
 */
export function SummaryCarousel({
  insights = [],
  comparisonMarkets,
  teams = [],
  variant = "edge",
}: {
  insights?: MarketInsight[];
  comparisonMarkets?: ProjectionMarket[];
  teams?: ProjectionTeam[];
  variant?: "edge" | "no-edge";
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const nextButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [active, setActive] = useState(0);
  const isComparison = Boolean(comparisonMarkets?.length);
  const slides = isComparison
    ? comparisonMarkets!.map(market => ({ key: market.key, label: market.label, market, insight: null }))
    : insights.map(insight => ({ key: `${insight.marketKey}-${insight.sideLabel}`, label: insight.sideLabel, market: undefined, insight }));
  const activeIndex = clampActiveEdgeIndex(active, slides.length);
  const isNoEdgeRanking = variant === "no-edge";

  const onScroll = () => {
    const el = trackRef.current;
    if (!el || el.clientWidth === 0) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    setActive(clampActiveEdgeIndex(i, slides.length));
  };

  const goTo = (i: number, moveFocus = false) => {
    const el = trackRef.current;
    if (!el) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    setActive(i);
    el.scrollTo({ left: i * el.clientWidth, behavior: reduce ? "auto" : "smooth" });
    if (moveFocus) {
      requestAnimationFrame(() => nextButtonRefs.current[i]?.focus({ preventScroll: true }));
    }
  };

  return (
    <section
      className={`summary-carousel summary-carousel--${isComparison ? "comparison" : variant}`}
      role="group"
      aria-roledescription="carousel"
      aria-label={
        isComparison
          ? `${slides.length} Book and Model markets`
          : isNoEdgeRanking
          ? `${insights.length} non-actionable market projections, ranked by no-vig ROI`
          : `${insights.length} model edges, ranked strongest first`
      }
    >
      <div
        className="summary-carousel__track"
        ref={trackRef}
        onScroll={onScroll}
        // Audit DIME-UI-012: the track stays OUT of the tab order — each slide
        // already exposes a labeled tabbable region (summary__viewport) and
        // the next-edge arrow advances the carousel, so a second nested
        // scroll stop per card was pure tab bloat.
        tabIndex={-1}
        aria-label={
          isComparison
            ? "Swipe through this game's Book and Model markets"
            : isNoEdgeRanking
            ? "Swipe through this game's highest no-vig ROI market projections"
            : "Swipe through this game's model edges"
        }
      >
        {slides.map((slide, i) => (
          <div
            key={slide.key}
            className="summary-carousel__slide"
            role="group"
            aria-roledescription="slide"
            aria-label={
              isComparison
                ? `Market ${i + 1} of ${slides.length}: ${slide.label}; Book and Model values`
                : isNoEdgeRanking
                  ? `Projection ${i + 1} of ${slides.length}: ${slide.label}; no actionable edge`
                  : `Edge ${i + 1} of ${slides.length}: ${slide.label}`
            }
          >
            <ProjectionSummary
              insight={slide.insight}
              comparisonMarkets={slide.market ? [slide.market] : undefined}
              teams={teams}
              onNextEdge={() => goTo((i + 1) % slides.length, true)}
              nextEdgeLabel={`View next ${
                isComparison ? "market" : isNoEdgeRanking ? "projection" : "model edge"
              }: ${slides[(i + 1) % slides.length]?.label} (${
                (i + 1) % slides.length + 1
              } of ${slides.length})`}
              nextEdgeTabIndex={i === activeIndex ? 0 : -1}
              nextEdgeButtonRef={(element) => {
                nextButtonRefs.current[i] = element;
              }}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
