/**
 * GameCard — Model Projection Card
 *
 * 3-tier responsive layout:
 *
 * Desktop + Tablet (≥ md / 768px): single horizontal row
 *   ┌──────────────────┬──────────────────────────────┬──────────────────┐
 *   │  SCORE PANEL     │  ODDS/LINES (3 SectionCols)  │  EDGE VERDICT    │
 *   │  Clock/Status    │  SPREAD | TOTAL | ML         │                  │
 *   │  Away logo+name  │  BOOK | MODEL per col        │                  │
 *   │  Home logo+name  │  Splits bars below           │                  │
 *   └──────────────────┴──────────────────────────────┴──────────────────┘
 *   ScorePanel: clamp(170px,22vw,260px) — scales 170px@768 → 260px@1182+
 *   EdgeVerdict: clamp(120px,11.5vw,190px) — floor 120px for tablet readability
 *
 * Mobile (< md / 768px): frozen-panel grid + horizontal scroll
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │  SCORE PANEL (frozen, clamp(140px,38%,180px)) │ ODDS scroll area  │
 *   └─────────────────────────────────────────────────────────────────────┘
 */

import React, { useState, useRef, useEffect, useCallback, memo } from "react";
// LazyMotion + m keeps the card compatible with the Dime shell's strict
// LazyMotion boundary (a full `motion` component inside it throws in dev and
// defeats motion tree-shaking). The local provider covers standalone routes.
// MotionConfig honors the OS reduced-motion setting for the entrance fade.
import { LazyMotion, MotionConfig, domAnimation, m } from "framer-motion";

// Splits-surface interaction styles ride this chunk (NOT the chat critical
// path — see the bundle budget note in splits-interactions.css).
import "@/styles/splits-interactions.css";

import { toast } from "sonner";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/lib/trpc";
import { getNbaTeamByDbSlug } from "@shared/nbaTeams";
import { NHL_BY_DB_SLUG, NHL_BY_ABBREV } from "@shared/nhlTeams";
import { ncaafHelmet } from "@shared/ncaafHelmets";
import { MLB_BY_ABBREV } from "@shared/mlbTeams";
import { getGameTeamColorsClient } from "@shared/teamColors";
import { useVisibility } from "@/hooks/useVisibility";
import { useIsDesktop } from "@/hooks/useIsDesktop";
import { useIsMdUp } from "@/hooks/useIsMdUp";
import {
  americanToImplied,
  calculateEdge,
  calculateRoi,
  formatRoi,
  getEdgeColor,
  getVerdict,
  EDGE_THRESHOLD_PP,
} from "@/lib/edgeUtils";
import { formatGameTime, toNum, spreadSign } from "@/lib/gameUtils";
import { trpc } from "@/lib/trpc";
import { useAppAuth } from "@/_core/hooks/useAppAuth";
import { BettingSplitsPanel } from "./BettingSplitsPanel";
import { OddsHistoryPanel } from "./OddsHistoryPanel";
import MlbLast5Panel from "./MlbLast5Panel";
import RecentSchedulePanel from "./RecentSchedulePanel";
import SituationalResultsPanel from "./SituationalResultsPanel";
import { MobileGameCard } from "./MobileGameCard";

type RouterOutput = inferRouterOutputs<AppRouter>;
type GameRow = RouterOutput["games"]["list"][number];

// ── Time formatting (alias — shared impl in @/lib/gameUtils) ──────────────────────────────────────────────────────────────────
const formatMilitaryTime = (time: string, _sport?: string): string =>
  formatGameTime(time);

// ── Date formatting (local — uses weekday, different from shared formatDateHeader) ──────────────────────────────────────────────────────────────────
function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

// ── Edge / spread / number helpers — imported from @/lib/edgeUtils and @/lib/gameUtils ──────────────────────────────────────────────────────────────────
// americanToImplied, calculateEdge, getVerdict, getEdgeColor → @/lib/edgeUtils
// spreadSign, toNum → @/lib/gameUtils

// ── Parse ROI% from edge label ───────────────────────────────────────────────
// Label format: "HIGH | TCU +2.5 | 56.12% | +3.74% vs BE | 7.13% ROI"
function parseRoiFromLabel(label: string | null | undefined): number | null {
  if (!label) return null;
  const m = label.match(/([\d.]+)%\s*ROI/);
  return m ? parseFloat(m[1]) : null;
}

// Parse the betting side from the label (e.g. "TCU +2.5" or "OVER 145.5")
function parseSideFromLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const parts = label.split("|");
  if (parts.length < 2) return null;
  return parts[1].trim();
}

// ── Normalize edge label ──────────────────────────────────────────────────────
// Strips bracket classification tags like [ELITE EDGE], [STRONG EDGE], [SMALL EDGE], etc.
// Also resolves NBA db slugs (e.g. "los_angeles_lakers") to display names.
// NHL labels: "UTA +1.5 [ELITE EDGE]" → "UTA +1.5"
// NBA labels: "los_angeles_lakers (+2.5)" → "Los Angeles Lakers (+2.5)"
function normalizeEdgeLabel(label: string | null | undefined): string {
  if (!label || label.toUpperCase() === "PASS") return "PASS";
  // Strip bracket classification tags: [ELITE EDGE], [STRONG EDGE], [PLAYABLE EDGE], [SMALL EDGE], [LEAN], etc.
  let normalized = label.replace(/\s*\[[^\]]*\]/g, "").trim();
  // Resolve NBA db slugs (e.g. "los_angeles_lakers (+2.5)")
  normalized = normalized.replace(
    /^([a-z][a-z0-9_]*)(\s+\()/i,
    (_, slug, rest) => {
      const nba = getNbaTeamByDbSlug(slug);
      if (nba) return nba.name + rest;
      return slug.replace(/_/g, " ") + rest;
    }
  );
  return normalized;
}

// ── Parse team abbreviation from edge label ───────────────────────────────────
// NHL edge labels: "UTA +1.5 [ELITE EDGE]" → "UTA"
// NBA edge labels: "los_angeles_lakers (+2.5)" → null (uses slug matching)
// Returns the 2-3 char uppercase abbreviation if present, otherwise null.
function parseAbbrFromEdgeLabel(
  label: string | null | undefined
): string | null {
  if (!label || label.toUpperCase() === "PASS") return null;
  // Match 2-4 uppercase letters at the start of the label (e.g. "UTA", "STL", "NSH")
  const m = label.match(/^([A-Z]{2,4})\s/);
  return m ? m[1] : null;
}

// ── Determine if edge label refers to the away team ───────────────────────────
// AUTHORITATIVE for NHL: parse abbrev from label, compare to awayAbbr.
// Fallback for NBA/MLB: use normalizeEdgeLabel().startsWith(awayDisplayName).
// This replaces the flawed "+1.5" string check which fails for home favorites.
function edgeLabelIsAway(
  label: string | null | undefined,
  awayAbbr: string,
  awayDisplayName: string | undefined,
  sport: string
): boolean {
  if (!label || label.toUpperCase() === "PASS") return false;
  if (sport === "NHL" || sport === "MLB") {
    const abbr = parseAbbrFromEdgeLabel(label);
    if (abbr) {
      if (process.env.NODE_ENV === "development") {
        console.log(
          `%c[edgeLabelIsAway] sport=${sport} label="${label}" abbr=${abbr} awayAbbr=${awayAbbr} → ${abbr === awayAbbr}`,
          "color:#FFFFFF;font-size:9px"
        );
      }
      return abbr === awayAbbr;
    }
  }
  // NBA fallback: display name match
  const normalized = normalizeEdgeLabel(label);
  return awayDisplayName
    ? normalized.toLowerCase().startsWith(awayDisplayName.toLowerCase())
    : false;
}

// ── TeamLogo ──────────────────────────────────────────────────────────────────
function TeamLogo({
  slug,
  name,
  logoUrl,
  size = 36,
  greyscale = false,
}: {
  slug: string;
  name: string;
  logoUrl?: string;
  size?: number;
  greyscale?: boolean;
}) {
  const [error, setError] = useState(false);
  // Enforce minimum 32px — logos must never be smaller than a fingertip target
  // size prop acts as the "base" for the clamp midpoint (in vw units)
  const minPx = Math.max(32, Math.round(size * 0.75));
  const maxPx = Math.max(48, Math.round(size * 1.5));
  const vwRatio = (size / 14).toFixed(2); // slightly larger vw ratio for better scaling
  const cssSize = `clamp(${minPx}px, ${vwRatio}vw, ${maxPx}px)`;
  if (!logoUrl || error) {
    return (
      <div
        className="rounded-full flex items-center justify-center font-bold flex-shrink-0"
        style={{
          width: cssSize,
          height: cssSize,
          minWidth: minPx,
          minHeight: minPx,
          background: "hsl(var(--muted))",
          color: "hsl(var(--muted-foreground))",
          fontSize: `clamp(${Math.max(10, Math.round(size * 0.22))}px, ${(size * 0.018).toFixed(2)}vw, ${Math.max(12, Math.round(size * 0.34))}px)`,
        }}
      >
        {name.slice(0, 2).toUpperCase()}
      </div>
    );
  }
  return (
    <img
      src={logoUrl}
      alt={name}
      style={{
        width: cssSize,
        height: cssSize,
        minWidth: minPx,
        minHeight: minPx,
        objectFit: "contain",
        mixBlendMode: "screen",
        flexShrink: 0,
        // Enhanced visibility: brightness lifts dark logos (A's, Pirates, White Sox)
        // contrast sharpens definition, saturate keeps colors vivid
        // drop-shadow adds a subtle white glow so logos pop on dark backgrounds
        // Increased brightness for dark-primary logos (A's dark green, Padres brown, White Sox, Pirates)
        // brightness(1.7): lifts dark logos significantly without blowing out bright logos (WSH red, ATL red)
        // contrast(1.12): sharpens edges for crisp definition
        // saturate(1.35): keeps colors vivid on dark backgrounds
        // drop-shadow: white glow halo so logos pop against #0f0f0f card background
        // Change G: greyscale losing team logo on FINAL desktop only
        filter: greyscale
          ? "grayscale(1) brightness(0.75) contrast(1.05)"
          : "brightness(1.7) contrast(1.12) saturate(1.35)",
      }}
      onError={() => setError(true)}
    />
  );
}

// ── MobileTeamNameBlock ─────────────────────────────────────────────────────
/**
 * Renders the school name + nickname stacked vertically inside the frozen
 * left panel (used on both mobile and desktop).
 *
 * Font sizes are UNIFORM across all teams — based on viewport width only.
 * No truncation — full name always visible. Container expands to fit content.
 *
 * School name: clamp(13px, 1.1vw, 18px) — 13px mobile, ~15.8px at 1440px, 18px max
 * Nickname:    clamp(11px, 0.9vw, 15px) — always smaller than school name
 */
function MobileTeamNameBlock({
  schoolName,
  nickname,
  isWinner,
  isFinalGame,
}: {
  schoolName: string;
  nickname?: string;
  isWinner: boolean;
  isFinalGame: boolean;
}) {
  const displayName = schoolName;

  // Uniform fluid font sizes — same for every team, scale with viewport width
  const NAME_FONT = "clamp(13px, 1.1vw, 18px)";
  const NICK_FONT = "clamp(11px, 0.9vw, 15px)";

  return (
    <div className="flex flex-col" style={{ lineHeight: 1.25 }}>
      <span
        style={{
          fontSize: NAME_FONT,
          fontWeight: 700,
          color: "var(--dime-text-primary, #FFFFFF)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          whiteSpace: "nowrap",
        }}
      >
        {displayName}
      </span>
      {nickname && (
        <span
          style={{
            fontSize: NICK_FONT,
            fontWeight: 600,
            color: "var(--dime-text-primary, #FFFFFF)",
            letterSpacing: "0.02em",
            textTransform: "none",
            whiteSpace: "nowrap",
          }}
        >
          {nickname}
        </span>
      )}
    </div>
  );
}

// ── VerdictSide ───────────────────────────────────────────────────────────────
function VerdictSide({
  diff,
  label,
  isStrong,
  logoUrl,
  teamSlug,
  teamName,
  compact = false,
}: {
  diff: number | null;
  label: string | null;
  isStrong: boolean;
  logoUrl?: string;
  teamSlug?: string;
  teamName?: string;
  compact?: boolean;
}) {
  const normalized = normalizeEdgeLabel(label);
  const isPass = normalized === "PASS" || (diff ?? 0) <= 0;
  const color = getEdgeColor(diff ?? 0);
  // Parse ROI% and side label from the full edge string
  const roi = parseRoiFromLabel(label);
  const sideLabel = parseSideFromLabel(label);

  if (isPass) {
    return (
      <div className="flex flex-col items-center gap-0.5 py-0.5">
        <span
          className="text-[11px] font-medium tracking-wide"
          style={{ color: "hsl(var(--muted-foreground) / 0.80)" }}
        >
          PASS
        </span>
      </div>
    );
  }

  if (compact) {
    // Compact inline version: side label + ROI% on one line
    const showArrow = (diff ?? 0) >= 3;
    const displayLabel = sideLabel ?? normalized;
    return (
      <div className="flex items-center gap-1 px-1.5 py-0.5">
        {(logoUrl || teamSlug) && (
          <TeamLogo
            slug={teamSlug ?? ""}
            name={teamName ?? ""}
            logoUrl={logoUrl}
            size={16}
          />
        )}
        <span
          className="font-bold leading-none whitespace-nowrap uppercase tracking-wide text-[11px]"
          style={{ color: "hsl(var(--foreground))" }}
        >
          {showArrow && (
            <span className="mr-0.5 text-[10px]" style={{ color }}>
              ▲
            </span>
          )}
          {displayLabel}
        </span>
        {roi !== null ? (
          <span
            className="text-[10px] leading-none font-extrabold"
            style={{ color }}
          >
            {roi.toFixed(2)}% ROI
          </span>
        ) : (
          <span
            className="text-[10px] leading-none"
            style={{ color: "hsl(var(--muted-foreground))", fontWeight: 500 }}
          >
            <span style={{ color, fontWeight: 800 }}>
              {diff}
              {diff === 1 ? "PT" : "PTS"}
            </span>
          </span>
        )}
      </div>
    );
  }

  const betNameSize = isStrong ? "17px" : "15px";
  const showArrow = (diff ?? 0) >= 3;
  const displayLabel = sideLabel ?? normalized;

  return (
    <div className="flex flex-col items-center gap-1 py-0.5">
      <div className="flex items-center gap-1.5">
        {(logoUrl || teamSlug) && (
          <TeamLogo
            slug={teamSlug ?? ""}
            name={teamName ?? ""}
            logoUrl={logoUrl}
            size={22}
          />
        )}
        <span
          className="font-bold leading-none whitespace-nowrap uppercase tracking-wide"
          style={{ fontSize: betNameSize, color: "hsl(var(--foreground))" }}
        >
          {showArrow && (
            <span className="mr-0.5 text-[10px]" style={{ color }}>
              ▲
            </span>
          )}
          {displayLabel}
        </span>
      </div>
      {roi !== null ? (
        <span
          className="text-[13px] leading-none font-extrabold"
          style={{ color }}
        >
          {roi.toFixed(2)}% ROI
        </span>
      ) : (
        <span
          className="text-[13px] leading-none"
          style={{ color: "hsl(var(--muted-foreground))", fontWeight: 500 }}
        >
          EDGE:{" "}
          <span style={{ color, fontWeight: 800 }}>
            {diff} {diff === 1 ? "PT" : "PTS"}
          </span>
        </span>
      )}
    </div>
  );
}

// ── EdgeVerdict ───────────────────────────────────────────────────────────────
function EdgeVerdict({
  spreadDiff,
  spreadEdge,
  totalDiff,
  totalEdge,
  awayLogoUrl,
  homeLogoUrl,
  awaySlug,
  homeSlug,
  awayDisplayName,
  homeDisplayName,
  compact = false,
  authSpreadEdgeIsAway,
}: {
  spreadDiff: number | null;
  spreadEdge: string | null;
  totalDiff: number | null;
  totalEdge: string | null;
  awayLogoUrl?: string;
  homeLogoUrl?: string;
  awaySlug?: string;
  homeSlug?: string;
  awayDisplayName?: string;
  homeDisplayName?: string;
  compact?: boolean;
  /** AUTHORITATIVE edge direction — computed at GameCard level with correct sport. When provided, skips local heuristic. */
  authSpreadEdgeIsAway?: boolean | null;
}) {
  const spreadPass =
    normalizeEdgeLabel(spreadEdge) === "PASS" || (spreadDiff ?? 0) <= 0;
  const totalPass =
    normalizeEdgeLabel(totalEdge) === "PASS" || (totalDiff ?? 0) <= 0;

  if (spreadPass && totalPass) {
    return (
      <div
        className="mt-2 pt-2 flex items-center justify-center"
        style={{ borderTop: "1px solid hsl(var(--border))" }}
      >
        <span
          className="text-xs font-medium tracking-widest uppercase"
          style={{ color: "hsl(var(--muted-foreground) / 0.80)" }}
        >
          PASS
        </span>
      </div>
    );
  }

  const spreadIsStronger = (spreadDiff ?? 0) >= (totalDiff ?? 0);

  // AUTHORITATIVE: use authSpreadEdgeIsAway when provided (computed at GameCard level with correct sport).
  // Fallback: resolve awayAbbr from all sport registries and use edgeLabelIsAway.
  // The heuristic _verdictSport detection was flawed for MLB (slugs like 'arizona_diamondbacks'
  // never match /^[A-Z]{2,3}$/, so MLB was always treated as NBA).
  const spreadEdgeIsAway: boolean = (() => {
    // Prefer authoritative value when available
    if (authSpreadEdgeIsAway !== undefined && authSpreadEdgeIsAway !== null)
      return authSpreadEdgeIsAway;
    if (!spreadEdge) return false;
    // Fallback: resolve awayAbbr from all sport registries
    const awayAbbrForVerdict = (() => {
      const nhl = NHL_BY_DB_SLUG.get(awaySlug ?? "");
      if (nhl?.abbrev) return nhl.abbrev;
      const nba = awaySlug ? getNbaTeamByDbSlug(awaySlug) : null;
      if (nba?.abbrev) return nba.abbrev;
      const mlb = awaySlug ? MLB_BY_ABBREV.get(awaySlug) : null;
      if (mlb?.abbrev) return mlb.abbrev;
      return awaySlug
        ? awaySlug
            .split("_")
            .map(w => w[0]?.toUpperCase() || "")
            .join("")
        : "";
    })();
    // Determine sport: NHL → MLB (check MLB registry) → NBA fallback
    const _verdictSport = (() => {
      if (awaySlug && NHL_BY_DB_SLUG.has(awaySlug)) return "NHL";
      if (awaySlug) {
        // Check MLB registry by slug (stored as full name e.g. 'arizona_diamondbacks')
        const mlbBySlug = Array.from(MLB_BY_ABBREV.values()).find(
          t => t.dbSlug === awaySlug
        );
        if (mlbBySlug) return "MLB";
      }
      return "NBA";
    })();
    return edgeLabelIsAway(
      spreadEdge,
      awayAbbrForVerdict,
      awayDisplayName,
      _verdictSport
    );
  })();
  const spreadLogoUrl = spreadEdgeIsAway ? awayLogoUrl : homeLogoUrl;
  const spreadSlug = spreadEdgeIsAway ? awaySlug : homeSlug;
  const spreadTeamName = spreadEdgeIsAway ? awayDisplayName : homeDisplayName;

  if (compact) {
    // Compact horizontal layout: spread edge | divider | total edge, all on one row
    return (
      <div className="flex items-center justify-center gap-0 w-full py-0 my-0">
        {!spreadPass && (
          <VerdictSide
            diff={spreadDiff}
            label={spreadEdge}
            isStrong={spreadIsStronger && !spreadPass}
            logoUrl={spreadLogoUrl}
            teamSlug={spreadSlug}
            teamName={spreadTeamName}
            compact
          />
        )}
        {!spreadPass && !totalPass && (
          <div
            style={{
              width: 1,
              height: 24,
              background: "hsl(var(--border) / 0.5)",
              flexShrink: 0,
            }}
          />
        )}
        {!totalPass && (
          <VerdictSide
            diff={totalDiff}
            label={totalEdge}
            isStrong={!spreadIsStronger && !totalPass}
            compact
          />
        )}
      </div>
    );
  }

  return (
    <div
      className="mt-2 pt-2 flex flex-col gap-2"
      style={{ borderTop: "1px solid hsl(var(--border))" }}
    >
      {!spreadPass && (
        <div className="flex items-center justify-center">
          <VerdictSide
            diff={spreadDiff}
            label={spreadEdge}
            isStrong={spreadIsStronger && !spreadPass}
            logoUrl={spreadLogoUrl}
            teamSlug={spreadSlug}
            teamName={spreadTeamName}
          />
        </div>
      )}
      {!totalPass && (
        <div className="flex items-center justify-center">
          <VerdictSide
            diff={totalDiff}
            label={totalEdge}
            isStrong={!spreadIsStronger && !totalPass}
          />
        </div>
      )}
    </div>
  );
}

// ── fmtOddsSign ─────────────────────────────────────────────────────────────
// Ensures positive American odds always display with a leading '+' sign.
// Negative odds are returned as-is (already have '-').
// Handles both string (e.g. "214", "+214", "-214") and number inputs.
// Returns '—' for null/undefined/NaN inputs.
// [FIX] Bug: model PL odds (e.g. 214) and model over odds (e.g. 115) were
// stored as positive integers in DB but rendered without '+' prefix.
// MUST be defined BEFORE DesktopMergedPanel and OddsLinesPanel (both use it).
const fmtOddsSign = (raw: string | number | null | undefined): string => {
  if (raw == null || raw === "" || raw === "—") return "—";
  const s = String(raw).trim();
  // Already has sign prefix — return as-is
  if (s.startsWith("+") || s.startsWith("-")) return s;
  const n = Number(s);
  if (isNaN(n)) return s; // non-numeric string — return unchanged
  if (n === 100) return "EV";
  if (n > 0) return `+${n}`;
  return s; // negative already handled by startsWith('-') above
};

// ── DesktopMergedPanel ───────────────────────────────────────────────────────
// Desktop-only (≥ lg) unified panel: merges ODDS + SPLITS into a single table.
// Layout per section (SPREAD | TOTAL | MONEYLINE):
//   Section header
//   BOOK row (away / home)
//   Tickets split bar
//   Handle split bar
//   MODEL row (away / home, neon green for edge)
// Plus EdgeVerdict column on the far right.
// Mobile/tablet: this component is NEVER rendered (hidden lg:flex wraps it).

// ── Inline split bar for DesktopMergedPanel ───────────────────────────────────
const MERGED_LABEL_STROKE =
  "-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000,0 0 6px #000000";

