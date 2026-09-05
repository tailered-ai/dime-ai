# AI Model Projections (Dime Feed) — Page Overrides

> **PROJECT:** Dime AI
> **Generated:** 2026-07-08 (authored from `dime-ai/reference-pages/dime-feed-*.html` and `dime-ai/DIME-FEED-MIGRATION-DRAFT.md`)
> **Page Type:** Dashboard / Data View

> ⚠️ **IMPORTANT:** Rules in this file **override** the Master file (`design-system/dime-ai/MASTER.md`).
> Only deviations from the Master are documented here. For all other rules, refer to the Master.

---

## Owner amendment — 2026-09-05 NCAAF market tables

- Use full school names throughout NCAAF projections, splits and odds history.
- Side contains the school or Over/Under. Book shows its line with odds beneath. Model shows the actual projection, then its odds and original pricing threshold when different.
- The NCAAF table footer is reserved for **EDGE % only when the raw comparable edge is strictly greater than zero**, otherwise **NO EDGE** (including zero, missing or incomparable prices). This supersedes the older 1.5-point display threshold for these tables.
- The strongest strictly positive NCAAF table row/footer uses the existing mint signal treatment, including on otherwise PASS cards. This is a table-only exception to the older zero-mint backstop; summary recommendations and all other sports retain their existing thresholds. Unplayable-game color suppression remains in force.

## Page-Specific Rules

### Layout Overrides

