/**
 * gradingSupport.ts — which (sport, timeframe) pairs the grader can actually settle.
 *
 * WHY THIS EXISTS
 *
 * The bet form offered six sports and nine timeframes and validated neither
 * against the other, so a user could log combinations the grader has no code
 * path for. Those bets do not fail loudly — they resolve to no game, stay
 * PENDING, and only surface 36 hours later as a stuck-bet alarm. Two whole
 * sports were in that state:
 *
 *   NFL     accepted by the form, absent from the grader's switch entirely.
 *           Every NFL bet logged "Unknown sport" once per cycle, forever.
 *   CUSTOM  has no score feed by design — a manual-entry escape hatch — but
 *           nothing said so, so it took the same silent path.
 *
 * Mismatched timeframes had the same shape: MLB + FIRST_PERIOD, NBA + NRFI,
 * NCAAM + FIRST_QUARTER are all accepted by the form and ungradeable in fact.
 *
 * Parlays raised the stakes. A ticket is all-or-nothing, so ONE ungradeable
 * leg holds the whole ticket open indefinitely — the user's stake stays
 * counted as open risk on a bet that can never resolve.
 *
 * This is the single declaration both the server (write-time rejection) and
 * the client (which timeframes to offer) read, so the form cannot drift from
 * what the grader implements.
 */

export type GradableSport = "NCAAF" | "MLB" | "NHL" | "NBA" | "NCAAM" | "NFL";
export type AnySport = GradableSport | "CUSTOM";

export type GradingTimeframe =
  | "FULL_GAME"
  | "REGULATION"
  | "FIRST_PERIOD"
  | "FIRST_HALF"
  | "FIRST_QUARTER"
  | "FIRST_5"
  | "FIRST_INNING"
  | "NRFI"
  | "YRFI";

/**
 * The timeframes each sport's fetcher actually populates.
 *
 * Every entry here corresponds to a key the matching fetch*Scores builds in its
 * `scores` map. Adding a timeframe to this table without adding it there
 * re-creates exactly the bug this file exists to prevent, which is what
 * `gradingSupport.test.ts` checks against the grader source.
 */
export const SPORT_TIMEFRAMES: Record<
  GradableSport,
  readonly GradingTimeframe[]
> = {
  // Quarters, plus regulation for overtime games.
  NCAAF: ["FULL_GAME", "REGULATION", "FIRST_HALF", "FIRST_QUARTER"],
  // Innings, so first-5 and first-inning windows exist. NRFI/YRFI are the
  // first-inning total expressed as a 0.5 line.
  MLB: ["FULL_GAME", "FIRST_5", "FIRST_INNING", "NRFI", "YRFI"],
  // Periods, and regulation is meaningful because OT/SO decide ties.
  NHL: ["FULL_GAME", "REGULATION", "FIRST_PERIOD"],
  // Quarters.
  NBA: ["FULL_GAME", "FIRST_HALF", "FIRST_QUARTER"],
  // Halves — college basketball has no quarters, so FIRST_QUARTER is absent
  // on purpose rather than by omission.
  NCAAM: ["FULL_GAME", "FIRST_HALF"],
  // Quarters, plus regulation: an NFL game tied after four quarters is decided
  // in OT, so REGULATION and FULL_GAME genuinely differ.
  NFL: ["FULL_GAME", "REGULATION", "FIRST_HALF", "FIRST_QUARTER"],
} as const;

/** Sports with a score feed. CUSTOM is deliberately not one of them. */
export const GRADABLE_SPORTS = Object.keys(SPORT_TIMEFRAMES) as GradableSport[];

export function isGradableSport(sport: string): sport is GradableSport {
  return sport in SPORT_TIMEFRAMES;
}

/** Timeframes to offer for a sport. Empty for anything with no feed. */
export function timeframesForSport(sport: string): readonly GradingTimeframe[] {
  return isGradableSport(sport) ? SPORT_TIMEFRAMES[sport] : [];
}

export type GradingSupport =
  | { ok: true }
  | { ok: false; reason: "NO_FEED" | "TIMEFRAME"; message: string };

/**
 * Can the grader settle this combination?
 *
 * Called at WRITE time, deliberately. The same reasoning as the RL/TOTAL line
 * invariant: a bet the grader cannot resolve is far cheaper to refuse now than
 * to explain 36 hours later, and on a parlay it would strand every other leg
 * on the ticket too.
 */
export function checkGradingSupport(
  sport: string,
  timeframe: string
): GradingSupport {
  if (!isGradableSport(sport)) {
    return {
      ok: false,
      reason: "NO_FEED",
      message:
        `${sport} has no score feed, so this bet could never be graded automatically. ` +
        `Pick a sport with live scores (${GRADABLE_SPORTS.join(", ")}).`,
    };
  }
  const allowed = SPORT_TIMEFRAMES[sport];
  if (!allowed.includes(timeframe as GradingTimeframe)) {
    return {
      ok: false,
      reason: "TIMEFRAME",
      message:
        `${sport} bets cannot be graded on ${humanTimeframe(timeframe)}. ` +
        `Available for ${sport}: ${allowed.map(humanTimeframe).join(", ")}.`,
    };
  }
  return { ok: true };
}

/** Display name for a timeframe, used in the messages above and in the UI. */
export function humanTimeframe(tf: string): string {
  switch (tf) {
    case "FULL_GAME":
      return "Full Game";
    case "REGULATION":
      return "Regulation";
    case "FIRST_PERIOD":
      return "1st Period";
    case "FIRST_HALF":
      return "1st Half";
    case "FIRST_QUARTER":
      return "1st Quarter";
    case "FIRST_5":
      return "First 5 Innings";
    case "FIRST_INNING":
      return "1st Inning";
    case "NRFI":
      return "NRFI";
    case "YRFI":
      return "YRFI";
    default:
      return tf;
  }
}