function MergedSplitBar({
  awayPct,
  homePct,
  awayColor,
  homeColor,
  rowLabel,
  awayLabel,
  homeLabel,
}: {
  awayPct: number | null;
  homePct: number | null;
  awayColor: string;
  homeColor: string;
  rowLabel: string;
  awayLabel?: string;
  homeLabel?: string;
}) {
  const hasData = awayPct != null && homePct != null;
  const headerLabelStyle: React.CSSProperties = {
    fontSize: "clamp(10px, 0.85vw, 13px)",
    color: "#FFFFFF",
    fontWeight: 800,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  };
  const teamLabelStyle: React.CSSProperties = {
    fontSize: "clamp(9px, 0.78vw, 12px)",
    color: "#FFFFFF",
    fontWeight: 600,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "38%",
  };
  return (
    <div className="flex flex-col w-full" style={{ gap: 2 }}>
      {/* Row label line: away label | TICKETS/MONEY | home label */}
      <div className="flex items-center justify-between" style={{ gap: 4 }}>
        <span style={teamLabelStyle}>{awayLabel ?? ""}</span>
        <span style={headerLabelStyle}>{rowLabel}</span>
        <span style={{ ...teamLabelStyle, textAlign: "right" }}>
          {homeLabel ?? ""}
        </span>
      </div>
      {/* Bar */}
      {hasData ? (
        (() => {
          const away = awayPct!;
          const home = homePct!;
          const isAwayFull = away >= 100;
          const isHomeFull = home >= 100;
          // letterSpacing: was 0.2em, decreased by 0.2 → 0em (no uniform spacing)
          // The 0.1 gap before % is handled by inserting a thin-space (U+2009) before % in the rendered text
          const segLabel: React.CSSProperties = {
            fontSize: "clamp(10px, 0.85vw, 13px)",
            color: "#FFFFFF",
            fontWeight: 800,
            whiteSpace: "nowrap",
            textShadow: MERGED_LABEL_STROKE,
            lineHeight: 1,
            letterSpacing: "0em",
          };
          return (
            <div
              style={{
                height: "clamp(22px, 2.2vw, 32px)",
                display: "flex",
                borderRadius: "9999px",
                border: "1px solid #FFFFFF",
                overflow: "hidden",
                width: "100%",
              }}
            >
              {/* Away segment — label flush LEFT (only when NOT full-bar) */}
              {away > 0 && !isAwayFull && !isHomeFull && (
                <div
                  style={{
                    flexGrow: away,
                    flexShrink: 1,
                    flexBasis: 0,
                    minWidth: away < 10 ? 36 : 30,
                    background: awayColor,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-start",
                    paddingLeft: "clamp(4px,0.4vw,8px)",
                    paddingRight: "clamp(4px,0.4vw,8px)",
                    borderRadius: "9999px 0 0 9999px",
                  }}
                  className="transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
                >
                  <span style={{ ...segLabel, textAlign: "left" }}>
                    {away} %
                  </span>
                </div>
              )}
              {/* Divider */}
              {!isAwayFull && !isHomeFull && away > 0 && home > 0 && (
                <div
                  style={{ width: 1, background: "#FFFFFF", flexShrink: 0 }}
                />
              )}
              {/* Home segment — label flush RIGHT (only when NOT full-bar) */}
              {home > 0 && !isHomeFull && !isAwayFull && (
                <div
                  style={{
                    flexGrow: home,
                    flexShrink: 1,
                    flexBasis: 0,
                    minWidth: home < 10 ? 36 : 30,
                    background: homeColor,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-end",
                    paddingLeft: "clamp(4px,0.4vw,8px)",
                    paddingRight: "clamp(4px,0.4vw,8px)",
                    borderRadius: "0 9999px 9999px 0",
                  }}
                  className="transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
                >
                  <span style={{ ...segLabel, textAlign: "right" }}>
                    {home} %
                  </span>
                </div>
              )}
              {/* 100% full-bar cases — EXCLUSIVE: only one can render */}
              {isAwayFull && !isHomeFull && (
                <div
                  style={{
                    flex: 1,
                    background: awayColor,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "9999px",
                  }}
                >
                  <span style={{ ...segLabel, textAlign: "center" }}>100%</span>
                </div>
              )}
              {isHomeFull && !isAwayFull && (
                <div
                  style={{
                    flex: 1,
                    background: homeColor,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "9999px",
                  }}
                >
                  <span style={{ ...segLabel, textAlign: "center" }}>100%</span>
                </div>
              )}
              {/* Both-full fallback: split 50/50 with both labels (data anomaly guard) */}
              {isAwayFull && isHomeFull && (
                <>
                  <div
                    style={{
                      flex: 1,
                      background: awayColor,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: "9999px 0 0 9999px",
                    }}
                  >
                    <span style={{ ...segLabel, textAlign: "center" }}>
                      100%
                    </span>
                  </div>
                  <div
                    style={{
                      flex: 1,
                      background: homeColor,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: "0 9999px 9999px 0",
                    }}
                  >
                    <span style={{ ...segLabel, textAlign: "center" }}>
                      100%
                    </span>
                  </div>
                </>
              )}
            </div>
          );
        })()
      ) : (
        <div
          style={{
            height: "clamp(22px,2.2vw,32px)",
            background: "#000000",
            borderRadius: "9999px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: "hsl(var(--muted-foreground))",
              opacity: 0.8,
            }}
          >
            —
          </span>
        </div>
      )}
    </div>
  );
}