- **Shell:** Dime sidebar with "AI Model Projections" as `is-active`; top bar shows Slate as the active pill tab
- **Main pane gutters:** 40px (not the chat pane's 140px)
- **Card grid:** `grid-template-columns: 340px 1fr 1fr 1fr 300px` — Matchup | Run Line | Total | Moneyline | Model Verdict
- **Column headers:** IBM Plex Mono micro-labels above the card list ("MATCHUP", "RUN LINE · BOOK / MODEL", …)
- **Sub-tabs:** Projections · Splits · Lineups · K Props · Cheat Sheets · HR Props — 13px/600, active = `--text-primary` + 2px mint underline, inactive = `--text-muted`
- **Date nav:** ‹ › square buttons (28px, radius 8, 1px border) around "Weekday, Month D" (15px/700) + mono "MLB · N GAMES"
  — owner directive 2026-07-23: desktop date nav centers under the title band at 17px; 24/32px rhythm to the league header (32px of space; the pre-existing 1px divider border adds up to 33px edge-to-edge)
- **Sync status:** top-bar right — mono micro-label "SYNCED N MIN AGO" with 6px mint dot
- **Bottom composer:** "Ask dime about tonight's slate…" — ties the feed back to chat

### Spacing Overrides

- Card list gap: `12px`; card padding: `16px` (Master dense tier applies)

### Typography Overrides

- Matchup line: 16px/700 `--text-primary`; "@" separator in `--text-muted` at 400
- Book values: 15px `--text-body`, juice in parens `--text-muted`
- Model values: 15px/700 — mint ONLY if the model disagrees with the book enough to be signal
- Verdict strip values: 17px/700 over 10px mono labels (PICK / EDGE / GRADE)

### Color Overrides

- **Live state:** pulsing 7px mint dot + mono "LIVE · TOP 6" in mint (`--mint-on-light` on light theme, with keyline on the dot)
- **PASS games:** verdict values in `--text-secondary`, grade "—" *(2026-07-23: the verdict-strip/grade concept is superseded — no letter-grade field exists in the current ProjectionCard architecture; PASS state is enforced via `.projection-card--pass` at `opacity: 0.82` + an ROI-only neutral badge + a defensive zero-mint backstop, per Round 4 items 3 and 8 in `docs/superpowers/plans/2026-07-23-feed-desktop-polish.md`)*, whole card at `opacity: 0.82`, zero mint anywhere in the card. When prices are scorable, the summary still presents one best canonical no-vig ROI side per market (`calculateRoi`), ordered highest → lowest (zero/negative values included). Each slide shows only `ROI ±x.x%` in compact grey styling; its accessible name still announces that the projection is not actionable. The unavailable-data sentence is reserved for games with no scorable side.
  — a LIVE card never takes the PASS treatment, even when a mid-game model
  invalidation removes every edge. The newer compact-state rule below still
  reduces the whole live/final card to `opacity: 0.72`; that is lifecycle
  hierarchy, not a PASS/no-edge signal.
- **Win% annotation** next to model ML: 12px `--text-secondary`

### Component Overrides

- Verdict strip is separated from market columns by a 1px left border (`--color-border`), right-aligned
- No favorites gold: star = neutral outline, mint fill only when active (pending final call)

### Owner Directives — 2026-07-17 (mobile-first; all breakpoints)

- **No theme toggle in the feed header.** The Profile tab's Appearance setting
  (System / Light / Dark) is the single theme control. `?theme=` embeds stay honored.
  System owns the fixed neutral-grey, dark-contrast ground (`#121212` page /
  `#181818` card), Dark owns the pure-black ground, and Light owns the white
  ground.
- **Dark-logo keyline at every breakpoint (2026-07-24).** Allowlisted marks
  whose artwork disappears into System/Dark receive the same alpha-following
  `0.2px` white keyline on mobile, tablet, and desktop. Light preserves the
  original mark with no generated outline.
- **Gamecard matchup block** (team names only; each fact once)
  *(AMENDED 2026-08-05 — see "card status header" below: the centered header owns
  the status for every state, and {BALLPARK} is scheduled-only. The {TIME OF FIRST
  PITCH ET} line is retired from this block entirely — the header owns it.)*:
  ```
  {STATUS}                              ← centered header, EVERY state (2026-08-05)
  {AWAY TEAM NAME} @ {HOME TEAM NAME}   ← "Giants @ Mariners" (names only, no abbrs)
  {BALLPARK}                            ← "T-Mobile Park" — SCHEDULED ONLY (2026-08-05)
  ```
  Countries render names only (no FIFA codes); WC context line stays "Round · Venue".
  Scheduled MLB probable pitchers render in their dedicated middle panel below
  this matchup block, never inside the matchup line itself.
- **Markets popover** *(amended 2026-07-23)*: closed by default; the card-level
  trigger reads "VIEW FULL AI MODEL PROJECTIONS" and opens the paginated
  floating panel defined below. The complete trigger label stays on one line
  on mobile and tablet. Per-game market details are not a native `details`
  disclosure.
- **Market column labels:** `SIDE | BOOK | MODEL` — never "SPORTSBOOK PRICE" /
  "MODEL FAIR PRICE". Applies to every feed surface: mobile, tablet, desktop.
- **Summary readout labels:** `MODEL EDGE | BOOK | MODEL` — never "BEST PRICE".
- **Summary row grouping (2026-07-24):** `MODEL EDGE | BOOK | MODEL | signal`
  travels as one intrinsic-width, centered, single-line group at every
  breakpoint. Mobile/tablet facts and signal share the same 44px alignment
  lane, compact type scale, and deterministic spacing. Values never wrap,
  clamp, truncate, or overlap. If localized content is physically wider than
  the card, overflow is confined to the summary viewport so the complete row
  remains reachable without widening the card or page.
- **MODEL EDGE values are spelled out:** `U 7` → "UNDER 7", `O 8.5` → "OVER 8.5",
  a leading team abbr → the team name (`ATH ML` → "ATHLETICS ML").
  *(2026-07-18: the "tables keep compact form" clause is superseded — see below.)*
- **Mobile chrome centering (<768px):** dime wordmark centered in the topbar;
  date nav (‹ date › + slate count) stacks centered *(sport chips removed
  2026-07-18 — see combined slate below)*; the summary block centers above
  the markets popover trigger on mobile-width cards.
- **Slate order:** MLB games list earliest → latest first pitch, top to bottom
  (`timeToMinutes`; TBD start times sink to the bottom).

### Owner Directives — 2026-07-18 (WC winner-scope markets)

- **The two remaining WC matches replace MONEYLINE with a match-WINNER
  market** — graded on whoever wins the match when it settles, regardless of
  90'+injury time, extra time, or penalties:
  - `wc26-3rd-103` (FRA home vs ENG away): **"World Cup 3rd Place"** — book
    France **-215** / England **+170** (owner-provided 2026-07-18).
  - `wc26-final-104` (ESP home vs ARG away): **"To Win the World Cup"** —
    book Spain **-150** / Argentina **+130** (owner-provided 2026-07-18).
- **Model odds for this scope = `model_*_to_advance`** from the v27 engine
  (`server/wc2026/v27_jul18_engine.mjs` `deriveAllMarkets`): P(win 90') +
  P(draw) × [ET sub-sim at λ/3 + pens 50.5/49.5 home/away] — for these two
  matches that is literally "wins the match outright" (engine header). They
  flow `wc2026_model_projections.to_advance_*_odds` → router
  `modelOdds.toAdvance*` → the winner column. Edge = 2-way
  `calculateEdge(book, model)` (model side is fair: pAdvH+pAdvA=1); the mint
  edge cell, footers, and carousel populate through the standard pipeline.
- The client map (`WC_WINNER_MARKETS`, DimeModelFeed.tsx) pins the
  v27-verified orientation; a live-row disagreement falls back to plain ML
  rather than misassigning the owner book prices.
- **Scope clarity:** on these two cards the headers of DRAW, SPREAD,
  DOUBLE CHANCE, and BOTH TEAMS TO SCORE append **"(90 Min)"** (display-only
  tag; market shapes/labels resolve from the base title). Total keeps its
  plain header. Picks read "France 3rd Place" / "Spain to Win WC" so the
  summary readout and carousel always name the market.

### Owner Directives — 2026-07-18 (combined slate)

- **One collective feed — no sport toggle.** The MLB / World Cup chips are
  removed; both leagues load for the selected date and render in ONE list,
  grouped by league: **World Cup on top, MLB beneath** (CBS-scores-style
  league grouping — ONLY the grouping/order is mirrored, no other CBS
  element). Rationale: two WC matches remain, then MLB carries the feed
  until NCAAF/NFL return.
- League sections are **collapsible containers** (native details/summary,
  open by default; chevron affordance; 44px header row; mobile-first):
  official league logo in a fixed 30px box + the full spelled-out name at
  15px (1.25x, clamped on narrow phones), **centered as a cluster within
  the page** with the chevron pinned to the right edge — "2026 FIFA WORLD
  CUP" and "MAJOR LEAGUE BASEBALL (MLB)".
  **No game counts** in headers, and the feedhead slate count is removed
  (its divider stays — the feedhead bottom border). The WC emblem is
  theme-keyed: `/brand/wc26-emblem-on-light.png` (black FIFA wordmark) on
  light, `/brand/wc26-emblem-on-dark.png` (white wordmark) on dark, both
  rendered the same size; MLB uses the actual current mark (2026-07-21):
  the official `https://www.mlbstatic.com/team-logos/league-on-dark/1.svg`
  with the bundled recolored `/brand/mlb-logo.png` as offline fallback. A
  missing logo file hides itself (clean text-only header). A league with no games that date renders no
  section. Within a section the existing slate order holds (first pitch
  asc; LIVE > upcoming > FINAL tiers).
  *(AMENDED 2026-08-06: the third tier is now **settled** — FINAL plus
  POSTPONED and SUSPENDED, which previously fell through into the upcoming
  tier. See "Owner Directives — 2026-08-06 (unplayable games)".)*
- **WC venue line drops trailing stadium parentheticals** —
  "MetLife Stadium (NY/NJ)" reads "MetLife Stadium · East Rutherford, NJ"
  (`wcDisplayStadium`; city matching still uses the raw stadium string).
- Date nav canonicalizes on the `mlb-` slug (one URL per date); legacy
  `wc-` deep links still parse and render the same combined slate.

### Owner Directives — 2026-07-21 (desktop emphasis pass)

Desktop (>=1024px) only — tablet/mobile keep their shipped layouts:

- **Shell page title at 5x, centered.** Embedded in the app shell, the
  topbar's "AI Model Projections" centers and scales 14px -> 70px (cqi-shaved
  only where the pane is too narrow for one line; never wraps). The topbar
  grows to a fixed 96px and the sticky feedhead offset tracks it. Standalone
  /feed keeps its compact wordmark + nav row.
- **Sidebar dime wordmark at 2.5x** (20px -> 50px) where the sidebar is
  persistent; the <1024px drawer keeps the frozen 20px.
- **MLB league logo is the actual current mark at 2x**: official navy/red
  mlbstatic league SVG in a 60px box (WC emblem keeps 30px); bundled
  recolored `/brand/mlb-logo.png` (navy `#041E42` / red `#BF0D3E`) as
  offline fallback.

### Owner Directives — 2026-07-23 (responsive feed density)

> **AMENDED 2026-08-02 (responsive rebuild):** column count is now fully
> CONTENT-driven from the league body's own width (`dmf-league` container
> queries only — FEED-CL01a generalized). Card readability floor is ~305px:
> **2-up engages at >=622px** of league-body width (2×305 + 12px gap) and
> **3-up at >=940px** (3×305 + 2×12). No viewport media query may ever set a
> column rule — the old `min-width:768px` 2-up media rule is retired, and the
> earlier "~1230px shell window / sidebar ≈250px" numbers are obsolete (the
> shipped shell sidebar is ~381px; container math makes sidebar width
> irrelevant). Every multi-column row **stretches** so scheduled row-mates
> align; each summary centers within surplus height and the
> "VIEW FULL AI MODEL PROJECTIONS" trigger stays pinned to the bottom.
> Live/final/postponed cards opt out with `align-self: start`, keeping their
> intentionally compact natural height beside richer upcoming cards.
> Historical (superseded) text follows for provenance.

