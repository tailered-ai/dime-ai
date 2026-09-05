import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "fs";
import path from "path";
import { MarketTable } from "./MarketTable";
import { TeamLogoMark } from "./TeamLogoMark";
import {
  ProjectionCard,
  rankedEdges,
  rankedNoEdgeCandidates,
} from "./ProjectionCard";
import {
  marketPaginationItems,
  projectionMarketPage,
} from "./ProjectionMarketsPopover";
import { clampActiveEdgeIndex } from "./SummaryCarousel";
import type { ProjectionGame } from "./types";

/** Round 4 Wave 2 (items 1, 5) source-contract fixtures — CSS/markup are read
 *  raw so these assertions pin the actual rules the visual smoke screenshots
 *  verify, without a browser/CSSOM in this vitest environment (same pattern
 *  as the W1 DOM-only harness note below). */
const cardCss = fs.readFileSync(
  path.join(import.meta.dirname, "ProjectionCard.css"),
  "utf8"
);
const edgeIndicatorCss = fs.readFileSync(
  path.join(import.meta.dirname, "EdgeIndicator.css"),
  "utf8"
);
const summaryCarouselSrc = fs.readFileSync(
  path.join(import.meta.dirname, "SummaryCarousel.tsx"),
  "utf8"
);
const marketPopoverSrc = fs.readFileSync(
  path.join(import.meta.dirname, "ProjectionMarketsPopover.tsx"),
  "utf8"
);
const feedSrc = fs.readFileSync(
  path.join(import.meta.dirname, "..", "..", "pages", "DimeModelFeed.tsx"),
  "utf8"
);
const lawDoc = fs.readFileSync(
  path.join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    "design-system",
    "dime-ai",
    "pages",
    "ai-model-projections.md"
  ),
  "utf8"
);

/** Slice the CSS source between two heading comments (exclusive of the second). */
function cssBlock(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start < 0 || end < 0)
    throw new Error(`CSS anchors changed: "${startMarker}" / "${endMarker}"`);
  return src.slice(start, end);
}

describe("TeamLogoMark — whitespace-free optical sizing and dark contrast", () => {
  const renderLogo = (abbr: string) =>
    renderToStaticMarkup(
      createElement(TeamLogoMark, {
        team: {
          abbr,
          name: abbr,
          logo: `https://www.mlbstatic.com/team-logos/${abbr}.svg`,
          color: null,
        },
      })
    );

  it("preserves official non-square aspect metadata instead of forcing a square image", () => {
    const yankees = renderLogo("NYY");
    const reds = renderLogo("CIN");
    expect(yankees).toContain('width="144" height="150"');
    expect(reds).toContain('width="213" height="150"');
    expect(cardCss).toMatch(
      /\.team-logo-box\s*\{[^}]*inline-size:\s*auto;[^}]*block-size:\s*clamp/
    );
    expect(cardCss).toMatch(
      /\.team-logo\s*\{[^}]*inline-size:\s*auto;[^}]*block-size:\s*100%;/
    );
    expect(cardCss).toContain(".team-logo-box--mono { aspect-ratio: 1; }");
  });

  it("outlines only allowlisted dark marks on Dark and never Light (two-mode, 2026-07-31)", () => {
    expect(renderLogo("NYY")).toContain("team-logo-box--dark-outline");
    expect(renderLogo("CHC")).not.toContain("team-logo-box--dark-outline");
    expect(cardCss).toContain(
      'html[data-theme-mode="dark"] .team-logo-box--dark-outline .team-logo'
    );
    expect(cardCss).toContain(
      'html:not([data-theme-mode]) .dmf-root[data-dmf-mode="dark"] .team-logo-box--dark-outline .team-logo'
    );
    // the retired "system" mode must not resurface in selectors
    expect(cardCss).not.toContain('data-theme-mode="system"');
    expect(cardCss).not.toContain('data-dmf-mode="system"');
    expect(cardCss).not.toContain(
      'html[data-theme-mode="light"] .team-logo-box--dark-outline .team-logo'
    );
    expect(cardCss).not.toContain(
      '.dmf-root[data-dmf-mode="light"] .team-logo-box--dark-outline .team-logo'
    );
    const outlineRule = cardCss.slice(
      cardCss.indexOf(
        'html[data-theme-mode="dark"] .team-logo-box--dark-outline'
      ),
      cardCss.indexOf(".team-logo-box--mono")
    );
    expect(countOccurrences(outlineRule, "drop-shadow(")).toBe(1);
    expect(outlineRule).toContain(
      "drop-shadow(0 0 0.2px rgba(255, 255, 255, 0.92))"
    );
    expect(outlineRule).not.toMatch(/drop-shadow\([^)]*1px/);
  });
});

/**
 * Directive §3 — single rendering ownership. The event time is owned by the card
 * header (EventHeader); MatchupPanel must NOT repeat it. This test renders the
 * real component tree (no DOM needed — react-dom/server) and asserts the time
 * appears exactly once, which is the exact regression the "3:00 PM ET × 2"
 * screenshot showed. `.test.ts` (not `.tsx`) + createElement so it matches the
 * existing vitest `client/src/**​/*.test.ts` include and needs no JSX runtime.
 */

const country = (
  name: string,
  abbr: string,
  flag: string
): ProjectionGame["away"] => ({
  abbr,
  name,
  kind: "country",
  flag,
  logo: null,
  color: null,
  score: null,
});

const side = (marketKey: string, marketLabel: string, sideLabel: string) => ({
  marketKey,
  marketLabel,
  sideLabel,
  bookPrice: null,
  bookOppPrice: null,
  modelPrice: null,
});

/** The Spain vs France semifinal from the directive screenshot. */
function wcFixture(): ProjectionGame {
  return {
    id: "wc-esp-fra",
    league: "World Cup",
    status: "scheduled",
    statusLabel: "3:00 PM ET",
    away: country("Spain", "ESP", "\u{1F1EA}\u{1F1F8}"),
    home: country("France", "FRA", "\u{1F1EB}\u{1F1F7}"),
    matchupContext: "Semifinal · SoFi Stadium (LA), Inglewood",
    venue: "SoFi Stadium (LA), Inglewood",
    startTime: "3:00 PM ET",
    markets: [
      {
        key: "dblchc",
        label: "Dbl Chc",
        sides: [
          side("dblchc", "Dbl Chc", "France Win/Draw"),
          side("dblchc", "Dbl Chc", "Spain Win/Draw"),
        ],
      },
      {
        key: "ml",
        label: "Moneyline",
        sides: [
          side("ml", "Moneyline", "Spain"),
          side("ml", "Moneyline", "France"),
        ],
      },
    ],
  };
}

/** The Giants @ Mariners card from the directive screenshot: U 7 carries a
 *  real edge (book -112, model -136) so the summary readout renders. */
function mlbFixture(): ProjectionGame {
  const team = (abbr: string, name: string): ProjectionGame["away"] => ({
    abbr,
    name,
    logo: null,
    color: "#333333",
    score: null,
  });
  return {
    id: "sf-sea",
    league: "MLB",
    status: "scheduled",
    statusLabel: "10:10 PM ET",
    away: team("SF", "Giants"),
    home: team("SEA", "Mariners"),
    matchupContext: "T-Mobile Park",
    venue: "T-Mobile Park", // equals context → the venue line must be suppressed
    startTime: "10:10 PM ET",
    markets: [
      {
        key: "runline",
        label: "Run Line",
        sides: [
          {
            marketKey: "runline",
            marketLabel: "Run Line",
            sideLabel: "Giants +1.5",
            bookPrice: null,
            bookOppPrice: null,
            modelPrice: null,
          },
          {
            marketKey: "runline",
            marketLabel: "Run Line",
            sideLabel: "Mariners -1.5",
            bookPrice: null,
            bookOppPrice: null,
            modelPrice: null,
          },
        ],
      },
      {
        key: "total",
        label: "Total",
        sides: [
          {
            marketKey: "total",
            marketLabel: "Total",
            sideLabel: "O 7",
            bookPrice: -108,
            bookOppPrice: -112,
            modelPrice: 118,
          },
          {
            marketKey: "total",
            marketLabel: "Total",
            sideLabel: "U 7",
            bookPrice: -112,
            bookOppPrice: -108,
            modelPrice: -136,
          },
        ],
      },
      {
        key: "moneyline",
        label: "Moneyline",
        sides: [
          {
            marketKey: "moneyline",
            marketLabel: "Moneyline",
            sideLabel: "Giants ML",
            bookPrice: null,
            bookOppPrice: null,
            modelPrice: null,
          },
          {
            marketKey: "moneyline",
            marketLabel: "Moneyline",
            sideLabel: "Mariners ML",
            bookPrice: null,
            bookOppPrice: null,
            modelPrice: null,
          },
        ],
      },
    ],
  };
}

function mlbPregameFixture(): ProjectionGame {
  return {
    ...mlbFixture(),
    pregameLineups: {
      source: "Rotowire",
      scrapedAt: 1_721_740_000_000,
      away: {
        pitcher: {
          name: "Logan Webb",
          hand: "R",
          seasonStats: "7-4 · 3.21 ERA",
          rotowireId: 14222,
          mlbamId: 657277,
          confirmed: true,
        },
        confirmed: true,
        battingOrder: [
          {
            battingOrder: 1,
            position: "CF",
            name: "Jung Hoo Lee",
            bats: "L",
            rotowireId: 18043,
            mlbamId: 808982,
          },
        ],
      },
      home: {
        pitcher: {
          name: "George Kirby",
          hand: "R",
          seasonStats: "8-5 · 3.62 ERA",
          rotowireId: 15669,
          mlbamId: 669923,
          confirmed: false,
        },
        confirmed: false,
        battingOrder: [],
      },
    },
  };
}

const render = (game: ProjectionGame): string =>
  renderToStaticMarkup(createElement(ProjectionCard, { game }));

const renderMarket = (game: ProjectionGame, marketIndex = 0): string => {
  const market = game.markets[marketIndex];
  if (!market)
    throw new Error(`Missing market fixture at index ${marketIndex}`);
  return renderToStaticMarkup(createElement(MarketTable, { market }));
};

const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

/** Markup with attribute values stripped, so "rendered exactly once" counts
 *  only VISIBLE text. `title` tooltips never counted; as of 2026-08-05 the card's
 *  `aria-label` also carries the status string (accessible name), which is a
 *  deliberate second copy for AT, not a second render. */
const visibleOnly = (html: string): string =>
  html.replace(/ (?:title|aria-label)="[^"]*"/g, "");

