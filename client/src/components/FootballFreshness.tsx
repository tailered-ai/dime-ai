import {
  footballFreshness,
  type FootballMarketState,
} from "@shared/footballMarkets";

/** Reuses the Feed's quiet metadata tier. Each provider owns its own clock. */
export function FootballFreshness({
  state,
  kickoff,
}: {
  state?: FootballMarketState | null;
  kickoff?: number | null;
}) {
  return (
    <p
      className="ds-caption px-3 py-2 text-center"
      style={{ color: "var(--text-secondary, var(--dime-text-secondary))" }}
    >
      {(["an_dk", "vsin_dk"] as const).map((provider, index) => {
        const observation = state?.[provider];
        return (
          <span key={provider} className="block">
            {index === 0 ? "Book · Action Network DK" : "Splits"}:{" "}
            {footballFreshness(state, provider, Date.now(), kickoff)}
            {observation && (
              <>
                {" "}
                · observed{" "}
                {new Date(observation.receivedAt).toLocaleString("en-US", {
                  timeZone: "America/New_York",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}{" "}
                ET
              </>
            )}
            {observation?.missing.length ? (
              <>
                {" "}
                · {observation.missing.length} fields unavailable; retained book
                values are last known
              </>
            ) : null}
            {provider === "vsin_dk" && observation?.splitLines && (
              <span className="block">
                Split thresholds: away{" "}
                {observation.splitLines.awaySpread ?? "unavailable"} / home{" "}
                {observation.splitLines.homeSpread ?? "unavailable"}; total{" "}
                {observation.splitLines.total ?? "unavailable"}. These are split
                thresholds, not book prices.
              </span>
            )}
          </span>
        );
      })}
    </p>
  );
}