interface DesktopMergedPanelProps {
  // Book values
  awayBookSpread: number;
  homeBookSpread: number;
  bookTotal: number;
  awayML: string;
  homeML: string;
  // Model values
  awayModelSpread: number;
  homeModelSpread: number;
  modelTotal: number;
  modelAwayML: string | null | undefined;
  modelHomeML: string | null | undefined;
  // Edge
  spreadDiff: number;
  totalDiff: number;
  computedSpreadEdge: string | null;
  computedTotalEdge: string | null;
  // Team identity
  awayLogoUrl?: string;
  homeLogoUrl?: string;
  awaySlug?: string;
  homeSlug?: string;
  awayDisplayName?: string;
  homeDisplayName?: string;
  // Model toggle
  showModel: boolean;
  onToggleModel: () => void;
  // AUTHORITATIVE edge direction — computed once at GameCard level, passed down
  authSpreadEdgeIsAway: boolean | null;
  authTotalEdgeIsOver: boolean | null;
  // Splits data
  game: {
    sport: string | null;
    awayTeam: string;
    homeTeam: string;
    awayBookSpread?: string | null;
    homeBookSpread?: string | null;
    bookTotal?: string | null;
    spreadAwayBetsPct: number | null | undefined;
    spreadAwayMoneyPct: number | null | undefined;
    totalOverBetsPct: number | null | undefined;
    totalOverMoneyPct: number | null | undefined;
    mlAwayBetsPct: number | null | undefined;
    mlAwayMoneyPct: number | null | undefined;
    awayML: string | null | undefined;
    homeML: string | null | undefined;
    awaySpreadOdds?: string | null;
    homeSpreadOdds?: string | null;
    overOdds?: string | null;
    underOdds?: string | null;
    // Open line fields (from AN HTML ingest)
    openAwaySpread?: string | null;
    openHomeSpread?: string | null;
    openAwaySpreadOdds?: string | null;
    openHomeSpreadOdds?: string | null;
    openTotal?: string | null;
    openOverOdds?: string | null;
    openUnderOdds?: string | null;
    openAwayML?: string | null;
    openHomeML?: string | null;
    // Note: DK NJ current lines are in awayBookSpread/homeBookSpread/bookTotal/awayML/homeML
    // (populated by ingestAnHtml from AN HTML best-odds table).
    // MLB run line (VSiN) — used as primary RL label source (more authoritative than awayBookSpread/DK)
    awayRunLine?: string | null;
    homeRunLine?: string | null;
    // NHL model puck line and total odds (from nhl_model_engine.py)
    modelAwayPLOdds?: string | null;
    modelHomePLOdds?: string | null;
    modelOverOdds?: string | null;
    modelUnderOdds?: string | null;
    // Model fair odds at derived model spread/total line
    modelAwaySpreadOdds?: string | null;
    modelHomeSpreadOdds?: string | null;
    // Model validity guard: null means model was invalidated or not yet run
    // Stored as Unix timestamp (ms) in DB, hence number | null
    modelRunAt?: number | null;
  };
}
function DesktopMergedPanel({
  awayBookSpread: awaySpread,
  homeBookSpread: homeSpread,
  bookTotal: bkTotal,
  awayML: awayMl,
  homeML: homeMl,
  awayModelSpread: mdlAwaySpread,
  homeModelSpread: mdlHomeSpread,
  modelTotal: mdlTotal,
  modelAwayML,
  modelHomeML,
  spreadDiff,
  totalDiff,
  computedSpreadEdge,
  computedTotalEdge,
  awayLogoUrl,
  homeLogoUrl,
  awaySlug,
  homeSlug,
  awayDisplayName,
  homeDisplayName,
  showModel,
  onToggleModel,
  authSpreadEdgeIsAway,
  authTotalEdgeIsOver,
  game,
}: DesktopMergedPanelProps) {
  // ── Team colors for split bars (Fix #5: client-side registry, zero round-trips) ──
  const sport = (game.sport ?? "NBA") as "MLB" | "NBA" | "NHL";
  const colors = getGameTeamColorsClient(game.awayTeam, game.homeTeam, sport);

  const FALLBACK_AWAY = "#1a4a8a";
  const FALLBACK_HOME = "#c84b0c";

  const isUnusable = (hex: string | null | undefined): boolean => {
    if (!hex) return false;
    const clean = hex.replace(/^#/, "");
    if (clean.length !== 6 && clean.length !== 3) return false;
    const full =
      clean.length === 3
        ? clean
            .split("")
            .map(c => c + c)
            .join("")
        : clean;
    const r = parseInt(full.slice(0, 2), 16) / 255;
    const g = parseInt(full.slice(2, 4), 16) / 255;
    const b = parseInt(full.slice(4, 6), 16) / 255;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return lum < 0.04 || lum > 0.9;
  };

  const tooSimilar = (hexA: string, hexB: string): boolean => {
    const toRgb = (h: string) => {
      const c = h.replace(/^#/, "");
      const f =
        c.length === 3
          ? c
              .split("")
              .map(x => x + x)
              .join("")
          : c;
      return [
        parseInt(f.slice(0, 2), 16),
        parseInt(f.slice(2, 4), 16),
        parseInt(f.slice(4, 6), 16),
      ];
    };
    try {
      const [r1, g1, b1] = toRgb(hexA);
      const [r2, g2, b2] = toRgb(hexB);
      return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2) < 60;
    } catch {
      return false;
    }
  };

  const pickColor = (
    p: string | null | undefined,
    s: string | null | undefined,
    t: string | null | undefined,
    fb: string
  ): string => {
    for (const c of [p, s, t]) {
      if (c && !isUnusable(c)) return c;
    }
    return fb;
  };

  const homeColor = pickColor(
    colors?.home?.primaryColor,
    colors?.home?.secondaryColor,
    colors?.home?.tertiaryColor,
    FALLBACK_HOME
  );
  const awayColor = (() => {
    for (const c of [
      colors?.away?.primaryColor,
      colors?.away?.secondaryColor,
      colors?.away?.tertiaryColor,
      FALLBACK_AWAY,
    ]) {
      if (!c) continue;
      if (isUnusable(c)) continue;
      if (!tooSimilar(c, homeColor)) return c;
    }
    return FALLBACK_AWAY;
  })();

  const awayAbbr = colors?.away?.abbrev ?? awayDisplayName ?? "";
  const homeAbbr = colors?.home?.abbrev ?? homeDisplayName ?? "";

  // ── Book / Model value strings ──────────────────────────────────────────────────────────────────────
  // game.modelRunAt=null means model was invalidated (e.g. ML direction flip) or not yet run.
  // Gate hasModelData behind it so stale model values never render during the re-run window.
  const hasModelData =
    game.modelRunAt != null &&
    (!isNaN(mdlAwaySpread) ||
      !isNaN(mdlTotal) ||
      (modelAwayML != null && modelAwayML !== "—"));

  // Spread odds in parentheses, e.g. "+1.5 (-225)" / "-1.5 (+185)"
  // Only append odds when they exist; omit if null (standard -110 assumed)
  const awaySpreadOddsStr = game.awaySpreadOdds ?? null;
  const homeSpreadOddsStr = game.homeSpreadOdds ?? null;
  const overOddsStr = game.overOdds ?? null;
  const underOddsStr = game.underOdds ?? null;

  const bkAwaySpread = !isNaN(awaySpread)
    ? awaySpreadOddsStr
      ? `${spreadSign(awaySpread)} (${awaySpreadOddsStr})`
      : spreadSign(awaySpread)
    : "—";
  const bkHomeSpread = !isNaN(homeSpread)
    ? homeSpreadOddsStr
      ? `${spreadSign(homeSpread)} (${homeSpreadOddsStr})`
      : spreadSign(homeSpread)
    : "—";
  const bkOver = !isNaN(bkTotal)
    ? overOddsStr
      ? `${String(bkTotal)} (${overOddsStr})`
      : String(bkTotal)
    : "—";
  const bkUnder = !isNaN(bkTotal)
    ? underOddsStr
      ? `${String(bkTotal)} (${underOddsStr})`
      : String(bkTotal)
    : "—";

  // ── Open line strings (from AN HTML ingest) ───────────────────────────────
  // fmtLine: format open line string; normalizeSpread adds '+' to positive spread values
  const normalizeSpread = (s: string | null | undefined): string | null => {
    if (!s) return null;
    const n = parseFloat(s);
    if (!isNaN(n) && n > 0 && !s.startsWith("+")) return `+${s}`;
    return s;
  };
  const fmtLine = (
    line: string | null | undefined,
    odds: string | null | undefined
  ): string | null => {
    if (!line) return null;
    return odds ? `${line} (${odds})` : line;
  };
  const openAwaySpreadStr = fmtLine(
    normalizeSpread(game.openAwaySpread),
    game.openAwaySpreadOdds
  );
  const openHomeSpreadStr = fmtLine(
    normalizeSpread(game.openHomeSpread),
    game.openHomeSpreadOdds
  );
  const openOverStr = fmtLine(game.openTotal, game.openOverOdds);
  const openUnderStr = fmtLine(game.openTotal, game.openUnderOdds);
  const openAwayMlStr = game.openAwayML ?? null;
  const openHomeMlStr = game.openHomeML ?? null;

  // DK NJ lines ARE the primary book columns (awayBookSpread IS the DK line)
  const displayAwaySpread = bkAwaySpread;
  const displayHomeSpread = bkHomeSpread;
  const displayOver = bkOver;
  const displayUnder = bkUnder;
  const displayAwayML = game.awayML ?? "—";
  const displayHomeML = game.homeML ?? "—";

  // For NHL/MLB games, append model odds in parentheses

  const isNhlGame = game.sport === "NHL";
  const isMlbGame = game.sport === "MLB";
  const mdlAwayPLOdds = game.modelAwayPLOdds ?? null;
  const mdlHomePLOdds = game.modelHomePLOdds ?? null;
  const mdlOverOdds = game.modelOverOdds ?? null;
  const mdlUnderOdds = game.modelUnderOdds ?? null;
  // MLB model fair odds at book's spread line (computed by Python engine)
  const mdlAwaySpreadOdds = game.modelAwaySpreadOdds ?? null;
  const mdlHomeSpreadOdds = game.modelHomeSpreadOdds ?? null;
  // ── MLB RULE: model RL LABEL always mirrors the book's run line. ─────────────────────────────
  // NEVER use awayModelSpread/homeModelSpread as the label for MLB — it can have wrong sign.
  // Priority: awayRunLine (VSiN run line) → awayBookSpread (DK NJ spread) → null.
  // [INPUT]  game.awayRunLine = "+1.5" (VSiN) or null
  // [INPUT]  awaySpread = 1.5 (DK NJ) or NaN
  // [OUTPUT] mlbMdlAwayLabel = "+1.5" (correct book label) or null
  const mlbMdlAwayLabel = isMlbGame
    ? game.awayRunLine != null && game.awayRunLine !== ""
      ? game.awayRunLine // VSiN run line (most authoritative)
      : !isNaN(awaySpread)
        ? spreadSign(awaySpread) // DK NJ spread fallback
        : null // no label available
    : null;
  const mlbMdlHomeLabel = isMlbGame
    ? game.homeRunLine != null && game.homeRunLine !== ""
      ? game.homeRunLine
      : !isNaN(homeSpread)
        ? spreadSign(homeSpread)
        : null
    : null;
  if (process.env.NODE_ENV === "development" && isMlbGame) {
    console.log(
      `[DesktopPanel:MLB_RL_LABEL] game=${game.awayTeam}@${game.homeTeam}` +
        ` | awayRunLine=${game.awayRunLine ?? "null"} awayBookSpread=${awaySpread}` +
        ` | mlbMdlAwayLabel=${mlbMdlAwayLabel ?? "null"} mlbMdlHomeLabel=${mlbMdlHomeLabel ?? "null"}`
    );
  }
  // [FIX] fmtOddsSign applied to all model juice values in DesktopMergedPanel.
  // This is the DESKTOP-SPECIFIC string construction path — separate from OddsLinesPanel.
  // mdlAwayPLOdds/mdlHomePLOdds/mdlOverOdds/mdlUnderOdds come from game.model* (raw DB integers).
  // Without fmtOddsSign, positive values like 214 and 115 render without '+' prefix.
  const mdlAwaySpreadStr = hasModelData
    ? isNhlGame && mdlAwayPLOdds
      ? `${spreadSign(mdlAwaySpread)} (${fmtOddsSign(mdlAwayPLOdds)})`
      : isMlbGame
        ? mlbMdlAwayLabel
          ? mdlAwaySpreadOdds
            ? `${mlbMdlAwayLabel} (${fmtOddsSign(mdlAwaySpreadOdds)})`
            : mlbMdlAwayLabel
          : "—"
        : !isNaN(mdlAwaySpread)
          ? spreadSign(mdlAwaySpread)
          : "—"
    : "—";
  const mdlHomeSpreadStr = hasModelData
    ? isNhlGame && mdlHomePLOdds
      ? `${spreadSign(mdlHomeSpread)} (${fmtOddsSign(mdlHomePLOdds)})`
      : isMlbGame
        ? mlbMdlHomeLabel
          ? mdlHomeSpreadOdds
            ? `${mlbMdlHomeLabel} (${fmtOddsSign(mdlHomeSpreadOdds)})`
            : mlbMdlHomeLabel
          : "—"
        : !isNaN(mdlHomeSpread)
          ? spreadSign(mdlHomeSpread)
          : "—"
    : "—";
  // CRITICAL: ALWAYS display the BOOK's total line with model fair odds at that line.
  // The book O/U is the NON-NEGOTIABLE reference for edge detection and display across ALL sports.
  // modelTotal in DB is now anchored to bookTotal (fixed in mlbModelRunner/nhlModelSync)
  // but we enforce it here as a defense-in-depth guard: if bkTotal is available, use it.
  const mdlDisplayTotal = !isNaN(bkTotal) ? bkTotal : mdlTotal;
  // Validation audit: warn in console if model total diverges from book total (should never happen)
  if (
    process.env.NODE_ENV !== "production" &&
    !isNaN(mdlTotal) &&
    !isNaN(bkTotal) &&
    Math.abs(mdlTotal - bkTotal) > 0.01
  ) {
    console.warn(
      `[LINE AUDIT] ${game.awayTeam}@${game.homeTeam} (${game.sport}): ` +
        `modelTotal=${mdlTotal} ≠ bookTotal=${bkTotal} — displaying bookTotal per policy`
    );
  }
  // [FIX] fmtOddsSign applied to model over/under odds in DesktopMergedPanel.
  // mdlOverOdds/mdlUnderOdds are raw DB strings (e.g. "115", "-115").
  // Without fmtOddsSign, positive values like 115 render without '+' prefix.
  const mdlOver =
    hasModelData && !isNaN(mdlDisplayTotal)
      ? (isNhlGame || isMlbGame) && mdlOverOdds
        ? `${String(mdlDisplayTotal)} (${fmtOddsSign(mdlOverOdds)})`
        : String(mdlDisplayTotal)
      : "—";
  const mdlUnder =
    hasModelData && !isNaN(mdlDisplayTotal)
      ? (isNhlGame || isMlbGame) && mdlUnderOdds
        ? `${String(mdlDisplayTotal)} (${fmtOddsSign(mdlUnderOdds)})`
        : String(mdlDisplayTotal)
      : "—";
  const mdlAwayMlStr = hasModelData ? (modelAwayML ?? "—") : "—";
  const mdlHomeMlStr = hasModelData ? (modelHomeML ?? "—") : "—";

  // ── Edge detection ────────────────────────────────────────────────────────
  // For NHL: puck line is always ±1.5 or ±2.5 from the simulation.
  // Comparing mdlAwaySpread < awaySpread is meaningless (both are ±1.5).
  // Edge direction is determined by the Python engine and stored in computedSpreadEdge.
  // AUTHORITATIVE: use props from outer GameCard (computed with 3-tier priority).
  // authSpreadEdgeIsAway: Tier 1 = model spread odds prob, Tier 2 = NHL label, Tier 3 = line arithmetic
  // authTotalEdgeIsOver:  Tier 1 = model over/under odds prob, Tier 2 = NHL label, Tier 3 = line comparison
  // Do NOT recompute locally — these are the single source of truth.
  const spreadEdgeIsAway: boolean | null = authSpreadEdgeIsAway;
  const totalEdgeIsOver: boolean | null = authTotalEdgeIsOver;
  // [FIX] For NHL/MLB: spreadDiff and totalDiff are null in DB.
  // hasSpreadEdge/hasTotalEdge must derive from authSpreadEdgeIsAway/authTotalEdgeIsOver
  // (which are computed from model odds and DB labels) rather than the null diff values.
  const hasSpreadEdge = spreadEdgeIsAway !== null;
  const hasTotalEdge = totalEdgeIsOver !== null;

  // ── Style helpers ────────────────────────────────────────────────────────────────────────────────────
  // Typography hierarchy (desktop):
  //   BOOK/MODEL column headers: HDR_FS (the largest)
  //   Value rows: VAL_FS = HDR_FS - 4pt
  //   Abbreviation/OVER/UNDER prefix labels: ABBR_FS = VAL_FS - 1pt
  //   Section title (SPREAD/TOTAL/MONEYLINE): TITLE_FS
  //
  // Using clamp: HDR_FS = clamp(14px,1.15vw,18px), VAL_FS = clamp(10px,0.85vw,14px), ABBR_FS = clamp(9px,0.78vw,13px)
  const HDR_FS = "clamp(15px,1.25vw,20px)"; // BOOK / MODEL column header labels — raised for readability
  const VAL_FS = "clamp(12px,1.0vw,16px)"; // Value rows (spread, total, ML numbers) — raised for readability
  const ABBR_FS = "clamp(11px,0.9vw,14px)"; // Abbreviation / OVER / UNDER prefix — raised for readability
  // TITLE_FS must be 2pt larger than HDR_FS at every breakpoint:
  // At min (mobile): HDR_FS=15px → TITLE_FS=17px
  // At mid (1366px): HDR_FS≈17px → TITLE_FS≈19px
  // At max (1920px): HDR_FS=20px → TITLE_FS=22px
  const TITLE_FS = "clamp(17px,1.45vw,22px)"; // Section title (SPREAD / TOTAL / MONEYLINE) — 2pt above HDR_FS
  // Colors:
  //   Book values: #D3D3D3 (light gray), weight 500
  //   Model non-edge values: #FFFFFF (white), weight 600
  //   Model edge values: mint accent token, weight 700
  const bookCell: React.CSSProperties = {
    fontSize: VAL_FS,
    fontWeight: 500,
    color: "#FFFFFF",
    letterSpacing: "0.02em",
  } as React.CSSProperties;
  const modelGreen: React.CSSProperties = {
    fontSize: VAL_FS,
    fontWeight: 700,
    color: "var(--dime-mint-text, #45E0A8)", // 2026-08-05 token law: mint text is theme-correct
    letterSpacing: "0.02em",
  };
  const modelWhite: React.CSSProperties = {
    fontSize: VAL_FS,
    fontWeight: 600,
    color: "#FFFFFF",
    letterSpacing: "0.02em",
  };
  const dimCell: React.CSSProperties = {
    fontSize: VAL_FS,
    fontWeight: 500,
    color: "#FFFFFF",
    letterSpacing: "0.02em",
  };
  // Bug fix: !null === true in JS, so !spreadEdgeIsAway and !totalEdgeIsOver are true when direction is null.
  // This caused false green highlights on home spread and under total when direction is undetermined.
  // Require direction to be explicitly false (not just non-true) before applying green.
  const awaySpreadModelStyle = showModel
    ? hasSpreadEdge && spreadEdgeIsAway === true
      ? modelGreen
      : modelWhite
    : dimCell;
  const homeSpreadModelStyle = showModel
    ? hasSpreadEdge && spreadEdgeIsAway === false
      ? modelGreen
      : modelWhite
    : dimCell;
  const overTotalModelStyle = showModel
    ? hasTotalEdge && totalEdgeIsOver === true
      ? modelGreen
      : modelWhite
    : dimCell;
  const underTotalModelStyle = showModel
    ? hasTotalEdge && totalEdgeIsOver === false
      ? modelGreen
      : modelWhite
    : dimCell;

  // ── ML edge detection ──────────────────────────────────────────────────────
  // ML edge direction must match spread edge direction (same team that covers the spread
  // is also the team to back on the ML).
  // Compute ML edge pp independently from book/model ML odds.
  const bkAwayMlNum = toNum(awayMl);
  const bkHomeMlNum = toNum(homeMl);
  const mdlAwayMlNum = toNum(modelAwayML);
  const mdlHomeMlNum = toNum(modelHomeML);
  const awayMlEdgePP = calculateEdge(bkAwayMlNum, mdlAwayMlNum);
  const homeMlEdgePP = calculateEdge(bkHomeMlNum, mdlHomeMlNum);
  // ML edge: independent of spread edge direction.
  // Show ML edge for whichever team has the larger positive pp.
  // This handles cases where spread edge and ML edge are on different teams
  // (e.g. PHI covers +1.5 but BOS wins outright -- both can be true simultaneously).
  const EDGE_THRESHOLD_ML = 0.5;
  // [FIX 2026-06-24] Gate ML edge detection on hasModelData.
  // modelAwayML/modelHomeML hold stale values when modelRunAt=null (RL INVALIDATE).
  // Without this gate, awayMlPositive/homeMlPositive can be true even when
  // hasModelData=false, causing ML column to render '—' in the mint edge accent.
  const awayMlPositive =
    hasModelData && !isNaN(awayMlEdgePP) && awayMlEdgePP > EDGE_THRESHOLD_ML;
  const homeMlPositive =
    hasModelData && !isNaN(homeMlEdgePP) && homeMlEdgePP > EDGE_THRESHOLD_ML;
  // Pick the side with the larger positive edge; if tied, prefer the spread-edge side
  const mlEdgeIsAway: boolean | null = (() => {
    if (awayMlPositive && homeMlPositive) {
      return awayMlEdgePP >= homeMlEdgePP ? true : false;
    }
    if (awayMlPositive) return true;
    if (homeMlPositive) return false;
    return null;
  })();
  const mlEdgePP =
    mlEdgeIsAway === true
      ? awayMlEdgePP
      : mlEdgeIsAway === false
        ? homeMlEdgePP
        : NaN;
  const hasMlEdge = !isNaN(mlEdgePP) && mlEdgePP > EDGE_THRESHOLD_ML;
  // ML edge display label: "TEAM ABBR ML" (e.g. "UTA ML" or "STL ML")
  const mlEdgeLabel =
    mlEdgeIsAway === true
      ? `${awayAbbr} ML`
      : mlEdgeIsAway === false
        ? `${homeAbbr} ML`
        : null;
  const mlEdgeLogoUrl = mlEdgeIsAway === true ? awayLogoUrl : homeLogoUrl;
  const mlEdgeSlug = mlEdgeIsAway === true ? awaySlug : homeSlug;
  const mlEdgeTeam = mlEdgeIsAway === true ? awayDisplayName : homeDisplayName;
  if (
    process.env.NODE_ENV === "development" &&
    (!isNaN(awayMlEdgePP) || !isNaN(homeMlEdgePP))
  ) {
    console.log(
      `%c[ML EDGE] ${game.awayTeam}@${game.homeTeam} spreadEdgeIsAway=${spreadEdgeIsAway} ` +
        `awayMlEdgePP=${isNaN(awayMlEdgePP) ? "NaN" : awayMlEdgePP.toFixed(2)} ` +
        `homeMlEdgePP=${isNaN(homeMlEdgePP) ? "NaN" : homeMlEdgePP.toFixed(2)} ` +
        `mlEdgePP=${isNaN(mlEdgePP) ? "NaN" : mlEdgePP.toFixed(2)} hasMlEdge=${hasMlEdge}`,
      "color:#FFFFFF;font-size:9px"
    );
  }
  const awayMlModelStyle = showModel
    ? hasMlEdge && mlEdgeIsAway === true
      ? modelGreen
      : modelWhite
    : dimCell;
  const homeMlModelStyle = showModel
    ? hasMlEdge && mlEdgeIsAway === false
      ? modelGreen
      : modelWhite
    : dimCell;

  // ── ROI % computations for EDGE column display ────────────────────────────
  // ROI = (modelWinProb / bookNoVigProb - 1) * 100
  // For each market, compute ROI from model fair odds vs book odds (no-vig adjusted).
  // Falls back to NaN if any required odds are missing.
  const bkAwaySpreadOddsNum = toNum(awaySpreadOddsStr);
  const bkHomeSpreadOddsNum = toNum(homeSpreadOddsStr);
  const bkOverOddsNum = toNum(overOddsStr);
  const bkUnderOddsNum = toNum(underOddsStr);
  // Spread/Run Line/Puck Line ROI — use the model's fair odds at the book's spread line
  const mdlAwaySpreadOddsNum = toNum(
    isNhlGame ? mdlAwayPLOdds : isMlbGame ? mdlAwaySpreadOdds : null
  );
  const mdlHomeSpreadOddsNum = toNum(
    isNhlGame ? mdlHomePLOdds : isMlbGame ? mdlHomeSpreadOdds : null
  );
  const spreadRoiAway = calculateRoi(
    mdlAwaySpreadOddsNum,
    bkAwaySpreadOddsNum,
    bkHomeSpreadOddsNum
  );
  const spreadRoiHome = calculateRoi(
    mdlHomeSpreadOddsNum,
    bkHomeSpreadOddsNum,
    bkAwaySpreadOddsNum
  );
  const spreadRoi =
    spreadEdgeIsAway === true
      ? spreadRoiAway
      : spreadEdgeIsAway === false
        ? spreadRoiHome
        : NaN;
  // Total ROI — use model over/under odds vs book over/under odds
  const mdlOverOddsNum = toNum(mdlOverOdds);
  const mdlUnderOddsNum = toNum(mdlUnderOdds);
  const totalRoiOver = calculateRoi(
    mdlOverOddsNum,
    bkOverOddsNum,
    bkUnderOddsNum
  );
  const totalRoiUnder = calculateRoi(
    mdlUnderOddsNum,
    bkUnderOddsNum,
    bkOverOddsNum
  );
  const totalRoi =
    totalEdgeIsOver === true
      ? totalRoiOver
      : totalEdgeIsOver === false
        ? totalRoiUnder
        : NaN;
  // ML ROI — use mlEdgeIsAway (independent of spread edge direction)
  const mlRoi =
    mlEdgeIsAway === true
      ? calculateRoi(mdlAwayMlNum, bkAwayMlNum, bkHomeMlNum)
      : mlEdgeIsAway === false
        ? calculateRoi(mdlHomeMlNum, bkHomeMlNum, bkAwayMlNum)
        : NaN;

  // ── Splits data ───────────────────────────────────────────────────────────
  const awaySpreadLabel = !isNaN(awaySpread)
    ? `${awayAbbr} (${spreadSign(awaySpread)})`
    : awayAbbr;
  const homeSpreadLabel = !isNaN(homeSpread)
    ? `${homeAbbr} (${spreadSign(homeSpread)})`
    : homeAbbr;
  const awayMlLabel = game.awayML ? `${awayAbbr} (${game.awayML})` : awayAbbr;
  const homeMlLabel = game.homeML ? `${homeAbbr} (${game.homeML})` : homeAbbr;

  // Treat 0%/0% as null — VSIN returns 0/0 when the spread/run-line market hasn't opened yet.
  // Prevents the misleading 100% home bar on the desktop SectionCol MergedSplitBar.
  // Symmetric with BettingSplitsPanel guards on both mobile (CompactMarketRow) and desktop (MarketBlock).
  const _rawSpreadBets = game.spreadAwayBetsPct ?? null;
  const _rawSpreadMoney = game.spreadAwayMoneyPct ?? null;
  const _spreadBothZero = _rawSpreadBets === 0 && _rawSpreadMoney === 0;
  const spreadTicketsPct = _spreadBothZero ? null : _rawSpreadBets;
  const spreadHandlePct = _spreadBothZero ? null : _rawSpreadMoney;
  const totalTicketsPct = game.totalOverBetsPct ?? null;
  const totalHandlePct = game.totalOverMoneyPct ?? null;
  const mlTicketsPct = game.mlAwayBetsPct ?? null;
  const mlHandlePct = game.mlAwayMoneyPct ?? null;

  // ── Section column renderer ───────────────────────────────────────────────
  // Layout per section (exact spec):
  //   ┌─────────────────────────────────────────┐
  //   │            SECTION TITLE                │
  //   │  AWAY LABEL              HOME LABEL     │  (or OVER / total / UNDER)
  //   │  ─────────────────────────────────────  │
  //   │  BOOK LINE   MODEL LINE  BOOK LINE  MODEL LINE  │  ← header row
  //   │  away book   away model  home book  home model  │  ← values row (single row)
  //   │  ─────────────────────────────────────  │
  //   │  AWAY LABEL   TICKETS   HOME LABEL      │
  //   │  [████████████████████████████████████] │
  //   │  AWAY LABEL    MONEY    HOME LABEL      │
  //   │  [████████████████████████████████████] │
  //   └─────────────────────────────────────────┘
  const SectionCol = ({
    title,
    awayLabel,
    homeLabel,
    awayBook,
    homeBook,
    awayModel,
    homeModel,
    awayModelStyle,
    homeModelStyle,
    ticketsPct,
    handlePct,
    totalLine,
    awayLogoUrl: sectionAwayLogoUrl,
    homeLogoUrl: sectionHomeLogoUrl,
    awayAbbr: sectionAwayAbbr,
    homeAbbr: sectionHomeAbbr,
    openAwayBook,
    openHomeBook,
  }: {
    title: string;
    awayLabel: string;
    homeLabel: string;
    awayBook: string;
    homeBook: string;
    awayModel: string;
    homeModel: string;
    awayModelStyle: React.CSSProperties;
    homeModelStyle: React.CSSProperties;
    ticketsPct: number | null;
    handlePct: number | null;
    totalLine?: string;
    /** Team logo URL for the away row (shown left of values in SPREAD/ML, NOT for TOTAL) */
    awayLogoUrl?: string;
    /** Team logo URL for the home row (shown left of values in SPREAD/ML, NOT for TOTAL) */
    homeLogoUrl?: string;
    /** Team abbreviation for the away row (shown right of logo in SPREAD/ML) */
    awayAbbr?: string;
    /** Team abbreviation for the home row (shown right of logo in SPREAD/ML) */
    homeAbbr?: string;
    /** Open line string for away (shown above DK line in BOOK cell, muted) */
    openAwayBook?: string | null;
    /** Open line string for home (shown above DK line in BOOK cell, muted) */
    openHomeBook?: string | null;
  }) => {
    const awayTickets = ticketsPct != null ? ticketsPct : null;
    const homeTickets = ticketsPct != null ? 100 - ticketsPct : null;
    const awayHandle = handlePct != null ? handlePct : null;
    const homeHandle = handlePct != null ? 100 - handlePct : null;

    // For OVER/UNDER split bars: use OVER/UNDER as team labels
    const barAwayLabel = totalLine ? "OVER" : awayLabel;
    const barHomeLabel = totalLine ? "UNDER" : homeLabel;

    // Column header style — HDR_FS (largest in hierarchy, 4pt above value rows)
    const colHdrStyle = (color: string): React.CSSProperties => ({
      fontSize: HDR_FS,
      fontWeight: 700,
      letterSpacing: "0.12em",
      textTransform: "uppercase" as const,
      color,
      whiteSpace: "nowrap" as const,
    });

    // Row label style — ABBR_FS (1pt below value rows)
    // Used for team abbreviations (SPREAD/ML) and OVER/UNDER labels (TOTAL)
    const _rowLabelStyle: React.CSSProperties = {
      fontSize: ABBR_FS,
      fontWeight: 700,
      color: "#FFFFFF",
      letterSpacing: "0.06em",
      textTransform: "uppercase" as const,
      whiteSpace: "nowrap" as const,
      marginRight: 2,
    };

    // Value font size — VAL_FS (4pt below HDR_FS)
    const valFontSize = VAL_FS;

    return (
      /* flex: 1 1 0% ensures all three SectionCols grow equally from 0 base — identical width regardless of content */
      <div
        className="flex flex-col"
        style={{
          flex: "1 1 0%",
          minWidth: 0,
          width: 0,
          padding: "8px 10px 10px",
        }}
      >
        {/* ── Section title ── */}
        <div className="flex items-center gap-1.5" style={{ marginBottom: 4 }}>
          <div style={{ flex: 1, height: 1, background: "#FFFFFF" }} />
          <span
            style={{
              fontSize: TITLE_FS,
              fontWeight: 850,
              color: "#FFFFFF",
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </span>
          <div style={{ flex: 1, height: 1, background: "#FFFFFF" }} />
        </div>

        {/* ── Uniform spacer row — reduced height to move BOOK/MODEL up ── */}
        <div style={{ height: "clamp(6px,0.5vw,9px)", marginBottom: 2 }} />

        {/* ── Odds grid: 2 columns — BOOK | MODEL ── */}
        {/*
          SPREAD/ML: logo immediately left of value in BOTH BOOK and MODEL cells.
          TOTAL:     "OVER"/"UNDER" text only — no o{}/u{} prefix, no logos.
        */}
        {/*
          OddsCell pill grid — 2 columns (BOOK | MODEL), 2 rows (away/over | home/under).
          BOOK pills: rounded border, bold main value, smaller juice below, optional open line above.
          MODEL pills: transparent bg, neon green when edge, white otherwise.
          isEdge is detected by comparing awayModelStyle / homeModelStyle to the modelGreen object.
          LOG: [OddsCell] logs are emitted in dev whenever isBest or isEdge is true.
        */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "3px 8px",
            marginBottom: 5,
            alignItems: "start",
          }}
        >
          {/* BOOK / MODEL column header row */}
          <span className="text-center" style={colHdrStyle("#FFFFFF")}>
            BOOK
          </span>
          <span
            className="text-center"
            style={colHdrStyle("var(--dime-mint-text, #45E0A8)")}
          >
            MODEL
          </span>

          {/* Away / OVER — BOOK pill */}
          <OddsCell
            mainValue={totalLine ? `o${awayBook}` : awayBook}
            juiceStr={null}
            isBook={true}
            openLine={null}
            size="md"
            wrapperStyle={{ justifySelf: "center", width: "100%" }}
          />

          {/* Away / OVER — MODEL pill */}
          <OddsCell
            mainValue={totalLine ? `o${awayModel}` : awayModel}
            juiceStr={null}
            isBook={false}
            isEdge={awayModelStyle === modelGreen}
            size="md"
            wrapperStyle={{ justifySelf: "center", width: "100%" }}
          />

          {/* Home / UNDER — BOOK pill */}
          <OddsCell
            mainValue={totalLine ? `u${homeBook}` : homeBook}
            juiceStr={null}
            isBook={true}
            openLine={null}
            size="md"
            wrapperStyle={{ justifySelf: "center", width: "100%" }}
          />

          {/* Home / UNDER — MODEL pill */}
          <OddsCell
            mainValue={totalLine ? `u${homeModel}` : homeModel}
            juiceStr={null}
            isBook={false}
            isEdge={homeModelStyle === modelGreen}
            size="md"
            wrapperStyle={{ justifySelf: "center", width: "100%" }}
          />
        </div>

        {/* ── Thin separator ── */}
        <div style={{ height: 1, background: "#FFFFFF", marginBottom: 7 }} />

        {/* ── TICKETS split bar ── */}
        <div style={{ marginTop: 4 }}>
          <MergedSplitBar
            awayPct={awayTickets}
            homePct={homeTickets}
            awayColor={awayColor}
            homeColor={homeColor}
            rowLabel="TICKETS"
            awayLabel={barAwayLabel}
            homeLabel={barHomeLabel}
          />
        </div>

        {/* ── MONEY split bar ── */}
        <div style={{ marginTop: 4 }}>
          <MergedSplitBar
            awayPct={awayHandle}
            homePct={homeHandle}
            awayColor={awayColor}
            homeColor={homeColor}
            rowLabel="HANDLE" // 2026-08-05: one word per concept — splits page + history tables say HANDLE
            awayLabel={barAwayLabel}
            homeLabel={barHomeLabel}
          />
        </div>
      </div>
    );
  };

  // ── EdgeVerdict column ────────────────────────────────────────────────────
  // AUTHORITATIVE pass detection: use computed edge direction values, NOT stale DB labels.
  // [FIX] For NHL/MLB: spreadDiff and totalDiff are null in DB.
  // spreadPass/totalPass must rely solely on authSpreadEdgeIsAway/authTotalEdgeIsOver.
  // The old formula (spreadEdgeIsAway === null || spreadDiff <= 0) was always true for NHL/MLB
  // because spreadDiff=null → (null ?? 0) = 0 → 0 <= 0 = true → always PASS.
  const spreadPass = spreadEdgeIsAway === null;
  const totalPass = totalEdgeIsOver === null;
  // spreadIsStronger: for NHL/MLB use model odds ROI comparison; for NBA use diff values
  const spreadIsStronger = (spreadDiff ?? 0) >= (totalDiff ?? 0);
  // Use authSpreadEdgeIsAway (the single authoritative source) for the edge panel logo.
  // Do NOT re-parse computedSpreadEdge (DB label) here — it can be stale/malformed and
  // would produce a different result than the authoritative value, showing the wrong team logo.
  const spreadEdgeIsAwayForVerdict = authSpreadEdgeIsAway === true;
  const spreadLogoUrl = spreadEdgeIsAwayForVerdict ? awayLogoUrl : homeLogoUrl;
  const spreadVerdictSlug = spreadEdgeIsAwayForVerdict ? awaySlug : homeSlug;
  const spreadVerdictTeam = spreadEdgeIsAwayForVerdict
    ? awayDisplayName
    : homeDisplayName;

  return (
    <div className="flex items-stretch w-full" style={{ minHeight: "100%" }}>
      {/* SPREAD section — sport-specific title: Run Line (MLB), Puck Line (NHL), Spread (others) */}
      <SectionCol
        title={
          sport === "MLB"
            ? "Run Line"
            : sport === "NHL"
              ? "Puck Line"
              : "Spread"
        }
        awayLabel={awaySpreadLabel}
        homeLabel={homeSpreadLabel}
        awayBook={displayAwaySpread}
        homeBook={displayHomeSpread}
        awayModel={mdlAwaySpreadStr}
        homeModel={mdlHomeSpreadStr}
        awayModelStyle={awaySpreadModelStyle}
        homeModelStyle={homeSpreadModelStyle}
        ticketsPct={spreadTicketsPct}
        handlePct={spreadHandlePct}
        awayLogoUrl={awayLogoUrl}
        homeLogoUrl={homeLogoUrl}
        awayAbbr={awayAbbr}
        homeAbbr={homeAbbr}
        openAwayBook={openAwaySpreadStr}
        openHomeBook={openHomeSpreadStr}
      />
      {/* Divider */}
      <div
        style={{
          width: 1,
          background: "#FFFFFF",
          flexShrink: 0,
          alignSelf: "stretch",
          margin: "8px 0",
        }}
      />
      {/* TOTAL section — no logos, OVER/UNDER baked into value cells */}
      <SectionCol
        title="Total"
        awayLabel="OVER"
        homeLabel="UNDER"
        awayBook={displayOver}
        homeBook={displayUnder}
        awayModel={String(mdlOver)}
        homeModel={String(mdlUnder)}
        awayModelStyle={overTotalModelStyle}
        homeModelStyle={underTotalModelStyle}
        ticketsPct={totalTicketsPct}
        handlePct={totalHandlePct}
        totalLine={!isNaN(bkTotal) ? String(bkTotal) : undefined}
        openAwayBook={openOverStr}
        openHomeBook={openUnderStr}
      />
      {/* Divider */}
      <div
        style={{
          width: 1,
          background: "#FFFFFF",
          flexShrink: 0,
          alignSelf: "stretch",
          margin: "8px 0",
        }}
      />
      {/* MONEYLINE section */}
      <SectionCol
        title="Moneyline"
        awayLabel={awayMlLabel}
        homeLabel={homeMlLabel}
        awayBook={displayAwayML}
        homeBook={displayHomeML}
        awayModel={mdlAwayMlStr}
        homeModel={mdlHomeMlStr}
        awayModelStyle={awayMlModelStyle}
        homeModelStyle={homeMlModelStyle}
        ticketsPct={mlTicketsPct}
        handlePct={mlHandlePct}
        awayLogoUrl={awayLogoUrl}
        homeLogoUrl={homeLogoUrl}
        awayAbbr={awayAbbr}
        homeAbbr={homeAbbr}
        openAwayBook={openAwayMlStr}
        openHomeBook={openHomeMlStr}
      />
      {/* Divider */}
      <div
        style={{
          width: 1,
          background: "#FFFFFF",
          flexShrink: 0,
          alignSelf: "stretch",
        }}
      />
      {/* EdgeVerdict column — width MUST be identical for showModel=true and showModel=false to prevent layout shift */}
      {/* Canonical width: clamp(180px,15vw,240px) — matches file-header spec, uniform across all toggle states */}
      {showModel ? (
        <div
          className="flex flex-col items-start justify-center"
          style={{
            flex: "0 0 clamp(180px,15vw,240px)",
            width: "clamp(180px,15vw,240px)",
            padding: "10px 12px",
            gap: 0,
          }}
        >
          {/* EDGE header */}
          <span
            style={{
              fontSize: "clamp(11px,0.9vw,14px)",
              fontWeight: 800,
              color: "#FFFFFF",
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              marginBottom: 8,
              alignSelf: "center",
            }}
          >
            EDGE
          </span>
          {spreadPass && totalPass && !hasMlEdge ? (
            <div
              style={{
                alignSelf: "center",
                padding: "4px 10px",
                borderRadius: 8,
                background: "#000000",
                border: "1px solid #FFFFFF",
              }}
            >
              <span
                style={{
                  fontSize: "clamp(12px,1.0vw,15px)",
                  fontWeight: 700,
                  color: "#FFFFFF",
                  letterSpacing: "0.1em",
                }}
              >
                PASS
              </span>
            </div>
          ) : (
            <div className="flex flex-col w-full" style={{ gap: 6 }}>
              {/* ── Spread / Puck Line / Run Line edge row ────────────────────────────── */}
              {!spreadPass &&
                (() => {
                  const diff = isNaN(spreadDiff) ? null : spreadDiff;
                  const edgeColor = getEdgeColor(diff ?? 0);
                  // AUTHORITATIVE spread label: build from spreadEdgeIsAway + model spread value.
                  // Format: "CIN +1.5" or "PIT -1.5" using the model's spread for the edge side.
                  const edgeAbbr = spreadEdgeIsAway ? awayAbbr : homeAbbr;
                  const edgeSpreadVal = spreadEdgeIsAway
                    ? mdlAwaySpread
                    : mdlHomeSpread;
                  const edgeSpreadStr = !isNaN(edgeSpreadVal)
                    ? `${edgeAbbr} ${spreadSign(edgeSpreadVal)}`
                    : normalizeEdgeLabel(computedSpreadEdge); // fallback to DB label
                  const normalized = edgeSpreadStr.trim();
                  const showArrow = (diff ?? 0) >= 3;
                  const mktLabel =
                    sport === "NHL"
                      ? "PUCK LINE"
                      : sport === "MLB"
                        ? "RUN LINE"
                        : "SPREAD";
                  return (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 3,
                        padding: "5px 8px",
                        borderRadius: 8,
                        background: "#000000",
                        border: `1px solid ${edgeColor}33`,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                          minWidth: 0,
                        }}
                      >
                        {(spreadLogoUrl || spreadVerdictSlug) && (
                          <TeamLogo
                            slug={spreadVerdictSlug ?? ""}
                            name={spreadVerdictTeam ?? ""}
                            logoUrl={spreadLogoUrl}
                            size={16}
                          />
                        )}
                        <span
                          style={{
                            fontSize: "clamp(11px,0.95vw,14px)",
                            fontWeight: 700,
                            color: "#FFFFFF",
                            letterSpacing: "0.04em",
                            textTransform: "uppercase",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            minWidth: 0,
                            flex: 1,
                          }}
                        >
                          {showArrow && (
                            <span
                              style={{
                                color: edgeColor,
                                marginRight: 2,
                                fontSize: "0.85em",
                              }}
                            >
                              ▲
                            </span>
                          )}
                          {normalized}
                        </span>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          flexWrap: "wrap",
                        }}
                      >
                        <span
                          style={{
                            fontSize: "clamp(11px,0.9vw,14px)",
                            color: "#FFFFFF",
                            fontWeight: 600,
                            letterSpacing: "0.06em",
                            textTransform: "uppercase",
                          }}
                        >
                          {mktLabel}
                        </span>
                        {!isNaN(spreadRoi) ? (
                          <span
                            style={{
                              fontSize: "clamp(10px,0.85vw,13px)",
                              fontWeight: 800,
                              color: edgeColor,
                              letterSpacing: "0.02em",
                            }}
                          >
                            {formatRoi(spreadRoi)}
                          </span>
                        ) : diff !== null ? (
                          <span
                            style={{
                              fontSize: "clamp(10px,0.85vw,13px)",
                              fontWeight: 800,
                              color: edgeColor,
                              letterSpacing: "0.02em",
                            }}
                          >
                            {diff}
                            {diff === 1 ? "PT" : "PTS"}
                          </span>
                        ) : (
                          <span
                            style={{
                              fontSize: "clamp(10px,0.85vw,13px)",
                              fontWeight: 800,
                              color: edgeColor,
                              letterSpacing: "0.02em",
                            }}
                          >
                            —
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })()}
              {/* ── Total edge row ──────────────────────────────────────────────────────── */}
              {!totalPass &&
                (() => {
                  const diff = isNaN(totalDiff) ? null : totalDiff;
                  const edgeColor = getEdgeColor(diff ?? 0);
                  // AUTHORITATIVE label: use totalEdgeIsOver (computed from model odds probability)
                  // NOT computedTotalEdge from DB (which may be stale/wrong from Python engine).
                  // Format: "OVER 8" or "UNDER 8.5" using the book's total line as anchor.
                  const authTotalLabel =
                    totalEdgeIsOver === true
                      ? `OVER ${isNaN(bkTotal) ? "" : bkTotal}`
                      : totalEdgeIsOver === false
                        ? `UNDER ${isNaN(bkTotal) ? "" : bkTotal}`
                        : normalizeEdgeLabel(computedTotalEdge); // fallback to DB label if direction unknown
                  const normalized = authTotalLabel.trim();
                  const showArrow = (diff ?? 0) >= 3;
                  return (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 3,
                        padding: "5px 8px",
                        borderRadius: 8,
                        background: "#000000",
                        border: `1px solid ${edgeColor}33`,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                          minWidth: 0,
                        }}
                      >
                        <span
                          style={{
                            fontSize: "clamp(11px,0.95vw,14px)",
                            fontWeight: 700,
                            color: "#FFFFFF",
                            letterSpacing: "0.04em",
                            textTransform: "uppercase",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            minWidth: 0,
                            flex: 1,
                          }}
                        >
                          {showArrow && (
                            <span
                              style={{
                                color: edgeColor,
                                marginRight: 2,
                                fontSize: "0.85em",
                              }}
                            >
                              ▲
                            </span>
                          )}
                          {normalized}
                        </span>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          flexWrap: "wrap",
                        }}
                      >
                        <span
                          style={{
                            fontSize: "clamp(11px,0.9vw,14px)",
                            color: "#FFFFFF",
                            fontWeight: 600,
                            letterSpacing: "0.06em",
                            textTransform: "uppercase",
                          }}
                        >
                          TOTAL
                        </span>
                        {!isNaN(totalRoi) ? (
                          <span
                            style={{
                              fontSize: "clamp(10px,0.85vw,13px)",
                              fontWeight: 800,
                              color: edgeColor,
                              letterSpacing: "0.02em",
                            }}
                          >
                            {formatRoi(totalRoi)}
                          </span>
                        ) : diff !== null ? (
                          <span
                            style={{
                              fontSize: "clamp(10px,0.85vw,13px)",
                              fontWeight: 800,
                              color: edgeColor,
                              letterSpacing: "0.02em",
                            }}
                          >
                            {diff}
                            {diff === 1 ? "PT" : "PTS"}
                          </span>
                        ) : (
                          <span
                            style={{
                              fontSize: "clamp(10px,0.85vw,13px)",
                              fontWeight: 800,
                              color: edgeColor,
                              letterSpacing: "0.02em",
                            }}
                          >
                            —
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })()}
              {/* ── ML edge row (shown when spread edge exists and ML edge pp > 0.5) ─────────── */}
              {hasMlEdge &&
                mlEdgeLabel &&
                (() => {
                  const diff = Math.round(mlEdgePP * 10) / 10;
                  const edgeColor = getEdgeColor(diff);
                  const showArrow = diff >= 3;
                  return (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 3,
                        padding: "5px 8px",
                        borderRadius: 8,
                        background: "#000000",
                        border: `1px solid ${edgeColor}33`,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                          minWidth: 0,
                        }}
                      >
                        {(mlEdgeLogoUrl || mlEdgeSlug) && (
                          <TeamLogo
                            slug={mlEdgeSlug ?? ""}
                            name={mlEdgeTeam ?? ""}
                            logoUrl={mlEdgeLogoUrl}
                            size={16}
                          />
                        )}
                        <span
                          style={{
                            fontSize: "clamp(11px,0.95vw,14px)",
                            fontWeight: 700,
                            color: "#FFFFFF",
                            letterSpacing: "0.04em",
                            textTransform: "uppercase",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            minWidth: 0,
                            flex: 1,
                          }}
                        >
                          {showArrow && (
                            <span
                              style={{
                                color: edgeColor,
                                marginRight: 2,
                                fontSize: "0.85em",
                              }}
                            >
                              ▲
                            </span>
                          )}
                          {mlEdgeLabel}
                        </span>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          flexWrap: "wrap",
                        }}
                      >
                        <span
                          style={{
                            fontSize: "clamp(11px,0.9vw,14px)",
                            color: "#FFFFFF",
                            fontWeight: 600,
                            letterSpacing: "0.06em",
                            textTransform: "uppercase",
                          }}
                        >
                          MONEYLINE
                        </span>
                        {!isNaN(mlRoi) ? (
                          <span
                            style={{
                              fontSize: "clamp(10px,0.85vw,13px)",
                              fontWeight: 800,
                              color: edgeColor,
                              letterSpacing: "0.02em",
                            }}
                          >
                            {formatRoi(mlRoi)}
                          </span>
                        ) : (
                          <span
                            style={{
                              fontSize: "clamp(10px,0.85vw,13px)",
                              fontWeight: 800,
                              color: edgeColor,
                              letterSpacing: "0.02em",
                            }}
                          >
                            {diff}
                            {diff === 1 ? "PT" : "PTS"}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })()}
            </div>
          )}
        </div>
      ) : (
        <div
          style={{
            flex: "0 0 clamp(180px,15vw,240px)",
            width: "clamp(180px,15vw,240px)",
            flexShrink: 0,
          }}
        />
      )}
    </div>
  );
}