- **Games per row (superseded):** mobile (<768px) rendered 1, tablet
  (768–1023px) rendered 2, and desktop (>=1024px) rendered 3 inside each
  league section. Cards keep their container-driven internal reflow.
- **Amendment (UI/UX resolution, FEED-CL01a):** the desktop 3-across promotion
  is content-aware — it engages only when the league body itself affords
  >=940px (every card >=~305px usable width), via a `dmf-league` container
  query. A viewport media query must never reintroduce a column rule.

### Owner Directives — 2026-07-23 (Rotowire probable pitchers + lineups)

- **Upcoming MLB only.** Between the matchup and projection summary, render two
  equal probable-pitcher columns with a centered `LINEUPS` button. Each pitcher
  shows a headshot, `First Last`, the Rotowire W–L/ERA display line, and a
  text label of `EXPECTED` or `CONFIRMED`. If Rotowire has not posted the game,
  preserve the panel shape with `Pitcher TBD` and pending copy. Pitcher names
  remain complete and on one line on mobile and tablet; compact cards give the
  pitchers two equal-width lanes and center the CTA between their photo rows,
  rather than stealing name width or wrapping/clipping text.
- Headshots are bottom-centered and inset inside their circular frames so the
  full portrait remains visible. `LINEUPS` is the Dime mint CTA: bold black
  text, 12px radius, inset highlight, hover elevation, and active scale.
