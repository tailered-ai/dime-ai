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
  // Which side (if any) is the signal? Highest positive edge among this market's sides.
  const scored = market.sides.map(s => scoreMarketSide(s));
  let signalIdx = -1;
  let best = 0;
  scored.forEach((m, i) => {
    if (m && m.recommendation !== "NO_EDGE" && m.edgePP > best) {
      best = m.edgePP;
      signalIdx = i;
    }
  });

  return (
    <table className="market-table">
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
                {side.sideLabel}
              </th>
              <td className="odds-value">{fmtPrice(side.bookPrice)}</td>
              <td
                className={`odds-value${isSignal ? " market-table__model--signal" : ""}`}
              >
                {side.modelLineLabel && side.modelPrice != null ? (
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
      {(market.resultLabel || market.note) && (
        <tfoot>
          {market.note && (
            <tr>
              <td colSpan={3} className="market-table__result">
                {market.note}
              </td>
            </tr>
          )}
          {market.resultLabel && (
            <tr>
              <td
                colSpan={3}
                className={`market-table__result ds-label${market.resultIsEdge ? " market-table__result--edge" : ""}`}
              >
                {market.resultLabel}
              </td>
            </tr>
          )}
        </tfoot>
      )}
    </table>
  );
}
