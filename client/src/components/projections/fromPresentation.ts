import type {
  SportPresentationModel,
  Participant,
  MarketPresentationModel,
} from "@/lib/sport/presentation";
import type {
  ProjectionGame,
  ProjectionMarket,
  ProjectionMarketSide,
  ProjectionTeam,
  GameStatus,
} from "./types";

/**
 * View binding: SportPresentationModel → ProjectionGame.
 *
 * The sport-aware model (lib/sport) is the single normalization layer; this maps
 * it to the card's view-model without changing any label, price, or edge. A
 * country participant carries its flag + real name through to TeamLogoMark; a
 * team participant carries its logo/monogram color.
 */

function participantToTeam(p: Participant): ProjectionTeam {
  return {
    abbr: p.shortName,
    name: p.displayName,
    logo: p.logo ?? null,
    color: p.color ?? null,
    score: p.score ?? null,
    kind: p.kind,
    flag: p.flag ?? null,
  };
}

function marketToProjection(m: MarketPresentationModel): ProjectionMarket {
  const n = m.selections.length;
  const sides: ProjectionMarketSide[] = m.selections.map((sel, i) => ({
    marketKey: m.key,
    marketLabel: m.label,
    sideLabel: sel.label,
    bookPrice: sel.bookPrice,
    bookOppPrice: n === 2 ? m.selections[n - 1 - i].bookPrice : undefined,
    modelPrice: sel.modelPrice,
    flag: sel.flag ?? null,
  }));
  return {
    key: m.key,
    label: m.label,
    note: m.note,
    sides,
    resultLabel: m.resultLabel,
    resultIsEdge: m.resultIsEdge,
  };
}

export function presentationToProjectionGame(
  model: SportPresentationModel
): ProjectionGame {
  const status: GameStatus = model.status; // scheduled | live | final all valid
  return {
    id: model.eventId,
    league: model.competition,
    status,
    statusLabel: model.statusLabel,
    away: participantToTeam(model.awayParticipant),
    home: participantToTeam(model.homeParticipant),
    matchupContext: model.contextLine,
    venue: model.venue,
    startTime: model.startTime,
    markets: model.markets.map(marketToProjection),
  };
}