- Matchup side tracks balance around the centered matchup copy; scheduled team
  logos sit directly beside their corresponding team names instead of at the
  card edges.
- Data stays on the existing public `games.mlbLineups({ gameIds })` read path.
  Batch numeric `games.id` values for `gameStatus === "upcoming"` only and poll
  every 60 seconds. Prefer the enriched lineup row; `games.list` starter names
  are the no-photo/no-stats fallback. Malformed lineup JSON is ignored at the
  client boundary, batting order is sorted 1–9, and no more than nine hitters
  render per team.
- `LINEUPS` opens a modal dialog, not another small popover: both teams, starter
  status, starter season line, lineup status, and batting orders render in two
  columns at tablet/desktop widths and one scrollable stack on mobile. The
  trigger and close control are at least 44px; Escape/outside click close the
  dialog and Radix restores focus to the trigger.
- **Lifecycle compaction.** As soon as a game becomes live, final, postponed, or
  suspended, remove all pregame pitcher/lineup UI, **remove the ballpark and the
  first-pitch time** (2026-08-05 extension — the same rule, one more pair of
  pregame-only facts), apply the compact card anatomy, set `align-self: start`,
  and diminish the card to `opacity: 0.72`.
  Never keep a stale lineup dialog trigger on a non-scheduled card.

### Owner Directives — 2026-07-23 (paginated market popover)

- **Replace the per-game collapsible market panel with an anchored popover.**
  Opening projections must never resize the card, stretch a row-mate, or move
  the feed grid. League sections remain their existing native collapsibles.
- The popover renders **one market table per page in source order**. MLB pages
  are Run Line (1), Total (2), and Moneyline (3). Other leagues keep their
  complete dynamic market count; the pagination window uses ellipses rather
  than hiding additional markets.
- Controls include Previous, numbered pages, and Next. The active page carries
  `aria-current`; boundary controls carry `aria-disabled` and leave the tab
  order. Every interactive pagination target is at least 44px.
- The floating surface is collision-aware, viewport-constrained, scrollable
  when vertical space is limited, and keeps one readable table on mobile. It
  consumes the global popover surface/foreground tokens in both themes; mint
  text uses the contrast-safe light-theme value.
- Escape and outside click close the popover and return focus to its trigger.
  Reduced motion removes the opening animation.

### Owner Directives — 2026-07-18 (edge labeling + multi-edge carousel)

