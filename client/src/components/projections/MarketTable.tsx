import { scoreMarketSide } from "@/lib/gameInsight";
import type { ProjectionMarket } from "./types";

/**
 * MarketTable — one market rendered as a semantic <table> (Law v3 §markets):
 * SIDE, BOOK, MODEL. Compact column terminology is the owner directive
 * (2026-07-17) across mobile, tablet, and desktop feeds. Numeric cells are
 * tabular-nums, values left-aligned; the market title centers above the table
 * (owner directive 2026-07-18). The model column goes mint ONLY on the side
 * that actually carries the edge; the edge PERCENTAGE lives in the footer
 * ("Spain ML · +3.1%"), never inline beside the model price. Participant-bound
 * sides carry their country flag before the label. No nested frames: the
 * table is flat.
 */
function fmtPrice(p: number | null | undefined): string {
  if (typeof p !== "number" || !Number.isFinite(p)) return "—";
  return p > 0 ? `+${p}` : `${p}`; // American odds keep their own sign; − is U+2212 via CSS? keep ASCII for odds
}

export function MarketTable({ market }: { market: ProjectionMarket }) {
  const showLines = market.sides.some(side => side.lineDisplay);
  // Which side (if any) is the signal? Highest positive edge among this market's sides.
  const scored = market.sides.map(s => scoreMarketSide(s));
  let signalIdx = -1;
  let best = 0;
  scored.forEach((m, i) => {
    if (m && (showLines || m.recommendation !== "NO_EDGE") && m.edgePP > best) {
      best = m.edgePP;
      signalIdx = i;
    }
  });
  const resultLabel = showLines
    ? best > 0
      ? `EDGE ${best < 0.1 ? "<0.1" : `+${best.toFixed(1)}`}%`
      : "NO EDGE"
    : market.resultLabel;
  const resultIsEdge = showLines ? best > 0 : market.resultIsEdge;

  return (
    <table className={`market-table${showLines ? " market-table--lines" : ""}`}>
      <caption className="market-table__caption ds-label">
        {market.label}
      </caption>
      <thead>
        <tr>
          <th scope="col">Side</th>
          <th scope="col">Book</th>
          <th scope="col">Model</th>
        </tr>
      </thead>
      <tbody>
        {market.sides.map((side, i) => {
          const isSignal = i === signalIdx;
          return (
            <tr
              key={side.sideLabel}
              className={isSignal ? "market-table__row--signal" : undefined}
            >
              <th scope="row" className="market-table__side">
                {side.flag && (
                  <span className="market-table__flag" aria-hidden="true">
                    {side.flag}
                  </span>
                )}
                {side.lineDisplay?.side ?? side.sideLabel}
              </th>
              <td className="odds-value">
                {side.lineDisplay?.book != null && (
                  <span className="market-table__line">
                    {side.lineDisplay.book}
                  </span>
                )}
                <span className="market-table__price">
                  {side.lineDisplay?.book != null
                    ? `(${fmtPrice(side.bookPrice)})`
                    : fmtPrice(side.bookPrice)}
                </span>
              </td>
              <td
                className={`odds-value${isSignal ? " market-table__model--signal" : ""}`}
              >
                {side.lineDisplay ? (
                  <>
                    {side.lineDisplay.model != null && (
                      <span className="market-table__line">
                        {side.lineDisplay.model}
                      </span>
                    )}
                    <span className="market-table__price">
                      {side.lineDisplay.model != null
                        ? `(${fmtPrice(side.modelPrice)})`
                        : fmtPrice(side.modelPrice)}
                    </span>
                    {side.modelPrice != null && side.lineDisplay.priceAt && (
                      <span className="market-table__basis">
                        {side.lineDisplay.priceAt === "line unavailable"
                          ? "Pricing line unavailable"
                          : `at ${side.lineDisplay.priceAt}`}
                      </span>
                    )}
                  </>
                ) : side.modelLineLabel && side.modelPrice != null ? (
                  <>
                    <span className="block">{side.modelLineLabel}</span>
                    <span>({fmtPrice(side.modelPrice)})</span>
                  </>
                ) : (
                  fmtPrice(side.modelPrice)
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
      {(resultLabel || market.note) && (
        <tfoot>
          {!showLines && market.note && (
            <tr>
              <td colSpan={3} className="market-table__result">
                {market.note}
              </td>
            </tr>
          )}
          {resultLabel && (
            <tr>
              <td
                colSpan={3}
                className={`market-table__result ds-label${resultIsEdge ? " market-table__result--edge" : ""}`}
              >
                {resultLabel}
              </td>
            </tr>
          )}
        </tfoot>
      )}
    </table>
  );
}