// ── OddsCell ─────────────────────────────────────────────────────────────────
//
// Pill-style odds cell inspired by Action Network's book-cell design.
//
// Visual spec:
//   ┌─────────────────────────────────────────────────────────────────┐
//   │  [🔖 orange bookmark badge — top-left corner, only when best]  │
//   │                                                                 │
//   │              +5.5          ← mainValue (bold, large)           │
//   │              -115          ← juiceStr  (muted, smaller)        │
//   │                                                                 │
//   └─────────────────────────────────────────────────────────────────┘
//
// Props:
//   mainValue  — the primary line value, e.g. "+5.5", "o139.5", "-148"
//   juiceStr   — the odds/juice, e.g. "-115", "-110" (null = omit second line)
//   isBest     — when true, renders the orange bookmark badge (top-left)
//   isEdge     — when true, applies neon green highlight to the pill
//   isBook     — when true, renders book styling (light bg pill); else model styling (transparent)
//   openLine   — optional open line string shown above pill in muted text
//   size       — 'sm' (mobile) | 'md' (tablet/desktop)
//
// Sizing strategy:
//   All font sizes use CSS clamp() so the pill scales fluidly from 320px to 1920px viewport.
//   The pill container uses percentage-based padding so it never overflows its grid cell.
//
// Debug logging:
//   In development, logs [OddsCell] mainValue + juiceStr + isBest + isEdge to console
//   whenever isBest or isEdge is true (to avoid noise for normal cells).

interface OddsCellProps {
  mainValue: string;
  juiceStr?: string | null;
  isBest?: boolean;
  isEdge?: boolean;
  isBook?: boolean;
  openLine?: string | null;
  size?: "sm" | "md";
  /** Optional additional style overrides for the outer wrapper */
  wrapperStyle?: React.CSSProperties;
}

function OddsCell({
  mainValue,
  juiceStr,
  isBest = false,
  isEdge = false,
  isBook = true,
  openLine,
  size = "md",
  wrapperStyle,
}: OddsCellProps) {
  // ── Debug logging ──────────────────────────────────────────────────────────
  if (process.env.NODE_ENV === "development" && (isBest || isEdge)) {
    console.log(
      `%c[OddsCell] ${mainValue} ${juiceStr ?? ""} | isBest=${isBest} isEdge=${isEdge} isBook=${isBook} size=${size}`,
      `color:${isEdge ? "#45E0A8" : "#FFFFFF"};font-size:9px`
    );
  }

  // ── Sizing ─────────────────────────────────────────────────────────────────
  // sm (mobile): mainValue 11-13px, juice 9-10px, pill padding 3px 5px
  // md (desktop): mainValue 13-17px, juice 10-12px, pill padding 4px 8px
  const mainFs =
    size === "sm" ? "clamp(10.5px, 2.6vw, 12.5px)" : "clamp(13px, 1.1vw, 17px)";
  const juiceFs =
    size === "sm" ? "clamp(9px, 2.1vw, 10.5px)" : "clamp(10px, 0.85vw, 12px)";
  const openFs =
    size === "sm" ? "clamp(9px, 2.0vw, 11px)" : "clamp(10px, 0.85vw, 12px)";
  const pillPadding = size === "sm" ? "3px 5px" : "4px 8px";
  const borderRadius = size === "sm" ? "8px" : "10px";

  // ── Colors ─────────────────────────────────────────────────────────────────
  // Book pill: light semi-transparent background, dark text on light → use white text on dark bg
  // Model pill: transparent bg, colored text
  // Edge: neon green border + text
  const pillBg = isBook ? (isEdge ? "transparent" : "#000000") : "transparent";
  const pillBorder = isBook
    ? isEdge
      ? "1px solid var(--dime-mint-border, #45E0A8)"
      : "1px solid #FFFFFF"
    : isEdge
      ? "1px solid var(--dime-mint-border, #45E0A8)"
      : "1px solid transparent";
  const mainColor = isEdge
    ? "var(--dime-mint-text, #45E0A8)"
    : isBook
      ? "#FFFFFF"
      : "#FFFFFF"; // 2026-08-05 token law
  const mainWeight = isEdge ? 800 : isBook ? 700 : 700;
  // Model cells: juice is always neon green (edge = full, non-edge = 60%); book cells: muted gray
  // 2026-08-05 token law: mint text is theme-correct
  const juiceColor = isBook
    ? isEdge
      ? "var(--dime-mint-text, #45E0A8)"
      : "#FFFFFF"
    : isEdge
      ? "var(--dime-mint-text, #45E0A8)"
      : "#FFFFFF";

  return (
    <div
      className="flex flex-col items-center justify-center"
      style={{ gap: 1, ...wrapperStyle }}
    >
      {/* Open line — shown above the pill in muted text */}
      {openLine && (
        <span
          className="tabular-nums"
          style={{
            fontSize: openFs,
            fontWeight: 500,
            color: "#FFFFFF",
            letterSpacing: "0.03em",
            whiteSpace: "nowrap",
            lineHeight: 1,
            marginBottom: 1,
          }}
        >
          o:{openLine}
        </span>
      )}

      {/* Pill container */}
      <div
        style={{
          position: "relative",
          display: "inline-flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: pillPadding,
          borderRadius,
          background: pillBg,
          border: pillBorder,
          minWidth: size === "sm" ? 42 : 48,
          gap: 1,
          transition:
            "background 160ms cubic-bezier(0.16,1,0.3,1), border-color 160ms cubic-bezier(0.16,1,0.3,1)",
        }}
      >
        {/* Orange bookmark badge — top-left corner */}
        {isBest && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: size === "sm" ? 12 : 15,
              height: size === "sm" ? 16 : 20,
              overflow: "hidden",
              borderTopLeftRadius: borderRadius,
            }}
            title="Best available odds"
          >
            {/* Bookmark ribbon SVG — orange fill, star icon */}
            <svg
              viewBox="0 0 15 20"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              style={{ width: "100%", height: "100%" }}
            >
              <path
                d="M0 0 H15 V20 L7.5 14 L0 20 Z"
                fill="var(--dime-mint, #45E0A8)"
              />
              <text
                x="7.5"
                y="10"
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize="7"
                fill="#FFFFFF"
                fontWeight="bold"
              >
                ★
              </text>
            </svg>
          </div>
        )}

        {/* Main value — bold, large */}
        <span
          className="tabular-nums"
          style={{
            fontSize: mainFs,
            fontWeight: mainWeight,
            color: mainColor,
            letterSpacing: "0.01em",
            lineHeight: 1.1,
            whiteSpace: "nowrap",
          }}
        >
          {mainValue}
        </span>

        {/* Juice/odds — smaller, muted */}
        {juiceStr && (
          <span
            className="tabular-nums"
            style={{
              fontSize: juiceFs,
              fontWeight: 500,
              color: juiceColor,
              letterSpacing: "0.01em",
              lineHeight: 1,
              whiteSpace: "nowrap",
            }}
          >
            {juiceStr}
          </span>
        )}
      </div>
    </div>
  );
}

// ── BookOddsCell (legacy shim — kept for backward compat with OddsLinesPanel) ─
// Two-line cell for mobile BOOK column: spread/total on line 1, odds on line 2.
// When oddsStr is null/empty, renders a single centered line (no second line).
function BookOddsCell({
  spreadStr,
  oddsStr,
  style,
}: {
  spreadStr: string;
  oddsStr: string | null | undefined;
  style: React.CSSProperties;
}) {
  if (!oddsStr) {
    return (
      <div className="flex items-center justify-center">
        <span className="tabular-nums" style={style}>
          {spreadStr}
        </span>
      </div>
    );
  }
  return (
    <div
      className="flex flex-col items-center justify-center"
      style={{ gap: 0, lineHeight: 1.2 }}
    >
      <span
        className="tabular-nums"
        style={{ ...style, fontSize: "10px", fontWeight: style.fontWeight }}
      >
        {spreadStr}
      </span>
      <span
        className="tabular-nums"
        style={{ ...style, fontSize: "8.5px", fontWeight: 400, opacity: 0.85 }}
      >
        ({oddsStr})
      </span>
    </div>
  );
}

// ── OddsLinesPanel ───────────────────────────────────────────────────────────
// IMPORTANT: This MUST be defined at module level (not inside GameCard) to avoid
// React treating it as a new component type on every render, which causes an
// infinite re-render loop / "Maximum call stack size exceeded" error.

interface OddsLinesPanelProps {
  // Book values
  awayBookSpread: number;
  homeBookSpread: number;
  bookTotal: number;
  awayML: string;
  homeML: string;
  // Book odds (for parenthetical display, e.g. "+6.5 (-110)")
  awaySpreadOdds?: string | null;
  homeSpreadOdds?: string | null;
  overOdds?: string | null;
  underOdds?: string | null;
  // Open line strings (from AN HTML ingest)
  openAwaySpreadStr?: string | null;
  openHomeSpreadStr?: string | null;
  openOverStr?: string | null;
  openUnderStr?: string | null;
  openAwayMlStr?: string | null;
  openHomeMlStr?: string | null;
  // DK NJ current line strings (from AN HTML ingest)
  displayAwaySpread?: string;
  displayHomeSpread?: string;
  displayOver?: string;
  displayUnder?: string;
  displayAwayML?: string;
  displayHomeML?: string;
  // Model values
  awayModelSpread: number;
  homeModelSpread: number;
  modelTotal: number;
  modelAwayML: string | null | undefined;
  modelHomeML: string | null | undefined;
  // Computed edge values
  spreadDiff: number;
  totalDiff: number;
  computedSpreadEdge: string | null;
  computedTotalEdge: string | null;
  // Team identity for EdgeVerdict logos
  awayLogoUrl?: string;
  homeLogoUrl?: string;
  awaySlug?: string;
  homeSlug?: string;
  awayDisplayName?: string;
  homeDisplayName?: string;
  // Controlled model toggle (lifted to parent)
  showModel: boolean;
  onToggleModel: () => void;
  // Sport identifier (for NHL puck line odds display)
  sport?: string | null;
  // NHL model puck line and total odds
  modelAwayPLOdds?: string | null;
  modelHomePLOdds?: string | null;
  modelOverOdds?: string | null;
  modelUnderOdds?: string | null;
  // MLB model fair odds at book's spread line
  modelAwaySpreadOdds?: string | null;
  modelHomeSpreadOdds?: string | null;
  // MLB run line (VSiN) — used as primary RL label source (more authoritative than awayBookSpread/DK)
  awayRunLine?: string | null;
  homeRunLine?: string | null;
  // AUTHORITATIVE edge direction — computed once at GameCard level, passed down
  authSpreadEdgeIsAway: boolean | null;
  authTotalEdgeIsOver: boolean | null;
  /**
   * True when modelRunAt is non-null (model has been run and result is valid).
   * When false (model invalidated or not yet run), all MODEL columns show '—'
   * to prevent stale/wrong model data from being displayed during re-run window.
   */
  isModeled: boolean;
}