- **The MODEL EDGE pick always names its market.** A moneyline edge reads
  "YANKEES ML" — never a bare "YANKEES". Run line edges carry their line
  ("YANKEES +1.5"), totals their number ("UNDER 9"). Implemented in the
  team-sport presentation adapter (`client/src/lib/sport/presentation.ts`
  `teamSideLabel`), mirroring the soccer adapter's "<Country> ML" rule.
- **Market-table side labels are spelled out** (supersedes the 2026-07-17
  compact-form clause): run line rows read "Dodgers -1.5" / "Yankees +1.5",
  total rows read "Over 9" / "Under 9", moneyline rows read "<Team> ML".
  Edge footers re-anchor on the spelled-out side ("Yankees +1.5 · +4.8%").
- **Ranked projection carousel:** a game with 2+ real edges cycles them in a
  swipeable scroll-snap strip (`SummaryCarousel`), one uniform summary
  readout per slide, ranked largest → smallest edge %, at most one side per
  market. If the whole game has no actionable edge, the same strip instead
  carries the highest canonical no-vig ROI side from each scorable market,
  ordered best → worst even when every ROI is negative; every neutral slide
  renders only a compact grey `ROI ±x.x%` badge while the accessible name
  retains the non-actionable status; its arrow remains neutral. The visible count/dot row
  is removed: a 44px `ArrowRight` control
  sits immediately after the edge pill, advances to the next edge, and wraps
  to the strongest after the last. Its icon is mint and its border consumes
  the theme foreground token (white on dark/system, black on light).
  `prefers-reduced-motion` collapses smooth scrolling. A game with one edge
  or one scorable no-edge candidate keeps the plain single summary with no
  arrow; a game with no scorable candidate shows the unavailable-data copy.

### Owner Directives — 2026-08-06 (compaction contrast + salience) — owner-approved

> **APPROVED AND AUTHORIZED by the owner, 2026-08-06.** This is the decision the
> previous directive's scope fence deferred: both items it excluded are now
> authorized and fixed. Decision note: PR #416, evidence bundle
> `docs/audits/2026-08-06-feed-contrast-salience-evidence/`.

Both defects trace to one cause — `.projection-card--compact`'s `opacity: 0.72`
composites the card **layer** over the page, so page ground bleeds into the text
as well as the card background. The dim itself stays (owner directive
2026-07-23); what changes is how the text tokens compensate for it.

- **The compaction remap no longer overshoots to `--foreground`.** It used to
  push both `--text-secondary` and `--text-muted` all the way to the foreground
  ink, which composited settled cards to 10.10:1 dark / 8.79:1 light —
  **brighter than the bettable scheduled card's own labels** at 8.13:1 / 6.54:1.
  Salience ran backwards: the games a user cannot act on carried the strongest
  ink on the slate. Both tokens now resolve to a bounded mid tone, derived from
  `--foreground` by `color-mix` so it stays achromatic and introduces no new
  token: 82% of the foreground ink mixed toward the page ground. One rule
  covers both themes, because `--foreground` and `--background` flip together.
- **The light-theme LIVE mint deepens from 60% to 50%.** At 60% the composited
  label measured **4.4969:1** — missing the 4.5:1 floor by 0.003, while the rule
  it lived in claimed to clear it. 50% measures **5.0170:1**. Same single mint
  hue, just deeper.
- **Status text is normal text for WCAG**, not large: 14.05px at 1440, 12.00px
  at 375, weight 600. The floor is 4.5:1, not 3:1.

Measured in a browser against the built artifact, composited as
`0.72 × colour + 0.28 × page`:

| state | dark before → after | light before → after |
|---|---|---|
| scheduled (bettable) | 8.13 → 8.13 (unchanged) | 6.54 → 6.54 (unchanged) |
| live | 6.25 → 6.25 | **4.4969 → 5.0170** |
| final / postponed / suspended | **10.10 → 6.85** | **8.79 → 5.27** |

Two invariants now hold together and are gated in CI by
`ProjectionCard.test.ts` plus a browser gate in the evidence bundle: every
status label clears 4.5:1, **and** no settled card's labels exceed the
scheduled card's. Reducing the settled tone was the only way to satisfy both —
simply reverting the remap would have dropped light-theme settled text to
~3.4:1, well under the floor.

### Owner Directives — 2026-08-06 (unplayable games: slate tier + mint rationing) — owner-approved

