/**
 * presentation.ts — the sport-aware presentation layer.
 *
 * ONE normalized model (`SportPresentationModel`) sits between each league's
 * data and the shared interface. Every sport is converted by a typed adapter in
 * `sportAdapters`; no league-specific `if` chains live in React components. The
 * adapters only RE-SHAPE and RE-LABEL already-computed data — every price, edge,
 * and projection is preserved exactly (the decision engine in gameInsight.ts and
 * edgeUtils.ts remains the single source of the numbers).
 *
 * Home/away is carried by explicit participant identity and event role, never by
 * row order. For soccer, a participant's country name, ISO code, and flag are
 * resolved together from one FIFA code (countries.ts), so they can never invert.
 */
import {
  rankMarkets,
  primaryInsight,
  type MarketInsight,
  type MarketSideInput,
} from "@/lib/gameInsight";
import { parseAmerican } from "@/components/projections/fromFeedSpec";
import { countryIdentity, isRawCountryCode } from "./countries";

// ─── The sport universe ──────────────────────────────────────────────────────

export type Sport =
  "MLB" | "NFL" | "NBA" | "NHL" | "NCAAF" | "NCAAM" | "SOCCER";
/** Lifecycle states. `suspended` became a first-class member on 2026-08-05
 *  (owner directive, pages/ai-model-projections.md) — it previously borrowed
 *  postponed's label and could not be told apart on a card. */
export type EventStatus =
  "scheduled" | "live" | "final" | "postponed" | "suspended";
export type EventRole = "home" | "away";
export type ParticipantKind = "team" | "country";

/** A team or country in an event. Identity is stable and never row-derived. */
export interface Participant {
  /** Stable identifier (team code / FIFA code) used to bind name+flag+prices. */
  id: string;
  role: EventRole;
  kind: ParticipantKind;
  /** Full human label — "Spain", "New York Yankees". NEVER a raw code. */
  displayName: string;
  /** Compact label for tight cells — a team abbrev, or the country name (no code). */
  shortName: string;
  /** Team logo asset URL; null for countries (they render a flag). */
  logo?: string | null;
  /** Brand color for a monogram fallback only. */
  color?: string | null;
  /** Country flag emoji; null for teams. */
  flag?: string | null;
  /** ISO 3166-1 alpha-2 for countries; null otherwise. */
  iso2?: string | null;
  score?: number | null;
}

export type SelectionRole =
  | EventRole
  | "draw"
  | "over"
  | "under"
  | "yes"
  | "no"
  | "home_or_draw"
  | "away_or_draw"
  | "neutral";

/** One selectable side of a market, bound to a participant where applicable. */
export interface MarketSelectionModel {
  modelLineLabel?: string;
  comparable?: boolean;
  id: string;
  role: SelectionRole;
  /** Rendered label — participant-resolved, never a raw country code. */
  label: string;
  /** The participant this selection belongs to (ML/spread/double-chance sides). */
  participantId?: string;
  /** Flag for the bound participant, sourced from the SAME object as its name. */
  flag?: string | null;
  bookPrice: number | null;
  modelPrice: number | null;
}

export interface MarketPresentationModel {
  note?: string;
  key: string;
  /** Sport-appropriate market name — never forced into MLB terminology. */
  label: string;
  selections: MarketSelectionModel[];
  /** The market's footer line: "NO EDGE", or the winning side + edge
   *  ("Spain ML · +3.1%") — edges live in the footer (owner directive
   *  2026-07-18), never inline beside the model price. */
  resultLabel?: string;
  /** True when resultLabel carries a real edge (mint footer styling). */
  resultIsEdge?: boolean;
}

/** The existing projection/decision output, unchanged — just carried along. */
export interface ProjectionSummaryModel {
  primary: MarketInsight | null;
  ranked: MarketInsight[];
}

export interface SportPresentationModel {
  eventId: string;
  sport: Sport;
  /** Short competition label for the card badge — "MLB", "World Cup", "NFL". */
  competition: string;
  status: EventStatus;
  statusLabel: string;
  homeParticipant: Participant;
  awayParticipant: Participant;
  venue?: string;
  startTime?: string;
  /** Secondary context line — pitchers, round, etc. */
  contextLine?: string;
  markets: MarketPresentationModel[];
  projection: ProjectionSummaryModel;
}

// ─── Double chance (soccer) — resolved through participant identity ──────────

export type DoubleChanceSelection = "HOME_OR_DRAW" | "AWAY_OR_DRAW" | "DRAW";