function OddsLinesPanel({
  awayBookSpread: awaySpread,
  homeBookSpread: homeSpread,
  bookTotal: bkTotal,
  awayML: awayMl,
  homeML: homeMl,
  awaySpreadOdds,
  homeSpreadOdds,
  overOdds,
  underOdds,
  openAwaySpreadStr,
  openHomeSpreadStr,
  openOverStr,
  openUnderStr,
  openAwayMlStr,
  openHomeMlStr,
  displayAwaySpread: dkAwaySpreadProp,
  displayHomeSpread: dkHomeSpreadProp,
  displayOver: dkOverProp,
  displayUnder: dkUnderProp,
  displayAwayML: dkAwayMlProp,
  displayHomeML: dkHomeMlProp,
  awayModelSpread: mdlAwaySpread,
  homeModelSpread: mdlHomeSpread,
  modelTotal: mdlTotal,
  modelAwayML,
  modelHomeML,
  spreadDiff,
  totalDiff,
  computedSpreadEdge,
  computedTotalEdge,
  awayLogoUrl,
  homeLogoUrl,
  awaySlug,
  homeSlug,
  awayDisplayName,
  homeDisplayName,
  showModel,
  onToggleModel,
  sport,
  modelAwayPLOdds,
  modelHomePLOdds,
  modelOverOdds,
  modelUnderOdds,
  modelAwaySpreadOdds,
  modelHomeSpreadOdds,
  awayRunLine,
  homeRunLine,
  authSpreadEdgeIsAway,
  authTotalEdgeIsOver,
  isModeled,
}: OddsLinesPanelProps) {
  // Change 1: hide Spread/Total/Moneyline + Book/Model header rows on desktop
  // These are redundant on desktop — each game card already has headers in the matchup panel.
  const isDesktopOdds = useIsDesktop();

  const mdlAwayMl = modelAwayML ?? "—";
  const mdlHomeMl = modelHomeML ?? "—";
  // isModeled=false means modelRunAt=null: model was invalidated (e.g. ML direction flip)
  // or not yet run. In this case, show '—' for all model columns to prevent stale display.
  const hasModelData =
    isModeled &&
    (!isNaN(mdlAwaySpread) || !isNaN(mdlTotal) || mdlAwayMl !== "—");

  // ── Book / Model display values — LINE and ODDS are kept SEPARATE so OddsCell
  //    renders them with proper visual hierarchy (line bold/large, odds smaller/muted).
  //    Combining them into one string causes the odds to wrap inside the pill and
  //    appear as a second "line" — the exact visual confusion reported.
  const bkTotalStr = !isNaN(bkTotal) ? String(bkTotal) : "—";

  // Book spread — line only (no parenthetical odds in mainValue)
  const bkAwaySpreadLineBase = !isNaN(awaySpread)
    ? spreadSign(awaySpread)
    : "—";
  const bkHomeSpreadLineBase = !isNaN(homeSpread)
    ? spreadSign(homeSpread)
    : "—";
  // Book spread odds — passed as juiceStr to OddsCell
  const bkAwaySpreadJuice = awaySpreadOdds ?? null;
  const bkHomeSpreadJuice = homeSpreadOdds ?? null;

  // Book total — line only
  const bkOverTotalLineBase = !isNaN(bkTotal) ? `o${bkTotalStr}` : "o—";
  const bkUnderTotalLineBase = !isNaN(bkTotal) ? `u${bkTotalStr}` : "u—";
  // Book total odds — passed as juiceStr
  const bkOverJuice = overOdds ?? null;
  const bkUnderJuice = underOdds ?? null;

  // Prefer DK-specific display values when available (DK props are already line-only strings)
  const bkAwaySpreadLine = dkAwaySpreadProp ?? bkAwaySpreadLineBase;
  const bkHomeSpreadLine = dkHomeSpreadProp ?? bkHomeSpreadLineBase;
  const bkOverTotalLine = dkOverProp ? `o${dkOverProp}` : bkOverTotalLineBase;
  const bkUnderTotalLine = dkUnderProp
    ? `u${dkUnderProp}`
    : bkUnderTotalLineBase;
  const awayMlDisplay = dkAwayMlProp ?? awayMl;
  const homeMlDisplay = dkHomeMlProp ?? homeMl;

  // ── Model values — line and odds SEPARATE ──────────────────────────────────
  const isNhlGame = sport === "NHL";
  const isMlbGame = sport === "MLB";
  // ── MLB RULE: model RL LABEL always mirrors book RL LABEL exactly.
  // Only the ODDS differ between book and model.
  // awayModelSpread/homeModelSpread may be stale or inverted if the model ran with wrong rl_home_spread.
  // The book's awayBookSpread/homeBookSpread is the single source of truth for the ±1.5 label.
  // For NHL/NBA: use model spread as before (model line is meaningful for non-RL sports).
  // ── MLB RL LABEL: Priority: awayRunLine (VSiN) → awayBookSpread (DK NJ) → null ─────────────────────
  // NEVER use awayModelSpread as the label for MLB — it can have wrong sign.
  // [INPUT]  awayRunLine = "+1.5" (VSiN) or null
  // [INPUT]  awaySpread = 1.5 (DK NJ) or NaN
  // [OUTPUT] mlbBookAwayLine = "+1.5" (correct book label) or null
  const mlbBookAwayLine = isMlbGame
    ? awayRunLine != null && awayRunLine !== ""
      ? awayRunLine // VSiN run line (most authoritative)
      : !isNaN(awaySpread)
        ? spreadSign(awaySpread) // DK NJ spread fallback
        : null // no label available
    : null;
  const mlbBookHomeLine = isMlbGame
    ? homeRunLine != null && homeRunLine !== ""
      ? homeRunLine
      : !isNaN(homeSpread)
        ? spreadSign(homeSpread)
        : null
    : null;
  if (process.env.NODE_ENV === "development" && isMlbGame) {
    console.log(
      `[OddsLinesPanel:MLB_RL_LABEL] away=${awayDisplayName ?? "?"} home=${homeDisplayName ?? "?"}` +
        ` | awayRunLine=${awayRunLine ?? "null"} awayBookSpread=${awaySpread}` +
        ` | mlbBookAwayLine=${mlbBookAwayLine ?? "null"} mlbBookHomeLine=${mlbBookHomeLine ?? "null"}`
    );
  }
  // Model spread line:
  //   MLB  → always use book label (mlbBookAwayLine / mlbBookHomeLine)
  //   NHL  → use model puck line label (mdlAwaySpread)
  //   NBA  → use model spread label (mdlAwaySpread)
  const mdlAwaySpreadLine = hasModelData
    ? isMlbGame
      ? (mlbBookAwayLine ??
        (mdlAwaySpread !== undefined && !isNaN(mdlAwaySpread)
          ? spreadSign(mdlAwaySpread)
          : "—"))
      : !isNaN(mdlAwaySpread)
        ? spreadSign(mdlAwaySpread)
        : "—"
    : "—";
  const mdlHomeSpreadLine = hasModelData
    ? isMlbGame
      ? (mlbBookHomeLine ??
        (mdlHomeSpread !== undefined && !isNaN(mdlHomeSpread)
          ? spreadSign(mdlHomeSpread)
          : "—"))
      : !isNaN(mdlHomeSpread)
        ? spreadSign(mdlHomeSpread)
        : "—"
    : "—";
  // Model spread odds — juiceStr for NHL puck line and MLB run line
  // [FIX] fmtOddsSign ensures positive odds (e.g. 214) display as '+214' not '214'.
  const mdlAwaySpreadJuice = hasModelData
    ? isNhlGame
      ? fmtOddsSign(modelAwayPLOdds ?? null)
      : isMlbGame
        ? fmtOddsSign(modelAwaySpreadOdds ?? null)
        : null
    : null;
  const mdlHomeSpreadJuice = hasModelData
    ? isNhlGame
      ? fmtOddsSign(modelHomePLOdds ?? null)
      : isMlbGame
        ? fmtOddsSign(modelHomeSpreadOdds ?? null)
        : null
    : null;

  // Keep legacy combined strings for any code paths that still use them (edge labels etc.)
  const mdlAwaySpreadStr = mdlAwaySpreadLine;
  const mdlHomeSpreadStr = mdlHomeSpreadLine;
  // CRITICAL: ALWAYS display the BOOK's total line with model fair odds at that line.
  // The book O/U is the NON-NEGOTIABLE reference for edge detection and display across ALL sports.
  // modelTotal in DB is now anchored to bookTotal (fixed in mlbModelRunner/nhlModelSync)
  // but we enforce it here as a defense-in-depth guard: if bkTotal is available, use it.
  const mdlDisplayTotal = !isNaN(bkTotal) ? bkTotal : mdlTotal;
  // Validation audit: warn in console if model total diverges from book total (should never happen)
  if (
    process.env.NODE_ENV !== "production" &&
    !isNaN(mdlTotal) &&
    !isNaN(bkTotal) &&
    Math.abs(mdlTotal - bkTotal) > 0.01
  ) {
    console.warn(
      `[LINE AUDIT] ${awayDisplayName ?? "AWAY"}@${homeDisplayName ?? "HOME"} (${sport ?? "?"}): ` +
        `modelTotal=${mdlTotal} ≠ bookTotal=${bkTotal} — displaying bookTotal per policy`
    );
  }
  // Model total — LINE and ODDS SEPARATE (same pattern as spread fix)
  // mainValue = line only ("8.5"), juiceStr = odds only ("-115") passed to OddsCell
  const mdlOverTotalLine =
    hasModelData && !isNaN(mdlDisplayTotal) ? String(mdlDisplayTotal) : "—";
  const mdlUnderTotalLine =
    hasModelData && !isNaN(mdlDisplayTotal) ? String(mdlDisplayTotal) : "—";
  // [FIX] fmtOddsSign ensures positive odds (e.g. 115) display as '+115' not '115'.
  const mdlOverJuice =
    hasModelData && (isNhlGame || isMlbGame)
      ? fmtOddsSign(modelOverOdds ?? null)
      : null;
  const mdlUnderJuice =
    hasModelData && (isNhlGame || isMlbGame)
      ? fmtOddsSign(modelUnderOdds ?? null)
      : null;
  // Legacy aliases kept for any remaining code paths that reference the old names
  const mdlOverTotal = mdlOverTotalLine;
  const mdlUnderTotal = mdlUnderTotalLine;
  const mdlAwayMlStr = hasModelData ? mdlAwayMl : "—";
  const mdlHomeMlStr = hasModelData ? mdlHomeMl : "—";

  // Grid: 6 columns when model is ON (Book|Model per group), 3 columns when model is OFF (Book only)
  const GRID = showModel ? "grid-cols-6" : "grid-cols-3";

  // ── Use AUTHORITATIVE edge direction passed from GameCard (computed after awayAbbr resolved) ─
  // Replaces the flawed includes('+1.5') check that failed for home favorites like 'COL -1.5'.
  const spreadEdgeIsAway = authSpreadEdgeIsAway;
  const totalEdgeIsOver = authTotalEdgeIsOver;

  const hasSpreadEdge = spreadEdgeIsAway !== null;
  const hasTotalEdge = totalEdgeIsOver !== null;

  // Base cell styles — book values are bolder when model is off (primary data), lighter when model is on (secondary)
  // Font sizes scale with viewport: clamp(min, preferred_vw, max)
  // Use smaller font when showing odds in parentheses (longer strings like "+6.5 (-110)")
  const cellFontSize = "clamp(9.5px, 1.0vw, 13px)";
  const bookCell = {
    fontSize: cellFontSize,
    fontWeight: showModel ? 400 : 600,
    color: "#FFFFFF",
    letterSpacing: "0.01em",
    textAlign: "center" as const,
    lineHeight: "1.3",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties;
  // Model cells: neon green only when this specific cell is the edge side; otherwise bold white
  const modelGreen = {
    fontSize: cellFontSize,
    fontWeight: 700,
    color: "var(--dime-mint-text, #45E0A8)", // 2026-08-05 token law: mint text is theme-correct
    letterSpacing: "0.01em",
    textAlign: "center" as const,
  } as React.CSSProperties;
  const modelWhite = {
    fontSize: cellFontSize,
    fontWeight: 700,
    color: "#FFFFFF",
    letterSpacing: "0.01em",
    textAlign: "center" as const,
  } as React.CSSProperties;
  const dimCell = {
    fontSize: cellFontSize,
    fontWeight: 700,
    color: "#FFFFFF",
    letterSpacing: "0.01em",
    textAlign: "center" as const,
  } as React.CSSProperties;

  // Per-cell model style helpers
  // Null-guard: !null === true in JS — require explicit true/false, never rely on truthy/falsy for direction.
  const awaySpreadModelStyle = showModel
    ? hasSpreadEdge && spreadEdgeIsAway === true
      ? modelGreen
      : modelWhite
    : dimCell;
  const homeSpreadModelStyle = showModel
    ? hasSpreadEdge && spreadEdgeIsAway === false
      ? modelGreen
      : modelWhite
    : dimCell;
  const overTotalModelStyle = showModel
    ? hasTotalEdge && totalEdgeIsOver === true
      ? modelGreen
      : modelWhite
    : dimCell;
  const underTotalModelStyle = showModel
    ? hasTotalEdge && totalEdgeIsOver === false
      ? modelGreen
      : modelWhite
    : dimCell;
  // ML edges: independent of spread edge direction -- use team with larger positive ML edge pp
  const bkAwayMlNumMob = toNum(awayMl);
  const bkHomeMlNumMob = toNum(homeMl);
  const mdlAwayMlNumMob = toNum(modelAwayML);
  const mdlHomeMlNumMob = toNum(modelHomeML);
  const awayMlEdgePPMob = calculateEdge(bkAwayMlNumMob, mdlAwayMlNumMob);
  const homeMlEdgePPMob = calculateEdge(bkHomeMlNumMob, mdlHomeMlNumMob);
  const EDGE_THRESHOLD_ML_MOB = 0.5;
  // [FIX 2026-06-24] Gate ML edge detection on hasModelData (same fix as DesktopMergedPanel above).
  const awayMlPosMob =
    hasModelData &&
    !isNaN(awayMlEdgePPMob) &&
    awayMlEdgePPMob > EDGE_THRESHOLD_ML_MOB;
  const homeMlPosMob =
    hasModelData &&
    !isNaN(homeMlEdgePPMob) &&
    homeMlEdgePPMob > EDGE_THRESHOLD_ML_MOB;
  const mlEdgeIsAwayMob: boolean | null = (() => {
    if (awayMlPosMob && homeMlPosMob)
      return awayMlEdgePPMob >= homeMlEdgePPMob ? true : false;
    if (awayMlPosMob) return true;
    if (homeMlPosMob) return false;
    return null;
  })();
  const hasMlEdgeMob = mlEdgeIsAwayMob !== null;
  const awayMlModelStyle = showModel
    ? hasMlEdgeMob && mlEdgeIsAwayMob === true
      ? modelGreen
      : modelWhite
    : dimCell;
  const homeMlModelStyle = showModel
    ? hasMlEdgeMob && mlEdgeIsAwayMob === false
      ? modelGreen
      : modelWhite
    : dimCell;

  // Helper: cell value with style
  const Cell = ({
    val,
    style,
  }: {
    val: string;
    style: React.CSSProperties;
  }) => (
    <div className="flex items-center justify-center">
      <span className="tabular-nums" style={style}>
        {val}
      </span>
    </div>
  );

  return (
    <div
      className="flex flex-col pl-2 pr-0 pt-0 pb-0 min-w-0"
      style={{ justifyContent: "center" }}
    >
      {/* Top-level column group headers: SPREAD | TOTAL | MONEYLINE
           DESKTOP ONLY: hidden on desktop (lg+) — redundant with per-card matchup headers.
           MOBILE: always shown. */}
      {!isDesktopOdds && (
        <div
          className={`grid ${GRID} pb-0.5`}
          style={{
            transition:
              "grid-template-columns 160ms cubic-bezier(0.16,1,0.3,1)",
          }}
        >
          <span
            className={`${showModel ? "col-span-2" : ""} text-center font-extrabold uppercase tracking-widest`}
            style={{ fontSize: "clamp(12px, 1.05vw, 16px)", color: "#FFFFFF" }}
          >
            Spread
          </span>
          <span
            className={`${showModel ? "col-span-2" : ""} text-center font-extrabold uppercase tracking-widest`}
            style={{ fontSize: "clamp(12px, 1.05vw, 16px)", color: "#FFFFFF" }}
          >
            Total
          </span>
          <span
            className={`${showModel ? "col-span-2" : ""} text-center font-extrabold uppercase tracking-widest`}
            style={{ fontSize: "clamp(12px, 1.05vw, 16px)", color: "#FFFFFF" }}
          >
            Moneyline
          </span>
        </div>
      )}

      {/* Sub-headers: BOOK only when model off; BOOK | MODEL when model on
           DESKTOP ONLY: hidden on desktop (lg+) — redundant with per-card matchup headers.
           MOBILE: always shown. */}
      {!isDesktopOdds && (
        <div
          className={`grid ${GRID} pb-1 mb-0.5`}
          style={{
            borderBottom: "1px solid #FFFFFF",
            transition:
              "grid-template-columns 160ms cubic-bezier(0.16,1,0.3,1)",
          }}
        >
          {showModel
            ? ["Book", "Model", "Book", "Model", "Book", "Model"].map(
                (lbl, i) => (
                  <span
                    key={i}
                    className="text-center font-bold uppercase tracking-widest"
                    style={{
                      fontSize: "clamp(11px, 0.95vw, 14px)",
                      color:
                        lbl === "Model"
                          ? "var(--dime-mint-text, #45E0A8)"
                          : "#FFFFFF", // 2026-08-05 token law
                    }}
                  >
                    {lbl}
                  </span>
                )
              )
            : ["Book", "Book", "Book"].map((lbl, i) => (
                <span
                  key={i}
                  className="text-center font-bold uppercase tracking-widest"
                  style={{
                    fontSize: "clamp(11px, 0.95vw, 14px)",
                    color: "#FFFFFF",
                  }}
                >
                  {lbl}
                </span>
              ))}
        </div>
      )}

      {/* Away row — OddsCell pills for BOOK, plain spans for MODEL */}
      <div
        className={`grid ${GRID} py-2`}
        style={{
          transition: "grid-template-columns 160ms cubic-bezier(0.16,1,0.3,1)",
        }}
      >
        {/* Away Spread BOOK pill — line and odds SEPARATE for correct visual hierarchy */}
        <OddsCell
          mainValue={bkAwaySpreadLine}
          juiceStr={bkAwaySpreadJuice}
          isBook={true}
          openLine={openAwaySpreadStr}
          size="md"
          wrapperStyle={{ justifySelf: "center", width: "100%" }}
        />
        {showModel && (
          <OddsCell
            mainValue={mdlAwaySpreadLine}
            juiceStr={mdlAwaySpreadJuice}
            isBook={false}
            isEdge={awaySpreadModelStyle === modelGreen}
            size="md"
            wrapperStyle={{ justifySelf: "center", width: "100%" }}
          />
        )}
        {/* Away Total BOOK pill — line and odds SEPARATE */}
        <OddsCell
          mainValue={bkOverTotalLine}
          juiceStr={bkOverJuice}
          isBook={true}
          openLine={openOverStr}
          size="md"
          wrapperStyle={{ justifySelf: "center", width: "100%" }}
        />
        {showModel && (
          <OddsCell
            mainValue={`o${mdlOverTotalLine}`}
            juiceStr={mdlOverJuice}
            isBook={false}
            isEdge={overTotalModelStyle === modelGreen}
            size="md"
            wrapperStyle={{ justifySelf: "center", width: "100%" }}
          />
        )}
        {/* Away ML BOOK pill */}
        <OddsCell
          mainValue={awayMlDisplay || "—"}
          juiceStr={null}
          isBook={true}
          openLine={openAwayMlStr}
          size="md"
          wrapperStyle={{ justifySelf: "center", width: "100%" }}
        />
        {showModel && (
          <OddsCell
            mainValue={mdlAwayMlStr}
            juiceStr={null}
            isBook={false}
            isEdge={awayMlModelStyle === modelGreen}
            size="md"
            wrapperStyle={{ justifySelf: "center", width: "100%" }}
          />
        )}
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: "#FFFFFF" }} />

      {/* Home row — OddsCell pills for BOOK, plain spans for MODEL */}
      <div
        className={`grid ${GRID} py-2`}
        style={{
          transition: "grid-template-columns 160ms cubic-bezier(0.16,1,0.3,1)",
        }}
      >
        {/* Home Spread BOOK pill — line and odds SEPARATE for correct visual hierarchy */}
        <OddsCell
          mainValue={bkHomeSpreadLine}
          juiceStr={bkHomeSpreadJuice}
          isBook={true}
          openLine={openHomeSpreadStr}
          size="md"
          wrapperStyle={{ justifySelf: "center", width: "100%" }}
        />
        {showModel && (
          <OddsCell
            mainValue={mdlHomeSpreadLine}
            juiceStr={mdlHomeSpreadJuice}
            isBook={false}
            isEdge={homeSpreadModelStyle === modelGreen}
            size="md"
            wrapperStyle={{ justifySelf: "center", width: "100%" }}
          />
        )}
        {/* Home Total BOOK pill — line and odds SEPARATE */}
        <OddsCell
          mainValue={bkUnderTotalLine}
          juiceStr={bkUnderJuice}
          isBook={true}
          openLine={openUnderStr}
          size="md"
          wrapperStyle={{ justifySelf: "center", width: "100%" }}
        />
        {showModel && (
          <OddsCell
            mainValue={`u${mdlUnderTotalLine}`}
            juiceStr={mdlUnderJuice}
            isBook={false}
            isEdge={underTotalModelStyle === modelGreen}
            size="md"
            wrapperStyle={{ justifySelf: "center", width: "100%" }}
          />
        )}
        {/* Home ML BOOK pill */}
        <OddsCell
          mainValue={homeMlDisplay || "—"}
          juiceStr={null}
          isBook={true}
          openLine={openHomeMlStr}
          size="md"
          wrapperStyle={{ justifySelf: "center", width: "100%" }}
        />
        {showModel && (
          <OddsCell
            mainValue={mdlHomeMlStr}
            juiceStr={null}
            isBook={false}
            isEdge={homeMlModelStyle === modelGreen}
            size="md"
            wrapperStyle={{ justifySelf: "center", width: "100%" }}
          />
        )}
      </div>
    </div>
  );
}

// ── Main GameCard ─────────────────────────────────────────────────────────────

interface GameCardProps {
  game: GameRow;
  /** 'full' = all 3 panels (default), 'projections' = score+odds only, 'splits' = score+splits only */
  mode?: "full" | "projections" | "splits";
  /** When provided by a parent page, overrides internal model toggle state */
  showModel?: boolean;
  onToggleModel?: () => void;
  /** Set of favorited game IDs from the parent — avoids per-card fetches */
  favoriteGameIds?: Set<number>;
  onToggleFavorite?: (gameId: number) => void;
  /** Called when user favorites a game (not when unfavoriting) — used for in-page notification */
  onFavoriteNotify?: (gameId: number) => void;
  /**
   * Pass the parent's auth state down so GameCard doesn't need its own useAppAuth() query.
   * This avoids 33+ redundant tRPC calls and ensures the star renders immediately when
   * the parent already knows the user is authenticated.
   */
  isAppAuthed?: boolean;
  /**
   * Feed-level mobile tab override. When provided, the per-card tab state is ignored
   * and this value is used instead. The card will call onMobileTabChange when the user
   * interacts with the tab bar (but the tab bar is now rendered at the feed level).
   */
  mobileTab?: "dual" | "splits";
  onMobileTabChange?: (tab: "dual" | "splits") => void;
}

