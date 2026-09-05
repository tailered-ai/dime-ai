/*
 * BettingSplitsPanel
 *
 * Mobile  (< md / 768px): tabbed toggle, one market at a time — ultra-compact rows
 *   Each row: [MARKET LABEL] [TICKETS bar] [HANDLE bar] — all inline
 *
 * Tablet + desktop (≥ md / 768px): all 3 markets side-by-side in equal
 * columns, no tab selectors — the wide layout is the whole point of the
 * splits surface on these screens.
 */

import { useState } from "react";
import { useIsMdUp } from "@/hooks/useIsMdUp";
import { trpc } from "@/lib/trpc";
import { getGameTeamColorsClient } from "@shared/teamColors";
import { OddsHistoryPanel } from "./OddsHistoryPanel";
// The panel's .bsp-* styles ride whichever chunk renders it (NOT the chat
// critical path) — importing here covers every direct consumer, including
// PublishProjections, regardless of navigation order.
import "@/styles/splits-interactions.css";

type MobileMarket = "spread" | "total" | "ml";

interface BettingSplitsPanelProps {
  /** DB game ID — used to fetch the odds & splits history timeline */
  gameId?: number;
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
  };
  awayLabel: string;
  homeLabel: string;
  /** Official team abbreviations (e.g. "KC", "BAL") — preferred over city
   * names in the tight market-label rows; falls back to awayLabel/homeLabel. */
  awayAbbr?: string;
  homeAbbr?: string;
  awayNickname?: string;
  homeNickname?: string;
  /** IntersectionObserver gate — only fetch data when card is in viewport */
  enabled?: boolean;
  /** Called whenever the user switches the SPREAD/TOTAL/MONEYLINE toggle */
  onMarketChange?: (market: MobileMarket) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toNum(v: string | null | undefined): number {
  if (v == null) return NaN;
  const n = parseFloat(v);
  return isNaN(n) ? NaN : n;
}

function spreadSign(n: number): string {
  if (n === 0) return "PK";
  return n > 0 ? `+${n}` : `${n}`;
}

const FALLBACK_AWAY = "#1a4a8a";
const FALLBACK_HOME = "#c84b0c";

function isUnusableBarColor(hex: string | null | undefined): boolean {
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
}

function areColorsTooSimilar(
  hexA: string,
  hexB: string,
  threshold = 60
): boolean {
  const toRgb = (hex: string) => {
    const clean = hex.replace(/^#/, "");
    const full =
      clean.length === 3
        ? clean
            .split("")
            .map(c => c + c)
            .join("")
        : clean;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  };
  try {
    const [r1, g1, b1] = toRgb(hexA);
    const [r2, g2, b2] = toRgb(hexB);
    return (
      Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2) < threshold
    );
  } catch {
    return false;
  }
}

