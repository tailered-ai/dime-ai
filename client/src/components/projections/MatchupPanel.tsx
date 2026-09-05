import { useLayoutEffect, useRef, useState } from "react";
import { TeamLogoMark } from "./TeamLogoMark";
import type { ProjectionGame } from "./types";

/**
 * MatchupPanel — the gamecard's identity block (owner directive 2026-07-17,
 * amended 2026-08-05). Logos flank a centered stack:
 *
 *   {AWAY TEAM NAME} @ {HOME TEAM NAME}   ← "Giants @ Mariners"
 *   {BALLPARK / STAGE CONTEXT}            ← "T-Mobile Park" — pregame only
 *
 * Full names when they fit; canonical abbreviations in constrained lanes.
 * The venue is suppressed when the context line already carries it — each fact
 * renders once. Scores stay beside the logos for live/final games.
 *
 * Single rendering ownership (owner directive 2026-08-05, superseding the
 * 2026-07-17 §3 split): ProjectionCard's centered header owns the status for
 * EVERY state, first-pitch time included, so this panel no longer renders a
 * time line at all. Ballpark and start time are gated to scheduled games here
 * as a backstop — the adapters (lib/sport/presentation.ts, fromFeedSpec.ts)
 * gate them at the source, and this makes the law hold for any future adapter
 * that forgets to. See ProjectionCard.test.ts.
 */
export function MatchupPanel({ game }: { game: ProjectionGame }) {
  const { away, home, matchupContext, venue } = game;
  const centerRef = useRef<HTMLDivElement>(null);
  const fullNameRef = useRef<HTMLSpanElement>(null);
  const [compactNames, setCompactNames] = useState(true);
  useLayoutEffect(() => {
    const center = centerRef.current;
    const fullName = fullNameRef.current;
    if (!center || !fullName) return;
    const measure = () =>
      setCompactNames(
        fullName.getBoundingClientRect().width > center.clientWidth
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(center);
    observer.observe(fullName);
    return () => observer.disconnect();
  }, [away.name, home.name]);
  const showScore = away.score != null && home.score != null;
  const isPregame = game.status === "scheduled";
  // No duplicate ballpark: drop the venue line when the context already has it.
  const showVenue =
    isPregame && !!venue && !(matchupContext ?? "").includes(venue);
  // The context line is NOT gated here: on MLB rows it is the ballpark (the
  // adapters already drop it off-pregame), but on soccer rows it is the round
  // label, which survives every state. Only the adapters know which sport they
  // are shaping, so that call stays theirs.

  return (
    <div className="matchup">
      <div className="matchup__grid">
        <div className="matchup__team matchup__team--away">
          <TeamLogoMark team={away} />
          {showScore && (
            <span className="matchup__score score-value">{away.score}</span>
          )}
        </div>

        <div
          className="matchup__center"
          ref={centerRef}
          role="group"
          aria-label={`${away.name} at ${home.name}`}
        >
          <span
            className="matchup__line matchup__line--measure"
            ref={fullNameRef}
            aria-hidden="true"
          >
            {away.name} <span className="matchup__at">@</span> {home.name}
          </span>
          <span
            className="matchup__line"
            title={`${away.name} @ ${home.name}`}
            aria-hidden="true"
            data-compact={compactNames}
          >
            {compactNames ? away.abbr || away.name : away.name}{" "}
            <span className="matchup__at" aria-hidden="true">
              @
            </span>{" "}
            {compactNames ? home.abbr || home.name : home.name}
          </span>
        </div>

        <div className="matchup__team matchup__team--home">
          {showScore && (
            <span className="matchup__score score-value">{home.score}</span>
          )}
          <TeamLogoMark team={home} />
        </div>

        {/* Context/venue span the FULL card width beneath the flag row —
            2.5x flags (owner directive 2026-07-18) squeeze the center column,
            and the venue must never truncate. The first-pitch line that used to
            close this stack moved to the centered card header (2026-08-05). */}
        {(matchupContext || showVenue) && (
          <div className="matchup__below">
            {matchupContext && (
              <span
                className="matchup__context ds-truncate"
                title={matchupContext}
              >
                {matchupContext}
              </span>
            )}
            {showVenue && (
              <span className="matchup__venue ds-truncate" title={venue}>
                {venue}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
