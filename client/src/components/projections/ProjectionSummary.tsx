import { ChevronRight } from "lucide-react";
import { EdgeIndicator } from "./EdgeIndicator";
import type { MarketInsight } from "@/lib/gameInsight";
import type { ProjectionMarket, ProjectionTeam } from "./types";

/**
 * ProjectionSummary — the card's dominant, 3-second insight (Law v3). Surfaces
 * the single strongest opportunity from primaryInsight(): the EdgeIndicator plus
 * the readout — MODEL EDGE / BOOK / MODEL, each on its own labeled element.
 * Every value is derived by the decision engine, never styled in. When there's
 * no actionable edge, the visual badge shows only its neutral no-vig ROI.
 *
 * Owner directive 2026-07-17: the MODEL EDGE value is spelled out — "U 7"
 * reads "Under 7", "ATH ML" reads "Athletics ML" (CSS uppercases the display).
 * Since 2026-07-18 the presentation adapter pre-spells team-sport labels
 * ("Yankees ML", "Under 9"), so spellOutPick is the safety net for any label
 * that still arrives compact.
 */
function fmtPrice(p: number): string {
  if (!Number.isFinite(p)) return "—";
  return p > 0 ? `+${p}` : `${p}`;
}

/** Expand a market side label for the readout: O/U → Over/Under, a leading
 *  team abbreviation → that team's name. Anything unrecognized passes through
 *  verbatim, so soccer labels ("Spain Win or Draw", "Draw") are never mangled. */
export function spellOutPick(label: string, teams: ProjectionTeam[]): string {
  const [head, ...rest] = label.trim().split(/\s+/);
  if (!head) return label;
  const tail = rest.join(" ");
  const withTail = (s: string) => (tail ? `${s} ${tail}` : s);
  if (head.toUpperCase() === "U") return withTail("Under");
  if (head.toUpperCase() === "O") return withTail("Over");
  const team = teams.find(t => t.abbr === head && t.name && t.name !== head);
  if (team) return withTail(team.name);
  return label;
}