describe("ProjectionCard — single rendering ownership (directive §3)", () => {
  it("renders the event time exactly once per card (matchup block owns it)", () => {
    const html = visibleOnly(render(wcFixture()));
    expect(countOccurrences(html, "3:00 PM ET")).toBe(1);
  });

  it("header owns the status; a final card carries no start time (2026-08-05: even if one is supplied)", () => {
    // A FINAL card: the header owns the status; the center owns stage context only.
    const game: ProjectionGame = {
      ...wcFixture(),
      status: "final",
      statusLabel: "FINAL",
      // Deliberately still populated: the MatchupPanel backstop must suppress
      // both regardless of what the adapter hands it (owner directive 2026-08-05).
      venue: "SoFi Stadium (LA), Inglewood",
      startTime: "3:00 PM ET",
    };
    const html = visibleOnly(render(game));
    expect(countOccurrences(html, "FINAL")).toBe(1);
    expect(html).toContain("Semifinal"); // soccer ROUND context still renders
    expect(html).not.toContain("3:00 PM ET");
    expect(html).not.toContain("matchup__time");
    expect(html).not.toContain("matchup__venue");
  });

  it("spells out both participants and the paged market labels (§5/§6)", () => {
    const html = render(wcFixture());
    const marketHtml = renderMarket(wcFixture());
    expect(html).toContain("Spain");
    expect(html).toContain("France");
    expect(marketHtml).toContain("Spain Win/Draw");
    expect(marketHtml).toContain("France Win/Draw");
    // Flags carry the spelled-out country name as their accessible label.
    expect(html).toContain("Spain flag");
    expect(html).toContain("France flag");
  });
});

describe("ProjectionCard — no corner league label (owner directive 2026-07-18)", () => {
  it("renders no league label on any card; scheduled cards DO render the status header (2026-08-05)", () => {
    const scheduled = render(wcFixture());
    expect(scheduled).not.toContain("projection-card__league");
    // Superseded 2026-08-05: the header is no longer live/final-only — every
    // state renders one centered status line, scheduled included.
    expect(scheduled).toContain("projection-card__head");
    expect(render(mlbFixture())).not.toContain("projection-card__league");
  });

  it("live/final cards keep the status header without a league label", () => {
    const html = render({
      ...wcFixture(),
      status: "final",
      statusLabel: "FINAL",
      startTime: undefined,
    });
    expect(html).toContain("projection-card__head");
    expect(html).toContain("FINAL");
    expect(html).not.toContain("projection-card__league");
  });
});

/** Owner directive 2026-08-05 ("card status header + pregame-only venue/time",
 *  design-system/dime-ai/pages/ai-model-projections.md): ONE centered status
 *  slot for every lifecycle state, and ballpark + first pitch confined to
 *  scheduled cards. Supersedes the 2026-07-17 clause that gave the matchup
 *  block the time and the header only LIVE/FINAL. */
