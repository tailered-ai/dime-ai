import type { MarketSideInput } from "@/lib/gameInsight";

/** A team as the projection card renders it. `logo` is a transparent asset URL;
 *  when absent, the card falls back to a monogram disc (logo-exception color). */
export interface ProjectionTeam {
  abbr: string;
  name: string;
  logo?: string | null;
  /** primary color for the monogram-disc fallback only (Three-Color Law logo exception) */
  color?: string | null;
  score?: number | null;
  /** "country" ⇒ render the flag emoji (no frame); "team" ⇒ logo/monogram. */
  kind?: "team" | "country";
  /** Country flag emoji, bound to the participant's name from the same source. */
  flag?: string | null;
}

/** Mirrors lib/sport EventStatus. `suspended` is first-class as of 2026-08-05
 *  (owner directive) — it no longer renders under postponed's label. */
export type GameStatus =
  "scheduled" | "live" | "final" | "postponed" | "suspended";

/** One rendered market side: the decision-engine input plus display extras. */
export interface ProjectionMarketSide extends MarketSideInput {
  /** Country flag emoji for participant-bound sides (soccer); null otherwise. */
  flag?: string | null;
}

/** One market (run line / total / moneyline) with its two sides. */
export interface ProjectionMarket {
  /** Context for prices at a different line; excluded from edge arithmetic. */
  note?: string;
  key: string; // "runline" | "total" | "moneyline"
  label: string; // "Run line" | "Total" | "Moneyline"
  sides: ProjectionMarketSide[]; // decision-engine shape + display extras
  /** footer line: "NO EDGE" or the winning side + edge ("Spain ML · +3.1%") */
  resultLabel?: string;
  /** true when resultLabel carries a real edge (mint footer styling) */
  resultIsEdge?: boolean;
}

/** One Rotowire batting-order entry, normalized before it reaches the card. */
export interface ProjectionLineupPlayer {
  battingOrder: number;
  position: string;
  name: string;
  bats: string | null;
  rotowireId: number | null;
  mlbamId: number | null;
}

/** The expected or confirmed starter shown on an upcoming MLB card. */
export interface ProjectionPitcher {
  name: string | null;
  hand: string | null;
  /** Rotowire's compact season line, e.g. "7-4 · 3.21 ERA". */
  seasonStats: string | null;
  rotowireId: number | null;
  mlbamId: number | null;
  confirmed: boolean;
}

export interface ProjectionTeamLineup {
  pitcher: ProjectionPitcher;
  battingOrder: ProjectionLineupPlayer[];
  confirmed: boolean;
}

/**
 * Rotowire's pregame read model. It is deliberately optional on ProjectionGame:
 * only scheduled MLB cards receive it, while live/final and non-MLB cards keep
 * their existing compact shape.
 */
export interface ProjectionPregameLineups {
  source: "Rotowire";
  scrapedAt: number | null;
  away: ProjectionTeamLineup;
  home: ProjectionTeamLineup;
}

export interface ProjectionGame {
  id: string;
  league: string; // "MLB"
  status: GameStatus;
  /** The one status line, rendered centered in the card header at EVERY state
   *  (owner directive 2026-08-05): "8:40 PM ET" | "LIVE · BOT 8TH" | "FINAL" |
   *  "POSTPONED" | "SUSPENDED". */
  statusLabel: string;
  away: ProjectionTeam;
  home: ProjectionTeam;
  /** Secondary context under the matchup line — the MLB ballpark (scheduled
   *  only), or soccer's round label ("World Cup Final", every state). */
  matchupContext?: string;
  /** Stadium line — SCHEDULED ONLY (owner directive 2026-08-05). */
  venue?: string;
  /** First pitch / kickoff in ET ("10:10 PM ET") — SCHEDULED ONLY; the header
   *  owns the clock for every other state (owner directive 2026-08-05). */
  startTime?: string;
  /** Scheduled-MLB-only probable pitchers and batting orders from Rotowire. */
  pregameLineups?: ProjectionPregameLineups;
  markets: ProjectionMarket[];
  /**
   * FALSE when this game has no published model output at all — either the
   * model never ran (`modelRunAt` is null) or every market was withheld by the
   * per-market publication gate (`MLB_MARKET_GATE_MODE=on`).
   *
   * This is a THIRD card state, and it is not PASS. PASS means the model ran
   * and found nothing worth acting on; "no model" means there was nothing to
   * find anything with. The same distinction the owner drew between PASS and
   * `unplayable` (pages/ai-model-projections.md, 2026-08-06: "They look similar
   * and they mean opposite things, so they get separate modifiers").
   *
   * Optional and defaulting to published, so every existing caller and fixture
   * keeps its current behavior.
   */
  modelPublished?: boolean;
}