export function ProjectionSummary({
  insight,
  teams = [],
  modelPublished = true,
  comparisonUnavailable = false,
  comparisonMarkets,
  onNextEdge,
  nextEdgeLabel,
  positionLabel,
  nextEdgeTabIndex = 0,
  nextEdgeButtonRef,
}: {
  insight: MarketInsight | null;
  teams?: ProjectionTeam[];
  /** False when the game has NO published model output — see ProjectionGame. */
  modelPublished?: boolean;
  comparisonUnavailable?: boolean;
  /** Unranked market context; mismatched model odds stay in full details. */
  comparisonMarkets?: ProjectionMarket[];
  onNextEdge?: () => void;
  nextEdgeLabel?: string;
  positionLabel?: string;
  nextEdgeTabIndex?: number;
  nextEdgeButtonRef?: (element: HTMLButtonElement | null) => void;
}) {
  // Readout above the EdgeIndicator (owner directive 2026-07-18): the
  // MODEL EDGE / BOOK / MODEL facts lead, the labeled signal sits beneath.
  //
  // A scored no-edge case uses the SAME readout structure as an edge card,
  // with an ROI-only neutral badge in the signal slot. A genuinely unscorable
  // game gets the unavailable-data sentence and no empty signal badge.
  //
  // 2026-08-05 (a11y refinement): every card exposes this tabbable region, so
  // on a full slate a screen-reader rotor listed N identical "Model
  // projection summary" entries. Including the matchup makes each stop
  // distinguishable without adding an extra tab stop.
  const regionLabel =
    teams.length >= 2 && teams[0]?.name && teams[1]?.name
      ? `Model projection summary: ${teams[0].name} at ${teams[1].name}`
      : "Model projection summary";
  const comparison = !insight
    ? comparisonMarkets?.find(market => market.sides.length > 0)
    : undefined;
  const side = comparison?.sides[0];
  // A projected line is not the threshold that priced model odds. Show the
  // projection alone here; the full table retains the odds and explicit basis.
  const modelProjection = modelPublished ? side?.lineDisplay?.model : undefined;
  const compactModel =
    modelProjection ??
    (modelPublished && side?.comparable !== false && side?.modelPrice != null
      ? fmtPrice(side.modelPrice)
      : "—");
  return (
    <div
      className={`summary ${side ? "summary--comparison" : insight ? "summary--priced" : "summary--empty"}`}
    >
      <div
        className="summary__viewport"
        role="region"
        aria-label={regionLabel}
        tabIndex={nextEdgeTabIndex ?? 0}
      >
        <div className="summary__group">
          <dl className="summary__readout">
            {side ? (
              <>
                <div className="summary__item summary__item--edge">
                  <dt className="ds-label">{comparison?.label}</dt>
                  <dd className="summary__pick">
                    {spellOutPick(
                      side.lineDisplay?.side ?? side.sideLabel,
                      teams
                    )}
                  </dd>
                </div>
                <div className="summary__item summary__item--book">
                  <dt className="ds-label">Book</dt>
                  <dd className="odds-value">
                    {side.lineDisplay?.book != null
                      ? `${side.lineDisplay.book} (${side.bookPrice != null ? fmtPrice(side.bookPrice) : "—"})`
                      : side.bookPrice != null
                        ? fmtPrice(side.bookPrice)
                        : "—"}
                  </dd>
                </div>
                <div className="summary__item summary__item--model">
                  <dt className="ds-label">
                    {modelProjection != null ? "Model line" : "Model"}
                  </dt>
                  <dd className="odds-value">{compactModel}</dd>
                </div>
              </>
            ) : insight ? (
              <>
                <div className="summary__item summary__item--edge">
                  <dt className="ds-label">Model edge</dt>
                  <dd className="summary__pick">
                    {spellOutPick(insight.sideLabel, teams)}
                  </dd>
                </div>
                <div className="summary__item summary__item--book">
                  {/* "Book" not "Best price" — owner directive 2026-07-17 */}
                  <dt className="ds-label">Book</dt>
                  <dd className="odds-value">{fmtPrice(insight.bookPrice)}</dd>
                </div>
                <div className="summary__item summary__item--model">
                  {/* "Model" not "Model fair price" — owner directive 2026-07-17 */}
                  <dt className="ds-label">Model</dt>
                  <dd className="odds-value">
                    {fmtPrice(insight.modelFairPrice)}
                  </dd>
                </div>
              </>
            ) : (
              <div className="summary__item summary__item--message">
                <dt className="sr-only">Projection status</dt>
                <dd className="summary__none ds-body-sm">
                  {comparisonUnavailable
                    ? "Book/model comparison unavailable."
                    : modelPublished
                      ? "Every market is efficiently priced. No action."
                      : "No model projection published for this game."}
                </dd>
              </div>
            )}
          </dl>
          {(insight || side) && (
            <div className="summary__signal">
              {insight ? (
                <EdgeIndicator insight={insight} className="summary__edge" />
              ) : (
                <span
                  className="summary__comparison-status"
                  aria-label={
                    !modelPublished
                      ? "No model projection published for this game."
                      : undefined
                  }
                >
                  {!modelPublished
                    ? "Model unavailable"
                    : modelProjection != null && modelProjection !== "—"
                      ? "Projection only"
                      : "Comparison unavailable"}
                </span>
              )}
              {onNextEdge && nextEdgeLabel && (
                <button
                  type="button"
                  className="summary__next"
                  aria-label={nextEdgeLabel}
                  tabIndex={nextEdgeTabIndex}
                  ref={nextEdgeButtonRef}
                  onClick={onNextEdge}
                >
                  {positionLabel && (
                    <span className="summary__position" aria-hidden="true">
                      {positionLabel}
                    </span>
                  )}
                  <ChevronRight
                    size={14}
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