describe("ProjectionCard — centered lifecycle status header (owner directive 2026-08-05)", () => {
  const STATES: ReadonlyArray<[ProjectionGame["status"], string]> = [
    ["scheduled", "10:10 PM ET"],
    ["live", "LIVE · BOT 8TH"],
    ["final", "FINAL"],
    ["postponed", "POSTPONED"],
    ["suspended", "SUSPENDED"],
  ];

  it("renders exactly one status line, in the header slot, for every lifecycle state", () => {
    for (const [status, label] of STATES) {
      const html = render({
        ...mlbFixture(),
        status,
        statusLabel: label,
        pregameLineups: undefined,
      });
      expect(html).toContain("projection-card__head");
      expect(countOccurrences(html, "projection-card__head")).toBe(1);
      expect(countOccurrences(html, "projection-card__status ")).toBe(1);
      expect(html).toContain(`projection-card__status--${status}`);
      expect(html).toContain(label);
      // The header precedes the matchup row in source order (it IS the slot
      // directly above the away/home row).
      expect(html.indexOf("projection-card__head")).toBeLessThan(
        html.indexOf("matchup__grid")
      );
    }
  });

  it("centers the header slot — the old top-right flex-end placement is retired", () => {
    expect(cardCss).toMatch(
      /\.projection-card__head \{[^}]*justify-content: center;/
    );
    expect(cardCss).not.toMatch(
      /\.projection-card__head \{[^}]*justify-content: flex-end;/
    );
  });

  it("keeps the shipped micro-label register and adds tabular figures for clock states", () => {
    expect(cardCss).toMatch(
      /\.projection-card__status \{[^}]*font-size: var\(--proj-meta\)/
    );
    expect(cardCss).toMatch(
      /\.projection-card__status \{[^}]*letter-spacing: 0\.06em/
    );
    expect(cardCss).toMatch(
      /\.projection-card__status \{[^}]*text-transform: uppercase/
    );
    // Inherited from the retired .matchup__time rule: scheduled first-pitch
    // figures stay tabular now that the time lives in the header.
    expect(cardCss).toMatch(
      /\.projection-card__status \{[^}]*font-variant-numeric: tabular-nums/
    );
  });

  it("gives every state a head row in the grid, scheduled included", () => {
    // The base rule now governs every state: there is no longer a
    // `--scheduled` override dropping "head" (nor one restating the base).
    expect(cardCss).toMatch(
      /\.projection-card \{[\s\S]*?grid-template-areas: "head" "matchup" "summary" "markets";/
    );
    expect(cardCss).not.toMatch(
      /\.projection-card--scheduled \{\s*grid-template-(areas|rows)/
    );
    expect(cardCss).toMatch(
      /\.projection-card--scheduled\.projection-card--with-pregame \{\s*grid-template-areas: "head" "matchup" "pregame" "summary" "markets";/
    );
  });

  it("puts the lifecycle status in the card's accessible name", () => {
    for (const [status, label] of STATES) {
      const html = render({
        ...mlbFixture(),
        status,
        statusLabel: label,
        pregameLineups: undefined,
      });
      expect(html).toContain(`aria-label="Giants at Mariners, ${label}"`);
    }
  });

  it("prints the ballpark and the first pitch on SCHEDULED cards only, and the time exactly once", () => {
    const scheduled = visibleOnly(render(mlbFixture()));
    // Ballpark stays (it arrives as the matchup context on MLB rows).
    expect(scheduled).toContain("T-Mobile Park");
    // The time now lives in the header — never printed twice.
    expect(countOccurrences(scheduled, "10:10 PM ET")).toBe(1);
    expect(scheduled).not.toContain("matchup__time");

    for (const status of ["live", "final", "postponed", "suspended"] as const) {
      const html = render({
        ...mlbFixture(),
        status,
        statusLabel: status.toUpperCase(),
        // The adapters gate these; the panel backstops them.
        matchupContext: undefined,
        venue: "T-Mobile Park",
        startTime: "10:10 PM ET",
        pregameLineups: undefined,
      });
      expect(html).not.toContain("T-Mobile Park");
      expect(html).not.toContain("10:10 PM ET");
      expect(html).not.toContain("matchup__venue");
      expect(html).not.toContain("matchup__time");
    }
  });

  it("treats suspended as its own lifecycle state, compacted like postponed", () => {
    const html = render({
      ...mlbFixture(),
      status: "suspended",
      statusLabel: "SUSPENDED",
      pregameLineups: undefined,
    });
    expect(html).toContain("projection-card--suspended");
    expect(html).toContain("projection-card--compact");
    expect(html).toContain("SUSPENDED");
    expect(html).not.toContain("POSTPONED");
  });

  it("records the superseding directive in the page law", () => {
    const section = lawDoc.slice(
      lawDoc.indexOf(
        "Owner Directives — 2026-08-05 (card status header + pregame-only venue/time)"
      ),
      lawDoc.indexOf("Owner Directives — 2026-08-02 (responsive rebuild")
    );
    expect(section).toContain("horizontally centered");
    expect(section).toContain("SUSPENDED");
    expect(section).toContain("PREGAME-ONLY");
    // The 2026-07-17 clause it retires is named, not silently dropped.
    expect(section).toContain(
      "Scheduled games own the time in this block; the card header shows LIVE/FINAL"
    );
    // …and the lifecycle-compaction directive absorbs the venue/time rule.
    expect(lawDoc).toMatch(
      /\*\*Lifecycle compaction\.\*\*[\s\S]*?remove the ballpark and the\s*\n\s*first-pitch time\*\*/
    );
  });
});

/** Owner directive 2026-08-06 ("unplayable games: slate tier + mint rationing").
 *  A postponed or suspended game carries ZERO mint even when the model found an
 *  edge — MASTER.md: "if it isn't signal (edge/pick/live/active), it isn't
 *  mint", and an edge on a game that will not be played is not signal. The edge
 *  CONTENT stays; only the accent goes. Distinct from PASS, which means no
 *  market cleared the threshold in a game that WILL be played. */
describe("ProjectionCard — unplayable cards carry no mint (owner directive 2026-08-06)", () => {
  /** Giants @ Mariners with a real edge, in an unplayable lifecycle state. */
  const unplayable = (status: "postponed" | "suspended"): ProjectionGame => ({
    ...mlbFixture(),
    status,
    statusLabel: status.toUpperCase(),
    pregameLineups: undefined,
  });

  it("still finds a real edge on these fixtures (guards the test's own premise)", () => {
    for (const status of ["postponed", "suspended"] as const) {
      expect(rankedEdges(unplayable(status)).length).toBeGreaterThan(0);
    }
  });

  it("marks postponed and suspended cards unplayable, and never a live one", () => {
    for (const status of ["postponed", "suspended"] as const) {
      expect(render(unplayable(status))).toContain(
        "projection-card--unplayable"
      );
    }
    // In-play markets are actionable — mirrors the 2026-07-23 "a LIVE card
    // never takes the PASS treatment" ruling.
    const live = render({
      ...mlbFixture(),
      status: "live",
      statusLabel: "LIVE · BOT 8TH",
      pregameLineups: undefined,
    });
    expect(live).not.toContain("projection-card--unplayable");
    for (const status of ["scheduled", "final"] as const) {
      expect(
        render({ ...mlbFixture(), status, pregameLineups: undefined })
      ).not.toContain("projection-card--unplayable");
    }
  });

  it("keeps --unplayable distinct from --pass (opposite meanings, same treatment)", () => {
    // An unplayable card WITH edges is not a PASS card.
    const html = render(unplayable("postponed"));
    expect(html).toContain("projection-card--unplayable");
    expect(html).not.toContain("projection-card--pass");
  });

  it("neutralizes the mint chip, the market signal cells, and the edge footers", () => {
    const block = cssBlock(
      cardCss,
      "Item 3 — PASS-card law",
      "Item 4 — live indicator"
    );
    for (const sel of [
      ".projection-card--unplayable .edge-indicator",
      ".projection-card--unplayable .market-table__model--signal",
      ".projection-card--unplayable .market-table__result--edge",
      ".projection-card__markets-popover--unplayable .market-table__model--signal",
      ".projection-card__markets-popover--unplayable .market-table__result--edge",
      ".projection-card--unplayable .edge-indicator svg",
    ]) {
      expect(block).toContain(sel);
    }
  });

  it("neutralizes the carousel advance arrow, which is otherwise mint", () => {
    // .projection-card .summary__next is `color: var(--brand-mint)`. On an
    // unplayable card that arrow is a carousel control, not a model signal —
    // the same reasoning as .summary-carousel--no-edge.
    expect(cardCss).toMatch(
      /\.projection-card--unplayable \.summary__next \{[^}]*color: var\(--foreground/
    );
  });

  it("threads the flag to the popover, which portals outside the card", () => {
    // The floating surface is not a descendant of .projection-card, so a
    // descendant selector cannot reach it — it needs its own class.
    expect(
      fs.readFileSync(
        path.join(import.meta.dirname, "ProjectionMarketsPopover.tsx"),
        "utf8"
      )
    ).toMatch(
      /isUnplayable[\s\S]*?projection-card__markets-popover--unplayable/
    );
  });

  it("leaves the edge CONTENT and the accessible names untouched", () => {
    const html = render(unplayable("postponed"));
    // The pick, the percentage and the popover trigger all still render.
    expect(html).toContain("Under 7"); // the fixture's edge side, spelled out
    expect(html).toContain("edge-indicator");
    expect(html).toContain("View full AI model projections");
    // The lifecycle state still leads the card's accessible name (2026-08-05),
    // so the announcement and the visual continue to agree.
    expect(html).toContain('aria-label="Giants at Mariners, POSTPONED"');
  });

  it("no longer overshoots the compaction remap to bare --foreground", () => {
    // The overshoot is what made non-actionable cards the brightest ink on the
    // slate. Both remapped tokens must resolve to a bounded mid tone instead.
    expect(cardCss).not.toMatch(
      /\.projection-card--compact \{[^}]*--text-secondary: var\(--foreground\);/
    );
    // One rule, both themes: --foreground and --background flip together, so
    // "82% ink toward the page ground" is a light grey on dark and a dark grey
    // on light without a per-theme override.
    for (const token of ["--text-secondary", "--text-muted"]) {
      expect(cardCss).toMatch(
        new RegExp(
          `\\.projection-card--compact \\{[\\s\\S]*?${token}: color-mix\\(\\s*in srgb,\\s*var\\(--foreground\\)\\s*82%,\\s*var\\(--background\\)\\s*\\)`
        )
      );
    }
    // No per-theme override should be needed or present for these tokens.
    expect(cardCss).not.toMatch(
      /html:not\(\.dark\) \.projection-card--compact \{\s*--text-secondary/
    );
  });

  it("deepens the light-theme live mint to clear the AA floor it was missing", () => {
    // 60% composited to 4.4969:1 — short of 4.5 by 0.003.
    expect(cardCss).toMatch(
      /html:not\(\.dark\) \.projection-card--compact \.projection-card__status--live \{[\s\S]*?var\(--mint-ink[^)]*\) 50%,/
    );
    expect(cardCss).not.toMatch(/var\(--mint-ink[^)]*\) 60%,/);
  });

  it("keeps every remapped tone achromatic (Three-Color Law v2: R == G == B)", () => {
    // Mixing the two achromatic extremes can only produce a grey. Guard against
    // a future chromatic substitution, and against raw hex (X-HEX ratchet).
    // NB: match whole declarations — a `[^)]*` character class cannot span the
    // nested `var(...)` and silently truncates the value it is meant to check.
    const compact = cssBlock(
      cardCss,
      "Pregame detail makes upcoming MLB cards",
      "A settled no-edge card can carry both modifiers"
    );
    const decls = compact.match(/--text-(?:secondary|muted):[^;]+;/g) ?? [];
    expect(decls).toHaveLength(2);
    for (const d of decls) {
      expect(d).toMatch(
        /color-mix\(\s*in srgb,\s*var\(--foreground\)\s*\d+%,\s*var\(--background\)\s*\)/
      );
      expect(d).not.toMatch(/#[0-9a-f]{3,8}/i);
    }
  });

  it("records the directive in the page law", () => {
    const section = lawDoc.slice(
      lawDoc.indexOf(
        "Owner Directives — 2026-08-06 (unplayable games: slate tier + mint rationing)"
      ),
      lawDoc.indexOf("Owner Directives — 2026-08-05 (card status header")
    );
    expect(section).toContain("LIVE > upcoming > settled");
    expect(section).toContain("Zero mint on an unplayable card");
    expect(section).toContain("Record<GameStatus, number>");
    // Owner authorization, 2026-08-06 — this section is live law, not a
    // proposal. The scope fence matters as much as the approval: it must stay
    // explicit that the deferred contrast remedy is NOT covered, so nobody
    // later reads "owner-approved" as blanket permission to change the token.
    expect(section).toContain(
      "APPROVED AND AUTHORIZED by the owner, 2026-08-06"
    );
    expect(section).toContain(
      "Neither may be shipped on the strength of this approval"
    );
    expect(section).toMatch(/4\.4969:1/);
    // The superseded 2026-07-18 tier clause carries a forward pointer.
    expect(lawDoc).toMatch(
      /LIVE > upcoming > FINAL tiers\)\.\s*\n\s*\*\(AMENDED 2026-08-06/
    );
  });
});

/** Dodgers @ Yankees with TWO real edges (the 2026-07-18 directive screenshot):
 *  Yankees ML +9.1pp (book -105, model -152) outranks Under 9 +7.6pp (book
 *  -115, model -157); the run line is dead even (no edge). Labels arrive
 *  pre-spelled from the presentation layer ("Yankees ML", "Under 9"). */
function multiEdgeFixture(): ProjectionGame {
  const team = (abbr: string, name: string): ProjectionGame["away"] => ({
    abbr,
    name,
    logo: null,
    color: "#333333",
    score: null,
  });
  return {
    id: "lad-nyy",
    league: "MLB",
    status: "scheduled",
    statusLabel: "7:05 PM ET",
    away: team("LAD", "Dodgers"),
    home: team("NYY", "Yankees"),
    matchupContext: "Yankee Stadium",
    venue: "Yankee Stadium",
    startTime: "7:05 PM ET",
    markets: [
      {
        key: "run-line",
        label: "Run Line",
        sides: [
          {
            marketKey: "run-line",
            marketLabel: "Run Line",
            sideLabel: "Dodgers -1.5",
            bookPrice: 140,
            bookOppPrice: -170,
            modelPrice: 140,
          },
          {
            marketKey: "run-line",
            marketLabel: "Run Line",
            sideLabel: "Yankees +1.5",
            bookPrice: -170,
            bookOppPrice: 140,
            modelPrice: -170,
          },
        ],
      },
      {
        key: "total",
        label: "Total",
        sides: [
          {
            marketKey: "total",
            marketLabel: "Total",
            sideLabel: "Over 9",
            bookPrice: -105,
            bookOppPrice: -115,
            modelPrice: 130,
          },
          {
            marketKey: "total",
            marketLabel: "Total",
            sideLabel: "Under 9",
            bookPrice: -115,
            bookOppPrice: -105,
            modelPrice: -157,
          },
        ],
      },
      {
        key: "moneyline",
        label: "Moneyline",
        sides: [
          {
            marketKey: "moneyline",
            marketLabel: "Moneyline",
            sideLabel: "Dodgers ML",
            bookPrice: -115,
            bookOppPrice: -105,
            modelPrice: 152,
          },
          {
            marketKey: "moneyline",
            marketLabel: "Moneyline",
            sideLabel: "Yankees ML",
            bookPrice: -105,
            bookOppPrice: -115,
            modelPrice: -152,
          },
        ],
      },
    ],
  };
}

describe("ProjectionCard — ranked edge carousel (owner directive 2026-07-18)", () => {
  it("keeps one arrow keyboard-reachable when a live edge list shrinks", () => {
    expect(clampActiveEdgeIndex(2, 3)).toBe(2);
    expect(clampActiveEdgeIndex(2, 2)).toBe(1);
    expect(clampActiveEdgeIndex(2, 0)).toBe(0);
  });

  it("2+ edges render the swipe strip, strongest first, weakest last", () => {
    const html = render(multiEdgeFixture());
    expect(html).toContain("summary-carousel");
    expect(countOccurrences(html, "summary-carousel__slide")).toBe(2);
    // Ranked: Yankees ML (+9.1pp) leads, Under 9 (+7.6pp) closes the strip.
    expect(html.indexOf("Yankees ML")).toBeGreaterThan(-1);
    expect(html.indexOf("Yankees ML")).toBeLessThan(html.indexOf("Under 9"));
    expect(countOccurrences(html, 'class="summary__next"')).toBe(2);
    expect(html).toContain("lucide-chevron-right");
    expect(html).toContain("View next model edge: Under 9 (2 of 2)");
  });

  it("no-edge markets stay out and the old visible count/dot chrome is gone", () => {
    const html = render(multiEdgeFixture());
    // Slides are labeled with their pick; the dead-even run line gets none.
    expect(html).not.toContain("of 2: Dodgers -1.5");
    expect(html).not.toContain("of 2: Yankees +1.5");
    expect(html).not.toContain("summary-carousel__nav");
    expect(html).not.toContain("summary-carousel__count");
    expect(html).not.toContain("summary-carousel__dot");
  });

  it("a single-edge card keeps the plain summary with no carousel arrow", () => {
    const html = render(mlbFixture());
    expect(html).not.toContain("summary-carousel");
    expect(html).not.toContain("summary__next");
    expect(html).toContain('summary__pick">Under 7<');
  });

  it("the moneyline edge readout carries the market: 'Yankees ML', never bare 'Yankees'", () => {
    const html = render(multiEdgeFixture());
    expect(html).toContain('summary__pick">Yankees ML<');
    expect(html).not.toContain('summary__pick">Yankees<');
  });
});

describe("ProjectionCard — matchup block format (owner directive 2026-07-17)", () => {
  it("keeps full country names accessible when canonical codes fit the compact lane", () => {
    const html = render(wcFixture());
    expect(html).toContain("Spain");
    expect(html).toContain("France");
    expect(html).toContain('aria-label="Spain at France"');
    expect(html).toContain('title="Spain @ France"');
  });

  it("renders the ballpark exactly once (no duplicate venue line)", () => {
    // venue is contained in the context line, so the venue line is suppressed.
    // Strip title="" tooltip attributes — only VISIBLE text counts as a render.
    const visible = visibleOnly(render(wcFixture()));
    expect(countOccurrences(visible, "SoFi Stadium (LA), Inglewood")).toBe(1);
  });

  it("MLB card reads NAME @ NAME / ballpark / first pitch — no abbrs, no pitchers", () => {
    const visible = visibleOnly(render(mlbFixture()));
    expect(visible).toContain("Giants");
    expect(visible).toContain("Mariners");
    expect(visible).not.toContain("SF Giants"); // names only in the matchup line
    expect(countOccurrences(visible, "T-Mobile Park")).toBe(1);
    expect(countOccurrences(visible, "10:10 PM ET")).toBe(1);
  });

  it("spells out the MODEL EDGE pick and labels the readout BOOK", () => {
    // U 7 carries the edge (book -112 vs model -136, the directive screenshot).
    const html = render(mlbFixture());
    expect(html).toContain('summary__pick">Under 7<');
    expect(html).toContain(">Book<");
    expect(html).not.toContain("Best price");
  });

  it("labels market columns BOOK / MODEL and offers the projections popover", () => {
    const html = render(wcFixture());
    const marketHtml = renderMarket(wcFixture());
    expect(marketHtml).toContain(">Book<");
    expect(marketHtml).toContain(">Model<");
    expect(marketHtml).not.toMatch(/Sportsbook price|Model fair price/);
    expect(html).toContain("View full AI model projections");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain("<details");
  });
});

describe("ProjectionCard — paginated market popover", () => {
  it("shows all three MLB market pages in source order", () => {
    expect(mlbFixture().markets.map(market => market.label)).toEqual([
      "Run Line",
      "Total",
      "Moneyline",
    ]);
    expect(marketPaginationItems(0, 3)).toEqual([0, 1, 2]);
    expect(marketPaginationItems(1, 3)).toEqual([0, 1, 2]);
    expect(marketPaginationItems(2, 3)).toEqual([0, 1, 2]);
  });

  it("keeps larger World Cup slates reachable with a compact ellipsis window", () => {
    const baseMarket = wcFixture().markets[0];
    const markets = Array.from({ length: 7 }, (_, index) => ({
      ...baseMarket,
      key: `market-${index + 1}`,
      label: `Market ${index + 1}`,
    }));

    for (let page = 0; page < markets.length; page += 1) {
      expect(projectionMarketPage(markets, page)).toEqual({
        activePage: page,
        activeMarket: markets[page],
      });
    }
    expect(
      Array.from(
        new Set(
          markets.flatMap((_, page) =>
            marketPaginationItems(page, markets.length).filter(
              (item): item is number => typeof item === "number"
            )
          )
        )
      ).sort((a, b) => a - b)
    ).toEqual([0, 1, 2, 3, 4, 5, 6]);

    expect(marketPaginationItems(0, 7)).toEqual([0, 1, 2, "ellipsis-end", 6]);
    expect(marketPaginationItems(3, 7)).toEqual([
      0,
      "ellipsis-start",
      3,
      "ellipsis-end",
      6,
    ]);
    expect(marketPaginationItems(6, 7)).toEqual([0, "ellipsis-start", 4, 5, 6]);
  });

  it("binds the actual popover to the complete dynamic market list", () => {
    expect(marketPopoverSrc).toContain(
      "projectionMarketPage(\n    game.markets,\n    requestedPage"
    );
    expect(marketPopoverSrc).toContain(
      "marketPaginationItems(activePage, marketCount)"
    );
    expect(marketPopoverSrc).toContain("<MarketTable market={activeMarket} />");
    expect(marketPopoverSrc).not.toMatch(/markets\.(?:slice|splice)\(/);
  });

  it("uses theme-safe portal tokens and remains scroll-contained", () => {
    const popoverCss = cssBlock(
      cardCss,
      "The portal is outside",
      "Market table — flat"
    );
    expect(popoverCss).toContain("background: var(--popover, #141414);");
    expect(popoverCss).toContain("color: var(--popover-foreground, #fff);");
    expect(popoverCss).toContain(
      "max-block-size: min(34rem, var(--radix-popover-content-available-height));"
    );
    expect(popoverCss).toContain("overflow-y: auto;");
    expect(marketPopoverSrc).not.toContain("projection-card__markets-eyebrow");
    expect(marketPopoverSrc).toContain('aria-label="Close full model projections"');
    expect(popoverCss).not.toMatch(/#0a7c50/i);
  });

  it("renders no empty popover trigger when a game has no markets", () => {
    const html = render({ ...mlbFixture(), markets: [] });
    expect(html).not.toContain("projection-card__markets-toggle");
    expect(marketPaginationItems(0, 0)).toEqual([]);
  });
});

/** Round 4 Wave 1 — card anatomy (docs/superpowers/plans/2026-07-23-feed-desktop-polish.md,
 *  items 2/3/4; law: design-system/dime-ai/pages/ai-model-projections.md). These pin the
 *  RENDERED STRUCTURE (class names, DOM order) that the desktop/tablet-scoped CSS in
 *  ProjectionCard.css hooks — the actual 24px/opacity/mint-on-light/pulse values are CSS,
 *  verified separately by the visual smoke screenshots, not by this DOM-only harness. */
describe("ProjectionCard — unified score row (Round 4 Wave 1, item 2)", () => {
  /** A live/final game: both scores present, so MatchupPanel's showScore branch fires. */
  function scoredFixture(): ProjectionGame {
    const team = (
      abbr: string,
      name: string,
      score: number
    ): ProjectionGame["away"] => ({
      abbr,
      name,
      logo: null,
      color: "#333333",
      score,
    });
    return {
      id: "lad-nyy-final",
      league: "MLB",
      status: "final",
      statusLabel: "FINAL",
      away: team("LAD", "Dodgers", 4),
      home: team("NYY", "Yankees", 2),
      matchupContext: "Yankee Stadium",
      venue: "Yankee Stadium",
      markets: [],
    };
  }

  it("renders away logo/score, the matchup line, and home score/logo on one optical row", () => {
    const html = render(scoredFixture());
    // Both scores render via the same tabular-nums score class.
    expect(html.match(/class="matchup__score score-value"/g)).toHaveLength(2);
    // DOM order: away score, THEN the "Dodgers @ Yankees" center line, THEN home score —
    // the exact away-logo·away-score·"Away @ Home"·home-score·home-logo sequence.
    const awayScoreIdx = html.indexOf(">4<");
    const centerIdx = html.indexOf("matchup__center");
    const homeScoreIdx = html.indexOf(">2<");
    expect(awayScoreIdx).toBeGreaterThan(-1);
    expect(awayScoreIdx).toBeLessThan(centerIdx);
    expect(centerIdx).toBeLessThan(homeScoreIdx);
  });

  it("scheduled games (no score) keep the current layout — no score row at all", () => {
    const html = render(mlbFixture());
    expect(html).not.toContain("matchup__score");
    expect(cardCss).toMatch(
      /\.matchup__grid\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto;/
    );
    expect(cardCss).toContain(
      ".matchup__team--away { justify-content: flex-end; }"
    );
    expect(cardCss).toContain(
      ".matchup__team--home { justify-content: flex-start; }"
    );
  });
});

describe("ProjectionCard — PASS-card law (Round 4 Wave 1, item 3)", () => {
  /** A game with a real market but neither side clears the WATCH threshold —
   *  a genuine whole-card PASS (edgePP well under 1.5pp both sides). */
  function passFixture(): ProjectionGame {
    const team = (abbr: string, name: string): ProjectionGame["away"] => ({
      abbr,
      name,
      logo: null,
      color: "#333333",
      score: null,
    });
    return {
      id: "oak-tex",
      league: "MLB",
      status: "scheduled",
      statusLabel: "7:05 PM ET",
      away: team("OAK", "Athletics"),
      home: team("TEX", "Rangers"),
      matchupContext: "Globe Life Field",
      venue: "Globe Life Field",
      startTime: "7:05 PM ET",
      markets: [
        {
          key: "moneyline",
          label: "Moneyline",
          sides: [
            {
              marketKey: "moneyline",
              marketLabel: "Moneyline",
              sideLabel: "Athletics ML",
              bookPrice: -110,
              bookOppPrice: -110,
              modelPrice: -110,
            },
            {
              marketKey: "moneyline",
              marketLabel: "Moneyline",
              sideLabel: "Rangers ML",
              bookPrice: -110,
              bookOppPrice: -110,
              modelPrice: -110,
            },
          ],
        },
      ],
    };
  }

  it("carries the projection-card--pass modifier when no market clears the edge threshold", () => {
    expect(render(passFixture())).toContain("projection-card--pass");
    expect(render(mlbFixture())).not.toContain("projection-card--pass"); // Under 7 IS a real edge
  });

  it("uses the SAME structured summary grid as an edge card and keeps the best candidate visible", () => {
    const html = render(passFixture());
    expect(html).toContain("summary__readout");
    expect(html).toContain('summary__pick">Athletics ML<');
    expect(html).toContain("ROI +4.8%");
    expect(html).not.toContain(">No edge<");
    expect(html).toContain(
      'aria-label="No actionable edge: Athletics ML; no-vig ROI +4.8%"'
    );
    // A priced PASS uses the standard MODEL EDGE / BOOK / MODEL facts, never
    // the unavailable-data sentence or a divergent standalone <p>.
    expect(html).not.toContain(
      "Every market is efficiently priced. No action."
    );
    expect(html).not.toMatch(/<p class="summary__none/);
  });

  it("renders zero mint signal anywhere on a genuine PASS card", () => {
    const html = render(passFixture());
    expect(html).toContain("edge-indicator--none"); // ROI-only neutral badge occupies the signal slot
    expect(html).not.toContain("lucide-minus");
    expect(html).not.toContain('"edge-indicator summary__edge"'); // the signal (mint) variant never appears
    expect(html).not.toContain("market-table__model--signal");
    expect(html).not.toContain("market-table__result--edge");
  });

  it("ranks one candidate per market by expected ROI, retaining negative ROI and neutral non-actionable semantics", () => {
    const game: ProjectionGame = {
      ...passFixture(),
      markets: [
        {
          key: "runline",
          label: "Run Line",
          sides: [
            {
              marketKey: "runline",
              marketLabel: "Run Line",
              sideLabel: "Athletics +1.5",
              bookPrice: -120,
              bookOppPrice: -120,
              modelPrice: 125,
            },
            {
              marketKey: "runline",
              marketLabel: "Run Line",
              sideLabel: "Rangers -1.5",
              bookPrice: -120,
              bookOppPrice: -120,
              modelPrice: 130,
            },
          ],
        },
        {
          key: "total",
          label: "Total",
          sides: [
            {
              marketKey: "total",
              marketLabel: "Total",
              sideLabel: "Over 8.5",
              bookPrice: -105,
              bookOppPrice: -105,
              modelPrice: 105,
            },
            {
              marketKey: "total",
              marketLabel: "Total",
              sideLabel: "Under 8.5",
              bookPrice: -105,
              bookOppPrice: -105,
              modelPrice: 120,
            },
          ],
        },
        {
          key: "moneyline",
          label: "Moneyline",
          sides: [
            {
              marketKey: "moneyline",
              marketLabel: "Moneyline",
              sideLabel: "Athletics ML",
              bookPrice: -110,
              bookOppPrice: -110,
              modelPrice: 110,
            },
            {
              marketKey: "moneyline",
              marketLabel: "Moneyline",
              sideLabel: "Rangers ML",
              bookPrice: -110,
              bookOppPrice: -110,
              modelPrice: 115,
            },
          ],
        },
      ],
    };
    const ranked = rankedNoEdgeCandidates(game);
    expect(ranked.map(item => item.marketKey)).toEqual([
      "total",
      "moneyline",
      "runline",
    ]);
    expect(ranked.map(item => item.sideLabel)).toEqual([
      "Over 8.5",
      "Athletics ML",
      "Athletics +1.5",
    ]);
    expect(ranked.every(item => item.roiPct != null && item.roiPct < 0)).toBe(
      true
    );
    expect(ranked.every(item => item.recommendation === "NO_EDGE")).toBe(true);

    const html = render(game);
    expect(countOccurrences(html, "summary-carousel__slide")).toBe(3);
    expect(countOccurrences(html, ">No edge<")).toBe(0);
    expect(countOccurrences(html, "edge-indicator--none")).toBe(3);
    expect(countOccurrences(html, "No actionable edge:")).toBe(3);
    expect(html.indexOf("Over 8.5")).toBeLessThan(html.indexOf("Athletics ML"));
    expect(html.indexOf("Athletics ML")).toBeLessThan(
      html.indexOf("Athletics +1.5")
    );
    expect(html).toContain("ROI −2.4%");
    expect(html).toContain("ROI −4.8%");
    expect(html).toContain("ROI −11.1%");
    expect(html).toContain(
      "non-actionable market projections, ranked by no-vig ROI"
    );
    expect(html).toContain("View next projection:");
    expect(html).toContain("summary-carousel--no-edge");
    expect(cardCss).toMatch(
      /\.summary-carousel--no-edge \.summary__next\s*\{[^}]*color:\s*var\(--foreground/
    );
  });

  it("keeps the unavailable-data sentence only when no market side can be scored", () => {
    const html = render(wcFixture());
    expect(html).toContain("Every market is efficiently priced. No action.");
    expect(html).toContain('class="summary__item summary__item--message"');
    expect(html).not.toContain("edge-indicator--none");
    expect(html).not.toContain("summary__signal");
  });
});

describe("ProjectionCard — live indicator (Round 4 Wave 1, item 4)", () => {
  it("a live card renders the pulsing dot beside the status label", () => {
    const html = render({
      ...wcFixture(),
      status: "live",
      statusLabel: "LIVE · TOP 5TH",
      startTime: undefined,
    });
    expect(html).toContain("projection-card__live-dot");
    expect(html).toContain("projection-card__status--live");
    expect(html).toContain("LIVE · TOP 5TH");
    // The dot precedes the label text inside the same status span. Match the
    // LAST occurrence: since 2026-08-05 the status string also appears earlier,
    // in the card's aria-label (accessible name), which is not the visible one.
    expect(html.indexOf("projection-card__live-dot")).toBeLessThan(
      html.lastIndexOf("LIVE · TOP 5TH")
    );
  });

  it("final and scheduled cards never render the live dot", () => {
    const final = render({
      ...wcFixture(),
      status: "final",
      statusLabel: "FINAL",
      startTime: undefined,
    });
    expect(final).not.toContain("projection-card__live-dot");
    const scheduled = render(wcFixture());
    expect(scheduled).not.toContain("projection-card__live-dot");
  });
});

describe("ProjectionCard — Rotowire pregame context", () => {
  it("shows both probable pitchers and the centered LINEUPS trigger on scheduled MLB cards", () => {
    const html = render(mlbPregameFixture());
    expect(html).toContain("projection-card--with-pregame");
    expect(html).toContain('aria-label="Probable pitchers"');
    expect(html).toContain("Logan Webb");
    expect(html).toContain("7-4 · 3.21 ERA");
    expect(html).toContain("George Kirby");
    expect(html).toContain("8-5 · 3.62 ERA");
    expect(html).toContain(">Confirmed<");
    expect(html).toContain(">Expected<");
    expect(html).toContain(">Lineups<");
    expect(html).toContain("View lineups for Giants at Mariners");
    expect(html).toContain('data-headshot-source="mlb"');
  });

  it("precisely top-centers headshots and renders LINEUPS as the mint, black, 44px CTA", () => {
    expect(cardCss).toMatch(
      /\.pregame-pitcher__photo\s*\{[^}]*place-items:\s*start center;/
    );
    expect(cardCss).toMatch(
      /\.pregame-pitcher__photo img\[data-headshot-source="mlb"\]\s*\{[^}]*object-fit:\s*contain;[^}]*object-position:\s*center top;[^}]*transform:\s*scale\(0\.82\);[^}]*transform-origin:\s*center top;/
    );
    expect(cardCss).toMatch(
      /\.pregame-pitcher__photo img\[data-headshot-source="rotowire"\]\s*\{[^}]*object-fit:\s*cover;[^}]*object-position:\s*center;[^}]*transform:\s*scale\(0\.9\);[^}]*transform-origin:\s*center;/
    );
    // Audit DIME-UI-014: LINEUPS is a quiet raised chip — mint fill is
    // rationed to the edge signal, so the chip must NOT carry the raw mint.
    expect(cardCss).toMatch(
      /\.pregame-pitchers__lineups\s*\{[^}]*min-block-size:\s*44px;[^}]*color:\s*var\(--foreground\);[^}]*background:\s*var\(--surface-raised\);[^}]*border-radius:\s*12px;/
    );
    expect(cardCss).toMatch(
      /\.pregame-pitchers__lineups:active\s*\{\s*transform:\s*scale\(0\.98\);\s*\}/
    );
  });

  it("keeps complete pitcher names on one line in equal tracks at EVERY viewport (container-driven)", () => {
    expect(cardCss).toMatch(
      /\.pregame-pitcher__name\s*\{[^}]*overflow-wrap:\s*anywhere;/
    );
    const compactPregame = cardCss.slice(
      cardCss.indexOf("Compact cards keep both complete pitcher names"),
      cardCss.indexOf("Deep-narrow defensive tier")
    );
    // 2026-08-02: card-width-driven only — the old <=1023.98px media wrapper
    // exempted desktop 3-across cards (the narrowest in the product), which
    // wrapped "Matthew Liberatore" onto two lines while phones one-lined it.
    expect(compactPregame).not.toContain("@media (max-width: 1023.98px)");
    expect(compactPregame).toContain("@container projcard (max-width: 472px)"); // 2026-08-05: content-box-corrected (~520px border-box cards)
    expect(compactPregame).toMatch(
      /\.pregame-pitchers\s*\{[^}]*position:\s*relative;[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/
    );
    expect(compactPregame).toMatch(
      /\.pregame-pitcher__name\s*\{[^}]*overflow-wrap:\s*normal;[^}]*white-space:\s*nowrap;/
    );
    // Audit DIME-UI-004: explicit grid placement (row 1, full-span, centered)
    // replaced the absolute overlay whose auto-placement wrapped the home
    // pitcher onto a diagonal second row at 390px.
    expect(compactPregame).toMatch(
      /\.pregame-pitchers__lineups\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*grid-row:\s*1;[^}]*place-self:\s*center;[^}]*min-inline-size:\s*4rem;/
    );
    expect(compactPregame).toMatch(
      /\.pregame-pitcher--away\s*\{\s*grid-row:\s*1;\s*\}/
    );
  });

  it("the deep-narrow (<=280px card) tier is a pure container tier — no viewport media", () => {
    const deepNarrow = cardCss.slice(
      cardCss.indexOf("Deep-narrow defensive tier"),
      cardCss.indexOf("The dialog is portalled")
    );
    // 2026-08-02: the old @media(min-width:1024px) wrapper is gone — under
    // the content-driven grid no multi-column card can resolve below ~305px,
    // so this tier is a container-scoped backstop for extreme hosts.
    expect(deepNarrow).not.toContain("@media (min-width: 1024px)");
    expect(deepNarrow).toContain("@container projcard (max-width: 246px)"); // 2026-08-05: content-box-corrected (~280px border-box cards)
    expect(deepNarrow).toMatch(
      /\.pregame-pitchers\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 3rem minmax\(0, 1fr\);[^}]*gap:\s*2px;/
    );
    // Its summary group stays the single-column two-row anatomy.
    expect(deepNarrow).toMatch(
      /\.summary__group \{ grid-template-columns: minmax\(0, auto\); \}/
    );
  });

  it("never renders stale pregame data after a game becomes live, final, postponed, or suspended", () => {
    for (const status of ["live", "final", "postponed", "suspended"] as const) {
      const html = render({
        ...mlbPregameFixture(),
        status,
        statusLabel:
          status === "live" ? "LIVE · TOP 1ST" : status.toUpperCase(),
        startTime: undefined,
      });
      expect(html).toContain(`projection-card--${status}`);
      expect(html).toContain("projection-card--compact");
      expect(html).not.toContain("projection-card--with-pregame");
      expect(html).not.toContain("Logan Webb");
      expect(html).not.toContain(">Lineups<");
    }
  });

  it("pins compact cards to their natural height and applies the diminished treatment", () => {
    expect(cardCss).toMatch(
      /\.projection-card--compact\s*\{[\s\S]*?align-self:\s*start;/
    );
    expect(cardCss).toMatch(
      /\.projection-card--compact\s*\{[\s\S]*?opacity:\s*0\.72;/
    );
    expect(cardCss).toMatch(
      /\.projection-card--scheduled\.projection-card--with-pregame\s*\{[\s\S]*?grid-template-areas:\s*"head"\s*"matchup"\s*"pregame"\s*"summary"\s*"markets";/
    );
  });
});

/** Round 4 Wave 2 (docs/superpowers/plans/2026-07-23-feed-desktop-polish.md, items 1/5;
 *  law: design-system/dime-ai/pages/ai-model-projections.md). Item 1 (equal-height rows,
 *  pinned market trigger) and item 5 (fixed-track summary alignment) are CSS-Grid contracts with
 *  no new DOM nodes, so — same as W1's note above — the structural proof here is (a) the DOM
 *  hooks the CSS keys off (class names) and (b) reading the actual CSS/markup source for the
 *  numeric contract itself; the rendered pixels are verified separately by the visual smoke
 *  screenshots (equal row heights, pinned trigger, aligned columns), not by this harness. */
describe("ProjectionCard — equal-height rows & pinned market trigger (Round 4 Wave 2, item 1)", () => {
  it("the league grid is CONTENT-driven: 2-up at >=622px and 3-up at >=940px of league-body width, container queries only", () => {
    const feedCss = fs.readFileSync(
      path.join(import.meta.dirname, "..", "..", "pages", "dimeModelFeed.css"),
      "utf8"
    );
    const flatFeedCss = feedCss.replace(/\s+/g, " ");
    expect(flatFeedCss).toMatch(
      /@container dmf-league \(min-width: 622px\) \{ \.dmf-leaguebody \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); align-items: stretch; \} \}/
    );
    // FEED-CL01a regression guard (generalized 2026-08-02): every column rule
    // keys off the league body's own width — a viewport media query here
    // recreates the ~194px-card crest-overhang band inside the app shell.
    expect(flatFeedCss).toMatch(
      /@container dmf-league \(min-width: 940px\) \{ \.dmf-leaguebody \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); align-items: stretch; \} \}/
    );
    expect(flatFeedCss).toContain(
      ".dmf-league { display: block; container: dmf-league / inline-size; }"
    );
    expect(feedCss).not.toMatch(
      /@media[^{]*\{[^{]*\.dmf-leaguebody \{ grid-template-columns/
    );
  });

  it("the law doc records the content-driven density contract and multi-column stretch behavior", () => {
    const section = lawDoc.slice(
      lawDoc.indexOf("Owner Directives — 2026-07-23 (responsive feed density)"),
      lawDoc.indexOf("Owner Directives — 2026-07-18 (edge labeling")
    );
    expect(section).toContain("622px");
    expect(section).toContain("940px");
    expect(section).toContain("container");
    expect(section).toContain("stretch");
  });

  it("the card carries a flexible summary row so surplus height centers there, trigger pinned last — at every viewport", () => {
    const item1 = cssBlock(
      cardCss,
      "Round 4 Wave 2 — item 1",
      "── Summary carousel"
    );
    // 2026-08-02: unconditional (was >=1024px-only) — the container grid
    // stretches row-mates at every multi-column width; in a 1-up row the 1fr
    // resolves to natural height, so mobile is unchanged.
    expect(item1).not.toContain("@media (min-width: 1024px)");
    // grid-template-areas order is head/matchup/summary/markets at EVERY state
    // (2026-08-05: scheduled no longer drops head) — the row-track list must
    // line up 1:1: fixed, fixed, 1fr (surplus absorber), fixed (pinned last).
    expect(item1).toMatch(
      /\.projection-card\s*\{\s*grid-template-rows:\s*auto auto 1fr auto;\s*\}/
    );
    // 2026-08-05: no `--scheduled` track override survives — the base list
    // covers it now that the head row is unconditional.
    expect(item1).not.toMatch(
      /\.projection-card--scheduled\s*\{\s*grid-template-rows/
    );
    // The carousel variant of the summary area also centers in its surplus row.
    expect(item1).toMatch(
      /\.summary-carousel\s*\{\s*align-content:\s*center;\s*\}/
    );
  });

  it("item 1's grid-template-rows contract is declared exactly once (in the item-1 section)", () => {
    const beforeItem1 = cardCss.slice(
      0,
      cardCss.indexOf("Round 4 Wave 2 — item 1")
    );
    expect(beforeItem1).not.toMatch(/grid-template-rows:\s*auto auto 1fr auto/);
  });
});

describe("ProjectionCard — centered single-row summary group", () => {
  it("an edge card's readout carries the fixed-track modifier classes (edge/book/model)", () => {
    const html = render(mlbFixture());
    expect(html).toContain('class="summary__item summary__item--edge"');
    expect(html).toContain('class="summary__item summary__item--book"');
    expect(html).toContain('class="summary__item summary__item--model"');
  });

  it("an unavailable-data card's message item spans the value columns", () => {
    const passHtml = render(wcFixture());
    expect(passHtml).toContain("projection-card--pass");
    expect(passHtml).toContain('class="summary__item summary__item--message"');
    expect(passHtml).not.toContain("summary__item--edge");
    expect(passHtml).not.toContain("summary__item--book");
  });

  it("centers the readout and signal together as one intrinsic-width group", () => {
    const centered = cssBlock(
      cardCss,
      "Centered summary group",
      "Round 4 Wave 2 — item 1"
    );
    expect(render(mlbFixture())).toContain("summary__viewport");
    expect(render(mlbFixture())).toContain("summary__group");
    expect(cardCss).toMatch(
      /\.summary__group\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;[^}]*justify-content:\s*center;/
    );
    expect(cardCss).toMatch(
      /\.summary__readout\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*max-content minmax\(48px, max-content\) minmax\(48px, max-content\);/
    );
    expect(cardCss).toMatch(
      /\.summary__viewport\s*\{[^}]*display:\s*grid;[^}]*justify-content:\s*safe center;[^}]*justify-items:\s*safe center;/
    );
    expect(cardCss).toContain(".summary__item--edge { grid-column: 1; }");
    expect(cardCss).toContain(".summary__item--book { grid-column: 2; }");
    expect(cardCss).toContain(".summary__item--model { grid-column: 3; }");
    expect(cardCss).not.toContain(".summary__readout { display: contents; }");
    expect(centered).not.toContain("minmax(max-content, 1fr)");
    expect(cardCss).toMatch(/\.summary__pick\s*\{[^}]*white-space:\s*nowrap;/);
    expect(cardCss).toContain(
      ".summary__item--message { grid-column: 1 / -1; justify-self: safe center; min-inline-size: 0; text-align: center; }"
    ); // 2026-08-05: unclipped, wrapping no-action sentence
  });

  it("never clamps facts: anatomy is width-deterministic, overflow stays local (FEED-EDGE-ROW-CLIP v2)", () => {
    expect(cardCss).toMatch(
      /\.summary__viewport\s*\{[^}]*inline-size:\s*100%;[^}]*min-inline-size:\s*0;[^}]*overflow-x:\s*auto;/
    );
    expect(render(mlbFixture())).toContain('role="region"');
    expect(render(mlbFixture())).toMatch(
      /aria-label="Model projection summary: [^"]+ at [^"]+"/
    ); // 2026-08-05: distinguishable per-card region label
    expect(render(mlbFixture())).toContain('tabindex="0"');
    // FEED-EDGE-ROW-CLIP v2 (2026-08-02) regression guard: the group is
    // nowrap on wide cards (scrollport = escape valve) and a FIXED two-row
    // grid on tight (<=520px) cards — content-driven wrapping must never
    // return, because it let one long pick drop its chip while row-mates
    // stayed on one line (mixed anatomy in a single grid row).
    expect(cardCss).toMatch(
      /\.summary__group\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*max-inline-size:\s*100%;/
    );
    expect(cardCss).not.toMatch(/flex-wrap:\s*wrap/);
    const tight = cssBlock(
      cardCss,
      "Tight cards (<=520px border-box card width",
      "Tight cards use identical fact"
    );
    expect(tight.replace(/\s+/g, " ")).toContain(
      ".summary__group { display: grid; grid-template-columns: minmax(0, auto); justify-items: center;"
    );
    expect(cardCss).toMatch(
      /\.summary__signal\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*min-inline-size:\s*max-content;/
    );
    expect(cardCss).toMatch(
      /\.summary__item\s*\{[^}]*min-inline-size:\s*max-content;/
    );
  });

  it("tight cards reduce spacing/type and switch to the fixed two-row anatomy", () => {
    const centered = cssBlock(
      cardCss,
      "Centered summary group",
      "Round 4 Wave 2 — item 1"
    );
    expect(centered).toContain("@container projcard (max-width: 472px)"); // 2026-08-05: content-box-corrected
    expect(centered).toMatch(
      /\.summary__group,\s*\n\s*\.summary__readout\s*\{[\s\S]*?column-gap:\s*8px;/
    ); // 2026-08-05: 4px fused adjacent odds
    expect(centered).toMatch(
      /\.summary__readout\s*\{\s*grid-template-columns:\s*max-content minmax\(40px, max-content\) minmax\(40px, max-content\);/
    );
    expect(centered).not.toContain("flex-direction: column");
    expect(centered).not.toContain("grid-template-columns: repeat(2");
  });

  it("gives compact facts and signal the same 44px alignment lane", () => {
    expect(cardCss).toMatch(
      /\.summary__signal\s*\{[^}]*justify-content:\s*center;[^}]*min-block-size:\s*44px;/
    );
    expect(cardCss).toMatch(
      /\.summary__readout\s*\{[^}]*align-items:\s*center;[^}]*min-block-size:\s*44px;/
    );
    expect(cardCss).toMatch(
      /\.summary__item\s*\{[^}]*justify-content:\s*center;[^}]*min-block-size:\s*44px;/
    );
  });

  it("gives tight cards stable horizontal fact and signal lanes at every viewport", () => {
    const centered = cssBlock(
      cardCss,
      "Centered summary group",
      "Round 4 Wave 2 — item 1"
    );
    // 2026-08-02: lane stability is container-driven — no viewport media may
    // exempt narrow desktop grid columns from the fixed lanes.
    expect(centered).not.toContain("@media (max-width: 1023.98px)");
    expect(centered).toMatch(
      // 2026-08-05: BOOK/MODEL lanes keep a deterministic minimum but may not
      // be narrower than a four-glyph price (the 2.125rem fixed tracks fused
      // adjacent odds into one token).
      /\.summary__readout\s*\{[\s\S]*?grid-template-columns:\s*minmax\(4\.625rem, max-content\) minmax\(2\.75rem, max-content\) minmax\(2\.75rem, max-content\);/
    );
    expect(centered).toMatch(
      /\.summary__signal\s*\{\s*min-inline-size:\s*8\.125rem;/
    );
  });

  it("the multi-edge next control is neutral and keeps its 44px target", () => {
    expect(cardCss).toMatch(
      /\.summary__next\s*\{[^}]*inline-size:\s*44px;[^}]*block-size:\s*44px;[^}]*color:\s*var\(--text-secondary, #a6a6a6\);[^}]*border:\s*0;/
    );
  });

  it("compacts the pill, never the 44px arrow, on the narrowest desktop cards", () => {
    const narrowSignal = cardCss.slice(
      cardCss.indexOf("On the narrowest three-across desktop cards"),
      cardCss.indexOf("── Markets popover")
    );
    expect(narrowSignal).toContain("@container projcard (max-width: 246px)"); // 2026-08-05: content-box-corrected (~280px border-box cards)
    expect(narrowSignal).toContain(
      ".projection-card .summary__signal { gap: 4px; max-inline-size: 100%; }"
    );
    expect(narrowSignal).toMatch(
      /\.projection-card \.summary__signal \.edge-indicator\s*\{[^}]*padding:\s*0\.25rem;/
    );
    expect(narrowSignal).not.toContain(".summary__next {");
    expect(cardCss).toMatch(
      /\.summary-carousel__slide\s*\{[^}]*overflow:\s*hidden;/
    );
  });

  it("numeric readout cells are tabular (Book/Model values, the edge chip's percentage)", () => {
    const centered = cssBlock(
      cardCss,
      "Centered summary group",
      "Round 4 Wave 2 — item 1"
    );
    expect(centered).toMatch(
      /\.summary__item--book \.odds-value,\s*\n\s*\.summary__item--model \.odds-value,\s*\n\s*\.edge-indicator__value\s*\{\s*\n\s*font-variant-numeric:\s*tabular-nums;/
    );
  });

  it("ONE canonical edge-chip style: EdgeIndicator is the sole chip implementation, no divergent variant", () => {
    // The mint chip is styled exactly once (plus its --none quiet counterpart) in EdgeIndicator.css.
    expect(
      (edgeIndicatorCss.match(/^\.edge-indicator \{/gm) ?? []).length
    ).toBe(1);
    expect(
      (edgeIndicatorCss.match(/^\.edge-indicator--none \{/gm) ?? []).length
    ).toBe(1);
    // SummaryCarousel (the multi-edge surface) delegates to ProjectionSummary/EdgeIndicator for
    // every slide rather than re-implementing its own chip markup.
    expect(summaryCarouselSrc).not.toMatch(/edge-indicator/);
    expect(summaryCarouselSrc).toContain("ProjectionSummary");
    // Rendered output only ever uses the two canonical chip classes — never an alternate
    // "chip"-named class that would diverge from the shipped mint-outline style.
    const edgeHtml = render(mlbFixture());
    const passHtml = render({
      ...mlbFixture(),
      id: "oak-tex-pass-2",
      markets: [
        {
          key: "moneyline",
          label: "Moneyline",
          sides: [
            {
              marketKey: "moneyline",
              marketLabel: "Moneyline",
              sideLabel: "Athletics ML",
              bookPrice: -110,
              bookOppPrice: -110,
              modelPrice: -110,
            },
            {
              marketKey: "moneyline",
              marketLabel: "Moneyline",
              sideLabel: "Rangers ML",
              bookPrice: -110,
              bookOppPrice: -110,
              modelPrice: -110,
            },
          ],
        },
      ],
    });
    expect(edgeHtml).toMatch(/class="edge-indicator summary__edge"/);
    expect(passHtml).toMatch(/class="edge-indicator--none summary__edge"/);
    expect(edgeHtml + passHtml).not.toMatch(/class="[^"]*\bchip\b[^"]*"/i);
  });
});

/** Round 4 Wave 3 (docs/superpowers/plans/2026-07-23-feed-desktop-polish.md, item 7 +
 *  the W1-review fold-in minors; law: design-system/dime-ai/pages/ai-model-projections.md).
 *  Same DOM-only-harness note as W1/W2 above: hover fills and transitions are CSS, verified
 *  by reading the actual stylesheet source (what the visual smoke's forced :hover screenshot
 *  proves) rather than by a CSSOM this vitest environment doesn't have. */
describe("ProjectionCard — market-trigger hover (Round 4 Wave 3, item 7)", () => {
  it("the toggle gets the shell row-hover fill on the 160ms brand curve, hover-capable + >=768px only", () => {
    const item7 = cssBlock(
      cardCss,
      "Round 4 Wave 3 — item 7",
      "The portal is outside"
    );
    expect(item7).toContain("@media (min-width: 768px) and (hover: hover)");
    expect(item7).toMatch(
      /\.projection-card__markets-toggle:hover \{ background: var\(--row-hover, #141414\); color: var\(--foreground, #fff\); \}/
    );
  });

  it("the transition (160ms brand curve, same cubic-bezier as MASTER.md's motion law) lives inside the same gate as the hover fill (item 8 audit-fix)", () => {
    const item7 = cssBlock(
      cardCss,
      "Round 4 Wave 3 — item 7",
      "The portal is outside"
    );
    expect(item7).toMatch(
      /\.projection-card__markets-toggle \{\s*\n\s*transition: background 160ms cubic-bezier\(0\.16, 1, 0\.3, 1\), color 160ms cubic-bezier\(0\.16, 1, 0\.3, 1\);/
    );
    // Not present on the unconditional base rule (audit-fix: it was there in
    // an earlier draft, inert but out of scope below 768px/on touch-only).
    const baseRule = cardCss.slice(
      cardCss.indexOf(".projection-card__markets-toggle {"),
      cardCss.indexOf(
        "}",
        cardCss.indexOf(".projection-card__markets-toggle {")
      )
    );
    expect(baseRule).not.toContain("transition:");
  });

  it("cursor:pointer and the label/panel-icon markup stay tappable at every breakpoint", () => {
    // Base rule is unconditional: the popover button is tappable everywhere,
    // not just on hover-capable desktop/tablet.
    expect(cardCss).toMatch(
      /\.projection-card__markets-toggle \{[^}]*cursor: pointer;/
    );
    expect(render(mlbFixture())).toContain("View full AI model projections");
    expect(render(mlbFixture())).toContain("projection-card__markets-icon");
    expect(render(mlbFixture())).not.toContain("projection-card__markets-chev");
    expect(render(mlbFixture())).not.toContain("<summary");
  });

  it("keeps the complete trigger label on one line at EVERY card width (container-scaled type)", () => {
    // 2026-08-02: the base span rule owns the one-line contract — nowrap plus
    // cqi-scaled type with a 10px floor — so no width can wrap
    // "View full AI model projections" (the old desktop 3-across band wrapped
    // it to two lines on every card).
    expect(cardCss).toMatch(
      /\.projection-card__markets-toggle > span\s*\{[^}]*white-space:\s*nowrap;\s*font-size:\s*clamp\(0\.625rem, 0\.3rem \+ 1\.8cqi, 0\.9375rem\);/
    );
    const compactToggle = cardCss.slice(
      cardCss.indexOf(
        '.projection-card__markets-toggle[data-state="open"] .projection-card__markets-icon'
      ),
      cardCss.indexOf("Round 4 Wave 3 — item 7")
    );
    expect(compactToggle).not.toContain("@media (max-width: 1023.98px)");
    expect(compactToggle).toContain("@container projcard (max-width: 472px)"); // 2026-08-05: content-box-corrected
    expect(compactToggle).toMatch(
      /\.projection-card__markets-toggle\s*\{[^}]*gap:\s*4px;[^}]*padding-inline:\s*4px;/
    );
  });

  it("no bare unconditional :hover rule remains outside the gated media query (no stuck touch-hover)", () => {
    const beforeItem7 = cardCss.slice(
      0,
      cardCss.indexOf("Round 4 Wave 3 — item 7")
    );
    expect(beforeItem7).not.toMatch(/\.projection-card__markets-toggle:hover/);
  });
});

describe("ProjectionCard — defensive PASS-mint backstop (Round 4 Wave 3 fold-in, W1 review)", () => {
  it("neutralizes market-table signal/edge classes and the real edge-indicator variant under .projection-card--pass", () => {
    const backstop = cssBlock(
      cardCss,
      "Defensive PASS backstop (Round 4, from the W1 review",
      "Item 4 — live indicator"
    );
    expect(backstop).toContain(
      ".projection-card--pass .market-table:not(.market-table--lines) .market-table__model--signal,"
    );
    expect(backstop).toContain(
      ".projection-card--pass .market-table:not(.market-table--lines) .market-table__result--edge,"
    );
    expect(backstop).toContain(
      ".projection-card__markets-popover--pass .market-table:not(.market-table--lines) .market-table__model--signal,"
    );
    expect(backstop).toContain(
      ".projection-card__markets-popover--pass .market-table:not(.market-table--lines) .market-table__result--edge,"
    );
    // 2026-08-06: the selector is now grouped with its --unplayable twin, so
    // it ends in a comma and the brace closes the whole list.
    expect(backstop).toContain(".projection-card--pass .edge-indicator,");
    expect(backstop).toContain(
      ".projection-card--unplayable .edge-indicator {"
    );
    // 2026-08-02: plain declarations — the two-class selectors out-rank every
    // one-class signal rule, and no inline style remains to fight, so the
    // !important cascade was retired without changing PASS meaning.
    expect(backstop).toMatch(/color: var\(--text-secondary, #a6a6a6\);/);
    expect(backstop).toMatch(/background: transparent;/);
    expect(backstop).not.toContain("!important");
  });

  it("keeps EDGE labeled with a quiet signal token and no ornamental glyph", () => {
    const edgeIndicatorSrc = fs.readFileSync(path.join(import.meta.dirname, "EdgeIndicator.tsx"), "utf8");
    expect(edgeIndicatorSrc).not.toMatch(/style=\{\{/);
    expect(edgeIndicatorSrc).not.toContain("TrendingUp");
    expect(edgeIndicatorSrc).toContain('className="edge-indicator__label">Edge');
    expect(edgeIndicatorCss).toContain("color: var(--mint-ink)");
    expect(edgeIndicatorCss).not.toMatch(/border-inline-start|box-shadow/);
  });

  it("applies items 3-4 (PASS dim + live dot) at EVERY breakpoint (2026-08-05: the item-8 >=768 scoping is superseded by the unqualified page law)", () => {
    const item234 = cssBlock(
      cardCss,
      "Round 4 Wave 1 — card-anatomy",
      "Centered summary group"
    );
    // The page law states PASS dim and the live dot without breakpoint
    // qualification (mobile-first owner directives); neither may live inside
    // a min-width gate anymore.
    expect(item234).not.toContain("@media (min-width: 768px)");
    expect(item234).toContain(".projection-card--pass .edge-indicator,");
    expect(item234).toMatch(/\.projection-card--pass \{ opacity: 0\.82; \}/);
    expect(item234).toMatch(
      /\.projection-card__live-dot \{\s*display: inline-block;/
    );
  });

  it("a genuine PASS card still renders zero mint-signal classes today (backstop is defense-in-depth, not the only guard)", () => {
    const game: ProjectionGame = {
      id: "oak-tex-backstop",
      league: "MLB",
      status: "scheduled",
      statusLabel: "7:05 PM ET",
      away: {
        abbr: "OAK",
        name: "Athletics",
        logo: null,
        color: "#333333",
        score: null,
      },
      home: {
        abbr: "TEX",
        name: "Rangers",
        logo: null,
        color: "#333333",
        score: null,
      },
      matchupContext: "Globe Life Field",
      venue: "Globe Life Field",
      startTime: "7:05 PM ET",
      markets: [
        {
          key: "moneyline",
          label: "Moneyline",
          sides: [
            {
              marketKey: "moneyline",
              marketLabel: "Moneyline",
              sideLabel: "Athletics ML",
              bookPrice: -110,
              bookOppPrice: -110,
              modelPrice: null,
            },
            {
              marketKey: "moneyline",
              marketLabel: "Moneyline",
              sideLabel: "Rangers ML",
              bookPrice: -110,
              bookOppPrice: -110,
              modelPrice: null,
            },
          ],
        },
      ],
    };
    const html = render(game);
    const marketHtml = renderMarket(game);
    expect(html).toContain("projection-card--pass");
    expect(marketHtml).not.toContain("market-table__model--signal");
    expect(marketHtml).not.toContain("market-table__result--edge");
    expect(html).not.toMatch(/class="edge-indicator summary__edge"/);
  });

  it("a LIVE card with zero edges never takes PASS (final-review I2 precedence ruling)", () => {
    // Reachable state: a mid-game model invalidation nulls every model price
    // (DimeModelFeed's mlbRowToCard) while the game is live. The precedence
    // ruling — annotated in ai-model-projections.md "PASS games" — is that
    // live-ness wins: the mint LIVE signal renders undimmed, and the PASS
    // zero-mint law simply never applies to a live card.
    const html = render({
      id: "lad-nyy-live-noedge",
      league: "MLB",
      status: "live",
      statusLabel: "LIVE · 5th",
      away: {
        abbr: "LAD",
        name: "Dodgers",
        logo: null,
        color: "#333333",
        score: 3,
      },
      home: {
        abbr: "NYY",
        name: "Yankees",
        logo: null,
        color: "#333333",
        score: 2,
      },
      matchupContext: "Yankee Stadium",
      venue: "Yankee Stadium",
      startTime: "7:05 PM ET",
      markets: [
        {
          key: "moneyline",
          label: "Moneyline",
          sides: [
            {
              marketKey: "moneyline",
              marketLabel: "Moneyline",
              sideLabel: "Dodgers ML",
              bookPrice: -110,
              bookOppPrice: -110,
              modelPrice: null,
            },
            {
              marketKey: "moneyline",
              marketLabel: "Moneyline",
              sideLabel: "Yankees ML",
              bookPrice: -110,
              bookOppPrice: -110,
              modelPrice: null,
            },
          ],
        },
      ],
    });
    expect(html).not.toContain("projection-card--pass");
    expect(html).toContain("projection-card__live-dot");
    expect(html).toContain("LIVE · 5th");
    // The ruling is recorded in the page law, so a future session can't
    // silently re-collide the two laws.
    expect(lawDoc).toContain("a LIVE card never takes the PASS treatment");
  });
});

describe("ProjectionCard — .summary__item--message hook", () => {
  it("is consumed by the centered readout grid", () => {
    // The class renders in the PASS-message branch (ProjectionSummary.tsx)...
    const passHtml = render({
      id: "oak-tex-message-hook",
      league: "MLB",
      status: "scheduled",
      statusLabel: "7:05 PM ET",
      away: {
        abbr: "OAK",
        name: "Athletics",
        logo: null,
        color: "#333333",
        score: null,
      },
      home: {
        abbr: "TEX",
        name: "Rangers",
        logo: null,
        color: "#333333",
        score: null,
      },
      matchupContext: "Globe Life Field",
      venue: "Globe Life Field",
      startTime: "7:05 PM ET",
      markets: [
        {
          key: "moneyline",
          label: "Moneyline",
          sides: [
            {
              marketKey: "moneyline",
              marketLabel: "Moneyline",
              sideLabel: "Athletics ML",
              bookPrice: -110,
              bookOppPrice: -110,
              modelPrice: null,
            },
            {
              marketKey: "moneyline",
              marketLabel: "Moneyline",
              sideLabel: "Rangers ML",
              bookPrice: -110,
              bookOppPrice: -110,
              modelPrice: null,
            },
          ],
        },
      ],
    });
    expect(passHtml).toContain('class="summary__item summary__item--message"');
    // ...and a real CSS rule consumes it (not a no-op class with zero rules).
    expect(cardCss).toContain(
      ".summary__item--message { grid-column: 1 / -1; justify-self: safe center; min-inline-size: 0; text-align: center; }"
    ); // 2026-08-05: unclipped, wrapping no-action sentence
  });
});

// Regression guards for the closure audit's own fixes. These lock the exact classes that
// regressed during the audit (two overclaims shipped before independent verification caught them):
// the CL-01 matchup grid flip and — critically — the logo collapse cap, plus the 10px type floor.
// Comments are stripped so historical values cited in comment prose can't satisfy a live-value check.
describe("closure regression guards — lock the audited fixes (CL-01/03/08/17)", () => {
  const liveCss = cardCss.replace(/\/\*[\s\S]*?\*\//g, "");

  it("CL-01: keeps the ≤280px matchup grid flip (auto | minmax(0,1fr) | auto) that ends 3-col logo starvation", () => {
    expect(liveCss).toMatch(
      /@container projcard \(max-width: 246px\)[\s\S]*?\.matchup__grid\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto;/
    );
  });

  it("CL-01: .team-logo keeps `max-inline-size: none` — guards the width cap that collapsed crests to 0px (shipped twice)", () => {
    expect(liveCss).toMatch(/\.team-logo\s*\{[^}]*max-inline-size:\s*none;/);
    // a percentage max-inline-size on the crest inside its shrink-to-fit box resolves to 0 → invisible logos. Must never return.
    expect(liveCss).not.toMatch(/\.team-logo\s*\{[^}]*max-inline-size:\s*100%/);
  });

  it("CL-03: .edge-indicator__label meets the 10px micro-label floor in every container tier", () => {
    const sizes = [
      ...liveCss.matchAll(
        /\.edge-indicator__label\s*\{\s*font-size:\s*([\d.]+)rem/g
      ),
    ].map(m => parseFloat(m[1]));
    expect(sizes.length).toBeGreaterThanOrEqual(2);
    for (const s of sizes) expect(s).toBeGreaterThanOrEqual(0.625);
  });

  it("CL-08/CL-17: no live font-size (bare, clamp minimum, or px) resolves below the 0.625rem / 10px floor", () => {
    const remBare = [...liveCss.matchAll(/font-size:\s*([\d.]+)rem/g)].map(m =>
      parseFloat(m[1])
    );
    const remClampMin = [
      ...liveCss.matchAll(/font-size:\s*clamp\(\s*([\d.]+)rem/g),
    ].map(m => parseFloat(m[1]));
    for (const r of [...remBare, ...remClampMin])
      expect(r).toBeGreaterThanOrEqual(0.625);
    const pxSizes = [...liveCss.matchAll(/font-size:\s*([\d.]+)px/g)].map(m =>
      parseFloat(m[1])
    );
    for (const p of pxSizes) expect(p).toBeGreaterThanOrEqual(10);
  });
});

describe("ProjectionCard — no published model is a THIRD state, not PASS", () => {
  // The defect this pins: before `modelPublished` existed, a game the model had
  // never touched fell through the same branch as a scored-but-efficient game
  // and told the user "Every market is efficiently priced. No action." — an
  // assertion about an analysis that never ran. The same branch is what the
  // per-market publication gate (MLB_MARKET_GATE_MODE=on) routes gated games
  // into, so it had to be split before that flag could ever be turned on.
  const noModel = (): ProjectionGame => ({
    ...wcFixture(),
    modelPublished: false,
  });

  it("says no model was published instead of claiming the markets were priced", () => {
    const html = render(noModel());
    expect(html).toContain("No model projection published for this game.");
    expect(html).not.toContain(
      "Every market is efficiently priced. No action."
    );
  });

  it("still uses the shared message slot, so layout is unchanged", () => {
    const html = render(noModel());
    expect(html).toContain('class="summary__item summary__item--message"');
    expect(html).not.toContain("summary__signal");
  });

  it("takes --nomodel and NOT --pass", () => {
    const html = render(noModel());
    expect(html).toContain("projection-card--nomodel");
    expect(html).not.toContain("projection-card--pass");
  });

  it("announces the absence in the accessible name, after the lifecycle state", () => {
    const html = render(noModel());
    expect(html).toContain(
      "Spain at France, 3:00 PM ET, no model projection published"
    );
  });

  it("a LIVE card is never --nomodel, mirroring the live-never-PASS ruling", () => {
    const html = render({
      ...noModel(),
      status: "live",
      statusLabel: "LIVE · 2ND HALF",
    });
    expect(html).not.toContain("projection-card--nomodel");
  });

  it("leaves a published game byte-for-byte unchanged (default is published)", () => {
    expect(render(wcFixture())).toBe(
      render({ ...wcFixture(), modelPublished: true })
    );
    expect(render(wcFixture())).toContain(
      "Every market is efficiently priced. No action."
    );
  });

  it("mirrors PASS's neutral values without touching the guarded PASS rule", () => {
    // The PASS rule is asserted as literal text elsewhere in this file as a page
    // -law guard; --nomodel must not dilute it into a selector list to share it.
    expect(cardCss).toMatch(/^\.projection-card--pass \{ opacity: 0\.82; \}$/m);
    expect(cardCss).toMatch(
      /^\.projection-card--nomodel \{ opacity: 0\.82; \}$/m
    );
    expect(cardCss).toMatch(
      /^\.projection-card--compact\.projection-card--nomodel \{ opacity: 0\.72; \}$/m
    );
  });
});
