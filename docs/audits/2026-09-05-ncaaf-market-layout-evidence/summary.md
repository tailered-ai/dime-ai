# NCAAF school names and Book/Model market cells

The feed now spells out school names and places each Book line above its odds in the Book column. Model cells show the actual projection, with the model odds' original pricing threshold shown beneath when it differs. Side cells contain only the school name or Over/Under. NCAAF footers contain only a positive raw EDGE percentage or NO EDGE, including zero, missing or incomparable quotes.

For Miami (Ohio) at Pittsburgh, the Book spread is +16.5 (-105) / -16.5 (-115), while Model shows +20.9 (+165 at +16) / -20.9 (-165 at -16). Because those prices refer to different thresholds, the footer correctly remains NO EDGE. No odds, projections, source snapshots or database records are changed by this presentation update.

Full names also appear in splits, history headers and search. Canonical team keys still resolve the same helmets. Existing professional-sport table behavior is retained.

## Reproduction

The live page was inspected before publication: 68 NCAAF cards were present, and Miami/Pittsburgh rendered `M-OH +16.5 | -105 | +16 (+165)` with `Model spread: M-OH +20.9 / PITT -20.9` in the footer. This matched the owner's screenshot.

## Evidence

- Lead: Impeccable. Advisor: independent pricing-contract review. [Brief](brief.yaml).
- TypeScript passed; 134 focused checks passed. The initial CSS-contract test failed after the owner-directed strict-positive exception; its expectation was updated and all focused checks passed. [Verbatim checks](typecheck-tests.txt).
- Production build and bundle gate passed: 216,134 gzip bytes / 222,538 ceiling. [Build](smoke.txt).
- Initial browser matrix: 11 passed across 375/768/817/1024/1440, dark/light and reduced motion. Visual review caught the neutral comparison arrow's light-theme token; one batched repair fixed it and allowed long projection subtitles to wrap. Final production-build confirmation passed all 12 browser cases, including every spread/total/available moneyline for all 68 games plus splits and source history. [Browser output](browser-tests.txt).
- Independent source review found no pricing/comparability regression. Shared adapters carry display values separately from pricing basis; UCLA bound quote overrides retain their guards.
- Detector ran once: two unchanged accent-rail heuristics, zero new blockers. [Audit](audit.md), [raw detector](impeccable-detect.json), [triage](impeccable-triage.json).
- Screenshots are local in `screenshots/` per the repository PNG policy. Viewports, keyboard and overflow are checked in `e2e/ncaaf-september5.spec.ts` against the production build with public-slate API fixtures.
- Final owner review, required CI and deployment are pending. No database migration or publication is needed.

## Limits

The model odds retain their original pricing threshold; displaying a projection does not reprice them or create an edge across different lines. Chromium was verified, not Firefox/WebKit. Popover pagination remains in the existing internal scroll area on short displays. Live source refresh and ingestion were outside this presentation-only change.