function GameCardInner({
  game,
  mode = "full",
  showModel: showModelProp,
  onToggleModel: onToggleModelProp,
  favoriteGameIds,
  onToggleFavorite,
  onFavoriteNotify,
  isAppAuthed: isAppAuthedProp,
  mobileTab: mobileTabProp,
  onMobileTabChange,
}: GameCardProps) {
  // Use custom app auth (app_session cookie) — NOT the legacy OAuth — to gate the star button.
  // Prefer the prop passed from the parent (avoids 33+ redundant tRPC queries per page load).
  // Fall back to calling useAppAuth() only when no prop is provided (e.g., standalone usage).
  const { appUser: appUserFallback } = useAppAuth();
  const isAppAuthed =
    isAppAuthedProp !== undefined ? isAppAuthedProp : Boolean(appUserFallback);
  const utils = trpc.useUtils();
  const toggleFavMutation = trpc.favorites.toggle.useMutation({
    onSuccess: () => {
      utils.favorites.getMyFavorites.invalidate();
      utils.favorites.getMyFavoritesWithDates.invalidate();
    },
  });
  const isFavorited = favoriteGameIds?.has(game.id) ?? false;
  const handleStarClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!isAppAuthed) return;
      const willBeFavorited = !isFavorited;
      if (onToggleFavorite) {
        onToggleFavorite(game.id);
      } else {
        toggleFavMutation.mutate({ gameId: game.id });
      }
      if (willBeFavorited && onFavoriteNotify) {
        onFavoriteNotify(game.id);
      }
    },
    [
      isAppAuthed,
      onToggleFavorite,
      game.id,
      toggleFavMutation,
      isFavorited,
      onFavoriteNotify,
    ]
  );
  const isNhlGame = game.sport === "NHL";
  const isMlbGame = game.sport === "MLB";
  // NHL puck line spread: trust the AN API spread value directly.
  // The spread value itself is authoritative: +1.5 = dog, -1.5 = fav.
  // The odds sign is NOT reliable for determining fav/dog in NHL puck lines because
  // the dog at +1.5 often has negative odds (e.g., -155) since covering +1.5 is easier.
  // DO NOT apply any odds-based sign correction — awayBookSpread from DB is correct.
  const awayBookSpread = toNum(game.awayBookSpread);
  const homeBookSpread = toNum(game.homeBookSpread);
  // IntersectionObserver-gated visibility — secondary panels only fetch when card is in viewport
  const [cardRef, isCardVisible] = useVisibility({ rootMargin: "200px" });
  // For NHL: use modelAwayPuckLine/modelHomePuckLine (simulation-derived, e.g. "+1.5"/"-1.5")
  // instead of awayModelSpread/homeModelSpread (which may contain stale goal-differential values).
  // For NBA: use awayModelSpread/homeModelSpread as before.
  const awayModelSpread = isNhlGame
    ? toNum(game.modelAwayPuckLine ?? game.awayModelSpread)
    : toNum(game.awayModelSpread);
  const homeModelSpread = isNhlGame
    ? toNum(game.modelHomePuckLine ?? game.homeModelSpread)
    : toNum(game.homeModelSpread);
  const bookTotal = toNum(game.bookTotal);
  // For NHL: modelTotal from DB may be stale (8.5 from old goal-sum formula).
  // The correct simulation-derived total is stored in modelTotal after re-run.
  // Use it directly — it will be correct after the next model run.
  const modelTotal = toNum(game.modelTotal);

  // Use game.spreadDiff (probability edge in pp, set by Python engine) for NHL and MLB.
  // MLB run lines are always ±1.5 — line arithmetic (|awayModelSpread - awayBookSpread|) always
  // yields 0 (signs match) or 3.0 (inverted sign), making it useless for edge detection.
  // The real MLB RL edge lives in the ODDS (model fair odds vs book break-even), so we use
  // game.spreadDiff (written by mlbModelRunner from away_rl_cover_pct vs book break-even).
  // For NBA: compute diff from line values as before.
  const spreadDiff =
    isNhlGame || isMlbGame
      ? toNum(game.spreadDiff)
      : !isNaN(awayModelSpread) && !isNaN(awayBookSpread)
        ? Math.round(Math.abs(awayModelSpread - awayBookSpread) * 10) / 10
        : toNum(game.spreadDiff);
  // For NHL: totalDiff is a probability edge in percentage points (set by Python engine).
  // Do NOT recalculate from |modelTotal - bookTotal| — that produces a goal difference (0.49)
  // which is always below the 8pp threshold, suppressing all total edges.
  // For NBA: compute diff from line values as before.
  // totalDiff: probability-based edge in percentage points.
  // For NHL and MLB: use game.totalDiff (set by Python/TS engine from model over/under% vs book break-even%).
  //   MLB model always sets modelTotal = bookTotal (same line), so line arithmetic gives 0 — useless.
  //   The edge lives in the ODDS (model P(over) vs book break-even%), not the line.
  // For NBA: compute from line arithmetic |modelTotal - bookTotal| (model outputs a different line).
  const totalDiff =
    isNhlGame || isMlbGame
      ? toNum(game.totalDiff)
      : !isNaN(modelTotal) && !isNaN(bookTotal)
        ? Math.round(Math.abs(modelTotal - bookTotal) * 10) / 10
        : toNum(game.totalDiff);
  // ── Open line strings (from AN HTML ingest) — available in GameCard scope ─
  const _normSpread = (s: string | null | undefined): string | null => {
    if (!s) return null;
    const n = parseFloat(s);
    if (!isNaN(n) && n > 0 && !s.startsWith("+")) return `+${s}`;
    return s;
  };
  const _fmtLine = (
    line: string | null | undefined,
    odds: string | null | undefined
  ): string | null => {
    if (!line) return null;
    return odds ? `${line} (${odds})` : line;
  };
  const openAwaySpreadStr = _fmtLine(
    _normSpread(game.openAwaySpread),
    game.openAwaySpreadOdds
  );
  const openHomeSpreadStr = _fmtLine(
    _normSpread(game.openHomeSpread),
    game.openHomeSpreadOdds
  );
  const openOverStr = _fmtLine(game.openTotal, game.openOverOdds);
  const openUnderStr = _fmtLine(game.openTotal, game.openUnderOdds);
  const openAwayMlStr = game.openAwayML ?? null;
  const openHomeMlStr = game.openHomeML ?? null;
  // ── Display strings: use awayBookSpread (already NHL-corrected at top of component) ─────
  // awayBookSpread/homeBookSpread are already odds-corrected above (dog=+1.5, fav=-1.5).
  // No secondary correction needed here.
  const _spreadSign = (n: number) => (n > 0 ? `+${n}` : String(n));
  const _bkAwaySpreadStr = !isNaN(awayBookSpread)
    ? game.awaySpreadOdds
      ? `${_spreadSign(awayBookSpread)} (${game.awaySpreadOdds})`
      : _spreadSign(awayBookSpread)
    : "—";
  const _bkHomeSpreadStr = !isNaN(homeBookSpread)
    ? game.homeSpreadOdds
      ? `${_spreadSign(homeBookSpread)} (${game.homeSpreadOdds})`
      : _spreadSign(homeBookSpread)
    : "—";
  const _bkOver = !isNaN(bookTotal)
    ? game.overOdds
      ? `${bookTotal} (${game.overOdds})`
      : String(bookTotal)
    : "—";
  const _bkUnder = !isNaN(bookTotal)
    ? game.underOdds
      ? `${bookTotal} (${game.underOdds})`
      : String(bookTotal)
    : "—";
  const displayAwaySpread = _bkAwaySpreadStr;
  const displayHomeSpread = _bkHomeSpreadStr;
  const displayOver = _bkOver;
  const displayUnder = _bkUnder;
  const displayAwayML = game.awayML ?? "—";
  const displayHomeML = game.homeML ?? "—";

  // College abbreviations must not resolve to professional teams (MIA is also the Marlins).
  const isNcaaf = game.sport === "NCAAF";
  // Resolve professional team info only outside the college feed.
  const awayNba = isNcaaf ? null : getNbaTeamByDbSlug(game.awayTeam);
  const homeNba = isNcaaf ? null : getNbaTeamByDbSlug(game.homeTeam);
  const awayNhl = !isNcaaf && !awayNba ? (NHL_BY_DB_SLUG.get(game.awayTeam) ?? null) : null;
  const homeNhl = !isNcaaf && !homeNba ? (NHL_BY_DB_SLUG.get(game.homeTeam) ?? null) : null;
  const awayMlb =
    !isNcaaf && !awayNba && !awayNhl ? (MLB_BY_ABBREV.get(game.awayTeam) ?? null) : null;
  const homeMlb =
    !isNcaaf && !homeNba && !homeNhl ? (MLB_BY_ABBREV.get(game.homeTeam) ?? null) : null;
  // Normalize city abbreviations: "LA" → "Los Angeles" (defensive, DB should already have full name)
  const normCity = (c: string | undefined) => (c === "LA" ? "Los Angeles" : c);
  const awayName =
    normCity(awayNba?.city) ??
    awayNhl?.city ??
    awayMlb?.city ??
    game.awayTeam.replace(/_/g, " ");
  const homeName =
    normCity(homeNba?.city) ??
    homeNhl?.city ??
    homeMlb?.city ??
    game.homeTeam.replace(/_/g, " ");
  const awayNickname =
    awayNba?.nickname ?? awayNhl?.nickname ?? awayMlb?.nickname ?? "";
  const homeNickname =
    homeNba?.nickname ?? homeNhl?.nickname ?? homeMlb?.nickname ?? "";
  const awayLogoUrl = isNcaaf ? ncaafHelmet(game.awayTeam) ?? undefined : awayNba?.logoUrl ?? awayNhl?.logoUrl ?? awayMlb?.logoUrl;
  const homeLogoUrl = isNcaaf ? ncaafHelmet(game.homeTeam) ?? undefined : homeNba?.logoUrl ?? homeNhl?.logoUrl ?? homeMlb?.logoUrl;

  const time = formatMilitaryTime(game.startTimeEst, game.sport);
  // All sports use ET — no date-shift needed (games end before midnight ET).
  const displayDate = game.gameDate;
  const dateLabel = formatDate(displayDate);

  // Score state
  const isLive = game.gameStatus === "live";
  const isFinal = game.gameStatus === "final";
  const isUpcoming = !isLive && !isFinal;
  const hasScores =
    game.awayScore !== null &&
    game.awayScore !== undefined &&
    game.homeScore !== null &&
    game.homeScore !== undefined;
  // Fix: include isLive so leading team in live games also gets winner styling (was isFinal-only)
  const awayWins =
    (isFinal || isLive) && hasScores && game.awayScore! > game.homeScore!;
  const homeWins =
    (isFinal || isLive) && hasScores && game.homeScore! > game.awayScore!;

  // Active market toggle — shared between BettingSplitsPanel and OddsHistoryPanel
  // Defaults to 'spread'; mirrors the SPREAD/TOTAL/MONEYLINE toggle in BettingSplitsPanel
  const [activeMarket, setActiveMarket] = useState<"spread" | "total" | "ml">(
    "spread"
  );

  // Model toggle state (lifted from OddsLinesPanel)
  const [showModelInternal, setShowModelInternal] = useState(true);
  const showModel =
    showModelProp !== undefined ? showModelProp : showModelInternal;
  const toggleModel =
    onToggleModelProp ?? (() => setShowModelInternal(v => !v));

  // Mobile tab state — controls which section is active on mobile full mode
  // Two tabs only: 'dual' (MODEL PROJECTIONS — BOOK+MODEL both active) | 'splits' (BETTING SPLITS)
  // DEFAULT: 'dual'
  type MobileTab = "dual" | "splits";
  const MOBILE_TAB_KEY = "prez_bets_mobile_tab_v2";
  const getPersistedTab = (): MobileTab => {
    try {
      const stored = localStorage.getItem(MOBILE_TAB_KEY);
      if (stored === "dual" || stored === "splits") return stored;
    } catch {
      /* localStorage unavailable (private browsing, etc.) */
    }
    return "dual"; // fallback default
  };
  const [mobileTabInternal, setMobileTabInternal] =
    useState<MobileTab>(getPersistedTab);
  // When a feed-level prop is provided, use it; otherwise fall back to internal state
  const mobileTab: MobileTab =
    mobileTabProp === "dual" || mobileTabProp === "splits"
      ? mobileTabProp
      : mobileTabInternal;
  const setMobileTab = (next: MobileTab) => {
    if (onMobileTabChange) {
      onMobileTabChange(next); // bubble up to feed
    } else {
      setMobileTabInternal(next); // standalone mode
    }
  };

  // Persist tab preference whenever it changes (only in standalone mode)
  useEffect(() => {
    if (!mobileTabProp) {
      try {
        localStorage.setItem(MOBILE_TAB_KEY, mobileTabInternal);
      } catch {
        /* ignore */
      }
    }
  }, [mobileTabInternal, mobileTabProp]);

  // Per-team score flash — only the team whose score increased flashes neon green
  const prevAwayScoreRef = useRef<number | null>(null);
  const prevHomeScoreRef = useRef<number | null>(null);
  const [awayScoreFlash, setAwayScoreFlash] = useState(false);
  const [homeScoreFlash, setHomeScoreFlash] = useState(false);
  useEffect(() => {
    const curAway = game.awayScore ?? null;
    const curHome = game.homeScore ?? null;
    if (
      curAway !== null &&
      prevAwayScoreRef.current !== null &&
      curAway > prevAwayScoreRef.current
    ) {
      if (process.env.NODE_ENV === "development") {
        console.log(
          `%c[GameCard:scoreFlash] game=${game.id} AWAY ${prevAwayScoreRef.current}→${curAway}`,
          "color:#45E0A8;font-size:10px"
        );
      }
      setAwayScoreFlash(true);
      const t = setTimeout(() => setAwayScoreFlash(false), 800);
      prevAwayScoreRef.current = curAway;
      return () => clearTimeout(t);
    }
    if (
      curHome !== null &&
      prevHomeScoreRef.current !== null &&
      curHome > prevHomeScoreRef.current
    ) {
      if (process.env.NODE_ENV === "development") {
        console.log(
          `%c[GameCard:scoreFlash] game=${game.id} HOME ${prevHomeScoreRef.current}→${curHome}`,
          "color:#45E0A8;font-size:10px"
        );
      }
      setHomeScoreFlash(true);
      const t = setTimeout(() => setHomeScoreFlash(false), 800);
      prevHomeScoreRef.current = curHome;
      return () => clearTimeout(t);
    }
    // Initialize refs on first render
    if (curAway !== null) prevAwayScoreRef.current = curAway;
    if (curHome !== null) prevHomeScoreRef.current = curHome;
  }, [game.awayScore, game.homeScore, game.id]);

  // Desktop detection — shared singleton hooks (no duplicate matchMedia listeners).
  // isDesktop = ≥1024 (lg); isMdUp = ≥768 (tablet band uses the md desktop layout,
  // so its type must never fall back to the sub-10px phone sizes).
  const isDesktop = useIsDesktop();
  const isMdUp = useIsMdUp();

  const maxDiff = Math.max(
    isNaN(spreadDiff) ? 0 : spreadDiff,
    isNaN(totalDiff) ? 0 : totalDiff
  );
  const borderColor = getEdgeColor(maxDiff);

  const awayDisplayName = awayNickname || awayName;
  const homeDisplayName = homeNickname || homeName;

  const computedSpreadEdge: string | null = (() => {
    // [FIX] For NHL/MLB: spreadDiff is null in DB (not written by Python engine for these sports).
    // The edge direction lives in game.spreadEdge (DB label set by Python engine).
    // Do NOT gate on spreadDiff <= 0 for NHL/MLB — it will always be 0 or null (line is always ±1.5).
    if (isNhlGame || isMlbGame) {
      if (!game.spreadEdge || game.spreadEdge === "PASS") return "PASS";

      // ── MLB TIER 1 OPTION B GUARD (stale-DB override) ──────────────────────────────────────────
      // PROBLEM: game.spreadEdge is written by the model runner at run time. If book odds move
      // after the last model run (e.g., LAD -1.5 was +115 when model ran → edge detected, written
      // to DB), the stale "LAD -1.5 [EDGE]" persists until the next model run even though the
      // current book odds (+139) no longer represent an edge vs model (+146).
      //
      // SOLUTION: When modelAwaySpreadOdds and modelHomeSpreadOdds are available (MLB only),
      // run Option B inline using the CURRENT book RL odds (awayRunLineOdds / homeRunLineOdds).
      // If BOTH sides show negative edge (model less confident than book on both sides),
      // override the DB label with PASS — the stale edge is definitively invalidated.
      //
      // OPTION B RULE: edge exists ONLY when modelImplied(side) > bookImplied(side) (raw vs raw).
      //   edgeAway = americanToImplied(mdlAwayOdds) - americanToImplied(bkAwayOdds)
      //   edgeHome = americanToImplied(mdlHomeOdds) - americanToImplied(bkHomeOdds)
      //   If max(edgeAway, edgeHome) <= 0 → NO EDGE → return PASS
      //
      // VALIDATION (TB@LAD June 16):
      //   bkAway=-168 mdlAway=-146: edgeAway = 59.35% - 62.69% = -3.34pp (no edge)
      //   bkHome=+139 mdlHome=+146: edgeHome = 40.65% - 41.84% = -1.19pp (no edge)
      //   max(-3.34, -1.19) = -1.19 <= 0 → PASS ✓  (overrides stale "LAD -1.5 [EDGE]")
      if (isMlbGame) {
        const _mdlAwayOddsStr = game.modelAwaySpreadOdds ?? null; // e.g. "-146" (from game.modelAwaySpreadOdds)
        const _mdlHomeOddsStr = game.modelHomeSpreadOdds ?? null; // e.g. "+146"
        const _bkAwayOddsStr = game.awayRunLineOdds ?? null; // e.g. "-168" (current book)
        const _bkHomeOddsStr = game.homeRunLineOdds ?? null; // e.g. "+139"
        if (
          _mdlAwayOddsStr &&
          _mdlHomeOddsStr &&
          _bkAwayOddsStr &&
          _bkHomeOddsStr
        ) {
          const _mdlAwayNum = parseFloat(_mdlAwayOddsStr);
          const _mdlHomeNum = parseFloat(_mdlHomeOddsStr);
          const _bkAwayNum = parseFloat(_bkAwayOddsStr);
          const _bkHomeNum = parseFloat(_bkHomeOddsStr);
          if (
            !isNaN(_mdlAwayNum) &&
            !isNaN(_mdlHomeNum) &&
            !isNaN(_bkAwayNum) &&
            !isNaN(_bkHomeNum)
          ) {
            const _mdlAwayImpl = americanToImplied(_mdlAwayNum);
            const _mdlHomeImpl = americanToImplied(_mdlHomeNum);
            const _bkAwayImpl = americanToImplied(_bkAwayNum);
            const _bkHomeImpl = americanToImplied(_bkHomeNum);
            const _edgeAway = _mdlAwayImpl - _bkAwayImpl;
            const _edgeHome = _mdlHomeImpl - _bkHomeImpl;
            const _bestEdge = Math.max(_edgeAway, _edgeHome);
            if (process.env.NODE_ENV === "development" || true) {
              console.log(
                `[computedSpreadEdge:MLB-Tier1] game=${game.id} ${game.awayTeam}@${game.homeTeam}` +
                  ` | [INPUT] mdlAway=${_mdlAwayNum} mdlHome=${_mdlHomeNum}` +
                  ` bkAway=${_bkAwayNum} bkHome=${_bkHomeNum}` +
                  ` | [STATE] mdlAwayImpl=${(_mdlAwayImpl * 100).toFixed(2)}% mdlHomeImpl=${(_mdlHomeImpl * 100).toFixed(2)}%` +
                  ` bkAwayImpl=${(_bkAwayImpl * 100).toFixed(2)}% bkHomeImpl=${(_bkHomeImpl * 100).toFixed(2)}%` +
                  ` | [OUTPUT] edgeAway=${(_edgeAway * 100).toFixed(2)}pp edgeHome=${(_edgeHome * 100).toFixed(2)}pp bestEdge=${(_bestEdge * 100).toFixed(2)}pp` +
                  ` | [VERIFY] bestEdge>0=${_bestEdge > 0} dbLabel="${game.spreadEdge}"` +
                  ` → ${_bestEdge <= 0 ? "OVERRIDING stale DB label → PASS" : "DB label confirmed valid"}`
              );
            }
            // AUTHORITATIVE: if Option B says no edge on either side, the DB label is stale → PASS
            if (_bestEdge <= 0) return "PASS";
            // Option B confirms edge exists — trust DB label for direction
          }
        }
      }
      // ── END MLB TIER 1 OPTION B GUARD ─────────────────────────────────────────────────────────

      return game.spreadEdge;
    }
    if (isNaN(spreadDiff) || spreadDiff <= 0) return "PASS";
    // For NHL and MLB: edge direction comes from game.spreadEdge (set by Python engine).
    // Line arithmetic is invalid since both model and book always have ±1.5 for run/puck lines.
    // The MLB engine writes spreadEdge as "AWAY +1.5 [EDGE]" or "HOME -1.5 [EDGE]" etc.
    if (isNhlGame || isMlbGame) return game.spreadEdge ?? null;
    if (isNaN(awayModelSpread) || isNaN(awayBookSpread)) return game.spreadEdge;
    if (awayModelSpread < awayBookSpread) {
      return `${awayDisplayName} ${spreadSign(awayBookSpread)}`;
    } else {
      return `${homeDisplayName} ${spreadSign(homeBookSpread)}`;
    }
  })();

  const computedTotalEdge: string | null = (() => {
    // [FIX] For NHL/MLB: totalDiff is null in DB (not written by Python engine for these sports).
    // The edge direction lives in game.totalEdge (DB label set by Python engine).
    // Do NOT gate on totalDiff <= 0 for NHL/MLB — it will always be null.
    if (isNhlGame || isMlbGame) {
      if (!game.totalEdge || game.totalEdge === "PASS") return "PASS";
      return game.totalEdge;
    }
    if (isNaN(totalDiff) || totalDiff <= 0) return "PASS";
    // For NHL and MLB: edge direction must come from model odds at the book's line, NOT from comparing
    // model expected total vs book line. The model could have E_total > book line but still have
    // P(over) < 50% due to distribution shape. Use game.totalEdge (set by Python/TS engine) for both.
    // MLB now writes totalEdge as "OVER {total} [EDGE]" or "UNDER {total} [EDGE]" from mlbModelRunner.
    if (isNhlGame || isMlbGame) return game.totalEdge ?? null;
    if (isNaN(modelTotal) || isNaN(bookTotal)) return game.totalEdge;
    return modelTotal > bookTotal ? `Over ${bookTotal}` : `Under ${bookTotal}`;
  })();

  // ── AUTHORITATIVE edge direction — computed ONCE, used by all 3 render paths ─
  // Replaces 3 divergent local computations (desktop IIFE, DesktopMergedPanel, mobile IIFE).
  // Uses edgeLabelIsAway() for NHL/MLB (abbrev-based); line arithmetic for NBA.
  // NOTE: awayAbbr / awayDisplayName are defined below in makeCityAbbr — forward-reference safe
  // because this block is inside the component body, evaluated after makeCityAbbr runs.
  // We defer to a lazy getter pattern: define as a function, call after awayAbbr is resolved.
  // ACTUAL ASSIGNMENT happens after awayAbbr is defined (see below).

  const awayConsensus =
    isNaN(awayBookSpread) && isNaN(bookTotal)
      ? "—"
      : awayBookSpread < 0
        ? spreadSign(awayBookSpread)
        : isNaN(bookTotal)
          ? "—"
          : `${bookTotal}`;
  const homeConsensus =
    isNaN(homeBookSpread) && isNaN(bookTotal)
      ? "—"
      : homeBookSpread < 0
        ? spreadSign(homeBookSpread)
        : isNaN(bookTotal)
          ? "—"
          : `${bookTotal}`;

  // ── Score Panel ─────────────────────────────────────────────────────────────
  // Compact score panel for splits mode — logo + name only, score pushed right
  // NBA: show team nickname; NHL/MLB: show city name
  const isNba = !!awayNba;
  const compactAwayLabel = isNba ? awayNickname || awayName : awayName;
  const compactHomeLabel = isNba ? homeNickname || homeName : homeName;

  // Mobile abbreviations: official abbreviation for frozen score panel.
  // Priority: NHL official abbrev → NBA official abbrev → MLB official abbrev → city-derived fallback
  // [INPUT] nhlEntry: NhlTeam | null, nbaEntry: NbaTeam | null, mlbEntry: MlbTeam | null, name: string
  // [OUTPUT] 2-3 char official abbreviation (e.g. "NYY", "LAL", "NSH") or city-derived fallback
  const makeCityAbbr = (
    nhlEntry: typeof awayNhl,
    nbaEntry: typeof awayNba,
    mlbEntry: typeof awayMlb,
    name: string
  ): string => {
    if (nhlEntry?.abbrev) return nhlEntry.abbrev; // NHL: official 3-letter abbrev (e.g. "NSH", "EDM", "TBL")
    if (nbaEntry?.abbrev) return nbaEntry.abbrev; // NBA: official 3-letter abbrev (e.g. "NYK", "LAL", "GSW", "OKC")
    if (mlbEntry?.abbrev) return mlbEntry.abbrev; // MLB: official 2-3 letter abbrev (e.g. "NYY", "LAD", "CWS", "STL")
    // Fallback: first word of city/school name, max 4 chars (should never reach here for MLB/NBA/NHL)
    const word = (name || "").split(/\s+/)[0] ?? name;
    return word.slice(0, 4).toUpperCase();
  };
  const awayAbbr = makeCityAbbr(awayNhl, awayNba, awayMlb, awayName);
  const homeAbbr = makeCityAbbr(homeNhl, homeNba, homeMlb, homeName);

  // ── AUTHORITATIVE edge direction — single source of truth for all render paths ──
  // Computed here (after awayAbbr is resolved) and passed to DesktopMergedPanel + mobile IIFE.
  // Eliminates the 3 divergent local computations that could disagree on the same render.
  //
  // [FIX 2026-06-24] MODELRUNAT GATE: When modelRunAt is null (model not yet run, or was
  // invalidated by RL INVALIDATE), BOTH edge direction flags MUST be null.
  // Without this gate, stale model odds fields (left over from a previous run before
  // invalidation) cause authSpreadEdgeIsAway/authTotalEdgeIsOver to be non-null while
  // hasModelData=false. This renders '—' dashes in the mint edge accent in MobileGameCard
  // and DesktopMergedPanel — a false edge signal on a game with no valid model output.
  // Root cause: RL INVALIDATE sets modelRunAt=null but leaves model odds fields populated
  // in the DB (they are nulled atomically in the same DB update, but a race condition
  // between the DB write and the frontend cache can expose a window where modelRunAt=null
  // but model odds are still non-null in the cached game object).
  // Fix: gate both flags on _hasModelRunAt so no edge color is ever applied without a
  // valid model run timestamp.
  const _hasModelRunAt = game.modelRunAt != null;
  const authSpreadEdgeIsAway: boolean | null = !_hasModelRunAt
    ? null
    : (() => {
        if (!computedSpreadEdge || computedSpreadEdge === "PASS") return null;
        if (isNhlGame || isMlbGame) {
          return edgeLabelIsAway(
            computedSpreadEdge,
            awayAbbr,
            awayDisplayName,
            game.sport ?? "NHL"
          );
        }
        // NBA: use line arithmetic (model spread vs book spread)
        if (!isNaN(awayModelSpread) && !isNaN(awayBookSpread))
          return awayModelSpread < awayBookSpread;
        return null;
      })();
  const authTotalEdgeIsOver: boolean | null = !_hasModelRunAt
    ? null
    : (() => {
        // [FIX] For NHL/MLB: totalDiff is null in DB. Skip the totalDiff guard and go directly to
        // Tier 1 (model odds comparison) then Tier 2 (DB label). The guard was blocking all NHL/MLB
        // total edges because totalDiff was always null/0 for these sports.
        if (!(isNhlGame || isMlbGame) && (isNaN(totalDiff) || totalDiff <= 0))
          return null;

        // ── TIER 1 (highest priority): Model over/under odds probability comparison ──────────────────
        // OPTION B RULE: edge exists ONLY when modelImplied(side) > bookImplied(side) — both RAW.
        // Compare raw model implied vs raw book implied on the SAME side (no vig removal on either).
        //
        // CORRECT examples:
        //   u7.5: model=-116 → mdlUnderImplied=53.70% vs book=-123 → bkUnderImplied=55.16%
        //     53.70% < 55.16% → model LESS confident in UNDER → NO EDGE ✓
        //   u7.5: model=-128 → mdlUnderImplied=56.14% vs book=-123 → bkUnderImplied=55.16%
        //     56.14% > 55.16% → model MORE confident in UNDER → UNDER EDGE ✓
        //
        // WRONG (old): comparing raw model implied vs book NO-VIG prob (apples to oranges)
        //   This inflated apparent model confidence and produced false edges.
        //
        // We check BOTH over and under independently:
        //   OVER edge:  mdlOverImplied  > bkOverImplied  → model more confident in OVER
        //   UNDER edge: mdlUnderImplied > bkUnderImplied → model more confident in UNDER
        //   If both or neither: fall through to Tier 2
        const _mdlOverOddsNum = toNum(game.modelOverOdds);
        const _mdlUnderOddsNum = toNum(game.modelUnderOdds);
        const _bkOverOddsNum = toNum(game.overOdds);
        const _bkUnderOddsNum = toNum(game.underOdds);
        if (!isNaN(_bkOverOddsNum) && !isNaN(_bkUnderOddsNum)) {
          const rawBkOver = americanToImplied(_bkOverOddsNum);
          const rawBkUnder = americanToImplied(_bkUnderOddsNum);
          // Check OVER side: model over odds available and model more confident in OVER
          const overEdge = !isNaN(_mdlOverOddsNum)
            ? americanToImplied(_mdlOverOddsNum) > rawBkOver
            : false;
          // Check UNDER side: model under odds available and model more confident in UNDER
          const underEdge = !isNaN(_mdlUnderOddsNum)
            ? americanToImplied(_mdlUnderOddsNum) > rawBkUnder
            : false;
          if (process.env.NODE_ENV === "development") {
            console.log(
              `[authTotalEdgeIsOver:Tier1] game=${game.id}` +
                ` mdlOver=${_mdlOverOddsNum} mdlUnder=${_mdlUnderOddsNum}` +
                ` bkOver=${_bkOverOddsNum} bkUnder=${_bkUnderOddsNum}` +
                ` | mdlOverImp=${isNaN(_mdlOverOddsNum) ? "N/A" : americanToImplied(_mdlOverOddsNum).toFixed(4)}` +
                ` bkOverImp=${rawBkOver.toFixed(4)}` +
                ` | mdlUnderImp=${isNaN(_mdlUnderOddsNum) ? "N/A" : americanToImplied(_mdlUnderOddsNum).toFixed(4)}` +
                ` bkUnderImp=${rawBkUnder.toFixed(4)}` +
                ` | overEdge=${overEdge} underEdge=${underEdge}`
            );
          }
          if (overEdge && !underEdge) return true; // OVER edge confirmed (Option B)
          if (underEdge && !overEdge) return false; // UNDER edge confirmed (Option B)
          // Neither side has an edge — return null IMMEDIATELY.
          // Tier 1 is AUTHORITATIVE when model odds are available.
          // Do NOT fall through to Tier 2: the DB label may be stale from a previous
          // run that used the old no-vig formula and produced a false edge.
          if (!overEdge && !underEdge) return null;
          // Both edges simultaneously (degenerate case for vig-bearing model) — fall through
        }

        // ── TIER 2: NHL/MLB — use computedTotalEdge from model engine (model odds at book's line) ───────
        // The Python engine already accounts for distribution shape, so trust its direction.
        // MLB now writes totalEdge as "OVER {total} [EDGE]" or "UNDER {total} [EDGE]" (same format as NHL).
        if (isNhlGame || isMlbGame) {
          if (!computedTotalEdge || computedTotalEdge === "PASS") return null;
          const normalized = computedTotalEdge.toUpperCase();
          if (normalized.startsWith("OVER")) return true;
          if (normalized.startsWith("UNDER")) return false;
          return null;
        }

        // ── TIER 3 (fallback): Line comparison for NBA/NCAAM without model odds ──────────────────────
        if (!isNaN(modelTotal) && !isNaN(bookTotal))
          return modelTotal > bookTotal;
        return null;
      })();

  const CompactScorePanel = () => (
    <div
      className="flex flex-col justify-center h-full px-2 py-3 gap-2"
      style={{ minWidth: 0 }}
    >
      {/* Status: [star] [clock] [LIVE] */}
      <div className="flex items-center gap-1 mb-1">
        {isAppAuthed && (
          <button
            type="button"
            onClick={handleStarClick}
            className="gc-star"
            data-favorited={isFavorited}
            aria-label={
              isFavorited ? "Remove from favorites" : "Add to favorites"
            }
            title={isFavorited ? "Remove from favorites" : "Add to favorites"}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "2px 3px",
              lineHeight: 1,
              flexShrink: 0,
              minWidth: 44,
              minHeight: 44,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: isFavorited
                ? "var(--dime-mint-text, #45E0A8)"
                : "var(--dime-text-muted, #FFFFFF)",
              opacity: 1,
              transition:
                "color 160ms cubic-bezier(0.16,1,0.3,1), transform 160ms cubic-bezier(0.16,1,0.3,1), filter 160ms cubic-bezier(0.16,1,0.3,1)",
              filter: "none",
            }}
            onMouseEnter={e => {
              e.currentTarget.style.transform = "scale(1.25)";
            }}
            onMouseLeave={e => {
              e.currentTarget.style.transform = "scale(1)";
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              style={{
                fill: isFavorited ? "var(--dime-mint, #45E0A8)" : "none",
                stroke: isFavorited
                  ? "var(--dime-mint, #45E0A8)"
                  : "currentColor",
              }}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </button>
        )}
        {isLive ? (
          <>
            {game.gameClock && (
              <span
                className="text-[10px] tabular-nums"
                style={{ color: "hsl(var(--muted-foreground))" }}
              >
                {game.gameClock}
              </span>
            )}
            <span
              className="gc-live flex items-center gap-0.5 text-[10px] font-black tracking-widest uppercase flex-shrink-0"
              style={{ color: "var(--dime-mint-text, #45E0A8)" }} // 2026-08-05 token law
            >
              <span
                className="rounded-full animate-pulse inline-block"
                style={{
                  width:
                    "7px" /* 2026-08-05: MASTER live-indicator spec (was w-1 = 4px) */,
                  height: "7px",
                  background: "var(--dime-mint, #45E0A8)",
                }}
              />
              LIVE
            </span>
          </>
        ) : isFinal ? (
          <span
            className="px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide"
            style={{
              background: "#000000",
              color: "hsl(var(--muted-foreground))",
            }}
          >
            FINAL
          </span>
        ) : (
          <span
            className="text-[10px] font-bold"
            style={{ color: "hsl(var(--muted-foreground))" }}
          >
            {time}
          </span>
        )}
      </div>
      {/* Away row */}
      <div className="flex items-center justify-between gap-1.5 w-full">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <TeamLogo
            slug={game.awayTeam}
            name={awayName}
            logoUrl={awayLogoUrl}
            size={32}
          />
          <span
            className="font-bold"
            style={{
              fontSize: 11,
              color: awayWins
                ? "hsl(var(--foreground))"
                : isFinal
                  ? "hsl(var(--muted-foreground))"
                  : "hsl(var(--foreground))",
              fontWeight: awayWins ? 800 : 600,
              whiteSpace: "nowrap",
              letterSpacing: "0.05em",
            }}
          >
            {awayAbbr}
          </span>
        </div>
        {(isLive || isFinal) && hasScores && (
          // winner=750, loser=600; font-black removed
          <span
            className="tabular-nums flex-shrink-0"
            style={{
              fontSize: 20,
              lineHeight: 1,
              fontWeight: awayWins ? 750 : isFinal || isLive ? 600 : 900,
              color: awayWins
                ? "hsl(var(--foreground))"
                : isFinal || isLive
                  ? "hsl(var(--muted-foreground))"
                  : "hsl(var(--foreground))",
            }}
          >
            {game.awayScore}
          </span>
        )}
      </div>
      <div style={{ height: 1, background: "hsl(var(--border) / 0.4)" }} />
      {/* Home row */}
      <div className="flex items-center justify-between gap-1.5 w-full">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <TeamLogo
            slug={game.homeTeam}
            name={homeName}
            logoUrl={homeLogoUrl}
            size={32}
          />
          <span
            className="font-bold"
            style={{
              fontSize: 11,
              color: homeWins
                ? "hsl(var(--foreground))"
                : isFinal
                  ? "hsl(var(--muted-foreground))"
                  : "hsl(var(--foreground))",
              fontWeight: homeWins ? 800 : 600,
              whiteSpace: "nowrap",
              letterSpacing: "0.05em",
            }}
          >
            {homeAbbr}
          </span>
        </div>
        {(isLive || isFinal) && hasScores && (
          // winner=750, loser=600; font-black removed
          <span
            className="tabular-nums flex-shrink-0"
            style={{
              fontSize: 20,
              lineHeight: 1,
              fontWeight: homeWins ? 750 : isFinal || isLive ? 600 : 900,
              color: homeWins
                ? "hsl(var(--foreground))"
                : isFinal || isLive
                  ? "hsl(var(--muted-foreground))"
                  : "hsl(var(--foreground))",
            }}
          >
            {game.homeScore}
          </span>
        )}
      </div>
    </div>
  );

  // Shows: game clock/status at top, then two team rows (logo + name + score)
  // Score sits immediately after the team name, not pushed to the far right.
  // For upcoming games: shows start time instead of scores.
  function ScorePanel() {
    // Uniform font sizes — same for every team, scale with viewport width only
    // No per-name auto-scaling; no truncation
    // Change F: FINAL loser → fontWeight 400 (unbold city, team name, score); winner stays 700
    const awayFontWeight = awayWins ? 700 : isFinal && isDesktop ? 400 : 600;
    const homeFontWeight = homeWins ? 700 : isFinal && isDesktop ? 400 : 600;
    // School name: clamp(12px, 1.0vw, 17px) — reduced by 1pt (was clamp(13px,1.1vw,18px)) — Change E
    const NAME_FONT_SIZE = isDesktop
      ? "clamp(12px, 1.0vw, 17px)"
      : "clamp(13px, 1.1vw, 18px)";
    // Nickname: clamp(10px, 0.8vw, 14px) — reduced by 1pt (was clamp(11px,0.9vw,15px)) — Change E
    const NICK_FONT_SIZE = isDesktop
      ? "clamp(10px, 0.8vw, 14px)"
      : "clamp(11px, 0.9vw, 15px)";
    // Desktop-specific sizes: 1.5× the NAME_FONT_SIZE (clamp(13px,1.1vw,18px))
    // → clamp(19.5px, 1.65vw, 27px) for star/clock/LIVE/FINAL/time
    // ── DESKTOP UI CHANGES ──────────────────────────────────────────────────────
    // Change A: LIVE badge 3× bigger on desktop (was clamp(10.5px,0.83vw,13.5px) → ×3)
    // Change B: inning/period/clock 2× bigger on desktop (was clamp(12px,1.01vw,15px) → ×2)
    // Change C: FINAL badge 3× bigger on desktop (was clamp(12px,1.01vw,15px) → ×3)
    // Change D: star SVG 2× bigger on desktop (was 18px → 36px)
    // Change E: city/team NAME_FONT_SIZE reduced by 1pt: clamp(13px,1.1vw,18px) → clamp(12px,1.0vw,17px)
    //           NICK_FONT_SIZE reduced by 1pt: clamp(11px,0.9vw,15px) → clamp(10px,0.8vw,14px)
    // Star: 24px × 0.75 = 18px (−25% more, total −50% from original 36px)
    const HEADER_ICON_SIZE = isDesktop ? 18 : isMdUp ? 16 : 12;
    // 768–1023 (tablet md layout): full readable sizes — the sub-10px values are
    // phone-only and violate the no-tiny-text law on tablets.
    const CLOCK_FONT_SIZE = isDesktop
      ? "clamp(12px, 1.01vw, 15px)"
      : isMdUp
        ? "12px"
        : "10px";
    const LIVE_FONT_SIZE = isDesktop
      ? "clamp(13.3px, 1.05vw, 17.1px)"
      : isMdUp
        ? "12px"
        : "10px";
    const FINAL_FONT_SIZE = isDesktop
      ? "clamp(15.2px, 1.28vw, 19px)"
      : isMdUp
        ? "13px"
        : "11px";
    const TIME_FONT_SIZE = isDesktop
      ? "clamp(12px, 1.01vw, 15px)"
      : isMdUp
        ? "12px"
        : "10px";
    // Desktop: teams pushed toward top (justify-start + small paddingTop)
    // Mobile: teams vertically centered (justify-center)
    const teamGroupJustify = "center";
    const teamGroupPaddingTop = "0px";
    return (
      <div
        className="flex flex-col pl-2 pr-2 pt-0 pb-0"
        style={{ minHeight: "100%", justifyContent: "center" }}
      >
        {/* Status row: [star] [clock/status] [LIVE badge]
          This row acts as the header spacer to align away/home rows with OddsTable.
          The OddsLinesPanel header (SPREAD/TOTAL/MONEYLINE + BOOK/MODEL rows) takes
          roughly the same height, so we use flex-grow on the team rows to fill space. */}
        {/* Status row: left-aligned on both desktop and mobile */}
        <div className="flex items-center gap-1.5 mb-0.5">
          {/* Star / Favorite button — always left of status */}
          {isAppAuthed && (
            <button
              type="button"
              onClick={handleStarClick}
              className="gc-star"
              data-favorited={isFavorited}
              aria-label={
                isFavorited ? "Remove from favorites" : "Add to favorites"
              }
              title={isFavorited ? "Remove from favorites" : "Add to favorites"}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: isDesktop ? "3px 4px" : "3px 4px",
                lineHeight: 1,
                flexShrink: 0,
                /* [LAYOUT FIX] Mobile star: 32px (was 44px) — frees 12px for team row */
                minWidth: isDesktop ? 36 : 32,
                minHeight: isDesktop ? 36 : 32,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: isFavorited
                  ? "var(--dime-mint-text, #45E0A8)"
                  : "var(--dime-text-muted, #FFFFFF)",
                opacity: 1,
                transition:
                  "color 160ms cubic-bezier(0.16,1,0.3,1), transform 160ms cubic-bezier(0.16,1,0.3,1), filter 160ms cubic-bezier(0.16,1,0.3,1)",
                // Change D: larger glow to match 2× star size on desktop
                filter: "none",
              }}
              onMouseEnter={e => {
                e.currentTarget.style.transform = "scale(1.25)";
                if (!isFavorited)
                  e.currentTarget.style.color =
                    "var(--dime-text-secondary, #FFFFFF)";
              }}
              onMouseLeave={e => {
                e.currentTarget.style.transform = "scale(1)";
                if (!isFavorited)
                  e.currentTarget.style.color =
                    "var(--dime-text-muted, #FFFFFF)";
              }}
            >
              {/* Desktop: 24px star (1.5× mobile 16px) */}
              <svg
                width={HEADER_ICON_SIZE}
                height={HEADER_ICON_SIZE}
                viewBox="0 0 24 24"
                style={{
                  fill: isFavorited ? "var(--dime-mint, #45E0A8)" : "none",
                  stroke: isFavorited
                    ? "var(--dime-mint, #45E0A8)"
                    : "currentColor",
                }}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
            </button>
          )}
          {/* Game status: time / FINAL / clock */}
          {isLive ? (
            // LIVE: badge stacked ABOVE inning/clock on desktop (Change A+B)
            // Mobile: inline row (unchanged)
            isDesktop ? (
              <div className="flex flex-col items-center gap-0.5">
                {/* LIVE pill — desktop: scaled down (−44% from original) */}
                <span
                  className="px-2 py-1 font-black tracking-widest flex-shrink-0 flex items-center"
                  style={{
                    fontSize: LIVE_FONT_SIZE,
                    background: "var(--dime-mint-dim, transparent)",
                    color: "var(--dime-mint-text, #45E0A8)",
                    border: "1px solid var(--dime-mint-border, #45E0A8)",
                    letterSpacing: "0.10em",
                    borderRadius: "14px",
                    gap: "8px",
                    lineHeight: 1,
                  }}
                >
                  <span
                    className="rounded-full animate-pulse inline-block flex-shrink-0"
                    style={{
                      width: "9px",
                      height: "9px",
                      background: "var(--dime-mint, #45E0A8)",
                    }}
                  />
                  LIVE
                </span>
                {/* Inning/clock is now rendered ABOVE the away team row on desktop — not here */}
              </div>
            ) : (
              <>
                <span
                  className="px-1.5 py-0.5 font-bold tracking-wide flex-shrink-0 flex items-center"
                  style={{
                    fontSize: LIVE_FONT_SIZE,
                    background: "var(--dime-mint-dim, transparent)",
                    color: "var(--dime-mint-text, #45E0A8)",
                    border: "1px solid var(--dime-mint-border, #45E0A8)",
                    letterSpacing: "0.08em",
                    borderRadius: "12px",
                    gap: "8px",
                  }}
                >
                  <span
                    className="rounded-full animate-pulse inline-block flex-shrink-0"
                    style={{
                      width:
                        "7px" /* 2026-08-05: MASTER live-indicator spec (was 5px) */,
                      height: "7px",
                      background: "var(--dime-mint, #45E0A8)",
                    }}
                  />
                  LIVE
                </span>
                {game.gameClock && (
                  <span
                    className="font-semibold tabular-nums"
                    style={{
                      fontSize: CLOCK_FONT_SIZE,
                      color: "hsl(var(--muted-foreground))",
                    }}
                  >
                    {game.gameClock}
                  </span>
                )}
              </>
            )
          ) : isFinal ? (
            // FINAL: 3× bigger on desktop, unchanged on mobile (Change C)
            // No inning shown for FINAL games (game is over)
            <span
              className="px-1.5 py-0.5 font-black tracking-widest"
              style={{
                fontSize: FINAL_FONT_SIZE,
                background: "var(--dime-surface-raised, #000000)",
                color: "var(--dime-text-secondary, #FFFFFF)",
                border: isDesktop
                  ? "1px solid var(--dime-border-strong, #FFFFFF)"
                  : "none",
                borderRadius: "12px",
                lineHeight: 1,
              }}
            >
              FINAL
            </span>
          ) : (
            /* Desktop: clamp(16px,1.35vw,20px) — 1.5× mobile 13px */
            <span
              className="font-bold"
              style={{
                fontSize: TIME_FONT_SIZE,
                color: "hsl(var(--foreground))",
              }}
            >
              {time}
            </span>
          )}
        </div>

        {/* Team group — desktop: pushed toward top; mobile: vertically centered */}
        <div
          className="flex flex-1 flex-col"
          style={{
            gap: 0,
            justifyContent: teamGroupJustify,
            paddingTop: teamGroupPaddingTop,
          }}
        >
          {/* Desktop-only: inning/clock status above away team row, left-aligned, unbolded */}
          {isLive && isDesktop && game.gameClock && (
            <div className="hidden lg:block" style={{ marginBottom: 2 }}>
              <span
                style={{
                  fontSize: CLOCK_FONT_SIZE,
                  fontWeight: 400,
                  color: "hsl(var(--muted-foreground))",
                  letterSpacing: "0.04em",
                  lineHeight: 1,
                }}
              >
                {game.gameClock}
              </span>
            </div>
          )}
          {/* Away team row */}
          {/* [LAYOUT FIX] Away row: gap reduced to 4px; left side flex:1 1 0% + minWidth:0 prevents abbrev overflow */}
          <div
            className="flex items-center justify-between py-1 w-full"
            style={{ gap: 4 }}
          >
            {/* Left: logo + name — flex:1 1 0% + minWidth:0 = bulletproof containment */}
            <div
              className="flex items-center"
              style={{
                gap: 6,
                flex: "1 1 0%",
                minWidth: 0,
                overflow: "hidden",
              }}
            >
              {/* Change G: greyscale away logo when away team lost and game is FINAL on desktop */}
              {/* [LAYOUT FIX] Mobile logo: 28px (was 36px) — frees 8px for abbrev+score */}
              <TeamLogo
                slug={game.awayTeam}
                name={awayName}
                logoUrl={awayLogoUrl}
                size={isDesktop ? 36 : 28}
                greyscale={isFinal && isDesktop && !awayWins}
              />
              {/* Responsive name display:
               Mobile (< 1024px): abbreviation only (e.g. "GSW", "NYY") — never truncates
               Desktop (≥ 1024px): city name + nickname on two lines */}
              <div className="flex flex-col">
                {/* Mobile: abbreviation only */}
                <span
                  className="font-bold leading-tight lg:hidden"
                  style={{
                    fontSize: "clamp(11px, 3.5vw, 14px)",
                    color: awayWins
                      ? "hsl(var(--foreground))"
                      : isFinal
                        ? "hsl(var(--muted-foreground))"
                        : "hsl(var(--foreground))",
                    fontWeight: awayFontWeight,
                    whiteSpace: "nowrap",
                    letterSpacing: "0.06em",
                    lineHeight: 1.2,
                  }}
                >
                  {awayAbbr}
                </span>
                {/* Desktop: city name */}
                <span
                  className="font-semibold leading-tight hidden lg:block"
                  style={{
                    fontSize: NAME_FONT_SIZE,
                    color: awayWins
                      ? "hsl(var(--foreground))"
                      : isFinal
                        ? "hsl(var(--muted-foreground))"
                        : "hsl(var(--foreground))",
                    fontWeight: awayFontWeight,
                    whiteSpace: "nowrap",
                    lineHeight: 1.15,
                  }}
                >
                  {awayName}
                </span>
                {/* Nickname line 2 — desktop only */}
                <span
                  className="leading-none hidden lg:block"
                  style={{
                    fontSize: NICK_FONT_SIZE,
                    color: "hsl(var(--muted-foreground))",
                    whiteSpace: "nowrap",
                  }}
                >
                  {awayNickname || "\u00A0"}
                </span>
              </div>
            </div>
            {/* Right: score pushed to far right */}
            {(isLive || isFinal) && hasScores && (
              <span
                className="tabular-nums flex-shrink-0 transition-colors duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
                style={{
                  /* [LAYOUT FIX] Score font:
                 Mobile MLB: clamp(13px,3.8vw,19px) — 13px min ensures 13+ px margin at all mobile viewports
                 Mobile NBA: clamp(12px,3.5vw,17px) — smaller for 3-digit scores
                 Desktop: unchanged (wider panels, no overflow risk) */
                  fontSize: isNba
                    ? isDesktop
                      ? "clamp(18px, 2vw, 38px)"
                      : "clamp(12px, 3.5vw, 17px)"
                    : isDesktop
                      ? "clamp(22px, 2.5vw, 44px)"
                      : "clamp(13px, 3.8vw, 19px)",
                  lineHeight: 1,
                  minWidth: "2ch",
                  textAlign: "right",
                  /* Change F: FINAL loser score → fontWeight 400 on desktop; winner stays 700 */
                  fontWeight: awayScoreFlash
                    ? 900
                    : awayWins
                      ? 700
                      : isFinal && isDesktop
                        ? 400
                        : isFinal || isLive
                          ? 600
                          : 900,
                  color: awayScoreFlash
                    ? "var(--dime-mint-text, #45E0A8)" // 2026-08-05 token law
                    : awayWins
                      ? "hsl(var(--foreground))"
                      : isFinal || isLive
                        ? "hsl(var(--muted-foreground))"
                        : "hsl(var(--foreground))",
                  textShadow: "none",
                }}
              >
                {game.awayScore}
              </span>
            )}
          </div>

          {/* Divider — mirrors OddsLinesPanel divider */}
          <div style={{ height: 1, background: "hsl(var(--border) / 0.4)" }} />

          {/* Home team row */}
          <div className="flex items-center justify-between gap-2 py-1 w-full">
            {/* Left: logo + name/nickname — always two lines */}
            <div className="flex items-center gap-2">
              {/* Change G: greyscale home logo when home team lost and game is FINAL on desktop */}
              {/* [LAYOUT FIX] Mobile logo: 28px (was 36px) — frees 8px for abbrev+score */}
              <TeamLogo
                slug={game.homeTeam}
                name={homeName}
                logoUrl={homeLogoUrl}
                size={isDesktop ? 36 : 28}
                greyscale={isFinal && isDesktop && !homeWins}
              />
              {/* Responsive name display:
               Mobile (< 1024px): abbreviation only (e.g. "GSW", "NYY") — never truncates
               Desktop (≥ 1024px): city name + nickname on two lines */}
              <div className="flex flex-col">
                {/* Mobile: abbreviation only */}
                <span
                  className="font-bold leading-tight lg:hidden"
                  style={{
                    fontSize: "clamp(11px, 3.5vw, 14px)",
                    color: homeWins
                      ? "hsl(var(--foreground))"
                      : isFinal
                        ? "hsl(var(--muted-foreground))"
                        : "hsl(var(--foreground))",
                    fontWeight: homeFontWeight,
                    whiteSpace: "nowrap",
                    letterSpacing: "0.06em",
                    lineHeight: 1.2,
                  }}
                >
                  {homeAbbr}
                </span>
                {/* Desktop: city name */}
                <span
                  className="font-semibold leading-tight hidden lg:block"
                  style={{
                    fontSize: NAME_FONT_SIZE,
                    color: homeWins
                      ? "hsl(var(--foreground))"
                      : isFinal
                        ? "hsl(var(--muted-foreground))"
                        : "hsl(var(--foreground))",
                    fontWeight: homeFontWeight,
                    whiteSpace: "nowrap",
                    lineHeight: 1.15,
                  }}
                >
                  {homeName}
                </span>
                {/* Nickname line 2 — desktop only */}
                <span
                  className="leading-none hidden lg:block"
                  style={{
                    fontSize: NICK_FONT_SIZE,
                    color: "hsl(var(--muted-foreground))",
                    whiteSpace: "nowrap",
                  }}
                >
                  {homeNickname || "\u00A0"}
                </span>
              </div>
            </div>
            {/* Right: score pushed to far right */}
            {(isLive || isFinal) && hasScores && (
              <span
                className="tabular-nums flex-shrink-0 transition-colors duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
                style={{
                  /* [LAYOUT FIX] Home score: same font fix as away score */
                  fontSize: isNba
                    ? isDesktop
                      ? "clamp(18px, 2vw, 38px)"
                      : "clamp(12px, 3.5vw, 17px)"
                    : isDesktop
                      ? "clamp(22px, 2.5vw, 44px)"
                      : "clamp(13px, 3.8vw, 19px)",
                  lineHeight: 1,
                  minWidth: "2ch",
                  textAlign: "right",
                  /* Change F: FINAL loser score → fontWeight 400 on desktop; winner stays 700 */
                  fontWeight: homeScoreFlash
                    ? 900
                    : homeWins
                      ? 700
                      : isFinal && isDesktop
                        ? 400
                        : isFinal || isLive
                          ? 600
                          : 900,
                  color: homeScoreFlash
                    ? "var(--dime-mint-text, #45E0A8)" // 2026-08-05 token law
                    : homeWins
                      ? "hsl(var(--foreground))"
                      : isFinal || isLive
                        ? "hsl(var(--muted-foreground))"
                        : "hsl(var(--foreground))",
                  textShadow: "none",
                }}
              >
                {game.homeScore}
              </span>
            )}
          </div>

          {/* MLB-specific metadata: venue, broadcaster, starting pitchers */}
          {isMlbGame && isUpcoming && (
            <div
              className="flex flex-col gap-0.5 px-2 pb-1.5"
              style={{ marginTop: 2 }}
            >
              {/* Venue + broadcaster on one line */}
              {(game.venue || game.broadcaster) && (
                <div className="flex items-center gap-1 flex-wrap">
                  {game.venue && (
                    <span
                      style={{
                        fontSize: "clamp(11px,0.85vw,13px)",
                        color:
                          "var(--dime-text-secondary, hsl(var(--muted-foreground)))",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {game.venue}
                    </span>
                  )}
                  {game.venue && game.broadcaster && (
                    <span
                      style={{
                        fontSize: "clamp(10px, 0.75vw, 12px)",
                        color: "var(--dime-text-muted, hsl(var(--border)))",
                      }}
                    >
                      ·
                    </span>
                  )}
                  {game.broadcaster && (
                    <span
                      style={{
                        fontSize: "clamp(11px, 0.85vw, 13px)",
                        color: "var(--dime-text-body, #FFFFFF)",
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {game.broadcaster}
                    </span>
                  )}
                  {(game.doubleHeader === "Y" || game.doubleHeader === "S") && (
                    <span
                      style={{
                        fontSize: "clamp(10px, 0.75vw, 12px)",
                        color: "var(--dime-text-secondary, #FFFFFF)",
                        fontWeight: 700,
                        whiteSpace: "nowrap",
                        marginLeft: 2,
                      }}
                    >
                      DH-{game.doubleHeader === "Y" ? "1" : "2"}
                    </span>
                  )}
                </div>
              )}
              {/* Starting pitchers */}
              {(game.awayStartingPitcher || game.homeStartingPitcher) && (
                <div className="flex items-center gap-1 flex-wrap">
                  <span
                    style={{
                      fontSize: "clamp(10px, 0.8vw, 12px)",
                      color:
                        "var(--dime-text-secondary, hsl(var(--muted-foreground)))",
                      whiteSpace: "nowrap",
                    }}
                  >
                    SP:
                  </span>
                  {game.awayStartingPitcher && (
                    <span
                      style={{
                        fontSize: "clamp(10px, 0.8vw, 12px)",
                        color: "var(--dime-text-body, #FFFFFF)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {game.awayStartingPitcher}
                      {!game.awayPitcherConfirmed ? " *" : ""}
                    </span>
                  )}
                  {game.awayStartingPitcher && game.homeStartingPitcher && (
                    <span
                      style={{
                        fontSize: "clamp(10px, 0.8vw, 12px)",
                        color:
                          "var(--dime-text-secondary, hsl(var(--muted-foreground)))",
                        whiteSpace: "nowrap",
                      }}
                    >
                      vs
                    </span>
                  )}
                  {game.homeStartingPitcher && (
                    <span
                      style={{
                        fontSize: "clamp(10px, 0.8vw, 12px)",
                        color: "var(--dime-text-body, #FFFFFF)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {game.homeStartingPitcher}
                      {!game.homePitcherConfirmed ? " *" : ""}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        {/* end team group wrapper */}
      </div>
    );
  }

  // OddsLinesPanel is now a top-level component (defined above GameCard)
  // to prevent infinite re-render loops from component identity changes.

  return (
    <LazyMotion features={domAnimation}>
      <MotionConfig reducedMotion="user">
        <m.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          className="w-full relative"
          ref={cardRef}
          // Inert hook: mobile CSS (dime-mobile.css) maps edge tiers to the
          // brand's mint/grey signal scale. Desktop rendering is untouched.
          data-edge-tier={maxDiff >= EDGE_THRESHOLD_PP ? "signal" : "none"}
          style={{
            background: "hsl(var(--card))",
            borderTop: "1px solid hsl(var(--border))",
            borderBottom: "1px solid hsl(var(--border))",
            borderLeft: `3px solid ${borderColor}`,
            overflowX: "clip",
          }}
        >
          {/*
          DESKTOP (≥ lg): single horizontal 3-column row
            Score panel | Odds/Lines | Betting Splits
          MOBILE (< lg): 2-row layout
            Row 1: Score panel (full width)
            Row 2: Odds/Lines (left ~45%) | Betting Splits (right ~55%)
        */}

          {/* ── Desktop layout ── */}
          {/* MIN-HEIGHT: ensures a consistent baseline card height while allowing taller content (e.g. OPEN sub-rows) to expand naturally without clipping */}
          {/* ── Desktop + Tablet layout (≥ md / 768px) ── */}
          <div
            className="hidden md:flex items-stretch w-full"
            style={{ minHeight: "clamp(160px,14vw,220px)" }}
          >
            {/* Col 1: Score panel — fixed width so all SPREAD/TOTAL/ML/EDGE borders align at same horizontal position.
              Splits mode: a fixed matchup rail. The old "1 1 30%" grew to ~65%
              of the row and crushed the three market columns into overlap. */}
            <div
              style={{
                flex:
                  mode === "splits"
                    ? "0 0 clamp(205px,18vw,320px)"
                    : "0 0 clamp(170px,22vw,260px)",
                width:
                  mode === "splits"
                    ? "clamp(205px,18vw,320px)"
                    : "clamp(170px,22vw,260px)",
                borderRight: "1px solid hsl(var(--border) / 0.5)",
              }}
            >
              <ScorePanel />
            </div>

            {/* Col 2+3: Merged panel (full + projections modes) — BOOK → splits → MODEL per section + EdgeVerdict */}
            {(mode === "projections" || mode === "full") && (
              <div
                className="flex-1 min-w-0"
                style={{ borderLeft: "1px solid hsl(var(--border) / 0.5)" }}
              >
                <DesktopMergedPanel
                  awayBookSpread={awayBookSpread}
                  homeBookSpread={homeBookSpread}
                  bookTotal={bookTotal}
                  awayML={game.awayML ?? "—"}
                  homeML={game.homeML ?? "—"}
                  awayModelSpread={awayModelSpread}
                  homeModelSpread={homeModelSpread}
                  modelTotal={modelTotal}
                  modelAwayML={game.modelAwayML}
                  modelHomeML={game.modelHomeML}
                  spreadDiff={spreadDiff}
                  totalDiff={totalDiff}
                  computedSpreadEdge={computedSpreadEdge}
                  computedTotalEdge={computedTotalEdge}
                  awayLogoUrl={awayLogoUrl}
                  homeLogoUrl={homeLogoUrl}
                  awaySlug={game.awayTeam}
                  homeSlug={game.homeTeam}
                  awayDisplayName={awayDisplayName}
                  homeDisplayName={homeDisplayName}
                  showModel={showModel}
                  onToggleModel={toggleModel}
                  authSpreadEdgeIsAway={authSpreadEdgeIsAway}
                  authTotalEdgeIsOver={authTotalEdgeIsOver}
                  game={game}
                />
              </div>
            )}

            {/* Col 2: Odds/Lines — non-projections, non-full modes (splits mode uses its own layout below) */}
            {mode !== "projections" && mode !== "full" && mode !== "splits" && (
              <div
                className="flex flex-col justify-center"
                style={{
                  flex: "1.5 1 28%",
                  minWidth: 190,
                  borderRight: "1px solid hsl(var(--border) / 0.5)",
                }}
              >
                <OddsLinesPanel
                  awayBookSpread={awayBookSpread}
                  homeBookSpread={homeBookSpread}
                  bookTotal={bookTotal}
                  awayML={game.awayML ?? "—"}
                  homeML={game.homeML ?? "—"}
                  awaySpreadOdds={game.awaySpreadOdds ?? null}
                  homeSpreadOdds={game.homeSpreadOdds ?? null}
                  overOdds={game.overOdds ?? null}
                  underOdds={game.underOdds ?? null}
                  openAwaySpreadStr={openAwaySpreadStr}
                  openHomeSpreadStr={openHomeSpreadStr}
                  openOverStr={openOverStr}
                  openUnderStr={openUnderStr}
                  openAwayMlStr={openAwayMlStr}
                  openHomeMlStr={openHomeMlStr}
                  displayAwaySpread={displayAwaySpread}
                  displayHomeSpread={displayHomeSpread}
                  displayOver={displayOver}
                  displayUnder={displayUnder}
                  displayAwayML={displayAwayML}
                  displayHomeML={displayHomeML}
                  awayModelSpread={awayModelSpread}
                  homeModelSpread={homeModelSpread}
                  modelTotal={modelTotal}
                  modelAwayML={game.modelAwayML}
                  modelHomeML={game.modelHomeML}
                  spreadDiff={spreadDiff}
                  totalDiff={totalDiff}
                  computedSpreadEdge={computedSpreadEdge}
                  computedTotalEdge={computedTotalEdge}
                  awayLogoUrl={awayLogoUrl}
                  homeLogoUrl={homeLogoUrl}
                  awaySlug={game.awayTeam}
                  homeSlug={game.homeTeam}
                  awayDisplayName={awayDisplayName}
                  homeDisplayName={homeDisplayName}
                  showModel={showModel}
                  onToggleModel={toggleModel}
                  sport={game.sport}
                  modelAwayPLOdds={game.modelAwayPLOdds}
                  modelHomePLOdds={game.modelHomePLOdds}
                  modelOverOdds={game.modelOverOdds}
                  modelUnderOdds={game.modelUnderOdds}
                  modelAwaySpreadOdds={game.modelAwaySpreadOdds ?? null}
                  modelHomeSpreadOdds={game.modelHomeSpreadOdds ?? null}
                  awayRunLine={
                    (game as unknown as Record<string, string | null>)
                      .awayRunLine ?? null
                  }
                  homeRunLine={
                    (game as unknown as Record<string, string | null>)
                      .homeRunLine ?? null
                  }
                  authSpreadEdgeIsAway={authSpreadEdgeIsAway}
                  authTotalEdgeIsOver={authTotalEdgeIsOver}
                  isModeled={game.modelRunAt != null}
                />
              </div>
            )}

            {/* Col 3: Betting Splits — non-projections, non-full, non-splits modes */}
            {mode !== "projections" && mode !== "full" && mode !== "splits" && (
              <div
                className="flex flex-col"
                style={{
                  flex: "2 1 40%",
                  minWidth: 220,
                  borderLeft: "1px solid hsl(var(--border) / 0.5)",
                }}
              >
                <div className="px-3 py-2">
                  <BettingSplitsPanel
                    gameId={game.id}
                    enabled={isCardVisible}
                    game={game}
                    awayLabel={awayName}
                    homeLabel={homeName}
                    awayAbbr={awayAbbr}
                    homeAbbr={homeAbbr}
                    awayNickname={awayNickname}
                    homeNickname={homeNickname}
                    onMarketChange={setActiveMarket}
                  />
                </div>
              </div>
            )}
            {mode === "splits" && (
              <div className="flex-1 min-w-0 px-3 py-3">
                <BettingSplitsPanel
                  gameId={game.id}
                  game={game}
                  awayLabel={awayName}
                  homeLabel={homeName}
                  awayAbbr={awayAbbr}
                  homeAbbr={homeAbbr}
                  awayNickname={awayNickname}
                  homeNickname={homeNickname}
                  onMarketChange={setActiveMarket}
                />
              </div>
            )}
          </div>

          {/* ── Mobile layout ── */}
          {/*
          KEY DESIGN: The score panel is NOT inside the scroll container.
          Instead, the card uses a CSS Grid with two columns:
            - Left column: fixed-width score panel (never scrolls)
            - Right column: overflow-x:auto scroll container (Odds/Lines + Splits)
          This completely eliminates the z-index bleed issue because the score
          panel and the scroll container are siblings, not parent/child.
        */}
          {/* ── Mobile layout (< md / 768px) ── */}
          <div className="md:hidden w-full">
            {/* Projections mode */}
            {mode === "projections" && (
              <div className="flex flex-col w-full">
                {/* Grid row: fixed score column | scrollable odds column */}
                {/* Score panel: clamp(140px,38%,180px) — Fix #7: responsive frozen panel */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "clamp(140px, 38%, 180px) 1fr",
                    width: "100%",
                  }}
                >
                  {/* Fixed score panel — NOT inside scroll container */}
                  <div
                    style={{
                      gridColumn: "1",
                      borderRight: "1px solid hsl(var(--border) / 0.5)",
                      background: "hsl(var(--card))",
                      zIndex: 1,
                    }}
                  >
                    <ScorePanel />
                  </div>
                  {/* Scroll container — only the right column scrolls */}
                  <div
                    style={{
                      gridColumn: "2",
                      overflowX: "auto",
                      overflowY: "hidden",
                    }}
                    className="flex flex-col justify-center"
                  >
                    {/* minWidth = calc(100vw - clamp(140px,38%,180px)): must match the frozen score column width exactly */}
                    {/* Using 38vw as the vw-equivalent of 38% (mobile cards are ~full-width) to ensure scroll fills correctly */}
                    <div
                      style={{
                        minWidth: "calc(100vw - clamp(140px, 38vw, 180px))",
                      }}
                      className="flex flex-col justify-center"
                    >
                      <OddsLinesPanel
                        awayBookSpread={awayBookSpread}
                        homeBookSpread={homeBookSpread}
                        bookTotal={bookTotal}
                        awayML={game.awayML ?? "—"}
                        homeML={game.homeML ?? "—"}
                        awaySpreadOdds={game.awaySpreadOdds ?? null}
                        homeSpreadOdds={game.homeSpreadOdds ?? null}
                        overOdds={game.overOdds ?? null}
                        underOdds={game.underOdds ?? null}
                        openAwaySpreadStr={openAwaySpreadStr}
                        openHomeSpreadStr={openHomeSpreadStr}
                        openOverStr={openOverStr}
                        openUnderStr={openUnderStr}
                        openAwayMlStr={openAwayMlStr}
                        openHomeMlStr={openHomeMlStr}
                        displayAwaySpread={displayAwaySpread}
                        displayHomeSpread={displayHomeSpread}
                        displayOver={displayOver}
                        displayUnder={displayUnder}
                        displayAwayML={displayAwayML}
                        displayHomeML={displayHomeML}
                        awayModelSpread={awayModelSpread}
                        homeModelSpread={homeModelSpread}
                        modelTotal={modelTotal}
                        modelAwayML={game.modelAwayML}
                        modelHomeML={game.modelHomeML}
                        spreadDiff={spreadDiff}
                        totalDiff={totalDiff}
                        computedSpreadEdge={computedSpreadEdge}
                        computedTotalEdge={computedTotalEdge}
                        awayLogoUrl={awayLogoUrl}
                        homeLogoUrl={homeLogoUrl}
                        awaySlug={game.awayTeam}
                        homeSlug={game.homeTeam}
                        awayDisplayName={awayDisplayName}
                        homeDisplayName={homeDisplayName}
                        showModel={showModel}
                        onToggleModel={toggleModel}
                        sport={game.sport}
                        modelAwayPLOdds={game.modelAwayPLOdds}
                        modelHomePLOdds={game.modelHomePLOdds}
                        modelOverOdds={game.modelOverOdds}
                        modelUnderOdds={game.modelUnderOdds}
                        modelAwaySpreadOdds={
                          (game as unknown as Record<string, string | null>)
                            .modelAwaySpreadOdds ?? null
                        }
                        modelHomeSpreadOdds={
                          (game as unknown as Record<string, string | null>)
                            .modelHomeSpreadOdds ?? null
                        }
                        awayRunLine={
                          (game as unknown as Record<string, string | null>)
                            .awayRunLine ?? null
                        }
                        homeRunLine={
                          (game as unknown as Record<string, string | null>)
                            .homeRunLine ?? null
                        }
                        authSpreadEdgeIsAway={authSpreadEdgeIsAway}
                        authTotalEdgeIsOver={authTotalEdgeIsOver}
                        isModeled={game.modelRunAt != null}
                      />
                    </div>
                  </div>
                </div>
                {/* Row 2: EdgeVerdict — compact horizontal row flush below the table */}
                {showModel && (
                  <div
                    className="flex items-center justify-start w-full px-0 py-0"
                    style={{
                      borderTop: "1px solid hsl(var(--border) / 0.5)",
                      minHeight: 24,
                    }}
                  >
                    <EdgeVerdict
                      spreadDiff={isNaN(spreadDiff) ? null : spreadDiff}
                      spreadEdge={computedSpreadEdge}
                      totalDiff={isNaN(totalDiff) ? null : totalDiff}
                      totalEdge={computedTotalEdge}
                      awayLogoUrl={awayLogoUrl}
                      homeLogoUrl={homeLogoUrl}
                      awaySlug={game.awayTeam}
                      homeSlug={game.homeTeam}
                      awayDisplayName={awayDisplayName}
                      homeDisplayName={homeDisplayName}
                      authSpreadEdgeIsAway={authSpreadEdgeIsAway}
                      compact
                    />
                  </div>
                )}
                {/* Subtle card separator */}
                <div style={{ height: 8 }} />
                <div
                  style={{ height: 1, background: "#FFFFFF", width: "100%" }}
                />
              </div>
            )}

            {/* Splits mode: fixed CompactScore column | scrollable Splits column */}
            {mode === "splits" && (
              <div
                className="gc-splitgrid"
                style={{
                  display: "grid",
                  gridTemplateColumns: "clamp(170px, 14vw, 220px) 1fr",
                  width: "100%",
                }}
              >
                {/* Fixed compact score — NOT inside scroll container */}
                <div
                  className="gc-frozen"
                  style={{
                    gridColumn: "1",
                    borderRight: "1px solid hsl(var(--border) / 0.5)",
                    background: "hsl(var(--card))",
                    zIndex: 1,
                  }}
                >
                  <CompactScorePanel />
                </div>
                {/* Scroll container for splits. 2026-08-05: focusable + named
                    — as a plain div the pane's off-screen half was unreachable
                    by keyboard entirely. */}
                <div
                  tabIndex={0}
                  role="group"
                  aria-label="Betting splits — scroll horizontally for the home side"
                  style={{
                    gridColumn: "2",
                    overflowX: "auto",
                    overflowY: "hidden",
                  }}
                >
                  <div className="gc-scrollinner" style={{ minWidth: 260 }}>
                    <BettingSplitsPanel
                      gameId={game.id}
                      game={game}
                      awayLabel={awayName}
                      homeLabel={homeName}
                      /* 2026-08-05 (mobile refinement): pass abbrs like the two
                         desktop call sites do — without them the bar headers
                         fell back to city names ("New York (+1.5)" for NYY
                         AND NYM; "Los Angeles" for LAD and LAA), wrapping to
                         two lines beside a frozen column that already says
                         the abbr. */
                      awayAbbr={awayAbbr}
                      homeAbbr={homeAbbr}
                      awayNickname={awayNickname}
                      homeNickname={homeNickname}
                      onMarketChange={setActiveMarket}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* ─────────────────────────────────────────────────────────────────────
               MOBILE FULL MODE — Tab-based layout
               ┌──────────────────────────────────────────────────────────────┐
               │  FROZEN LEFT PANEL (120px)  │  RIGHT PANEL (flex-1)         │
               │  Logo + Abbr + Score        │  [TAB BAR sticky]             │
               │                             │  Active section content       │
               │                             │  BOOK LINES / MODEL LINES /   │
               │                             │  SPLITS / EDGE                │
               └──────────────────────────────────────────────────────────────┘
               Tabs: BOOK LINES | MODEL LINES | SPLITS | EDGE
               Toggle dimming:
                 BOOK active  → book values white bold, model mint 40% opacity
                 MODEL active → book values gray 40% opacity, model mint bold
          ──────────────────────────────────────────────────────────────────── */}
            {mode === "full" && (
              <MobileGameCard
                game={game}
                awayAbbr={awayAbbr}
                homeAbbr={homeAbbr}
                awayName={awayName}
                homeName={homeName}
                awayDisplayName={awayDisplayName}
                homeDisplayName={homeDisplayName}
                awayLogoUrl={awayLogoUrl}
                homeLogoUrl={homeLogoUrl}
                awayNickname={awayNickname}
                homeNickname={homeNickname}
                awayBookSpread={awayBookSpread}
                homeBookSpread={homeBookSpread}
                bookTotal={bookTotal}
                modelTotal={modelTotal}
                awayModelSpread={awayModelSpread}
                homeModelSpread={homeModelSpread}
                spreadDiff={spreadDiff}
                totalDiff={totalDiff}
                computedSpreadEdge={computedSpreadEdge}
                computedTotalEdge={computedTotalEdge}
                authSpreadEdgeIsAway={authSpreadEdgeIsAway}
                authTotalEdgeIsOver={authTotalEdgeIsOver}
                showModel={showModel}
                mobileTab={mobileTab}
                setMobileTab={setMobileTab}
                isLive={isLive}
                isFinal={isFinal}
                isUpcoming={isUpcoming}
                hasScores={hasScores}
                awayWins={awayWins}
                homeWins={homeWins}
                awayScoreFlash={awayScoreFlash}
                homeScoreFlash={homeScoreFlash}
                time={time}
                isAppAuthed={isAppAuthed}
                isFavorited={isFavorited}
                onStarClick={handleStarClick}
                activeMarket={activeMarket}
                setActiveMarket={setActiveMarket}
                isNhlGame={isNhlGame}
                isMlbGame={isMlbGame}
                borderColor={borderColor}
                awayMlbAnSlug={awayMlb?.anSlug}
                homeMlbAnSlug={homeMlb?.anSlug}
              />
            )}
          </div>
        </m.div>

        {/* ── ODDS & SPLITS HISTORY — Full-width, below the card body ──
           Rendered outside all overflow:hidden containers so the collapsible
           table can expand freely. On the Betting Splits page (mode="splits")
           the history is part of the surface itself; elsewhere it follows the
           mobile SPLITS tab (full mode, <768px only — the persisted tab state
           must never leak onto desktop full-mode feeds).
           The border-left matches the card's accent stripe.
      */}
        {(mode === "splits" ||
          (mode === "full" && !isMdUp && mobileTab === "splits")) &&
          isCardVisible &&
          game.id != null && (
            <div
              className="w-full"
              data-edge-tier={maxDiff >= EDGE_THRESHOLD_PP ? "signal" : "none"}
              style={{
                background: "hsl(var(--card))",
                borderLeft: `3px solid ${borderColor}`,
                borderBottom: "1px solid hsl(var(--border))",
              }}
            >
              <OddsHistoryPanel
                sport={game.sport}
                gameId={game.id}
                enabled={isCardVisible}
                awayTeam={game.awayTeam}
                homeTeam={game.homeTeam}
                activeMarket={activeMarket}
              />
            </div>
          )}

        {/* ── Recent Schedule + Situational Results ─────────────────────────────
           Last 5 Games + Trends live on the Trends tab — they are intentionally
           ABSENT from the Betting Splits surface (mode="splits") at every width.
           They render only on the full-mode mobile SPLITS tab, MLB only.
           NBA/NHL panels are intentionally omitted until their DBs are backfilled.
           Panels are rendered outside overflow:hidden so they can expand freely.
      */}
        {mode === "full" &&
          !isMdUp &&
          mobileTab === "splits" &&
          isCardVisible &&
          game.sport === "MLB" &&
          awayMlb?.anSlug &&
          homeMlb?.anSlug && (
            <>
              <RecentSchedulePanel
                sport="MLB"
                enabled={isCardVisible}
                awaySlug={awayMlb.anSlug}
                homeSlug={homeMlb.anSlug}
                awayAbbr={awayAbbr}
                homeAbbr={homeAbbr}
                awayName={awayName}
                homeName={homeName}
                awayLogoUrl={awayLogoUrl}
                homeLogoUrl={homeLogoUrl}
                borderColor={borderColor}
                defaultCollapsed={true}
              />
              <SituationalResultsPanel
                sport="MLB"
                enabled={isCardVisible}
                awaySlug={awayMlb.anSlug}
                homeSlug={homeMlb.anSlug}
                awayAbbr={awayAbbr}
                homeAbbr={homeAbbr}
                awayName={awayName}
                homeName={homeName}
                awayLogoUrl={awayLogoUrl}
                homeLogoUrl={homeLogoUrl}
                borderColor={borderColor}
                defaultCollapsed={true}
              />
            </>
          )}
      </MotionConfig>
    </LazyMotion>
  );
}

/**
 * React.memo wrapper for GameCard.
 * Prevents re-renders when the parent (ModelProjections) re-renders due to
 * unrelated state changes (e.g. now-ticker, search query, header height).
 * Props are stable because ModelProjections wraps all callbacks in useCallback
 * and computes mobileTab/isAppAuthed once per render via useMemo.
 */
export const GameCard = memo(GameCardInner);