> **APPROVED AND AUTHORIZED by the owner, 2026-08-06.** This section is
> therefore live law, not a proposal.
>
> Closes two findings from the post-deploy audit of PR #409, both of which that
> PR reported and deliberately did not fix because they were out of its scope.
> Decision note: PR #413 (`fix/feed-unplayable-slate-rank`), evidence bundle
> `docs/audits/2026-08-06-feed-unplayable-evidence/`.
>
> **Scope of the authorization — read this before citing it.** It covers exactly
> the four bullets below: the settled-tier change, the zero-mint rule for
> unplayable cards, the edge-content-stays clause, and the never-unplayable
> ruling for LIVE. It does **not** authorize either open item that the same
> audit surfaced and this directive leaves alone:
>
> 1. the light-theme LIVE status label measuring **4.4969:1** against a 4.5:1
>    floor, whose recorded remedy (deepening the `color-mix` from 60% to 50%,
>    ≈4.96:1) is a brand-token change still awaiting its own owner decision; and
> 2. the `.projection-card--compact` salience inversion, which would require
>    revisiting the lifecycle-compaction `opacity: 0.72`.
>
> Neither may be shipped on the strength of this approval.
>
> **RESOLVED later the same day.** Both were separately approved and authorized
> by the owner and are fixed — see "Owner Directives — 2026-08-06 (compaction
> contrast + salience)" above. The fence is kept as written because it was true
> of *this* approval; it records that the two items travelled on their own
> decision rather than riding in on this one.

**"Unplayable" is a new, named card state: `postponed` or `suspended`.** It is
NOT the same thing as PASS. PASS means the model found nothing worth acting on
in a game that will be played. Unplayable means the game is not available to act
on, whatever the model found. They look similar and they mean opposite things,
so they get separate modifiers (`--pass`, `--unplayable`) that share one
treatment.

- **Slate tier (supersedes the "LIVE > upcoming > FINAL tiers" clause of
  2026-07-18).** The tiers are now **LIVE > upcoming > settled**, where
  *settled* = `final` + `postponed` + `suspended`. Previously postponed and
  suspended fell through into the *upcoming* tier and sorted by their original
  first pitch, which put games nobody can bet above the ones they can — on the
  audited slate they held positions 2 and 3 of 5 at every breakpoint. Within a
  tier the existing order still holds (first pitch ascending; `Array.sort` is
  stable). The rank is now derived from the card's `status` through an
  exhaustive `Record<GameStatus, number>`, not by sniffing the `timeLabel`
  string, so a future lifecycle state cannot silently default into a tier —
  it fails the typecheck instead.
