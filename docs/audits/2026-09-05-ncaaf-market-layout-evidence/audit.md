# NCAAF market layout: bounded technical audit

**Changed-line verdict: no new blockers found.** The one Impeccable detector invocation produced two warnings, both on unchanged `GameCard.tsx` accent rails already present at baseline. Exit code 2 records warnings; it is not a detector execution failure.

- Baseline: `ad3dbd175bd568f3944e34c30d0b9cba58696a25`.
- Scope: `MarketTable.tsx`, `ProjectionCard.tsx`, `GameCard.tsx`, `BettingSplitsPanel.tsx`, `OddsHistoryPanel.tsx`, `BettingSplits.tsx`, and `DimeModelFeed.tsx`.
- Raw result: [impeccable-detect.json](impeccable-detect.json). Exact source hashes and changed-line classifications: [impeccable-triage.json](impeccable-triage.json).

## Detector findings

| Location in inspected source | Finding | Changed-line triage |
| --- | --- | --- |
| `GameCard.tsx:4600` | Side-tab accent border (`3px solid`) | Pre-existing at baseline line 4578; not an added line. This is the existing edge/status signal rail, not a decorative addition in this change. |
| `GameCard.tsx:5080` | Side-tab accent border (`3px solid`) | Pre-existing at baseline line 5058; not an added line. It continues the same rail beside the history panel. |

These are generic stylistic heuristics, not verified new accessibility or behavior failures. They do not justify changing the incumbent splits design in this release. New verified issue counts: P0 **0**, P1 **0**, P2 **0**, P3 **0**. No production source was edited during this audit.

## Changed implementation review

- **Accessibility:** Market tables retain captions, column headers, row headers, and ordinary text for line/price values. School names are explicit text instead of abbreviations. History image alternatives use the same complete school names. The existing keyboard controls are retained.
- **Performance:** The changes add a shared static school-name lookup and bounded per-market rendering. No new network requests, dependencies, animations, or layout-measurement loops were introduced by the inspected changes.
- **Responsive behavior:** NCAAF names wrap in matchup, market, and history labels. The model table reserves separate Book/Model columns; long school names cannot expand their track. Projection subtitles now wrap. Actual viewport geometry still requires the root's final browser matrix.
- **Theming:** New table/layout rules consume existing text/spacing tokens. The neutral comparison arrow uses the feed's foreground token; newly added display text inherits the current theme. Runtime contrast is not established by the detector.
- **Data integrity:** The presentation layer retains the comparison guard: `scoreMarketSide` returns null for `comparable === false`. Actual projected lines and a distinct `at …` pricing-basis note are displayed; changing the label does not change Book or model values. Canonical team/event IDs, helmet keys, and non-NCAAF naming behavior stay intact.

This is a static changed-line audit, not a full WCAG certification or a claimed browser pass. A numerical cross-dimension quality score is intentionally omitted because final visual/contrast/keyboard evidence is being recorded separately. No additional detector pass or polish loop is recommended for these two pre-existing warnings.