export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${String(x)}`);
}

/**
 * Full double-chance label from the event's participants — "Spain Win/Draw"
 * (owner directive 2026-07-18: "Win/Draw", not "Win or Draw").
 * HOME_OR_DRAW ALWAYS resolves to the home participant, AWAY_OR_DRAW to the away
 * participant, regardless of the order sides arrive in from a provider.
 */
export function formatDoubleChanceSelection(
  selection: DoubleChanceSelection,
  event: Pick<SportPresentationModel, "homeParticipant" | "awayParticipant">
): string {
  switch (selection) {
    case "HOME_OR_DRAW":
      return `${event.homeParticipant.displayName} Win/Draw`;
    case "AWAY_OR_DRAW":
      return `${event.awayParticipant.displayName} Win/Draw`;
    case "DRAW":
      return "Draw";
    default:
      return assertNever(selection);
  }
}

// ─── Structural input (mirrors DimeModelFeed's normalized FeedCardSpec) ──────
// Structurally typed so the adapters don't couple to the page's internal type
// and can be unit-tested in isolation.

export interface FeedCrestLike {
  url?: string | null;
  code: string;
  bg?: string | null;
}
export interface FeedTeamLike {
  name: string;
  crest: FeedCrestLike;
  score?: string | null;
}
export interface FeedRowLike {
  modelLineLabel?: string;
  comparable?: boolean;
  label: string;
  book: string;
  model: string;
  crest?: FeedCrestLike | null;
}
export interface FeedMarketLike {
  note?: string;
  title: string;
  rows: FeedRowLike[];
  foot: { label: string; edge: boolean };
}
export interface FeedEventLike {
  id: string;
  /** Explicit source status when available; prevents postponed games from
   *  falling through the score-based inference and appearing scheduled. */
  status?: EventStatus;
  liveLabel?: string | null;
  timeLabel: string;
  away: FeedTeamLike;
  home: FeedTeamLike;
  meta: string;
  pitchers?: { away: string; home: string } | null;
  venueLine?: string | null;
  markets: FeedMarketLike[];
}

export interface AdapterContext {
  /** Short competition label override (e.g. round-specific naming). */
  competition?: string;
}

export type SportAdapter = (
  raw: FeedEventLike,
  ctx?: AdapterContext
) => SportPresentationModel;

// ─── Shared building blocks ──────────────────────────────────────────────────

function parseScore(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function statusOf(raw: FeedEventLike): EventStatus {
  if (raw.status) return raw.status;
  if (raw.liveLabel) return "live";
  if (raw.away.score != null || raw.home.score != null) return "final";
  return "scheduled";
}

/**
 * Venue line — PREGAME-ONLY (owner directive 2026-08-05, superseding the
 * 2026-07-17 matchup-block anatomy). Once a game is live, final, postponed, or
 * suspended, the ballpark is stale scan noise: the header carries the lifecycle
 * status and the card compacts. Still dropped on scheduled cards when it merely
 * repeats the context line (each fact renders once).
 */
function venueOf(raw: FeedEventLike, status: EventStatus): string | undefined {
  if (status !== "scheduled") return undefined;
  const v = raw.venueLine ?? undefined;
  return v && v !== raw.meta ? v : undefined;
}

/** First pitch / kickoff in ET — PREGAME-ONLY (owner directive 2026-08-05).
 *  Every non-scheduled state carries its lifecycle status in the centered card
 *  header instead, and a scheduled card's time moved there too, so this line
 *  now exists only as the matchup block's optional companion to the ballpark.
 *  The pre-2026-08-05 rule leaked a first-pitch time onto LIVE cards. */
function startTimeOf(
  raw: FeedEventLike,
  status: EventStatus
): string | undefined {
  return status === "scheduled" ? raw.timeLabel || undefined : undefined;
}

/** Spelled-out market titles (owner directive 2026-07-18): no abbreviated
 *  headers above the market tables. Unlisted titles pass through verbatim. */
const MARKET_DISPLAY_LABELS: Record<string, string> = {
  ml: "Moneyline",
  "to adv": "To Advance",
  "dbl chc": "Double Chance",
  btts: "Both Teams to Score",
};
function marketDisplayLabel(title: string): string {
  return MARKET_DISPLAY_LABELS[title.trim().toLowerCase()] ?? title;
}

/** Footer line for a market (owner directive 2026-07-18: edges live in the
 *  footer). An edge foot arrives as "<row label> [suffix] · +x.x%" built from
 *  raw row labels; re-anchor it on the RELABELED selection so no code survives
 *  ("ESP ML · +3.1%" → "Spain ML · +3.1%"). */
function footOf(
  m: FeedMarketLike,
  selections: MarketSelectionModel[]
): { resultLabel?: string; resultIsEdge?: boolean } {
  const label = m.foot.label?.trim();
  if (!label) return {};
  if (!m.foot.edge) return { resultLabel: label, resultIsEdge: false };
  const idx = m.rows.findIndex(r => label.startsWith(r.label.trim()));
  const tail = /·\s*\+[\d.]+%\s*$/.exec(label)?.[0];
  if (idx >= 0 && tail && selections[idx]) {
    return {
      resultLabel: `${selections[idx].label} ${tail}`,
      resultIsEdge: true,
    };
  }
  return { resultLabel: label, resultIsEdge: true };
}

/** Pair each side with the opposite side's book price so no-vig math has both. */
function sidesFromMarket(m: MarketPresentationModel): MarketSideInput[] {
  const n = m.selections.length;
  return m.selections.map((sel, i) => ({
    marketKey: m.key,
    marketLabel: m.label,
    sideLabel: sel.label,
    bookPrice: sel.bookPrice,
    bookOppPrice: n === 2 ? m.selections[n - 1 - i].bookPrice : undefined,
    modelPrice: sel.modelPrice,
    comparable: sel.comparable,
  }));
}

function projectionOf(
  markets: MarketPresentationModel[]
): ProjectionSummaryModel {
  const sides = markets.flatMap(sidesFromMarket);
  return { primary: primaryInsight(sides), ranked: rankMarkets(sides) };
}

// ─── Team-sport adapter (MLB / NFL / NBA / NHL / NCAAF / NCAAM) ───────────────
// Team codes (NYY, LAL) are conventional and stay as-is; only the country rule
// (soccer) forbids raw abbreviations.

function teamParticipant(t: FeedTeamLike, role: EventRole): Participant {
  return {
    id: t.crest.code || role,
    role,
    kind: "team",
    displayName: t.name,
    shortName: t.crest.code || t.name,
    logo: t.crest.url ?? null,
    color: t.crest.bg ?? null,
    flag: null,
    iso2: null,
    score: parseScore(t.score),
  };
}

/** Best-effort role tag for a team-sport side (used by the no-vig pairing only). */
function teamRoleFor(idx: number, label: string): SelectionRole {
  const l = label.toUpperCase();
  if (/^O(\s|VER|$)/.test(l)) return "over";
  if (/^U(\s|NDER|$)/.test(l)) return "under";
  return idx === 0 ? "away" : "home";
}

/** Replace a leading team-code token ("NYY +1.5") with the participant's name
 *  ("Yankees +1.5"). Labels that don't lead with a known code pass through. */
function teamDeCode(
  label: string,
  away: Participant,
  home: Participant
): string {
  const first = label.trim().split(/\s+/)[0];
  if (first && first === away.id) return label.replace(first, away.displayName);
  if (first && first === home.id) return label.replace(first, home.displayName);
  return label;
}

/** Spelled-out side labels for team-sport market tables (owner directive
 *  2026-07-18, mirrors the soccer adapter): moneyline rows read "<Team> ML" —
 *  the market context travels with the pick into the summary readout and edge
 *  carousel ("Yankees ML", never a bare "Yankees") — run/puck-line and spread
 *  rows spell the team name and keep their line ("Yankees +1.5"), and total
 *  rows spell Over/Under ("Under 9"). Unrecognized labels pass through. */
function teamSideLabel(
  title: string,
  rawLabel: string,
  away: Participant,
  home: Participant
): string {
  const t = title.trim().toLowerCase();
  const label = rawLabel.trim();
  if (t === "ml" || t === "moneyline") {
    const named = teamDeCode(label, away, home);
    return /\bML$/i.test(named) ? named : `${named} ML`;
  }
  if (t === "total") {
    const head = label.split(/\s+/)[0]?.toUpperCase();
    const tail = numTail(label);
    if (head === "O" || head === "OVER") return tail ? `Over ${tail}` : "Over";
    if (head === "U" || head === "UNDER")
      return tail ? `Under ${tail}` : "Under";
    return label;
  }
  if (/^(run ?line|puck ?line|spread)$/.test(t))
    return teamDeCode(label, away, home);
  return rawLabel;
}

function teamMarkets(
  raw: FeedEventLike,
  away: Participant,
  home: Participant
): MarketPresentationModel[] {
  return raw.markets.map(m => {
    const key = m.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const selections: MarketSelectionModel[] = m.rows.map((row, i) => ({
      id: `${key}-${i}`,
      role: teamRoleFor(i, row.label),
      label: teamSideLabel(m.title, row.label, away, home),
      bookPrice: parseAmerican(row.book),
      modelPrice: parseAmerican(row.model),
      modelLineLabel: row.modelLineLabel,
      comparable: row.comparable,
    }));
    return {
      key,
      label: marketDisplayLabel(m.title),
      note: m.note,
      selections,
      ...footOf(m, selections),
    };
  });
}

function createTeamPresentation(
  sport: Sport,
  competition: string
): SportAdapter {
  return (raw, ctx) => {
    const awayParticipant = teamParticipant(raw.away, "away");
    const homeParticipant = teamParticipant(raw.home, "home");
    const markets = teamMarkets(raw, awayParticipant, homeParticipant);
    const status = statusOf(raw);
    return {
      eventId: raw.id,
      sport,
      competition: ctx?.competition ?? competition,
      status,
      statusLabel: raw.liveLabel || raw.timeLabel,
      awayParticipant,
      homeParticipant,
      venue: venueOf(raw, status),
      // On team-sport rows the context line IS the ballpark (the MLB feed sets
      // `meta = g.venue`), so the pregame-only venue rule has to gate it here
      // too — owner directive 2026-08-05. Soccer's context line is the ROUND,
      // not a venue, and keeps its own ungated rule in the adapter below.
      contextLine: status === "scheduled" ? raw.meta || undefined : undefined,
      startTime: startTimeOf(raw, status),
      markets,
      projection: projectionOf(markets),
    };
  };
}

export const createMlbPresentation = createTeamPresentation("MLB", "MLB");
export const createNflPresentation = createTeamPresentation("NFL", "NFL");
export const createNbaPresentation = createTeamPresentation("NBA", "NBA");
export const createNhlPresentation = createTeamPresentation("NHL", "NHL");
export const createNcaafPresentation = createTeamPresentation("NCAAF", "NCAAF");
export const createNcaamPresentation = createTeamPresentation("NCAAM", "NCAAM");

// ─── Soccer adapter — country identity + participant-resolved markets ─────────

function countryParticipant(t: FeedTeamLike, role: EventRole): Participant {
  const id = countryIdentity(t.crest.code, t.name);
  // displayName must be a real name: dictionary name → non-code DB name → "TBD".
  const name = id.name || (isRawCountryCode(t.name) ? "TBD" : t.name || "TBD");
  return {
    id: t.crest.code || role,
    role,
    kind: "country",
    displayName: name,
    shortName: name, // countries never show a raw code
    logo: null,
    color: t.crest.bg ?? null,
    flag: id.flag,
    iso2: id.iso2,
    score: parseScore(t.score),
  };
}

/** Replace a leading FIFA-code token with the matching participant's name so no
 *  raw country abbreviation can survive in any label we don't special-case. */
function deCode(label: string, away: Participant, home: Participant): string {
  const first = label.trim().split(/\s+/)[0];
  if (first && first === away.id) return label.replace(first, away.displayName);
  if (first && first === home.id) return label.replace(first, home.displayName);
  if (isRawCountryCode(label)) {
    if (label === away.id) return away.displayName;
    if (label === home.id) return home.displayName;
  }
  return label;
}

const numTail = (label: string): string => label.replace(/^\S+\s*/, "").trim();

function soccerMarket(
  m: FeedMarketLike,
  away: Participant,
  home: Participant,
  event: Pick<SportPresentationModel, "homeParticipant" | "awayParticipant">
): MarketPresentationModel {
  // Key from the full title (tag included, so tagged and untagged variants
  // stay distinct); trim edge hyphens left by trailing symbols like ")".
  const key = m.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // "(90 Min)" scope tag (owner directive 2026-07-18): when a card carries a
  // match-WINNER market, its 90-minute-scoped markets say so in their headers.
  // The tag is display-only — strip it before matching the market shape so
  // "Dbl Chc (90 Min)" still resolves the Double Chance labels, then re-append
  // it to the spelled-out display label ("Double Chance (90 Min)").
  const rawTitle = m.title.trim();
  const tag90 = /\s*\(90 min\)$/i.test(rawTitle);
  const baseTitle = tag90
    ? rawTitle.replace(/\s*\(90 min\)$/i, "").trim()
    : rawTitle;
  const displayLabel = tag90
    ? `${marketDisplayLabel(baseTitle)} (90 Min)`
    : marketDisplayLabel(baseTitle);
  const title = baseTitle.toLowerCase();
  const price = (row: FeedRowLike) => ({
    bookPrice: parseAmerican(row.book),
    modelPrice: parseAmerican(row.model),
  });
  const sel = (
    i: number,
    role: SelectionRole,
    label: string,
    participant?: Participant
  ): MarketSelectionModel => ({
    id: `${key}-${i}`,
    role,
    label,
    participantId: participant?.id,
    flag: participant?.flag ?? null,
    ...price(m.rows[i]),
  });

  let selections: MarketSelectionModel[];
  switch (title) {
    case "dbl chc":
      // Row 0 = HOME WD, row 1 = AWAY WD (feed contract) → resolve via identity.
      selections = [
        sel(
          0,
          "home_or_draw",
          formatDoubleChanceSelection("HOME_OR_DRAW", event),
          home
        ),
        sel(
          1,
          "away_or_draw",
          formatDoubleChanceSelection("AWAY_OR_DRAW", event),
          away
        ),
      ];
      break;
    case "draw":
      selections = [sel(0, "draw", "Draw"), sel(1, "neutral", "No Draw")];
      break;
    case "total":
      selections = [
        sel(0, "over", `Over ${numTail(m.rows[0].label) || ""}`.trim()),
        sel(1, "under", `Under ${numTail(m.rows[1].label) || ""}`.trim()),
      ];
      break;
    case "btts":
      // Rows read YES / NO; the spelled-out market title carries the meaning
      // ("Both Teams to Score", owner directive 2026-07-18).
      selections = [sel(0, "yes", "YES"), sel(1, "no", "NO")];
      break;
    case "ml":
      // Flag + "<Country> ML" per row (owner directive 2026-07-18).
      selections = m.rows.map((row, i) => {
        const participant = i === 0 ? away : home;
        return sel(
          i,
          i === 0 ? "away" : "home",
          `${participant.displayName} ML`,
          participant
        );
      });
      break;
    // Winner-scope markets (owner directive 2026-07-18): graded on whoever
    // wins the match when it settles — 90'+injury time, extra time, or pens.
    // The pick carries its market ("England 3rd Place", "Spain to Win WC"),
    // matching the "<Country> ML" convention, so the summary readout and edge
    // carousel always name the market the edge lives in.
    case "world cup 3rd place":
      selections = m.rows.map((row, i) => {
        const participant = i === 0 ? away : home;
        return sel(
          i,
          i === 0 ? "away" : "home",
          `${participant.displayName} 3rd Place`,
          participant
        );
      });
      break;
    case "to win the world cup":
      selections = m.rows.map((row, i) => {
        const participant = i === 0 ? away : home;
        return sel(
          i,
          i === 0 ? "away" : "home",
          `${participant.displayName} to Win WC`,
          participant
        );
      });
      break;
    case "to adv":
    case "spread":
    default:
      // away top / home bottom (feed contract); de-code any leading FIFA token.
      selections = m.rows.map((row, i) => {
        const participant =
          i === 0 ? away : i === m.rows.length - 1 ? home : undefined;
        return sel(
          i,
          i === 0 ? "away" : "home",
          deCode(row.label, away, home),
          participant
        );
      });
      break;
  }
  return { key, label: displayLabel, selections, ...footOf(m, selections) };
}

export const createSoccerPresentation: SportAdapter = (raw, ctx) => {
  const awayParticipant = countryParticipant(raw.away, "away");
  const homeParticipant = countryParticipant(raw.home, "home");
  const evt = { homeParticipant, awayParticipant };
  const markets = raw.markets.map(m =>
    soccerMarket(m, awayParticipant, homeParticipant, evt)
  );
  const status = statusOf(raw);
  return {
    eventId: raw.id,
    sport: "SOCCER",
    competition: ctx?.competition ?? "World Cup",
    status,
    statusLabel: raw.liveLabel || raw.timeLabel,
    awayParticipant,
    homeParticipant,
    venue: venueOf(raw, status),
    // Stage identity, not a venue (wcMatchToCard splits them: meta = round
    // label, venueLine = stadium · city). "World Cup Final" is the only thing
    // naming the match on a settled card, so it survives every lifecycle state
    // — the pregame-only rule takes the stadium and the kickoff time, not this.
    contextLine: raw.meta || undefined,
    startTime: startTimeOf(raw, status),
    markets,
    projection: projectionOf(markets),
  };
};

// ─── The registry ────────────────────────────────────────────────────────────

export const sportAdapters: Record<Sport, SportAdapter> = {
  MLB: createMlbPresentation,
  NFL: createNflPresentation,
  NBA: createNbaPresentation,
  NHL: createNhlPresentation,
  NCAAF: createNcaafPresentation,
  NCAAM: createNcaamPresentation,
  SOCCER: createSoccerPresentation,
};

/** Adapt any supported event by sport key. */
export function toPresentation(
  sport: Sport,
  raw: FeedEventLike,
  ctx?: AdapterContext
): SportPresentationModel {
  return sportAdapters[sport](raw, ctx);
}