- **Zero mint on an unplayable card, even when the model has an edge**
  (enforces MASTER.md "if it isn't signal (edge/pick/live/active), it isn't
  mint"). A model edge on a game that will not be played is a stale opinion, not
  signal. Previously `isPass` only neutralized mint when there were *no* edges,
  so a postponed game kept a full mint `EDGE +x.x%` chip, mint model cells, mint
  edge footers, and a mint carousel arrow directly beneath a POSTPONED header —
  the strongest visual claim on the card arguing with the strongest textual one.
- **The edge CONTENT stays; only the mint claim goes.** The readout, the pick,
  the percentage, the market tables, and the popover trigger all still render,
  in the neutral grey treatment PASS already uses. Removing the information
  would be a product decision; removing the accent is brand-law enforcement.
  Accessible names are unchanged and stay truthful: the card's own accessible
  name already opens with "…, POSTPONED" / "…, SUSPENDED" (directive
  2026-08-05), so a screen-reader user hears the lifecycle state before the
  edge, and the visual and the announcement continue to agree.
- **A LIVE card is never unplayable**, mirroring the 2026-07-23 ruling that a
  LIVE card never takes the PASS treatment. In-play markets are actionable.

### Owner Directives — 2026-08-05 (card status header + pregame-only venue/time)

> **SUPERSEDES** the 2026-07-17 "Gamecard matchup block" clause
> *"Scheduled games own the time in this block; the card header shows LIVE/FINAL
> only."* That clause is retired. Decision note: PR `feat/feed-card-status-header`,
> evidence bundle `docs/audits/2026-08-05-feed-card-status-evidence/`.

- **One status slot, one alignment, every state.** Every gamecard renders exactly
  one status line in the card header, **horizontally centered**, directly above
  the away/home matchup row. Nothing about WHERE the status sits is
  lifecycle-specific — the header is no longer a live/final-only affordance and
  the old top-right (`justify-content: flex-end`) placement is retired. The
  scheduled card, which previously rendered no header at all, now renders one.
- **Status content by state:**

  | State | Header reads |
  |---|---|
  | scheduled | first-pitch time ET — "9:40 PM ET" |
  | live | "LIVE · BOT 8TH" + the pulsing 7px mint dot |
  | final | "FINAL" |
  | postponed | "POSTPONED" |
  | suspended | "SUSPENDED" |

- **Suspended is a first-class state (2026-08-05).** It no longer collapses into
  the "POSTPONED" label. `gameStatus === "suspended"` threads through as its own
  lifecycle member with the label "SUSPENDED"; it takes the same compact anatomy,
  `align-self: start`, and `opacity: 0.72` as postponed.
- **The slot, alignment, and type register are shared; ink is not.** Every state
  keeps the existing micro-label register — `--proj-meta` (12.00px at a 375
  viewport, 14.05px at 1440), 600, `letter-spacing: 0.06em`, uppercase, Familjen
  Grotesk in mono-STYLE with no mono face loaded — plus
  `font-variant-numeric: tabular-nums`, inherited from the retired
  `.matchup__time` rule so scheduled clock figures stay tabular. **Ink still
  varies by state and is meant to:** live is `--mint-ink` (signal) with 0.08em
  tracking and the light-theme compaction-contrast correction, and the four
  compact states inherit the existing `--text-secondary → --foreground` remap
  that holds AA through their `opacity: 0.72`. Measured composited contrast
  (**corrected 2026-08-06** — the original figures composited the text over the
  already-dimmed card instead of over the page, which `opacity` actually
  composites against) — scheduled 8.13:1 dark / 6.54:1 light, live 6.25 /
  **4.4969**, settled 10.10 / 8.79. Nine of the ten clear 4.5:1; **light-theme
  live misses by 0.003** and is a pre-existing defect, not a consequence of this
  directive — the colour and opacity rules that produce it are byte-identical
  before and after. Derivation and a computed remedy (deepen the `color-mix` to
  50%, giving ≈4.96:1) are in
  `docs/audits/2026-08-05-feed-card-status-evidence/checklist.md`.
  Second known consequence, logged for the owner rather than fixed
  here: that remap makes the four **non-actionable** states the brightest text
  in the slot, above the scheduled card a user can actually bet. Resolving it
  means touching the lifecycle-compaction dim itself, which is owner territory.
  This directive is placement and conditional rendering, not a restyle.
- **Ballpark and first pitch are PREGAME-ONLY.** Live, final, postponed, and
  suspended cards render neither, anywhere on the card. A scheduled card keeps
  its ballpark line; its time now lives in the centered header and must not be
  printed twice. Enforced at the adapter layer (`presentation.ts` team builder,
  `fromFeedSpec.ts`) with `MatchupPanel` as a backstop.
- **MLB is the scope of the venue rule.** The MLB feed row carries the ballpark
  in the matchup context line (`meta = g.venue`), so the team-sport adapter gates
  that context line on scheduled. Soccer's context line is the ROUND ("World Cup
  Final"), not a venue — it survives at every state; only the soccer stadium line
  and kickoff time are gated. Stage identity is not a ballpark.

### Owner Directives — 2026-08-02 (responsive rebuild — container-driven law)

- **Summary anatomy is width-deterministic (supersedes the 2026-07-24
  "single-line group at every breakpoint" clause AND the code-side
  FEED-EDGE-ROW-CLIP content-wrap that silently replaced it).** At card widths
  >520px the `MODEL EDGE | BOOK | MODEL | signal` group renders as ONE
  centered nowrap line, with the hidden-scrollbar summary viewport as the
  escape valve. At card widths <=520px EVERY card uses the same fixed two-row
  grid: facts row first, signal row (chip + 44px next control) centered
  beneath. Content may never decide wrapping — one long pick must not drop
  its chip while row-mates stay on one line. Values never clip, picks are
  never abbreviated, and the page never scrolls horizontally.
- **The markets trigger stays on one line at every card width** (extends the
  2026-07-23 mobile/tablet clause to all surfaces): the label sizes from the
  card container (cqi) with a 10px floor.
- **Pitcher names stay complete and on one line at every viewport** (extends
  the 2026-07-23 clause): the compact-name contract keys off CARD width
  (`projcard` container), never the viewport, so narrow desktop grid columns
  behave exactly like phones. The <=310px-card tier still drops LINEUPS to
  its own centered row rather than occluding a name.
- **League header at the 320px floor:** reduce type (15 → 12px), tracking,
  logo box (30 → 24px), and chevron lane before any truncation; the
  `.dmf-lgname` ellipsis is a last resort, not the plan.
- **Shell title sizing is copy-agnostic:** `clamp(1.5rem, 6cqi, 4.375rem)` on
  the pane container — the retired `(100cqi − 80px)/10.8` divisor (tuned to
  the literal string "AI Model Projections") must not return. Band stays a
  fixed 96px; title centers, never wraps.
- **One sticky-chrome offset:** `--dmf-topbar-h` (owned by
  `pages/dimeModelFeed.css`) is the single source of truth for topbar height
  and feedhead top — 46px + safe-area base, 64px + safe-area mobile, 96px in
  the shell, or the floating nav's published clearance
  (`--dime-floating-nav-h − --dime-floating-nav-gap`) when the nav is
  mounted. Competing 46/64/96/112/−8 literals are retired; the 130px mobile
  bottom slab is gone (24px + home-indicator safe-area everywhere).
- **CONFIRMED pitcher labels are not mint** (mint-rationing enforcement):
  confirmation is data freshness, not model signal — foreground ink + 700
  weight carries the emphasis. EXPECTED/pending stays quiet secondary.
- **Mint is consumed via tokens only:** `--brand-mint` (index.css) is the one
  source; raw `#45E0A8` literals are legal only as `var()` fallbacks.
  Theme-correct mint TEXT uses `--mint-ink` (raw mint dark / `#0A7C50`
  light).
- **The feed stylesheet is a real stylesheet** (`pages/dimeModelFeed.css`) —
  the inline `DMF_CSS` template string and the dead pre-ProjectionCard render
  tree (GameRow/MarketCol/TeamRow/Crest + the `.dmf-game` CSS) are removed.

---

## Data Contract (do not violate — see `dime-ai/DIME-FEED-MIGRATION-DRAFT.md` §4)

- `games.list` requires exact `{ sport, gameDate }`; sync date to `games.getCurrentDate` (11:00 UTC cutoff)
- Honor ETag/304 (empty 304 body ≠ "no games"); keep 0-games auto-retry ×3 + auto-advance-to-first-available-date
- F5/NRFI/team-HR ride on the `games.list` row; K props / HR props / lineups are separate batched queries
- Keep 60s polling with `placeholderData: prev`
- Feed data is TIERED (amended 2026-08-05, owner-ratified via PR): **commodity**
  data — schedule, book lines/odds, betting splits, lineups, metadata — is public;
  the **proprietary model IP** — projections, win probabilities, edges, fair odds
  (every `model*`/edge field, K-prop & HR-prop projections, WC model odds) — is
  gated: anonymous callers receive it nulled at the wire layer, authenticated
  users get the full payload. `favorites.*` and Last-5 remain fully login-gated.
  (Enforced in the read procedures via `server/feedGating.ts`, not the
  `publishedModel` flag.)

---

## Recommendations

- Stream Dime chat answers about the slate token-by-token (existing SSE core)
- Mobile (<768px): sidebar becomes drawer; reuse frozen-panel MobileGameCard pattern inside the Dime skin
- Empty state: keep it quiet — mono label + date-advance hint, no illustration


## Owner amendment — September 5, 2026: feed controls and compact cards

The owner explicitly requested status, sport/league, conference and game filters, a date calendar, responsive full names/abbreviations across sports, quieter EDGE styling and removal of the unequal-card whitespace. These directions supersede earlier no-filter, always-full-school-name and duplicated mobile-header rules on this page.

- One ordered grid uses a compact summary anatomy for every market state; no inline full-table fallback. Rows stretch naturally and preserve Eastern kickoff order. Expanded market details do not resize the feed grid.
- Book line and price, actual model projection, and supplied comparison information remain accessible. Price-basis annotations appear only in full projections. Incomparable prices never become an EDGE or silently move to a different threshold.
- A balanced slate toolbar supplies sport/league, status, source-backed NCAAF conference and searchable game filters. URL query parameters preserve selection/back/forward; upstream filter changes reset dependent selections. Date changes clear the previous game selection.
- Calendar dates use exact Gregorian date-only arithmetic; Today uses America/New_York. New-date queries never display previous-date placeholders. Same-date polling keeps its cache.
- Full names fit when space permits, otherwise canonical abbreviations appear. Full accessible names remain available. Team identity, helmets, score hierarchy and current odds are unchanged.
- League disclosure headers live with their sections at every width. The multi-row toolbar enters normal flow on narrow/short screens to preserve content space. Native keyboard/focus behavior, light/dark themes and reduced motion remain required.

Evidence: `docs/audits/2026-09-05-feed-controls-evidence/`.