function relativeLuminance(hex: string): number {
  const clean = hex.replace(/^#/, "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map(c => c + c)
          .join("")
      : clean;
  const toLinear = (c: number) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const r = toLinear(parseInt(full.slice(0, 2), 16) / 255);
  const g = toLinear(parseInt(full.slice(2, 4), 16) / 255);
  const b = toLinear(parseInt(full.slice(4, 6), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function bestTextColor(hex: string | null | undefined): string {
  if (!hex || !/^#[0-9a-fA-F]{3,6}$/.test(hex)) return "#ffffff";
  const bgLum = relativeLuminance(hex);
  return (bgLum + 0.05) / 0.05 > 1.05 / (bgLum + 0.05) ? "#000000" : "#ffffff";
}

function pickBarColor(
  primary: string | null | undefined,
  secondary: string | null | undefined,
  tertiary: string | null | undefined,
  fallback: string
): string {
  for (const c of [primary, secondary, tertiary]) {
    if (c && !isUnusableBarColor(c)) return c;
  }
  return fallback;
}

// ── LabeledBar — compact inline split bar with ABBR (LINE) - XX% labels ────────
//
// Design rules (non-negotiable):
//   1. Labels ALWAYS appear INSIDE their pill segment — never outside.
//   2. 100%/0% → single full-width segment, only the 100% label shown, 0% hidden entirely.
//   3. Any value 1–99% → segment gets a minWidth guarantee so the label always fits.

interface LabeledBarProps {
  awayPct: number | null;
  homePct: number | null;
  awayColor: string;
  homeColor: string;
  awayLineLabel: string; // e.g. "LBS (-14.5)"
  homeLineLabel: string; // e.g. "HAW (+14.5)"
  rowLabel: string; // e.g. "Tickets" or "Money"
}

// Minimum pixel width for a segment that must show a label.
// Single-digit (1-9%): needs more room because rounded pill corners eat into visible area.
// Two-digit (10-99%): standard room.
// We compute dynamically based on digit count to give maximal precision.
function mobileSegMinPx(pct: number): number {
  // 1-9%: "X%" = 2 chars @ ~6px each + 2×6px padding + 4px for rounded corners = 40px
  // 10-99%: "XX%" = 3 chars @ ~6px each + 2×6px padding = 30px
  // 100%: handled by full-bar path, not used here
  return pct < 10 ? 40 : 30;
}

// Black stroke textShadow for all % labels — applied to every label path, no exceptions
const LABEL_STROKE =
  "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 6px #000000, 0 0 10px #000000";

// Away label: flush LEFT inside the segment
const MOBILE_AWAY_LABEL_STYLE: React.CSSProperties = {
  fontSize: 10,
  color: "#ffffff",
  fontWeight: 700, // Grotesk loads 400-700; 800 renders synthetic bold
  letterSpacing: "0.04em",
  lineHeight: 1,
  whiteSpace: "nowrap",
  display: "block",
  textAlign: "left",
  textShadow: LABEL_STROKE,
};

// Home label: flush RIGHT inside the segment
const MOBILE_HOME_LABEL_STYLE: React.CSSProperties = {
  fontSize: 10,
  color: "#ffffff",
  fontWeight: 700, // Grotesk loads 400-700; 800 renders synthetic bold
  letterSpacing: "0.04em",
  lineHeight: 1,
  whiteSpace: "nowrap",
  display: "block",
  textAlign: "right",
  textShadow: LABEL_STROKE,
};

// 100% full-bar label: centered
const MOBILE_FULL_LABEL_STYLE: React.CSSProperties = {
  fontSize: 10,
  color: "#ffffff",
  fontWeight: 700, // Grotesk loads 400-700; 800 renders synthetic bold
  letterSpacing: "0.04em",
  lineHeight: 1,
  whiteSpace: "nowrap",
  display: "block",
  textAlign: "center",
  textShadow: LABEL_STROKE,
};

function LabeledBar({
  awayPct,
  homePct,
  awayColor,
  homeColor,
  awayLineLabel,
  homeLineLabel,
  rowLabel,
}: LabeledBarProps) {
  const hasData = awayPct != null && homePct != null;

  if (!hasData) {
    return (
      <div className="w-full flex flex-col gap-0.5">
        {/* Header row */}
        <div
          className="flex items-center justify-between"
          style={{ paddingLeft: 2, paddingRight: 2 }}
        >
          <span
            style={{
              fontSize: 11,
              color: "var(--dime-text-body, #ffffff)",
              fontWeight: 700,
              letterSpacing: "0.04em",
            }}
          >
            {awayLineLabel}
          </span>
          <span
            style={{
              fontSize: 10,
              color: "var(--dime-text-secondary, #ffffff)",
              fontFamily: "var(--dime-font-mono)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            {rowLabel}
          </span>
          <span
            style={{
              fontSize: 11,
              color: "var(--dime-text-body, #ffffff)",
              fontWeight: 700,
              letterSpacing: "0.04em",
            }}
          >
            {homeLineLabel}
          </span>
        </div>
        {/* Empty bar */}
        <div
          className="w-full rounded-md flex items-center justify-center"
          style={{
            height: 20,
            background: "var(--dime-row-hover, #000000)",
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: "var(--dime-text-secondary, #ffffff)",
            }}
          >
            —
          </span>
        </div>
      </div>
    );
  }

  const away = awayPct ?? 0;
  const home = homePct ?? 0;

  // 100%/0% special case — render a single full-width segment, hide the zero side entirely
  const isAwayFull = away >= 100;
  const isHomeFull = home >= 100;

  // Use flexGrow proportional sizing so segments always fill the container
  // without exceeding it. overflow:hidden is on each segment (not the container).
  const awaySegStyle: React.CSSProperties = isAwayFull
    ? {
        flex: 1,
        background: awayColor,
        borderRadius: "4px",
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-start",
        padding: "0 4px",
        overflow: "hidden",
      }
    : isHomeFull
      ? { display: "none" }
      : away > 0
        ? {
            flexGrow: away,
            flexShrink: 1,
            flexBasis: 0,
            minWidth: mobileSegMinPx(away),
            background: awayColor,
            borderRadius: "4px 0 0 4px",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-start",
            padding: "0 5px",
            overflow: "hidden",
          }
        : { display: "none" };

  const homeSegStyle: React.CSSProperties = isHomeFull
    ? {
        flex: 1,
        background: homeColor,
        borderRadius: "4px",
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        padding: "0 5px",
        overflow: "hidden",
      }
    : isAwayFull
      ? { display: "none" }
      : home > 0
        ? {
            flexGrow: home,
            flexShrink: 1,
            flexBasis: 0,
            minWidth: mobileSegMinPx(home),
            background: homeColor,
            borderRadius: "0 4px 4px 0",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            padding: "0 5px",
            overflow: "hidden",
          }
        : { display: "none" };

  const showDivider = !isAwayFull && !isHomeFull && away > 0 && home > 0;

  return (
    <div className="bsp-row w-full flex flex-col gap-0.5">
      {/* Header row: AWAY_LABEL  [rowLabel]  HOME_LABEL */}
      <div
        className="bsp-hdr flex items-center justify-between"
        style={{ paddingLeft: 2, paddingRight: 2 }}
      >
        <span
          style={{
            fontSize: 11,
            color: "var(--dime-text-secondary)",
            fontWeight: 700,
            letterSpacing: "0.03em",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {awayLineLabel}
        </span>
        <span
          style={{
            fontSize: 11,
            color: "var(--dime-text-secondary)",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.10em",
          }}
        >
          {rowLabel}
        </span>
        <span
          style={{
            fontSize: 11,
            color: "var(--dime-text-secondary)",
            fontWeight: 700,
            letterSpacing: "0.03em",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {homeLineLabel}
        </span>
      </div>
      {/* Bar — flex row, NO overflow:hidden on outer container (that clips home label) */}
      {/* Header spans: 11px floor — the mobile type law bans sub-10px content. */}
      <div
        className="bsp-bar"
        style={{
          // Mobile pill height: fixed 20px (mobile baseline, not scaled — mobile is already at scale=1)
          height: 20,
          minWidth: 0,
          display: "flex",
          flexDirection: "row",
          borderRadius: 4,
          border: "1px solid var(--dime-border-strong)",
          boxSizing: "border-box",
        }}
      >
        {/* Away segment — label flush LEFT (only when NOT full-bar) */}
        {away > 0 && !isAwayFull && !isHomeFull && (
          <div
            style={awaySegStyle}
            className="bsp-seg bsp-seg--away transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
          >
            <span style={MOBILE_AWAY_LABEL_STYLE}>{away}%</span>
          </div>
        )}
        {/* Divider */}
        {showDivider && (
          <div
            className="bsp-div"
            style={{
              width: 1,
              background: "var(--dime-border-strong)",
              flexShrink: 0,
              alignSelf: "stretch",
            }}
          />
        )}
        {/* Home segment — label flush RIGHT (only when NOT full-bar) */}
        {home > 0 && !isHomeFull && !isAwayFull && (
          <div
            style={homeSegStyle}
            className="bsp-seg bsp-seg--home transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
          >
            <span style={MOBILE_HOME_LABEL_STYLE}>{home}%</span>
          </div>
        )}
        {/* 100% full-bar cases — label centered — EXCLUSIVE: only one can render */}
        {isAwayFull && !isHomeFull && (
          <div
            style={{
              flex: 1,
              background: awayColor,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 4,
            }}
            className="bsp-seg bsp-seg--away transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
          >
            <span style={MOBILE_FULL_LABEL_STYLE}>100%</span>
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
              borderRadius: 4,
            }}
            className="bsp-seg bsp-seg--home transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
          >
            <span style={MOBILE_FULL_LABEL_STYLE}>100%</span>
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
                borderRadius: "4px 0 0 4px",
              }}
              className="bsp-seg bsp-seg--away transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
            >
              <span style={MOBILE_FULL_LABEL_STYLE}>100%</span>
            </div>
            <div
              style={{
                flex: 1,
                background: homeColor,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "0 4px 4px 0",
              }}
              className="bsp-seg bsp-seg--home transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
            >
              <span style={MOBILE_FULL_LABEL_STYLE}>100%</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── CompactMarketRow — one market row for mobile ──────────────────────────────
// Layout: [TITLE] [TICKETS bar] [HANDLE bar] stacked vertically

interface CompactMarketRowProps {
  title: string;
  ticketsPct: number | null | undefined;
  handlePct: number | null | undefined;
  awayColor: string;
  homeColor: string;
  awayLineLabel: string; // e.g. "LBS (-14.5)"
  homeLineLabel: string; // e.g. "HAW (+14.5)"
}

function CompactMarketRow({
  title,
  ticketsPct,
  handlePct,
  awayColor,
  homeColor,
  awayLineLabel,
  homeLineLabel,
}: CompactMarketRowProps) {
  // Treat 0%/0% as "no data" — VSIN returns 0/0 when the market hasn't opened yet.
  // Symmetric guard with desktop MarketBlock — prevents the misleading 100% home bar.
  const bothZero = ticketsPct === 0 && handlePct === 0;
  const effectiveTickets = bothZero ? null : ticketsPct;
  const effectiveHandle = bothZero ? null : handlePct;

  const hasTickets = effectiveTickets != null;
  const hasHandle = effectiveHandle != null;
  if (!hasTickets && !hasHandle) return null;

  const awayTickets = hasTickets ? effectiveTickets! : null;
  const homeTickets = hasTickets ? 100 - effectiveTickets! : null;
  const awayHandle = hasHandle ? effectiveHandle! : null;
  const homeHandle = hasHandle ? 100 - effectiveHandle! : null;

  const marketLabel =
    title === "Moneyline" ? "ML" : title === "Spread" ? "SPR" : "TOT";

  return (
    <div
      className="flex flex-col w-full"
      style={{ padding: "2px 8px 4px 8px", gap: 6 }}
    >
      <LabeledBar
        awayPct={awayTickets}
        homePct={homeTickets}
        awayColor={awayColor}
        homeColor={homeColor}
        awayLineLabel={awayLineLabel}
        homeLineLabel={homeLineLabel}
        rowLabel="Tickets"
      />
      <LabeledBar
        awayPct={awayHandle}
        homePct={homeHandle}
        awayColor={awayColor}
        homeColor={homeColor}
        awayLineLabel={awayLineLabel}
        homeLineLabel={homeLineLabel}
        rowLabel="Handle" // 2026-08-05: one word per concept — desktop bars and the history tables both say HANDLE
      />
    </div>
  );
}

// ── SplitBar — full-size bar for desktop ──────────────────────────────────────

interface SplitBarProps {
  label: string;
  awayPct: number | null;
  homePct: number | null;
  awayColor: string;
  homeColor: string;
}

// Desktop SplitBar label styles — directional, same black stroke as mobile
// Font scales proportionally with bar height: bar = clamp(28px,3vw,44px), font ≈ 40% of bar height
// Away label: flush LEFT
const DESKTOP_AWAY_LABEL_STYLE: React.CSSProperties = {
  fontSize: "clamp(12px, 1.2vw, 17px)",
  color: "var(--dime-text-primary, #ffffff)",
  fontWeight: 700, // Grotesk loads 400-700; 800 renders synthetic bold
  letterSpacing: "0.04em",
  lineHeight: 1,
  whiteSpace: "nowrap",
  display: "block",
  textAlign: "left",
  textShadow: LABEL_STROKE,
};

// Home label: flush RIGHT
const DESKTOP_HOME_LABEL_STYLE: React.CSSProperties = {
  fontSize: "clamp(12px, 1.2vw, 17px)",
  color: "var(--dime-text-primary, #ffffff)",
  fontWeight: 700, // Grotesk loads 400-700; 800 renders synthetic bold
  letterSpacing: "0.04em",
  lineHeight: 1,
  whiteSpace: "nowrap",
  display: "block",
  textAlign: "right",
  textShadow: LABEL_STROKE,
};

// 100% full-bar label: centered
const DESKTOP_FULL_LABEL_STYLE: React.CSSProperties = {
  fontSize: "clamp(12px, 1.2vw, 17px)",
  color: "var(--dime-text-primary, #ffffff)",
  fontWeight: 700, // Grotesk loads 400-700; 800 renders synthetic bold
  letterSpacing: "0.04em",
  lineHeight: 1,
  whiteSpace: "nowrap",
  display: "block",
  textAlign: "center",
  textShadow: LABEL_STROKE,
};

// Proportional padding for desktop segments — scales with font/bar size
// clamp(6px, 0.6vw, 10px) keeps padding proportional at all viewport widths
const DESKTOP_SEG_PADDING = "clamp(6px, 0.6vw, 10px)";

// Minimum pixel width for a desktop segment so the label always fits inside.
// Dynamic: single-digit values need more room due to rounded pill corners.
// At clamp(11px,1.2vw,17px) font + clamp(6px,0.6vw,10px) padding each side:
//   1-9%:  "X%"  = 2 chars @ ~11px each + 12px padding + 6px corners = ~51px min
//   10-99%: "XX%" = 3 chars @ ~11px each + 12px padding = ~45px min
// We use slightly larger values to be safe across all viewport widths.
function desktopSegMinPx(pct: number): number {
  return pct < 10 ? 54 : 46;
}

function SplitBar({
  label,
  awayPct,
  homePct,
  awayColor,
  homeColor,
}: SplitBarProps) {
  const hasData = awayPct != null && homePct != null;

  // Design rules (non-negotiable):
  //   1. Labels ALWAYS appear INSIDE their pill segment — never outside.
  //   2. 100%/0% → single full-width segment, only the 100% label shown, 0% hidden entirely.
  //   3. Any value 1–99% → segment gets a minWidth guarantee so the label always fits.

  return (
    <div className="flex flex-col gap-1 w-full">
      <span
        className="text-center uppercase"
        style={{
          fontFamily: "var(--dime-font-mono)",
          fontWeight: 500,
          fontSize: "clamp(11px, 0.9vw, 13px)",
          color: "var(--dime-text-secondary, #ffffff)",
          letterSpacing: "0.1em",
        }}
      >
        {label}
      </span>
      {hasData ? (
        (() => {
          const away = awayPct ?? 0;
          const home = homePct ?? 0;
          const isAwayFull = away >= 100;
          const isHomeFull = home >= 100;
          const showDivider =
            !isAwayFull && !isHomeFull && away > 0 && home > 0;

          // Use flex-grow proportional sizing so segments always fill the container
          // without exceeding it. minWidth ensures even 1% segments show their label.
          // overflow:hidden is on each segment (not the container) to preserve pill shape.
          // Padding uses DESKTOP_SEG_PADDING (clamp) so it scales with viewport width.
          const awaySegStyle: React.CSSProperties = isAwayFull
            ? {
                flex: 1,
                background: awayColor,
                borderRadius: "9999px",
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-start",
                paddingLeft: DESKTOP_SEG_PADDING,
                paddingRight: DESKTOP_SEG_PADDING,
                overflow: "hidden",
              }
            : away > 0
              ? {
                  flexGrow: away,
                  flexShrink: 1,
                  flexBasis: 0,
                  minWidth: desktopSegMinPx(away),
                  background: awayColor,
                  borderRadius: "9999px 0 0 9999px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "flex-start",
                  paddingLeft: DESKTOP_SEG_PADDING,
                  paddingRight: DESKTOP_SEG_PADDING,
                  overflow: "hidden",
                }
              : { display: "none" };

          const homeSegStyle: React.CSSProperties = isHomeFull
            ? {
                flex: 1,
                background: homeColor,
                borderRadius: "9999px",
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                paddingLeft: DESKTOP_SEG_PADDING,
                paddingRight: DESKTOP_SEG_PADDING,
                overflow: "hidden",
              }
            : home > 0
              ? {
                  flexGrow: home,
                  flexShrink: 1,
                  flexBasis: 0,
                  minWidth: desktopSegMinPx(home),
                  background: homeColor,
                  borderRadius: "0 9999px 9999px 0",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  paddingLeft: DESKTOP_SEG_PADDING,
                  paddingRight: DESKTOP_SEG_PADDING,
                  overflow: "hidden",
                }
              : { display: "none" };

          return (
            <div
              style={{
                // Use --pill-height CSS token (driven by --scale) for fluid scaling
                height: "var(--pill-height, clamp(28px, 3vw, 44px))",
                display: "flex",
                flexDirection: "row",
                borderRadius: "9999px",
                // NO overflow:hidden here — that clips the home segment label.
                // Each segment has its own overflow:hidden to clip text within its bounds.
                border: "1.5px solid var(--dime-border-strong)",
                boxSizing: "border-box",
                width: "100%",
              }}
              className="bsp-bar bsp-bar--pill"
            >
              {/* Away segment — label flush LEFT (only when NOT full-bar) */}
              {away > 0 && !isAwayFull && !isHomeFull && (
                <div
                  style={awaySegStyle}
                  className="bsp-seg bsp-seg--away transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
                >
                  <span style={DESKTOP_AWAY_LABEL_STYLE}>{away}%</span>
                </div>
              )}
              {/* Divider */}
              {showDivider && (
                <div
                  className="bsp-div"
                  style={{
                    width: 1.5,
                    background: "var(--dime-border-strong)",
                    flexShrink: 0,
                    alignSelf: "stretch",
                  }}
                />
              )}
              {/* Home segment — label flush RIGHT (only when NOT full-bar) */}
              {home > 0 && !isHomeFull && !isAwayFull && (
                <div
                  style={homeSegStyle}
                  className="bsp-seg bsp-seg--home transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
                >
                  <span style={DESKTOP_HOME_LABEL_STYLE}>{home}%</span>
                </div>
              )}
              {/* 100% full-bar cases — label centered — EXCLUSIVE: only one can render */}
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
                  className="bsp-seg bsp-seg--away transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
                >
                  <span style={DESKTOP_FULL_LABEL_STYLE}>100%</span>
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
                  className="bsp-seg bsp-seg--home transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
                >
                  <span style={DESKTOP_FULL_LABEL_STYLE}>100%</span>
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
                    className="bsp-seg bsp-seg--away transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
                  >
                    <span style={DESKTOP_FULL_LABEL_STYLE}>100%</span>
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
                    className="bsp-seg bsp-seg--home transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
                  >
                    <span style={DESKTOP_FULL_LABEL_STYLE}>100%</span>
                  </div>
                </>
              )}
            </div>
          );
        })()
      ) : (
        <div
          className="w-full rounded-full flex items-center justify-center"
          style={{
            height: 30,
            background: "var(--dime-surface-raised, #000000)",
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: "var(--dime-text-secondary, #ffffff)",
            }}
          >
            —
          </span>
        </div>
      )}
    </div>
  );
}

// ── MarketBlock — full-size column for desktop ────────────────────────────────

interface MarketBlockProps {
  title: string;
  awayLabel: string;
  homeLabel: string;
  totalValue?: number;
  ticketsPct: number | null | undefined;
  handlePct: number | null | undefined;
  awayColor: string;
  homeColor: string;
}

function MarketBlock({
  title,
  awayLabel,
  homeLabel,
  totalValue,
  ticketsPct,
  handlePct,
  awayColor,
  homeColor,
}: MarketBlockProps) {
  // Treat 0%/0% as "no data" — VSIN returns 0/0 when the market hasn't opened yet.
  // This is the same guard applied on mobile. Prevents the misleading 100% home bar.
  const ticketsBothZero = ticketsPct === 0 && handlePct === 0;
  const effectiveTickets = ticketsBothZero ? null : ticketsPct;
  const effectiveHandle = ticketsBothZero ? null : handlePct;

  const hasTickets = effectiveTickets != null;
  const hasHandle = effectiveHandle != null;
  // Never return null — always render the column so all 3 fill the full width

  const awayTickets = hasTickets ? effectiveTickets! : null;
  const homeTickets = hasTickets ? 100 - effectiveTickets! : null;
  const awayHandle = hasHandle ? effectiveHandle! : null;
  const homeHandle = hasHandle ? 100 - effectiveHandle! : null;
  const isTotalMarket = totalValue !== undefined && !isNaN(totalValue);

  return (
    // Horizontal inset keeps adjacent market columns' labels ≥24px apart
    // across the divider (never a run-on line) while still fitting two
    // "WSH (-106)"-length labels per column in the 1024–1279 shell band.
    // border-box is load-bearing: frozen-tokens.css forces content-box on all
    // .dc-page descendants, which made width:100%+padding overflow each market
    // column (the 2026-07-21 cutoff bug). Guarded by e2e/splits-layout.spec.ts.
    <div
      className="flex flex-col w-full"
      data-market-col
      style={{
        gap: 10,
        padding: "12px clamp(14px, 1.5vw, 20px)",
        boxSizing: "border-box",
      }}
    >
      <div className="flex items-center gap-2">
        <div
          className="flex-1"
          style={{ height: 1, background: "var(--dime-border, #ffffff)" }}
        />
        <span
          className="uppercase tracking-widest font-bold whitespace-nowrap"
          style={{
            fontSize: "clamp(13px, 1.1vw, 17px)",
            color: "var(--dime-text-primary, #ffffff)",
            letterSpacing: "0.14em",
          }}
        >
          {title}
        </span>
        <div
          className="flex-1"
          style={{ height: 1, background: "var(--dime-border, #ffffff)" }}
        />
      </div>
      {/* Both label-row branches share one fixed box so the three market
          columns keep a single baseline (TOTAL used to sit 3-4px lower). */}
      {isTotalMarket ? (
        // OVER/UNDER need the same min-width:0 + ellipsis safety as the
        // away/home branch below — at the narrower 1024px column width
        // (post sidebar-widening, 673922b) these labels no longer fit their
        // gap-8 flex row at floor font size and were painting across the
        // divider track. flexShrink:0 on the number keeps "7.5" whole while
        // the OVER/UNDER text is the one that yields.
        <div
          className="flex items-center justify-between"
          style={{
            paddingLeft: 2,
            paddingRight: 2,
            gap: 8,
            minHeight: "clamp(32px, 2.8vw, 40px)",
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontSize: "clamp(12px, 1.0vw, 16px)",
              color: "var(--dime-text-primary, #ffffff)",
              fontWeight: 700,
              letterSpacing: "0.06em",
              whiteSpace: "nowrap",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            OVER
          </span>
          <span
            style={{
              fontSize: "clamp(14px, 1.2vw, 20px)",
              color: "var(--dime-text-primary, #ffffff)",
              fontWeight: 700,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {totalValue}
          </span>
          <span
            style={{
              fontSize: "clamp(12px, 1.0vw, 16px)",
              color: "var(--dime-text-primary, #ffffff)",
              fontWeight: 700,
              letterSpacing: "0.06em",
              whiteSpace: "nowrap",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              textAlign: "right",
            }}
          >
            UNDER
          </span>
        </div>
      ) : (
        // Equal lanes let the team and complete price wrap at their space.
        // Never ellipsize numerical market values.
        <div
          className="flex items-center justify-between"
          style={{
            paddingLeft: 2,
            paddingRight: 2,
            gap: 8,
            minHeight: "clamp(32px, 2.8vw, 40px)",
          }}
        >
          <span
            className="uppercase"
            style={{
              fontSize: "clamp(12px, 1.0vw, 15px)",
              color: "var(--dime-text-primary, #ffffff)",
              fontWeight: 700,
              letterSpacing: "0.02em",
              whiteSpace: "normal",
              flex: "1 1 0",
              minWidth: 0,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {awayLabel}
          </span>
          <span
            className="uppercase text-right"
            style={{
              fontSize: "clamp(12px, 1.0vw, 15px)",
              color: "var(--dime-text-primary, #ffffff)",
              fontWeight: 700,
              letterSpacing: "0.02em",
              whiteSpace: "normal",
              flex: "1 1 0",
              minWidth: 0,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {homeLabel}
          </span>
        </div>
      )}
      <SplitBar
        label="Tickets"
        awayPct={awayTickets}
        homePct={homeTickets}
        awayColor={awayColor}
        homeColor={homeColor}
      />
      <SplitBar
        label="Handle"
        awayPct={awayHandle}
        homePct={homeHandle}
        awayColor={awayColor}
        homeColor={homeColor}
      />
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function BettingSplitsPanel({
  gameId,
  game,
  awayLabel,
  homeLabel,
  awayAbbr: awayAbbrProp,
  homeAbbr: homeAbbrProp,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  awayNickname: _aN,
  homeNickname: _hN,
  onMarketChange,
}: BettingSplitsPanelProps) {
  const [mobileMarket, setMobileMarket] = useState<MobileMarket>("spread");
  const isMdUp = useIsMdUp();

  // Wrapper that updates internal state AND notifies parent (GameCard)
  const handleMarketChange = (m: MobileMarket) => {
    setMobileMarket(m);
    onMarketChange?.(m);
  };
  const sport = game.sport ?? "NBA";
  // Performance Fix #5: client-side color lookup (eliminates tRPC round-trip per card)
  const colors = getGameTeamColorsClient(game.awayTeam, game.homeTeam, sport);

  const homeColor = pickBarColor(
    colors?.home?.primaryColor,
    colors?.home?.secondaryColor,
    colors?.home?.tertiaryColor,
    FALLBACK_HOME
  );

  const awayColorCandidates: (string | null | undefined)[] = [
    colors?.away?.primaryColor,
    colors?.away?.secondaryColor,
    colors?.away?.tertiaryColor,
    FALLBACK_AWAY,
  ];
  const awayColor = (() => {
    for (const candidate of awayColorCandidates) {
      if (!candidate) continue;
      if (isUnusableBarColor(candidate)) continue;
      if (!areColorsTooSimilar(candidate, homeColor)) return candidate;
    }
    return FALLBACK_AWAY;
  })();

  const awaySpread = toNum(game.awayBookSpread);
  const homeSpread = toNum(game.homeBookSpread);
  const bookTotal = toNum(game.bookTotal);

  // Abbreviations keep the tight label rows collision-free; city names are the
  // last resort ("KANSAS CITY (+1.5)" is what used to overlap the next column).
  const awayAbbr = colors?.away?.abbrev ?? awayAbbrProp ?? awayLabel;
  const homeAbbr = colors?.home?.abbrev ?? homeAbbrProp ?? homeLabel;

  const awaySpreadLabel = !isNaN(awaySpread)
    ? `${awayAbbr} (${spreadSign(awaySpread)})`
    : awayAbbr;
  const homeSpreadLabel = !isNaN(homeSpread)
    ? `${homeAbbr} (${spreadSign(homeSpread)})`
    : homeAbbr;
  const awayMlLabel = game.awayML ? `${awayAbbr} (${game.awayML})` : awayAbbr;
  const homeMlLabel = game.homeML ? `${homeAbbr} (${game.homeML})` : homeAbbr;

  // Treat 0%/0% as "no data" — VSIN returns 0/0 when the run-line/spread market
  // hasn't opened yet (line shows "-"). Displaying it renders a misleading 100% home bar.
  const spreadBothZero =
    game.spreadAwayBetsPct === 0 && game.spreadAwayMoneyPct === 0;
  const hasSpreadSplits =
    !spreadBothZero &&
    (game.spreadAwayMoneyPct != null || game.spreadAwayBetsPct != null);
  const hasTotalSplits =
    game.totalOverMoneyPct != null || game.totalOverBetsPct != null;
  const hasMlSplits =
    game.mlAwayMoneyPct != null ||
    game.mlAwayBetsPct != null ||
    game.awayML != null;
  const hasAnySplits = hasSpreadSplits || hasTotalSplits || hasMlSplits;

  if (!hasAnySplits) {
    return (
      <div
        className="w-full flex items-center justify-center"
        style={{ minHeight: 80, padding: "16px 12px" }}
      >
        <span
          style={{
            fontSize: 11,
            color: "var(--dime-text-secondary, #ffffff)",
            fontFamily: "var(--dime-font-mono)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            fontWeight: 500,
          }}
        >
          Splits not yet available
        </span>
      </div>
    );
  }

  // Determine which markets are available; default to first available
  const availableMarkets: MobileMarket[] = [
    ...(hasSpreadSplits ? ["spread" as const] : []),
    ...(hasTotalSplits ? ["total" as const] : []),
    ...(hasMlSplits ? ["ml" as const] : []),
  ];
  // Resolve active market — fall back to first available if current isn't available
  const activeMarket: MobileMarket = availableMarkets.includes(mobileMarket)
    ? mobileMarket
    : (availableMarkets[0] ?? "spread");

  return (
    <>
      {/* ── Mobile (< md): toggle + single active market ── */}
      {!isMdUp && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: "100%",
            height: "100%",
            padding: "4px 0",
          }}
        >
          {/* 3-way toggle */}
          <div
            className="flex items-center"
            style={{ padding: "0 8px 4px 8px", gap: 4 }}
          >
            {(["spread", "total", "ml"] as MobileMarket[]).map(m => {
              const label =
                m === "spread" ? "SPREAD" : m === "total" ? "TOTAL" : "ML"; // 2026-08-05: "MONEYLINE" clipped to "MONEYLIN" at 375-390 (equal-thirds row); ML is the surface's own abbr (history badge vocabulary)
              const isActive = m === activeMarket;
              const isAvailable = availableMarkets.includes(m);
              return (
                <button
                  type="button"
                  key={m}
                  className="bsp-toggle"
                  data-active={isActive}
                  aria-pressed={isActive}
                  onClick={() => handleMarketChange(m)}
                  disabled={!isAvailable}
                  style={{
                    // Colors/typography live in the .bsp-toggle brand layer
                    // (dime-mobile.css) — inline carries layout only.
                    flex: 1,
                    padding: "3px 0",
                    textTransform: "uppercase",
                    cursor: isAvailable ? "pointer" : "default",
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {/* Active market bars */}
          {activeMarket === "spread" && hasSpreadSplits && (
            <CompactMarketRow
              title="Spread"
              ticketsPct={game.spreadAwayBetsPct}
              handlePct={game.spreadAwayMoneyPct}
              awayColor={awayColor}
              homeColor={homeColor}
              awayLineLabel={awaySpreadLabel}
              homeLineLabel={homeSpreadLabel}
            />
          )}
          {activeMarket === "total" && hasTotalSplits && (
            <CompactMarketRow
              title="Total"
              ticketsPct={game.totalOverBetsPct}
              handlePct={game.totalOverMoneyPct}
              awayColor={awayColor}
              homeColor={homeColor}
              awayLineLabel={!isNaN(bookTotal) ? `OVER ${bookTotal}` : "OVER"}
              homeLineLabel={!isNaN(bookTotal) ? `UNDER ${bookTotal}` : "UNDER"}
            />
          )}
          {activeMarket === "ml" && hasMlSplits && (
            <CompactMarketRow
              title="Moneyline"
              ticketsPct={game.mlAwayBetsPct}
              handlePct={game.mlAwayMoneyPct}
              awayColor={awayColor}
              homeColor={homeColor}
              awayLineLabel={awayMlLabel}
              homeLineLabel={homeMlLabel}
            />
          )}
        </div>
      )}

      {/* ── Tablet + desktop (≥ md): three equal minmax(0,1fr) tracks with the
           1px dividers as their own grid tracks. A divider that owns a track
           cannot be painted over by neighboring content, and minmax(0,1fr)
           makes each column shrinkable so nowrap labels ellipsize instead of
           pushing the row past the viewport. ── */}
      {isMdUp && (
        <div
          className="bsp-desktop"
          style={{
            display: "grid",
            gridTemplateColumns:
              "minmax(0,1fr) 1px minmax(0,1fr) 1px minmax(0,1fr)",
            alignItems: "stretch",
            width: "100%",
            minWidth: 0,
          }}
        >
          {/* Spread column — always rendered */}
          <div className="min-w-0">
            <MarketBlock
              title="Spread"
              awayLabel={awaySpreadLabel}
              homeLabel={homeSpreadLabel}
              ticketsPct={game.spreadAwayBetsPct}
              handlePct={game.spreadAwayMoneyPct}
              awayColor={awayColor}
              homeColor={homeColor}
            />
          </div>
          <div
            data-splits-divider
            style={{ background: "var(--dime-border)", margin: "8px 0" }}
          />
          {/* Total column — always rendered */}
          <div className="min-w-0">
            <MarketBlock
              title="Total"
              awayLabel=""
              homeLabel=""
              totalValue={isNaN(bookTotal) ? undefined : bookTotal}
              ticketsPct={game.totalOverBetsPct}
              handlePct={game.totalOverMoneyPct}
              awayColor={awayColor}
              homeColor={homeColor}
            />
          </div>
          <div
            data-splits-divider
            style={{ background: "var(--dime-border)", margin: "8px 0" }}
          />
          {/* Moneyline column — always rendered */}
          <div className="min-w-0">
            <MarketBlock
              title="Moneyline"
              awayLabel={awayMlLabel}
              homeLabel={homeMlLabel}
              ticketsPct={game.mlAwayBetsPct}
              handlePct={game.mlAwayMoneyPct}
              awayColor={awayColor}
              homeColor={homeColor}
            />
          </div>
        </div>
      )}
    </>
  );
}
